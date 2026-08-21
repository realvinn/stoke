import { mkdirSync, readFileSync, rmdirSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { homedir } from 'node:os'
import { claudeGlobalConfigLockPath, claudeGlobalConfigPath } from './claudePaths.ts'
import { writeJsonAtomic } from './claudeSettings.ts'

/**
 * Writing one key into Claude Code's global config, `~/.claude.json`.
 *
 * This file is nothing like `settings.json`. It is 155 KB on this machine, it
 * is rewritten constantly by every live session — startup counters, per-project
 * `lastCost`/`lastSessionId`, tip impressions, a flag-cache refresh — and
 * losing it costs the account: a parse failure makes the CLI back it up and
 * then **reset to defaults**, measured at 16 keys down to 5, destroying
 * `oauthAccount`, `userID`, `machineID` and every project entry. There is no
 * automatic restore from the backup it takes.
 *
 * Stoke writes exactly one key here — `workflowSizeGuideline` — because that is
 * where `/config` writes it, and putting it in settings.json instead would hide
 * the `/config` row and take the control away from the CLI.
 *
 * ## Why a lock is necessary but not sufficient
 *
 * The CLI protects this file with a bundled proper-lockfile v4: the lock is an
 * empty **directory** at `<config>.lock`, created by `mkdir`, judged stale
 * purely by its own mtime at 10s, refreshed by the holder every 5s.
 *
 * Every CLI writer re-reads the file from disk *inside* its critical section
 * and applies a reducer to that disk value, so a running session does not
 * serialise a stale cached object over an external edit — verified by writing a
 * sentinel key mid-session and watching it survive the session's full exit
 * payload. The loss window is narrower than that and was measured directly:
 * it is `[the CLI's read completes -> its rename completes]`, which sits
 * entirely inside its lock hold. So holding the lock closes it.
 *
 * Except that the CLI acquires with `retries: 0`. It never waits. An `ELOCKED`
 * sends it straight down an unlocked, un-backed-up read-modify-write — so
 * Stoke holding the lock is precisely what forces the CLI onto the path the
 * lock was meant to guard against. Its exit handlers write with no lock at all.
 *
 * Hence: hold the lock, hold it *briefly*, and then **verify the write landed
 * and retry if it did not**. All three, not any two.
 */

/** proper-lockfile's default, and the rule for breaking someone else's lock. */
const STALE_MS = 10_000
/** Refresh well inside STALE_MS so a session never steals a lock we hold. */
const REFRESH_MS = 4_000
/** How long to wait for a lock before giving up and writing anyway, as the CLI does. */
const ACQUIRE_TIMEOUT_MS = 2_000
const POLL_MS = 25
/** Past the CLI's own 1000ms `fs.watchFile` poll, so a re-read sees settled state. */
const SETTLE_MS = 1_500
const ATTEMPTS = 4

/** Locks this process is holding, swept on the way out. */
const held = new Set<string>()

/**
 * A crash must not wedge a session's config writes.
 *
 * The 10s staleness rule already bounds the damage — but only for a lock
 * *directory*. Sweeping on exit is what keeps the ordinary case at zero.
 */
export function releaseHeldLocks(): void {
  for (const lock of held) {
    try {
      rmdirSync(lock)
    } catch {
      // Already gone, or stolen as stale. Either way there is nothing to do.
    }
  }
  held.clear()
}
process.on('exit', releaseHeldLocks)

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Take the lock, or report that we are proceeding without it.
 *
 * Waiting is Stoke's contribution: the CLI does not wait, so a writer that does
 * is what actually reduces contention rather than adding to it.
 */
async function acquire(lock: string): Promise<boolean> {
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS
  for (;;) {
    try {
      mkdirSync(lock)
      held.add(lock)
      return true
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false

      let info: ReturnType<typeof statSync> | null = null
      try {
        info = statSync(lock)
      } catch {
        // Vanished between the mkdir and the stat. Try again immediately.
        continue
      }

      const age = Date.now() - info.mtime.getTime()
      if (age > STALE_MS) {
        try {
          if (info.isDirectory()) {
            rmdirSync(lock)
          } else {
            /*
             * A lock *file* is not something proper-lockfile ever creates, and
             * it is worse than a stale directory: the CLI breaks a stale lock
             * with `rmdir`, which can never remove a file, so one left here
             * degrades every CLI config write to the unlocked path
             * permanently. Removing it repairs the CLI, not just this write.
             */
            unlinkSync(lock)
          }
          continue
        } catch {
          // Someone else won the race to break it. Fall through and retry.
        }
      }
    }
    if (Date.now() >= deadline) return false
    await sleep(POLL_MS)
  }
}

function release(lock: string): void {
  if (!held.has(lock)) return
  held.delete(lock)
  try {
    rmdirSync(lock)
  } catch {
    // Stolen as stale, or already swept. Nothing to repair.
  }
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export interface GlobalConfigWrite {
  ok: boolean
  error: string | null
  /** True when the write landed but only after the lock had to be skipped. */
  wroteUnlocked: boolean
  attempts: number
}

/**
 * The one guard that matters more than the lock does.
 *
 * `GDe()` in the CLI refuses to persist anything when the on-disk object has
 * lost its auth keys, so writing a config that dropped them does not merely
 * lose data — it freezes the CLI's own config persistence afterwards. And
 * writing over a *failed parse* is exactly how this file gets reset to
 * defaults. Both are refusals here, not repairs.
 */
function refuseToWrite(parsed: unknown): string | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return 'Claude Code’s global config is not a JSON object. Stoke will not overwrite it.'
  }
  const cfg = parsed as Record<string, unknown>
  if (cfg.oauthAccount === undefined && cfg.hasCompletedOnboarding !== true) {
    return 'Claude Code’s global config has no sign-in recorded, so Stoke will not write to it.'
  }
  return null
}

