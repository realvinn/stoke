/*
 * Kimi Code's plan usage, the way its own `/usage` reads it.
 *
 * Read out of the package its installer ships (`@moonshot-ai/kimi-code`
 * 2.1.1, `dist/main.mjs`, downloaded and read on 2026-09-30, never run):
 *
 *   token   `<KIMI_CODE_HOME or ~/.kimi-code>/credentials/kimi-code.json`
 *           (`FileTokenStorage`, the `oauth/kimi-code` key's slot), plain
 *           JSON, snake_case: {access_token, refresh_token, expires_at (epoch
 *           SECONDS: `Math.floor(Date.now() / 1e3) + expiresIn`), scope,
 *           token_type, expires_in}. An empty access_token is a revoked one.
 *   slot    only for the default OAuth host and base URL; a
 *           KIMI_CODE_OAUTH_HOST / KIMI_OAUTH_HOST / KIMI_CODE_BASE_URL
 *           override puts the token in a hashed `kimi-code-env-…` slot and
 *           the calls elsewhere — Stoke reads none of that (`elsewhere`).
 *   expiry  Kimi refreshes when `expires_at` is near; `expires_at` 0 is
 *           never refreshed (`shouldRefreshToken`). Stoke never refreshes
 *           another app's sign-in, so a token already past `expires_at` is
 *           not sent; one with no expiry is sent as Kimi itself would.
 *   call    `GET https://api.kimi.com/coding/v1/usages`,
 *           `Authorization: Bearer <access_token>` (`fetchManagedUsage`).
 *   answer  {usages: {limit_5h, limit_7d, limit_month_total,
 *           limit_month_code: {used_ratio, reset_time}}, boosterWallet}.
 *           `used_ratio` is 0-1 and its `/usage` prints round(ratio × 100)%
 *           used; `reset_time` is a string it hands to `Date.parse`. Rows
 *           "5h limit", "Weekly limit", "Monthly limit" (month_code is only a
 *           breakdown of the month). A window it omits is skipped — unknown,
 *           never 0%.
 *
 * The booster wallet (paid extra, in fixed-point cents and possibly CNY) is
 * not shown: its currency is not always dollars and nothing here draws
 * another. Unverified live: Kimi Code is not installed on the machine this
 * was written on, so only the vendor's code and fixtures stand behind it.
 *
 * Pure, compiled by both tsconfigs (gotcha 27).
 */
import type { UsageSnapshot, UsageWindow } from './types'

export const KIMI_USAGE_URL = 'https://api.kimi.com/coding/v1/usages'

/** `<KIMI_CODE_HOME or ~/.kimi-code>/credentials/kimi-code.json`. */
export function kimiCredentialsPath(env: Record<string, string | undefined>, userHome: string, join: (...p: string[]) => string): string {
  const home = env.KIMI_CODE_HOME && env.KIMI_CODE_HOME.length > 0 ? env.KIMI_CODE_HOME : join(userHome, '.kimi-code')
  return join(home, 'credentials', 'kimi-code.json')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

export type KimiAuthVerdict =
  | { ok: true; bearer: string }
  | { ok: false; kind: 'signed-out' | 'expired' | 'elsewhere'; message: string }

export function kimiAuthFrom(token: unknown, env: Record<string, string | undefined>, now: number): KimiAuthVerdict {
  if (env.KIMI_CODE_OAUTH_HOST || env.KIMI_OAUTH_HOST || env.KIMI_CODE_BASE_URL) {
    return { ok: false, kind: 'elsewhere', message: 'Kimi Code is set to another server, so Stoke does not read its usage.' }
  }
  const access = isRecord(token) && typeof token.access_token === 'string' ? token.access_token.trim() : ''
  if (!access) return { ok: false, kind: 'signed-out', message: 'Kimi Code is not signed in.' }
  const exp = isRecord(token) && typeof token.expires_at === 'number' && Number.isFinite(token.expires_at) ? token.expires_at : 0
  if (exp > 0 && exp * 1000 <= now) {
    return {
      ok: false,
      kind: 'expired',
      message: 'Kimi Code’s sign-in has expired. Open Kimi Code to refresh it; Stoke never refreshes another app’s sign-in.'
    }
  }
  return { ok: true, bearer: access }
}

const WINDOWS: readonly { key: string; kind: UsageWindow['kind']; label: string; short: string; ms: number | null }[] = [
  { key: 'limit_5h', kind: 'session', label: '5 hours', short: '5h', ms: 5 * 3_600_000 },
  { key: 'limit_7d', kind: 'weekly', label: 'Weekly', short: 'week', ms: 7 * 86_400_000 },
  // A calendar month has no fixed length, so no pace marker is placed on it.
  { key: 'limit_month_total', kind: 'other', label: 'Monthly', short: 'month', ms: null }
]

/** The reading one answer from `/usages` makes. */
export function parseKimiUsages(body: unknown, now: number): UsageSnapshot {
  const snap: UsageSnapshot = { source: 'kimi', windows: [], extraCredits: null, fetchedAt: now, error: null }
  const usages = isRecord(body) && isRecord(body.usages) ? body.usages : null
  if (!usages) {
    snap.error = 'Kimi Code answered without its usage.'
    return snap
  }
  for (const w of WINDOWS) {
    const e = usages[w.key]
    if (!isRecord(e)) continue
    const raw = typeof e.used_ratio === 'number' ? e.used_ratio : typeof e.used_ratio === 'string' ? Number(e.used_ratio) : NaN
    if (!Number.isFinite(raw)) continue
    const parsed = typeof e.reset_time === 'string' && e.reset_time ? Date.parse(e.reset_time) : NaN
    const resetsAt = Number.isFinite(parsed) ? parsed : null
    snap.windows.push({
      kind: w.kind,
      label: w.label,
      short: w.short,
      percent: Math.round(Math.max(0, Math.min(1, raw)) * 100),
      severity: 'normal',
      resetsAt,
      elapsed: resetsAt !== null && w.ms !== null ? Math.max(0, Math.min(1, (now - (resetsAt - w.ms)) / w.ms)) : null,
      active: true
    })
  }
  return snap
}

/** The reading for one HTTP answer, whatever it was. */
export function kimiUsageResponse(status: number, body: unknown, now: number, retryAfterSeconds?: number | null): UsageSnapshot {
  if (status >= 200 && status < 300) return parseKimiUsages(body, now)
  const snap: UsageSnapshot = { source: 'kimi', windows: [], extraCredits: null, fetchedAt: now, error: null }
  if (status === 401 || status === 403) snap.error = 'Kimi Code refused its stored sign-in. Open Kimi Code to sign in again.'
  else if (status === 404) snap.error = 'Kimi Code’s usage is not available for this plan.'
  else {
    snap.error = `Kimi Code usage unavailable (${status}).`
    if ((status === 429 || status >= 500) && retryAfterSeconds && retryAfterSeconds > 0) snap.retryAfter = retryAfterSeconds * 1000
  }
  return snap
}
