/*
 * The wire contract between Stoke and a Stoke Hub: routes, bodies, headers,
 * errors, limits, the presence socket's frames, and the text every request
 * signature covers.
 *
 * The server (on the owner's NUC), the client (Stoke's main process) and the
 * relay are built against THIS file; a route or field that is not here does
 * not exist. Paths are relative to the hub base URL (`hub.url`, e.g.
 * `https://stoke.vinn.dev/hub`) and always start with `/v1/`, so a reverse
 * proxy may mount the hub anywhere and no signature ever covers the mount.
 *
 * Pure (gotcha 27). Design: docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md.
 */
import type { ChainEntry, DeviceRecord } from './chain.ts'
import { isRecord, labelled } from './codec.ts'
import type { ItemEnvelope, StoredItem } from './items.ts'
import { HUB_LABELS } from './labels.ts'
import type { PairRecord } from './pairing.ts'

export const HUB_PROTOCOL = 1
export const HUB_API_PREFIX = '/v1'

/* ------------------------------------------------------------- headers */

export const HUB_HEADERS = {
  device: 'x-stoke-device',
  ts: 'x-stoke-ts',
  nonce: 'x-stoke-nonce',
  sig: 'x-stoke-sig',
  /** Set only by the edge Worker; the hub's edge listener requires it (edge.ts). */
  edge: 'x-stoke-hub-edge',
  /** Set only by the edge Worker: the visitor's IP (from `CF-Connecting-IP`). */
  clientIp: 'x-stoke-client-ip'
} as const

/** A request whose `x-stoke-ts` is further than this from the hub's clock is refused (`clock-skew`). */
export const REQUEST_SKEW_MS = 5 * 60_000
/** A nonce is remembered per device this long (`replayed`). Must exceed 2 × REQUEST_SKEW_MS. */
export const NONCE_MEMORY_MS = 10 * 60_000
export const REQUEST_NONCE_BYTES = 16

/**
 * What a device signs for one request (spec §3.4). `pathFromV1` is the path
 * and query exactly as sent, from `/v1/` on; `bodySha256` is b64url SHA-256
 * of the body bytes (of the empty string for none). Every field is a string
 * or an integer, so any language rebuilds the same bytes.
 */
export function requestSigningText(f: {
  method: string
  pathFromV1: string
  ts: number
  nonce: string
  device: string
  bodySha256: string
}): string {
  return labelled(HUB_LABELS.request, {
    method: f.method.toUpperCase(),
    path: f.pathFromV1,
    ts: f.ts,
    nonce: f.nonce,
    device: f.device,
    body: f.bodySha256
  })
}

/**
 * The part of a request path a signature covers: from the first `/v1/`
 * after the mount on. `mount` is where the hub is served (`/hub` behind the
 * edge, whatever a reverse proxy chose otherwise). Null when the path is not
 * under the mount at all.
 */
export function pathFromV1(pathAndQuery: string, mount: string): string | null {
  const m = mount.replace(/\/+$/, '')
  if (!pathAndQuery.startsWith(`${m}/v1/`)) return null
  return pathAndQuery.slice(m.length)
}

/* -------------------------------------------------------------- limits */

export const HUB_LIMITS = {
  /** Any request body. */
  bodyBytes: 1024 * 1024,
  /** Puts in one `POST /v1/items`. */
  putsPerRequest: 100,
  /** Live items (tombstones included) per account. */
  itemsPerAccount: 5000,
  /** Items per page of the change feed. */
  itemsPerPage: 500,
  /** Chain entries per account (a long life of devices). */
  chainEntries: 1000,
  /** Active devices per account. */
  activeDevices: 32,
  /** One presence frame. */
  presenceFrameBytes: 64 * 1024,
  /**
   * One sealed presence status, as JSON (`SealedStatus`): a device's session
   * summary for its other devices. Well under a frame, so the hub can forward
   * it inside one with room for the envelope.
   */
  statusBytes: 24 * 1024,
  /** Presence and relay sockets ping this often, so nothing on the path sees them idle (spec §2.2). */
  pingMs: 25_000
} as const

/* -------------------------------------------------------------- errors */

export type HubErrorCode =
  | 'bad-request'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'stale-epoch'
  | 'chain-conflict'
  | 'rate-limited'
  | 'locked'
  | 'too-large'
  | 'invite-invalid'
  | 'email-taken'
  | 'weak-password'
  | 'bad-signature'
  | 'clock-skew'
  | 'replayed'
  | 'edge-refused'
  | 'pending'
  | 'offline'
  | 'server-error'
  /** `POST /v1/auth/verify`: the password typed is not the account's. Never `unauthorized`, which signs a device out. */
  | 'wrong-password'
  /** `POST /v1/auth/verify`: this device's own counter (`VERIFY_THROTTLE`) is locked. */
  | 'throttled'

