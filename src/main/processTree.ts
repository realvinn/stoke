/**
 * Kill a pty's whole process tree, for Force restart on a terminal that stopped
 * answering (shared/terminalStall.ts, `PtyManager.stop(…, force)`).
 *
 * The ordinary close (`PtyManager.kill`) is node-pty's own `kill()`: SIGHUP to
 * the child alone, which is right for a live `claude` — it exits in under a
 * second — and useless for a hung one. A node process whose event loop is
 * blocked never runs its signal handlers, and Claude Code installs handlers for
 * SIGHUP and SIGTERM, so a handled signal is simply held forever. Only SIGKILL
 * cannot be held. So this is the pty's own SIGHUP and SIGTERM first (a process
 * that is merely slow still gets to clean up), then SIGKILL once `graceMs` has
 * passed with anything left.
 *
 * Every target is checked first (`killablePid`): never 0, 1 or a negative pid,
 * never Stoke or its parent, never an exited process's pid, and a GROUP only
 * once `ps` says the child leads it and it is not Stoke's own. `kill(-0)` is
 * `kill(0)`, which signals the caller's own group: an SSH tab's pty reports pid
 * 0 once its ssh has gone, and that would have been SIGTERM, then SIGKILL, to
 * Stoke itself.
 *
 * To the GROUP, not the pid. node-pty forks with `forkpty`, whose child calls
 * `setsid`, so the child leads a new session and process group: pgid == pid.
 * Everything it starts without detaching inherits that group — Claude Code's
 * MCP servers, its Bash tool's commands, a hook — so `kill(-pid)` takes all of
 * them down with it, and a grandchild that traps SIGTERM still meets the
 * SIGKILL. What it does NOT reach is anything that left the group on purpose
 * (`detached: true`, `setsid`, a daemon): those outlive the tab, as they would
 * outlive a closed terminal anywhere.
 *
 * On Windows there are no groups: `taskkill /T /F` walks the tree by parent
 * pid while the parent is still there to walk from, and only then is node-pty's
 * own kill (which closes the ConPTY) called, if the process is still running.
 * Never run on Windows.
 *
 * Pure apart from what it is handed (signal, taskkill, ps, sleep), so
 * verify:terminal-stall drives it with fakes and with a real pty.
 */

import { execFile } from 'node:child_process'
import { join } from 'node:path'

/** SIGTERM, then this long before SIGKILL. */
export const FORCE_KILL_GRACE_MS = 2_000
/** After the SIGKILL, how long to look for the group to be gone. */
const AFTER_KILL_MS = 1_000
/** How often the group is looked for. */
const POLL_MS = 100

export type TreeKillOutcome =
  /** Nothing was left after the first signals (the pty's own SIGHUP, then SIGTERM). */
  | 'terminated'
  /** Something was still there after `graceMs`, and SIGKILL took it. */
  | 'killed'
  /** Something was still there even after the SIGKILL (a process stuck in the kernel). */
  | 'stuck'
  /** Windows: taskkill ran (or failed, and the pty's own kill was used). */
  | 'taskkill'
  /**
   * Nothing was signalled, because the pid named no process of ours to kill:
   * 0, 1, negative or not an integer, Stoke itself or its parent, or a process
   * that had already exited (its pid may be another program's by now). Only
   * the pty's own kill ran.
   */
  | 'gone'

export interface TreeKillDeps {
  platform: string
  /** `process.kill`: a negative pid is a process group, signal 0 only asks. */
  signal: (pid: number, sig: NodeJS.Signals | 0) => void
  /** Windows only: kill `pid` and every process under it. Rejects when it could not. */
  taskkill: (pid: number) => Promise<void>
  /**
   * The pty's own kill (node-pty's `kill()`, the SSH wrapper's, which also stops
   * its password retry). On POSIX it runs before any signal, on Windows after the tree.
   */
  fallback: () => void
  sleep: (ms: number) => Promise<void>
  /**
   * Whether the pty's process has already exited (its exit event ran). After
   * that its pid may be reused, so it is never signalled, never handed to
   * taskkill, and never counted as "still there".
   */
  exited: () => boolean
  /** Stoke's own pid and its parent's: never a target, alone or as a group. */
  self: { pid: number; ppid: number }
  /**
   * POSIX: each listed pid's process group, as `ps` reports it, or null when
   * `ps` could not say. A pid missing from the map was not found.
   */
  groups: (pids: number[]) => Promise<Map<number, number> | null>
  graceMs?: number
}

