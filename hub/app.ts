/*
 * Stoke Hub, the server: accounts and sessions, the signed device chain, the
 * wrapped vault keys, the item store, pairing, presence and the relay — built
 * exactly to the contract in src/shared/hub/ and the node:crypto reference in
 * src/main/hub/crypto.ts, imported by relative `.ts` path (gotcha 78) so this
 * runs under `node --experimental-strip-types` as it is, or bundled
 * (hub/build.mjs). Design: docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md.
 *
 * Two listeners (spec §2.3, edge.ts `edgeVerdict`):
 * - `edge` (loopback; `cloudflared`'s target): every request must carry the
 *   shared secret only the edge Worker adds, compared without an early exit.
 *   No secret configured means every request is refused: that is how a
 *   misconfiguration gets noticed.
 * - `lan` (optional; the owner's network or tailnet): no secret, the socket's
 *   IP. A request carrying Cloudflare's own headers here means a tunnel was
 *   pointed at the wrong port — the public internet reaching the listener
 *   that asks for no secret — so it is refused and logged.
 *
 * What the hub can and cannot do is the spec's §7.1: it stores ciphertext,
 * wrapped keys and a chain it cannot extend, and it never holds anything that
 * opens them. It checks everything it CAN check anyway — the chain rules
 * (it runs `verifyChain`), the put rule, the pairing commitment — so a buggy
 * or hostile client cannot poison what the other devices will read.
 *
 * Every route handler is synchronous between its reads and its writes
 * (node:sqlite is synchronous), so a compare-and-swap put or a chain append
 * cannot interleave with another. The only awaits are the body read, before
 * anything is looked at, and scrypt, whose claims are taken before it (gotcha
 * 20: the invite a signup redeems, the one-in-flight sign-in per email).
 */
import { createServer, STATUS_CODES, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import {
  BOOTSTRAP_INVITE_TTL_MS,
  EMAIL_THROTTLE,
  formatInvite,
  INVITE_BYTES,
  INVITE_TTL_MS,
  IP_THROTTLE,
  isSessionToken,
  LOCKOUT_MEMORY_MS,
  LOGIN_REFUSED,
  MAX_PASSWORD_CHARS,
  normalizeEmail,
  parseInvite,
  passwordProblem,
  recordLoginFailure,
  SESSION_PREFIX,
  SESSION_TOKEN_BYTES,
  SESSION_TOUCH_MS,
  SESSION_TTL_MS,
  throttleVerdict
} from '../src/shared/hub/auth.ts'
import {
  DEVICE_CAPS,
  deviceRecordProblem,
  MAX_LABEL_CHARS,
  verifyChain,
  wrapsRequiredAfter,
  type ChainEntry,
  type ChainVerdict,
  type DeviceRecord
} from '../src/shared/hub/chain.ts'
import { canonicalJson, idFromBytes, isB64u, isId, isNonNegInt, isRecord } from '../src/shared/hub/codec.ts'
import { edgeVerdict } from '../src/shared/hub/edge.ts'
import { isItemId, putVerdict, type ItemEnvelope, type StoredItem } from '../src/shared/hub/items.ts'
import {
  PAIR_ATTEMPTS_PER_HOUR,
  PAIR_NONCE_BYTES,
  PAIR_TTL_MS,
  pairTransition,
  revealProblem,
  type PairEvent,
  type PairRecord,
  type PairState
} from '../src/shared/hub/pairing.ts'
import {
  HUB_ERROR_STATUS,
  HUB_HEADERS,
  HUB_LIMITS,
  HUB_PROTOCOL,
  HUB_ROUTES,
  matchHubRoute,
  NONCE_MEMORY_MS,
  pathFromV1 as pathUnderMount,
  type HubAuth,
  type HubErrorBody,
  type HubErrorCode,
  type HubRouteName,
  type ItemPutResult,
  type PresenceServerFrame
} from '../src/shared/hub/protocol.ts'
import { RELAY_MAX_FRAME_BYTES } from '../src/shared/hub/relay.ts'
import {
  hashPassword,
  nodeChainCrypto,
  pairCommit,
  randomB64u,
  randomU8,
  sha256B64u,
  UNMATCHABLE_PASSWORD_HASH,
  verifyPassword,
  verifyRequest
} from '../src/main/hub/crypto.ts'
import { HubLog, LogThrottle } from './log.ts'
import { InFlight, RateBuckets, Semaphore } from './limits.ts'
import { Presence, RelayBroker, type PresenceConn } from './sockets.ts'
import { HubStore, type AccountRow, type PairRow, type Role, type SessionRow } from './store.ts'

/** The hub's own version (the protocol is `HUB_PROTOCOL`; this names the server build). */
export const HUB_SERVER_VERSION = '0.1.0'

export interface Listen {
  host: string
  port: number
}

export interface HubConfig {
  dataDir: string
  /** Where the hub is served: `/hub` behind the edge Worker, and by default on the LAN too. */
  mount: string
  /** Requires the edge secret. Null: no edge listener. */
  edge: Listen | null
  /** Asks for no secret. Null (the default): none. */
  lan: Listen | null
  edgeSecret: string | null
  /** Requests per client IP: a bucket of `capacity`, refilled at `refillPerSec`. */
  rate?: { capacity: number; refillPerSec: number }
  /** How often sockets are pinged (default `HUB_LIMITS.pingMs`); a suite sets it long and drives `ping()` itself. */
  pingMs?: number
}

export interface HubDeps {
  now?: () => number
  log?: HubLog
  /** Where the bootstrap invite is printed, as plain text (spec §3.1). */
  announce?: (text: string) => void
}

export interface HubHandle {
  edgePort: number | null
  lanPort: number | null
  /** Sweep aged rows and time out relays now, instead of on the minute (tests drive a fake clock with it). */
  tick(): void
  /** Run the socket liveness round now, as the 25 s timer does: cut what did not answer the last ping, ping the rest. */
  ping(): void
  /** Graceful: stop listening, say bye on every socket, let requests in flight finish, close the database. */
  close(): Promise<void>
}

export const DEFAULT_RATE = { capacity: 300, refillPerSec: 5 }
/** Concurrent scrypt runs (128 MiB each) and how many more may wait. */
const SCRYPT_SLOTS = 2
const SCRYPT_QUEUE = 16
/** Sign-in attempts in flight: one per email (so the throttle counts every guess), four per IP. */
const LOGIN_PER_EMAIL = 1
const LOGIN_PER_IP = 4
/** Open pairing requests one account may have at once. */
const OPEN_PAIRS_PER_ACCOUNT = 8
/** Presence frames a device may send per minute (a ping every 25 s is two). */
const PRESENCE_FRAMES_PER_MINUTE = 120
/** How long `close()` lets requests in flight finish before it cuts them. */
const DRAIN_MS = 10_000
const SWEEP_MS = 60_000

/**
 * Headers that say a request came through Cloudflare (a Worker, the tunnel)
 * or Tailscale Funnel — i.e. from the public internet. None of them belongs on
 * the LAN listener, which asks for no secret.
 */
const LAN_FORWARD_MARKS = ['cf-ray', 'cf-connecting-ip', 'cf-worker', 'tailscale-funnel-request', HUB_HEADERS.edge, HUB_HEADERS.clientIp]

/* ---------------------------------------------------------------- errors */

const DEFAULT_MESSAGE: Record<HubErrorCode, string> = {
  'bad-request': 'The hub could not read that request.',
  unauthorized: 'Sign in to the hub again.',
  forbidden: 'This device may not do that.',
  'not-found': 'The hub has nothing at that address.',
  conflict: 'That changed on the hub in the meantime.',
  'stale-epoch': 'The vault key was rotated. Fetch the new one and try again.',
  'chain-conflict': 'The device list changed on the hub. Fetch it and try again.',
  'rate-limited': 'Too many requests. Wait a moment and try again.',
  locked: 'Too many wrong passwords for this email. Try again later.',
  'too-large': 'That is more than the hub accepts in one request.',
  'invite-invalid': 'That invite is not valid on this hub: it was used, it expired, or it was mistyped.',
  'email-taken': 'An account with that email already exists on this hub.',
  'weak-password': 'Choose a longer password.',
  'bad-signature': "The hub could not verify this device's signature. Sign in again.",
  'clock-skew': "This computer's clock is more than five minutes off the hub's. Correct the time and try again.",
  replayed: 'The hub has already seen that request.',
  'edge-refused': 'The hub refused a request that did not come through its edge.',
  pending: 'This device has not joined the account yet. Approve it from a device that has.',
  offline: 'That device is not connected to the hub right now.',
  'server-error': 'The hub hit an error. Try again.'
}

export class HubError extends Error {
  readonly code: HubErrorCode
  readonly retryAfterMs: number | undefined
  constructor(code: HubErrorCode, message?: string, retryAfterMs?: number) {
    super(message ?? DEFAULT_MESSAGE[code])
    this.code = code
    this.retryAfterMs = retryAfterMs
  }
}

function errorBody(err: HubError): HubErrorBody {
  const body: HubErrorBody = { error: err.code, message: err.message }
  if (err.retryAfterMs !== undefined) body.retryAfterMs = Math.max(0, Math.ceil(err.retryAfterMs))
  return body
}

/* --------------------------------------------------------------- helpers */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff'
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  if (res.headersSent) {
    res.end()
    return
  }
  const text = JSON.stringify(body)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': String(Buffer.byteLength(text)), ...extra })
  res.end(text)
}

