import assert from 'node:assert/strict'
import { grokBotMessages, grokBotThreads } from '../src/shared/grokBotConversation.ts'
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
console.log(`${passed} Grok Bot conversation checks passed`)
