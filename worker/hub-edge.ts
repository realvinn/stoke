/**
 * `stoke-hub-edge` — the Worker on the ROUTE `stoke.vinn.dev/hub/*` that
 * carries Stoke Hub traffic to the owner's NUC (spec §2:
 * docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md).
 *
 * It is a SEPARATE Worker from the installer (`worker/index.ts`), on purpose:
 *
 * - The installer's blast radius stays where it was. Whoever can deploy
 *   `stoke-install` can run code on every machine that pipes the one-liner
 *   into a shell, and verify:install holds that it fetches nothing and holds
 *   nothing secret. This Worker holds a secret and makes subrequests; putting
 *   that into the installer would put a secret and an unrelated code path
 *   into the one artefact that must stay auditable byte for byte.
 * - A route on a hostname runs BEFORE that hostname's Custom Domain Worker
 *   (Cloudflare, Custom Domains › request matching), so `/hub/*` reaches this
 *   one and every other path still reaches the installer, unchanged. That
 *   precedence is cited, not measured: nothing here has been deployed.
 *
 * What it does, and all it does:
 * - refuses plain http (a bearer token must never cross the internet in the
 *   clear) and any path outside `/hub/` (a route is a pattern; this does not
 *   trust it to be the only way in);
 * - forwards the request to `HUB_ORIGIN` (the Cloudflare Tunnel hostname on
 *   the NUC) with the path and query EXACTLY as sent, so device signatures
 *   still verify, adding `x-stoke-hub-edge: <HUB_EDGE_SECRET>` and the
 *   visitor's IP, after deleting any client copy of either (edge.ts
 *   `edgeForwardHeaders`);
 * - bridges a WebSocket upgrade: it opens the upstream socket with `fetch()`
 *   and `Upgrade: websocket`, accepts both ends, and copies every message
 *   across unchanged, binary as binary (`bridgeSockets`; the pattern
 *   Cloudflare documents end to end; returning the origin's 101 directly is
 *   UNVERIFIED and not relied on). An evicted isolate drops the socket, which
 *   the protocol is built to survive (§2.2).
 * - answers every refusal of its own as a hub error body (JSON with a known
 *   code), so a Stoke shows the sentence rather than "not a hub" (gotcha 71's
 *   lesson: a 200 is not a success, and neither is a non-JSON page).
 *
 * Not typechecked (worker/ is in neither tsconfig, as modules.d.ts says), so
 * the HTTP half is written against the Fetch API only and RUN under node by
 * verify:install (matrix, headers, refusals) and verify:hub-server (a signed
 * request through this function to a real hub). The upgrade itself needs
 * `WebSocketPair`, which only the Workers runtime has; the bridge between the
 * two accepted sockets (`bridgeSockets`) runs under node in verify:hub-server
 * against stand-ins that behave as the runtime does, and scripts/hub-e2e.mts
 * drives the deployed one.
 *
 * Deployed BY HAND, like the installer and for the same reason:
 *   npx wrangler secret put HUB_EDGE_SECRET -c wrangler.hub-edge.jsonc
 *   npm run deploy:hub-edge
 */
import { EDGE_MOUNT, edgeForwardHeaders, edgeTarget, MIN_EDGE_SECRET_CHARS } from '../src/shared/hub/edge.ts'
import { HUB_LIMITS, type HubErrorBody, type HubErrorCode } from '../src/shared/hub/protocol.ts'

export interface HubEdgeEnv {
  /** `https://hub-origin.vinn.dev` — the tunnel hostname (a var in wrangler.hub-edge.jsonc). */
  HUB_ORIGIN?: string
  /** The shared secret the hub's edge listener requires (`wrangler secret put`). */
  HUB_EDGE_SECRET?: string
  /** Optional Access service token for the origin hostname (spec §2.3). */
  HUB_ACCESS_CLIENT_ID?: string
  HUB_ACCESS_CLIENT_SECRET?: string
}

export type EdgeFetch = (input: string, init: RequestInit) => Promise<Response>

/**
 * Headers that describe one connection and never cross a proxy (RFC 9110
 * §7.6.1), plus content-length, which the runtime recomputes for the body it
 * actually sends. Dropped on the HTTP path only: the socket path builds its
 * own upgrade.
 */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'content-length'])

