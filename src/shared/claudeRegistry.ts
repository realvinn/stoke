/**
 * Claude Code's own register of running sessions: `<config dir>/sessions/<pid>.json`.
 *
 * Every interactive `claude` writes one file named after its own pid and keeps
 * it current for as long as it runs. Measured against 2.1.278 (2026-09-19):
 *
 *  - `sessionId` is the session the process is on NOW. `/clear` mints a new id
 *    and the in-TUI `/resume` switches to another, and this file follows within
 *    ~0.05s. `/compact` keeps the id. A `--resume <id>` names that id from its
 *    very first write — there is no transient id to debounce.
 *  - `status` is one of `busy`, `shell`, `idle`, `waiting` (the four the binary
 *    defines), with `waitingFor` beside `waiting` (a permission dialog). A prompt
 *    goes `busy` within ~0.1s; Esc goes back to `idle` with no `Stop` hook at
 *    all. The key is ABSENT for the first ~0.5s after the file appears.
 *  - `version` is the running binary's version, which is the one fact the
 *    relaunch offer needs and the statusLine payload only states once the TUI
 *    renders.
 *  - SIGHUP removes the file ~0.37s later.
 *
 * It is undocumented, so every field is optional here and a reading that does
 * not parse is `null`, never a guess — the same stance `usage.ts` takes with its
 * endpoint: a wrong reading is worse than none. **`idle` does not prove the
 * prompt box is empty**: typing a draft leaves the status `idle` (measured), so
 * anything that kills a session on `idle` alone can throw away unsent text.
 *
 * Pure and in `src/shared`, so the poller in `src/main/sessionRegistry.ts` and
 * the renderer read one definition, and `scripts/verify-registry.mts` runs it
 * under strip-types. No `node:` imports (gotcha 27).
 */

export type RegistryStatus = 'busy' | 'shell' | 'idle' | 'waiting'

const STATUSES: readonly RegistryStatus[] = ['busy', 'shell', 'idle', 'waiting']

/** One `<pid>.json`, every field optional because the file is not ours. */
export interface RegistryEntry {
  pid: number | null
  sessionId: string | null
  cwd: string | null
  status: RegistryStatus | null
  waitingFor: string | null
  version: string | null
  /** Epoch ms the process started, by its own clock. */
  startedAt: number | null
  statusUpdatedAt: number | null
}

/**
 * A session id as Stoke will ever pass one to `claude`.
 *
 * The same whitelist `SAFE_ID` applies in `main/ssh.ts`, and for a sharper
 * reason here: an id read out of this file becomes a `--resume <id>` argument,
 * and on Windows a `.cmd` install runs through `cmd.exe /c`, which acts on
 * `& | ^ < >` (gotcha 13). A file on disk must not be able to put a shell
 * metacharacter into argv.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/

export function isSafeRegistryId(v: unknown): v is string {
  return typeof v === 'string' && SAFE_SESSION_ID.test(v)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function str(v: unknown, max = 512): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.slice(0, max) : null
}

/**
 * One registry file's text as a reading, or null when it is not one at all.
 *
 * A half-written file, a truncated one, an array, a number: all null. A file
 * that parses but carries nothing Stoke can use (no pid AND no session id) is
 * null too, because an entry that names nothing cannot be matched to anything
 * and would only ever be a false match.
 */
export function parseRegistry(text: string): RegistryEntry | null {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const pid = num(raw.pid)
  const sessionId = isSafeRegistryId(raw.sessionId) ? raw.sessionId : null
  if (pid === null && sessionId === null) return null
  const status =
    typeof raw.status === 'string' && (STATUSES as readonly string[]).includes(raw.status)
      ? (raw.status as RegistryStatus)
      : null
  return {
    pid: pid !== null && Number.isInteger(pid) && pid > 0 ? pid : null,
    sessionId,
    cwd: str(raw.cwd, 4096),
    status,
    waitingFor: status === 'waiting' ? str(raw.waitingFor, 200) : null,
    version: str(raw.version, 64),
    startedAt: num(raw.startedAt),
    statusUpdatedAt: num(raw.statusUpdatedAt)
  }
}

