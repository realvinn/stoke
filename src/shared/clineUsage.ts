/*
 * The Cline account's credit balance, the way Cline's own CLI reads it.
 *
 * Read out of Cline's open-source code on 2026-09-30 (github.com/cline/cline
 * at 3435f72), never guessed:
 *
 *   where   `$CLINE_PROVIDER_SETTINGS_PATH`, else `<CLINE_DATA_DIR or
 *           <CLINE_DIR or ~/.cline>/data>/settings/providers.json`
 *           (sdk/packages/shared/src/storage/paths.ts). Plain JSON, 0600; the
 *           sign-in is `providers.cline.settings.auth` {accessToken,
 *           refreshToken, expiresAt (ms), accountId}.
 *   bearer  the stored accessToken with `workos:` in front unless it already
 *           has it, case-insensitively (`formatClineApiKey`,
 *           sdk/packages/core/src/auth/provider-auth-registry.ts).
 *   expiry  `auth.expiresAt`, else the JWT's `exp`, else UNKNOWN — which Cline
 *           treats as expired and refreshes. Stoke never refreshes (only the
 *           agent may; gotcha 36's rule), so an expired or undated token is
 *           not sent anywhere: the reading says to open Cline.
 *   call    `GET https://api.cline.bot/api/v1/users/{id}/balance`
 *           (ClineAccountService.fetchBalance), answered `{success, data}` or
 *           bare, data `{balance, userId}`. `id` is the user id; the stored
 *           `auth.accountId` is that id (on this machine it equals
 *           `userInfo.clineUserId`, a `usr-…`).
 *   unit    MICRO-dollars: the CLI prints `$` + balance / 1_000_000, two
 *           decimals, en-US (`normalizeCreditBalance`, `formatCreditBalance`,
 *           apps/cli/src/utils/output.ts; its test: 500_000 → "$0.50"). A
 *           third-party monitor that divided by 100 is exactly the wrong
 *           number this file exists to not show.
 *
 * What Cline does NOT state: any free-model or ClinePass allowance. Its core
 * learns those only from an error's text ("free limit reached on model"), so
 * there is no number to show and none is shown.
 *
 * The balance shown is the PERSONAL one. Cline's CLI shows the active
 * organization's balance instead when an organization is active (it asks
 * `/users/me` first); Stoke asks only for the user's own, and says so.
 *
 * Only api.cline.bot is ever called. A Cline pointed elsewhere (a `baseUrl`
 * in its settings, `CLINE_API_BASE_URL`, a non-production
 * `CLINE_ENVIRONMENT`) gets no reading rather than its token sent to a server
 * Stoke did not choose.
 *
 * Pure, and compiled by both tsconfigs (gotcha 27). The token passes through
 * here in memory only; nothing here logs, stores or returns it past `bearer`.
 */
import type { UsageSnapshot } from './types'

export const CLINE_API_BASE = 'https://api.cline.bot'

export function clineBalanceUrl(userId: string): string {
  return `${CLINE_API_BASE}/api/v1/users/${encodeURIComponent(userId)}/balance`
}

/** `CLINE_PROVIDER_SETTINGS_PATH`, else `<data dir>/settings/providers.json` (paths.ts). */
export function clineProvidersPath(env: Record<string, string | undefined>, userHome: string, join: (...p: string[]) => string): string {
  const explicit = env.CLINE_PROVIDER_SETTINGS_PATH?.trim()
  if (explicit) return explicit
  const dataDir = env.CLINE_DATA_DIR?.trim() || join(env.CLINE_DIR?.trim() || join(userHome, '.cline'), 'data')
  return join(dataDir, 'settings', 'providers.json')
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const WORKOS = 'workos:'

/** `formatClineApiKey`: the token as Cline sends it. */
export function clineBearer(accessToken: string): string {
  const t = accessToken.trim()
  return t.toLowerCase().startsWith(WORKOS) ? t : `${WORKOS}${t}`
}

/** The JWT's `exp` in ms, or null. The `workos:` prefix is not part of the JWT. */
export function jwtExpiryMs(accessToken: string): number | null {
  let t = accessToken.trim()
  if (t.toLowerCase().startsWith(WORKOS)) t = t.slice(WORKOS.length)
  const part = t.split('.')[1]
  if (!part) return null
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/')
    const json = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))) as { exp?: unknown }
    return typeof json.exp === 'number' && Number.isFinite(json.exp) && json.exp > 0 ? json.exp * 1000 : null
  } catch {
    return null
  }
}

