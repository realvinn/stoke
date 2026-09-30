import { createPublicKey, verify as verifySignature, type JsonWebKey, type KeyObject } from 'node:crypto'
import {
  accessCertsUrl,
  accessIssuer,
  parseAccessRedirect,
  type AccessLookup,
  type AccessPolicy,
  type AccessRefusal
} from '../../shared/cfAccess.ts'

/**
 * Verifying the `Cf-Access-Jwt-Assertion` Cloudflare Access puts on every
 * request it lets through — the signature, not just the header's presence.
 *
 * Until 2026-09-30 the phone server passed any request carrying that header
 * (or the unsigned `Cf-Access-Authenticated-User-Email`) with any value at all,
 * and `verify:security` forged exactly that to stand in for the edge. With the
 * team domain and the application's AUD tag in settings, the header is now a
 * token Cloudflare must have signed for this application (gotcha 124):
 *
 * - RS256 only, pinned before any crypto runs. `alg: none` and `HS256` keyed
 *   with the public key (the classic confusion) never reach `verify`.
 * - The key comes from the JWKS of the team named in SETTINGS, looked up by the
 *   token's `kid`. Nothing in the token picks where keys come from: `iss`, `jku`,
 *   `x5u` and an embedded `jwk` are never followed.
 * - `iss` must be `https://<team>`, `aud` must contain the AUD tag, `exp` is
 *   required and `nbf`/`iat` checked when present, each with 60 s of leeway
 *   (RFC 7519 §4.1.4 allows "a few minutes"). `nbf` is optional because service
 *   tokens have none.
 * - Key rotation: Access rotates its signing key every six weeks and keeps the
 *   old one valid for seven days, so an unknown `kid` refetches the JWKS — at
 *   most once per `KID_COOLDOWN_MS`, however many tokens ask, and one fetch in
 *   flight at a time, claimed before its first await (gotcha 20).
 *
 * No electron import, no dependency beyond `node:crypto`, and fetch and the
 * clock injectable — `verify:remote` runs all of it under strip-types against
 * a keypair it generates and a JWKS it serves from a fake fetch.
 */

/** Clock skew allowed on `exp`, `nbf` and `iat`, in seconds. */
export const ACCESS_LEEWAY_S = 60
/** A real Access token is ~1 KB; anything past this is refused before decoding. */
export const MAX_ACCESS_TOKEN_CHARS = 16 * 1024
/** A real team JWKS is ~3 KB (two RSA-2048 keys plus their certificates). */
export const MAX_JWKS_BYTES = 64 * 1024
export const JWKS_TIMEOUT_MS = 5_000
/** Minimum gap between refetches an unknown `kid` may cause while keys are cached. */
export const KID_COOLDOWN_MS = 30_000
/** Minimum gap between fetches while NO usable key is cached (cold start, outage). */
export const EMPTY_RETRY_MS = 5_000
/** How long a fetched key set is fresh: the answer's max-age, clamped to this range. */
export const MIN_KEYS_TTL_MS = 5 * 60_000
export const MAX_KEYS_TTL_MS = 60 * 60_000
export const DEFAULT_KEYS_TTL_MS = 10 * 60_000
/**
 * How long a key set is still USED when every refetch fails. Past this, every
 * token is refused (`no-keys`) until a fetch succeeds: a key Cloudflare has
 * withdrawn must not stay trusted forever because a network was down. Old keys
 * stay valid a week after rotation, so a day of staleness never refuses a
 * token Cloudflare would still stand behind.
 */
export const MAX_STALE_MS = 24 * 60 * 60_000
const MIN_RSA_BITS = 2048
const MAX_RSA_BITS = 8192
/** Keys past this many in one answer are ignored; a team publishes two. */
const MAX_KEYS = 16

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export type AccessVerdict =
  | { ok: true; subject: string; exp: number }
  | { ok: false; reason: AccessRefusal }

/** Where `verifyAccessJwt` gets a key for a `kid`. `AccessKeySet` is the real one. */
export interface AccessKeySource {
  keyFor(kid: string): Promise<KeyObject | null>
  /** Usable keys held now; 0 means a refusal is `no-keys`, not `unknown-kid`. */
  readonly size: number
}

