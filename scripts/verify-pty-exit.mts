import assert from 'node:assert/strict'
import { setImmediate as turn } from 'node:timers/promises'
import { execFileSync, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn as spawnPty, type IPty } from '@lydell/node-pty'
import { PtyExitTracker, QUIT_DEADLINE_MS, QUIT_TERM_GRACE_MS, WIN_QUIT_DEADLINE_MS, holdQuitForPtys, lastResortKill, settleQuit, systemQuitSettle, type QuitChild, type QuitSettleDeps, type QuitSettleReport } from '../src/main/ptyExitTracker.ts'
import { FORCE_KILL_GRACE_MS, killProcessTree, type TreeKillOutcome } from '../src/main/processTree.ts'
import { releaseExitedPtyTransports } from '../src/main/ptyTransportCleanup.ts'

let checks = 0
function check(name: string, actual: unknown, expected: unknown): void {
  assert.deepEqual(actual, expected, name)
  console.log(`  PASS ${name}`); checks++
}
function fixture() {
  const listeners: Array<() => void> = []
  const child = { onExit: (callback: () => void) => { listeners.push(callback); return { dispose() {} } } } as unknown as IPty
  return { child, listeners, exit: () => listeners.forEach(callback => callback()) }
}

console.log('\nPTY quit drain: exact native ownership')
const tracker = new PtyExitTracker(), first = fixture(), second = fixture()
tracker.track(first.child); tracker.track(first.child); tracker.track(second.child)
check('the same child has only one exit registration', first.listeners.length, 1)
check('two exact objects stay owned independently', tracker.count, 2)
const deadline = await tracker.wait(15)
check('a deadline reports pending exits', deadline, 2)
check('a deadline keeps native ownership', tracker.count, 2)
first.exit()
check('delivery inside the native callback does not release its object', tracker.count, 2)
await turn()
check('one loop turn still owns the native close', tracker.count, 2)
await turn()
check('the first completed callback releases only its own object', tracker.count, 1)
let drained = false
const waiting = tracker.wait().then(count => { drained = true; return count })
await turn()
check('a closed tab cannot imply the remaining native exit', drained, false)
second.exit()
check('the final callback still needs its close turns', drained, false)
check('the wait finishes only after actual delivery and closing', await waiting, 0)
tracker.track(first.child)
check('an exited object cannot be registered again', tracker.count, 0)
check('an empty drain returns immediately', await tracker.wait(), 0)

console.log('\nPTY quit drain: real native children')
const root = await mkdtemp(join(tmpdir(), 'stoke-pty-exit-'))
const native = new PtyExitTracker(), children: IPty[] = []
try {
  const launch = (code: string) => {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
    env.ELECTRON_RUN_AS_NODE = '1'
    const child = spawnPty(process.execPath, ['-e', code], { cwd: root, env, cols: 80, rows: 24 })
    children.push(child); native.track(child)
    child.onExit(() => releaseExitedPtyTransports(child))
    return child
  }
  launch('setTimeout(() => process.exit(0), 100)')
  check('a natural native exit drains', await native.wait(), 0)
  const killed = launch('setInterval(() => {}, 1000)')
  killed.kill()
  check('requesting termination still owns the native callback', native.count, 1)
  check('a killed native child drains after actual exit', await native.wait(), 0)
} finally {
  if (native.count) { for (const child of children) { try { child.kill() } catch {} }; await native.wait() }
  await rm(root, { recursive: true, force: true })
}

/* ------------------------------------------- quit: the settle, with fakes */

