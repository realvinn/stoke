/*
 * Claude Code's own session registry, `<config dir>/sessions/<pid>.json`, and
 * the poller that reads it for every live local Claude pty.
 *
 * The bug this exists for: a tab learned its session id once, at launch, and
 * never again — but `/clear` mints a new id and the in-TUI `/resume` switches
 * to another, so the relaunch pill, Resume, tab restore and the sidebar's
 * de-dupe all went on naming the conversation the process had left. A
 * `/clear`ed id has no transcript, so `claude --resume <it>` exits 1 with "No
 * conversation found". And nothing said whether a turn was running, so the
 * pill could kill one mid-reply. This file is where the CLI states both.
 *
 * Hermetic, and in both halves (gotcha 74): the poller is handed a directory
 * that exists only in a map in memory, and a clock, so nothing here reads the
 * real `~/.claude/sessions` — which on a developer's machine holds the live
 * sessions of whatever else is running, this one's own included. It asserts
 * that too: every path the poller touches is inside the directory it was given.
 *
 *   node scripts/verify-registry.mts
 */
import {
  descendsFrom,
  isBusyStatus,
  parseProcessTable,
  isSafeRegistryId,
  parseRegistry,
  pickEntry,
  REGISTRY_FALLBACK_AFTER_MS,
  rebindTo,
  samePath,
  type RegistryEntry,
  type RegistryTarget
} from '../src/shared/claudeRegistry.ts'
import { basename, dirname, join, sep } from 'node:path'
import { RegistryPoller } from '../src/main/sessionRegistry.ts'
import type { LiveSessionState } from '../src/shared/types.ts'
import {
  activityView,
  afterLooking,
  agentWork,
  backgroundLabel,
  DRAFT_EDGE_WINDOW_MS,
  draftOnPrompt,
  draftOnRegistry,
  NO_DRAFT_TRACK,
  promptClearsDraft,
  registryClearsDraft,
  stopNotifies,
  waitingAlerts,
  waitingLabel,
  type ActivityInput,
  type DraftTrack
} from '../src/shared/activityView.ts'
import type { PromptOrigin } from '../src/shared/types.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

const A = '6b80feb4-1a2b-4c3d-8e4f-000000000001'
const B = '39db23cb-078b-494b-a47e-751c181dd5d5'
const C = '11111111-2222-4333-8444-555555555501'

/*
 * A real file, captured off this machine on 2026-09-19 from `claude` 2.1.278
 * (cwd shortened, socket path kept). The shape the parser has to read.
 */
const REAL =
  '{"pid":33075,"sessionId":"39db23cb-078b-494b-a47e-751c181dd5d5","cwd":"/Volumes/NVME (1TB)/Codes/x",' +
  '"startedAt":1789793375964,"procStart":"Sat Sep 19 04:49:34 2026","version":"2.1.278","peerProtocol":1,' +
  '"peerFeatures":["notify_idle","reply_across_default_dirs","artifact_yield"],"kind":"interactive",' +
  '"entrypoint":"cli","pidDomain":"darwin","messagingSocketPath":"/tmp/cc-socks/33075.sock",' +
  '"name":"x-ba","nameSource":"derived","nameSince":1789793375964,"status":"idle",' +
  '"updatedAt":1789793382426,"statusUpdatedAt":1789793382426}'

console.log('\nparsing a registry file')
check('the real file parses to its session, status and version', (() => {
  const e = parseRegistry(REAL)
  return e && [e.pid, e.sessionId, e.status, e.version, e.cwd, e.startedAt]
})(), [33075, B, 'idle', '2.1.278', '/Volumes/NVME (1TB)/Codes/x', 1789793375964])
check('text that is not JSON is no reading', parseRegistry('{"pid":1,"sess'), null)
check('an empty file is no reading', parseRegistry(''), null)
check('an array is no reading', parseRegistry('[1,2]'), null)
check('a bare number is no reading', parseRegistry('42'), null)
check('null is no reading', parseRegistry('null'), null)
check('an object naming neither a pid nor a session is no reading', parseRegistry('{"status":"busy"}'), null)
check(
  'the first half-second, before the CLI writes a status, reads as status null — not idle',
  parseRegistry(JSON.stringify({ pid: 5, sessionId: A, version: '2.1.278' }))?.status,
  null
)
for (const status of ['busy', 'shell', 'idle', 'waiting'] as const) {
  check(`"${status}" is read as itself`, parseRegistry(JSON.stringify({ pid: 5, sessionId: A, status }))?.status, status)
}
check(
  'a status the binary does not define is null, not a guess',
  parseRegistry(JSON.stringify({ pid: 5, sessionId: A, status: 'thinking' }))?.status,
  null
)
check(
  'waitingFor is kept beside waiting',
  parseRegistry(JSON.stringify({ pid: 5, sessionId: A, status: 'waiting', waitingFor: 'permission' }))?.waitingFor,
  'permission'
)
check(
  'and dropped beside anything else, where it would describe a state that has ended',
  parseRegistry(JSON.stringify({ pid: 5, sessionId: A, status: 'idle', waitingFor: 'permission' }))?.waitingFor,
  null
)
check(
  'a session id carrying a shell metacharacter is refused — it becomes a --resume argument, and cmd.exe acts on & (gotcha 13)',
  parseRegistry(JSON.stringify({ pid: 5, sessionId: 'abc&calc.exe', status: 'idle' }))?.sessionId,
  null
)
check('isSafeRegistryId takes a uuid', isSafeRegistryId(A), true)
check('and refuses a path', isSafeRegistryId('../../etc/passwd'), false)
check('and refuses a non-string', isSafeRegistryId(12345678), false)
check(
  'a wrong-typed field is null, not coerced',
  (() => {
    const e = parseRegistry(JSON.stringify({ pid: '5', sessionId: A, version: 2, startedAt: 'yesterday' }))
    return e && [e.pid, e.version, e.startedAt]
  })(),
  [null, null, null]
)
check('a negative pid is no pid', parseRegistry(JSON.stringify({ pid: -3, sessionId: A }))?.pid, null)