export const HUB_ERROR_STATUS: Record<HubErrorCode, number> = {
  'bad-request': 400,
  unauthorized: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  'stale-epoch': 409,
  'chain-conflict': 409,
  'rate-limited': 429,
  locked: 429,
  'too-large': 413,
  'invite-invalid': 400,
  'email-taken': 409,
  'weak-password': 400,
  'bad-signature': 401,
  'clock-skew': 401,
  replayed: 401,
  'edge-refused': 403,
  pending: 403,
  offline: 409,
  'server-error': 500,
  'wrong-password': 401,
  throttled: 429
}

/** Every non-2xx body. `message` is a sentence the panel may show as is. */
export interface HubErrorBody {
  error: HubErrorCode
  message: string
  retryAfterMs?: number
}

export function isHubErrorBody(v: unknown): v is HubErrorBody {
  return isRecord(v) && typeof v.error === 'string' && v.error in HUB_ERROR_STATUS && typeof v.message === 'string'
}

/**
 * Read a hub response, refusing anything that is not the hub BEFORE parsing
 * (gotcha 71): a Cloudflare challenge or a captive portal answers HTML with
 * status 200, and a wrong URL answers somebody else's JSON. Every hub answer
 * is `application/json` holding an object; an error is a `HubErrorBody`.
 */
export function readHubResponse(
  status: number,
  contentType: string | null,
  text: string
): { ok: true; status: number; body: Record<string, unknown> } | { ok: false; status: number; error: HubErrorBody } {
  const notHub = (message: string): { ok: false; status: number; error: HubErrorBody } => ({
    ok: false,
    status,
    error: { error: 'server-error', message }
  })
  if (!/^application\/json\b/i.test(contentType ?? '')) {
    return notHub(
      /html/i.test(contentType ?? '')
        ? `That address answered with a web page (HTTP ${status}), not a Stoke hub — a Cloudflare challenge, a sign-in page, or the wrong URL.`
        : `That address did not answer like a Stoke hub (HTTP ${status}, ${contentType ?? 'no content type'}).`
    )
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return notHub(`That address sent JSON it could not finish (HTTP ${status}).`)
  }
  if (!isRecord(body)) return notHub('That address did not answer like a Stoke hub.')
  if (status >= 200 && status < 300) return { ok: true, status, body }
  if (isHubErrorBody(body)) return { ok: false, status, error: body }
  return notHub(`That address refused the request (HTTP ${status}) without saying why like a Stoke hub would.`)
}

/* -------------------------------------------------------------- routes */

/**
 * Who may call a route.
 * - `public`: anyone (the edge secret still applies on the edge listener).
 * - `session`: a valid session and device signature; the device may be pending.
 * - `active`: the device must be active in the account's chain.
 * - `owner`: an active device of an account with role 'owner'.
 */
export type HubAuth = 'public' | 'session' | 'active' | 'owner'

export interface HubRoute {
  method: 'GET' | 'POST'
  /** From `/v1/`; `:name` matches one segment. */
  path: string
  auth: HubAuth
  /** A WebSocket upgrade (a GET). */
  ws?: true
}

export const HUB_ROUTES = {
  health: { method: 'GET', path: '/v1/health', auth: 'public' },
  signup: { method: 'POST', path: '/v1/auth/signup', auth: 'public' },
  login: { method: 'POST', path: '/v1/auth/login', auth: 'public' },
  logout: { method: 'POST', path: '/v1/auth/logout', auth: 'session' },
  authVerify: { method: 'POST', path: '/v1/auth/verify', auth: 'active' },
  account: { method: 'GET', path: '/v1/account', auth: 'session' },
  invite: { method: 'POST', path: '/v1/auth/invites', auth: 'owner' },
  chainGet: { method: 'GET', path: '/v1/chain', auth: 'session' },
  chainAppend: { method: 'POST', path: '/v1/chain', auth: 'session' },
  wrapGet: { method: 'GET', path: '/v1/vault/wrap', auth: 'active' },
  recoveryGet: { method: 'GET', path: '/v1/vault/recovery', auth: 'session' },
  itemsGet: { method: 'GET', path: '/v1/items', auth: 'active' },
  itemsPut: { method: 'POST', path: '/v1/items', auth: 'active' },
  itemsPrune: { method: 'POST', path: '/v1/items/prune', auth: 'active' },
  pairCreate: { method: 'POST', path: '/v1/pair', auth: 'session' },
  pairList: { method: 'GET', path: '/v1/pair', auth: 'active' },
  pairGet: { method: 'GET', path: '/v1/pair/:pair', auth: 'session' },
  pairNonce: { method: 'POST', path: '/v1/pair/:pair/nonce', auth: 'active' },
  pairReveal: { method: 'POST', path: '/v1/pair/:pair/reveal', auth: 'session' },
  pairRefuse: { method: 'POST', path: '/v1/pair/:pair/refuse', auth: 'session' },
  relayCreate: { method: 'POST', path: '/v1/relays', auth: 'active' },
  wsPresence: { method: 'GET', path: '/v1/ws/presence', auth: 'active', ws: true },
  wsRelay: { method: 'GET', path: '/v1/ws/relay/:relay', auth: 'active', ws: true }
} as const satisfies Record<string, HubRoute>