interface Decoded {
  header: Record<string, unknown>
  payload: Record<string, unknown>
  signingInput: string
  signature: Buffer
}

const B64URL = /^[A-Za-z0-9_-]+$/

function jsonObject(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/**
 * Three strict base64url parts whose first two are JSON objects, or null.
 * Decoding only: nothing here is trusted until `verifyAccessJwt` has checked
 * the signature over exactly `signingInput`.
 */
export function decodeAccessJwt(token: string): Decoded | null {
  if (token.length === 0 || token.length > MAX_ACCESS_TOKEN_CHARS) return null
  const parts = token.split('.')
  if (parts.length !== 3 || !parts.every((p) => B64URL.test(p))) return null
  const header = jsonObject(parts[0])
  const payload = jsonObject(parts[1])
  if (!header || !payload) return null
  return {
    header,
    payload,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: Buffer.from(parts[2], 'base64url')
  }
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/**
 * The claims, once the signature is known good. Pure; `nowS` is Unix seconds.
 * Order is fixed so a token that is wrong in two ways always reports the same
 * reason: issuer, audience, type, then time.
 */
export function checkAccessClaims(
  payload: Record<string, unknown>,
  policy: AccessPolicy,
  nowS: number
): AccessVerdict {
  if (payload.iss !== accessIssuer(policy.teamDomain)) return { ok: false, reason: 'iss' }
  const aud = payload.aud
  const auds = typeof aud === 'string' ? [aud] : Array.isArray(aud) ? aud : []
  if (!auds.some((a) => a === policy.aud)) return { ok: false, reason: 'aud' }
  // `app` is an application token; `org` is the team-wide session, not for us.
  if (payload.type !== undefined && payload.type !== 'app') return { ok: false, reason: 'type' }
  if (!isNum(payload.exp)) return { ok: false, reason: 'expired' }
  if (nowS >= payload.exp + ACCESS_LEEWAY_S) return { ok: false, reason: 'expired' }
  if (payload.nbf !== undefined && (!isNum(payload.nbf) || nowS + ACCESS_LEEWAY_S < payload.nbf)) {
    return { ok: false, reason: 'not-yet-valid' }
  }
  if (payload.iat !== undefined && (!isNum(payload.iat) || nowS + ACCESS_LEEWAY_S < payload.iat)) {
    return { ok: false, reason: 'not-yet-valid' }
  }
  const subject = [payload.email, payload.common_name, payload.sub].find(
    (s): s is string => typeof s === 'string' && s.length > 0
  )
  return { ok: true, subject: subject ?? '', exp: payload.exp }
}

/**
 * True when `signature` is an RS256 signature by `key` over `signingInput`.
 * A signature of any other length than the modulus is refused before `verify`.
 */
function rs256(key: KeyObject, signingInput: string, signature: Buffer): boolean {
  if (key.asymmetricKeyType !== 'rsa') return false
  const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
  if (signature.length !== Math.ceil(bits / 8)) return false
  try {
    // For an RSA key `verify` defaults to RSASSA-PKCS1-v1_5, which with
    // SHA-256 is exactly RS256.
    return verifySignature('sha256', Buffer.from(signingInput, 'ascii'), key, signature)
  } catch {
    return false
  }
}

/**
 * Verify one `Cf-Access-Jwt-Assertion` against a policy. Never throws.
 *
 * `token` is `unknown` on purpose: it is a header value, which Node hands over
 * as `string | string[] | undefined`, and only a single string is a token.
 */
export async function verifyAccessJwt(
  token: unknown,
  policy: AccessPolicy,
  keys: AccessKeySource,
  nowMs: number
): Promise<AccessVerdict> {
  if (token === undefined || token === '') return { ok: false, reason: 'missing' }
  if (typeof token !== 'string') return { ok: false, reason: 'malformed' }
  const jwt = decodeAccessJwt(token)
  if (!jwt) return { ok: false, reason: 'malformed' }
  // Pinned before any key is looked up: RFC 8725 §3.1.
  if (jwt.header.alg !== 'RS256') return { ok: false, reason: 'alg' }
  // A critical extension we do not implement must be refused, not ignored (RFC 7515 §4.1.11).
  if (jwt.header.crit !== undefined) return { ok: false, reason: 'malformed' }
  const kid = jwt.header.kid
  if (typeof kid !== 'string' || kid.length === 0 || kid.length > 256) {
    return { ok: false, reason: 'unknown-kid' }
  }
  const key = await keys.keyFor(kid)
  if (!key) return { ok: false, reason: keys.size === 0 ? 'no-keys' : 'unknown-kid' }
  if (!rs256(key, jwt.signingInput, jwt.signature)) return { ok: false, reason: 'signature' }
  return checkAccessClaims(jwt.payload, policy, Math.floor(nowMs / 1000))
}

/** The body, refused past `cap` bytes whether or not the server said how long it was. */
async function readCapped(res: Response, cap: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > cap) throw new Error(`the answer is over ${cap} bytes`)
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > cap) {
      await reader.cancel().catch(() => {})
      throw new Error(`the answer is over ${cap} bytes`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** Cloudflare sends `max-age=14400` (measured); honoured within [5 min, 1 h]. */
export function keysTtlFrom(cacheControl: string | null): number {
  const m = /(?:^|[,\s])max-age=(\d+)/i.exec(cacheControl ?? '')
  if (!m) return DEFAULT_KEYS_TTL_MS
  return Math.min(MAX_KEYS_TTL_MS, Math.max(MIN_KEYS_TTL_MS, Number(m[1]) * 1000))
}

/**
 * The RS256 signing keys in a JWKS document, by `kid`.
 *
 * Only what can sign an RS256 token is kept: `kty` RSA, `alg` absent or RS256,
 * `use` absent or `sig`, a modulus of 2048-8192 bits. Only `n` and `e` are
 * imported, so a private member or an `x5c` chain in the answer is never read.
 * Throws on a document that is not JSON with a `keys` array.
 */
export function parseJwks(text: string): Map<string, KeyObject> {
  const doc: unknown = JSON.parse(text)
  const list = (doc as { keys?: unknown } | null)?.keys
  if (!Array.isArray(list)) throw new Error('the answer has no keys list')
  const keys = new Map<string, KeyObject>()
  for (const raw of list.slice(0, MAX_KEYS)) {
    if (!raw || typeof raw !== 'object') continue
    const k = raw as Record<string, unknown>
    if (k.kty !== 'RSA') continue
    if (k.alg !== undefined && k.alg !== 'RS256') continue
    if (k.use !== undefined && k.use !== 'sig') continue
    if (typeof k.kid !== 'string' || k.kid.length === 0 || k.kid.length > 256 || keys.has(k.kid)) continue
    if (typeof k.n !== 'string' || typeof k.e !== 'string' || !B64URL.test(k.n) || !B64URL.test(k.e)) continue
    try {
      const jwk: JsonWebKey = { kty: 'RSA', n: k.n, e: k.e }
      const key = createPublicKey({ key: jwk, format: 'jwk' })
      const bits = key.asymmetricKeyDetails?.modulusLength ?? 0
      if (bits < MIN_RSA_BITS || bits > MAX_RSA_BITS) continue
      keys.set(k.kid, key)
    } catch {
      /* not a key node can import; skip it */
    }
  }
  return keys
}

export interface AccessKeySetOptions {
  /** Built from the team domain in settings (`accessCertsUrl`), never from a token. */
  certsUrl: string
  fetch?: FetchLike
  now?: () => number
  kidCooldownMs?: number
  emptyRetryMs?: number
  maxStaleMs?: number
}

/**
 * One team's signing keys, fetched on demand and cached.
 *
 * The rules, each a way the naive version goes wrong:
 * - ONE fetch in flight. Ten sockets opening at once on a cold cache share it;
 *   `inflight` is claimed synchronously, before the first await (gotcha 20).
 * - An unknown `kid` refetches at most once per `kidCooldownMs`. Without that,
 *   anyone who can reach the port with the bearer key could make Stoke hammer
 *   Cloudflare by sending made-up kids.
 * - With no usable keys at all, a fetch may be retried every `emptyRetryMs`,
 *   so a machine that started offline recovers within seconds of the network.
 * - A failed refetch keeps the last good set until `maxStaleMs`.
 */
export class AccessKeySet implements AccessKeySource {
  readonly certsUrl: string
  private readonly fetchFn: FetchLike
  private readonly now: () => number
  private readonly kidCooldownMs: number
  private readonly emptyRetryMs: number
  private readonly maxStaleMs: number
  private keys = new Map<string, KeyObject>()
  private fetchedAt = 0
  private ttlMs = DEFAULT_KEYS_TTL_MS
  private attemptedAt = Number.NEGATIVE_INFINITY
  private inflight: Promise<void> | null = null
  private error: string | null = null
  /** Fetches started, ever. The suite counts these; nothing else reads them. */
  fetches = 0

  constructor(o: AccessKeySetOptions) {
    this.certsUrl = o.certsUrl
    this.fetchFn = o.fetch ?? ((url, init) => fetch(url, init))
    this.now = o.now ?? Date.now
    this.kidCooldownMs = o.kidCooldownMs ?? KID_COOLDOWN_MS
    this.emptyRetryMs = o.emptyRetryMs ?? EMPTY_RETRY_MS
    this.maxStaleMs = o.maxStaleMs ?? MAX_STALE_MS
  }

  private usable(): boolean {
    return this.keys.size > 0 && this.now() - this.fetchedAt <= this.maxStaleMs
  }

  get size(): number {
    return this.usable() ? this.keys.size : 0
  }

  /** The last fetch's failure, or null once one has succeeded. */
  get lastError(): string | null {
    return this.error
  }

  /**
   * Fetch the JWKS now, or join the fetch already running. Never rejects: a
   * failure is recorded in `lastError` and the previous keys are kept.
   */
  refresh(): Promise<void> {
    if (this.inflight) return this.inflight
    this.attemptedAt = this.now()
    this.fetches++
    const run = this.load().finally(() => {
      this.inflight = null
    })
    this.inflight = run
    return run
  }

  private async load(): Promise<void> {
    try {
      const res = await this.fetchFn(this.certsUrl, {
        // The keys come from exactly this URL; a redirect elsewhere is refused.
        redirect: 'error',
        signal: AbortSignal.timeout(JWKS_TIMEOUT_MS),
        headers: { accept: 'application/json' }
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const keys = parseJwks(await readCapped(res, MAX_JWKS_BYTES))
      if (keys.size === 0) throw new Error('the answer holds no RS256 signing key')
      this.keys = keys
      this.fetchedAt = this.now()
      this.ttlMs = keysTtlFrom(res.headers.get('cache-control'))
      this.error = null
    } catch (err) {
      const why = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
      this.error = `Could not fetch ${this.certsUrl}: ${why}`
    }
  }

  async keyFor(kid: string): Promise<KeyObject | null> {
    const now = this.now()
    if (this.usable()) {
      const key = this.keys.get(kid)
      if (key) {
        // Fresh enough to use; past its max-age, refreshed behind this answer.
        if (now - this.fetchedAt > this.ttlMs && !this.inflight && now - this.attemptedAt >= this.kidCooldownMs) {
          void this.refresh()
        }
        return key
      }
      if (this.inflight) await this.inflight
      else if (now - this.attemptedAt >= this.kidCooldownMs) await this.refresh()
    } else if (this.inflight) {
      await this.inflight
    } else if (now - this.attemptedAt >= this.emptyRetryMs) {
      await this.refresh()
    }
    return this.usable() ? (this.keys.get(kid) ?? null) : null
  }
}

/**
 * The request headers of a browser opening a page. Access with Managed OAuth
 * answers a non-browser request with `401 WWW-Authenticate` instead of the login
 * redirect `discoverAccess` reads (measured 2026-09-30), so the probe has to
 * look like Safari asking for HTML.
 */
export const BROWSER_PROBE_HEADERS: Readonly<Record<string, string>> = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
}

const HOSTNAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])$/

/**
 * Find the Access team and application in front of a hostname, with no
 * credential: what "Look it up" in Settings › Phone access runs.
 *
 * Stoke holds no Cloudflare API token — cloudflared's `cert.pem` is the only
 * credential and it is never read (gotcha 58) — so this asks the edge the same
 * way `checkHostname` does: a browser-shaped request to a gated path, redirect
 * not followed. Access answers with its login redirect, which names the team
 * and carries the AUD tag as `kid` plus `meta`, a JWT the team signed repeating
 * the hostname and the AUD. The answer is trusted only once `meta` verifies
 * against that team's own JWKS with `hostname` equal to the one asked about:
 * Cloudflare lets an Access application cover only a zone its account owns, so
 * a team's signature over this hostname is the binding. A redirect alone is
 * never enough — whoever answers for the hostname could write any team into it.
 *
 * Undocumented and measured, so it can fail; the panel keeps the manual fields
 * (Zero Trust › Access › Applications › Additional settings) for that.
 */
export async function discoverAccess(
  hostname: string,
  deps: { fetch?: FetchLike; now?: () => number; keysFor?: (certsUrl: string) => AccessKeySource } = {}
): Promise<AccessLookup> {
  const host = hostname.trim().toLowerCase()
  if (!host) return { ok: false, error: 'Set the public hostname first.' }
  if (!HOSTNAME.test(host)) return { ok: false, error: `${host} is not a hostname Stoke can look up.` }
  const doFetch: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init))
  const now = deps.now ?? Date.now

  let res: Response
  try {
    res = await doFetch(`https://${host}/api/host`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(8000),
      headers: { ...BROWSER_PROBE_HEADERS }
    })
  } catch (err) {
    const why = err instanceof Error ? (err.cause instanceof Error ? err.cause.message : err.message) : String(err)
    return { ok: false, error: `Could not reach ${host}: ${why}` }
  }
  await res.body?.cancel().catch(() => {})

  const found = res.status >= 300 && res.status < 400 ? parseAccessRedirect(res.headers.get('location')) : null
  if (!found) {
    const www = res.headers.get('www-authenticate') ?? ''
    if (res.status === 401 && /cloudflare-access-protected-resource/i.test(www)) {
      return {
        ok: false,
        error: `${host} answered with Access's OAuth sign-in rather than the login page Stoke reads. Paste the team domain and AUD tag below.`
      }
    }
    if (res.status >= 300 && res.status < 400) {
      return { ok: false, error: `${host} redirects somewhere that is not a Cloudflare Access login.` }
    }
    if (res.status === 401 || (res.status >= 200 && res.status < 300)) {
      return {
        ok: false,
        error: `${host} reaches this machine without a Cloudflare Access sign-in, so there is no Access application in front of it to look up. Add one in Zero Trust › Access › Applications first.`
      }
    }
    return { ok: false, error: `${host} answered HTTP ${res.status}, not a Cloudflare Access login.` }
  }

  const refused = {
    ok: false as const,
    error: `The Access login for ${host} did not carry a valid signature from ${found.teamDomain}, so Stoke did not use it. Paste the team domain and AUD tag below.`
  }
  const meta = decodeAccessJwt(found.meta)
  if (!meta || meta.header.alg !== 'RS256' || typeof meta.header.kid !== 'string') return refused
  const certsUrl = accessCertsUrl(found.teamDomain)
  const keys = deps.keysFor?.(certsUrl) ?? new AccessKeySet({ certsUrl, fetch: doFetch, now })
  const key = await keys.keyFor(meta.header.kid)
  if (!key) {
    return keys.size === 0
      ? { ok: false, error: `Found ${found.teamDomain}, but could not fetch its signing keys to check it. Try again.` }
      : refused
  }
  if (!rs256(key, meta.signingInput, meta.signature)) return refused
  const p = meta.payload
  const auds = typeof p.aud === 'string' ? [p.aud] : Array.isArray(p.aud) ? p.aud : []
  const nowS = Math.floor(now() / 1000)
  if (
    p.type !== 'meta' ||
    typeof p.hostname !== 'string' ||
    p.hostname.toLowerCase() !== host ||
    !auds.includes(found.aud) ||
    !isNum(p.exp) ||
    nowS >= p.exp + ACCESS_LEEWAY_S
  ) {
    return refused
  }
  return { ok: true, teamDomain: found.teamDomain, aud: found.aud }
}