/** Whether a process (`pid`) or a group (`-pgid`) has anything left in it. */
function alive(deps: TreeKillDeps, target: number): boolean {
  try {
    deps.signal(target, 0)
    return true
  } catch (err) {
    // EPERM: it exists, it is just not ours to signal (a setuid child). Still there.
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

function send(deps: TreeKillDeps, target: number, sig: NodeJS.Signals): boolean {
  try {
    deps.signal(target, sig)
    return true
  } catch {
    return false
  }
}

/**
 * Wait until nothing is left in the group (or the pid, when the group could not
 * be signalled), at most `ms`. True when it is gone.
 */
async function goneWithin(deps: TreeKillDeps, target: number, ms: number): Promise<boolean> {
  for (let waited = 0; ; waited += POLL_MS) {
    // A pid alone (no group) answers for the process only until it exits: after that the number is free.
    if (target > 0 && deps.exited()) return true
    if (!alive(deps, target)) return true
    if (waited >= ms) return false
    await deps.sleep(POLL_MS)
  }
}

/**
 * Whether `pid` is a process this may kill at all. `kill(0)` (and `-0`, which
 * is 0) signals the CALLER's own process group, Stoke itself; `kill(-1)` every
 * process this user owns. An SSH tab's pty reports pid 0 once its ssh has
 * exited, and between the two connections of a password retry
 * (sshFallback.ts), and an ended session stays in PtyManager's map (gotcha 84).
 * An exited process's pid may already be someone else's, on Windows within
 * moments.
 */
export function killablePid(pid: number, self: { pid: number; ppid: number }, exited: boolean): boolean {
  return Number.isInteger(pid) && pid > 1 && pid !== self.pid && pid !== self.ppid && !exited
}

export async function killProcessTree(pid: number, deps: TreeKillDeps): Promise<TreeKillOutcome> {
  if (!killablePid(pid, deps.self, deps.exited())) {
    deps.fallback()
    return 'gone'
  }
  if (deps.platform === 'win32') {
    try {
      await deps.taskkill(pid)
    } catch {
      /* access denied, or already gone: the pty's own kill below still runs */
    }
    deps.fallback()
    return 'taskkill'
  }
  const grace = deps.graceMs ?? FORCE_KILL_GRACE_MS
  /*
   * The group only when `ps` says the child LEADS it (forkpty's setsid) and it
   * is not Stoke's own group. Anything else — no `ps`, a child that is not a
   * leader, a group Stoke is in — is the pid alone: weaker (its MCP servers may
   * outlive it), never wider.
   *
   * Asked BEFORE anything is sent, while the child is certainly alive. Asked
   * after the SIGHUP below, a leader that dies on it is reaped within
   * milliseconds, `ps` no longer lists it, and its group (MCP servers that
   * trap SIGHUP) was never signalled: measured, the suite's trapping
   * grandchild outlived the forced stop.
   */
  const groups = await deps.groups([pid, deps.self.pid])
  const leads = groups !== null && groups.get(pid) === pid && groups.get(deps.self.pid) !== pid
  // It ended by itself while ps answered, with no group to reach: its pid may be free now.
  if (!leads && deps.exited()) {
    deps.fallback()
    return 'gone'
  }
  /*
   * The pty's own kill next: SIGHUP to the child, which a live but slow
   * `claude` acts on, and which tells the SSH wrapper it was stopped, so the
   * ssh this kills is never followed by a password retry nobody holds.
   */
  deps.fallback()
  /*
   * A GROUP is safe to signal after its leader has gone: POSIX never reuses a
   * process group id while the group has a member, and an empty group answers
   * ESRCH. Only the pid alone is unsafe once the process has exited.
   */
  let target = leads ? -pid : pid
  if (!send(deps, target, 'SIGTERM') && target < 0) {
    // Nothing in the group took it. With the leader gone too, all of it is gone.
    if (deps.exited()) return 'terminated'
    target = pid
    send(deps, target, 'SIGTERM')
  }
  if (await goneWithin(deps, target, grace)) return 'terminated'
  send(deps, target, 'SIGKILL')
  return (await goneWithin(deps, target, AFTER_KILL_MS)) ? 'killed' : 'stuck'
}

/** `taskkill /PID <pid> /T /F` by absolute path, never a bare name on PATH. */
export function taskkillTree(pid: number): Promise<void> {
  const exe = join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe')
  return new Promise((resolve, reject) => {
    execFile(exe, ['/PID', String(pid), '/T', '/F'], { timeout: 5_000, maxBuffer: 64 * 1024, windowsHide: true }, (err) =>
      err ? reject(err) : resolve()
    )
  })
}

/** `ps -o pid=,pgid=` for the listed pids. ps exits 1 when one is missing, so its stdout is read either way. */
export function psGroups(pids: number[]): Promise<Map<number, number> | null> {
  const args = ['-o', 'pid=,pgid=']
  for (const pid of pids) args.push('-p', String(pid))
  return new Promise((resolve) => {
    execFile('ps', args, { timeout: 2_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      const map = new Map<number, number>()
      for (const line of String(stdout ?? '').split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
        if (m) map.set(Number(m[1]), Number(m[2]))
      }
      // No line at all is "could not say" (no ps, a timeout), never "not found".
      resolve(map.size || !err ? map : null)
    })
  })
}

/** The real dependencies, for main. */
export function systemTreeKill(fallback: () => void, exited: () => boolean): TreeKillDeps {
  return {
    platform: process.platform,
    signal: (pid, sig) => {
      process.kill(pid, sig)
    },
    taskkill: taskkillTree,
    fallback,
    exited,
    self: { pid: process.pid, ppid: process.ppid },
    groups: psGroups,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}
