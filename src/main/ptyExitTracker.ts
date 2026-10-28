import type { IPty } from '@lydell/node-pty'
import { FORCE_KILL_GRACE_MS, killablePid, killProcessTree, systemTreeKill, type TreeKillOutcome } from './processTree.ts'

/**
 * At quit, after the grace, how long a stubborn child's process group has
 * between SIGTERM and SIGKILL. Shorter than Force restart's
 * `FORCE_KILL_GRACE_MS`: the gentle signal already had that long, and the
 * whole quit has to end inside `QUIT_DEADLINE_MS`. Measured on macOS, the
 * tree kill around it (`ps`, SIGTERM, this, SIGKILL, the group seen empty)
 * took 735 ms with 500 here; under load it once outran the second the
 * deadline leaves it, so this is 300.
 */
export const QUIT_TERM_GRACE_MS = 300
/**
 * The longest a quit waits on its pty children, from the start of the settle.
 * Windows keeps its drain's old 5 s bound: ConPTY's exit has to be DELIVERED
 * before Node's teardown (see `track`), and a slow machine's delivery is the
 * reason that drain exists. A taskkill'd child is gone at once either way.
 */
export const QUIT_DEADLINE_MS = 3_000
export const WIN_QUIT_DEADLINE_MS = 5_000

/** One pty child as the quit sees it. */
export interface QuitChild {
  pid: number
  /** Its exit event has run (its pid may be another program's from then on). */
  exited: () => boolean
  /** Resolves when its exit event runs. */
  exit: Promise<void>
  /** Resolves once that exit has also been delivered and closed (`track`). */
  delivered: Promise<void>
}

export interface QuitSettleDeps {
  /** How long the owner's gentle signal (node-pty's SIGHUP) gets, alone. */
  graceMs: number
  /** The whole settle's bound, measured from its start. */
  deadlineMs: number
  now: () => number
  /** Kill one child's process tree (`killProcessTree`); never handed an exited child. */
  treeKill: (pid: number, exited: () => boolean) => Promise<TreeKillOutcome>
  /**
   * The deadline came while a tree kill was still under way (a slow `ps`, a
   * kill still waiting): SIGKILL to the pid alone, guarded by `killablePid`.
   */
  lastResort: (pid: number, exited: () => boolean) => void
}

export interface QuitSettleReport {
  /** The pids that were still running after the grace, so had their tree killed. */
  escalated: number[]
  outcomes: TreeKillOutcome[]
  /** Children whose exit had not been delivered when the settle gave up. */
  remaining: number
}

