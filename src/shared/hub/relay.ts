/*
 * Remote between the owner's own devices, through a hub relay.
 *
 * The hub pairs one guest socket with one host socket and forwards frames it
 * cannot read. Inside, a SIGMA-style handshake between device keys the chain
 * vouches for derives one AES-256-GCM key per direction; after it, every
 * frame is ciphertext, and the plaintext is the phone API Stoke already
 * serves (`src/main/remote/server.ts`'s contract): request/response pairs for
 * `/api/*` and the `/ws/events` and pty sockets' own frames.
 *
 * The HOST decides who may attach: a grant per requesting device, kept on
 * the host alone (T0), `view` or `full`; the first attach asks. This module
 * is the frame shapes, the transcript texts, the nonce and AAD layout, the
 * routes a relay may carry and the grant rule. Pure (gotcha 27).
 *
 * Design: docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md §6.
 */
import { b64uDecode, canonicalJson, isB64u, isId, isRecord, labelled, utf8 } from './codec.ts'
import { HUB_LABELS } from './labels.ts'

/* ---------------------------------------------------------- handshake */

export const RELAY_NONCE_BYTES = 32

/** Guest → host, in the clear: who, to whom, and the guest's ephemeral key. */
export interface RelayHs1 {
  t: 'hs1'
  v: 1
  relay: string
  account: string
  guest: string
  host: string
  /** b64url X25519 ephemeral public key. */
  eph: string
  /** b64url, RELAY_NONCE_BYTES. */
  nonce: string
}

/** Host → guest: its ephemeral key and a signature over the transcript. */
export interface RelayHs2 {
  t: 'hs2'
  v: 1
  eph: string
  nonce: string
  /** Ed25519 by the host's device key over `relayHs2Text(th)`. */
  sig: string
}

/** Guest → host: the guest's signature, binding the host's. */
export interface RelayHs3 {
  t: 'hs3'
  sig: string
}

export function hs1Problem(v: unknown, expect: { relay: string; account: string; host?: string }): string | null {
  if (!isRecord(v) || v.t !== 'hs1' || v.v !== 1) return 'not hs1'
  if (v.relay !== expect.relay) return 'another relay'
  if (v.account !== expect.account) return 'another account'
  if (!isId('device', v.guest) || !isId('device', v.host)) return 'bad device ids'
  if (expect.host !== undefined && v.host !== expect.host) return 'addressed to another host'
  if (v.guest === v.host) return 'a device cannot attach to itself'
  if (!isB64u(v.eph, 32) || !isB64u(v.nonce, RELAY_NONCE_BYTES)) return 'bad key or nonce'
  return null
}

export function hs2Problem(v: unknown): string | null {
  if (!isRecord(v) || v.t !== 'hs2' || v.v !== 1) return 'not hs2'
  if (!isB64u(v.eph, 32) || !isB64u(v.nonce, RELAY_NONCE_BYTES) || !isB64u(v.sig, 64)) return 'bad fields'
  return null
}

export function hs3Problem(v: unknown): string | null {
  if (!isRecord(v) || v.t !== 'hs3' || !isB64u(v.sig, 64)) return 'not hs3'
  return null
}

/** Hashed (SHA-256) into `th`: hs1 whole and hs2 without its signature. */
export function relayTranscriptText(hs1: RelayHs1, hs2: Omit<RelayHs2, 'sig'>): string {
  const { ...h2 } = hs2 as Record<string, unknown>
  delete h2.sig
  return `${HUB_LABELS.relayTranscript}\n${canonicalJson(hs1)}\n${canonicalJson(h2)}`
}

/** The host signs this. `th` is b64url of the transcript hash. */
export function relayHs2Text(th: string): string {
  return labelled(HUB_LABELS.relayHs2, { th })
}

/** The guest signs this: the transcript and the host's own signature. */
export function relayHs3Text(th: string, hs2Sig: string): string {
  return labelled(HUB_LABELS.relayHs3, { th, hs2: hs2Sig })
}

/** HKDF info for the 64 bytes that split into g2h (first 32) and h2g (last 32); salt is `th`'s bytes. */
export const RELAY_KEYS_INFO = HUB_LABELS.relayKeys

/* -------------------------------------------------------------- frames */

