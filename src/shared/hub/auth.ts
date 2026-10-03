/*
 * Signing in to a hub: who may have an account, what a password must be and
 * how it is stored, what a session token and an invite look like, and how
 * guessing is slowed down.
 *
 * Kept apart from encryption on purpose (spec §3): the password decides who
 * may SIGN IN, and no key is ever derived from it, so a reset on the NUC can
 * never open anyone's data. The hashing itself is scrypt in
 * `src/main/hub/crypto.ts`; this is the part with no crypto in it.
 *
 * Pure (gotcha 27).
 */
import { base32Decode, base32Encode, base32Length, groupsOf, isB64u, normalizeBase32 } from './codec.ts'

/* --------------------------------------------------------------- email */

export const MAX_EMAIL_CHARS = 254

/** The account key: trimmed and lower-cased, or null when it is not an email address at all. Never mailed. */
export function normalizeEmail(text: unknown): string | null {
  if (typeof text !== 'string') return null
  const e = text.trim().toLowerCase()
  if (e.length === 0 || e.length > MAX_EMAIL_CHARS) return null
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null
}

/* ------------------------------------------------------------ password */

export const MIN_PASSWORD_CHARS = 12
export const MAX_PASSWORD_CHARS = 1024

/** Why a new password is not acceptable, or null. Counted in code points. */
export function passwordProblem(p: unknown): string | null {
  if (typeof p !== 'string') return 'Enter a password.'
  const n = [...p].length
  if (n < MIN_PASSWORD_CHARS) return `At least ${MIN_PASSWORD_CHARS} characters. A few unrelated words are easier to remember.`
  if (n > MAX_PASSWORD_CHARS) return `At most ${MAX_PASSWORD_CHARS} characters.`
  if (p.trim() === '') return 'A password cannot be only spaces.'
  return null
}

/**
 * scrypt at N = 2^17, r = 8, p = 1 (OWASP's floor): 128 MiB per guess.
 * Measured on this Mac 2026-10-01: 263 ms under Node 26, 501 ms under
 * Electron 43's Node — the NUC will be in that range.
 */
export const PASSWORD_KDF = { log2N: 17, r: 8, p: 1, saltBytes: 16, keyBytes: 32, maxmem: 256 * 1024 * 1024 } as const

export interface PasswordHash {
  log2N: number
  r: number
  p: number
  /** b64url */
  salt: string
  /** b64url */
  hash: string
}

/** `scrypt$17$8$1$<salt>$<hash>`: the parameters travel with the hash, so they can rise later. */
export function formatPasswordHash(h: PasswordHash): string {
  return `scrypt$${h.log2N}$${h.r}$${h.p}$${h.salt}$${h.hash}`
}

/**
 * Parse a stored hash, or null. Bounds are checked here because a row is
 * data: a tampered `log2N` of 30 would ask for 128 GiB on the next login.
 */
export function parsePasswordHash(text: unknown): PasswordHash | null {
  if (typeof text !== 'string') return null
  const m = /^scrypt\$(\d{1,2})\$(\d{1,2})\$(\d)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/.exec(text)
  if (!m) return null
  const log2N = Number(m[1])
  const r = Number(m[2])
  const p = Number(m[3])
  if (log2N < 14 || log2N > 18 || r < 1 || r > 16 || p < 1 || p > 4) return null
  if (128 * 2 ** log2N * r > PASSWORD_KDF.maxmem) return null
  if (!isB64u(m[4], PASSWORD_KDF.saltBytes) || !isB64u(m[5], PASSWORD_KDF.keyBytes)) return null
  return { log2N, r, p, salt: m[4], hash: m[5] }
}

/** The one sentence both an unknown email and a wrong password get: no enumeration. */
export const LOGIN_REFUSED = 'That email and password do not match an account on this hub.'

/* ------------------------------------------------------------- tokens */

export const SESSION_PREFIX = 'sht_'
export const SESSION_TOKEN_BYTES = 32
/** Sliding: a session seen within this long stays valid. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60_000
/** A session's `seen_at` is written at most this often (every request would be a disk write). */
export const SESSION_TOUCH_MS = 24 * 60 * 60_000

export function isSessionToken(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith(SESSION_PREFIX) && isB64u(v.slice(SESSION_PREFIX.length), SESSION_TOKEN_BYTES)
}

/* ------------------------------------------------------------ invites */

export const INVITE_PREFIX = 'INV'
export const INVITE_BYTES = 15
/** The invite a fresh hub prints for its first account. */
export const BOOTSTRAP_INVITE_TTL_MS = 24 * 60 * 60_000
/** An invite an owner mints for somebody else. */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000