console.log('\nQuit: a child that will not exit is ended, one that exits is left alone (settleQuit, gotcha 163)')
{
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
  type FakeChild = QuitChild & { end: () => void }
  const fakeChild = (pid: number): FakeChild => {
    let ended = false
    let resolveExit!: () => void
    let resolveDelivered!: () => void
    const exit = new Promise<void>((r) => { resolveExit = r })
    const delivered = new Promise<void>((r) => { resolveDelivered = r })
    return {
      pid,
      exited: () => ended,
      exit,
      delivered,
      end: () => {
        if (ended) return
        ended = true
        resolveExit()
        setImmediate(resolveDelivered)
      }
    }
  }
  const GRACE = 120, DEADLINE = 600
  const fakeDeps = (onKill: (pid: number, exited: () => boolean) => Promise<TreeKillOutcome>): QuitSettleDeps & { kills: number[]; lastResorts: number[] } => {
    const kills: number[] = [], lastResorts: number[] = []
    return {
      graceMs: GRACE, deadlineMs: DEADLINE, now: Date.now, kills, lastResorts,
      treeKill: (pid, exited) => { kills.push(pid); return onKill(pid, exited) },
      lastResort: (pid) => { lastResorts.push(pid) }
    }
  }

  // Everything exits by itself (the SIGHUP was enough): nothing more is sent, and nothing waits for the grace.
  {
    const a = fakeChild(4001), b = fakeChild(4002)
    const deps = fakeDeps(async () => 'killed')
    const t0 = Date.now()
    const settling = settleQuit([a, b], deps)
    setTimeout(a.end, 10)
    setTimeout(b.end, 30)
    const r = await settling
    check('children that exit by themselves are never escalated', [r.escalated, deps.kills, r.remaining], [[], [], 0])
    check('…and the settle ends with the last exit, not after the grace', Date.now() - t0 < GRACE, true)
  }

  // One child traps the SIGHUP: after the grace, ITS tree alone is killed.
  {
    const gentle = fakeChild(4011), stubborn = fakeChild(4012)
    let killedAt = 0
    const t0 = Date.now()
    const deps = fakeDeps(async (pid) => {
      killedAt = Date.now() - t0
      if (pid === stubborn.pid) setTimeout(stubborn.end, 20)
      return 'killed'
    })
    const settling = settleQuit([gentle, stubborn], deps)
    setTimeout(gentle.end, 5)
    const r = await settling
    check('a child still running after the grace has its tree killed, and only it', [r.escalated, deps.kills, r.outcomes, r.remaining], [[4012], [4012], ['killed'], 0])
    check('…not before the grace has passed', killedAt >= GRACE - 5, true)
    check('…and a tree the kill ended gets no last-resort SIGKILL', deps.lastResorts, [])
  }

  // A tree kill the deadline cuts short (a slow ps, a process stuck in the kernel): the settle still ends by
  // the deadline, and the leader gets the SIGKILL the cut-short kill may never have sent.
  {
    const stuck = fakeChild(4031), gone = fakeChild(4032)
    const deps = fakeDeps((pid) => {
      if (pid === gone.pid) setTimeout(gone.end, 10)
      return new Promise<TreeKillOutcome>(() => {})
    })
    const t0 = Date.now()
    const r = await settleQuit([stuck, gone], deps)
    const took = Date.now() - t0
    check('a kill that never returns does not hold the quit past the deadline', [took >= DEADLINE - 10, took < DEADLINE + 150], [true, true])
    check('…the leader still running then gets one SIGKILL of last resort, the one that exited none', deps.lastResorts, [4031])
    check('…and what is still there is reported, never invented', [r.escalated, r.remaining], [[4031, 4032], 1])
  }

  // The last resort itself keeps killablePid's guards: never 0, never Stoke, never an exited child.
  {
    const sent: Array<[number, string]> = []
    const last = lastResortKill((pid, sig) => { sent.push([pid, sig]) }, { pid: 77, ppid: 76 })
    for (const pid of [0, 1, -1, 1.5, 77, 76]) last(pid, () => false)
    last(5000, () => true)
    check('the last resort refuses pid 0, 1, a negative or fractional pid, Stoke and its parent, and an exited child', sent, [])
    last(5001, () => false)
    check('…and sends a running child\'s pid exactly one SIGKILL, never its group', sent, [[5001, 'SIGKILL']])
  }

  // The shipped dependencies (`systemQuitSettle`): the bounds a quit really runs under. The fakes above
  // use their own, so without this a deadline of 30 s, or a no-op last resort, kept every check green
  // (CLAUDE.md gotcha 175).
  {
    const mac = systemQuitSettle('darwin'), linux = systemQuitSettle('linux'), win = systemQuitSettle('win32')
    check(
      'the shipped settle: Force restart\'s grace, and the whole quit bounded at 3 s on macOS and Linux, 5 s on Windows',
      [mac.graceMs, mac.deadlineMs, linux.deadlineMs, win.graceMs, win.deadlineMs, QUIT_DEADLINE_MS, WIN_QUIT_DEADLINE_MS],
      [FORCE_KILL_GRACE_MS, QUIT_DEADLINE_MS, QUIT_DEADLINE_MS, FORCE_KILL_GRACE_MS, WIN_QUIT_DEADLINE_MS, 3000, 5000]
    )
    check('…leaving the tree kill room for its SIGTERM-to-SIGKILL step before the deadline', FORCE_KILL_GRACE_MS + QUIT_TERM_GRACE_MS < QUIT_DEADLINE_MS, true)
  }
  if (process.platform === 'win32') {
    console.log('  SKIP the shipped last resort on a real process: Windows has no SIGTERM to trap')
  } else {
    // Our own children, started here: one that traps SIGTERM and SIGHUP, and one whose exit "already ran".
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v
    env.ELECTRON_RUN_AS_NODE = '1'
    const stubborn = () =>
      spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {}); setTimeout(() => process.exit(0), 8000)"], { stdio: 'ignore', env })
    const exitOf = (c: ReturnType<typeof stubborn>) => new Promise<{ code: number | null; signal: string | null }>((r) => c.on('exit', (code, signal) => r({ code, signal })))
    const running = stubborn(), exited = stubborn()
    const runningExit = exitOf(running), exitedExit = exitOf(exited)
    await sleep(150)
    // Never hand the real kill a made-up pid (0 is this process's own group): a child that did not start fails here.
    if (!running.pid || !exited.pid || running.pid <= 1 || exited.pid <= 1) throw new Error('the last-resort test children did not start')
    const lastResort = systemQuitSettle().lastResort
    lastResort(running.pid, () => false)
    lastResort(exited.pid, () => true)
    const r1 = await Promise.race([runningExit, sleep(3000).then(() => null)])
    const r2 = await Promise.race([exitedExit, sleep(300).then(() => null)])
    // Both are ours: end whatever is left before judging (a failed check throws).
    for (const c of [running, exited]) if (c.exitCode === null && c.signalCode === null) { try { c.kill('SIGKILL') } catch { /* gone */ } }
    await Promise.race([Promise.all([runningExit, exitedExit]), sleep(2000)])
    check('the shipped last resort SIGKILLs a running child that traps SIGTERM', r1?.signal ?? 'still running', 'SIGKILL')
    check('…and signals nothing for a child whose exit has run (its pid may be another program\'s)', r2, null)
  }

  // No children: nothing at all.
  {
    const deps = fakeDeps(async () => 'killed')
    const r = await settleQuit([], deps)
    check('a quit with no pty children sends nothing and waits for nothing', [r.escalated, deps.kills, r.remaining], [[], [], 0])
  }

  // Through the real killProcessTree with Windows fakes: taskkill /T /F for the stubborn tree only.
  {
    const taskkilled: number[] = []
    const signalled: number[] = []
    const winTreeKill = (pid: number, exited: () => boolean): Promise<TreeKillOutcome> =>
      killProcessTree(pid, {
        platform: 'win32',
        signal: (p) => { signalled.push(p) },
        taskkill: async (p) => { taskkilled.push(p) },
        fallback: () => {},
        sleep,
        exited,
        self: { pid: 77, ppid: 76 },
        groups: async () => null,
        graceMs: 50
      })
    const ok = fakeChild(5001), stubborn = fakeChild(5002), zero = fakeChild(0), self = fakeChild(77)
    const deps: QuitSettleDeps = { graceMs: GRACE, deadlineMs: DEADLINE, now: Date.now, lastResort: () => {}, treeKill: async (pid, exited) => {
      const out = await winTreeKill(pid, exited)
      if (pid === stubborn.pid) stubborn.end()
      return out
    } }
    setTimeout(ok.end, 5)
    const r = await settleQuit([ok, stubborn, zero, self], deps)
    check('Windows: taskkill /T /F reaches the stubborn tree, never the child that exited', taskkilled, [5002])
    check('Windows: a pid of 0, or Stoke\'s own, is never handed to taskkill (killablePid)', [r.outcomes.slice().sort(), signalled], [['gone', 'gone', 'taskkill'], []])
  }

  // The tracker: one settle per process, whoever asks, over the children it owns.
  {
    const t = new PtyExitTracker(), one = fixture(), two = fixture()
    ;(one.child as unknown as { pid: number }).pid = 6001
    ;(two.child as unknown as { pid: number }).pid = 6002
    t.track(one.child); t.track(two.child)
    const kills: number[] = []
    const deps: QuitSettleDeps = { graceMs: GRACE, deadlineMs: DEADLINE, now: Date.now, lastResort: () => {}, treeKill: async (pid) => { kills.push(pid); if (pid === 6002) setTimeout(two.exit, 5); return 'killed' } }
    setTimeout(one.exit, 5)
    const first = t.settle(deps), second = t.settle(deps)
    check('the before-quit drain and the will-quit hold share ONE settle', first === second, true)
    const r = await first
    check('the tracker escalates only the child whose exit never came', [r.escalated, kills, r.remaining], [[6002], [6002], 0])
    check('…and marks itself settled, so a second quit goes straight through', [t.settled, t.count], [true, 0])
  }

  // holdQuitForPtys against a fake app: held while children remain, quit again once settled.
  {
    const listeners: Array<(e: { preventDefault: () => void }) => void> = []
    let quits = 0
    const fakeApp = { on: (_e: 'will-quit', fn: (e: { preventDefault: () => void }) => void) => { listeners.push(fn) }, quit: () => { quits++ } }
    const t = new PtyExitTracker(), one = fixture()
    ;(one.child as unknown as { pid: number }).pid = 6101
    t.track(one.child)
    const reports: QuitSettleReport[] = []
    holdQuitForPtys(fakeApp, t, { graceMs: GRACE, deadlineMs: DEADLINE, now: Date.now, lastResort: () => {}, treeKill: async () => 'killed' }, (r) => reports.push(r))
    let prevented = 0
    const willQuit = () => { for (const fn of listeners) fn({ preventDefault: () => { prevented++ } }) }
    willQuit()
    check('a will-quit with a pty child still owned is held', [prevented, quits], [1, 0])
    one.exit()
    for (let i = 0; i < 40 && !quits; i++) await sleep(5)
    check('…and quits again as soon as the child has gone, with nothing escalated', [quits, reports.map((r) => r.escalated)], [1, [[]]])
    willQuit()
    check('the second will-quit goes straight through', [prevented, quits], [1, 1])
    const idle = new PtyExitTracker()
    const idleListeners: Array<(e: { preventDefault: () => void }) => void> = []
    holdQuitForPtys({ on: (_e, fn) => { idleListeners.push(fn) }, quit: () => { quits++ } }, idle)
    let idlePrevented = 0
    for (const fn of idleListeners) fn({ preventDefault: () => { idlePrevented++ } })
    check('a quit with no pty child is never held', idlePrevented, 0)
  }
}

