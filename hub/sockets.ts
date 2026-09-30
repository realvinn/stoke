/*
 * The hub's two kinds of long-lived socket (spec §6): one presence socket per
 * active device, and relays that pair one guest socket with one host socket.
 *
 * The relay is the part with a promise attached: it forwards every frame
 * VERBATIM — the same bytes, the same text/binary type, in order — and never
 * parses, logs or keeps one. Inside it the two devices run a handshake over
 * keys the chain vouches for and then AES-GCM (src/shared/hub/relay.ts); the
 * hub sees sizes and timing, nothing else. Who may join is decided before the
 * upgrade (hub/app.ts): only the relay's own guest and host, of the relay's
 * own account, once each.
 *
 * Relays live in memory only. They are two live sockets; after a restart
 * there is nothing to resume, and the guest simply asks for a new one.
 *
 * Flow control (found in review, 2026-10-01): the relay used to hand every
 * frame to `ws.send` on the other end however much was already queued there,
 * so one end streaming while the other never read made the HUB buffer without
 * limit — one account's two devices (or one compromised device) could fill
 * the NUC's memory until systemd's MemoryMax killed the hub for everybody. Now
 * a delivery that leaves more than RELAY_HIGH_WATER queued toward one end
 * PAUSES the socket it came from — TCP then pushes back on the sender, whose
 * own buffer grows instead of the hub's — and the send callbacks resume it
 * once that end has drained below RELAY_LOW_WATER. RELAY_HARD_CAP closes the
 * relay (1013) if frames already read past the pause ever push it that far.
 */
import type { RawData, WebSocket } from 'ws'
import type { PresenceServerFrame } from '../src/shared/hub/protocol.ts'
import { RELAY_IDLE_MS, RELAY_OPEN_TTL_MS, RELAYS_PER_ACCOUNT } from '../src/shared/hub/relay.ts'
import type { HubLog } from './log.ts'

/** Close codes a peer may be told (RFC 6455 §7.4): 1005, 1006 and 1015 only ever describe a close, never travel in one. */
export function sendableCloseCode(code: number): number {
  if (code >= 3000 && code <= 4999) return code
  if (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) return code
  return 1000
}

function closeQuietly(ws: WebSocket | null, code: number, reason: string): void {
  if (!ws) return
  try {
    ws.close(sendableCloseCode(code), reason.slice(0, 120))
  } catch {
    try {
      ws.terminate()
    } catch {
      /* already gone */
    }
  }
}

/* ------------------------------------------------------------ presence */

export interface PresenceConn {
  ws: WebSocket
  account: string
  device: string
  tokenHash: string
  /** The app version its `hello` named, for the log. */
  app: string
}

/**
 * Presence frames are small hints; this much queued toward one device means it
 * is not reading them, so the socket is cut (it reconnects and re-reads state)
 * rather than letting the hub hold an ever-growing queue for it.
 */
export const PRESENCE_MAX_BUFFERED = 1024 * 1024

export class Presence {
  private readonly accounts = new Map<string, Map<string, PresenceConn>>()

  /** Register a device's socket, replacing an older one of the same device. */
  add(conn: PresenceConn): void {
    let devices = this.accounts.get(conn.account)
    if (!devices) {
      devices = new Map()
      this.accounts.set(conn.account, devices)
    }
    const old = devices.get(conn.device)
    devices.set(conn.device, conn)
    if (old && old.ws !== conn.ws) {
      this.sendTo(old, { t: 'bye', reason: 'replaced by a newer connection from this device' })
      closeQuietly(old.ws, 4001, 'replaced')
    }
  }

  /** Forget a socket, if it is still the one registered for its device. True when it was. */
  remove(conn: PresenceConn): boolean {
    const devices = this.accounts.get(conn.account)
    if (!devices || devices.get(conn.device) !== conn) return false
    devices.delete(conn.device)
    if (devices.size === 0) this.accounts.delete(conn.account)
    return true
  }

  online(account: string): string[] {
    return [...(this.accounts.get(account)?.keys() ?? [])].sort()
  }

  isOnline(account: string, device: string): boolean {
    return this.accounts.get(account)?.has(device) ?? false
  }

  private sendTo(conn: PresenceConn, frame: PresenceServerFrame): void {
    try {
      if (conn.ws.readyState !== conn.ws.OPEN) return
      if (conn.ws.bufferedAmount > PRESENCE_MAX_BUFFERED) {
        conn.ws.terminate()
        return
      }
      conn.ws.send(JSON.stringify(frame))
    } catch {
      /* a dead socket is reaped by the ping loop */
    }
  }

  send(account: string, device: string, frame: PresenceServerFrame): boolean {
    const conn = this.accounts.get(account)?.get(device)
    if (!conn) return false
    this.sendTo(conn, frame)
    return true
  }

  broadcast(account: string, frame: PresenceServerFrame, except?: string): void {
    for (const conn of this.accounts.get(account)?.values() ?? []) if (conn.device !== except) this.sendTo(conn, frame)
  }

