/*
 * The OpenRouter key's usage: `GET https://openrouter.ai/api/v1/key`.
 *
 * Unlike every other source here this one is DOCUMENTED — OpenRouter's API
 * reference, "Get current API key", checked 2026-09-30 — and answers to the
 * ordinary key, where `/api/v1/credits` needs a management key (a stored key
 * gets 403). Its `data`:
 *
 *   usage, usage_daily, usage_weekly, usage_monthly   USD; the day, week
 *                                                      (Mon-Sun) and month
 *                                                      are UTC
 *   limit, limit_remaining                            USD, each `| null`
 *                                                      (null: no limit)
 *   limit_reset                                       "Type of limit reset", `| null`
 *   is_free_tier                                      never bought credits
 *   free_model_daily_requests {used, limit, remaining}
 *       "Free-model requests the account may make per UTC day" — the one
 *       honest "free usage" number any source here states.
 *   label                                             NOT shown: OpenRouter
 *                                                      labels a key with part
 *                                                      of the key itself.
 *
 * The key is Settings › Providers' one OpenRouter key, which every agent
 * pointed at OpenRouter shares, so this is ONE reading per key — "shared by
 * N agents" — never one per agent.
 *
 * Pure, compiled by both tsconfigs (gotcha 27); the fetch is main's
 * (main/usageVendors.ts), so a suite can hand this any body and any status.
 */
import type { UsageBalance, UsageSnapshot, UsageWindow } from './types'

export const OPENROUTER_KEY_URL = 'https://openrouter.ai/api/v1/key'

const DAY_MS = 86_400_000

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function usd(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function clampPercent(p: number): number {
  return Math.round(Math.max(0, Math.min(100, p)))
}

/** Midnight UTC after `now`: when a "per UTC day" allowance comes back. */
export function nextUtcMidnight(now: number): number {
  return Math.floor(now / DAY_MS) * DAY_MS + DAY_MS
}

/**
 * The reading one answer from `/api/v1/key` makes.
 *
 * A figure the body does not state stays out: no key-limit window without
 * both `limit` and `limit_remaining`, no free-model window without a positive
 * daily `limit` and a `used`, no balance row for a missing amount.
 */
export function parseOpenRouterKey(body: unknown, now: number): UsageSnapshot {
  const base = { source: 'openrouter' as const, extraCredits: null, fetchedAt: now }
  const data = isRecord(body) && isRecord(body.data) ? body.data : null
  if (!data) return { ...base, windows: [], error: 'OpenRouter answered without the key’s details.' }

  const windows: UsageWindow[] = []
  const limit = usd(data.limit)
  const left = usd(data.limit_remaining)
  const resetRule = typeof data.limit_reset === 'string' && /^[a-z_ -]{1,20}$/i.test(data.limit_reset) ? data.limit_reset : null
  if (limit !== null && limit > 0 && left !== null) {
    windows.push({
      kind: 'other',
      label: 'Key limit',
      short: 'key',
      percent: clampPercent(((limit - left) / limit) * 100),
      severity: 'normal',
      resetsAt: null,
      // The reset is stated as a rule, not an instant, and whether it runs on
      // the same UTC calendar as `usage_daily` is not documented — so it is
      // said, not computed.
      resetNote: resetRule ? `resets ${resetRule}` : 'does not reset',
      elapsed: null,
      active: true
    })
  }

  const free = isRecord(data.free_model_daily_requests) ? data.free_model_daily_requests : null
  const freeLimit = free ? usd(free.limit) : null
  const freeUsed = free ? usd(free.used) : null
  if (freeLimit !== null && freeLimit > 0 && freeUsed !== null && freeUsed >= 0) {
    const resetsAt = nextUtcMidnight(now)
    windows.push({
      kind: 'other',
      // Short enough for the panel's label column; the reset says which day.
      label: 'Free models',
      short: 'free',
      percent: clampPercent((freeUsed / freeLimit) * 100),
      severity: 'normal',
      resetsAt,
      elapsed: Math.max(0, Math.min(1, (now - (resetsAt - DAY_MS)) / DAY_MS)),
      active: true
    })
  }

  const balances: UsageBalance[] = []
  if (limit === null && 'limit' in data) {
    balances.push({ label: 'Key limit', amount: null, unit: 'usd', text: 'no limit', title: 'This key has no spending limit of its own.' })
  } else if (left !== null) {
    balances.push({ label: 'Key limit left', amount: left, unit: 'usd' })
  }
  const today = usd(data.usage_daily)
  if (today !== null) balances.push({ label: 'Used today', amount: today, unit: 'usd', title: 'This key’s OpenRouter spend in the current UTC day.' })
  const month = usd(data.usage_monthly)
  if (month !== null) balances.push({ label: 'This month', amount: month, unit: 'usd', title: 'This key’s OpenRouter spend in the current UTC month.' })
  if (free && freeLimit !== null && freeLimit > 0) {
    const remaining = usd(free.remaining)
    if (remaining !== null) {
      balances.push({
        label: 'Free requests left',
        amount: null,
        unit: 'usd',
        text: `${Math.max(0, Math.round(remaining))} of ${Math.round(freeLimit)}`,
        title: 'Free-model requests left today (UTC). The ceiling depends on the credits ever bought on the account.'
      })
    }
  }

  return {
    ...base,
    windows,
    balances,
    plan: data.is_free_tier === true ? 'free tier' : null,
    error: null
  }
}

/**
 * The reading for one HTTP answer, whatever it was. `retryAfterSeconds` is the
 * `Retry-After` header as sent; only a 429 or a 5xx carries it on, as the
 * Anthropic reader does, and `nextBackoff` decides the rest.
 */
export function openRouterResponse(status: number, body: unknown, now: number, retryAfterSeconds?: number | null): UsageSnapshot {
  if (status >= 200 && status < 300) return parseOpenRouterKey(body, now)
  const snap: UsageSnapshot = { source: 'openrouter', windows: [], extraCredits: null, fetchedAt: now, error: null }
  if (status === 401 || status === 403) {
    snap.error = 'OpenRouter refused the key in Settings › Providers.'
    return snap
  }
  snap.error = `OpenRouter usage unavailable (${status}).`
  if ((status === 429 || status >= 500) && retryAfterSeconds && retryAfterSeconds > 0) snap.retryAfter = retryAfterSeconds * 1000
  return snap
}
