import assert from 'node:assert/strict'
import { grokBotMessages, grokBotThreads, grokBotSwitch, grokBotApprovals, grokBotSkills } from '../src/shared/grokBotConversation.ts'
import { grokBotCommand } from '../src/shared/grokBotCommands.ts'
import { canMoveTab, type Tab } from '../src/shared/tabWindows.ts'
import { toStored } from '../src/renderer/src/lib/restore.ts'
import { folderChip, shortcutVerdict } from '../src/shared/topBar.ts'
import { tabLabel, openableFolder, profileCwd, restartPlan } from '../src/renderer/src/lib/tabs.ts'

let passed = 0
const check = (name: string, fn: () => void) => { fn(); passed++; console.log(`  PASS ${name}`) }
check('bot and group choices retain distinct IDs and deduplicate invalid rows', () => {
  assert.deepEqual(grokBotThreads({ bots: [{ id: 'a', name: 'Researcher' }, { id: 'a' }, null, { name: 'missing id' }], groups: [{ id: 'g', name: 'Team' }] }), [
    { id: 'a', name: 'Researcher', kind: 'Bot' }, { id: 'g', name: 'Team', kind: 'Group' }
  ])
  assert.deepEqual(grokBotThreads({ bots: 'wrong shape' }), [])
})
check('nested bot replies and multiline user prompts keep their real text and authors', () => {
  assert.deepEqual(grokBotMessages({ transcript: { entries: [
    { id: 'u', kind: 'user-message', prompt: 'hello\n界', atMs: 123 },
    { id: 'b', kind: 'send-message', message: { type: 'text', content: '## Reply\n**Bold**' } },
    { id: 't', kind: 'tool', text: 'Working…' },
    { message: { auth: 'owned-private-metadata' } }
  ] } }), [
    { id: 'u', role: 'user', text: 'hello\n界', atMs: 123 },
    { id: 'b', role: 'assistant', text: '## Reply\n**Bold**', atMs: null },
    { id: 't', role: 'activity', text: 'Working…', atMs: null }
  ])
})
check('content blocks prefer complete messages to previews and omit non-text metadata', () => {
  const rows = grokBotMessages({ thread: { entries: [{ role: 'assistant', content: ['line one', { text: 'line two' }, { secret: 'owned-private' }], preview: 'short', timestamp: Infinity }] } })
  assert.equal(rows[0].text, 'line one\nline two')
  assert.equal(rows[0].atMs, null)
  assert.equal(JSON.stringify(rows).includes('owned-private'), false)
  assert.deepEqual(grokBotMessages({ transcript: { entries: {} } }), [])
})
check('conversation parsing bounds history and text and strips terminal controls', () => {
  const rows = grokBotMessages({ entries: Array.from({ length: 210 }, (_, i) => ({ id: String(i), text: '\0' + 'a'.repeat(128 * 1024 + 10) })) })
  assert.equal(rows.length, 200)
  assert.equal(rows[0].id, '10')
  assert.ok(rows.every(row => row.text.length <= 128 * 1024 && !row.text.includes('\0')))
})
const tab: Tab = {
  id: 'owned-bot-tab', kind: 'grok-bot', cliId: 'grok', ptyId: '', sessionId: '', cwd: '/owned/poison-folder', projectName: '', title: 'Researcher',
  permissionMode: 'default', model: '', effort: 'default', ultracode: false, status: 'running', exitCode: null, hostId: null, selectedPath: null, expandedPath: null,
  grokBot: { accountId: 'owned-bot-account', accountLabel: 'Cursor 3', targetId: 'bot-3', targetLabel: 'Researcher', draft: 'owned draft' }
}
check('the tab identifies Grok Bot and its account without naming the Grok Build CLI', () => {
  assert.equal(tabLabel(tab, null).agentTag, 'Grok Bot')
  assert.deepEqual(tabLabel(tab, null).account, { key: 'owned-bot-account', text: 'Cursor 3' })
  assert.equal(tabLabel({ ...tab, customTitle: 'My bot' }, null).text, 'My bot')
})
check('cloud conversations have no local folder, project profile or terminal shortcuts', () => {
  assert.equal(openableFolder(tab), null)
  assert.equal(profileCwd(tab), null)
  assert.equal(folderChip(tab, { style: 'path', hostLabel: null, deviceLabel: null }), null)
  assert.equal(shortcutVerdict({ on: 'any' }, { ...tab, utility: false, dot: null }).ok, false)
  assert.equal(restartPlan(tab, []).kind, 'impossible')
})
check('conversation drafts are never serialized as terminal sessions or screens', () => {
  const stored = toStored([tab], tab.id, {}, () => { throw new Error('A bot conversation must not save a terminal screen') }, 0)
  assert.deepEqual(stored.tabs, [])
  assert.equal(JSON.stringify(stored).includes('owned draft'), false)
})
check('window handoff can carry idle conversation drafts, while an in-flight send stays with its owner', () => {
  assert.equal(canMoveTab(tab), true)
  assert.equal(canMoveTab({ ...tab, grokBot: { ...tab.grokBot!, sending: true } }), false)
})
check('switching bots and accounts keeps drafts isolated and clears old receipts', () => {
  const first = { ...tab.grokBot!, delivery: 'accepted' as const }
  const second = { ...first, ...grokBotSwitch(first, { id: 'account-2', label: 'Second' }, { id: 'bot-3', name: 'Same ID in second account', kind: 'Bot' }) }
  assert.equal(second.draft, '')
  assert.equal(second.delivery, undefined)
  assert.equal(second.drafts!['owned-bot-account:bot-3'].draft, 'owned draft')
  second.draft = 'second account draft'
  const back = grokBotSwitch(second, { id: 'owned-bot-account', label: 'First' }, { id: 'bot-3', name: 'First bot', kind: 'Bot' })
  assert.equal(back.draft, 'owned draft')
  assert.equal(back.drafts!['account-2:bot-3'].draft, 'second account draft')
  const uncertain = { ...first, delivery: 'unknown' as const, sendError: 'Check the thread before resending.' }
  const switched = { ...uncertain, ...grokBotSwitch(uncertain, { id: 'account-2', label: 'Second' }) }
  const restored = grokBotSwitch(switched, { id: uncertain.accountId, label: 'First' }, { id: uncertain.targetId, name: 'First bot', kind: 'Bot' })
  assert.equal(restored.delivery, 'unknown')
  assert.equal(restored.sendError, uncertain.sendError)
})
check('group, skill and approval commands reject unsupported or unsafe options before launch', () => {
  const accountId = 'owned'
  for (const operation of [
    { kind: 'delete', target: '--all' }, { kind: 'members-set', target: 'group', members: [] },
    { kind: 'create', targetKind: 'group', name: 'Group', members: Array.from({ length: 7 }, (_, i) => String(i)) },
    { kind: 'update', target: 'bot', notify: 'on' }, { kind: 'approval-respond', target: 'bot', entryId: 'e', requestId: 'r', decision: 'always-allow' },
    { kind: 'thread', target: 'bot', limit: 201 }, { kind: 'skill-add', markdown: 'a'.repeat(100001) }, { kind: 'exec', message: 'arbitrary shell' }
  ]) assert.throws(() => grokBotCommand({ accountId, ...operation } as never))
  const command = grokBotCommand({ accountId, kind: 'send', target: 'bot', message: '--gateway https://evil.invalid $(touch owned)' })
  assert.equal(command.argv.at(-1), '--gateway https://evil.invalid $(touch owned)')
  assert.equal(command.argv.at(-3), '--')
})
check('approval calls use the reviewed CLI route and grant only an explicit one-time decision', () => {
  assert.deepEqual(grokBotCommand({ accountId: 'owned', kind: 'approval-respond', target: 'bot', entryId: 'entry', requestId: 'request', decision: 'accept' }), {
    gateway: false, argv: ['approvals', 'respond', '--target=bot', '--entry-id=entry', '--request-id=request', '--decision=accept']
  })
  assert.deepEqual(grokBotApprovals({ approvals: [{ entryId: 'entry', requestId: 'request', type: 'auto-review-approval', command: 'owned command', truncated: true, secret: 'owned-hidden' }, { entryId: 'unsupported', requestId: 'other', type: 'secret-request' }] }), [{ entryId: 'entry', requestId: 'request', type: 'auto-review-approval', details: 'command: owned command', truncated: true }])
  assert.deepEqual(grokBotSkills([{ id: 'skill', name: 'Research', description: 'Plan', source: 'workflow', token: 'owned-hidden' }]), [{ id: 'skill', name: 'Research', description: 'Plan', source: 'workflow' }])
})
console.log(`${passed} Grok Bot conversation checks passed`)