console.log('\nwhich statuses are busy')
check('busy is busy', isBusyStatus('busy'), true)
check('waiting is busy — a permission dialog is the middle of a turn', isBusyStatus('waiting'), true)
check('shell is busy — a command is running', isBusyStatus('shell'), true)
check('only idle is idle', isBusyStatus('idle'), false)
check('no status is "cannot say", never idle', isBusyStatus(null), null)

console.log('\nmatching a pty to its file')
const entry = (over: Partial<RegistryEntry>): RegistryEntry => ({
  pid: null,
  sessionId: null,
  cwd: null,
  status: 'idle',
  waitingFor: null,
  version: '2.1.278',
  startedAt: null,
  statusUpdatedAt: null,
  ...over
})
const target = (over: Partial<RegistryTarget> = {}): RegistryTarget => ({
  ptyId: 'p1',
  pid: 100,
  sessionId: A,
  cwd: '/private/tmp/w',
  startedAt: 1_000_000,
  ...over
})
check('the file named after the pid, stating that pid, wins', pickEntry(target(), entry({ pid: 100, sessionId: B }), null, new Set())?.sessionId, B)
check(
  'a file under that name stating ANOTHER pid is not this process',
  pickEntry(target(), entry({ pid: 999, sessionId: B }), null, new Set()),
  null
)
check(
  'with no pid file, the one entry holding our id is ours (a .cmd install runs under cmd.exe, so the pids differ)',
  pickEntry(target(), null, [entry({ pid: 7, sessionId: A }), entry({ pid: 8, sessionId: B, cwd: '/private/tmp/w' })], new Set())?.pid,
  7
)
check(
  'two entries holding our id is no answer',
  pickEntry(target(), null, [entry({ pid: 7, sessionId: A }), entry({ pid: 8, sessionId: A })], new Set()),
  null
)
// pty 100 -> cmd.exe-ish 101 -> claude 7; 8 and 9 are strangers (a terminal `claude`).
const TREE = new Map<number, number>([[101, 100], [7, 101], [8, 50], [9, 1]])
const ours = (pid: number): boolean => descendsFrom(pid, 100, TREE)
check(
  'a --continue (no id yet): the one entry in our folder, started after us, under our pty',
  pickEntry(
    target({ sessionId: '' }),
    null,
    [entry({ pid: 7, sessionId: B, cwd: '/private/tmp/w', startedAt: 1_000_500 }), entry({ pid: 8, sessionId: C, cwd: '/elsewhere' })],
    new Set(),
    ours
  )?.sessionId,
  B
)
check(
  'but not one that started long before we spawned — that is somebody else\'s session in the same folder',
  pickEntry(target({ sessionId: '' }), null, [entry({ pid: 7, sessionId: B, cwd: '/private/tmp/w', startedAt: 1 })], new Set(), ours),
  null
)
check(
  'and not when two could be it',
  pickEntry(
    target({ sessionId: '' }),
    null,
    [entry({ pid: 7, sessionId: B, cwd: '/private/tmp/w' }), entry({ pid: 101, sessionId: C, cwd: '/private/tmp/w' })],
    new Set(),
    ours
  ),
  null
)
check(
  'and never one another pty has provably claimed by pid',
  pickEntry(target({ sessionId: '' }), null, [entry({ pid: 7, sessionId: B, cwd: '/private/tmp/w' })], new Set([B]), ours),
  null
)
check(
  'gotcha 92: a stranger in the same folder, started after us, is NOT ours — it is not under our pty',
  pickEntry(
    target({ sessionId: '' }),
    null,
    [entry({ pid: 8, sessionId: B, cwd: '/private/tmp/w', startedAt: 1_000_500 })],
    new Set(),
    ours
  ),
  null
)
check(
  'and with no process table to prove descent, the folder fallback answers nothing',
  pickEntry(target({ sessionId: '' }), null, [entry({ pid: 7, sessionId: B, cwd: '/private/tmp/w', startedAt: 1_000_500 })], new Set()),
  null
)
check('descent: a grandchild descends from the pty', descendsFrom(7, 100, TREE), true)
check('descent: a stranger does not', [descendsFrom(8, 100, TREE), descendsFrom(9, 100, TREE)], [false, false])
check('descent: a cycle in the table (pid reuse) ends, false', descendsFrom(3, 100, new Map([[3, 4], [4, 3]])), false)
check(
  'ps -A -o pid=,ppid= output parses, padding and junk lines tolerated',
  [...parseProcessTable('    1     0\n  101   100\r\nPID PPID\n\n 7 101\n')],
  [[1, 0], [101, 100], [7, 101]]
)
check('a trailing separator is the same folder', samePath('/a/b/', '/a/b'), true)
check('Windows folders compare without case', samePath('C:\\Users\\V\\code', 'c:/users/v/CODE'), true)
check('POSIX folders do not', samePath('/Users/V/code', '/users/v/code'), false)