/** Direction bytes: the first byte of every frame nonce. */
export const RELAY_DIR = { g2h: 1, h2g: 2 } as const
export type RelayDir = keyof typeof RELAY_DIR

/** Ciphertext bytes per frame, tag included. The hub closes a relay that sends more. */
export const RELAY_MAX_FRAME_BYTES = 1024 * 1024
/** A relay is closed (and a new one asked for) before a direction's counter reaches this. */
export const RELAY_MAX_COUNTER = 2 ** 40
/** The hub closes a relay that forwarded no frame for this long (its WebSocket pings do not count). */
export const RELAY_IDLE_MS = 10 * 60_000
/**
 * A guest sends an inner `ping` this often while its channel is open, well
 * under `RELAY_IDLE_MS`: a remote tab on a quiet session (Claude at its
 * prompt, the owner reading) otherwise sends nothing, and the hub would close
 * it as idle every ten minutes, dropping keys typed during the reconnect.
 */
export const RELAY_PING_MS = 4 * 60_000
/** No `pong` within this after a ping: the other end is not serving the channel, and the guest closes it. */
export const RELAY_PONG_WAIT_MS = 60_000
export const RELAY_OPEN_TTL_MS = 60_000
export const RELAYS_PER_ACCOUNT = 8
/** How long the host's "let this device in?" question waits before it refuses. */
export const RELAY_ASK_MS = 60_000

/** `dir(1) ‖ 00 00 00 ‖ counter(8, big-endian)`: never repeats under one key. */
export function relayNonce(dir: RelayDir, counter: number): Uint8Array {
  if (!Number.isSafeInteger(counter) || counter < 0 || counter >= RELAY_MAX_COUNTER) {
    throw new RangeError('relay counter out of range')
  }
  const n = new Uint8Array(12)
  n[0] = RELAY_DIR[dir]
  let c = counter
  for (let i = 11; i >= 4; i--) {
    n[i] = c % 256
    c = Math.floor(c / 256)
  }
  return n
}

/** GCM additional data for every frame of one relay in one direction. */
export function relayFrameAad(relay: string, dir: RelayDir): Uint8Array {
  return utf8(labelled(HUB_LABELS.relayFrame, { relay, dir }))
}

/* ---------------------------------------------------- the inner frames */

export type RelayMode = 'view' | 'full'

/**
 * What travels inside the encrypted channel, as JSON.
 *
 * - `attach` (guest, the first frame after `hs3`): the session this relay is
 *   for. The host's question — "Let <device> open <session>?" — names it, and
 *   an "Allow once" answer is scoped to it (`relayScopeVerdict`, remote.ts).
 * - `ready`/`refused` (host): the answer. Nothing else is served before `ready`.
 * - `part`: a piece of the JSON text of the NEXT frame, every piece but the
 *   last carrying `more: true` (`relayFrameParts`). A pty's `attached` frame
 *   replays up to 512 K characters of scrollback and a transcript can be
 *   megabytes, which JSON inside JSON takes past the hub's 1 MiB frame cap;
 *   the receiver joins the pieces and parses the whole as one frame. A part
 *   never holds a part.
 * - `status` (host, once serving): the attached session's model, effort,
 *   context and usage, as the host's own status bar reads them
 *   (`RemoteSessionStatus`, remote.ts). The guest parses it as text another
 *   machine chose; a host never takes one from a guest.
 */
export type RelayInnerFrame =
  | { t: 'attach'; ptyId: string }
  | { t: 'ready'; mode: RelayMode; host: { label: string; platform: string } }
  | { t: 'refused'; reason: string }
  | { t: 'status'; status: unknown }
  | { t: 'req'; id: number; method: 'GET' | 'POST'; path: string; body?: unknown }
  | { t: 'res'; id: number; status: number; body: unknown }
  | { t: 'ws-open'; id: number; path: string }
  | { t: 'ws-msg'; id: number; data: string }
  | { t: 'ws-close'; id: number; code?: number; reason?: string }
  | { t: 'part'; data: string; more?: true }
  | { t: 'ping' }
  | { t: 'pong' }

/**
 * The most UTF-16 units of frame text one `part` carries. A unit is at most
 * three UTF-8 bytes, and escaping it again as JSON at most doubles an ASCII
 * one, so a part stays under ~600 KB sealed: inside `RELAY_MAX_FRAME_BYTES`.
 */
