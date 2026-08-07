import { readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type {
  StatusLinePayload,
  StatusLineRateLimit,
  StatusLineSnapshot,
  StatusLineWindowReading
} from '@shared/types'

/**
 * Stoke's own `statusLine` command, and the payload it captures.
 *
 * The CLI pipes a JSON object to the configured statusLine command on stdin
 * and prints whatever that command writes to stdout. That is the only channel
 * that states the context window before a single token is spent — the
 * transcript never records the tier, and the startup banner stopped saying it
 * in 2.1.221 (see CLAUDE.md gotcha 2). It is also the only source of the
 * plan's rate limits that works on macOS, where the OAuth token is in the
 * Keychain rather than in ~/.claude/.credentials.json.
 *
 * Transport is one file per session under the system temp directory, written
 * temp+rename so a reader never sees half a payload. Not a unix socket: there
 * is no Windows equivalent a shell command can reach as simply. Not an HTTP
 * POST: curl.exe only exists from Windows 10 1803, and a pass-through would
 * have to tee stdin. Not a pure shell wrapper: `more` paginates and re-wraps
 * and `findstr` truncates past ~8KB, and both do it silently.
 *
 * Nothing here writes to the user's own ~/.claude/settings.json. It is read,
 * once, so the line it configures can be passed through.
 */

const WINDOW_MIN = 1_000
const WINDOW_MAX = 10_000_000

export function statusLineDir(): string {
  return join(tmpdir(), 'stoke', 'statusline')
}

/**
 * A session id is normally a uuid we minted, but `--session-id` can be handed
 * anything, so it is reduced to something safely joinable before it ever
 * becomes part of a path.
 */
function key(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
}

export function statusLinePayloadFile(sessionId: string): string {
  return join(statusLineDir(), `${key(sessionId)}.json`)
}

function windowSize(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  const n = Math.round(v)
  // Bounded for the same reason windowFromBanner is: a nonsense value large
  // enough to read 0% forever would hide a real overflow.
  return n >= WINDOW_MIN && n <= WINDOW_MAX ? n : null
}

function percent(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.max(0, Math.min(100, v))
}

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/**
 * `resets_at` is epoch SECONDS in this payload and epoch milliseconds
 * everywhere else in Stoke. This function is the only place the two meet.
 */
function reading(raw: StatusLineRateLimit | undefined): StatusLineWindowReading | null {
  const pct = percent(raw?.used_percentage)
  if (pct === null) return null
  const secs = raw?.resets_at
  const resetsAt =
    typeof secs === 'number' && Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null
  return { percent: pct, resetsAt }
}

/**
 * The wire payload as the rest of the app wants it: flat, camelCase, and in
 * milliseconds, so no component ever meets the snake_case shape or the
 * seconds/ms boundary.
 *
 * `key` is what the payload file is named after, which is the session id for
 * every session Stoke mints an id for. A `--continue` session's id is chosen
 * by the CLI *after* launch, so its files are named after a launch key
 * instead — and `session_id` in the payload is then the only place the real id
 * appears at all. So the payload's own statement wins, and the key is the
 * fallback. (Contracts §0.2 names this parameter `sessionId`; the name is the
 * only thing that changes, and it changes because it is no longer always one.)
 */
export function toSnapshot(
  key: string,
  payload: StatusLinePayload,
  receivedAt: number
): StatusLineSnapshot {
  const cw = payload.context_window
  return {
    sessionId: text(payload.session_id) ?? key,
    contextWindowSize: windowSize(cw?.context_window_size),
    usedPercentage: percent(cw?.used_percentage),
    modelId: text(payload.model?.id),
    modelName: text(payload.model?.display_name),
    exceeds200k: payload.exceeds_200k_tokens === true,
    fiveHour: reading(payload.rate_limits?.five_hour),
    sevenDay: reading(payload.rate_limits?.seven_day),
    receivedAt
  }
}

/**
 * The last payload this session's wrapper wrote, or null.
 *
 * Null covers every failure the same way on purpose — no file yet, a CLI too
 * old to run a statusLine command, a half-written file, a temp sweeper that
 * deleted it. Every caller has a fallback, and a throw here would take the
 * context meter down with it.
 */
export function readStatusLine(sessionId: string): StatusLineSnapshot | null {
  if (!sessionId) return null
  try {
    const file = statusLinePayloadFile(sessionId)
    const raw = readFileSync(file, 'utf8')
    const at = statSync(file).mtimeMs
    const payload = JSON.parse(raw) as unknown
    if (!payload || typeof payload !== 'object') return null
    return toSnapshot(sessionId, payload as StatusLinePayload, at)
  } catch {
    return null
  }
}