export type HubRouteName = keyof typeof HUB_ROUTES

/** The route a request names, with its `:params`, or null (404). `pathFromV1` may carry a query. */
export function matchHubRoute(method: string, pathFromV1: string): { name: HubRouteName; params: Record<string, string> } | null {
  const pathname = pathFromV1.split('?', 1)[0]
  const got = pathname.split('/')
  for (const [name, r] of Object.entries(HUB_ROUTES) as [HubRouteName, HubRoute][]) {
    if (r.method !== method.toUpperCase()) continue
    const want = r.path.split('/')
    if (want.length !== got.length) continue
    const params: Record<string, string> = {}
    let ok = true
    for (let i = 0; i < want.length; i++) {
      if (want[i].startsWith(':')) {
        if (!/^[a-z0-9]{1,40}$/.test(got[i])) {
          ok = false
          break
        }
        params[want[i].slice(1)] = got[i]
      } else if (want[i] !== got[i]) {
        ok = false
        break
      }
    }
    if (ok) return { name, params }
  }
  return null
}

/* -------------------------------------------------------------- bodies */

/** A device before the chain lists it: what login and pairing carry. */
export type DeviceDraft = Omit<DeviceRecord, 'addedAt' | 'caps'> & { caps?: DeviceRecord['caps'] }

export interface HealthResponse {
  ok: true
  server: 'stoke-hub'
  protocol: typeof HUB_PROTOCOL
  /** The hub's own version string. */
  version: string
  /** True until the first account exists (the bootstrap invite is in the hub's log). */
  needsBootstrap: boolean
}

export interface SignupRequest {
  invite: string
  email: string
  password: string
}
export interface SignupResponse {
  accountId: string
  role: 'owner' | 'member'
}

/**
 * `POST /v1/auth/login`. A device the account's chain already lists as active
 * SHOULD sign it like any request (the four `x-stoke-*` headers of spec §3.4,
 * no bearer, by the key the chain holds for `device.id`): the hub then judges
 * the attempt by that device's own lockout (`DEVICE_THROTTLE`), which only
 * its key can trip, instead of the email's, which anyone who knows the address
 * can. A proof that does not verify — or a device the chain does not list — is
 * simply not a proof: the email's lockout applies, and nothing says why.
 */
export interface LoginRequest {
  email: string
  password: string
  /** This device's public keys: the session is bound to them (spec §3.4). */
  device: DeviceDraft
}
export interface LoginResponse {
  token: string
  accountId: string
  expiresAt: number
  /**
   * `new-account`: no chain yet — this device should create the genesis.
   * `pending`: a chain exists and does not list this device — pair or recover.
   * `active`: the chain lists this device.
   */
  state: 'new-account' | 'pending' | 'active'
}

/**
 * `POST /v1/auth/verify` (spec 2026-10-03 §2): "confirm it's you" on a device
 * already in the vault, before it lets its other devices in to something. The
 * password is checked against the account's hash and nothing else happens: no
 * session is minted, nothing is written but this device's own failure counter
 * (`VERIFY_THROTTLE`, keyed by account and device, never the sign-in
 * counters). Answers `{ ok: true }`, 401 `wrong-password`, or 429 `throttled`
 * with `retryAfterMs`.
 */
export interface VerifyPasswordRequest {
  password: string
}
export interface VerifyPasswordResponse {
  ok: true
}

export interface AccountResponse {
  accountId: string
  email: string
  role: 'owner' | 'member'
  /** The chain's current epoch and head, or null before genesis. */
  chain: { seq: number; head: string; epoch: number } | null
}

