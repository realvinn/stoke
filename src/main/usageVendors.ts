/*
 * The network readers besides Anthropic's (usage.ts): the OpenRouter key,
 * Kimi Code's plan usage and the Cline account balance. Each is one
 * read-only GET; everything about what the answer means is in the pure halves
 * (shared/openRouterUsage.ts, kimiUsage.ts, clineUsage.ts), which
 * `verify:usage` holds against fixtures.
 *
 * None ever logs, stores or returns a key or a token: an error names the
 * status, never the request. Kimi's and Cline's tokens are read from the
 * agent's own file for this one call and dropped, exactly as Stoke reads
 * Claude Code's token for its own plan limits (gotcha 36) — and, like that
 * one, never refreshed.
 *
 * No electron import, so a suite can load this module; nothing here runs
 * unless called.
 */
import { readFile } from 'node:fs/promises'
import { clineAuthFrom, clineBalanceResponse, clineBalanceUrl } from '../shared/clineUsage.ts'
import { KIMI_USAGE_URL, kimiAuthFrom, kimiUsageResponse } from '../shared/kimiUsage.ts'
import { OPENROUTER_KEY_URL, openRouterResponse } from '../shared/openRouterUsage.ts'
import type { UsageSnapshot } from '../shared/types.ts'

const TIMEOUT_MS = 15_000

function retryAfterOf(res: Response): number | null {
  const n = Number(res.headers.get('retry-after'))
  return Number.isFinite(n) && n > 0 ? n : null
}

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text().catch(() => '')
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function failed(source: UsageSnapshot['source'], now: number, err: unknown, what: string): UsageSnapshot {
  // The message is the transport's own (a timeout, a DNS failure) — never
  // anything carrying the request, which is where a key would be.
  const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'could not be reached'
  return { source, windows: [], extraCredits: null, fetchedAt: now, error: `${what} ${reason}.` }
}

/** The OpenRouter key in Settings › Agents › Claude Code › Provider & keys: what it has spent and what is left. */
export async function fetchOpenRouterUsage(key: string, now = Date.now()): Promise<UsageSnapshot> {
  if (!key) return { source: 'openrouter', windows: [], extraCredits: null, fetchedAt: now, error: 'No OpenRouter key in Settings › Agents › Claude Code › Provider & keys.' }
  try {
    const res = await fetch(OPENROUTER_KEY_URL, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    return openRouterResponse(res.status, await bodyOf(res), now, retryAfterOf(res))
  } catch (err) {
    return failed('openrouter', now, err, 'OpenRouter')
  }
}

/**
 * The balance of the Cline account a Cline home is signed in to.
 *
 * @param providersPath that home's providers.json (`clineProvidersPath`)
 * @param env           the environment its Cline sees, for the server overrides
 */
export async function fetchClineUsage(providersPath: string, env: Record<string, string | undefined>, now = Date.now()): Promise<UsageSnapshot> {
  const base = { source: 'cline' as const, windows: [], extraCredits: null, fetchedAt: now }
  const raw = await readFile(providersPath, 'utf8').catch(() => null)
  if (raw === null) return { ...base, error: null, note: 'Cline has not been signed in on this account.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...base, error: 'Cline’s providers.json could not be read.' }
  }
  const auth = clineAuthFrom(parsed, env, now)
  if (!auth.ok) {
    // Signed out is a fact, not a failure worth backing off from.
    return auth.kind === 'signed-out' ? { ...base, error: null, note: auth.message } : { ...base, error: auth.message }
  }
  try {
    const res = await fetch(clineBalanceUrl(auth.userId), {
      headers: { authorization: `Bearer ${auth.bearer}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    return clineBalanceResponse(res.status, await bodyOf(res), now, retryAfterOf(res))
  } catch (err) {
    return failed('cline', now, err, 'Cline')
  }
}

/**
 * Kimi Code's plan usage, with the token its own sign-in left in that home.
 *
 * @param credentialsPath that home's `credentials/kimi-code.json` (`kimiCredentialsPath`)
 * @param env             the environment its Kimi sees, for the server overrides
 */
export async function fetchKimiUsage(credentialsPath: string, env: Record<string, string | undefined>, now = Date.now()): Promise<UsageSnapshot> {
  const base = { source: 'kimi' as const, windows: [], extraCredits: null, fetchedAt: now }
  const raw = await readFile(credentialsPath, 'utf8').catch(() => null)
  if (raw === null) return { ...base, error: null, note: 'Kimi Code has not been signed in on this account.' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { ...base, error: 'Kimi Code\u2019s credentials file could not be read.' }
  }
  const auth = kimiAuthFrom(parsed, env, now)
  if (!auth.ok) return auth.kind === 'signed-out' ? { ...base, error: null, note: auth.message } : { ...base, error: auth.message }
  try {
    const res = await fetch(KIMI_USAGE_URL, {
      headers: { authorization: `Bearer ${auth.bearer}`, accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    return kimiUsageResponse(res.status, await bodyOf(res), now, retryAfterOf(res))
  } catch (err) {
    return failed('kimi', now, err, 'Kimi Code')
  }
}