/** `p`, or nothing after `ms`. The timer is always cleared, so nothing is left holding a loop. */
async function within(p: Promise<unknown>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([p, new Promise<void>((resolve) => { timer = setTimeout(resolve, Math.max(0, ms)) })])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Quit's half of the kill (CLAUDE.md gotcha 163). The owner has ALREADY sent
 * each child its gentle signal (`PtyManager.shutdown` → node-pty's `kill()`,
 * SIGHUP; the quick terminal's `end`), and that signal stays the first one:
 * Claude Code's SIGHUP handler is what writes its transcript. Measured on
 * macOS, a quit with a child that traps SIGHUP and SIGTERM left Electron's
 * main thread in `node::FreeEnvironment` → `CleanupHandles` → node-pty's exit
 * TSFN finalizer → `std::thread::join`, joining the thread that sits in
 * `waitpid` for that child: Stoke's process lives exactly as long as its
 * stubbornest pty child. So:
 *
 * - A child that exits inside `graceMs` is never signalled again, and the
 *   settle ends the moment the last one has exited: no fixed wait.
 * - A child still running after the grace has its tree killed
 *   (`killProcessTree`: SIGTERM to its group, SIGKILL after
 *   `QUIT_TERM_GRACE_MS`; taskkill /T /F on Windows), with `killablePid`'s
 *   guards — never pid 0 or 1, never Stoke or its group, never an exited
 *   child's pid.
 * - Nothing waits past `deadlineMs`, whatever a child does. A tree kill the
 *   deadline cuts short may not have reached its SIGKILL yet, and once the
 *   quit goes on the JS loop never runs again to send it: a child ignoring
 *   SIGTERM would then hold Stoke in Node's teardown for good. So at the
 *   deadline each child still running gets one SIGKILL, to its pid alone
 *   (`lastResort`; the leader is the one Node's teardown waits for).
 *
 * Pure apart from what it is handed, so verify:pty-exit drives it with fakes
 * and, through `PtyExitTracker.settle`, with real ptys under a real Electron.
 */
export async function settleQuit(children: QuitChild[], deps: QuitSettleDeps): Promise<QuitSettleReport> {
  const start = deps.now()
  const left = (): number => deps.deadlineMs - (deps.now() - start)
  await within(Promise.all(children.map((c) => c.exit)), Math.min(deps.graceMs, left()))
  const stubborn = children.filter((c) => !c.exited())
  const outcomes: TreeKillOutcome[] = []
  if (stubborn.length) {
    // Only a kill still under way gets the last resort: one that finished has seen
    // its group empty, and its leader's exit event may simply not have run yet.
    const finished = new Set<QuitChild>()
    await within(
      Promise.all(stubborn.map((c) => deps.treeKill(c.pid, c.exited).then((o) => void outcomes.push(o), () => void outcomes.push('stuck')).finally(() => void finished.add(c)))),
      left()
    )
    for (const c of stubborn) if (!finished.has(c) && !c.exited()) deps.lastResort(c.pid, c.exited)
  }
  let delivered = 0
  await within(Promise.all(children.map((c) => c.delivered.then(() => void delivered++))), left())
  return { escalated: stubborn.map((c) => c.pid), outcomes, remaining: children.length - delivered }
}

/** The real dependencies: `killProcessTree` with nothing sent before it (the owner sent the gentle signal). */
export function systemQuitSettle(platform: string = process.platform): QuitSettleDeps {
  return {
    graceMs: FORCE_KILL_GRACE_MS,
    deadlineMs: platform === 'win32' ? WIN_QUIT_DEADLINE_MS : QUIT_DEADLINE_MS,
    now: Date.now,
    treeKill: (pid, exited) => killProcessTree(pid, { ...systemTreeKill(() => {}, exited), graceMs: QUIT_TERM_GRACE_MS }),
    lastResort: lastResortKill((pid, sig) => process.kill(pid, sig), { pid: process.pid, ppid: process.ppid })
  }
}

/** SIGKILL to one pid alone, behind `killablePid` (never 0, 1, Stoke or its parent, never an exited child). */
export function lastResortKill(signal: (pid: number, sig: NodeJS.Signals) => void, self: { pid: number; ppid: number }): (pid: number, exited: () => boolean) => void {
  return (pid, exited) => {
    if (!killablePid(pid, self, exited())) return
    try {
      signal(pid, 'SIGKILL')
    } catch {
      /* gone, or not ours */
    }
  }
}

/** Own native exit delivery independently of tabs, which may close first. */
export class PtyExitTracker {
  private pending = new Map<IPty, Promise<void>>()
  private exits = new Map<IPty, Promise<void>>()
  private exited = new WeakSet<IPty>()
  private watched = new WeakSet<IPty>()
  private quitSettle: Promise<QuitSettleReport> | null = null
  /** True once the quit's settle has finished (`settle`). */
  settled = false

  track(child: IPty): void {
    if (this.watched.has(child)) return
    this.watched.add(child)
    let complete!: () => void
    let ended!: () => void
    this.pending.set(child, new Promise<void>(resolve => { complete = resolve }))
    this.exits.set(child, new Promise<void>(resolve => { ended = resolve }))
    child.onExit(() => {
      this.exited.add(child)
      ended()
      // ConPTY's TSFN must finish its JS callback and native handle close
      // before Electron starts Node environment teardown. Do not resolve
      // from inside that callback, or just from a kill()/tab-close request.
      setImmediate(() => setImmediate(() => {
        this.pending.delete(child)
        this.exits.delete(child)
        complete()
      }))
    })
  }

  get count(): number { return this.pending.size }

  /** A deadline reports remaining ownership; it never invents an exit. */
  async wait(timeoutMs = 5000): Promise<number> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        Promise.all([...this.pending.values()]),
        new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })
      ])
      return this.pending.size
    } finally { clearTimeout(timer) }
  }

  /**
   * The quit's wait, which also ends what will not end (`settleQuit`). Once
   * per process: the before-quit drain (Windows) and the will-quit hold
   * (`holdQuitForPtys`) share one settle, and a second quit never starts a
   * second round of signals.
   */
  settle(deps: QuitSettleDeps = systemQuitSettle()): Promise<QuitSettleReport> {
    this.quitSettle ??= settleQuit(
      [...this.pending].map(([child, delivered]) => ({
        pid: child.pid,
        exited: () => this.exited.has(child),
        exit: this.exits.get(child) ?? Promise.resolve(),
        delivered
      })),
      deps
    ).then((report) => {
      this.settled = true
      return report
    })
    return this.quitSettle
  }
}

// Survives the main window's closed handler clearing its PtyManager. Every
// local/SSH agent and quick shell registers the exact object after spawn.
export const ownedPtyExits = new PtyExitTracker()

/** The part of Electron's `app` the hold needs. */
export interface QuitApp {
  on(event: 'will-quit', listener: (event: { preventDefault: () => void }) => void): unknown
  quit(): void
}

/**
 * Hold the quit at `will-quit` until every pty child this process owns has
 * gone, ending any that would not (`PtyExitTracker.settle`, gotcha 163), then
 * quit again. `will-quit`, not `before-quit`: by then every window has closed,
 * so the window leaves the screen exactly as fast as before and only the
 * windowless process waits, at most `QUIT_DEADLINE_MS` — where without this
 * it waited inside Node's teardown for as long as the stubbornest child lived.
 * Nothing in before-quit moves. With no child left, or once the settle has
 * run, the quit goes straight through. The second `app.quit()` runs every
 * before-quit handler again, so anything decided there is decided once
 * (gotcha 170).
 */
export function holdQuitForPtys(app: QuitApp, tracker: PtyExitTracker = ownedPtyExits, deps?: QuitSettleDeps, report?: (r: QuitSettleReport) => void): void {
  app.on('will-quit', (event) => {
    if (tracker.settled || tracker.count === 0) return
    event.preventDefault()
    void tracker.settle(deps).then((r) => {
      report?.(r)
      app.quit()
    })
  })
}
