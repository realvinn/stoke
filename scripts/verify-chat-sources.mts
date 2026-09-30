/*
 * Chat history: every source's reader, the caps and what they say, the store,
 * incremental reads, Cline's duplicate fold, search and its snippets, and the
 * worker the main process talks to — all against SYNTHETIC fixtures in a temp
 * directory. Never the real ~/.claude, ~/.codex or any app's data: every root
 * is resolved from a fake home (`SourceEnv`), and the store is a temp userData.
 *
 * Gotcha 74 is the reason for the shape: a suite that fakes a clock or a cap
 * must fake the paths too, and must show that a bystander beside what it
 * deletes survives. Here the fake home holds a bystander next to the
 * transcripts, and the fake userData holds one next to the store that
 * "Delete index" removes.
 *
 *   node scripts/verify-chat-sources.mts
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zstdCompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import {
  CHAT_CAP_DEFAULTS,
  CHAT_INDEX_DEFAULTS,
  CHAT_PRESETS,
  chatOpenAction,
  clampChatCaps,
  clampChatIndex,
  clampChatIndexOptions,
  emptyChatStatus,
  ftsQuery,
  HIT_CLOSE,
  HIT_OPEN,
  offerFound,
  parseMarked,
  presetOf,
  sourceDisclosure,
  type ChatIndexOptions,
  type ChatSourceStatus
} from '../src/shared/chatIndex.ts'
import { agentLaunchPlan, DEFAULT_ENDPOINT } from '../src/shared/agents.ts'
import { isSafeResumeId, resumableClis, type CodingCliId } from '../src/shared/codingClis.ts'
import { cleanText, cutBytes, planTrim } from '../src/main/chatIndex/parse.ts'
import { ChatStore } from '../src/main/chatIndex/store.ts'
import { runPass, type PassHooks } from '../src/main/chatIndex/scan.ts'
import {
  claudeRoots,
  codexHome,
  coworkRoot,
  detectSource,
  discovery,
  opencodeDbPath,
  setDiscoveryLimitForTest,
  zedDbPath,
  DISCOVERY_MAX_ENTRIES,
  type SourceEnv
} from '../src/main/chatIndex/sources.ts'
import { ChatIndexHost } from '../src/main/chatIndex/host.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`))
}

function section(title: string): void {
  console.log(`\n${title}`)
}

/* ------------------------------------------------------------ pure rules */

section('settings: hydrated and clamped')
{
  const fresh = hydrateSettings({})
  check('a settings file with no key reads as never asked (the offer shows once)', fresh.chatIndex, 'unasked')
  check('only the two literals are answers', [clampChatIndex('on'), clampChatIndex('off'), clampChatIndex(true), clampChatIndex('yes')], [
    'on',
    'off',
    'unasked',
    'unasked'
  ])
  check('the defaults: every source on, subagents off, redaction on, Standard caps', fresh.chatIndexOptions, CHAT_INDEX_DEFAULTS)
  const junk = clampChatIndexOptions({ sources: { claude: false, codex: 'yes', bogus: true }, subagents: 'true', redact: 0, caps: { perSource: -5, total: '9e9', passMb: 'x' } })
  check('a source not literally false/true takes its default; unknown ids are dropped', [junk.sources.claude, junk.sources.codex, 'bogus' in junk.sources], [false, true, false])
  check('subagents only on for the literal true; redaction only off for the literal false', [junk.subagents, junk.redact], [false, true])
  check('caps are pulled into range, never refused', [junk.caps.perSource, junk.caps.total, junk.caps.passMb], [1, 200_000, CHAT_CAP_DEFAULTS.passMb])
  check('a hand-edited file keeps every named field (no undefined after hydrate)', Object.keys(clampChatCaps({})).sort(), Object.keys(CHAT_CAP_DEFAULTS).sort())
  check('presets are recognised, anything else is custom', [presetOf(CHAT_PRESETS.light), presetOf(CHAT_CAP_DEFAULTS), presetOf({ ...CHAT_CAP_DEFAULTS, perSource: 7 })], [
    'light',
    'standard',
    'custom'
  ])
}

section('search query and snippets')
{
  check('every word a required prefix', ftsQuery('stok sess'), '"stok"* "sess"*')
  check('a double quote can never reach FTS5 syntax', ftsQuery('a" OR b:c NEAR("x'), '"a"* "OR"* "b"* "c"* "NEAR"* "x"*')
  check('nothing searchable is null', ftsQuery('  -- ** '), null)
  check('non-ASCII words stay whole', ftsQuery('tiếng Việt 日本語'), '"tiếng"* "Việt"* "日本語"*')
  const m = parseMarked(`say ${HIT_OPEN}Việt${HIT_CLOSE} and ${HIT_OPEN}naïve${HIT_CLOSE}…`)
  check('marks become ranges over the unmarked text', [m.text, m.ranges.map(([s, e]) => m.text.slice(s, e))], ['say Việt and naïve…', ['Việt', 'naïve']])
}

section('text: what is kept')
{
  const blob = 'Zm9vYmFy' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MjQy'.repeat(8)
  const t = cleanText(`look ${blob} here sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV and ghp_abcdefghijklmnopqrstuvwxyz0123 ok`, { redact: true })
  check('a base64 run goes, the sentence around it stays', [t.includes('Zm9vYmFy'), t.startsWith('look [data] here')], [false, true])
  check('API keys are redacted', [t.includes('ABCDEFGHIJKLMNOPQRSTUV'), t.includes('abcdefghijklmnopqrstuvwxyz0123'), t.split('[redacted]').length - 1], [false, false, 2])
  check('redaction off keeps them', cleanText('key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV', { redact: false }).includes('ABCDEFGHIJKLMNOPQRSTUV'), true)
  check('a one-case long identifier is not a blob', cleanText('x'.repeat(250), { redact: true }).length, 250)
  check('the snippet marks can never be stored', cleanText(`a${HIT_OPEN}b${HIT_CLOSE}c\u0000d`, { redact: true }), 'abcd')
  check('a byte cut never splits a character', cutBytes('日本語', 4), '日')
  check('planTrim keeps the head and the tail, drops the middle', planTrim([10, 10, 10, 10, 10, 10, 10, 10], 40), [3, 4, 5, 6])
  check('planTrim leaves what fits alone', planTrim([10, 10], 40), [])
}

