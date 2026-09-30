/*
 * Where the hub is, and how a request gets there.
 *
 * Three decisions, each small enough to be a pure function a suite can hold
 * (gotcha 31: otherwise they are side effects inside a Worker and a server
 * nobody local can invoke):
 *
 * - `hubUrlVerdict`: which `hub.url` a Stoke accepts — https anywhere, plain
 *   http only on a private network — and the base every path hangs off.
 * - `edgeTarget` / `edgeForwardHeaders`: what the `stoke-hub-edge` Worker on
 *   the route `stoke.vinn.dev/hub/*` forwards, to where, with which headers.
 * - `edgeVerdict`: whether the hub's edge listener takes a request — it must
 *   carry the shared secret only the Worker adds.
 *
 * Pure (gotcha 27). Design: docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md §2.
 */
import { HUB_HEADERS } from './protocol.ts'

/* ------------------------------------------------------ the hub URL */

export type HubUrlVerdict =
  | { ok: true; base: string; transport: 'https' | 'http-private'; warning: string | null }
  | { ok: false; problem: string }

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n <= 255) ? parts : null
}

/**
 * A host plain http may be used with: this machine, an RFC 1918 network,
 * Tailscale's 100.64.0.0/10, a `.local` (mDNS) name, a `.ts.net` name
 * (reached over the tailnet's WireGuard). Everything else must be https.
 */
export function isPrivateHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.ts.net')) return true
  const v4 = ipv4(h)
  if (v4) {
    const [a, b] = v4
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  if (h === '::1') return true
  // IPv6 unique-local fc00::/7, which Tailscale's fd7a:115c:a1e0::/48 is inside.
  return /^f[cd][0-9a-f]{2}:/.test(h)
}

/**
 * Judge what the owner typed as the hub URL. A bare origin gets `/hub`
 * appended (the edge's mount); any other path is kept, trailing slashes
 * dropped. No credentials, query or fragment: none of them would survive a
 * request, and a password in a URL ends up in logs.
 */
export function hubUrlVerdict(text: unknown): HubUrlVerdict {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, problem: 'Enter the address of your hub.' }
  let u: URL
  try {
    u = new URL(text.trim())
  } catch {
    return { ok: false, problem: 'That is not a web address. It starts with https://.' }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, problem: 'A hub address starts with https://.' }
  if (u.username || u.password) return { ok: false, problem: 'Leave the name and password out of the address; Stoke signs in separately.' }
  if (u.search || u.hash) return { ok: false, problem: 'A hub address has no ? or # part.' }
  const path = u.pathname.replace(/\/+$/, '')
  const base = `${u.protocol}//${u.host}${path === '' ? '/hub' : path}`
  if (u.protocol === 'https:') return { ok: true, base, transport: 'https', warning: null }
  if (!isPrivateHost(u.hostname)) {
    return { ok: false, problem: 'Plain http:// only works for an address on your own network or tailnet. Use https://.' }
  }
  return {
    ok: true,
    base,
    transport: 'http-private',
    warning:
      'This address is plain http, so anyone on that network can read your hub session (not your keys or settings, which stay encrypted, and not enough to change anything). Use https where you can.'
  }
}

/** The full URL of `pathFromV1` (e.g. `/v1/items?since=3`) under a base from `hubUrlVerdict`. */
export function hubEndpoint(base: string, pathFromV1: string): string {
  return `${base.replace(/\/+$/, '')}${pathFromV1.startsWith('/') ? '' : '/'}${pathFromV1}`
}

/** The same, as the WebSocket URL for an upgrade route. */
export function hubSocketUrl(base: string, pathFromV1: string): string {
  return hubEndpoint(base, pathFromV1).replace(/^http/, 'ws')
}

/* ------------------------------------------------------ the edge Worker */

/** The mount the edge Worker's route covers, and the hub serves under. */
export const EDGE_MOUNT = '/hub'