/* ------------------------------------------------------- quit: the wire */

console.log('\nQuit: the wire in index.ts (gotcha 31)')
{
  const index = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const beforeQuit = index.indexOf("app.on('before-quit'")
  const hold = index.indexOf('holdQuitForPtys(app, ownedPtyExits')
  check('index.ts holds the quit for its pty children', hold > 0, true)
  check('…registered after before-quit, which it leaves alone', hold > beforeQuit && beforeQuit > 0, true)
  const quitBody = index.slice(beforeQuit, hold)
  check('before-quit still ends every session itself (the gentle SIGHUP stays first)', /ptys\?\.shutdown\(\)/.test(quitBody), true)
  check('the Windows drain settles (taskkill after the grace) rather than only waiting', /ownedPtyExits\.settle\(\)/.test(quitBody) && !/ownedPtyExits\.wait\(\)/.test(quitBody), true)
  /*
   * The hold quits again once its children are gone, and Electron runs
   * before-quit again for that quit (measured in (a) below). A drain decided
   * afresh there — an account check that started during the hold — would
   * prevent that quit, and the handler returns on `appQuitting` without ever
   * quitting again: a windowless Stoke for good.
   */
  check(
    'before-quit decides whether to drain once, at the FIRST quit, so the hold’s second quit is never held again',
    [
      /const drain = \(quitDrains \?\?= process\.platform === 'win32' \|\| accountIdentities\.pendingCount > 0\)\s+if \(drain && !quitReady\) event\.preventDefault\(\)/.test(quitBody),
      (index.match(/quitDrains\b/g) ?? []).length
    ],
    [true, 2]
  )
  const pty = readFileSync(new URL('../src/main/pty.ts', import.meta.url), 'utf8')
  check('every local pty child is owned by the tracker the quit settles', /ownedPtyExits\.track\(proc\)/.test(pty) && /started: child => ownedPtyExits\.track\(child\)/.test(pty), true)
}