export interface InviteResponse {
  invite: string
  expiresAt: number
}

/** `GET /v1/chain?since=<seq>`: entries with seq > since (all when absent). */
export interface ChainResponse {
  entries: ChainEntry[]
}

/**
 * A vault key wrapped to one device (crypto.ts `wrapVaultKey`). Anyone can
 * make one for a public box key, so it is trusted only once the key inside
 * matches the epoch's commitment in the verified chain (`ChainEntry.vk`).
 */
export interface VaultWrap {
  v: 1
  /** b64url ephemeral X25519 public key. */
  eph: string
  nonce: string
  ct: string
}

/** The vault key wrapped by the Recovery Kit (crypto.ts `sealRecoveryWrap`). */
export interface RecoveryWrap {
  v: 1
  nonce: string
  ct: string
}

/**
 * `POST /v1/chain`: entries to append (in order, extending the hub's head),
 * with the wraps the last one needs, applied together or not at all.
 * - genesis: `wraps` for epoch 1 = the genesis device, plus `recovery`.
 * - add: `wraps` for the current epoch = the added device.
 * - revoke/rotate: `wraps` for the new epoch = every device active after it
 *   (`wrapsRequiredAfter`), plus `recovery`.
 * A wrap is stored once and never replaced: one for a device (or the Kit)
 * that already holds one at that epoch must be byte-identical, else 409
 * `conflict`. Only a device active before or after the entries — by id AND
 * the key it signed in with — may supply any (else 403 `forbidden`); a
 * pending session may post bare entries only.
 * Republishing after a restore (spec §7.3) is the same call with entries the
 * hub no longer has, plus — from a device those entries leave active — the
 * wraps the restored hub lacks for any epoch they open.
 */
export interface ChainAppendRequest {
  entries: ChainEntry[]
  wraps?: { epoch: number; devices: { device: string; wrap: VaultWrap }[]; recovery?: RecoveryWrap }
}
export interface ChainAppendResponse {
  seq: number
  head: string
  epoch: number
}

/** `GET /v1/vault/wrap?epoch=<n>`: the calling device's wrap (the current epoch when absent). */
export interface WrapResponse {
  epoch: number
  wrap: VaultWrap
}

/** `GET /v1/vault/recovery?epoch=<n>`: useless without the Kit, so a pending device may fetch it. */
export interface RecoveryResponse {
  epoch: number
  wrap: RecoveryWrap
}

/** `GET /v1/items?since=<seq>&limit=<n>`. */
export interface ItemsResponse {
  items: StoredItem[]
  /** Pass as `since` next. */
  next: number
  more: boolean
  /** The account's current epoch, so a client notices a rotation it missed. */
  epoch: number
}

export interface ItemsPutRequest {
  puts: { baseVersion: number; envelope: ItemEnvelope }[]
}
export type ItemPutResult =
  | { id: string; ok: true; version: number; seq: number }
  | { id: string; ok: false; error: 'conflict'; current: StoredItem }
  | { id: string; ok: false; error: 'stale-epoch'; epoch: number }
  | { id: string; ok: false; error: 'invalid'; reason: string }
export interface ItemsPutResponse {
  results: ItemPutResult[]
}

/** `POST /v1/items/prune`: delete every envelope sealed under an epoch below this (after a rotation re-sealed them). */
export interface ItemsPruneRequest {
  epochBelow: number
}

export interface PairCreateRequest {
  /** b64url SHA-256 of `pairCommitText` (pairing.ts). */
  commit: string
  device: { id: string; label: string; platform: string }
}
export interface PairCreateResponse {
  pair: string
  expiresAt: number
}
export interface PairListResponse {
  pairs: PairRecord[]
}
export interface PairNonceRequest {
  nonce: string
}
export interface PairRevealRequest {
  device: DeviceRecord
  nonce: string
}

export interface RelayCreateRequest {
  host: string
}
export interface RelayCreateResponse {
  relay: string
  expiresAt: number
}

/* ------------------------------------------------------------ presence */

/**
 * A device's presence status — what it tells its OTHER devices about itself
 * and, if its owner allowed it there, its sessions — sealed under the current
 * epoch's presence key (crypto.ts `sealStatus`, AAD `presenceStatusAad`). The
 * hub keeps the last one per connected device in memory, forwards it to the
 * account's other devices, and cannot read it: the plaintext is
 * `RemoteStatus` (src/shared/hub/remote.ts).
 */