/**
 * Where the edge Worker sends a request, or null to answer 404 itself.
 * Only `/hub/…` is forwarded (the route is `stoke.vinn.dev/hub/*`, but a
 * route is a pattern and a Worker should not trust it to be the only way in);
 * the path and query are kept exactly, so signatures still verify.
 */
export function edgeTarget(requestUrl: string, origin: string): string | null {
  let u: URL
  try {
    u = new URL(requestUrl)
  } catch {
    return null
  }
  if (!u.pathname.startsWith(`${EDGE_MOUNT}/`)) return null
  return `${origin.replace(/\/+$/, '')}${u.pathname}${u.search}`
}

/**
 * Headers the edge must never pass on from a client: its own secret and the
 * client-IP header (so a client cannot forge either), Access service-token
 * headers (so a client cannot present its own), and `host` (the fetch sets
 * the origin's).
 */
const EDGE_STRIPPED = new Set([HUB_HEADERS.edge, HUB_HEADERS.clientIp, 'cf-access-client-id', 'cf-access-client-secret', 'host'])

/**
 * The headers the edge Worker sends to the origin: the client's (WebSocket
 * upgrade headers included), minus EDGE_STRIPPED, plus the secret, the
 * client's IP, and optionally an Access service token (spec §2.3).
 */
export function edgeForwardHeaders(
  incoming: Iterable<[string, string]>,
  opts: { secret: string; clientIp: string; access?: { id: string; secret: string } }
): [string, string][] {
  const out: [string, string][] = []
  for (const [k, v] of incoming) if (!EDGE_STRIPPED.has(k.toLowerCase())) out.push([k.toLowerCase(), v])
  out.push([HUB_HEADERS.edge, opts.secret])
  out.push([HUB_HEADERS.clientIp, opts.clientIp])
  if (opts.access) {
    out.push(['cf-access-client-id', opts.access.id])
    out.push(['cf-access-client-secret', opts.access.secret])
  }
  return out
}

/* ------------------------------------------------ the hub's edge check */

/**
 * Compare a presented secret `got` with the configured `want` without an
 * early exit: the loop runs over `want`'s length whatever `got` holds, so the
 * time taken says nothing about how much of it matched. (Main-process code
 * may use `crypto.timingSafeEqual` instead; this one also runs in a Worker.)
 */
export function sameSecret(got: string, want: string): boolean {
  if (got.length === 0 || want.length === 0) return false
  let diff = got.length ^ want.length
  for (let i = 0; i < want.length; i++) diff |= (got.charCodeAt(i) || 0) ^ want.charCodeAt(i)
  return diff === 0
}

/** The shortest edge secret the hub will run with (32 random bytes is 43 b64url characters). */
export const MIN_EDGE_SECRET_CHARS = 32

/**
 * Whether one request is accepted by the listener it arrived on, and which IP
 * to throttle it by.
 *
 * - `edge` (loopback, `cloudflared`'s target): the secret must be configured
 *   AND match, or 403 `edge-refused` — an edge listener with no secret is a
 *   configuration error, and refusing everything is how it is noticed. The
 *   client IP is the Worker's header.
 * - `lan` (optional, the owner's network or tailnet): no secret; the client
 *   IP is the socket's, and a forwarded-IP header on it is ignored.
 */
export function edgeVerdict(f: {
  listener: 'edge' | 'lan'
  secret: string | null
  headers: Record<string, string | undefined>
  socketIp: string
}): { ok: true; clientIp: string } | { ok: false } {
  if (f.listener === 'lan') return { ok: true, clientIp: f.socketIp }
  if (!f.secret || f.secret.length < MIN_EDGE_SECRET_CHARS) return { ok: false }
  const got = f.headers[HUB_HEADERS.edge] ?? ''
  if (!sameSecret(got, f.secret)) return { ok: false }
  const ip = (f.headers[HUB_HEADERS.clientIp] ?? '').trim()
  return { ok: true, clientIp: ip || f.socketIp }
}