/**
 * Whether a status means "a turn is in flight": true, false, or null for
 * "cannot say".
 *
 * `waiting` counts as busy — a permission dialog is the middle of a turn, and
 * killing the process there loses the turn exactly as killing it mid-reply
 * does. `shell` counts too: the binary's own name for a state in which a
 * command is running. Only a stated `idle` is idle. A missing status (the first
 * half-second of every session, or a CLI that stops writing the key) is null,
 * and every caller must treat null as "do not act on this".
 */
export function isBusyStatus(status: RegistryStatus | null): boolean | null {
  if (status === null) return null
  return status !== 'idle'
}

/** What main knows about a local Claude pty when it goes looking for its file. */
export interface RegistryTarget {
  ptyId: string
  /** The pty child's pid, or null when node-pty did not report one. */
  pid: number | null
  /** The id Stoke currently holds for this pty — '' for a `--continue`. */
  sessionId: string
  /** The session's folder, already resolved through symlinks by the caller. */
  cwd: string
  /** When Stoke spawned it, epoch ms. */
  startedAt: number
}

/**
 * How long after the spawn a missing `<pid>.json` stops being "not written
 * yet" and becomes "not named after this pid". Measured: the file appears
 * 1.3-2.5s after the spawn, and the status key ~0.5s after that.
 */
export const REGISTRY_FALLBACK_AFTER_MS = 4000

/**
 * A process that started this long BEFORE Stoke spawned the pty cannot be it.
 * Slack rather than zero because the two clocks are read at slightly different
 * moments on the same machine.
 */
const STARTED_SLACK_MS = 5000

/**
 * Which registry entry describes this pty, or null when none can be named with
 * confidence.
 *
 * In order:
 *
 *  1. **The file named after the pty's pid.** On macOS and Linux the pty child
 *     IS `claude` (or execs into it), so this is exact. Measured here.
 *  2. **The one entry carrying the id Stoke already holds.** For a pty whose pid
 *     is not claude's — a Windows `.cmd` install runs through `cmd.exe /c`, so
 *     the pty pid is cmd.exe's — the session id is the next-best key.
 *  3. **The one unclaimed entry in the same folder that started after the
 *     spawn.** The `--continue` case on such a machine, where Stoke holds no id.
 *
 * 2 and 3 are fallbacks for a layout this machine cannot produce, and they are
 * UNVERIFIED on Windows. Both refuse ambiguity — two candidates is no answer —
 * because naming the wrong process would rebind a tab to a stranger's session.
 * `claimed` is every session id some OTHER target has already matched by pid,
 * so a fallback cannot steal a session that is provably somebody else's.
 */
export function pickEntry(
  target: RegistryTarget,
  byPid: RegistryEntry | null,
  all: readonly RegistryEntry[] | null,
  claimed: ReadonlySet<string>
): RegistryEntry | null {
  if (byPid && (byPid.pid === null || byPid.pid === target.pid)) return byPid
  if (!all) return null
  const free = all.filter((e) => !(e.sessionId && claimed.has(e.sessionId)))
  if (target.sessionId) {
    const same = free.filter((e) => e.sessionId === target.sessionId)
    if (same.length === 1) return same[0]
    if (same.length > 1) return null
  }
  const here = free.filter(
    (e) =>
      e.cwd !== null &&
      samePath(e.cwd, target.cwd) &&
      (e.startedAt === null || e.startedAt >= target.startedAt - STARTED_SLACK_MS)
  )
  return here.length === 1 ? here[0] : null
}

/**
 * Two folder paths as the same folder: separators and a trailing one folded,
 * and case folded on a path that looks like Windows (a drive letter), where the
 * file system is case-insensitive. Symlinks are the caller's job — this module
 * has no file system to ask.
 */
export function samePath(a: string, b: string): boolean {
  const norm = (p: string): string => {
    const s = p.replace(/[\\/]+/g, '/').replace(/\/$/, '')
    return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s
  }
  return norm(a) === norm(b)
}

/**
 * The id a pty has moved to, or null when it has not moved.
 *
 * Only a safe id (see `isSafeRegistryId`) and only a change: the same id, or a
 * file that names none, is not a rebind. A `--continue` pty holds '' and gets
 * its real id here the first time its file is read — which is what closes
 * gotcha 26's blank ring.
 */
export function rebindTo(current: string, entry: RegistryEntry | null): string | null {
  const next = entry?.sessionId ?? null
  if (!next || next === current) return null
  return next
}