console.log('\nwhen a pty has moved to another session')
check('a /clear is a rebind to the new id', rebindTo(A, entry({ sessionId: B })), B)
check('the same id is not a rebind', rebindTo(A, entry({ sessionId: A })), null)
check('a file naming no session is not a rebind', rebindTo(A, entry({ sessionId: null })), null)
check('no file is not a rebind', rebindTo(A, null), null)
check('a --continue learning its id is a rebind from nothing — gotcha 26', rebindTo('', entry({ sessionId: B })), B)

/* --------------------------------------------------------------- the poller */

/** A registry directory that exists only here. */
function fakeRegistry(dir: string) {
  const files = new Map<string, string>()
  const reads: string[] = []
  let lists = 0
  return {
    files,
    reads,
    get lists() {
      return lists
    },
    fs: {
      readFile: async (path: string): Promise<string> => {
        reads.push(path)
        const text = files.get(path)
        if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
        return text
      },
      readdir: async (d: string): Promise<string[]> => {
        lists++
        reads.push(d)
        return [...files.keys()].filter((f) => dirname(f) === d).map((f) => basename(f))
      }
    },
    put(pid: number, body: Record<string, unknown>): void {
      // Through `join`, as the poller builds its paths, so the suite agrees
      // with it on a Windows runner too.
      files.set(join(dir, `${pid}.json`), JSON.stringify({ pid, ...body }))
    }
  }
}

const DIR = join(sep, 'fake', 'config', 'sessions')
const NOW = 5_000_000

