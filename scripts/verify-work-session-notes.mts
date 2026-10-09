import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PtyManager } from '../src/main/pty.ts'
import { recentWorkNotes, WorkSessionNotesReader } from '../src/main/plugins/workSessionNotes.ts'

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const okay = JSON.stringify(actual) === JSON.stringify(expected)
  if (!okay) failures++
  console.log(`  ${okay ? 'PASS' : 'FAIL'} ${name}${okay ? '' : `: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`)
}
async function rejection(run: Promise<unknown>): Promise<string> { try { await run; return '' } catch (err) { return err instanceof Error ? err.message : String(err) } }
const root = await mkdtemp(join(tmpdir(), 'stoke-work-notes-'))
const sessionId = 'd871d09b-6a9e-4ca6-b73b-c3effd7f7b9f'
const file = join(root, 'session.jsonl')
const line = (role: string, content: unknown, extra = {}) => JSON.stringify({ type: role, sessionId, timestamp: '2026-10-09T09:00:00Z', message: { content }, ...extra }) + '\n'
try {
  console.log('\nWork session notes: the exact main-owned session admission')
  const ptys = new PtyManager(() => {}, () => {}, () => {})
  const sessions = (ptys as unknown as { sessions: Map<string, unknown> }).sessions
  const ordinary = { sessionId, ordinary: true, instrumented: true, private: false, hostId: null, exited: false }
  sessions.set('owned', ordinary)
  check('only the owned ordinary local Claude session can supply notes', ptys.workNotesSession('owned'), { sessionId })
  for (const [label, patch] of [
    ['private', { private: true }], ['SSH', { hostId: 'fixture-host' }], ['ended', { exited: true }],
    ['setup', { ordinary: false }], ['other CLI', { instrumented: false }], ['unbound continue', { sessionId: '' }]
  ] as const) {
    sessions.set('owned', { ...ordinary, ...patch })
    check(`${label} cannot supply transcript input`, ptys.workNotesSession('owned'), null)
  }
  check('unknown and other PTY identities cannot choose a transcript', ptys.workNotesSession('stranger'), null)
  sessions.clear()

  console.log('\nWork session notes: real bounded JSONL reads and forced redaction')
  const original = line('user', 'Build a café dashboard 🔥. api_key="fixture-secret-value"') +
    line('assistant', [{ type: 'thinking', thinking: 'Never expose reasoning' }, { type: 'tool_use', name: 'Bash', input: { command: 'private tool input' } }, { type: 'text', text: 'Implemented the first screen; checks are still pending.' }]) +
    line('user', [{ type: 'tool_result', content: 'private tool output' }]) +
    line('assistant', 'Sidechain must not appear', { isSidechain: true }) +
    line('user', 'Meta must not appear', { isMeta: true }) +
    line('assistant', 'Different owner must not appear', { sessionId: 'different-session' }) +
    line('assistant', 'Incomplete turn must not appear').slice(0, -1)
  await writeFile(file, original)
  const notes = await recentWorkNotes(file, sessionId)
  check('conversation roles and Unicode survive without inventing completion', [notes.turns, notes.text.includes('User: Build a café dashboard 🔥'), notes.text.includes('checks are still pending')], [2, true, true])
  check('keys, tool input/output, reasoning, meta and other sessions are excluded', ['fixture-secret-value', 'private tool', 'Never expose', 'Sidechain', 'Meta must', 'Different owner', 'Incomplete turn'].some(word => notes.text.includes(word)), false)
  check('a partial trailing record is explicitly flagged', notes.truncated, true)
  check('reading leaves original transcript bytes untouched', await readFile(file, 'utf8'), original)
  await writeFile(file, line('user', 'Earlier text'.repeat(90000)) + Array.from({ length: 40 }, (_, at) => line('assistant', `Turn ${at}: 日本語 🔥 ${'useful observation '.repeat(70)}`)).join(''))
  const bounded = await recentWorkNotes(file, sessionId)
  check('a large tail stays bounded and includes the newest complete turn', [Buffer.byteLength(bounded.text, 'utf8') <= 4096, bounded.text.includes('Turn 39'), bounded.text.includes('\ufffd'), bounded.truncated, bounded.turns <= 24], [true, true, false, true, true])
  await writeFile(file, line('assistant', 'Short completed conversation turn'))
  check('an uncut complete transcript is not labelled truncated', (await recentWorkNotes(file, sessionId)).truncated, false)
  check('folders cannot be opened as transcripts', !!await rejection(recentWorkNotes(root, sessionId)), true)
  if (process.platform !== 'win32') {
    const linked = join(root, 'linked.jsonl'); await symlink(file, linked)
    check('a replaced transcript leaf cannot redirect its read through a symlink', !!await rejection(recentWorkNotes(linked, sessionId)), true)
  }

  console.log('\nWork session notes: disable, stale owners, concurrent reads and deadlines')
  let enabled = true; let owner: { sessionId: string } | null = { sessionId }; let calls = 0
  const reader = new WorkSessionNotesReader({ enabled: async () => enabled, owner: () => owner, file: async () => { calls++; return file } })
  owner = null
  check('an unavailable session is refused before file lookup', [!!await rejection(reader.read('pty', sessionId)), calls], [true, 0])
  owner = { sessionId }; enabled = false
  check('disabled Work reads no transcript', [!!await rejection(reader.read('pty', sessionId)), calls], [true, 0])
  enabled = true
  check('a renderer cannot choose another session ID for this PTY', [!!await rejection(reader.read('pty', 'stranger')), calls], [true, 0])
  const ready = await reader.read('pty', sessionId)
  check('a successful preview names its exact owner and capture time', [ready.ptyId, ready.sessionId, ready.capturedAt > 0, ready.text.includes('Short completed')], ['pty', sessionId, true, true])

  let release!: (value: string) => void; let started!: () => void
  let began = new Promise<void>(resolve => { started = resolve })
  let pendingFile = new Promise<string>(resolve => { release = resolve })
  const delayed = new WorkSessionNotesReader({ enabled: async () => enabled, owner: () => owner, file: async () => { started(); return pendingFile }, timeoutMs: 30 })
  const pending = rejection(delayed.read('pty', sessionId)); await began
  check('a simultaneous read is refused before await', (await rejection(delayed.read('pty', sessionId))).includes('already running'), true)
  check('the reader returns a bounded deadline failure', (await pending).includes('deadline'), true)
  check('timeout retains the claim while the real lookup is still pending', (await rejection(delayed.read('pty', sessionId))).includes('already running'), true)
  owner = { sessionId: 'cleared-session' }; release(file)
  await new Promise(resolve => setTimeout(resolve, 10))
  check('a changed owner releases the old claim without returning its text', (await rejection(delayed.read('pty', sessionId))).includes('session changed'), true)
  owner = { sessionId }
  began = new Promise<void>(resolve => { started = resolve }); pendingFile = new Promise<string>(resolve => { release = resolve })
  const disabledDuring = new WorkSessionNotesReader({ enabled: async () => enabled, owner: () => owner, file: async () => { started(); return pendingFile } })
  const disabling = rejection(disabledDuring.read('pty', sessionId)); await began; enabled = false; release(file)
  check('disable during the read cannot deliver notes', (await disabling).includes('disabled'), true)
} finally { await rm(root, { recursive: true, force: true }) }
console.log(`\n${failures ? `${failures} failures` : 'All Work session-note checks passed'}`)
process.exitCode = failures ? 1 : 0