section('opening a hit')
{
  const ctx = { installed: new Set<CodingCliId>(['claude', 'codex']), resumable: resumableClis() }
  check('Codex and OpenCode can reopen one chat by id (read in their binaries)', [...resumableClis()].sort(), ['codex', 'opencode'])
  check('Claude resumes through the usual path', chatOpenAction({ source: 'claude', nativeId: 'abc', cwd: '/w', subagent: false }, ctx), {
    kind: 'claude',
    sessionId: 'abc',
    cwd: '/w'
  })
  check('Codex, installed, reopens in Codex', chatOpenAction({ source: 'codex', nativeId: 'x-1', cwd: '/w', subagent: false }, ctx).kind, 'agent')
  check('OpenCode, not installed, says so', chatOpenAction({ source: 'opencode', nativeId: 'ses_1', cwd: '/w', subagent: false }, ctx).kind, 'notice')
  check('Zed and Cowork get the viewer notice', [chatOpenAction({ source: 'zed', nativeId: 'z', cwd: '/w', subagent: false }, ctx).kind, chatOpenAction({ source: 'claude-cowork', nativeId: 'c', cwd: '/w', subagent: false }, ctx).kind], [
    'notice',
    'notice'
  ])
  check('a subagent transcript is never resumed', chatOpenAction({ source: 'claude', nativeId: 'a/b', cwd: '/w', subagent: true }, ctx).kind, 'notice')
  const base = { endpoint: DEFAULT_ENDPOINT, openrouterKey: '', continueLast: true, mcp: null, piExtensionPath: null }
  const codex = agentLaunchPlan({ ...base, id: 'codex', resumeId: '019f456c-d3fd-7e83-927d-f3b8ad5ac6cf' })
  check('codex reopens by id, and the id wins over continue', codex.ok ? codex.plan.args : codex, ['resume', '019f456c-d3fd-7e83-927d-f3b8ad5ac6cf'])
  const oc = agentLaunchPlan({ ...base, id: 'opencode', resumeId: 'ses_abc123' })
  check('opencode reopens with --session', oc.ok ? oc.plan.args : oc, ['--session', 'ses_abc123'])
  check('an id with a cmd.exe metacharacter is refused', agentLaunchPlan({ ...base, id: 'codex', resumeId: 'abc&calc' }).ok, false)
  check('a CLI with no by-id resume is refused, not started fresh', agentLaunchPlan({ ...base, id: 'gemini', resumeId: 'abcdef12' }).ok, false)
  check('isSafeResumeId', [isSafeResumeId('ses_abc123'), isSafeResumeId('a b'), isSafeResumeId('-x'), isSafeResumeId('x')], [true, false, false, false])
}

section('disclosure: a cap that binds is said out loud')
{
  const s = (over: Partial<ChatSourceStatus>): ChatSourceStatus => ({ ...emptyChatStatus('/x').sources[0], ...over })
  const caps = { ...CHAT_CAP_DEFAULTS, perSource: 10 }
  check('per-source', sourceDisclosure(s({ found: 30, indexed: 10, cappedBy: 'perSource' }), caps), 'Indexed the newest 10 of 30 chats (the limit is 10 per tool).')
  check('still going', sourceDisclosure(s({ found: 30, indexed: 4, cappedBy: 'time' }), caps).startsWith('Still indexing: 4 of 30 so far.'), true)
  check('discovery', sourceDisclosure(s({ found: 50, foundAtLeast: true, indexed: 10, cappedBy: 'discovery' }), { ...caps, perSource: 100 }), 'Indexed 10 chats. Stopped counting at 50+ files.')
  check('all of it', sourceDisclosure(s({ found: 3, indexed: 3 }), caps), 'Indexed all 3 chats.')
  check('copies are named, and not counted as missing', sourceDisclosure(s({ found: 3, indexed: 2, duplicates: 1 }), caps), 'Indexed all 2 chats. 1 more is a copy of chats their own tool still has, so it is searched there, not twice.')
}

/* ------------------------------------------------------------- fixtures */

const root = mkdtempSync(join(tmpdir(), 'stoke-chat-sources-'))
const home = join(root, 'home')
const userData = join(root, 'userData')
const storeDir = join(userData, 'chat-index')
const env: SourceEnv = { home, env: {}, platform: process.platform }
const T0 = Date.parse('2026-09-01T00:00:00Z')

function write(path: string, text: string, mtimeMs?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  if (mtimeMs !== undefined) utimesSync(path, mtimeMs / 1000, mtimeMs / 1000)
}

const jl = (recs: unknown[]): string => recs.map((r) => JSON.stringify(r)).join('\n') + '\n'
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const iso = (ms: number): string => new Date(ms).toISOString()

const BLOB = 'Zm9vYmFyYmF6' + 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0MjQy'.repeat(8)

function claudeChat(i: number, cwd: string, extra = ''): string {
  const t = T0 + i * 60_000
  return jl([
    { type: 'permission-mode', permissionMode: 'default' },
    { type: 'user', message: { role: 'user', content: `hello chat${i} about topic${i} ${extra}` }, cwd, gitBranch: 'main', timestamp: iso(t), sessionId: uuid(i) },
    {
      type: 'assistant',
      timestamp: iso(t + 1000),
      message: {
        model: 'claude-opus-5',
        content: [
          { type: 'thinking', thinking: 'thinkword' },
          { type: 'text', text: `answer${i} alpha` },
          { type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: 'toolinputword' } }
        ]
      }
    },
    { type: 'user', timestamp: iso(t + 2000), message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'tooloutputword' }] } },
    { type: 'user', isMeta: true, message: { content: 'metaword' } },
    { type: 'assistant', isSidechain: true, message: { content: [{ type: 'text', text: 'sidechainword' }] } },
    { type: 'user', message: { content: '<command-name>/clear</command-name>' } },
    { type: 'ai-title', aiTitle: `Title number ${i}` }
  ])
}