/* ------------------------------- quit: real ptys under a real Electron */

console.log('\nQuit: real ptys under a real Electron (gotcha 163)')
if (process.platform === 'win32') {
  console.log('  SKIP on Windows: no signal can be trapped there, and taskkill is held by the fakes above')
} else {
  const electron = createRequire(import.meta.url)('electron') as unknown as string
  const quitRoot = await mkdtemp(join(tmpdir(), 'stoke-pty-quit-'))
  const PROC = join(quitRoot, 'proc')
  await mkdir(PROC, { recursive: true })
  /*
   * The pty child (`<kind>`) and a grandchild it starts in its own process
   * group. 'normal' cleans up and exits on SIGHUP at once, 'slow' 600 ms
   * later (Claude Code writing its transcript), 'trap' ignores SIGHUP and
   * SIGTERM and so does its grandchild: a hung or stubborn program and its MCP
   * server. Every one exits by itself after PTYQUIT_SELF_EXIT_MS, so a
   * regression cannot leave anything running for long. Built from lines, never
   * a template with backticks inside (CLAUDE.md's standing trap).
   */
  await writeFile(join(PROC, 'quit-child.cjs'), [
    "const { spawn } = require('node:child_process')",
    'const kind = process.argv[2]',
    "const role = process.argv[3] || 'child'",
    'setTimeout(() => process.exit(0), Number(process.env.PTYQUIT_SELF_EXIT_MS || 9000))',
    "const trap = () => { process.on('SIGHUP', () => {}); process.on('SIGTERM', () => {}) }",
    "if (role === 'grand') {",
    "  if (kind === 'trap') trap()",
    '} else {',
    "  const g = spawn(process.execPath, [__filename, kind, 'grand'], { stdio: 'ignore', env: process.env })",
    "  if (kind === 'trap') trap()",
    "  else process.on('SIGHUP', () => setTimeout(() => { try { g.kill('SIGKILL') } catch {} process.exit(129) }, kind === 'slow' ? 600 : 0))",
    "  process.stdout.write('READY child=' + process.pid + ' grand=' + g.pid + '\\n')",
    '}',
    'setInterval(() => {}, 1000)'
  ].join('\n'))
  const alivePid = (pid: number): boolean => {
    try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
  }
  /** Every process whose command line names this run's process folder (a READ: `ps`). */
  const marked = (): number[] =>
    execFileSync('ps', ['-ww', '-A', '-o', 'pid=,args='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
      .split('\n').filter((l) => l.includes(PROC)).map((l) => Number(l.trim().split(/\s+/)[0])).filter((p) => p > 0 && p !== process.pid)
  const reapMarked = async (): Promise<number[]> => {
    for (const p of marked()) { try { process.kill(p, 'SIGKILL') } catch { /* gone */ } }
    for (let i = 0; i < 40 && marked().length; i++) await new Promise((r) => setTimeout(r, 50))
    return marked()
  }
  type QuitRun = { quitToExitMs: number; code: number | null; signal: string | null; lines: string[]; settle: QuitSettleReport | null; pids: { child: number; grand: number }[]; aliveAfter: boolean[] }
  let runNo = 0
  const quitRun = async (kinds: string[], opts: { noHold?: boolean; selfExitMs?: number } = {}): Promise<QuitRun> => {
    const dir = join(quitRoot, `run-${++runNo}`)
    await mkdir(join(dir, 'tmp'), { recursive: true })
    const out = join(dir, 'log.txt')
    const env: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v
    Object.assign(env, {
      TMPDIR: join(dir, 'tmp'),
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      PTYQUIT_OUT: out,
      PTYQUIT_DIR: PROC,
      PTYQUIT_KINDS: kinds.join(','),
      PTYQUIT_SELF_EXIT_MS: String(opts.selfExitMs ?? 9000)
    })
    if (opts.noHold) env.PTYQUIT_NO_HOLD = '1'
    const harness = fileURLToPath(new URL('./drive-pty-quit.mts', import.meta.url))
    const e = spawn(electron, ['--use-mock-keychain', `--user-data-dir=${join(dir, 'ud')}`, harness], { env, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    e.stderr?.on('data', (d) => (stderr += d))
    const ended = await new Promise<{ at: number; code: number | null; signal: string | null } | null>((resolve) => {
      const stuck = setTimeout(() => resolve(null), 25_000)
      e.on('exit', (code, signal) => { clearTimeout(stuck); resolve({ at: Date.now(), code, signal }) })
    })
    if (!ended) {
      // The rig's own Electron (this run's scratch profile), never a Stoke: ask it to go, by its exact pid.
      try { e.kill('SIGTERM') } catch { /* gone */ }
      throw new Error(`the harness Electron was still running 25 s after it started (${kinds.join(',')}): ${stderr.slice(-400)}`)
    }
    const lines = (() => { try { return readFileSync(out, 'utf8').trim().split('\n') } catch { return [] } })()
    const stamp = (word: string) => { const l = lines.find((x) => x.split(' ')[1] === word); return l ? Number(l.split(' ')[0]) : NaN }
    const error = lines.find((l) => l.split(' ')[1] === 'error')
    if (error || Number.isNaN(stamp('quit'))) throw new Error(`the harness did not reach its quit (${kinds.join(',')}): ${error ?? ''} ${stderr.slice(-400)}`)
    const ready = JSON.parse(lines.find((l) => l.split(' ')[1] === 'ready')!.split(' ').slice(2).join(' ')) as { pids: { child: number; grand: number }[] }
    const settleLine = lines.find((l) => l.split(' ')[1] === 'settle')
    const all = ready.pids.flatMap((p) => [p.child, p.grand])
    // An orphan is reparented and reaped by init a moment later; give that its moment.
    for (let i = 0; i < 20 && all.some(alivePid); i++) await new Promise((r) => setTimeout(r, 25))
    return {
      quitToExitMs: ended.at - stamp('quit'),
      code: ended.code,
      signal: ended.signal,
      lines,
      settle: settleLine ? (JSON.parse(settleLine.split(' ').slice(2).join(' ')) as QuitSettleReport) : null,
      pids: ready.pids,
      aliveAfter: all.map(alivePid)
    }
  }
  const shown = (r: QuitRun) => `    (Electron ended ${r.quitToExitMs} ms after quit; ${r.lines.map((l) => l.split(' ')[1]).join(' → ')})`
  try {
    // The control first: without the hold, the rig must be able to see the hang it exists for.
    const control = await quitRun(['trap'], { noHold: true, selfExitMs: 5000 })
    console.log(shown(control))
    check('control, no hold: a child trapping SIGHUP and SIGTERM keeps Electron alive after quit until it ends itself', control.quitToExitMs >= 4000, true)
    check('control reaped', await reapMarked(), [])

    // (a) An ordinary child exits on the SIGHUP, and the quit is not held for longer than its exit.
    const normal = await quitRun(['normal'])
    console.log(shown(normal))
    check('(a) a child that exits on SIGHUP is never escalated', normal.settle && [normal.settle.escalated, normal.settle.outcomes, normal.settle.remaining], [[], [], 0])
    check(`(a) and the quit waits only for its exit, not the ${FORCE_KILL_GRACE_MS} ms grace (under 1 s)`, normal.quitToExitMs < 1000, true)
    check('(a) Electron exits cleanly and the child and its grandchild are gone', [normal.code, normal.aliveAfter], [0, [false, false]])
    // Why index.ts's before-quit decides its drain once (the wire check above): the hold's quit runs it again.
    check('(a) the hold’s second quit runs before-quit again', normal.lines.filter((l) => l.split(' ')[1] === 'before-quit').length, 2)

    // (b) A trapping child and its trapping grandchild: ended after the grace, and Electron gone inside ~3 s.
    const trapped = await quitRun(['trap'])
    console.log(shown(trapped))
    check('(b) the trapping child is escalated after the grace, its tree killed', trapped.settle && [trapped.settle.escalated, trapped.settle.outcomes, trapped.settle.remaining], [[trapped.pids[0].child], ['killed'], 0])
    check('(b) the trapping child and its trapping grandchild are both gone', trapped.aliveAfter, [false, false])
    check(`(b) Electron has exited within 3.5 s of quit, and not before the ${FORCE_KILL_GRACE_MS} ms grace`, [trapped.quitToExitMs >= FORCE_KILL_GRACE_MS, trapped.quitToExitMs < 3500, trapped.code], [true, true, 0])

    // (c) Everything exits by itself (one at once, one 600 ms later): nothing escalates.
    const both = await quitRun(['normal', 'slow'])
    console.log(shown(both))
    check('(c) nothing escalates when every child exits by itself', both.settle && [both.settle.escalated, both.settle.outcomes, both.settle.remaining], [[], [], 0])
    check('(c) the quit ends with the slower child, well inside the grace', [both.quitToExitMs >= 550, both.quitToExitMs < FORCE_KILL_GRACE_MS], [true, true])
    check('(c) every child and grandchild is gone', both.aliveAfter, [false, false, false, false])
    check('(c) one settle for the whole quit, then the quit goes through', [both.lines.filter((l) => l.split(' ')[1] === 'settle').length, both.lines.filter((l) => l.split(' ')[1] === 'quit-event').length], [1, 1])
  } finally {
    const left = await reapMarked()
    await rm(quitRoot, { recursive: true, force: true })
    check('no process carrying this run\'s scratch path survives the quit runs', left, [])
  }
}

setTimeout(() => {
  console.error('FAIL native terminal transports remain open after the exit drain')
  process.exit(1)
}, 5000).unref()
process.once('beforeExit', () => console.log(`\n${checks} PTY exit checks passed, including native transport cleanup`))