/** Answer a WebSocket upgrade we will not take, on the raw socket, in the same JSON shape. */
function refuseUpgrade(socket: Duplex, err: HubError): void {
  const status = HUB_ERROR_STATUS[err.code]
  const text = JSON.stringify(errorBody(err))
  const head = [
    `HTTP/1.1 ${status} ${STATUS_CODES[status] ?? 'Error'}`,
    'content-type: application/json; charset=utf-8',
    `content-length: ${Buffer.byteLength(text)}`,
    'cache-control: no-store',
    'connection: close'
  ]
  try {
    socket.end(`${head.join('\r\n')}\r\n\r\n${text}`)
  } catch {
    socket.destroy()
  }
}

/** Node hands a header as an array when it was sent twice; a signed header sent twice is not one we will guess at. */
function flatHeaders(h: IncomingMessage['headers']): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(h)) if (typeof v === 'string') out[k] = v
  return out
}

function socketIp(req: IncomingMessage): string {
  const ip = req.socket.remoteAddress ?? ''
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip
}

function queryOf(pathV1: string): URLSearchParams {
  const q = pathV1.indexOf('?')
  return new URLSearchParams(q < 0 ? '' : pathV1.slice(q + 1))
}

/** A non-negative integer query parameter, `fallback` when absent. */
function intParam(q: URLSearchParams, name: string, fallback: number): number {
  const v = q.get(name)
  if (v === null) return fallback
  if (!/^\d{1,15}$/.test(v)) throw new HubError('bad-request', `The ${name} parameter must be a whole number.`)
  return Number(v)
}