  /** Say `bye` and close every socket of one device (revoked). */
  kickDevice(account: string, device: string, reason: string, code: number): void {
    const conn = this.accounts.get(account)?.get(device)
    if (!conn) return
    this.sendTo(conn, { t: 'bye', reason })
    closeQuietly(conn.ws, code, reason)
  }

  /** The same for every socket opened with one session (signed out). */
  kickSession(tokenHash: string, reason: string, code: number): void {
    for (const conn of this.all()) {
      if (conn.tokenHash !== tokenHash) continue
      this.sendTo(conn, { t: 'bye', reason })
      closeQuietly(conn.ws, code, reason)
    }
  }

  all(): PresenceConn[] {
    return [...this.accounts.values()].flatMap((m) => [...m.values()])
  }

  closeAll(reason: string, code: number): void {
    for (const conn of this.all()) {
      this.sendTo(conn, { t: 'bye', reason })
      closeQuietly(conn.ws, code, reason)
    }
  }
}

/* --------------------------------------------------------------- relays */

export type RelayRole = 'guest' | 'host'

export interface Relay {
  id: string
  account: string
  guest: string
  host: string
  createdAt: number
  /** Both ends must have joined by then. */
  expiresAt: number
  sockets: Record<RelayRole, WebSocket | null>
  /** Frames sent before the other end joined, delivered when it does. */
  queue: { to: RelayRole; data: RawData; binary: boolean; bytes: number }[]
  queuedBytes: number
  lastActivity: number
  /** Frames and bytes forwarded, for the close log line. Never their content. */
  frames: number
  bytes: number
  /** Which end's socket the broker has paused because the OTHER end is not keeping up. */
  held: Record<RelayRole, boolean>
  /** The most ever queued toward either end, for the close log line: what flow control held it to. */
  peakBuffered: number
  closed: boolean
}

/** What one end may send before the other has joined (the guest's hs1, typically). */
const MAX_QUEUED_FRAMES = 32
const MAX_QUEUED_BYTES = 2 * 1024 * 1024
/** Queued toward one end past this, the other end's socket is paused. Four maximum frames. */
export const RELAY_HIGH_WATER = 4 * 1024 * 1024
/** ...and resumed once the slow end has drained below this. */
export const RELAY_LOW_WATER = 1024 * 1024
/** Past this (frames already read when the pause took hold), the relay is closed with 1013. */
export const RELAY_HARD_CAP = 16 * 1024 * 1024

function otherEnd(role: RelayRole): RelayRole {
  return role === 'guest' ? 'host' : 'guest'
}

function byteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((n, b) => n + b.length, 0)
  return data instanceof ArrayBuffer ? data.byteLength : data.length
}

export class RelayBroker {
  private readonly relays = new Map<string, Relay>()
  private readonly now: () => number
  private readonly log: HubLog
  private readonly onResume: (ws: WebSocket) => void

  /**
   * `onResume` is told when a paused end is read again: the hub's ping loop
   * skips a socket it paused (it cannot read that end's pong) and must not then
   * judge it by a ping it could not have answered.
   */
  constructor(opts: { now: () => number; log: HubLog; onResume?: (ws: WebSocket) => void }) {
    this.now = opts.now
    this.log = opts.log
    this.onResume = opts.onResume ?? (() => {})
  }

  countFor(account: string): number {
    let n = 0
    for (const r of this.relays.values()) if (r.account === account && !r.closed) n++
    return n
  }

  /** A new relay, or null when the account already has RELAYS_PER_ACCOUNT open. */
  create(id: string, account: string, guest: string, host: string): Relay | null {
    if (this.countFor(account) >= RELAYS_PER_ACCOUNT) return null
    const now = this.now()
    const relay: Relay = {
      id,
      account,
      guest,
      host,
      createdAt: now,
      expiresAt: now + RELAY_OPEN_TTL_MS,
      sockets: { guest: null, host: null },
      queue: [],
      queuedBytes: 0,
      lastActivity: now,
      frames: 0,
      bytes: 0,
      held: { guest: false, host: false },
      peakBuffered: 0,
      closed: false
    }
    this.relays.set(id, relay)
    return relay
  }

  /** The relay, only if it belongs to `account`: another account's id reads as no relay at all. */
  get(account: string, id: string): Relay | null {
    const r = this.relays.get(id)
    return r && !r.closed && r.account === account ? r : null
  }

  roleOf(relay: Relay, device: string): RelayRole | null {
    if (device === relay.guest) return 'guest'
    if (device === relay.host) return 'host'
    return null
  }

  /** Whether `role`'s end is still free. Each end joins once; a second socket is refused. */
  canJoin(relay: Relay, role: RelayRole): boolean {
    return !relay.closed && relay.sockets[role] === null && this.now() < relay.expiresAt
  }