export interface SealedStatus {
  v: 1
  epoch: number
  /** b64url, 12 random bytes. */
  nonce: string
  /** b64url AES-256-GCM ciphertext, tag appended. */
  ct: string
}

/** Why `v` is not a sealed status the hub may forward, or null. Judged on shape and size only. */
export function sealedStatusProblem(v: unknown): string | null {
  if (!isRecord(v) || v.v !== 1) return 'not a sealed status'
  if (typeof v.epoch !== 'number' || !Number.isSafeInteger(v.epoch) || v.epoch < 1) return 'bad epoch'
  if (typeof v.nonce !== 'string' || !/^[A-Za-z0-9_-]{16}$/.test(v.nonce)) return 'bad nonce'
  if (typeof v.ct !== 'string' || !/^[A-Za-z0-9_-]{22,}$/.test(v.ct)) return 'bad ciphertext'
  if (Object.keys(v).some((k) => k !== 'v' && k !== 'epoch' && k !== 'nonce' && k !== 'ct')) return 'unknown fields'
  if (JSON.stringify(v).length > HUB_LIMITS.statusBytes) return 'too large'
  return null
}

/** Hub → device on `/v1/ws/presence`. Hints only: a client re-reads state on every (re)connect. */
export type PresenceServerFrame =
  | { t: 'welcome'; device: string; online: string[] }
  | { t: 'presence'; online: string[] }
  | { t: 'items'; seq: number }
  | { t: 'chain'; seq: number; head: string }
  | { t: 'pair'; pair: string; state: PairRecord['state'] }
  | { t: 'relay'; relay: string; guest: string }
  /** Another device's latest sealed status (null: it withdrew it), after `welcome` and whenever it sends one. */
  | { t: 'status'; device: string; status: SealedStatus | null }
  | { t: 'bye'; reason: string }
  | { t: 'pong' }

/** Device → hub on `/v1/ws/presence`. `status` replaces this device's last one (null withdraws it). */
export type PresenceClientFrame =
  | { t: 'hello'; protocol: number; app: string }
  | { t: 'ping' }
  | { t: 'status'; status: SealedStatus | null }

/** A client frame the hub acts on, or null (ignored). A `status` must pass `sealedStatusProblem`. */
export function parsePresenceClientFrame(v: unknown): PresenceClientFrame | null {
  if (!isRecord(v)) return null
  switch (v.t) {
    case 'hello':
      return { t: 'hello', protocol: typeof v.protocol === 'number' ? v.protocol : 0, app: typeof v.app === 'string' ? v.app.slice(0, 40) : '' }
    case 'ping':
      return { t: 'ping' }
    case 'status':
      if (v.status === null) return { t: 'status', status: null }
      return sealedStatusProblem(v.status) === null ? { t: 'status', status: v.status as unknown as SealedStatus } : null
    default:
      return null
  }
}

export function parsePresenceServerFrame(text: string): PresenceServerFrame | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(v)) return null
  const strings = (x: unknown): boolean => Array.isArray(x) && x.every((s) => typeof s === 'string')
  switch (v.t) {
    case 'welcome':
      return typeof v.device === 'string' && strings(v.online) ? (v as unknown as PresenceServerFrame) : null
    case 'presence':
      return strings(v.online) ? (v as unknown as PresenceServerFrame) : null
    case 'items':
      return typeof v.seq === 'number' ? (v as unknown as PresenceServerFrame) : null
    case 'chain':
      return typeof v.seq === 'number' && typeof v.head === 'string' ? (v as unknown as PresenceServerFrame) : null
    case 'pair':
      return typeof v.pair === 'string' && typeof v.state === 'string' ? (v as unknown as PresenceServerFrame) : null
    case 'relay':
      return typeof v.relay === 'string' && typeof v.guest === 'string' ? (v as unknown as PresenceServerFrame) : null
    case 'status':
      return typeof v.device === 'string' && (v.status === null || sealedStatusProblem(v.status) === null)
        ? { t: 'status', device: v.device, status: v.status as SealedStatus | null }
        : null
    case 'bye':
      return typeof v.reason === 'string' ? (v as unknown as PresenceServerFrame) : null
    case 'pong':
      return { t: 'pong' }
    default:
      return null
  }
}

/** Reconnect delay after `attempt` failures: 1 s doubling to 60 s, with ±20% jitter from `random01`. */
export function reconnectDelayMs(attempt: number, random01: number): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 6)))
  return Math.round(base * (0.8 + 0.4 * Math.min(1, Math.max(0, random01))))
}