/*
 * A subagent's own transcript, as the CLI writes it under `<session>/subagents/`:
 * EVERY record carries `isSidechain: true` (measured: 7,378 of 7,378 user and
 * assistant records across 52 real files, and none with an ai-title). A
 * fixture without the flag is how "subagents on" once indexed nothing and no
 * check saw it.
 */
function claudeSubagentChat(i: number, cwd: string, word: string): string {
  const t = T0 + i * 60_000
  return jl([
    { type: 'user', isSidechain: true, agentId: 'a1', message: { role: 'user', content: `subagent task ${word}` }, cwd, timestamp: iso(t), sessionId: uuid(29) },
    {
      type: 'assistant',
      isSidechain: true,
      agentId: 'a1',
      timestamp: iso(t + 1000),
      message: { model: 'claude-opus-5', content: [{ type: 'text', text: `subagent report ${word}` }, { type: 'tool_use', id: 's1', name: 'Read', input: { file_path: 'subtoolword' } }] }
    },
    { type: 'user', isSidechain: true, agentId: 'a1', cwd, timestamp: iso(t + 2000), message: { content: [{ type: 'tool_result', tool_use_id: 's1', content: 'subtooloutputword' }] } }
  ])
}

const projDir = join(home, '.claude', 'projects', '-tmp-proj-a')
const claudeFile = (i: number): string => join(projDir, `${uuid(i)}.jsonl`)
for (let i = 0; i < 30; i++) {
  const extra =
    i === 29
      ? `Größe tiếng Việt 日本語 naïve café ${BLOB} key sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUV end`
      : ''
  write(claudeFile(i), claudeChat(i, '/tmp/proj-a', extra), T0 + i * 60_000)
}
// A subagent's transcript beside its session, and a bystander that is not a transcript at all.
write(join(projDir, uuid(29), 'subagents', 'agent-a1.jsonl'), claudeSubagentChat(99, '/tmp/proj-a', 'subagentword'), T0 + 90 * 60_000)
write(join(projDir, 'notes.txt'), 'bystander, not a chat')

// Codex: the threads table, one user thread and one guardian subagent, and their rollouts.
const codexId = '019f456c-d3fd-7e83-927d-f3b8ad5ac6cf'
const guardId = '019f456c-aaaa-7e83-927d-f3b8ad5ac6cf'
const codexDir = join(home, '.codex', 'sessions', '2026', '09', '28')
const codexRollout = join(codexDir, `rollout-2026-09-28T16-02-23-${codexId}.jsonl`)
const guardRollout = join(codexDir, `rollout-2026-09-28T16-05-00-${guardId}.jsonl`)
const codexT = T0 + 40 * 60_000
write(
  codexRollout,
  jl([
    { timestamp: iso(codexT), type: 'session_meta', payload: { id: codexId, cwd: '/tmp/codex-proj', timestamp: iso(codexT), source: 'vscode' } },
    { timestamp: iso(codexT), type: 'turn_context', payload: { model: 'gpt-6.1-sol', cwd: '/tmp/codex-proj' } },
    { timestamp: iso(codexT), type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'developerword rules' }] } },
    {
      timestamp: iso(codexT + 1),
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd> envcontextword\n</environment_context>' },
          { type: 'input_text', text: 'codex question about quokka' }
        ]
      }
    },
    { timestamp: iso(codexT + 2), type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: 'codex question about quokka eventdupword' } } },
    { timestamp: iso(codexT + 3), type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'reasoningword' }] } },
    { timestamp: iso(codexT + 4), type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"cmd":"functionargword"}' } },
    { timestamp: iso(codexT + 5), type: 'response_item', payload: { type: 'function_call_output', output: 'functionoutputword' } },
    { timestamp: iso(codexT + 6), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'codex answer wombat' }] } }
  ]),
  codexT + 10_000
)
write(
  guardRollout,
  jl([
    { timestamp: iso(codexT), type: 'session_meta', payload: { id: guardId, cwd: '/tmp/codex-proj', source: { subagent: { other: 'guardian' } } } },
    { timestamp: iso(codexT), type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'guardianword' }] } }
  ]),
  codexT + 20_000
)
{
  const db = new DatabaseSync(join(home, '.codex', 'state_5.sqlite'))
  db.exec(`CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    source TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, git_branch TEXT,
    first_user_message TEXT NOT NULL DEFAULT '', model TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, name TEXT)`)
  const ins = db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
  // `title` as the desktop app often leaves it (its own context first); `name` is what Codex shows.
  ins.run(codexId, codexRollout, codexT / 1000, codexT / 1000, 'vscode', '/tmp/codex-proj', '# Files mentioned by the user: ctxtitleword', 0, 'main', 'codex question about quokka', 'gpt-6.1-sol', codexT, codexT + 10_000, 'Quokka thread name')
  ins.run(guardId, guardRollout, codexT / 1000, codexT / 1000, '{"subagent":{"other":"guardian"}}', '/tmp/codex-proj', '', 0, null, '', null, codexT, codexT + 20_000, null)
  db.close()
}