export const RELAY_CHUNK_CHARS = 200 * 1024
/** The most one joined frame may grow to before the relay is closed: past any real reply. */
export const RELAY_MAX_MESSAGE_CHARS = 16 * 1024 * 1024

/** One frame's JSON text as what goes on the wire: itself when small, else its parts in order. */
export function relayFrameParts(text: string): string[] {
  if (text.length <= RELAY_CHUNK_CHARS) return [text]
  const out: string[] = []
  for (let at = 0; at < text.length; at += RELAY_CHUNK_CHARS) {
    const data = text.slice(at, at + RELAY_CHUNK_CHARS)
    out.push(JSON.stringify(at + RELAY_CHUNK_CHARS < text.length ? { t: 'part', data, more: true } : { t: 'part', data }))
  }
  return out
}

const PTY_ID_RE = /^[A-Za-z0-9_-]{1,80}$/

/** A pty id as the phone API spells one. */
export function isPtyId(v: unknown): v is string {
  return typeof v === 'string' && PTY_ID_RE.test(v)
}

export function parseRelayInner(text: string): RelayInnerFrame | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(v) || typeof v.t !== 'string') return null
  const id = (x: unknown): boolean => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0
  switch (v.t) {
    case 'attach':
      return isPtyId(v.ptyId) ? { t: 'attach', ptyId: v.ptyId } : null
    case 'ready':
      return (v.mode === 'view' || v.mode === 'full') && isRecord(v.host) ? (v as unknown as RelayInnerFrame) : null
    case 'refused':
      return typeof v.reason === 'string' ? (v as unknown as RelayInnerFrame) : null
    case 'status':
      return isRecord(v.status) ? { t: 'status', status: v.status } : null
    case 'req':
      return id(v.id) && (v.method === 'GET' || v.method === 'POST') && typeof v.path === 'string'
        ? (v as unknown as RelayInnerFrame)
        : null
    case 'res':
      return id(v.id) && typeof v.status === 'number' ? (v as unknown as RelayInnerFrame) : null
    case 'ws-open':
      return id(v.id) && typeof v.path === 'string' ? (v as unknown as RelayInnerFrame) : null
    case 'ws-msg':
      return id(v.id) && typeof v.data === 'string' ? (v as unknown as RelayInnerFrame) : null
    case 'part':
      if (typeof v.data !== 'string' || (v.more !== undefined && v.more !== true)) return null
      return v.more ? { t: 'part', data: v.data, more: true } : { t: 'part', data: v.data }
    case 'ws-close':
      return id(v.id) ? (v as unknown as RelayInnerFrame) : null
    case 'ping':
    case 'pong':
      return { t: v.t }
    default:
      return null
  }
}

/* ------------------------------------------- what a relay may carry */

export interface RelayRoute {
  method: 'GET' | 'POST' | 'WS'
  /** A path pattern; `:ptyId` matches one path segment. The query is matched separately. */
  path: string
  /** The grant it needs. */
  needs: RelayMode
}

/**
 * The phone API a relay may carry, and nothing else. `/api/transcribe`
 * (the guest has its own speech server) and `/api/push/*` (subscriptions are
 * a phone's) are absent, so refused; so is every static file.
 */
export const RELAY_ROUTES: readonly RelayRoute[] = [
  { method: 'GET', path: '/api/host', needs: 'view' },
  { method: 'GET', path: '/api/sessions', needs: 'view' },
  { method: 'GET', path: '/api/theme', needs: 'view' },
  { method: 'GET', path: '/api/projects', needs: 'view' },
  { method: 'GET', path: '/api/folders', needs: 'view' },
  { method: 'GET', path: '/api/history', needs: 'view' },
  { method: 'GET', path: '/api/transcript', needs: 'view' },
  { method: 'POST', path: '/api/sessions', needs: 'full' },
  { method: 'POST', path: '/api/sessions/:ptyId/answer', needs: 'full' },
  { method: 'POST', path: '/api/projects', needs: 'full' },
  { method: 'WS', path: '/ws/events', needs: 'view' },
  { method: 'WS', path: '/ws', needs: 'view' }
]

const PTY_ID = PTY_ID_RE