async function scenario(): Promise<void> {
  console.log('\nthe poller, against a directory that exists only in this suite')
  const reg = fakeRegistry(DIR)
  // What PtyManager would say, with `rebind` applied to it the way index.ts does.
  const ptys = new Map<string, RegistryTarget>()
  const rebinds: [string, string, string][] = []
  const states: LiveSessionState[] = []
  const poller = new RegistryPoller(
    () => DIR,
    reg.fs,
    () => [...ptys.values()],
    {
      rebind: (ptyId, sessionId, previous) => {
        rebinds.push([ptyId, sessionId, previous])
        const t = ptys.get(ptyId)
        if (t) ptys.set(ptyId, { ...t, sessionId })
      },
      state: (st) => states.push(st)
    }
  )

  await poller.pass(NOW)
  check('with no Claude pty open, nothing is read at all', reg.reads.length, 0)

  ptys.set('p1', { ptyId: 'p1', pid: 100, sessionId: A, cwd: '/w', startedAt: NOW - 500 })
  await poller.pass(NOW)
  check('a pty whose file is not written yet produces no reading', states.length, 0)
  check('and, being young, does not send the poller listing the directory', reg.lists, 0)

  reg.put(100, { sessionId: A, version: '2.1.278' })
  await poller.pass(NOW)
  check('the file appears without a status: one reading, busy unknown', states.map((s) => [s.sessionId, s.status, s.busy]), [[A, null, null]])

  reg.put(100, { sessionId: A, version: '2.1.278', status: 'idle' })
  await poller.pass(NOW)
  await poller.pass(NOW)
  check('idle arrives once, and an unchanged file is not re-sent', states.map((s) => s.busy), [null, false])

  /*
   * Gotcha 104: a busy blip shorter than one pass — a prompt, then Esc inside
   * the second — reads the same `idle` with a newer statusUpdatedAt. That
   * stamp is what tells activityView the turn is over; unreported, the prompt
   * hook read meanwhile kept the dot pulsing until the next hook.
   */
  reg.put(100, { sessionId: A, version: '2.1.278', status: 'idle', statusUpdatedAt: NOW - 5000, updatedAt: NOW - 5000 })
  await poller.pass(NOW)
  const beforeBlip = states.length
  reg.put(100, { sessionId: A, version: '2.1.278', status: 'idle', statusUpdatedAt: NOW - 200, updatedAt: NOW - 200 })
  await poller.pass(NOW)
  check(
    'a blip between passes (same status, newer statusUpdatedAt) is reported, with the new stamp',
    [states.length - beforeBlip, states[states.length - 1]?.status, states[states.length - 1]?.statusUpdatedAt],
    [1, 'idle', NOW - 200]
  )
  check(
    '…which settles a prompt read during the blip: the dot is done, not working',
    activityView({ hook: { state: 'working', at: NOW - 600, message: null }, live: states[states.length - 1] ?? null, running: true }).dot,
    'done'
  )
  reg.put(100, { sessionId: A, version: '2.1.278', status: 'idle', statusUpdatedAt: NOW - 200, updatedAt: NOW })
  await poller.pass(NOW)
  await poller.pass(NOW)
  check('an unchanged stamp is still not re-sent, whatever updatedAt does', states.length - beforeBlip, 1)

  reg.put(100, { sessionId: A, version: '2.1.278', status: 'busy' })
  await poller.pass(NOW)
  check('a prompt turns it busy', states[states.length - 1]?.busy, true)

  // Measured: /clear goes busy on the OLD id, then the new id appears, then idle.
  reg.put(100, { sessionId: B, version: '2.1.278', status: 'busy' })
  await poller.pass(NOW)
  check('a /clear is reported as a rebind, naming the id it left', rebinds, [['p1', B, A]])
  check('and the reading follows it', states[states.length - 1]?.sessionId, B)
  await poller.pass(NOW)
  check('once main has applied it, the same id is not rebound again', rebinds.length, 1)

  reg.files.delete(join(DIR, '100.json'))
  const before = states.length
  await poller.pass(NOW)
  check('a file that vanishes (the process is dying) keeps the last reading rather than inventing one', states.length, before)
  check('and states() still answers with it', poller.states().map((s) => s.sessionId), [B])

  /*
   * Gotcha 92, the regression: the dying pty's own file is gone, and a
   * STRANGER — a terminal `claude`, a second Stoke — is running in the same
   * folder, started after this pty. Old enough for the fallback, the poller
   * used to hand the dying tab that stranger's session, and the ended row's
   * Resume then named an id with no transcript.
   */
  ptys.set('p1', { ...(ptys.get('p1') as RegistryTarget), startedAt: NOW - REGISTRY_FALLBACK_AFTER_MS - 10_000 })
  reg.put(777, { sessionId: C, cwd: '/w', startedAt: NOW - 3000, status: 'busy' })
  const rebindsBefore = rebinds.length
  const listsBefore = reg.lists
  await poller.pass(NOW)
  check('gotcha 92: a pid-matched pty whose file vanished keeps its id beside a stranger in the same folder', rebinds.length, rebindsBefore)
  check('and its reading is still its own', poller.states().map((s) => s.sessionId), [B])
  check('and it does not even list the directory looking for one', reg.lists, listsBefore)
  reg.files.delete(join(DIR, '777.json'))

  ptys.delete('p1')
  await poller.pass(NOW)
  check('a pty that has gone is forgotten', poller.states(), [])

  // The fallback: a pty whose pid is not claude's (Windows .cmd -> cmd.exe).
  ptys.set('p2', { ptyId: 'p2', pid: 200, sessionId: C, cwd: '/w', startedAt: NOW - REGISTRY_FALLBACK_AFTER_MS - 1 })
  reg.put(4242, { sessionId: C, version: '2.1.279', status: 'waiting', waitingFor: 'permission' })
  await poller.pass(NOW)
  check('an old pty with no file under its pid is found by the id it holds', states[states.length - 1]?.sessionId, C)
  check('waiting is busy, and says what for', [states[states.length - 1]?.busy, states[states.length - 1]?.waitingFor], [true, 'permission'])
  check('that took one directory listing', reg.lists, 1)

  // Reentrancy (gotcha 20): a second pass while one is awaiting does nothing.
  const slow = fakeRegistry(DIR)
  let release: () => void = () => {}
  const gate = new Promise<void>((r) => {
    release = r
  })
  slow.put(300, { sessionId: A, status: 'idle' })
  const seen: LiveSessionState[] = []
  const racing = new RegistryPoller(
    () => DIR,
    {
      readFile: async (p) => {
        await gate
        return slow.fs.readFile(p)
      },
      readdir: slow.fs.readdir
    },
    () => [{ ptyId: 'p3', pid: 300, sessionId: A, cwd: '/w', startedAt: NOW }],
    { rebind: () => {}, state: (st) => seen.push(st) }
  )
  const first = racing.pass(NOW)
  const second = racing.pass(NOW)
  release()
  await Promise.all([first, second])
  check('two overlapping passes read and report once, not twice', [slow.reads.length, seen.length], [1, 1])

  /*
   * Gotcha 74's other half: a fake clock with a real directory is the
   * dangerous combination. Every path this suite's pollers touched is inside
   * the directory they were handed — none is the real ~/.claude/sessions.
   */
  const touched = [...reg.reads, ...slow.reads]
  check(
    'every path the poller touched is inside the directory it was given',
    touched.every((p) => p === DIR || p.startsWith(DIR + sep)),
    true
  )
}

