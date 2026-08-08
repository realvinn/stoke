import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AutoScanSnapshot, StoredActivity } from './autoscan.ts'

/**
 * Where the auto-scanner's baselines live between runs.
 *
 * Separate from autoscan.ts so that module keeps importing nothing at all and
 * scripts/verify-worklog-autoscan.mts can exercise every rule against a clock
 * it controls. The userData directory is passed in rather than read from
 * electron's `app`, exactly as the queue does — importing electron would stop
 * this loading under plain node and take the tests with it.
 *
 * Everything read from this file is repaired or dropped. It is a cache: a
 * corrupt one must cost at most one re-baselined session, never a launch.
 */

export const AUTOSCAN_STATE_FILENAME = 'worklog-autoscan.json'

export function autoScanStateFile(userDataDir: string): string {
  return join(userDataDir, AUTOSCAN_STATE_FILENAME)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function activity(v: unknown): StoredActivity | null {
  if (!isRecord(v)) return null
  const sessionId = typeof v.sessionId === 'string' ? v.sessionId : ''
  const scannedMessages = num(v.scannedMessages)
  // A record with no session id addresses nothing, and one with no baseline is
  // the very thing this file exists to carry. Either way it is not a record.
  if (!sessionId || scannedMessages === null) return null
  return {
    sessionId,
    scannedMessages,
    lastScanAt: num(v.lastScanAt) ?? 0,
    mutedUntil: num(v.mutedUntil) ?? 0
  }
}

/** Never throws. A state file that cannot be read is an empty state. */
export function readAutoScanState(file: string): AutoScanSnapshot {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (!isRecord(raw)) return { sessions: [], recentScans: [] }
    const sessions = Array.isArray(raw.sessions)
      ? raw.sessions.map(activity).filter((s): s is StoredActivity => s !== null)
      : []
    const recentScans = Array.isArray(raw.recentScans)
      ? raw.recentScans.filter((t): t is number => typeof t === 'number' && Number.isFinite(t))
      : []
    return { sessions, recentScans }
  } catch {
    // Missing (the normal first run) or corrupt. Both mean there is nothing to
    // restore, and refusing to start would take the app down over a cache.
    return { sessions: [], recentScans: [] }
  }
}

/** Temp file + rename, so a crash mid-write cannot truncate the state. */
export function writeAutoScanState(file: string, snapshot: AutoScanSnapshot): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(snapshot, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.error('[stoke] failed to persist the autoscan state', err)
  }
}