/** `INV-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX` from 15 random bytes (120 bits). */
export function formatInvite(random: Uint8Array): string {
  if (random.length !== INVITE_BYTES) throw new Error('an invite is 15 bytes')
  return `${INVITE_PREFIX}-${groupsOf(base32Encode(random), 4)}`
}

/**
 * The canonical form of a typed invite (what the hub hashes and looks up), or
 * null. Case, spaces, hyphens and look-alikes are forgiven.
 */
export function parseInvite(text: unknown): string | null {
  if (typeof text !== 'string') return null
  let t = normalizeBase32(text)
  /*
   * The prefix is stripped AFTER normalising, as normalising spells it: the I
   * of `INV` is read as 1 like any typed I, so `inv-…` arrives as `1NV…`.
   * Stripping first by the literal missed every lower-case invite.
   */
  const bare = base32Length(INVITE_BYTES)
  if (t.length === bare + INVITE_PREFIX.length && t.startsWith(normalizeBase32(INVITE_PREFIX))) t = t.slice(INVITE_PREFIX.length)
  const bytes = base32Decode(t, INVITE_BYTES)
  return bytes ? formatInvite(bytes) : null
}

/* ----------------------------------------------------------- throttle */

export interface ThrottleRule {
  windowMs: number
  maxFailures: number
  lockMs: number
  /** Repeat lockouts double up to this. */
  maxLockMs: number
}

/** Per normalised email, known or not. */
export const EMAIL_THROTTLE: ThrottleRule = {
  windowMs: 15 * 60_000,
  maxFailures: 5,
  lockMs: 15 * 60_000,
  maxLockMs: 24 * 60 * 60_000
}

/**
 * Per device, for a sign-in that PROVES it comes from a device the account's
 * chain lists as active (signed like any request, by the key the chain holds
 * for that id). Such an attempt is judged by this counter INSTEAD of the
 * email's: only the holder of the device's key can trip it, whereas anyone who
 * knows the address can trip the email's, and did lock the owner's own devices
 * out (found in review, 2026-10-01). The same numbers as the email's.
 */
export const DEVICE_THROTTLE: ThrottleRule = EMAIL_THROTTLE

/**
 * Per active device, for "confirm it's you" (`POST /v1/auth/verify`, spec
 * 2026-10-03 §2): a counter of its own, keyed by account AND device and never
 * shared with the sign-in counters above or the IP's, so wrong passwords typed
 * there can never lock anyone out of signing in. Only a session signed by a
 * device the chain lists by id and key can reach it (gotcha 140), so only that
 * device's key can trip it. The same numbers as sign-in: 5 wrong inside 15 min
 * locks it 15 min, doubling per repeat, capped at a day.
 */
export const VERIFY_THROTTLE: ThrottleRule = {
  windowMs: 15 * 60_000,
  maxFailures: 5,
  lockMs: 15 * 60_000,
  maxLockMs: 24 * 60 * 60_000
}

/** Per client IP (the edge's `x-stoke-client-ip`, else the socket's). */
export const IP_THROTTLE: ThrottleRule = {
  windowMs: 15 * 60_000,
  maxFailures: 30,
  lockMs: 15 * 60_000,
  maxLockMs: 15 * 60_000
}

/** A lockout count this long without a failure starts over. */
export const LOCKOUT_MEMORY_MS = 24 * 60 * 60_000

export interface ThrottleState {
  failures: number
  firstAt: number
  lockedUntil: number
  lockouts: number
  lastAt: number
}

/** Whether an attempt may even be checked now. Run BEFORE scrypt, so a locked key costs the hub nothing. */
export function throttleVerdict(state: ThrottleState | null, now: number): { ok: true } | { ok: false; retryAfterMs: number } {
  if (state && state.lockedUntil > now) return { ok: false, retryAfterMs: state.lockedUntil - now }
  return { ok: true }
}

/** The state after one failed attempt. */
export function recordLoginFailure(state: ThrottleState | null, now: number, rule: ThrottleRule): ThrottleState {
  const fresh = (lockouts: number): ThrottleState => ({ failures: 1, firstAt: now, lockedUntil: 0, lockouts, lastAt: now })
  let s: ThrottleState
  if (!state) s = fresh(0)
  else {
    const lockouts = now - state.lastAt > LOCKOUT_MEMORY_MS ? 0 : state.lockouts
    s =
      now - state.firstAt > rule.windowMs || state.lockedUntil > 0
        ? fresh(lockouts)
        : { ...state, failures: state.failures + 1, lastAt: now, lockouts }
  }
  if (s.failures >= rule.maxFailures) {
    const lock = Math.min(rule.lockMs * 2 ** s.lockouts, rule.maxLockMs)
    return { ...s, lockedUntil: now + lock, lockouts: s.lockouts + 1, failures: 0 }
  }
  return s
}