export type ClineAuthVerdict =
  | { ok: true; bearer: string; userId: string }
  | { ok: false; kind: 'signed-out' | 'expired' | 'elsewhere'; message: string }

/** Cline's user ids are `usr-…`; anything that is not a plain id is not one. */
const USER_ID = /^[A-Za-z0-9_-]{1,100}$/

/**
 * Whether a providers.json (already parsed) holds a sign-in Stoke may use
 * right now, and if so the header and the id. `env` is the environment the
 * Cline account's process sees, for the server overrides.
 */
export function clineAuthFrom(providers: unknown, env: Record<string, string | undefined>, now: number): ClineAuthVerdict {
  const settings = isRecord(providers) && isRecord(providers.providers) && isRecord(providers.providers.cline)
    ? providers.providers.cline.settings
    : null
  const auth = isRecord(settings) && isRecord(settings.auth) ? settings.auth : null
  const token = auth && typeof auth.accessToken === 'string' ? auth.accessToken.trim() : ''
  const userId = auth && typeof auth.accountId === 'string' ? auth.accountId.trim() : ''
  if (!token || !USER_ID.test(userId)) {
    return { ok: false, kind: 'signed-out', message: 'Cline is not signed in to a Cline account.' }
  }
  const baseUrl = isRecord(settings) && typeof settings.baseUrl === 'string' ? settings.baseUrl.trim().replace(/\/+$/, '') : ''
  const envBase = env.CLINE_API_BASE_URL?.trim().replace(/\/+$/, '') ?? ''
  const environment = (env.CLINE_ENVIRONMENT_OVERRIDE?.trim() || env.CLINE_ENVIRONMENT?.trim() || 'production').toLowerCase()
  if ((baseUrl && baseUrl !== CLINE_API_BASE) || (envBase && envBase !== CLINE_API_BASE) || environment !== 'production') {
    return {
      ok: false,
      kind: 'elsewhere',
      message: 'Cline is set to another server, so Stoke does not read its balance. It reads only api.cline.bot.'
    }
  }
  const stated = typeof auth?.expiresAt === 'number' && Number.isFinite(auth.expiresAt) && auth.expiresAt > 0 ? auth.expiresAt : null
  const expiresAt = stated ?? jwtExpiryMs(token)
  if (expiresAt === null || expiresAt <= now) {
    return {
      ok: false,
      kind: 'expired',
      message: 'Cline’s sign-in has expired. Open Cline to refresh it; Stoke never refreshes another app’s sign-in.'
    }
  }
  return { ok: true, bearer: clineBearer(token), userId }
}

/** Cline's balance unit to dollars: micro-dollars, as its CLI divides them. Null when not a number. */
export function clineBalanceUsd(micro: unknown): number | null {
  return typeof micro === 'number' && Number.isFinite(micro) ? micro / 1_000_000 : null
}

const BALANCE_TITLE =
  'Your personal Cline credits, as the Cline CLI shows them. An organization’s credits are not read. Cline states no free-model allowance, so none is shown.'

/** The reading for one HTTP answer from the balance endpoint. */
export function clineBalanceResponse(status: number, body: unknown, now: number, retryAfterSeconds?: number | null): UsageSnapshot {
  const snap: UsageSnapshot = { source: 'cline', windows: [], extraCredits: null, fetchedAt: now, error: null }
  if (status === 401 || status === 403) {
    snap.error = 'Cline refused its stored sign-in. Open Cline to sign in again.'
    return snap
  }
  if (status < 200 || status >= 300) {
    snap.error = `Cline balance unavailable (${status}).`
    if ((status === 429 || status >= 500) && retryAfterSeconds && retryAfterSeconds > 0) snap.retryAfter = retryAfterSeconds * 1000
    return snap
  }
  // `{success, data}` when enveloped, the bare payload otherwise (`request<T>`).
  let data: unknown = body
  if (isRecord(body) && typeof body.success === 'boolean') {
    if (!body.success) {
      snap.error = 'Cline answered that the balance request failed.'
      return snap
    }
    data = body.data
  }
  const amount = isRecord(data) ? clineBalanceUsd(data.balance) : null
  if (amount === null) {
    snap.error = 'Cline answered without a balance.'
    return snap
  }
  snap.balances = [{ label: 'Credits', amount, unit: 'usd', title: BALANCE_TITLE }]
  return snap
}
