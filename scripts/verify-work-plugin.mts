import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkPlugin, changeWork, readWorkState } from '../src/main/plugins/work.ts'
import { localWorkDay, validWorkDay } from '../src/shared/workPlugin.ts'
import type { WorkCommand, WorkState } from '../src/shared/workPlugin.ts'

let failures = 0
function check(name: string, actual: unknown, expected: unknown): void {
  const okay = JSON.stringify(actual) === JSON.stringify(expected)
  if (!okay) failures++
  console.log(`  ${okay ? 'PASS' : 'FAIL'} ${name}${okay ? '' : `: got ${JSON.stringify(actual)}, wanted ${JSON.stringify(expected)}`}`)
}
function refuses(fn: () => unknown): boolean { try { fn(); return false } catch { return true } }
let sequence = 0
const id = (): string => `record-${++sequence}`
let clock = 1000
const timezone = 'Australia/Melbourne'
let state: WorkState = { schema: 1, revision: 0, enabled: false, tasks: [], daily: [] }
const apply = (command: WorkCommand): void => { state = changeWork(state, command, ++clock, id, timezone) }
const task = (): typeof state.tasks[number] => state.tasks[0]
const command = (kind: 'approve' | 'start' | 'plan', day = '2026-10-09'): WorkCommand => ({ kind, id: task().id, revision: task().revision, day })

console.log('\nWork: approval, daily history and evidence')
check('fresh installs are opt-in', state.enabled, false)
check('disabled boards reject new work', refuses(() => apply({ kind: 'idea', title: 'build', brief: '', project: '' })), true)
apply({ kind: 'enable', enabled: true })
apply({ kind: 'idea', title: '改善 Stoke 🔥', brief: 'Record the checks', project: 'Stoke' })
check('an idea cannot start itself', refuses(() => apply(command('start'))), true)
apply(command('plan'))
check('planning does not approve or start work', task().status, 'Idea')
apply(command('plan'))
check('repeat plans keep one task/day pair', state.daily.length, 1)
apply({ kind: 'edit', id: task().id, revision: task().revision, title: 'Stoke release', brief: 'Proof', project: 'Stoke' })
check('editing the idea updates its planned title', state.daily[0].title, 'Stoke release')
const stale = task().revision
apply(command('approve'))
check('approval records no execution or assigned session', [task().status, task().sessionId, state.daily[0].status], ['Approved', null, 'To-Do'])
check('a late action cannot overwrite the latest task', refuses(() => apply({ kind: 'edit', id: task().id, revision: stale, title: 'stale', brief: '', project: '' })), true)
apply({ ...command('start'), sessionId: 'session-one' } as WorkCommand)
check('starting links this day to the assigned session', [task().status, state.daily[0].status, state.daily[0].sessionId], ['Working', 'Working on', 'session-one'])
check('completion requires evidence', refuses(() => apply({ kind: 'complete', id: task().id, revision: task().revision, day: '2026-10-09', evidence: '  ' })), true)
apply(command('plan', '2026-10-10'))
apply({ kind: 'complete', id: task().id, revision: task().revision, day: '2026-10-10', evidence: 'Checks passed; commit abc123.' })
check('completion keeps one durable task and two days', [state.tasks.length, state.daily.length, task().status], [1, 2, 'Completed'])
check('yesterday remains a truthful history', state.daily.map((d) => [d.day, d.status]), [['2026-10-09', 'Working on'], ['2026-10-10', 'Completed']])
check('today retains the completion evidence', state.daily[1].evidence, task().evidence)
check('daily entries preserve their timezone', state.daily.map((r) => r.timezone), [timezone, timezone])
apply({ kind: 'daily', day: '2026-10-10', title: 'Fix an unexpected issue', notes: 'A support request' })
const unplanned = state.daily[2]
apply({ kind: 'daily-edit', id: unplanned.id, revision: unplanned.revision, status: 'Completed', notes: 'Resolved', evidence: 'Support case closed' })
check('unplanned work needs no invented backlog task', [state.daily[2].taskId, state.tasks.length], [null, 1])
apply({ kind: 'enable', enabled: false })
check('disabling retains all records and evidence', [state.tasks.length, state.daily.length, state.daily[2].evidence], [1, 3, 'Support case closed'])
check('schema round-trip retains linked history', readWorkState(JSON.parse(JSON.stringify(state))), state)
check('future schemas are preserved by refusing writes', refuses(() => readWorkState({ ...state, schema: 2 })), true)
check('invalid dates are refused', ['2026-02-30', '2026-13-01', '2026-2-01', 'x'].every((d) => !validWorkDay(d)), true)
check('leap days are allowed', validWorkDay('2028-02-29'), true)
check('local date uses the local calendar', localWorkDay(new Date(2026, 9, 9, 0, 1)), '2026-10-09')
check('dangling task relations are refused', refuses(() => readWorkState({ ...state, daily: [{ ...state.daily[0], taskId: 'missing' }] })), true)