/** The runtime makes its own WebSocket handshake to the origin; the client's key and extensions are for its own. */
const CLIENT_SOCKET_HEADERS = new Set(['connection', 'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 'content-length'])

/** A refusal the edge makes itself, in the hub's own error shape. */
export function edgeError(code: HubErrorCode, message: string, status: number): Response {
  const body: HubErrorBody = { error: code, message }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }
  })
}

function isLoopback(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]'
}

/**
 * The origin and secret this Worker forwards with, or why it will not
 * forward at all. The origin must be https (plain http only to loopback, for
 * `wrangler dev` and the suites) and must not be this Worker's own hostname,
 * which would loop; the secret must be at least as long as the hub requires.
 */
export function edgeConfig(env: HubEdgeEnv, requestHost: string): { origin: string; secret: string; access?: { id: string; secret: string } } | { problem: string } {
  const secret = (env.HUB_EDGE_SECRET ?? '').trim()
  if (secret.length < MIN_EDGE_SECRET_CHARS) return { problem: 'The hub edge has no secret configured yet.' }
  let origin: URL
  try {
    origin = new URL((env.HUB_ORIGIN ?? '').trim())
  } catch {
    return { problem: 'The hub edge has no origin configured yet.' }
  }
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && isLoopback(origin.hostname))) {
    return { problem: 'The hub edge only forwards to an https origin.' }
  }
  if (origin.host === requestHost) return { problem: 'The hub edge is configured to forward to itself.' }
  const id = env.HUB_ACCESS_CLIENT_ID?.trim()
  const accessSecret = env.HUB_ACCESS_CLIENT_SECRET?.trim()
  return { origin: origin.origin, secret, ...(id && accessSecret ? { access: { id, secret: accessSecret } } : {}) }
}

/** The checks both paths share; a Response when the request stops here. */
function preflight(request: Request, env: HubEdgeEnv): Response | { target: string; cfg: { origin: string; secret: string; access?: { id: string; secret: string } } } {
  const url = new URL(request.url)
  if (url.protocol !== 'https:' && !isLoopback(url.hostname)) {
    return edgeError('forbidden', 'The hub is reached over https only.', 403)
  }
  if (!url.pathname.startsWith(`${EDGE_MOUNT}/`)) return edgeError('not-found', 'The hub has nothing at that address.', 404)
  const cfg = edgeConfig(env, url.host)
  if ('problem' in cfg) return edgeError('server-error', `${cfg.problem} The owner finishes setting it up with wrangler.`, 503)
  const target = edgeTarget(request.url, cfg.origin)
  if (!target) return edgeError('not-found', 'The hub has nothing at that address.', 404)
  return { target, cfg }
}

/** Forward one plain HTTP request. `fetchImpl` is injected so the suites can run this under node. */
export async function forwardHttp(request: Request, env: HubEdgeEnv, fetchImpl: EdgeFetch = fetch): Promise<Response> {
  const pre = preflight(request, env)
  if (pre instanceof Response) return pre
  if (request.method !== 'GET' && request.method !== 'POST') return edgeError('not-found', 'The hub answers GET and POST only.', 404)
  const declared = Number(request.headers.get('content-length') ?? 0)
  if (declared > HUB_LIMITS.bodyBytes) return edgeError('too-large', 'That is more than the hub accepts in one request.', 413)
  let body: ArrayBuffer | undefined
  if (request.method === 'POST') {
    body = await request.arrayBuffer()
    if (body.byteLength > HUB_LIMITS.bodyBytes) return edgeError('too-large', 'That is more than the hub accepts in one request.', 413)
  }
  const headers = edgeForwardHeaders(request.headers, {
    secret: pre.cfg.secret,
    clientIp: request.headers.get('cf-connecting-ip') ?? '',
    access: pre.cfg.access
  }).filter(([k]) => !HOP_BY_HOP.has(k))
  let res: Response
  try {
    res = await fetchImpl(pre.target, { method: request.method, headers, body, redirect: 'manual' })
  } catch {
    return edgeError('server-error', 'The hub did not answer. It may be offline.', 502)
  }
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: res.headers })
}

/** A close code a WebSocket may carry: 1005, 1006 and 1015 only describe a close. */
function sendable(code: number): number {
  if (code >= 3000 && code <= 4999) return code
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code
  return 1000
}

export interface EdgeSocket {
  /** How the runtime hands a binary frame to `message`: set before `accept()`. */
  binaryType: string
  accept(): void
  send(data: string | ArrayBuffer | ArrayBufferView): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'message', fn: (e: { data: unknown }) => void): void
  addEventListener(type: 'close', fn: (e: { code: number; reason: string }) => void): void
  addEventListener(type: 'error', fn: () => void): void
}