await scenario()

/*
 * What a tab's activity indicator shows (src/shared/activityView.ts, gotcha
 * 104): the hooks and this registry, decided in one pure function. The
 * full table, because every row is a state a real session reaches — measured
 * against 2.1.278 — and the old hook-only reading got four of them wrong: a
 * turn ending while a workflow runs read "Finished" (and notified), a
 * permission prompt vanished once the tab was looked at, an answered one left
 * no dot for the rest of the turn, and a pty that died mid-turn pulsed forever.
 */
function activityTable(): void {
  console.log('\nactivity view: the registry beside the hooks')
  const T0 = 1_800_000_000_000
  type Hook = NonNullable<ActivityInput['hook']>
  const working: Hook = { state: 'working', at: T0, message: null }
  const done: Hook = { state: 'done', at: T0, message: 'pong', background: [] }
  // The captured Stop in verify-statusline.mts, as parseHookEvent reads it.
  const workflow: Hook = {
    state: 'done',
    at: T0,
    message: 'The investigation workflow is running',
    background: [
      { type: 'shell', name: 'Run the full check chain' },
      { type: 'workflow', name: 'stoke-indicators-and-freeze' }
    ]
  }
  const subagent: Hook = { state: 'done', at: T0, message: 'Started it', background: [{ type: 'subagent', name: 'Explore the registry' }] }
  const devServer: Hook = { state: 'done', at: T0, message: 'Server is up', background: [{ type: 'shell', name: 'npm run dev' }] }
  const teammate: Hook = { state: 'done', at: T0, message: 'Asked them', background: [{ type: 'teammate', name: 'reviewer' }] }
  const attention: Hook = { state: 'attention', at: T0, message: 'Claude needs your permission to use Bash' }
  /** A registry reading; by default stated BEFORE the hook was read. */
  const reg = (
    status: LiveSessionState['status'],
    waitingFor: string | null = null,
    statusUpdatedAt: number | null = T0 - 500
  ): ActivityInput['live'] => ({ status, waitingFor, statusUpdatedAt })
  const after = T0 + 500
  const at = (hook: Hook | null, live: ActivityInput['live'], running = true): ActivityInput => ({ hook, live, running })
  const show = (input: ActivityInput): [string | null, string] => {
    const v = activityView(input)
    return [v.dot, v.label]
  }
  const dot = (input: ActivityInput): string | null => activityView(input).dot
  /** The tab in front, window focused: App's `seenActive`, which is `afterLooking`. */
  const looked = (input: ActivityInput): ActivityInput =>
    input.hook ? { ...input, hook: afterLooking(input.hook, activityView(input)) } : input

  // A turn ended while a workflow it started runs on: the registry stays busy.
  check(
    'busy after a Stop listing a running workflow keeps pulsing, and names it (agents first)',
    show(at(workflow, reg('busy'))),
    ['background', 'Running in the background: workflow “stoke-indicators-and-freeze”, shell “Run the full check chain”']
  )
  check('and that Stop does NOT raise "Finished"', activityView(at(workflow, reg('busy'))).notify, false)
  check('and looking at the tab does not clear it — it is still running', dot(looked(at(workflow, reg('busy')))), 'background')
  check('a background subagent the same', [dot(at(subagent, reg('busy'))), activityView(at(subagent, reg('busy'))).notify], ['background', false])
  check(
    'even a busy stated after the Stop stays "background" while the Stop named agent work (a waiting -> busy inside the workflow)',
    dot(at(workflow, reg('busy', null, after))),
    'background'
  )
  check('the workflow ends and the registry goes idle: done, and looking clears it', [dot(at(workflow, reg('idle', null, after))), dot(looked(at(workflow, reg('idle', null, after))))], ['done', null])
  check('the notification turn (a task-notification prompt) is plain working', show(at(working, reg('busy'))), ['working', 'Claude is working…'])

  // What notifies.
  check('a Stop with nothing in flight notifies', activityView(at(done, reg('idle'))).notify, true)
  check('a Stop whose only background is a shell notifies — a dev server can run forever', activityView(at(devServer, reg('shell'))).notify, true)
  check('a teammate does not hold back "Finished" (it may idle for an hour)', activityView(at(teammate, reg('busy'))).notify, true)
  check('the same Stop with no registry reading still does not notify', activityView(at(workflow, null)).notify, false)
  check('nothing but a Stop ever notifies', [activityView(at(working, reg('busy'))).notify, activityView(at(attention, null)).notify, activityView(at(null, null)).notify], [false, false, false])
  check('stopNotifies is the rule itself', [stopNotifies([]), stopNotifies(undefined), stopNotifies([{ type: 'workflow', name: null }]), stopNotifies([{ type: 'subagent', name: null }]), stopNotifies([{ type: 'shell', name: null }])], [true, true, false, false, true])

  // Busy with a finished Stop and no agent work: the two polls race.
  check('busy stated before the Stop was read is the registry lagging: done', show(at(done, reg('busy'))), ['done', 'Finished — your move'])
  check('busy stated AFTER the Stop was read is a new busy period (a prompt not yet read, /compact): working', dot(at(done, reg('busy', null, after))), 'working')
  check('busy with no statusUpdatedAt trusts the Stop', dot(at(done, reg('busy', null, null))), 'done')
  check('busy with nothing heard yet is working', dot(at(null, reg('busy'))), 'working')

  /*
   * Looking at a finished tab while the registry still says busy. A Stop is
   * usually read before the idle push, so this is the order almost every turn
   * ends in, on the tab in front. `seenActive` used to DELETE the entry, which
   * left the stale busy nothing to be weighed against: the tab read "Claude is
   * working…" and pulsed for up to a second.
   */
  const seenDone: Hook = { ...done, seen: true }
  check(
    'looking at a done tab while the registry still says busy (stamped before the Stop) is NOT working',
    show(looked(at(done, reg('busy')))),
    [null, '']
  )
  check('looking marks the Stop seen rather than dropping it', afterLooking(done, activityView(at(done, reg('busy')))), seenDone)
  check('looking again changes nothing — the same object, so seenActive renders nothing', afterLooking(seenDone, activityView(at(seenDone, reg('busy')))) === seenDone, true)
  check(
    'a seen Stop: the registry catching up (idle) shows nothing, a new turn (busy stated after it) is working',
    [dot(at(seenDone, reg('idle', null, after))), dot(at(seenDone, reg('busy', null, after)))],
    [null, 'working']
  )
  check('a seen Stop naming a running workflow still reads background while busy', dot(at({ ...workflow, seen: true }, reg('busy'))), 'background')
  check('a seen Stop on an exited tab, or with no reading, is nothing', [dot(at(seenDone, reg('busy'), false)), dot(at(seenDone, null))], [null, null])
  check(
    'a seen attention draws no hook-only dot; a registry waiting still shows',
    [dot(at({ ...attention, seen: true }, null)), dot(at({ ...attention, seen: true }, reg('waiting', 'permission prompt')))],
    [null, 'waiting']
  )
  check('looking drops a working entry, as before (a shell-only reading shows nothing either way)', afterLooking(working, activityView(at(working, reg('shell')))), null)
  check('looking leaves what is still running alone', afterLooking(workflow, activityView(at(workflow, reg('busy')))) === workflow, true)

  // Waiting: level-triggered, from the registry, never cleared by looking.
  check(
    'waiting for a permission prompt shows waiting, with the hook\'s message as detail',
    (() => {
      const v = activityView(at(attention, reg('waiting', 'permission prompt')))
      return [v.dot, v.label, v.detail]
    })(),
    ['waiting', 'Waiting for you — permission', 'Claude needs your permission to use Bash']
  )
  check('…and still shows it on the FRONT tab once looked at', show(looked(at(attention, reg('waiting', 'permission prompt')))), ['waiting', 'Waiting for you — permission'])
  check('waiting for input (AskUserQuestion, MCP elicitation) on the FRONT tab', show(looked(at(working, reg('waiting', 'input needed')))), ['waiting', 'Waiting for you — question'])
  check('a waiting with no hook heard at all still shows', dot(at(null, reg('waiting', 'permission prompt'))), 'waiting')
  check(
    'a LATER wait in the same turn does not borrow an answered prompt\'s message (the attention hook outlives its dialog)',
    (() => {
      const v = activityView(at({ ...attention, seen: true }, reg('waiting', 'input needed', T0 + 10_000)))
      return [v.dot, v.label, v.detail]
    })(),
    ['waiting', 'Waiting for you — question', null]
  )
  check(
    '…while the prompt\'s own message, read just after its wait was stated, is kept — seen or not',
    [activityView(at({ ...attention, seen: true }, reg('waiting', 'permission prompt'))).detail, activityView(at(attention, reg('waiting', 'permission prompt', null))).detail],
    ['Claude needs your permission to use Bash', 'Claude needs your permission to use Bash']
  )
  check('the other reasons the CLI states', [waitingLabel('sandbox request'), waitingLabel('worker request'), waitingLabel('goal proposal'), waitingLabel(null), waitingLabel('something new')], ['Waiting for you — sandbox access', 'Waiting for you — worker request', 'Waiting for you — goal proposal', 'Waiting for you', 'Waiting for you — something new'])
  check('a dialog the user opened is not an alert: mid-turn it stays working', dot(at(working, reg('waiting', 'dialog open'))), 'working')
  check('…idle it shows nothing new', [dot(at(null, reg('waiting', 'dialog open'))), dot(at(done, reg('waiting', 'dialog open')))], [null, 'done'])
  check('waitingAlerts: only dialog open is exempt', [waitingAlerts('dialog open'), waitingAlerts('permission prompt'), waitingAlerts(null)], [false, true, true])
  check(
    'answered (waiting -> busy, no hook): back to working, whether the tab was looked at while waiting or not',
    [
      dot(at(attention, reg('busy'))),
      dot({ ...looked(at(attention, reg('waiting', 'permission prompt'))), live: reg('busy') })
    ],
    ['working', 'working']
  )
  check('dismissed with Esc (waiting -> idle, no Stop): the stale attention shows nothing', dot(at(attention, reg('idle'))), null)

  // Shell: a background shell can run forever, so it never pulses.
  check('a shell never pulses: a prompt the registry has not caught up with shows nothing', dot(at(working, reg('shell'))), null)
  check('…and a turn that ended since (Esc, with a dev server up) is done', show(at(working, reg('shell', null, after))), ['done', 'Finished — your move · a shell is still running'])
  check('a Stop with a dev server running says so', show(at(devServer, reg('shell'))), ['done', 'Finished — your move · shell “npm run dev” still running'])
  check('a shell with nothing heard is nothing', dot(at(null, reg('shell'))), null)

  // Idle.
  check('idle stated before the prompt was read is the registry lagging: still working', dot(at(working, reg('idle'))), 'working')
  check('idle stated after it: the turn ended with no Stop (Esc, an API error)', dot(at(working, reg('idle', null, after))), 'done')
  check('idle after a Stop is done; nothing heard is nothing', [dot(at(done, reg('idle'))), dot(at(null, reg('idle')))], ['done', null])

  // A tab whose process is not running never pulses.
  check(
    'an exited tab never pulses: a turn it died in, a registry reading left busy or waiting, no reading',
    [dot(at(working, reg('busy'), false)), dot(at(attention, reg('waiting', 'permission prompt'), false)), dot(at(null, reg('busy'), false)), dot(at(working, null, false))],
    [null, null, null, null]
  )
  check(
    '…and a turn that finished before it exited reads done, still, even with its workflow listed',
    [dot(at(done, reg('busy'), false)), dot(at(workflow, reg('busy'), false))],
    ['done', 'done']
  )

  // No registry reading: the hooks alone, exactly as before.
  check('no reading, prompt: working', show(at(working, null)), ['working', 'Claude is working…'])
  check('no reading, Stop: done', show(at(done, null)), ['done', 'Finished — your move'])
  check('no reading, Stop with a running workflow: still done, as before (nothing could say when it ends)', dot(at(workflow, null)), 'done')
  check('no reading, permission prompt: the warning dot, labelled with the CLI\'s message', show(at(attention, null)), ['waiting', 'Claude needs your permission to use Bash'])
  check('no reading, attention with no message', show(at({ state: 'attention', at: T0, message: null }, null)), ['waiting', 'Needs your attention'])
  check('no reading, nothing heard: nothing', show(at(null, null)), [null, ''])
  check(
    'no reading, looking clears done and attention and keeps working (the old seenActive rule)',
    [dot(looked(at(done, null))), dot(looked(at(attention, null))), dot(looked(at(working, null)))],
    [null, null, 'working']
  )

  // Labels.
  check(
    'the background label: agents first, two named, the rest counted',
    backgroundLabel([
      { type: 'shell', name: 'npm run dev' },
      { type: 'monitor', name: null },
      { type: 'subagent', name: 'Explore' },
      { type: 'workflow', name: 'nightly' }
    ]),
    'Running in the background: subagent “Explore”, workflow “nightly”, and 2 more'
  )
  check('agentWork is workflows and subagents only', agentWork([{ type: 'teammate', name: null }, { type: 'workflow', name: 'w' }, { type: 'cloud session', name: null }]), [{ type: 'workflow', name: 'w' }])

  // Gotcha 82's typed-draft guard.
  console.log('\nthe typed-draft guard (gotcha 82) and who submitted what')
  check('a typed prompt clears the draft guard', promptClearsDraft('user'), true)
  check('a task-notification prompt does NOT clear it — nobody typed anything', promptClearsDraft('task-notification'), false)
  check('nor does any other machine-injected prompt', promptClearsDraft('system'), false)
  check('an event with no origin keeps the old behaviour', promptClearsDraft(null), true)
  const s = (status: LiveSessionState['status']): Pick<LiveSessionState, 'status'> => ({ status })
  check(
    'the registry clears it only when a session goes busy from idle (or from no reading)',
    [registryClearsDraft(s('idle'), s('busy')), registryClearsDraft(undefined, s('busy')), registryClearsDraft(s(null), s('busy'))],
    [true, true, true]
  )
  check(
    '…not on busy -> busy (a workflow), shell -> busy, waiting -> busy (a permission answered), busy -> shell or idle -> waiting',
    [
      registryClearsDraft(s('busy'), s('busy')),
      registryClearsDraft(s('shell'), s('busy')),
      registryClearsDraft(s('waiting'), s('busy')),
      registryClearsDraft(s('busy'), s('shell')),
      registryClearsDraft(s('idle'), s('waiting'))
    ],
    [false, false, false, false, false]
  )

  /*
   * The same guard end to end, the way App drives it: one pty's flag through
   * `draftOnRegistry` on every registry push and `draftOnPrompt` on every
   * prompt hook, on one clock. The idle -> busy edge clears provisionally,
   * because the CLI starts turns of its own on an idle session.
   */
  console.log('\nthe typed-draft guard across registry edges and prompt hooks')
  const W = DRAFT_EDGE_WINDOW_MS
  const pty = (typed: boolean) => {
    let track: DraftTrack = NO_DRAFT_TRACK
    let flag = typed
    let last: LiveSessionState['status'] | undefined
    return {
      registry(status: LiveSessionState['status'], now: number): boolean {
        const step = draftOnRegistry(track, last === undefined ? undefined : { status: last }, { status }, flag, now)
        track = step.track
        flag = step.typed
        last = status
        return flag
      },
      prompt(origin: PromptOrigin | null, now: number): boolean {
        const step = draftOnPrompt(track, origin, flag, now)
        track = step.track
        flag = step.typed
        return flag
      },
      type(): boolean {
        flag = true
        return flag
      }
    }
  }
  {
    const p = pty(true)
    p.registry('idle', 0)
    const edge = p.registry('busy', 1000)
    const notified = p.prompt('task-notification', 1800)
    check('idle -> busy clears provisionally; its task-notification prompt, read after, puts the draft guard back', [edge, notified], [false, true])
    p.registry('idle', 30_000)
    check('the typed draft is still guarded once that turn ends', p.registry('idle', 31_000), true)
    p.registry('busy', 40_000)
    const typed = p.prompt('user', 40_600)
    check('then a typed prompt clears it, and a machine prompt read just after cannot bring it back', [typed, p.prompt('task-notification', 41_000)], [false, false])
  }
  {
    const p = pty(true)
    p.registry('idle', 0)
    const first = p.prompt('task-notification', 1000)
    check('a task-notification read BEFORE its edge: the edge clears nothing', [first, p.registry('busy', 1700)], [true, true])
    p.registry('idle', 20_000)
    check('that claim is spent on its own edge: a later slash command (no hook) clears', p.registry('busy', 21_000), false)
  }
  {
    const p = pty(true)
    p.registry('idle', 0)
    const slash = p.registry('busy', 1000)
    check('an edge no prompt claims inside the window (a slash command, which fires none) clears', [slash, p.prompt('task-notification', 1000 + W + 1)], [false, false])
    const q = pty(true)
    q.registry('idle', 0)
    q.prompt('system', 1000)
    check('a machine prompt read too long before an edge is not its turn: the edge clears', q.registry('busy', 1000 + W + 1), false)
  }
  {
    const p = pty(false)
    p.registry('idle', 0)
    p.registry('busy', 1000)
    const typedAfter = p.type()
    check('keys typed after the edge stay set through the restore', [typedAfter, p.prompt('system', 1500)], [true, true])
    const q = pty(false)
    q.registry('idle', 0)
    q.registry('busy', 1000)
    check('a restore of nothing stays nothing', q.prompt('task-notification', 1500), false)
    const r = pty(true)
    r.registry('idle', 0)
    r.registry('busy', 1000)
    check('a wake-up or a teammate (origin system) restores like a task notification', r.prompt('system', 2200), true)
    const o = pty(true)
    o.registry('idle', 0)
    o.registry('busy', 1000)
    check('an event with no origin (an older build) is typed: the clear stands', o.prompt(null, 1400), false)
  }
  {
    // A permission prompt mid-turn, answered with keys: they go to the dialog.
    const p = pty(true)
    p.registry('idle', 0)
    p.registry('busy', 1000)
    p.prompt('user', 1300)
    p.registry('waiting', 5000)
    p.type()
    check('keys that answer a dialog do not count as a draft: waiting -> busy puts back what it went in with', p.registry('busy', 6000), false)
    // A draft typed while Claude worked, then a dialog, answered.
    const q = pty(false)
    q.registry('idle', 0)
    q.registry('busy', 1000)
    q.type()
    q.registry('waiting', 5000)
    q.type()
    check('…and a draft typed before the dialog survives it', q.registry('busy', 6000), true)
    const r = pty(false)
    r.registry('busy', 0)
    r.registry('waiting', 1000)
    r.type()
    check('dismissed with Esc (waiting -> idle): the same', r.registry('idle', 2000), false)
    const s2 = pty(false)
    s2.registry('busy', 0)
    s2.registry('waiting', 1000)
    s2.type()
    s2.registry('waiting', 1500)
    check('a second push inside the same waiting does not re-snapshot the answer keys', s2.registry('busy', 2000), false)
  }
}

activityTable()

// The tally is the last statement in the file, and must stay that way: anything
// after it is unfalsifiable (gotcha 50).
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
