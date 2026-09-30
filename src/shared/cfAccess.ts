/**
 * Cloudflare Access, the parts that need no crypto: which team and application
 * a settings file names, the shape of Access's login redirect, and the words
 * the desktop uses for a refused token.
 *
 * Compiled by both tsconfigs (renderer and main), so no `node:` import here
 * (CLAUDE.md gotcha 27). The signature half — JWKS, RS256, the claims — is
 * `src/main/remote/accessJwt.ts`, which needs `node:crypto`.
 *
 * Why a team domain and an AUD at all: a `Cf-Access-Jwt-Assertion` header is
 * evidence only once its signature checks out against the keys of the ONE
 * Cloudflare team that fronts this hostname, and its `aud` names the ONE Access
 * application in that team. Until 2026-09-30 Stoke held neither, so the server
 * could only check that the header was there — which any client can arrange
 * (gotcha 124).
 */

/**
 * `<team>.cloudflareaccess.com`, lowercased, no scheme, no slash. The label is
 * a DNS label: 1-63 characters, letters, digits and inner hyphens.
 *
 * Deliberately narrow. The team domain is spliced into the JWKS URL Stoke
 * fetches and into the `iss` it demands, so anything wider is an address a
 * hand-edited settings file could point the key fetch at. Custom team domains
 * are not accepted: none was measured, and widening this needs evidence.
 */
const TEAM_DOMAIN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/

/** An Access application's AUD tag: 64 lowercase hex characters (measured). */
const AUD_TAG = /^[0-9a-f]{64}$/

/**
 * A team domain as settings keeps it, or `''` when the value is not one.
 *
 * Forgiving about how it is PASTED — Zero Trust shows it as
 * `https://<team>.cloudflareaccess.com`, sometimes with a trailing slash — and
 * strict about what it becomes: `evil.com/x`, `a.cloudflareaccess.com.evil.com`
 * and anything with a path, port or userinfo are refused rather than trimmed
 * into something that fetches.
 */
export function clampAccessTeamDomain(value: unknown): string {
  if (typeof value !== 'string') return ''
  let v = value.trim().toLowerCase()
  if (v.startsWith('https://')) v = v.slice('https://'.length)
  if (v.endsWith('/')) v = v.slice(0, -1)
  return TEAM_DOMAIN.test(v) ? v : ''
}

/** An AUD tag as settings keeps it, or `''` when the value is not one. */
export function clampAccessAud(value: unknown): string {
  if (typeof value !== 'string') return ''
  const v = value.trim().toLowerCase()
  return AUD_TAG.test(v) ? v : ''
}

/** What a token is checked against. Both halves, or no policy at all. */
export interface AccessPolicy {
  /** `<team>.cloudflareaccess.com`: the JWKS host and, with `https://`, the `iss`. */
  teamDomain: string
  /** The Access application's AUD tag; the token's `aud` must contain it. */
  aud: string
}

/**
 * The policy a remote settings block names, or null when it does not name a
 * whole one. Clamped again here rather than trusted, because `RemoteConfig`
 * reaches the server from more than one path.
 */
export function accessPolicyOf(r: { accessTeamDomain?: unknown; accessAud?: unknown }): AccessPolicy | null {
  const teamDomain = clampAccessTeamDomain(r.accessTeamDomain)
  const aud = clampAccessAud(r.accessAud)
  return teamDomain && aud ? { teamDomain, aud } : null
}

/** The `iss` a token from this team carries — with the scheme, as Cloudflare writes it. */
export function accessIssuer(teamDomain: string): string {
  return `https://${teamDomain}`
}

/** Where the team publishes its signing keys. Built from settings, never from a token. */
export function accessCertsUrl(teamDomain: string): string {
  return `https://${teamDomain}/cdn-cgi/access/certs`
}

/**
 * Why a token was refused. One word each, so the server can record it without
 * echoing anything the client sent, and the panel can say what to do.
 */
export type AccessRefusal =
  | 'missing'
  | 'malformed'
  | 'alg'
  | 'no-keys'
  | 'unknown-kid'
  | 'signature'
  | 'iss'
  | 'aud'
  | 'expired'
  | 'not-yet-valid'
  | 'type'

/**
 * How the server is treating Access right now.
 *
 * `presence-only` is a settings file from before verification shipped: Access
 * required, but no team or AUD to verify against. It keeps the old check (a
 * header is there) rather than locking a working phone out on upgrade, and the
 * panel says so beside a Look it up button — it is never silent.
 */
export type AccessMode = 'off' | 'verified' | 'presence-only'