/** The route a request names, or null (refused). `path` may carry a query. */
export function relayRouteFor(method: 'GET' | 'POST' | 'WS', path: string): RelayRoute | null {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\\') || path.includes('#')) return null
  /*
   * Split at the FIRST `?` and keep everything after it. `split('?', 2)`
   * would drop a second `?` and all that follows, so `/ws?ptyId=x?k=secret`
   * was judged on `ptyId=x` while the host served the whole string.
   */
  const q = path.indexOf('?')
  const pathname = q < 0 ? path : path.slice(0, q)
  const query = q < 0 ? '' : path.slice(q + 1)
  if (pathname.split('/').some((s) => s === '..' || s === '.')) return null
  for (const r of RELAY_ROUTES) {
    if (r.method !== method) continue
    const want = r.path.split('/')
    const got = pathname.split('/')
    if (want.length !== got.length) continue
    if (!want.every((w, i) => (w === ':ptyId' ? PTY_ID.test(got[i]) : w === got[i]))) continue
    // The pty socket needs its ptyId, and takes `peek=1`; nothing else.
    if (r.method === 'WS' && r.path === '/ws') {
      const params = new URLSearchParams(query)
      const keys = [...params.keys()]
      if (!PTY_ID.test(params.get('ptyId') ?? '')) return null
      if (keys.some((k) => k !== 'ptyId' && k !== 'peek')) return null
    }
    return r
  }
  return null
}

/** Pty-socket frames a guest may send, by the grant they need. */
const PTY_FRAME_NEEDS: Record<string, RelayMode> = { input: 'full', submit: 'full', resize: 'full' }

/**
 * Whether the host lets one guest frame through, given the guest's grant.
 * `socketPath` is the path the frame's socket was opened on (for `ws-msg`).
 * `view` refuses every POST and every pty frame that types or resizes;
 * `/ws/events` takes no guest frames at all.
 */
export function relayFrameVerdict(
  mode: RelayMode | null,
  frame: RelayInnerFrame,
  socketPath?: string
): { ok: true } | { ok: false; reason: string } {
  if (mode === null) return { ok: false, reason: 'no grant' }
  const allows = (needs: RelayMode): boolean => needs === 'view' || mode === 'full'
  switch (frame.t) {
    case 'req': {
      const r = relayRouteFor(frame.method, frame.path)
      if (!r) return { ok: false, reason: 'not a relayed route' }
      return allows(r.needs) ? { ok: true } : { ok: false, reason: 'this device may only watch' }
    }
    case 'ws-open': {
      const r = relayRouteFor('WS', frame.path)
      return r ? { ok: true } : { ok: false, reason: 'not a relayed socket' }
    }
    case 'ws-msg': {
      if (!socketPath) return { ok: false, reason: 'unknown socket' }
      const r = relayRouteFor('WS', socketPath)
      if (!r) return { ok: false, reason: 'not a relayed socket' }
      if (r.path === '/ws/events') return { ok: false, reason: 'the events socket takes no frames' }
      let type = ''
      try {
        const parsed: unknown = JSON.parse(frame.data)
        type = isRecord(parsed) && typeof parsed.type === 'string' ? parsed.type : ''
      } catch {
        return { ok: false, reason: 'not a pty frame' }
      }
      const needs = PTY_FRAME_NEEDS[type]
      if (!needs) return { ok: false, reason: 'not a pty frame' }
      return allows(needs) ? { ok: true } : { ok: false, reason: 'this device may only watch' }
    }
    case 'ws-close':
    case 'ping':
    case 'pong':
      return { ok: true }
    default:
      return { ok: false, reason: 'a guest does not send that' }
  }
}

/* ------------------------------------------------------------- grants */

/** One requesting device's standing on THIS host. T0: never synced. */
export interface HubGrant {
  mode: RelayMode
  /** The device's label when the grant was given, for the list. */
  label: string
  /** ms. */
  at: number
}

/** A device's key fingerprint for the host's question: the signing key's first 8 bytes, hex, in groups of four. */
export function keyFingerprint(signPub: string): string {
  const bytes = b64uDecode(signPub)
  if (!bytes) return '?'
  const hex = [...bytes.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('')
  return hex.match(/.{4}/g)?.join(' ') ?? hex
}
