import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { UsageSnapshot, UsageWindow } from '../shared/types'

export type { UsageSnapshot, UsageWindow }

/**
 * Plan limits: the 5-hour rolling window, the weekly window, and any
 * model-scoped weekly window (Fable has its own).
 *
 * There is no supported programmatic source for this. `/usage` is a slash
 * command with no headless equivalent, nothing under `~/.claude` records the
 * windows — `stats-cache.json` is daily token counts and `usage-data/` is
 * session telemetry — and the transcripts carry per-turn token usage but no
 * limit state at all. Every community monitor does what this does: read the
 * OAuth token Claude Code already stores and call the endpoint the CLI itself
 * calls. Verified against the live account before it was written.
 *
 * Being undocumented, the shape can change without warning. Everything here
 * tolerates missing fields and reports unavailability rather than guessing —
 * a wrong number in a status bar is worse than a blank one.
 */

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'

/** Window lengths, used to place the pace marker. `resets_at` gives only the end. */
const WINDOW_MS: Record<UsageWindow['kind'], number> = {
  session: 5 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
  weekly_scoped: 7 * 24 * 60 * 60 * 1000
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function stamp(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isNaN(t) ? null : t
}

/**
 * The token has moved between shapes across Claude Code versions, so search for
 * it rather than assuming a path. `sk-ant-oat` is the OAuth prefix.
 */
function findToken(node: unknown, depth = 0): string | null {
  if (!node || depth > 5) return null
  if (typeof node === 'string') return node.startsWith('sk-ant-oat') ? node : null
  if (typeof node !== 'object') return null
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (typeof value === 'string' && /access.?token/i.test(key) && value) return value
    const found = findToken(value, depth + 1)
    if (found) return found
  }
  return null
}

export async function readOauthToken(): Promise<string | null> {
  try {
    const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8')
    return findToken(JSON.parse(raw))
  } catch {
    return null
  }
}

function elapsedFraction(resetsAt: number | null, windowMs: number, now: number): number | null {
  if (resetsAt === null) return null
  const startedAt = resetsAt - windowMs
  const through = (now - startedAt) / windowMs
  return Math.max(0, Math.min(1, through))
}

interface RawLimit {
  kind?: unknown
  group?: unknown
  percent?: unknown
  severity?: unknown
  resets_at?: unknown
  is_active?: unknown
  scope?: { model?: { display_name?: unknown } | null } | null
}

export function parseUsage(body: unknown, now: number): UsageSnapshot {
  const root = (body ?? {}) as Record<string, unknown>
  const windows: UsageWindow[] = []

  /*
   * Prefer the `limits` array: it is the only place the model-scoped weekly
   * window appears, and it carries severity. The top-level `five_hour` and
   * `seven_day` objects are a summary of the same numbers.
   */
  const limits = Array.isArray(root.limits) ? (root.limits as RawLimit[]) : []

  for (const limit of limits) {
    const rawKind = String(limit.kind ?? '')
    const kind: UsageWindow['kind'] =
      rawKind === 'session' ? 'session' : rawKind === 'weekly_scoped' ? 'weekly_scoped' : 'weekly'

    const model = limit.scope?.model?.display_name
    const label =
      kind === 'session' ? '5 hours' : kind === 'weekly_scoped' ? String(model ?? 'Scoped') : 'Weekly'

    // A scoped window with no reset time has never been used; it still belongs
    // on screen, just without a countdown.
    const resetsAt = stamp(limit.resets_at)

    windows.push({
      kind,
      label,
      percent: Math.max(0, Math.min(100, num(limit.percent))),
      severity: String(limit.severity ?? 'normal'),
      resetsAt,
      elapsed: elapsedFraction(resetsAt, WINDOW_MS[kind], now),
      active: limit.is_active === true
    })
  }

  const extra = (root.extra_usage ?? null) as { is_enabled?: unknown; utilization?: unknown } | null

  return {
    windows,
    extraCredits: extra
      ? { percent: num(extra.utilization), enabled: extra.is_enabled === true }
      : null,
    fetchedAt: now,
    error: null
  }
}

export async function fetchUsage(now = Date.now()): Promise<UsageSnapshot> {
  const empty = (error: string): UsageSnapshot => ({
    windows: [],
    extraCredits: null,
    fetchedAt: now,
    error
  })

  const token = await readOauthToken()
  if (!token) return empty('Not signed in to Claude Code.')

  try {
    const res = await fetch(USAGE_URL, {
      headers: {
        authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
        accept: 'application/json'
      },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) {
      /*
       * 429 is the endpoint asking to be left alone, and it does happen - it
       * arrived during development after a run of repeated calls. Honour
       * Retry-After when it is sent, and otherwise back off far longer than the
       * normal poll, because continuing to knock on an undocumented endpoint
       * that has just said no is how access gets worse rather than better.
       */
      const snapshot = empty(`Usage unavailable (${res.status}).`)
      if (res.status === 429 || res.status >= 500) {
        const header = Number(res.headers.get('retry-after'))
        snapshot.retryAfter = Number.isFinite(header) && header > 0 ? header * 1000 : 15 * 60_000
      }
      return snapshot
    }
    return parseUsage(await res.json(), now)
  } catch (err) {
    return empty(err instanceof Error ? err.message : 'Usage request failed.')
  }
}