export interface RemoteAccessStatus {
  mode: AccessMode
  teamDomain: string
  /** Signing keys cached from the team's JWKS. 0 before the first fetch lands. */
  keys: number
  /** The last JWKS fetch's failure, quoted; null once one succeeds. */
  keysError: string | null
  /** The last token refused, and when (epoch ms). Never the token itself. */
  lastRefusal: { reason: AccessRefusal; at: number } | null
  /** When a token last verified (epoch ms). */
  lastAccepted: number | null
}

export const ACCESS_STATUS_OFF: RemoteAccessStatus = {
  mode: 'off',
  teamDomain: '',
  keys: 0,
  keysError: null,
  lastRefusal: null,
  lastAccepted: null
}

/** One line per refusal, for Settings › Phone access. */
export function accessRefusalText(reason: AccessRefusal): string {
  switch (reason) {
    case 'missing':
      return 'a request arrived without a Cloudflare Access token — it did not come through Access'
    case 'malformed':
      return 'a request carried something that is not a Cloudflare Access token'
    case 'alg':
      return 'a token was signed with an algorithm Cloudflare Access never uses'
    case 'no-keys':
      return "Stoke could not fetch your team's signing keys, so it could not check a token"
    case 'unknown-kid':
      return "a token was signed by a key your team does not publish"
    case 'signature':
      return "a token's signature did not match your team's key"
    case 'iss':
      return 'a token came from a different Cloudflare team'
    case 'aud':
      return 'a token was for a different Access application — check the AUD tag'
    case 'expired':
      return "a token had expired — if this repeats, check this computer's clock"
    case 'not-yet-valid':
      return "a token is not valid yet — check this computer's clock"
    case 'type':
      return 'a token was not an application token'
  }
}

/**
 * What the PHONE is told when this machine refuses its Access token.
 *
 * Only ever sent to a request that already carried the right key (the key is
 * checked first), so it is a sentence for the owner, not a hint for a stranger.
 * It exists because the phone used to get the same 401 as a wrong key and said
 * "Your key was replaced" — a diagnosis the server could disprove, for a clock,
 * an unreachable JWKS or a stale AUD on the desktop (gotchas 46, 52, 124).
 * Each line names the machine's side of the check; the desktop panel keeps the
 * exact reason (`accessRefusalText`).
 */
export function accessRefusalForPhone(reason: AccessRefusal): string {
  switch (reason) {
    case 'missing':
      return 'Stoke on your computer only answers requests that come through Cloudflare Access, and this one did not.'
    case 'no-keys':
      return "Stoke on your computer could not fetch your Cloudflare team's signing keys, so it could not check your Access sign-in. Is the computer online?"
    case 'iss':
    case 'aud':
      return 'Your Cloudflare Access sign-in is for a different team or application than the one Stoke on your computer has on file. On the computer, open Settings › Phone access and press Look it up.'
    case 'expired':
    case 'not-yet-valid':
      return "Stoke on your computer read your Cloudflare Access sign-in as out of date. If this repeats, check the computer's clock."
    default:
      return 'Stoke on your computer could not verify your Cloudflare Access sign-in. Settings › Phone access on the computer says why.'
  }
}

/**
 * The parts of Access's login redirect that name the team and the application.
 *
 * A browser-shaped request to a hostname behind Access answers 302 to
 * `https://<team>.cloudflareaccess.com/cdn-cgi/access/login/<host>?kid=<AUD>&meta=<JWT>&redirect_url=…`
 * (measured on two Access-protected hosts, 2026-09-30; undocumented). `meta`
 * is a JWT the team signed that repeats the hostname and the AUD, which is what
 * lets `discoverAccess` trust the answer rather than the redirect. Pure: this
 * only reads the URL, and returns null for anything not of exactly that shape.
 */
export function parseAccessRedirect(
  location: string | null | undefined
): { teamDomain: string; aud: string; meta: string } | null {
  if (!location) return null
  let url: URL
  try {
    url = new URL(location)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  const teamDomain = clampAccessTeamDomain(url.hostname)
  if (!teamDomain || teamDomain !== url.hostname.toLowerCase()) return null
  if (!url.pathname.startsWith('/cdn-cgi/access/login/')) return null
  const kid = url.searchParams.get('kid') ?? ''
  // The kid in the URL must already BE an AUD tag, not merely clamp to one.
  if (!/^[0-9a-f]{64}$/.test(kid)) return null
  const meta = url.searchParams.get('meta') ?? ''
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(meta)) return null
  return { teamDomain, aud: kid, meta }
}

/** What "Look it up" hands the renderer, which is the only writer of the two fields. */
export type AccessLookup =
  | { ok: true; teamDomain: string; aud: string }
  | { ok: false; error: string }
