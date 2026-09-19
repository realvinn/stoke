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

// The tally is the last statement in the file, and must stay that way: anything
// after it is unfalsifiable (gotcha 50).
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