  join(relay: Relay, role: RelayRole, ws: WebSocket): void {
    if (!this.canJoin(relay, role)) {
      closeQuietly(ws, 1008, 'that end of the relay is taken')
      return
    }
    relay.sockets[role] = ws
    const other = otherEnd(role)
    ws.on('message', (data: RawData, isBinary: boolean) => this.forward(relay, other, data, isBinary))
    ws.on('close', (code: number, reason: Buffer) => this.closeRelay(relay, code, reason.toString('utf8') || `${role} left`))
    ws.on('error', () => this.closeRelay(relay, 1011, `${role} socket error`))
    if (bothJoined(relay)) {
      relay.lastActivity = this.now()
      const queued = relay.queue.splice(0)
      relay.queuedBytes = 0
      for (const f of queued) this.deliver(relay, f.to, f.data, f.binary, f.bytes)
      this.log.info('relay joined', { relay: relay.id, account: relay.account, guest: relay.guest, host: relay.host })
    }
  }

  private forward(relay: Relay, to: RelayRole, data: RawData, binary: boolean): void {
    if (relay.closed) return
    const bytes = byteLength(data)
    relay.lastActivity = this.now()
    if (!relay.sockets[to]) {
      if (relay.queue.length >= MAX_QUEUED_FRAMES || relay.queuedBytes + bytes > MAX_QUEUED_BYTES) {
        this.closeRelay(relay, 1008, 'too much sent before the other end joined')
        return
      }
      relay.queue.push({ to, data, binary, bytes })
      relay.queuedBytes += bytes
      return
    }
    this.deliver(relay, to, data, binary, bytes)
  }

  private deliver(relay: Relay, to: RelayRole, data: RawData, binary: boolean, bytes: number): void {
    const ws = relay.sockets[to]
    if (!ws || ws.readyState !== ws.OPEN) return
    relay.frames++
    relay.bytes += bytes
    ws.send(data, { binary }, (err) => {
      if (err) this.closeRelay(relay, 1011, 'could not deliver a frame')
      else this.drained(relay, to)
    })
    // What is queued toward `to` now: the socket's own write queue and ws's.
    const queued = ws.bufferedAmount
    if (queued > relay.peakBuffered) relay.peakBuffered = queued
    if (queued > RELAY_HARD_CAP) this.closeRelay(relay, 1013, 'the other end is not reading')
    else if (queued > RELAY_HIGH_WATER) this.hold(relay, otherEnd(to), queued)
  }

  /** Stop reading `end`: the end it sends to is not keeping up. */
  private hold(relay: Relay, end: RelayRole, queued: number): void {
    const src = relay.sockets[end]
    if (relay.closed || relay.held[end] || !src) return
    relay.held[end] = true
    src.pause()
    this.log.debug('relay held', { relay: relay.id, end, queued })
  }

  /** A frame toward `to` went out: if it has drained, read the end that was held for it again. */
  private drained(relay: Relay, to: RelayRole): void {
    const end = otherEnd(to)
    const dest = relay.sockets[to]
    const src = relay.sockets[end]
    if (relay.closed || !relay.held[end] || !src || !dest) return
    if (dest.bufferedAmount > RELAY_LOW_WATER) return
    relay.held[end] = false
    src.resume()
    this.onResume(src)
    this.log.debug('relay released', { relay: relay.id, end })
  }

  /** Close both ends with the same (sendable) code and forget the relay. */
  closeRelay(relay: Relay, code: number, reason: string): void {
    if (relay.closed) return
    relay.closed = true
    this.relays.delete(relay.id)
    relay.queue.length = 0
    // An end we paused could not read the peer's close frame, and would sit out ws's
    // 30 s close timer: read it again (forward drops anything more, the relay is closed).
    for (const end of ['guest', 'host'] as const) if (relay.held[end]) relay.sockets[end]?.resume()
    closeQuietly(relay.sockets.guest, code, reason)
    closeQuietly(relay.sockets.host, code, reason)
    this.log.info('relay closed', {
      relay: relay.id,
      account: relay.account,
      code: sendableCloseCode(code),
      why: reason,
      frames: relay.frames,
      bytes: relay.bytes,
      peakBuffered: relay.peakBuffered,
      ms: this.now() - relay.createdAt
    })
  }

  /** Every relay one device is an end of (revoked, signed out). */
  closeDevice(account: string, device: string, code: number, reason: string): void {
    for (const r of [...this.relays.values()]) if (r.account === account && (r.guest === device || r.host === device)) this.closeRelay(r, code, reason)
  }

  /** Relays never opened in time, and relays idle for RELAY_IDLE_MS. */
  tick(): void {
    const now = this.now()
    for (const r of [...this.relays.values()]) {
      if (!bothJoined(r) && now >= r.expiresAt) this.closeRelay(r, 1000, 'the other end never joined')
      else if (bothJoined(r) && now - r.lastActivity >= RELAY_IDLE_MS) this.closeRelay(r, 1000, 'idle')
    }
  }

  sockets(): WebSocket[] {
    return [...this.relays.values()].flatMap((r) => [r.sockets.guest, r.sockets.host].filter((w): w is WebSocket => w !== null))
  }

  closeAll(code: number, reason: string): void {
    for (const r of [...this.relays.values()]) this.closeRelay(r, code, reason)
  }
}

function bothJoined(r: Relay): boolean {
  return r.sockets.guest !== null && r.sockets.host !== null
}