console.log('\nWork: durable isolated storage and concurrent calls')
const root = await mkdtemp(join(tmpdir(), 'stoke-work-plugin-'))
try {
  const legacy = join(root, 'worklog-queue.json')
  const prior = JSON.stringify({ proposals: [{ id: 'keep', status: 'accepted', urls: { notion: 'https://www.notion.so/example' } }, { id: 'refusal', status: 'rejected' }] })
  await writeFile(legacy, prior)
  const plugin = new WorkPlugin(root)
  check('read-only opening creates no record file', (await plugin.read()).tasks.length, 0)
  check('read-only opening leaves the legacy queue alone', await readdir(root), ['worklog-queue.json'])
  await plugin.change({ kind: 'enable', enabled: true })
  await Promise.all(Array.from({ length: 6 }, (_, n) => plugin.change({ kind: 'idea', title: `Idea ${n}`, brief: '', project: '' })))
  const saved = await plugin.read()
  check('simultaneous saves do not lose any ideas', saved.tasks.length, 6)
  check('simultaneous saves mint distinct identities', new Set(saved.tasks.map((r) => r.id)).size, 6)
  const current = saved.tasks[0]
  const attempts = await Promise.allSettled([1, 2].map(() => plugin.change({ kind: 'approve', id: current.id, revision: current.revision, day: '2026-10-09' })))
  check('two approval clicks commit once', attempts.map((r) => r.status), ['fulfilled', 'rejected'])
  const disk = new WorkPlugin(root)
  check('restarting keeps all committed revisions', await disk.read(), await plugin.read())
  const copy = await plugin.read(); copy.tasks[0].title = 'mutated reply'
  check('reply mutations cannot change stored state', (await plugin.read()).tasks[0].title, current.title)
  check('accepted URLs and rejection tombstones remain byte-for-byte', await readFile(legacy, 'utf8'), prior)
  if (process.platform !== 'win32') check('board data is owner-only', (await stat(plugin.file)).mode & 0o777, 0o600)
  check('atomic saves leave no temporary files', (await readdir(join(root, 'plugins'))).filter((f) => f.endsWith('.tmp')), [])
  plugin.stop()
  check('quit refuses new mutations', (await Promise.allSettled([plugin.change({ kind: 'enable', enabled: false })]))[0].status, 'rejected')
  disk.stop()
  const bad = '{keep the corrupted bytes'
  await writeFile(plugin.file, bad)
  const corrupt = new WorkPlugin(root)
  check('a corrupt store refuses mutations', (await Promise.allSettled([corrupt.change({ kind: 'enable', enabled: true })]))[0].status, 'rejected')
  check('a corrupt store is never overwritten with defaults', await readFile(plugin.file, 'utf8'), bad)
  corrupt.stop()
} finally { await rm(root, { recursive: true, force: true }) }

console.log(failures ? `\n${failures} failed` : '\nall pass')
process.exitCode = failures ? 1 : 0