function readBody(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'])
  if (Number.isFinite(declared) && declared > max) return Promise.reject(new HubError('too-large'))
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let n = 0
    let done = false
    req.on('data', (c: Buffer) => {
      if (done) return
      n += c.length
      if (n > max) {
        done = true
        req.pause()
        reject(new HubError('too-large'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (done) return
      done = true
      resolve(Buffer.concat(chunks))
    })
    req.on('error', () => {
      if (done) return
      done = true
      reject(new HubError('bad-request', 'The request body did not arrive whole.'))
    })
  })
}

function vaultWrapProblem(w: unknown): string | null {
  if (!isRecord(w) || w.v !== 1) return 'not a vault wrap'
  if (!isB64u(w.eph, 32) || !isB64u(w.nonce, 12) || !isB64u(w.ct, 48)) return 'bad vault wrap fields'
  if (Object.keys(w).some((k) => k !== 'v' && k !== 'eph' && k !== 'nonce' && k !== 'ct')) return 'unknown vault wrap field'
  return null
}

function recoveryWrapProblem(w: unknown): string | null {
  if (!isRecord(w) || w.v !== 1) return 'not a recovery wrap'
  if (!isB64u(w.nonce, 12) || !isB64u(w.ct, 48)) return 'bad recovery wrap fields'
  if (Object.keys(w).some((k) => k !== 'v' && k !== 'nonce' && k !== 'ct')) return 'unknown recovery wrap field'
  return null
}

/** A login's device draft as the chain would record it (caps default to a desktop's), or why not. */
function draftRecord(d: unknown): DeviceRecord | string {
  if (!isRecord(d)) return 'no device'
  const rec = { id: d.id, label: d.label, platform: d.platform, sign: d.sign, box: d.box, caps: d.caps ?? [...DEVICE_CAPS], addedAt: 0 }
  return deviceRecordProblem(rec) ?? (rec as DeviceRecord)
}

function pairRecord(p: PairRow): PairRecord {
  const r: PairRecord = {
    pair: p.id,
    state: p.state as PairState,
    device: { id: p.device_id, label: p.device_label, platform: p.device_platform },
    commit: p.commit_hash,
    createdAt: p.created_at,
    expiresAt: p.expires_at
  }
  if (p.approver_json) r.approver = JSON.parse(p.approver_json)
  if (p.nonce_e) r.nonceE = p.nonce_e
  if (p.reveal_json) r.reveal = JSON.parse(p.reveal_json)
  return r
}

export function mintInvite(
  store: HubStore,
  f: { role: Role; kind: string; createdBy: string | null; now: number; ttlMs: number }
): { invite: string; expiresAt: number } {
  const invite = formatInvite(randomU8(INVITE_BYTES))
  const expiresAt = f.now + f.ttlMs
  store.insertInvite({ hash: sha256B64u(invite), role: f.role, kind: f.kind, createdBy: f.createdBy, now: f.now, expiresAt })
  return { invite, expiresAt }
}

/** The text a fresh hub prints (spec §3.1). The only place an invite is ever written out by the server. */
export function bootstrapAnnouncement(invite: string): string {
  return `stoke-hub: no accounts yet. Sign up from Stoke with this invite (valid 24 h, one use):\n  ${invite}\n`
}

/**
 * With no accounts, revoke any unused bootstrap invite and mint a fresh one.
 * Null when accounts exist (a hub that has an owner never prints one again).
 */
export function ensureBootstrapInvite(store: HubStore, now: number): { invite: string; expiresAt: number } | null {
  if (store.accountCount() > 0) return null
  store.revokeUnusedBootstrapInvites()
  return mintInvite(store, { role: 'owner', kind: 'bootstrap', createdBy: null, now, ttlMs: BOOTSTRAP_INVITE_TTL_MS })
}

/** The throttle key of an email: hashed, so the table never lists what strangers typed. */
export function emailThrottleKey(email: string): string {
  return `email:${sha256B64u(email)}`
}

/* ------------------------------------------------------------ the server */

type Listener = 'edge' | 'lan'

interface ChainState {
  entries: ChainEntry[]
  verdict: Extract<ChainVerdict, { ok: true }> | null
  /** Why a stored chain does not verify (a damaged or tampered database). */
  broken: string | null
  /** Every device id ever added, and its signing key. */
  keys: Map<string, string>
}

interface Authed {
  session: SessionRow
  tokenHash: string
  account: AccountRow
  device: string
  /** The chain's record of this device, when it is active with the key it signed in with. */
  active: DeviceRecord | null
  chain: ChainState | null
}

interface Ctx {
  rid: string
  listener: Listener
  ip: string
  route: HubRouteName | null
  auth: Authed | null
}

type Handler = (ctx: Ctx, body: Record<string, unknown>, params: Record<string, string>, pathV1: string) => unknown | Promise<unknown>

class HubServer {
  private readonly config: HubConfig
  private readonly now: () => number
  private readonly log: HubLog
  private readonly announce: (text: string) => void
  private store!: HubStore
  private readonly presence = new Presence()
  private readonly relays: RelayBroker
  private readonly buckets: RateBuckets
  private readonly scrypt = new Semaphore(SCRYPT_SLOTS, SCRYPT_QUEUE)
  private readonly loginByEmail = new InFlight(LOGIN_PER_EMAIL)
  private readonly loginByIp = new InFlight(LOGIN_PER_IP)
  private readonly refusalLog = new LogThrottle(20)
  private readonly chains = new Map<string, ChainState | null>()
  private readonly alive = new WeakMap<WebSocket, boolean>()
  /** The random payload of the last ping each socket was sent: only a pong echoing it counts. */
  private readonly pinged = new WeakMap<WebSocket, Buffer>()
  private readonly servers: { listener: Listener; server: Server }[] = []
  private readonly wssPresence: WebSocketServer
  private readonly wssRelay: WebSocketServer
  private readonly timers: ReturnType<typeof setInterval>[] = []
  private inFlight = 0
  private drained: (() => void) | null = null
  private closing = false
  private closed: Promise<void> | null = null
  private readonly handlers: Record<HubRouteName, Handler>

  constructor(config: HubConfig, deps: HubDeps) {
    this.config = { ...config, mount: config.mount.replace(/\/+$/, '') }
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? new HubLog((line) => process.stdout.write(`${line}\n`), { now: this.now })
    this.announce = deps.announce ?? ((text) => process.stdout.write(text))
    this.relays = new RelayBroker({ now: this.now, log: this.log, onResume: (ws) => this.alive.set(ws, true) })
    this.buckets = new RateBuckets(config.rate ?? DEFAULT_RATE)
    this.wssPresence = new WebSocketServer({ noServer: true, maxPayload: HUB_LIMITS.presenceFrameBytes, perMessageDeflate: false })
    this.wssRelay = new WebSocketServer({ noServer: true, maxPayload: RELAY_MAX_FRAME_BYTES, perMessageDeflate: false })
    this.handlers = {
      health: () => this.health(),
      signup: (ctx, body) => this.signup(ctx, body),
      login: (ctx, body) => this.login(ctx, body),
      logout: (ctx) => this.logout(ctx),
      account: (ctx) => this.account(ctx),
      invite: (ctx) => this.invite(ctx),
      chainGet: (ctx, _b, _p, pathV1) => this.chainGet(ctx, pathV1),
      chainAppend: (ctx, body) => this.chainAppend(ctx, body),
      wrapGet: (ctx, _b, _p, pathV1) => this.wrapGet(ctx, pathV1),
      recoveryGet: (ctx, _b, _p, pathV1) => this.recoveryGet(ctx, pathV1),
      itemsGet: (ctx, _b, _p, pathV1) => this.itemsGet(ctx, pathV1),
      itemsPut: (ctx, body) => this.itemsPut(ctx, body),
      itemsPrune: (ctx, body) => this.itemsPrune(ctx, body),
      pairCreate: (ctx, body) => this.pairCreate(ctx, body),
      pairList: (ctx) => this.pairList(ctx),
      pairGet: (ctx, _b, params) => this.pairGet(ctx, params.pair),
      pairNonce: (ctx, body, params) => this.pairNonce(ctx, body, params.pair),
      pairReveal: (ctx, body, params) => this.pairReveal(ctx, body, params.pair),
      pairRefuse: (ctx, _b, params) => this.pairRefuse(ctx, params.pair),
      relayCreate: (ctx, body) => this.relayCreate(ctx, body),
      // The two socket routes are answered in `onUpgrade`; a plain GET to one is a mistake.
      wsPresence: () => {
        throw new HubError('bad-request', 'That address takes a WebSocket.')
      },
      wsRelay: () => {
        throw new HubError('bad-request', 'That address takes a WebSocket.')
      }
    }
  }

  async start(): Promise<HubHandle> {
    this.store = HubStore.open(this.config.dataDir)
    const boot = ensureBootstrapInvite(this.store, this.now())
    if (boot) {
      this.announce(bootstrapAnnouncement(boot.invite))
      this.log.info('bootstrap invite printed', { expiresAt: new Date(boot.expiresAt).toISOString() })
    }
    const secretOk = !!this.config.edgeSecret && this.config.edgeSecret.length >= 32
    if (this.config.edge && !secretOk) {
      this.log.error('the edge listener refuses every request until HUB_EDGE_SECRET is set (32+ characters)', { listener: 'edge' })
    }
    const ports: Partial<Record<Listener, number>> = {}
    for (const [listener, at] of [
      ['edge', this.config.edge],
      ['lan', this.config.lan]
    ] as const) {
      if (!at) continue
      const server = createServer((req, res) => void this.onRequest(listener, req, res))
      server.headersTimeout = 15_000
      server.requestTimeout = 30_000
      server.keepAliveTimeout = 5_000
      server.maxHeadersCount = 64
      server.on('upgrade', (req, socket, head) => this.onUpgrade(listener, req, socket, head))
      server.on('clientError', (_err, socket) => {
        try {
          socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n')
        } catch {
          /* gone */
        }
      })
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(at.port, at.host, () => {
          server.off('error', reject)
          resolve()
        })
      })
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : at.port
      ports[listener] = port
      this.servers.push({ listener, server })
      this.log.info('listening', { listener, host: at.host, port, mount: this.config.mount || '/', refusesAll: listener === 'edge' ? !secretOk : undefined })
    }
    this.timers.push(setInterval(() => this.tick(), SWEEP_MS))
    this.timers.push(setInterval(() => this.pingAll(), this.config.pingMs ?? HUB_LIMITS.pingMs))
    for (const t of this.timers) t.unref()
    this.log.info('started', { version: HUB_SERVER_VERSION, protocol: HUB_PROTOCOL, accounts: this.store.accountCount() })
    return {
      edgePort: ports.edge ?? null,
      lanPort: ports.lan ?? null,
      tick: () => this.tick(),
      ping: () => this.pingAll(),
      close: () => this.close()
    }
  }

  /* ------------------------------------------------------ lifecycle */

  private tick(): void {
    if (this.closing) return
    const now = this.now()
    try {
      const swept = this.store.sweep({
        now,
        nonceBefore: now - NONCE_MEMORY_MS,
        throttleBefore: now - LOCKOUT_MEMORY_MS,
        pairsEndedBefore: now - 24 * 60 * 60_000
      })
      if (Object.values(swept).some((n) => n > 0)) this.log.debug('swept', swept)
    } catch (err) {
      this.log.error('sweep failed', { err })
    }
    this.buckets.sweep(now)
    this.relays.tick()
  }

  /**
   * A socket is alive while it answers our pings. Only a pong ECHOING the last
   * ping's random payload counts (RFC 6455 §5.5.3: a pong answering a ping
   * carries its data; every client library does this unasked). A pong
   * without it is allowed by the RFC and was taken as proof of life (found in
   * review, 2026-10-01): a peer that never read its side at all — the relay
   * end the hub was buffering for — could stay "alive" by sending one every
   * few seconds. It cannot echo bytes it never read.
   */
  private watchAlive(ws: WebSocket): void {
    this.alive.set(ws, true)
    ws.on('pong', (data: Buffer) => {
      const want = this.pinged.get(ws)
      if (want && data.length === want.length && data.equals(want)) this.alive.set(ws, true)
    })
  }

  /**
   * Ping every socket; one that did not answer the last ping is dead and is cut.
   * A relay end the broker PAUSED is skipped: we stopped reading it, so its
   * pong sits unread, and the end it waits on is the one being judged.
   */
  private pingAll(): void {
    for (const ws of [...this.wssPresence.clients, ...this.wssRelay.clients]) {
      if (ws.isPaused) continue
      if (this.alive.get(ws) === false) {
        ws.terminate()
        continue
      }
      this.alive.set(ws, false)
      const payload = Buffer.from(randomU8(8))
      this.pinged.set(ws, payload)
      try {
        ws.ping(payload)
      } catch {
        ws.terminate()
      }
    }
  }

  private close(): Promise<void> {
    if (this.closed) return this.closed
    this.closing = true
    this.closed = (async () => {
      this.log.info('stopping', { inFlight: this.inFlight })
      for (const t of this.timers) clearInterval(t)
      const serversClosed = this.servers.map(
        ({ server }) => new Promise<void>((resolve) => server.close(() => resolve()))
      )
      this.presence.closeAll('the hub is restarting', 1001)
      this.relays.closeAll(1001, 'the hub is restarting')
      if (this.inFlight > 0) {
        await new Promise<void>((resolve) => {
          const cut = setTimeout(resolve, DRAIN_MS)
          this.drained = () => {
            clearTimeout(cut)
            resolve()
          }
        })
      }
      for (const { server } of this.servers) server.closeAllConnections()
      // A socket whose peer never answers the close frame is cut after a moment.
      await new Promise((resolve) => setTimeout(resolve, 250))
      for (const ws of [...this.wssPresence.clients, ...this.wssRelay.clients]) ws.terminate()
      this.wssPresence.close()
      this.wssRelay.close()
      await Promise.race([Promise.all(serversClosed), new Promise((resolve) => setTimeout(resolve, 2000))])
      this.store.close()
      this.log.info('stopped', {})
    })()
    return this.closed
  }

  /* ---------------------------------------------------- the front door */

  /** Which IP this request is from, once the listener has taken it. */
  private frontDoor(listener: Listener, headers: Record<string, string | undefined>, ip: string): string {
    if (listener === 'lan' && LAN_FORWARD_MARKS.some((h) => headers[h] !== undefined)) {
      if (this.refusalLog.allow('lan-forwarded', this.now(), this.log)) {
        this.log.error('a request forwarded by Cloudflare reached the LAN listener; point cloudflared at the edge listener', { ip })
      }
      throw new HubError('edge-refused', 'This address is for your own network. Requests through Cloudflare must reach the hub’s edge listener.')
    }
    const v = edgeVerdict({ listener, secret: this.config.edgeSecret, headers, socketIp: ip })
    if (!v.ok) throw new HubError('edge-refused')
    return v.clientIp
  }

  private rateLimit(ip: string): void {
    const r = this.buckets.take(`ip:${ip}`, this.now())
    if (!r.ok) throw new HubError('rate-limited', undefined, r.retryAfterMs)
  }

  private chainState(account: string): ChainState | null {
    if (this.chains.has(account)) return this.chains.get(account) ?? null
    const rows = this.store.chainRows(account)
    if (rows.length === 0) {
      this.chains.set(account, null)
      return null
    }
    const entries = rows.map((r) => JSON.parse(r.entry_json) as ChainEntry)
    const verdict = verifyChain(entries, nodeChainCrypto, { account })
    const state: ChainState = { entries, verdict: verdict.ok ? verdict : null, broken: verdict.ok ? null : `${verdict.at}: ${verdict.reason}`, keys: keysOf(entries) }
    if (!verdict.ok) this.log.error('a stored device chain does not verify', { account, at: verdict.at, why: verdict.reason })
    this.chains.set(account, state)
    return state
  }

  /**
   * The session, the device's signature over this exact request, a nonce
   * never seen from that device, and — for `active`/`owner` routes — a chain
   * that lists this device WITH THE KEY IT SIGNED IN WITH (gotcha 140). `login`
   * already refuses an id the chain binds to another key; this is for the id
   * the chain did NOT list yet: a password-holder signs in under it first, the
   * real device joins with its own keys, and by id alone the squatter's
   * session would then be taken for that device.
   */
  private authenticate(need: HubAuth, method: string, pathV1: string, headers: Record<string, string | undefined>, body: Buffer): Authed | null {
    if (need === 'public') return null
    const m = /^Bearer (\S+)$/.exec(headers.authorization ?? '')
    const token = m?.[1]
    if (!token || !isSessionToken(token)) throw new HubError('unauthorized')
    const now = this.now()
    const tokenHash = sha256B64u(token)
    const session = this.store.session(tokenHash)
    if (!session || session.expires_at <= now) throw new HubError('unauthorized', 'Your hub session ended. Sign in again.')
    const v = verifyRequest({ method, pathFromV1: pathV1, headers, body, signPub: session.sign_pub, device: session.device_id, now })
    if (!v.ok) throw new HubError(v.error)
    if (!this.store.rememberNonce(session.device_id, v.nonce, now)) throw new HubError('replayed')
    if (now - session.seen_at >= SESSION_TOUCH_MS) this.store.touchSession(tokenHash, now, now + SESSION_TTL_MS)
    const account = this.store.accountById(session.account_id)
    if (!account || account.status !== 'active') throw new HubError('unauthorized')
    const chain = this.chainState(account.id)
    const active = chain?.verdict?.active.find((d) => d.id === session.device_id && d.sign === session.sign_pub) ?? null
    if ((need === 'active' || need === 'owner') && !active) throw new HubError('pending')
    if (need === 'owner' && account.role !== 'owner') throw new HubError('forbidden', 'Only the hub’s owner may do that.')
    return { session, tokenHash, account, device: session.device_id, active, chain }
  }

  /* -------------------------------------------------------- requests */

  private async onRequest(listener: Listener, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = this.now()
    const ctx: Ctx = { rid: randomB64u(6), listener, ip: socketIp(req), route: null, auth: null }
    this.inFlight++
    let status = 200
    let code: HubErrorCode | null = null
    try {
      if (this.closing) throw new HubError('server-error', 'The hub is restarting. Try again in a moment.')
      const body = await this.handle(ctx, req)
      sendJson(res, 200, body)
    } catch (err) {
      const e = err instanceof HubError ? err : new HubError('server-error')
      if (!(err instanceof HubError)) this.log.error('request failed', { rid: ctx.rid, route: ctx.route, err })
      status = HUB_ERROR_STATUS[e.code]
      code = e.code
      const extra: Record<string, string> = {}
      if (e.retryAfterMs !== undefined) extra['retry-after'] = String(Math.max(1, Math.ceil(e.retryAfterMs / 1000)))
      if (e.code === 'too-large' || this.closing) extra.connection = 'close'
      sendJson(res, status, errorBody(e), extra)
    } finally {
      this.inFlight--
      if (this.inFlight === 0 && this.drained) this.drained()
      this.logRequest(ctx, req.method ?? '', status, code, this.now() - started)
    }
  }

  private logRequest(ctx: Ctx, method: string, status: number, code: HubErrorCode | null, ms: number): void {
    const fields = {
      rid: ctx.rid,
      listener: ctx.listener,
      ip: ctx.ip,
      method,
      route: ctx.route,
      status,
      error: code ?? undefined,
      ms,
      account: ctx.auth?.account.id,
      device: ctx.auth?.device
    }
    // A stranger's refusals (no route matched, no session) are rate-limited in the log.
    if (code && !ctx.auth && !this.refusalLog.allow(`refused:${ctx.ip}`, this.now(), this.log)) return
    this.log.info('request', fields)
  }

  private async handle(ctx: Ctx, req: IncomingMessage): Promise<unknown> {
    const raw = req.url ?? ''
    if (!raw.startsWith('/')) throw new HubError('not-found')
    const headers = flatHeaders(req.headers)
    ctx.ip = this.frontDoor(ctx.listener, headers, ctx.ip)
    this.rateLimit(ctx.ip)
    const pathV1 = pathUnderMount(raw, this.config.mount)
    if (pathV1 === null) throw new HubError('not-found')
    const match = matchHubRoute(req.method ?? '', pathV1)
    if (!match) throw new HubError('not-found')
    ctx.route = match.name
    const body = await readBody(req, HUB_LIMITS.bodyBytes)
    let json: Record<string, unknown> = {}
    if (req.method === 'POST' && body.length > 0) {
      if (!/^application\/json\b/i.test(headers['content-type'] ?? '')) throw new HubError('bad-request', 'The hub takes JSON.')
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        throw new HubError('bad-request', 'That body is not JSON.')
      }
      if (!isRecord(parsed)) throw new HubError('bad-request', 'That body is not a JSON object.')
      json = parsed
    }
    ctx.auth = this.authenticate(HUB_ROUTES[match.name].auth, req.method ?? '', pathV1, headers, body)
    return await this.handlers[match.name](ctx, json, match.params, pathV1)
  }

  /* -------------------------------------------------------- sockets */

  private onUpgrade(listener: Listener, req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => {})
    const ctx: Ctx = { rid: randomB64u(6), listener, ip: socketIp(req), route: null, auth: null }
    try {
      if (this.closing) throw new HubError('server-error', 'The hub is restarting. Try again in a moment.')
      const raw = req.url ?? ''
      if (!raw.startsWith('/')) throw new HubError('not-found')
      const headers = flatHeaders(req.headers)
      ctx.ip = this.frontDoor(listener, headers, ctx.ip)
      this.rateLimit(ctx.ip)
      const pathV1 = pathUnderMount(raw, this.config.mount)
      const match = pathV1 === null ? null : matchHubRoute(req.method ?? '', pathV1)
      if (!match || pathV1 === null) throw new HubError('not-found')
      ctx.route = match.name
      const route = HUB_ROUTES[match.name] as { ws?: true; auth: HubAuth }
      if (!route.ws) throw new HubError('bad-request', 'That address does not take a WebSocket.')
      const auth = this.authenticate(route.auth, 'GET', pathV1, headers, Buffer.alloc(0)) as Authed
      ctx.auth = auth
      if (match.name === 'wsPresence') {
        this.wssPresence.handleUpgrade(req, socket, head, (ws) => this.presenceOpened(ws, auth))
      } else {
        const relay = this.relays.get(auth.account.id, match.params.relay)
        if (!relay) throw new HubError('not-found', 'That relay is not open (it expired, closed, or is not yours).')
        const role = this.relays.roleOf(relay, auth.device)
        if (!role) throw new HubError('forbidden', 'This device is not an end of that relay.')
        if (!this.relays.canJoin(relay, role)) throw new HubError('conflict', 'That end of the relay is already connected.')
        this.wssRelay.handleUpgrade(req, socket, head, (ws) => {
          this.watchAlive(ws)
          this.relays.join(relay, role, ws)
        })
      }
      this.logRequest(ctx, 'GET', 101, null, 0)
    } catch (err) {
      const e = err instanceof HubError ? err : new HubError('server-error')
      if (!(err instanceof HubError)) this.log.error('upgrade failed', { rid: ctx.rid, err })
      this.logRequest(ctx, req.method ?? '', HUB_ERROR_STATUS[e.code], e.code, 0)
      refuseUpgrade(socket, e)
    }
  }

  private presenceOpened(ws: WebSocket, auth: Authed): void {
    const conn: PresenceConn = { ws, account: auth.account.id, device: auth.device, tokenHash: auth.tokenHash, app: '' }
    this.watchAlive(ws)
    this.presence.add(conn)
    let windowStart = this.now()
    let frames = 0
    ws.on('message', (data: RawData, isBinary: boolean) => {
      const now = this.now()
      if (now - windowStart >= 60_000) {
        windowStart = now
        frames = 0
      }
      if (++frames > PRESENCE_FRAMES_PER_MINUTE) {
        ws.close(1008, 'too many frames')
        return
      }
      if (isBinary) {
        ws.close(1003, 'presence frames are JSON text')
        return
      }
      let f: unknown
      try {
        f = JSON.parse(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))
      } catch {
        ws.close(1007, 'not JSON')
        return
      }
      if (!isRecord(f)) return
      if (f.t === 'ping') this.presence.send(conn.account, conn.device, { t: 'pong' })
      else if (f.t === 'hello') conn.app = typeof f.app === 'string' ? f.app.slice(0, 40) : ''
    })
    ws.on('close', () => {
      if (this.presence.remove(conn)) this.presence.broadcast(conn.account, { t: 'presence', online: this.presence.online(conn.account) })
    })
    ws.on('error', () => {})
    const online = this.presence.online(conn.account)
    this.presence.send(conn.account, conn.device, { t: 'welcome', device: conn.device, online })
    this.presence.broadcast(conn.account, { t: 'presence', online }, conn.device)
  }

  private push(account: string, frame: PresenceServerFrame, except?: string): void {
    this.presence.broadcast(account, frame, except)
  }

  /* --------------------------------------------------- the routes */

  private health(): unknown {
    return { ok: true, server: 'stoke-hub', protocol: HUB_PROTOCOL, version: HUB_SERVER_VERSION, needsBootstrap: this.store.accountCount() === 0 }
  }

  private ipGate(ip: string): string {
    const key = `ip:${ip}`
    const v = throttleVerdict(this.store.throttle(key), this.now())
    if (!v.ok) throw new HubError('rate-limited', 'Too many failed attempts from this address. Try again later.', v.retryAfterMs)
    return key
  }

  private ipFailure(key: string): void {
    this.store.saveThrottle(key, recordLoginFailure(this.store.throttle(key), this.now(), IP_THROTTLE))
  }

  private async scryptSlot(): Promise<() => void> {
    const slot = this.scrypt.acquire()
    if (!slot) throw new HubError('rate-limited', 'The hub is busy checking passwords. Try again in a moment.', 2000)
    return slot
  }

  private async signup(ctx: Ctx, body: Record<string, unknown>): Promise<unknown> {
    const ipKey = this.ipGate(ctx.ip)
    const email = normalizeEmail(body.email)
    if (!email) throw new HubError('bad-request', 'That is not an email address.')
    const weak = passwordProblem(body.password)
    if (weak) throw new HubError('weak-password', weak)
    const password = body.password as string
    const invite = parseInvite(body.invite)
    const accountId = idFromBytes('account', randomU8(10))
    const hash = invite ? sha256B64u(invite) : ''
    // The claim, taken before the await: a second signup with this invite finds it used.
    const claimed = invite ? this.store.claimInvite(hash, accountId, this.now()) : null
    if (!claimed) {
      this.ipFailure(ipKey)
      throw new HubError('invite-invalid')
    }
    if (this.store.accountByEmail(email)) {
      this.store.releaseInvite(hash, accountId)
      throw new HubError('email-taken')
    }
    let pwHash: string
    try {
      const release = await this.scryptSlot()
      try {
        pwHash = await hashPassword(password)
      } finally {
        release()
      }
    } catch (err) {
      this.store.releaseInvite(hash, accountId)
      throw err
    }
    try {
      this.store.insertAccount({ id: accountId, email, pwHash, role: claimed.role, now: this.now() })
    } catch {
      // Another signup took the email while this one hashed: the UNIQUE constraint is the referee.
      this.store.releaseInvite(hash, accountId)
      throw new HubError('email-taken')
    }
    this.log.info('account created', { account: accountId, role: claimed.role, via: claimed.kind })
    return { accountId, role: claimed.role }
  }

  private async login(ctx: Ctx, body: Record<string, unknown>): Promise<unknown> {
    const email = normalizeEmail(body.email)
    if (!email) throw new HubError('bad-request', 'That is not an email address.')
    if (typeof body.password !== 'string' || body.password.length === 0 || body.password.length > MAX_PASSWORD_CHARS * 4) {
      throw new HubError('bad-request', 'Enter a password.')
    }
    const draft = draftRecord(body.device)
    if (typeof draft === 'string') throw new HubError('bad-request', `This device's keys are not usable: ${draft}.`)
    const emailKey = emailThrottleKey(email)
    const locked = throttleVerdict(this.store.throttle(emailKey), this.now())
    if (!locked.ok) throw new HubError('locked', undefined, locked.retryAfterMs)
    const ipKey = this.ipGate(ctx.ip)
    // Claims before the await (gotcha 20): one attempt per email in flight, a few per IP.
    const releaseEmail = this.loginByEmail.claim(emailKey)
    if (!releaseEmail) throw new HubError('rate-limited', 'A sign-in for this email is already being checked.', 1000)
    const releaseIp = this.loginByIp.claim(ipKey)
    if (!releaseIp) {
      releaseEmail()
      throw new HubError('rate-limited', undefined, 1000)
    }
    try {
      const account = this.store.accountByEmail(email)
      let good: boolean
      const release = await this.scryptSlot()
      try {
        // An unknown email costs one scrypt too, so timing names no account (spec §3.2).
        good = await verifyPassword(body.password, account?.pw_hash ?? UNMATCHABLE_PASSWORD_HASH)
      } finally {
        release()
      }
      if (!good || !account || account.status !== 'active') {
        const now = this.now()
        this.store.saveThrottle(emailKey, recordLoginFailure(this.store.throttle(emailKey), now, EMAIL_THROTTLE))
        this.ipFailure(ipKey)
        throw new HubError('unauthorized', LOGIN_REFUSED)
      }
      this.store.clearThrottle(emailKey)
      const chain = this.chainState(account.id)
      if (chain) {
        if (chain.verdict?.revoked.includes(draft.id)) {
          throw new HubError('forbidden', 'This device was removed from the account. Stoke has to make it a new identity to join again.')
        }
        const known = chain.keys.get(draft.id)
        if (known !== undefined && known !== draft.sign) throw new HubError('forbidden', 'That device id belongs to another key in this account.')
      }
      const now = this.now()
      const token = SESSION_PREFIX + randomB64u(SESSION_TOKEN_BYTES)
      const expiresAt = now + SESSION_TTL_MS
      this.store.insertSession({
        token_hash: sha256B64u(token),
        account_id: account.id,
        device_id: draft.id,
        sign_pub: draft.sign,
        box_pub: draft.box,
        label: draft.label,
        platform: draft.platform,
        created_at: now,
        seen_at: now,
        expires_at: expiresAt
      })
      const active = chain?.verdict?.active.some((d) => d.id === draft.id && d.sign === draft.sign) ?? false
      const state = !chain ? 'new-account' : active ? 'active' : 'pending'
      this.log.info('signed in', { account: account.id, device: draft.id, state })
      return { token, accountId: account.id, expiresAt, state }
    } finally {
      releaseEmail()
      releaseIp()
    }
  }

  private logout(ctx: Ctx): unknown {
    const a = ctx.auth as Authed
    this.store.deleteSession(a.tokenHash)
    this.presence.kickSession(a.tokenHash, 'signed out', 1000)
    return { ok: true }
  }

  private account(ctx: Ctx): unknown {
    const a = ctx.auth as Authed
    const v = a.chain?.verdict
    return { accountId: a.account.id, email: a.account.email, role: a.account.role, chain: v ? { seq: v.seq, head: v.head, epoch: v.epoch } : null }
  }

  private invite(ctx: Ctx): unknown {
    const a = ctx.auth as Authed
    const { invite, expiresAt } = mintInvite(this.store, { role: 'member', kind: 'owner', createdBy: a.account.id, now: this.now(), ttlMs: INVITE_TTL_MS })
    this.log.info('invite minted', { account: a.account.id })
    return { invite, expiresAt }
  }

  private chainGet(ctx: Ctx, pathV1: string): unknown {
    const a = ctx.auth as Authed
    const q = queryOf(pathV1)
    const since = q.has('since') ? intParam(q, 'since', 0) : -1
    return { entries: (a.chain?.entries ?? []).filter((e) => e.seq > since) }
  }

  /**
   * Append entries to the account's chain, with the wraps the new state needs,
   * all or nothing (spec §4.3, §4.6; protocol.ts `ChainAppendRequest`).
   *
   * The hub runs `verifyChain` over stored + new: it cannot sign anything, but
   * it can refuse what no honest device would have signed, so a broken append
   * never reaches the devices that will verify it. After it, every active
   * vault device must hold a wrap for the chain's epoch, and the Recovery Kit
   * too — stored already or in this request — so no remaining device is ever
   * left without the key (a revoke or rotate must bring them all).
   *
   * Wraps are written ONCE and never replaced, and only a member may hand any
   * out (found in review, 2026-10-01). Both writes used to be upserts, and any
   * append — a plain `add` included — could carry a wrap for every active
   * device plus a recovery wrap: an active device could overwrite the others'
   * keys and the Kit's (the Kit would then open nothing, silently), and since
   * this route takes a PENDING session, a password holder republishing old
   * entries after a restore (spec §7.3) could attach wraps of their own for
   * every device (box keys are public) before an honest device did. So: a
   * wrap for a device or the Kit that already has one at this epoch must be
   * byte-identical (a harmless repeat) or it is a conflict; and only a device
   * active before or after these entries, by id AND the key it signed in with
   * (gotcha 140), may supply any. A pending session may still post bare
   * entries — whose wraps must then already be here. The chain's `vk`
   * commitments (verifyChain) are the other half: a planted key is refused
   * by every device even if it were ever stored.
   */
  private chainAppend(ctx: Ctx, body: Record<string, unknown>): unknown {
    const a = ctx.auth as Authed
    const account = a.account.id
    const entries = body.entries
    if (!Array.isArray(entries) || entries.length === 0) throw new HubError('bad-request', 'Send at least one chain entry.')
    const stored = a.chain?.entries ?? []
    if (a.chain?.broken) throw new HubError('server-error', 'The device list stored on this hub does not verify. Restore it before changing it.')
    if (stored.length + entries.length > HUB_LIMITS.chainEntries) throw new HubError('too-large', 'This account’s device list is as long as a hub keeps.')
    const first = entries[0]
    if (!isRecord(first) || first.seq !== stored.length) throw new HubError('chain-conflict')
    const all = [...stored, ...entries]
    const verdict = verifyChain(all, nodeChainCrypto, { account })
    if (!verdict.ok) throw new HubError('bad-request', `Chain entry ${verdict.at} is not acceptable: ${verdict.reason}.`)
    if (stored.length === 0) {
      const g = entries[0] as ChainEntry
      if (g.device?.id !== a.device || g.device.sign !== a.session.sign_pub) {
        throw new HubError('forbidden', 'Only the device that signed in may start its account’s device list.')
      }
    }
    if (verdict.active.length > HUB_LIMITS.activeDevices) throw new HubError('too-large', 'This account has as many devices as a hub allows.')

    const required = wrapsRequiredAfter(verdict)
    const w = body.wraps
    const wraps = new Map<string, unknown>()
    let recovery: unknown = null
    if (w !== undefined) {
      if (!isRecord(w) || w.epoch !== verdict.epoch || !Array.isArray(w.devices)) {
        throw new HubError('bad-request', `Wraps must be for epoch ${verdict.epoch}, the epoch these entries leave the account in.`)
      }
      for (const d of w.devices) {
        if (!isRecord(d) || !isId('device', d.device)) throw new HubError('bad-request', 'A wrap names no device.')
        if (!required.includes(d.device)) throw new HubError('bad-request', `A wrap is for ${d.device}, which will not be an active device.`)
        if (wraps.has(d.device)) throw new HubError('bad-request', `Two wraps for ${d.device}.`)
        const p = vaultWrapProblem(d.wrap)
        if (p) throw new HubError('bad-request', `The wrap for ${d.device}: ${p}.`)
        wraps.set(d.device, d.wrap)
      }
      if (w.recovery !== undefined) {
        const p = recoveryWrapProblem(w.recovery)
        if (p) throw new HubError('bad-request', `The recovery wrap: ${p}.`)
        recovery = w.recovery
      }
    }
    if (wraps.size > 0 || recovery !== null) {
      const memberAfter = verdict.active.some((d) => d.id === a.device && d.sign === a.session.sign_pub)
      if (!a.active && !memberAfter) {
        throw new HubError('forbidden', 'Only a device of this account may hand out its vault key. Post the entries without wraps.')
      }
    }
    for (const [device, wrap] of [...wraps]) {
      const stored = this.store.wrap(account, verdict.epoch, device)
      if (stored === null) continue
      if (stored !== canonicalJson(wrap)) {
        throw new HubError('conflict', `${device} already holds its vault key for epoch ${verdict.epoch}, and the hub never replaces one.`)
      }
      wraps.delete(device)
    }
    if (recovery !== null) {
      const stored = this.store.recovery(account, verdict.epoch)
      if (stored !== null && stored !== canonicalJson(recovery)) {
        throw new HubError('conflict', `The Recovery Kit already holds the vault key for epoch ${verdict.epoch}, and the hub never replaces it.`)
      }
      if (stored !== null) recovery = null
    }
    const missing = required.filter((d) => !wraps.has(d) && this.store.wrap(account, verdict.epoch, d) === null)
    if (missing.length > 0) throw new HubError('bad-request', `The vault key for epoch ${verdict.epoch} is not wrapped to ${missing.join(', ')}.`)
    if (recovery === null && this.store.recovery(account, verdict.epoch) === null) {
      throw new HubError('bad-request', `The vault key for epoch ${verdict.epoch} is not wrapped to the Recovery Kit.`)
    }

    const added = entries as ChainEntry[]
    this.store.tx(() => {
      for (const e of added) this.store.insertChainRow(account, e.seq, canonicalJson(e), verdict.links[e.seq])
      for (const [device, wrap] of wraps) {
        if (!this.store.insertWrap(account, verdict.epoch, device, canonicalJson(wrap))) throw new HubError('conflict', `${device} already holds its vault key for epoch ${verdict.epoch}.`)
      }
      if (recovery !== null && !this.store.insertRecovery(account, verdict.epoch, canonicalJson(recovery))) {
        throw new HubError('conflict', `The Recovery Kit already holds the vault key for epoch ${verdict.epoch}.`)
      }
    })
    this.chains.set(account, { entries: all as ChainEntry[], verdict, broken: null, keys: keysOf(all as ChainEntry[]) })

    for (const e of added) {
      if (e.kind === 'revoke' && e.target) {
        const ended = this.store.deleteDeviceSessions(account, e.target)
        this.presence.kickDevice(account, e.target, 'this device was removed from the account', 1008)
        this.relays.closeDevice(account, e.target, 1008, 'a device was removed')
        this.log.info('device revoked', { account, device: e.target, sessions: ended, epoch: e.epoch })
      }
      if (e.kind === 'add' && e.device) this.approvePairsFor(account, e.device)
    }
    this.log.info('chain appended', { account, seq: verdict.seq, epoch: verdict.epoch, kinds: added.map((e) => e.kind) })
    this.push(account, { t: 'chain', seq: verdict.seq, head: verdict.head })
    return { seq: verdict.seq, head: verdict.head, epoch: verdict.epoch }
  }

  private wrapGet(ctx: Ctx, pathV1: string): unknown {
    const a = ctx.auth as Authed
    const epoch = intParam(queryOf(pathV1), 'epoch', a.chain?.verdict?.epoch ?? 0)
    const wrap = this.store.wrap(a.account.id, epoch, a.device)
    if (!wrap) throw new HubError('not-found', `No vault key for this device at epoch ${epoch}.`)
    return { epoch, wrap: JSON.parse(wrap) }
  }

  private recoveryGet(ctx: Ctx, pathV1: string): unknown {
    const a = ctx.auth as Authed
    const epoch = intParam(queryOf(pathV1), 'epoch', a.chain?.verdict?.epoch ?? 0)
    const wrap = this.store.recovery(a.account.id, epoch)
    if (!wrap) throw new HubError('not-found', `No Recovery Kit wrap at epoch ${epoch}.`)
    return { epoch, wrap: JSON.parse(wrap) }
  }

  private itemsGet(ctx: Ctx, pathV1: string): unknown {
    const a = ctx.auth as Authed
    const q = queryOf(pathV1)
    const since = intParam(q, 'since', 0)
    const limit = Math.max(1, Math.min(HUB_LIMITS.itemsPerPage, intParam(q, 'limit', HUB_LIMITS.itemsPerPage)))
    const rows = this.store.itemsSince(a.account.id, since, limit + 1)
    const page = rows.slice(0, limit)
    const items: StoredItem[] = page.map((r) => ({ envelope: JSON.parse(r.envelope_json) as ItemEnvelope, seq: r.seq }))
    return { items, next: page.length ? page[page.length - 1].seq : since, more: rows.length > limit, epoch: a.chain?.verdict?.epoch ?? 0 }
  }

  /** Compare-and-swap puts (`putVerdict`), each decided on its own, in one transaction. */
  private itemsPut(ctx: Ctx, body: Record<string, unknown>): unknown {
    const a = ctx.auth as Authed
    const account = a.account.id
    const puts = body.puts
    if (!Array.isArray(puts) || puts.length === 0) throw new HubError('bad-request', 'Send at least one put.')
    if (puts.length > HUB_LIMITS.putsPerRequest) throw new HubError('too-large', `At most ${HUB_LIMITS.putsPerRequest} puts in one request.`)
    const epoch = a.chain?.verdict?.epoch ?? 0
    const results: ItemPutResult[] = []
    let lastSeq = 0
    this.store.tx(() => {
      let count = this.store.itemCount(account)
      for (const put of puts) {
        const env = isRecord(put) && isRecord(put.envelope) ? put.envelope : null
        const id = env && typeof env.id === 'string' && isItemId(env.id) ? env.id : ''
        const current = id ? this.store.item(account, id) : null
        const verdict = putVerdict(current ? { version: current.version } : null, epoch, isRecord(put) ? { baseVersion: put.baseVersion, envelope: put.envelope } : { baseVersion: null, envelope: null }, a.device)
        if (!verdict.ok) {
          if (verdict.error === 'conflict') {
            if (current) results.push({ id, ok: false, error: 'conflict', current: { envelope: JSON.parse(current.envelope_json), seq: current.seq } })
            else results.push({ id, ok: false, error: 'invalid', reason: 'the hub holds nothing at that id: put it with baseVersion 0' })
          } else if (verdict.error === 'stale-epoch') results.push({ id, ok: false, error: 'stale-epoch', epoch })
          else results.push({ id, ok: false, error: 'invalid', reason: verdict.reason })
          continue
        }
        if (!current && count >= HUB_LIMITS.itemsPerAccount) {
          results.push({ id, ok: false, error: 'invalid', reason: `an account holds at most ${HUB_LIMITS.itemsPerAccount} items` })
          continue
        }
        const e = put.envelope as ItemEnvelope
        const seq = this.store.nextItemSeq(account)
        this.store.putItem(account, { id, version: e.version, epoch: e.epoch, envelope_json: canonicalJson(e), seq })
        if (!current) count++
        lastSeq = seq
        results.push({ id, ok: true, version: e.version, seq })
      }
    })
    if (lastSeq > 0) this.push(account, { t: 'items', seq: lastSeq }, a.device)
    return { results }
  }

  private itemsPrune(ctx: Ctx, body: Record<string, unknown>): unknown {
    const a = ctx.auth as Authed
    const epoch = a.chain?.verdict?.epoch ?? 0
    if (!isNonNegInt(body.epochBelow) || body.epochBelow < 1) throw new HubError('bad-request', 'epochBelow must be a whole number from 1.')
    if (body.epochBelow > epoch) throw new HubError('bad-request', `The current epoch is ${epoch}; its items cannot be pruned.`)
    const pruned = this.store.pruneItems(a.account.id, body.epochBelow)
    this.log.info('items pruned', { account: a.account.id, epochBelow: body.epochBelow, pruned })
    return { pruned }
  }

  /* ------------------------------------------------------- pairing */

  /** The pair, expired first if its time ran out while nobody looked. */
  private loadPair(account: string, id: string): PairRow {
    const p = this.store.pair(account, id)
    if (!p) throw new HubError('not-found', 'No such pairing request.')
    if (this.now() >= p.expires_at && pairTransition(p.state as PairState, 'expire')) {
      this.movePair(p, 'expire')
    }
    return p
  }

  private movePair(p: PairRow, event: PairEvent): void {
    const next = pairTransition(p.state as PairState, event)
    if (!next) throw new HubError('conflict', `That pairing request is ${p.state}.`)
    p.state = next
    if (next === 'approved' || next === 'refused' || next === 'expired') p.ended_at = this.now()
    this.store.updatePair(p)
    this.push(p.account_id, { t: 'pair', pair: p.id, state: next })
  }

  /**
   * Whether this session opened pair `p`: the same device id AND the signing
   * key the session signed in with (gotcha 140). By id alone, a password
   * holder signed in under a real device's not-yet-listed id could read that
   * device's pair, refuse it (a mismatched reveal refuses it too), expire it by
   * opening one of its own, and run up the id's refusal count until the real
   * device is locked out of pairing for the hour — again every hour.
   */
  private ownsPair(a: Authed, p: PairRow): boolean {
    return p.device_id === a.device && p.device_sign === a.session.sign_pub
  }

  /** An `add` for a device with a revealed pair approves that pair, if the keys are the revealed ones. */
  private approvePairsFor(account: string, device: DeviceRecord): void {
    for (const p of this.store.openPairsFor(account, device.id, device.sign)) {
      if (p.state !== 'revealed' || !p.reveal_json) continue
      const r = JSON.parse(p.reveal_json) as { device: DeviceRecord }
      if (r.device.sign === device.sign && r.device.box === device.box) this.movePair(p, 'approve')
    }
  }

  private pairCreate(ctx: Ctx, body: Record<string, unknown>): unknown {
    const a = ctx.auth as Authed
    const account = a.account.id
    const now = this.now()
    if (!isB64u(body.commit, 32)) throw new HubError('bad-request', 'A pairing request carries a commitment.')
    const d = body.device
    if (!isRecord(d) || d.id !== a.device) throw new HubError('bad-request', 'A pairing request names the device that sends it.')
    if (typeof d.label !== 'string' || d.label.trim() === '' || [...d.label].length > MAX_LABEL_CHARS) throw new HubError('bad-request', 'Name this device.')
    if (typeof d.platform !== 'string' || !/^[a-z0-9]{1,24}$/.test(d.platform)) throw new HubError('bad-request', 'Unknown platform.')
    if (!a.chain?.verdict) throw new HubError('conflict', 'This account has no device that could approve one yet.')
    if (a.active) throw new HubError('conflict', 'This device has already joined.')
    const sign = a.session.sign_pub
    if (this.store.refusedPairsSince(account, a.device, sign, now - 60 * 60_000) >= PAIR_ATTEMPTS_PER_HOUR) {
      throw new HubError('rate-limited', 'Three pairing attempts from this device were refused this hour.', 60 * 60_000)
    }
    for (const old of this.store.openPairsFor(account, a.device, sign)) this.movePair(old, 'expire')
    if (this.store.openPairs(account).length >= OPEN_PAIRS_PER_ACCOUNT) throw new HubError('rate-limited', 'Too many pairing requests are open for this account.')
    const p: PairRow = {
      id: idFromBytes('pair', randomU8(10)),
      account_id: account,
      device_id: a.device,
      device_sign: sign,
      device_label: d.label.trim(),
      device_platform: d.platform,
      state: 'waiting',
      commit_hash: body.commit,
      approver_json: null,
      nonce_e: null,
      reveal_json: null,
      created_at: now,
      expires_at: now + PAIR_TTL_MS,
      ended_at: null
    }
    this.store.insertPair(p)
    this.push(account, { t: 'pair', pair: p.id, state: 'waiting' })
    this.log.info('pair requested', { account, device: a.device, pair: p.id })
    return { pair: p.id, expiresAt: p.expires_at }
  }

  private pairList(ctx: Ctx): unknown {
    const a = ctx.auth as Authed
    const now = this.now()
    const pairs = this.store
      .openPairs(a.account.id)
      .filter((p) => {
        if (now < p.expires_at) return true
        this.movePair(p, 'expire')
        return false
      })
      .map(pairRecord)
    return { pairs }
  }

  /** A pending device sees only the pair it opened (id AND key, `ownsPair`); an active one, any of the account's. */
  private visiblePair(a: Authed, id: string): PairRow {
    const p = this.loadPair(a.account.id, id)
    if (!a.active && !this.ownsPair(a, p)) throw new HubError('not-found', 'No such pairing request.')
    return p
  }

  private pairGet(ctx: Ctx, id: string): unknown {
    return pairRecord(this.visiblePair(ctx.auth as Authed, id))
  }

  private pairNonce(ctx: Ctx, body: Record<string, unknown>, id: string): unknown {
    const a = ctx.auth as Authed
    const p = this.loadPair(a.account.id, id)
    if (!isB64u(body.nonce, PAIR_NONCE_BYTES)) throw new HubError('bad-request', 'A pairing nonce is 32 random bytes.')
    const me = a.active as DeviceRecord
    p.approver_json = JSON.stringify({ id: me.id, sign: me.sign, box: me.box, label: me.label })
    p.nonce_e = body.nonce
    this.movePair(p, 'nonce')
    return pairRecord(p)
  }

  private pairReveal(ctx: Ctx, body: Record<string, unknown>, id: string): unknown {
    const a = ctx.auth as Authed
    const p = this.visiblePair(a, id)
    if (!this.ownsPair(a, p)) throw new HubError('forbidden', 'Only the device asking to join reveals.')
    if (!pairTransition(p.state as PairState, 'reveal')) throw new HubError('conflict', `That pairing request is ${p.state}.`)
    const shape = deviceRecordProblem(body.device)
    if (shape) throw new HubError('bad-request', `The revealed device: ${shape}.`)
    if (!isB64u(body.nonce, PAIR_NONCE_BYTES)) throw new HubError('bad-request', 'A pairing nonce is 32 random bytes.')
    const device = body.device as DeviceRecord
    const nonce = body.nonce
    const problem =
      revealProblem({
        commit: p.commit_hash,
        commitDigest: pairCommit({ account: a.account.id, device, nonce }),
        device,
        nonce,
        pendingDevice: p.device_id
      }) ?? (device.sign !== a.session.sign_pub || device.box !== a.session.box_pub ? 'the reveal names keys this device did not sign in with' : null)
    if (problem) {
      this.movePair(p, 'refuse')
      this.log.warn('pair refused at reveal', { account: a.account.id, pair: p.id, why: problem })
      throw new HubError('bad-request', `The pairing request was refused: ${problem}.`)
    }
    p.reveal_json = JSON.stringify({ device, nonce })
    this.movePair(p, 'reveal')
    return pairRecord(p)
  }

  private pairRefuse(ctx: Ctx, id: string): unknown {
    const a = ctx.auth as Authed
    const p = this.visiblePair(a, id)
    this.movePair(p, 'refuse')
    this.log.info('pair refused', { account: a.account.id, pair: p.id, by: a.device })
    return pairRecord(p)
  }

  /* --------------------------------------------------------- relays */

  private relayCreate(ctx: Ctx, body: Record<string, unknown>): unknown {
    const a = ctx.auth as Authed
    const account = a.account.id
    const host = body.host
    if (!isId('device', host)) throw new HubError('bad-request', 'Name the device to attach to.')
    if (host === a.device) throw new HubError('bad-request', 'A device cannot attach to itself.')
    const hostRec = a.chain?.verdict?.active.find((d) => d.id === host)
    if (!hostRec) throw new HubError('not-found', 'That device is not in this account.')
    if (!hostRec.caps.includes('remote-host')) throw new HubError('forbidden', 'That device does not take remote attaches.')
    if (!(a.active as DeviceRecord).caps.includes('remote-guest')) throw new HubError('forbidden', 'This device may not attach to others.')
    if (!this.presence.isOnline(account, host)) throw new HubError('offline')
    const relay = this.relays.create(idFromBytes('relay', randomU8(15)), account, a.device, host)
    if (!relay) throw new HubError('rate-limited', 'This account already has as many remote connections open as a hub allows.')
    this.presence.send(account, host, { t: 'relay', relay: relay.id, guest: a.device })
    this.log.info('relay requested', { account, relay: relay.id, guest: a.device, host })
    return { relay: relay.id, expiresAt: relay.expiresAt }
  }
}

function keysOf(entries: readonly ChainEntry[]): Map<string, string> {
  const m = new Map<string, string>()
  for (const e of entries) if ((e.kind === 'genesis' || e.kind === 'add') && e.device) m.set(e.device.id, e.device.sign)
  return m
}

/** Open the data directory, print the bootstrap invite if there is no account, and listen. */
export async function startHub(config: HubConfig, deps: HubDeps = {}): Promise<HubHandle> {
  return new HubServer(config, deps).start()
}
