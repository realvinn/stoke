import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Which folder each session was started in, kept across a restart.
 *
 * `index.ts`'s `sessionCwds` map is how the worklog places a session at all —
 * `watchStates()` iterates its keys and `watchStateFor` reads its values — and
 * it lived only in memory. A restart with resumed tabs therefore made every
 * running session resolve to an empty cwd, so `reason` came back
 * 'unknown-folder', the tab dot vanished, and the panel said "No session is
 * open" about sessions that were still running (spec §2.4, closing note).
 *
 * Deliberately a sibling of autoscanStore.ts rather than part of it: one file
 * carries the scanner's spending state and this one carries an address book,
 * and a corrupt address book must not cost the hourly ceiling.
 *
 * Imports no electron, so scripts/verify-worklog-autoscan.mts exercises it.
 */

export const SESSION_STATE_FILENAME = 'worklog-sessions.json'

/**
 * How many sessions to carry forward.
 *
 * 200 keeps the JSON under about 20 KB on a machine with long paths, and it is
 * far more sessions than the auto-scanner's ceiling of six an hour can ever act
 * on. The cap exists so a long-lived install does not carry years of ids into a
 * list the panel renders one row per entry of.
 */
export const MAX_STORED_SESSIONS = 200

/**
 * How long a session stays worth remembering.
 *
 * Fourteen days is the longest gap over which resuming a session and still
 * calling it the worklog's business is plausible. Past that the transcript is
 * a different piece of work wearing the same id.
 */
export const STORED_SESSION_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

export interface StoredSession {
  sessionId: string
  /**
   * The session's own working directory.
   *
   * Always the *local* folder Stoke was pointed at (CLAUDE.md gotcha 18) —
   * `startHostSession` passes `defaultCwd || '.'` even for a host launch, so
   * this is never the remote directory. Harmless: `watchStateFrom` (watch.ts)
   * never consults `cwd` once `hostId` resolves to a real host — it decides
   * from `host.worklog` alone — so a stale local folder here cannot resurrect
   * the wrong project for a remote session, only go unread.
   */
  cwd: string
  /** `SshHost.id`, or null when the session is local. */
  hostId: string | null
  /** Epoch ms this record was last written. */
  at: number
}

export function sessionStateFile(userDataDir: string): string {
  return join(userDataDir, SESSION_STATE_FILENAME)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function session(v: unknown): StoredSession | null {
  if (!isRecord(v)) return null
  const sessionId = typeof v.sessionId === 'string' ? v.sessionId : ''
  const cwd = typeof v.cwd === 'string' ? v.cwd : ''
  // Both or nothing: a record with no id addresses no session, and one with no
  // folder is exactly the state this file exists to prevent.
  if (!sessionId || !cwd) return null
  return {
    sessionId,
    cwd,
    hostId: typeof v.hostId === 'string' && v.hostId ? v.hostId : null,
    at: typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0
  }
}

/**
 * Never throws. A file that cannot be read is an empty list.
 *
 * `now` is a parameter so the age rule is testable against a clock the suite
 * controls, the same way autoscan.ts takes its own.
 */
export function readSessionState(file: string, now = Date.now()): StoredSession[] {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    // Missing (the normal first run) or corrupt. Both mean nothing to restore.
    return []
  }
  if (!Array.isArray(raw)) return []
  return raw
    .map(session)
    .filter((s): s is StoredSession => s !== null && now - s.at < STORED_SESSION_MAX_AGE_MS)
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_STORED_SESSIONS)
}

/** Temp file + rename, matching store.ts, so a crash mid-write cannot truncate it. */
export function writeSessionState(file: string, sessions: StoredSession[]): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(sessions, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.error('[stoke] failed to persist the session folders', err)
  }
}