/** A frame `send()` puts on the wire as itself: text as text, bytes as a binary frame. */
function forwardable(data: unknown): data is string | ArrayBuffer | ArrayBufferView {
  return typeof data === 'string' || data instanceof ArrayBuffer || ArrayBuffer.isView(data)
}

/**
 * Accept both ends and copy every message across unchanged, in order — text
 * as text, binary as binary — and every close across with a sendable code.
 * Exported so verify:hub-server can drive it with stand-in sockets.
 *
 * `binaryType = 'arraybuffer'` on BOTH ends, before `accept()`, is the fix for
 * the first frames this bridge ever carried (2026-10-02, scripts/hub-e2e.mts
 * against the deployed edge): since compatibility date 2026-03-17
 * (`websocket_standard_binary_type`, on by default) the runtime hands a binary
 * frame to `message` as a Blob, and `send(blob)` put the TEXT "[object Blob]"
 * on the wire. Presence (all text) worked; every relay — binary after its
 * handshake — died at its first sealed frame with 1008 "a text frame arrived
 * after the handshake", and a binary frame sent on presence reached the hub
 * as text (1007 "not JSON" where a binary frame gets 1003). `forwardable` is
 * the backstop: a frame that is neither text nor bytes closes both ends
 * rather than crossing as something it was not.
 */
export function bridgeSockets(server: EdgeSocket, upstream: EdgeSocket): void {
  upstream.binaryType = 'arraybuffer'
  server.binaryType = 'arraybuffer'
  upstream.accept()
  server.accept()
  const shut = (ws: EdgeSocket, code: number, reason: string): void => {
    try {
      ws.close(sendable(code), reason)
    } catch {
      /* already closed */
    }
  }
  const pipe = (from: EdgeSocket, to: EdgeSocket, gone: string): void => {
    from.addEventListener('message', (e) => {
      if (!forwardable(e.data)) {
        shut(from, 1011, 'the edge could not forward a frame')
        shut(to, 1011, 'the edge could not forward a frame')
        return
      }
      try {
        to.send(e.data)
      } catch {
        shut(from, 1011, gone)
      }
    })
  }
  pipe(server, upstream, 'the hub went away')
  pipe(upstream, server, 'the device went away')
  server.addEventListener('close', (e) => shut(upstream, e.code, e.reason))
  upstream.addEventListener('close', (e) => shut(server, e.code, e.reason))
  server.addEventListener('error', () => shut(upstream, 1011, 'edge error'))
  upstream.addEventListener('error', () => shut(server, 1011, 'hub error'))
}

/** Bridge a WebSocket upgrade to the origin (Workers runtime only: `WebSocketPair`, `resp.webSocket`). */
export async function forwardSocket(request: Request, env: HubEdgeEnv): Promise<Response> {
  const pre = preflight(request, env)
  if (pre instanceof Response) return pre
  const headers: [string, string][] = edgeForwardHeaders(request.headers, {
    secret: pre.cfg.secret,
    clientIp: request.headers.get('cf-connecting-ip') ?? '',
    access: pre.cfg.access
  }).filter(([k]) => !CLIENT_SOCKET_HEADERS.has(k))
  headers.push(['upgrade', 'websocket'])
  let upstreamRes: Response
  try {
    upstreamRes = await fetch(pre.target, { method: 'GET', headers })
  } catch {
    return edgeError('server-error', 'The hub did not answer. It may be offline.', 502)
  }
  const upstream = (upstreamRes as unknown as { webSocket?: EdgeSocket | null }).webSocket
  // The hub refused the upgrade (unauthorized, not-found, …): its JSON answer goes back as it is.
  if (!upstream) return new Response(upstreamRes.body, { status: upstreamRes.status, headers: upstreamRes.headers })
  const Pair = (globalThis as unknown as { WebSocketPair: new () => Record<0 | 1, EdgeSocket> }).WebSocketPair
  const pair = new Pair()
  const client = pair[0]
  const server = pair[1]
  bridgeSockets(server, upstream)
  return new Response(null, { status: 101, webSocket: client } as unknown as ResponseInit)
}

export default {
  fetch(request: Request, env: HubEdgeEnv): Promise<Response> {
    return (request.headers.get('upgrade') ?? '').toLowerCase() === 'websocket' ? forwardSocket(request, env) : forwardHttp(request, env)
  }
}