export function readGlobalConfigKey(key: string): { value: unknown; error: string | null } {
  const path = claudeGlobalConfigPath(process.env, homedir())
  try {
    const parsed: unknown = JSON.parse(stripBom(readFileSync(path, 'utf8')))
    if (!parsed || typeof parsed !== 'object') return { value: undefined, error: null }
    return { value: (parsed as Record<string, unknown>)[key], error: null }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { value: undefined, error: null }
    return { value: undefined, error: `Could not read ${path}: ${String(err)}` }
  }
}

/** One locked pass. Returns null on success, or why it could not be done. */
function writeOnce(path: string, key: string, value: unknown): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripBom(readFileSync(path, 'utf8')))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      /*
       * Never create it. `proper-lockfile` realpaths its target, so the CLI
       * cannot even lock a file that does not exist — and a config Stoke
       * invented would have no `oauthAccount`, which is the state the guard
       * above exists to keep off disk.
       */
      return 'Claude Code’s global config does not exist yet. Start a session first.'
    }
    return `Claude Code’s global config could not be read or parsed (${String(err)}). Stoke will not overwrite it.`
  }

  const refusal = refuseToWrite(parsed)
  if (refusal) return refusal

  const cfg = parsed as Record<string, unknown>
  if (value === undefined) {
    if (!(key in cfg)) return null
    delete cfg[key]
  } else {
    if (cfg[key] === value) return null
    cfg[key] = value
  }

  // No trailing newline: that is what the CLI emits for this file, and matching
  // it keeps Stoke's writes from showing up as a whole-file diff.
  writeJsonAtomic(path, JSON.stringify(cfg, null, 2))
  return null
}

/**
 * Set or clear one key in the global config, durably.
 *
 * Locked, brief, then verified — see the header for why all three are needed.
 */
export async function writeGlobalConfigKey(key: string, value: unknown): Promise<GlobalConfigWrite> {
  const path = claudeGlobalConfigPath(process.env, homedir())
  const lock = claudeGlobalConfigLockPath(process.env, homedir())
  let wroteUnlocked = false
  let lastError: string | null = null

  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const locked = await acquire(lock)
    if (!locked) wroteUnlocked = true

    // Only meaningful if a write somehow runs long; the hold is milliseconds in
    // practice. Unref'd so it can never keep the process alive on its own.
    const refresh = locked
      ? setInterval(() => {
          const now = new Date()
          try {
            utimesSync(lock, now, now)
          } catch {
            // The lock was stolen as stale. The verify pass below is what
            // actually decides whether this write survived.
          }
        }, REFRESH_MS)
      : null
    refresh?.unref?.()

    try {
      lastError = writeOnce(path, key, value)
    } catch (err) {
      lastError = `Could not write Claude Code’s global config: ${String(err)}`
    } finally {
      if (refresh) clearInterval(refresh)
      if (locked) release(lock)
    }

    // A refusal is a decision, not a transient failure. Retrying it would just
    // read the same broken file three more times.
    if (lastError) return { ok: false, error: lastError, wroteUnlocked, attempts: attempt }

    await sleep(SETTLE_MS)
    const check = readGlobalConfigKey(key)
    if (check.error) return { ok: false, error: check.error, wroteUnlocked, attempts: attempt }
    if (check.value === value) return { ok: true, error: null, wroteUnlocked, attempts: attempt }

    /*
     * The write was lost — a session's own read-modify-write straddled ours.
     * That is the measured race, and the answer to it is simply to go again:
     * the window is milliseconds wide inside a file written a few times a
     * minute, so a second pass almost always lands.
     */
    lastError = 'A Claude Code session overwrote the change.'
  }

  return { ok: false, error: lastError, wroteUnlocked, attempts: ATTEMPTS }
}