// OpenCode: one session, a text part each way, a tool part, a synthetic part, a reasoning part.
{
  const path = opencodeDbPath(env)
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL, directory TEXT NOT NULL, time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL, parent_id TEXT, time_archived INTEGER);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL, data TEXT NOT NULL);`)
  const t = T0 + 35 * 60_000
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run('ses_abc123', 'OpenCode wallaby', '/tmp/oc', t, t + 5000, null, null)
  db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?)').run('ses_child1', 'child', '/tmp/oc', t, t + 6000, 'ses_abc123', null)
  const msg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)')
  msg.run('msg_1', 'ses_abc123', t, t, JSON.stringify({ role: 'user' }))
  msg.run('msg_2', 'ses_abc123', t + 1, t + 1, JSON.stringify({ role: 'assistant' }))
  msg.run('msg_c', 'ses_child1', t, t, JSON.stringify({ role: 'user' }))
  const part = db.prepare('INSERT INTO part VALUES (?,?,?,?,?,?)')
  part.run('prt_1', 'msg_1', 'ses_abc123', t, t, JSON.stringify({ type: 'text', text: 'opencode question wallaby' }))
  part.run('prt_2', 'msg_1', 'ses_abc123', t, t, JSON.stringify({ type: 'text', text: 'syntheticword', synthetic: true }))
  part.run('prt_3', 'msg_2', 'ses_abc123', t + 1, t + 1, JSON.stringify({ type: 'reasoning', text: 'ocreasonword' }))
  part.run('prt_4', 'msg_2', 'ses_abc123', t + 1, t + 1, JSON.stringify({ type: 'tool', state: { output: 'opencodetoolword' } }))
  part.run('prt_5', 'msg_2', 'ses_abc123', t + 1, t + 1, JSON.stringify({ type: 'text', text: 'opencode answer bandicoot' }))
  part.run('prt_6', 'msg_c', 'ses_child1', t, t, JSON.stringify({ type: 'text', text: 'childsessionword' }))
  db.close()
}

// Cline: one imported copy of the Codex thread above, and one of its own.
const clineRootDir = join(home, '.cline', 'data', 'sessions')
function clineSession(id: string, meta: unknown, messages: unknown, mtime: number): void {
  write(join(clineRootDir, id, `${id}.json`), JSON.stringify(meta))
  write(join(clineRootDir, id, `${id}.messages.json`), JSON.stringify(messages), mtime)
}
clineSession(
  '1783576295230_COPY1',
  { session_id: '1783576295230_COPY1', cwd: '/tmp/codex-proj', prompt: 'codex question', started_at: iso(codexT), metadata: { title: 'Imported quokka', importedFrom: { tool: 'codex', sourceSessionId: codexId } } },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 'clinecopyword codex question' }], ts: codexT }] },
  T0 + 41 * 60_000
)
clineSession(
  '1783576295230_OWN01',
  { session_id: '1783576295230_OWN01', cwd: '/tmp/cline-proj', prompt: 'koala', started_at: iso(T0), metadata: { title: 'Native cline koala' } },
  {
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'native cline koala question <environment_details>envdetailsword</environment_details>' }], ts: T0 },
      { role: 'assistant', content: [{ type: 'text', text: 'cline answer dingo' }, { type: 'tool_use', name: 'x', input: { q: 'clinetoolword' } }], ts: T0 + 1 },
      { role: 'user', content: [{ type: 'tool_result', content: 'clineresultword' }], ts: T0 + 2 }
    ]
  },
  T0 + 36 * 60_000
)

// A copy of a Claude chat that Claude's own cap leaves OUT of range: still Claude's, never Cline's.
clineSession(
  '1783576295230_COPY2',
  { session_id: '1783576295230_COPY2', cwd: '/tmp/proj-a', started_at: iso(T0), metadata: { title: 'Imported old chat', importedFrom: { tool: 'claude-code', sourceSessionId: uuid(3) } } },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 'clineoldcopyword' }], ts: T0 }] },
  T0 + 42 * 60_000
)
// A copy of the Codex guardian subagent thread, which Codex's own listing withholds while subagents are off.
clineSession(
  '1783576295230_COPY3',
  { session_id: '1783576295230_COPY3', cwd: '/tmp/codex-proj', started_at: iso(T0), metadata: { title: 'Imported guardian', importedFrom: { tool: 'codex', sourceSessionId: guardId } } },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 'clineguardcopyword' }], ts: T0 }] },
  T0 + 43 * 60_000
)
// A copy whose original is gone from its tool: the last record of it, so it is kept.
clineSession(
  '1783576295230_ORPH1',
  { session_id: '1783576295230_ORPH1', cwd: '/tmp/codex-gone', started_at: iso(T0), metadata: { title: 'Orphaned copy', importedFrom: { tool: 'codex', sourceSessionId: '019f0000-0000-7000-8000-000000000000' } } },
  { messages: [{ role: 'user', content: [{ type: 'text', text: 'orphanedcopyword' }], ts: T0 }] },
  T0 + 34 * 60_000
)

// Zed: one thread, zstd-compressed JSON, as Zed stores it.
{
  const path = zedDbPath(env)
  mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, summary TEXT NOT NULL, updated_at TEXT NOT NULL, data_type TEXT NOT NULL, data BLOB NOT NULL, parent_id TEXT, folder_paths TEXT, folder_paths_order TEXT, created_at TEXT)')
  const doc = {
    title: 'Zed platypus',
    updated_at: iso(T0 + 37 * 60_000),
    model: { provider: 'x', model: 'zed-model' },
    subagent_context: null,
    messages: [
      { User: { id: 'u1', content: [{ Text: 'zed question platypus' }, { Mention: { uri: 'zedmentionword' } }] } },
      { Agent: { content: [{ Thinking: { text: 'zedthinkword' } }, { Text: 'zed answer echidna' }, { ToolUse: { name: 'x', input: 'zedtoolword' } }], tool_results: {} } }
    ]
  }
  db.prepare('INSERT INTO threads VALUES (?,?,?,?,?,?,?,?,?)').run('zed-thread-1', 'Zed platypus', doc.updated_at, 'zstd', zstdCompressSync(Buffer.from(JSON.stringify(doc))), null, '/tmp/zed-proj', null, doc.updated_at)
  db.close()
}

// Claude desktop Cowork: metadata that carries an account name and email, and its nested transcript.
{
  const base = join(coworkRoot(env), 'org-1', 'acct-1')
  write(
    join(base, 'local_s1.json'),
    JSON.stringify({ title: 'Cowork numbat', cwd: '/tmp/cowork', createdAt: iso(T0), lastActivityAt: iso(T0 + 38 * 60_000), emailAddress: 'person@example.com', accountName: 'Secretive Person', isArchived: false })
  )
  write(join(base, 'local_s1', '.claude', 'projects', '-enc', `${uuid(500)}.jsonl`), claudeChat(500, '/outputs', 'cowork question numbat'), T0 + 38 * 60_000)
}

const STORE_MODE_CHECKABLE = process.platform !== 'win32'
const options = (over: Partial<ChatIndexOptions> = {}, caps: Partial<ChatIndexOptions['caps']> = {}): ChatIndexOptions => ({
  ...CHAT_INDEX_DEFAULTS,
  ...over,
  sources: { ...CHAT_INDEX_DEFAULTS.sources, ...(over.sources ?? {}) },
  caps: { ...CHAT_INDEX_DEFAULTS.caps, perSource: 10, ...caps }
})
let clock = Date.now()
const hooks = (over: Partial<PassHooks> = {}): PassHooks => ({
  now: () => clock,
  yieldTurn: async () => undefined,
  cancelled: () => false,
  progress: () => undefined,
  ...over
})
const words = (store: ChatStore, q: string): string[] => store.search(q).map((h) => `${h.source}:${h.nativeId}`)

try {
  section('roots honour each tool’s own override')
  check('CLAUDE_CONFIG_DIR is read, before ~/.claude', claudeRoots({ ...env, env: { CLAUDE_CONFIG_DIR: '/alt' } })[0], join('/alt', 'projects'))
  check('CODEX_HOME moves Codex', codexHome({ ...env, env: { CODEX_HOME: '/cx' } }), '/cx')

  section('detection: names and sizes only, before any yes')
  const det = ['claude', 'codex', 'opencode', 'claude-cowork', 'zed', 'cline'].map((id) => detectSource(id as never, env, false, discovery(Date.now())))
  check('Claude: the 30 top-level transcripts, never the subagent', det[0].chats, 30)
  check('Codex: both rollouts by name (the table is not opened)', det[1].chats, 2)
  check('OpenCode and Zed: a size, no count (a database is not opened)', [det[2].chats, det[4].chats, det[2].bytes > 0, det[4].bytes > 0], [null, null, true, true])
  check('Cowork and Cline counted by name', [det[3].chats, det[5].chats], [1, 5])
  check('detection created no store', existsSync(storeDir), false)
  const found = offerFound({ sources: det, at: 0 })
  check('the offer names what was found', found.text.startsWith('Claude Code (30), Codex (2), OpenCode ('), true)

  section('first pass: newest first, capped, disclosed')
  const store = ChatStore.open(storeDir)
  const pass1 = await runPass(store, { env, options: options() }, hooks())
  const st1 = store.status('idle')
  const claudeSt = st1.sources.find((s) => s.id === 'claude')!
  check('Claude: the newest 10 of 30 are indexed', [claudeSt.found, claudeSt.indexed, claudeSt.cappedBy], [30, 10, 'perSource'])
  check('...and it is said', sourceDisclosure(claudeSt, options().caps), 'Indexed the newest 10 of 30 chats (the limit is 10 per tool).')
  const kept = store.chatsOf('claude').map((c) => c.nativeId).sort()
  check('...the NEWEST ten', kept, Array.from({ length: 10 }, (_, k) => uuid(20 + k)).sort())
  check('Codex: the user thread only (the guardian subagent is left out)', store.chatsOf('codex').map((c) => c.nativeId), [codexId])
  check('OpenCode: the session, not its child', store.chatsOf('opencode').map((c) => c.nativeId), ['ses_abc123'])
  check('Zed and Cowork indexed', [store.count('zed'), store.count('claude-cowork')], [1, 1])
  const clineSt = st1.sources.find((s) => s.id === 'cline')!
  check(
    'Cline: copies of chats their tool still has are folded — in range or not — its own session and an orphaned copy kept',
    [store.chatsOf('cline').map((c) => c.nativeId).sort(), clineSt.duplicates],
    [['1783576295230_ORPH1', '1783576295230_OWN01'], 3]
  )
  check('...and that is said', sourceDisclosure(clineSt, options().caps), 'Indexed all 2 chats. 3 more are copies of chats their own tool still has, so they are searched there, not twice.')
  check('...an out-of-range original is not smuggled in through its copy', [words(store, 'clineoldcopyword'), words(store, 'orphanedcopyword')], [[], ['cline:1783576295230_ORPH1']])
  check('...nor a subagent thread, while subagents are off', words(store, 'clineguardcopyword'), [])
  check('the pass read files and stopped at no pass cap', [pass1.filesRead > 0, pass1.stoppedBy], [true, null])
  if (STORE_MODE_CHECKABLE) {
    const mode = (p: string): string => (existsSync(p) ? (statSync(p).mode & 0o777).toString(8) : 'absent')
    check('store dir 0700; database, WAL and shm 0600', [mode(storeDir), mode(join(storeDir, 'index.sqlite')), mode(join(storeDir, 'index.sqlite-wal')), mode(join(storeDir, 'index.sqlite-shm'))], [
      '700',
      '600',
      '600',
      '600'
    ])
  } else console.log('  NOTE  file modes are not POSIX on Windows; the 0600 check runs on macOS and Linux')

  section('search: user and assistant words only')
  check('a user word', words(store, 'topic29'), [`claude:${uuid(29)}`])
  check('an assistant word', words(store, 'answer25'), [`claude:${uuid(25)}`])
  check('a title: Codex’s thread NAME, not its context-prefixed title', [words(store, 'Quokka thread'), words(store, 'ctxtitleword')], [[`codex:${codexId}`], []])
  for (const w of ['toolinputword', 'tooloutputword', 'thinkword', 'metaword', 'sidechainword', 'subagentword', 'developerword', 'envcontextword', 'eventdupword', 'reasoningword', 'functionargword', 'functionoutputword', 'guardianword', 'syntheticword', 'ocreasonword', 'opencodetoolword', 'childsessionword', 'envdetailsword', 'clinetoolword', 'clineresultword', 'clinecopyword', 'zedthinkword', 'zedtoolword', 'zedmentionword']) {
    check(`never indexed: ${w}`, words(store, w), [])
  }
  check('the account fields in Cowork’s metadata are never indexed', [words(store, 'example.com'), words(store, 'Secretive')], [[], []])
  check('a base64 blob is not searchable', words(store, 'Zm9vYmFyYmF6'), [])
  check('an API key is not searchable', words(store, 'ABCDEFGHIJKLMNOPQRSTUV'), [])
  check('...its place is marked', words(store, 'redacted'), [`claude:${uuid(29)}`])
  check('every source answers', ['wombat', 'bandicoot', 'echidna', 'numbat', 'dingo'].map((w) => words(store, w)[0]?.split(':')[0]), ['codex', 'opencode', 'zed', 'claude-cowork', 'cline'])
  const viet = store.search('Viet tieng')
  check('diacritics fold: "Viet tieng" finds "tiếng Việt"', viet.map((h) => h.nativeId), [uuid(29)])
  const sn = viet[0]?.snippet
  check('...and the snippet highlights the words as written', sn ? sn.ranges.map(([s, e]) => sn.text.slice(s, e)).sort() : null, ['Việt', 'tiếng'])
  check('a CJK word standing alone', words(store, '日本語'), [`claude:${uuid(29)}`])
  check('Größe', words(store, 'größe'), [`claude:${uuid(29)}`])
  // Every hit's snippet is its OWN chat's text (gotcha 125: a REAL-bound rowid gave all of them the first one's).
  const alpha = store.search('alpha')
  check(
    'each hit quotes its own chat',
    [alpha.length >= 5, alpha.every((h) => h.snippet.text.includes(`answer${Number(h.nativeId.slice(-12))} alpha`))],
    [true, true]
  )
  const codexHit = store.search('wombat')[0]
  check('a hit carries what opening needs', [codexHit.cwd, codexHit.title, codexHit.role, codexHit.subagent], ['/tmp/codex-proj', 'Quokka thread name', 'assistant', false])

  {
    // One conversation that says a word hundreds of times must not crowd out the others.
    const crowd = ChatStore.open(join(root, 'crowd-index'))
    const meta = { title: null, firstPrompt: null, cwd: '/w', gitBranch: null, model: null, createdMs: T0, updatedMs: T0 }
    const loud = crowd.upsertChat('claude', 'loud', meta, { subagent: false, dedupeKey: null, whole: true })
    crowd.appendMessages(loud, Array.from({ length: 600 }, (_, k) => ({ role: 'assistant' as const, text: `crowdword crowdword again ${k}`, atMs: T0 })))
    const quiet = crowd.upsertChat('codex', 'quiet', meta, { subagent: false, dedupeKey: null, whole: true })
    crowd.appendMessages(quiet, [{ role: 'user', text: 'one crowdword here', atMs: T0 }])
    check('one hit per chat, and a loud chat cannot crowd a quiet one out', crowd.search('crowdword').map((h) => h.nativeId).sort(), ['loud', 'quiet'])
    crowd.close()
  }

  section('subagents on: a subagent’s own transcript is its text')
  {
    const sub = ChatStore.open(join(root, 'sub-index'))
    await runPass(sub, { env, options: options({ subagents: true }) }, hooks())
    const subId = `${uuid(29)}/agent-a1`
    const hit = sub.search('subagentword')
    check('its words are searchable (every record in it is a sidechain one)', hit.map((h) => `${h.source}:${h.nativeId}`), [`claude:${subId}`])
    check('...as a subagent chat, both turns, its tool payloads left out', [hit[0]?.subagent, sub.messages(sub.chatId('claude', subId) ?? -1).length, words(sub, 'subtoolword'), words(sub, 'subtooloutputword')], [
      true,
      2,
      [],
      []
    ])
    check('a sidechain record inside a top-level transcript is still not the user’s thread', words(sub, 'sidechainword'), [])
    check(
      'no chat is stored with nothing to search',
      sub.chatsOf('claude').filter((c) => sub.messages(c.id).length === 0).length,
      0
    )
    sub.close()
  }

  section('a transcript with nothing to search is never a chat, and takes no slot')
  {
    // Newest first: an empty session (opened, /clear, closed), then two real ones, under a per-tool cap of 2.
    const eHome = join(root, 'empty-home')
    const eEnv: SourceEnv = { home: eHome, env: {}, platform: process.platform }
    const eDir = join(eHome, '.claude', 'projects', '-tmp-empty-proj')
    const eFile = (n: number): string => join(eDir, `${uuid(n)}.jsonl`)
    write(
      eFile(1),
      jl([
        { type: 'permission-mode', permissionMode: 'default' },
        { type: 'user', isMeta: true, cwd: '/tmp/empty-proj', message: { content: 'metaword' }, timestamp: iso(T0) },
        { type: 'user', cwd: '/tmp/empty-proj', message: { content: '<command-name>/clear</command-name>' }, timestamp: iso(T0) }
      ]),
      T0 + 30 * 60_000
    )
    // A session that `cd`s: its folder is the one it started in, which is where it resumes from.
    write(
      eFile(2),
      jl([
        { type: 'user', cwd: '/tmp/empty-proj', message: { content: 'started here gerbilword' }, timestamp: iso(T0 + 1000) },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] }, timestamp: iso(T0 + 2000) },
        { type: 'user', cwd: '/tmp/empty-proj/moved', message: { content: 'then moved' }, timestamp: iso(T0 + 3000) }
      ]),
      T0 + 20 * 60_000
    )
    write(eFile(3), claudeChat(3, '/tmp/empty-proj', 'hamsterword'), T0 + 10 * 60_000)
    const e = ChatStore.open(join(root, 'empty-index'))
    const eOpts = options({}, { perSource: 2 })
    await runPass(e, { env: eEnv, options: eOpts }, hooks())
    check('the empty transcript is read but never stored as a chat', [e.hasChat('claude', uuid(1)), e.hasChat('claude', uuid(2))], [false, true])
    check('a whole read keeps the FIRST cwd, not the one a cd left', e.search('gerbilword')[0]?.cwd, '/tmp/empty-proj')
    await runPass(e, { env: eEnv, options: eOpts }, hooks())
    check('...and on the next pass its slot goes to the next-newest real chat', e.chatsOf('claude').map((c) => c.nativeId).sort(), [uuid(2), uuid(3)])
    const still = await runPass(e, { env: eEnv, options: eOpts }, hooks())
    check('...and then nothing is read again', [still.filesRead, still.bytesRead], [0, 0])
    appendFileSync(eFile(1), jl([{ type: 'user', cwd: '/tmp/empty-proj', message: { content: 'now a real question jerboaword' }, timestamp: iso(T0 + 5000) }]))
    utimesSync(eFile(1), (T0 + 31 * 60_000) / 1000, (T0 + 31 * 60_000) / 1000)
    await runPass(e, { env: eEnv, options: eOpts }, hooks())
    check('once it says something it is a chat again, newest, and the oldest makes room', [words(e, 'jerboaword'), e.chatsOf('claude').map((c) => c.nativeId).sort()], [
      [`claude:${uuid(1)}`],
      [uuid(1), uuid(2)]
    ])
    e.close()
  }

  section('incremental: only appended bytes are read')
  const pass2 = await runPass(store, { env, options: options() }, hooks())
  check('an unchanged pass reads nothing', [pass2.bytesRead, pass2.filesRead], [0, 0])
  const target = claudeFile(27)
  const beforeMsgs = store.messages(store.chatId('claude', uuid(27))!).length
  // The appended turn ran after a `cd`: the chat's folder must stay the one it started in.
  const addition = jl([
    { type: 'user', message: { content: 'appended question platypusfish' }, cwd: '/tmp/proj-a/moved', timestamp: iso(T0 + 27 * 60_000 + 5000) },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'appended answer' }] }, timestamp: iso(T0 + 27 * 60_000 + 6000) }
  ])
  appendFileSync(target, addition)
  utimesSync(target, (T0 + 27 * 60_000 + 7000) / 1000, (T0 + 27 * 60_000 + 7000) / 1000)
  const pass3 = await runPass(store, { env, options: options() }, hooks())
  check('the append costs its own bytes plus the one-byte newline check', pass3.bytesRead, Buffer.byteLength(addition) + 1)
  check('...folds exactly two new messages, no duplicates', store.messages(store.chatId('claude', uuid(27))!).length - beforeMsgs, 2)
  check('...and they are searchable', words(store, 'platypusfish'), [`claude:${uuid(27)}`])
  check('...and an append never moves the chat’s folder (the first cwd is where it resumes)', store.search('platypusfish')[0]?.cwd, '/tmp/proj-a')
  // A partial last line is not folded until its newline arrives, and then once.
  appendFileSync(target, JSON.stringify({ type: 'user', message: { content: 'halfline kiwiword' }, timestamp: iso(T0) }))
  await runPass(store, { env, options: options() }, hooks())
  check('a line with no newline yet is not read', words(store, 'kiwiword'), [])
  appendFileSync(target, '\n')
  await runPass(store, { env, options: options() }, hooks())
  check('...and is read once it is complete', [words(store, 'kiwiword'), store.search('kiwiword').length], [[`claude:${uuid(27)}`], 1])
  const afterKiwi = store.messages(store.chatId('claude', uuid(27))!).length
  // Rewritten in place under a new inode: read again from byte 0, not appended to.
  const tmp = `${target}.new`
  write(tmp, claudeChat(27, '/tmp/proj-a', 'rewrittenword'), T0 + 27 * 60_000 + 9000)
  renameSync(tmp, target)
  await runPass(store, { env, options: options() }, hooks())
  const rewritten = store.messages(store.chatId('claude', uuid(27))!)
  check('a replaced file is read whole: the old words go, the new come', [words(store, 'platypusfish'), words(store, 'rewrittenword').length, rewritten.length < afterKiwi], [[], 1, true])

  section('pruning, source switches, and the bystanders')
  unlinkSync(claudeFile(25))
  await runPass(store, { env, options: options() }, hooks())
  check('a transcript deleted at the source leaves the index', store.hasChat('claude', uuid(25)), false)
  check('...and the next-newest moves into range', store.hasChat('claude', uuid(19)), true)
  check('the bystander in the transcripts folder is untouched', readFileSync(join(projDir, 'notes.txt'), 'utf8'), 'bystander, not a chat')
  await runPass(store, { env, options: options({ sources: { ...CHAT_INDEX_DEFAULTS.sources, zed: false } }) }, hooks())
  check('a source switched off is dropped from the store', store.count('zed'), 0)
  await runPass(store, { env, options: options() }, hooks())
  check('...and comes back when switched on', store.count('zed'), 1)

  section('the pass caps: total, time, bytes, file size, text size, discovery')
  await runPass(store, { env, options: options({}, { total: 12 }) }, hooks())
  const stTotal = store.status('idle')
  check('total: the newest 12 across every source (a folded copy takes no slot)', store.count(), 12)
  const cutClaude = stTotal.sources.find((s) => s.id === 'claude')!
  check('...and the source it cut says the total is why', [cutClaude.cappedBy, sourceDisclosure(cutClaude, options({}, { total: 12 }).caps).includes('12-chat limit')], ['total', true])
  await runPass(store, { env, options: options() }, hooks())
  check('...lifting it brings them back', store.count() > 12, true)

  const timeStore = ChatStore.open(join(root, 'time-index'))
  // Every read of the clock moves it 2 s: the listing takes a few, then each chat one.
  let t = 0
  const timed = await runPass(timeStore, { env, options: options({}, { passSeconds: 10 }) }, hooks({ now: () => (t += 2_000) }))
  const timedClaude = timeStore.status('idle').sources.find((s) => s.id === 'claude')!
  check('time: a pass stops at its wall-time cap, and says which', [timed.stoppedBy, timedClaude.cappedBy], ['time', 'time'])
  check('...having read part of the range', timedClaude.indexed > 0 && timedClaude.indexed < 10, true)
  check(
    '...and the source says it is still going, against its target',
    sourceDisclosure(timedClaude, options({}, { passSeconds: 10 }).caps).startsWith(`Still indexing: ${timedClaude.indexed} of 10 so far (the newest 10 of ${timedClaude.found}).`),
    true
  )
  const resumed = await runPass(timeStore, { env, options: options() }, hooks())
  check('...and the next pass carries on to the full range', [resumed.stoppedBy, timeStore.count('claude')], [null, 10])
  timeStore.close()

  const byteStore = ChatStore.open(join(root, 'byte-index'))
  const bytePass = await runPass(byteStore, { env, options: options({}, { passMb: 0.001 }) }, hooks())
  check('bytes: a pass stops at its byte cap', [bytePass.stoppedBy, byteStore.count() < 10], ['bytes', true])
  byteStore.close()

  const bigStore = ChatStore.open(join(root, 'big-index'))
  // Just under chat 29's size (the one with the long pasted line): it is over the cap, the rest are not.
  const fileMb = (statSync(claudeFile(29)).size - 100) / (1024 * 1024)
  check('(fixture: every other chat in range is under that cap)', Array.from({ length: 9 }, (_, k) => 20 + k).filter((i) => i !== 25).every((i) => statSync(claudeFile(i)).size < statSync(claudeFile(29)).size - 100), true)
  await runPass(bigStore, { env, options: options({}, { fileMb }) }, hooks())
  const bigSt = bigStore.status('idle').sources.find((s) => s.id === 'claude')!
  const bigId = bigStore.chatId('claude', uuid(29))
  check('file size: a transcript over the cap is read as a head and a tail, and flagged', [bigSt.truncated, bigId !== null && bigStore.messages(bigId).length > 0], [1, true])
  check('...and it is said', sourceDisclosure(bigSt, options({}, { fileMb }).caps).includes('1 is kept in part'), true)
  bigStore.close()

  setDiscoveryLimitForTest(5)
  const discStore = ChatStore.open(join(root, 'disc-index'))
  await runPass(discStore, { env, options: options() }, hooks())
  const discSt = discStore.status('idle').sources.find((s) => s.id === 'claude')!
  check('discovery: a listing that stops counting says "at least", and prunes nothing', [discSt.foundAtLeast, discSt.cappedBy], [true, 'discovery'])
  setDiscoveryLimitForTest(DISCOVERY_MAX_ENTRIES)
  discStore.close()

  section('a cancelled pass writes nothing half-done and prunes nothing')
  const cancelStore = ChatStore.open(join(root, 'cancel-index'))
  let n = 0
  await runPass(cancelStore, { env, options: options() }, hooks({ cancelled: () => ++n > 3 }))
  const cancelledCount = cancelStore.count()
  await runPass(cancelStore, { env, options: options() }, hooks())
  check('a later pass completes it', [cancelledCount < cancelStore.count(), cancelStore.count('claude')], [true, 10])
  cancelStore.close()
  store.close()

  section('the worker: main asks, the worker reads, the main loop keeps turning')
  // A big transcript, so a pass is long enough to measure what it blocks.
  const heavy = join(projDir, `${uuid(900)}.jsonl`)
  const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'heavy line lorem ipsum dolor sit amet '.repeat(20) }] }, timestamp: iso(T0) })
  write(heavy, (line + '\n').repeat(Math.ceil((24 * 1024 * 1024) / (line.length + 1))), T0 + 100 * 60_000)
  const workerDir = join(userData, 'worker-index')
  write(join(userData, 'bystander.txt'), 'beside the store')
  const statuses: string[] = []
  const host = new ChatIndexHost({
    workerPath: fileURLToPath(new URL('../src/main/chatIndex/worker.ts', import.meta.url)),
    dir: workerDir,
    onStatus: (s) => statuses.push(s.state)
  })
  const emptyStatus = await host.status()
  check('a status read creates no store', [emptyStatus.chats, existsSync(join(workerDir, 'index.sqlite'))], [0, false])
  const wdet = await host.detect(env, false)
  check('detect through the worker', wdet.sources.find((s) => s.id === 'claude')?.chats, 30)
  let maxGap = 0
  let last = performance.now()
  const probe = setInterval(() => {
    const now = performance.now()
    maxGap = Math.max(maxGap, now - last)
    last = now
  }, 1)
  const t0 = performance.now()
  const wpass = await host.scan({ env, options: options() })
  const passMs = performance.now() - t0
  clearInterval(probe)
  check('the pass ran in the worker and read the big file', (wpass?.bytesRead ?? 0) > 20 * 1024 * 1024, true)
  /*
   * Relative, not a fixed number of ms: a loaded CI runner (or Windows' coarse
   * timers) can stretch any one gap. The counterfactual is the same pass run on
   * THIS thread, measured the same way: a 24 MB transcript is one synchronous
   * read, and that is the stall the worker exists to keep off the main process.
   */
  const inThread = ChatStore.open(join(root, 'in-thread-index'))
  let ownGap = 0
  let ownLast = performance.now()
  const ownProbe = setInterval(() => {
    const now = performance.now()
    ownGap = Math.max(ownGap, now - ownLast)
    ownLast = now
  }, 1)
  await runPass(inThread, { env, options: options() }, { ...hooks(), now: Date.now, yieldTurn: () => new Promise((r) => setImmediate(r)) })
  clearInterval(ownProbe)
  inThread.close()
  check(
    `the main loop never waited on it (max gap ${maxGap.toFixed(1)} ms in the worker, ${ownGap.toFixed(1)} ms for the same pass on this thread)`,
    maxGap < Math.max(50, passMs / 3) && maxGap * 3 < ownGap,
    true
  )
  check('a second scan while one runs is queued, not doubled', await Promise.all([host.scan({ env, options: options() }), host.scan({ env, options: options() })]).then((r) => r.filter((x) => x === null).length >= 1), true)
  check('search through the worker', (await host.search('wombat', 10)).map((h) => h.source), ['codex'])
  {
    // A second, reading connection beside the worker's (WAL allows it): the big chat's text is held to its cap.
    const peek = ChatStore.open(workerDir)
    const heavyId = peek.chatId('claude', uuid(900))
    const kept = heavyId === null ? -1 : peek.messages(heavyId).reduce((n, m) => n + Buffer.byteLength(m.text), 0)
    check(`text size: a 24 MB transcript keeps at most its ${CHAT_CAP_DEFAULTS.chatKb} KB of text (kept ${kept})`, kept > 400 * 1024 && kept <= CHAT_CAP_DEFAULTS.chatKb * 1024, true)
    check('...and is flagged as kept in part', peek.status('idle').sources.find((s) => s.id === 'claude')!.truncated >= 1, true)
    peek.close()
  }
  check('status was pushed while it ran', statuses.includes('running') && statuses.includes('idle'), true)
  await host.deleteIndex()
  check('Delete index removes the store…', existsSync(workerDir), false)
  check('…and nothing beside it', readFileSync(join(userData, 'bystander.txt'), 'utf8'), 'beside the store')
  check('after delete, search is empty and status is zero', [await host.search('wombat', 10), (await host.status()).chats], [[], 0])
  await host.stop()
} finally {
  rmSync(root, { recursive: true, force: true })
}

/*
 * The tally is the LAST statement in this file and has to stay that way:
 * `process.exitCode` is set once, so an assertion below it could print FAIL and
 * still exit 0 (CLAUDE.md gotchas 50 and 62).
 */
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
