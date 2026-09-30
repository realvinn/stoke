/*
 * "Other machines": the desktop's half of remote between the owner's own
 * signed-in devices, through the hub (spec §6). One of these lives inside the
 * hub service while this device is in the vault, and plays both parts:
 *
 * - STATUS. Over the presence socket it tells the other devices its name,
 *   platform and — only while the owner ticked "Let my other devices see and
 *   open my sessions" HERE — a summary of its sessions, sealed under the
 *   epoch's presence key (`sealStatus`), so the hub forwards bytes it cannot
 *   read. It opens theirs the same way, and the list shows only devices the
 *   verified chain holds as active and the hub says are online.
 * - GUEST. A remote tab: ask the hub for a relay to that device, run the
 *   handshake over keys the chain vouches for (`RelayChannel`), name the
 *   session (`attach`), then speak the PHONE's pty-socket protocol inside the
 *   encrypted channel. A dropped link reconnects with backoff; an "Allow once"
 *   the host gave outlives the drop long enough to reattach without asking.
 * - HOST. A relay the hub says a device asked for: the same handshake, then
 *   the host decides (`attachDecision`): refuse, serve, or ask the owner —
 *   "Let <device> open <session>?" Allow once / Always / Deny, refused after
 *   `RELAY_ASK_MS`. Every relayed request and socket goes through the phone
 *   server's own handlers (`RemoteServer.relayRequest`/`relaySocket`), after
 *   the grant's mode (`relayFrameVerdict`) and the answer's reach
 *   (`relayScopeVerdict`). Nothing here opens a port.
 * - The CHAIN. The handshake checks each end against this device's verified
 *   chain, and so does every frame after it; when the chain moves
 *   (`chainChanged`), a relay or tab to a device it no longer holds ends.
 * - LIVENESS. A guest pings through the channel (`RELAY_PING_MS`), or the hub
 *   would close a quiet tab as idle every `RELAY_IDLE_MS`.
 *
 * No electron import, so a suite can run two of these against a real hub.
 * No TypeScript parameter properties (strip-only mode).
 */
import { stableJson } from '../../shared/hub/codec.ts'
import { reconnectDelayMs, sealedStatusProblem, type PresenceClientFrame, type SealedStatus } from '../../shared/hub/protocol.ts'
import {
  attachDecision,
  emptyRemoteView,
  holdOnce,
  newerStatus,
  otherMachines,
  parseRemoteStatus,
  pruneOnce,
  relayScopeVerdict,
  releaseOnce,
  remoteStatusFrom,
  REMOTE_STATUS_MIN_MS,
  REMOTE_STATUS_POLL_MS,
  type AttachAnswer,
  type HubRemoteView,
  type OnceGrant,
  type RelayScope,
  type RemoteRowLike,
  type RemoteStatus,
  type RemoteTabFrame,
  type RemoteTabState
} from '../../shared/hub/remote.ts'
import {
  isPtyId,
  keyFingerprint,
  RELAY_ASK_MS,
  RELAY_PING_MS,
  RELAY_PONG_WAIT_MS,
  relayFrameVerdict,
  type HubGrant,
  type RelayInnerFrame,
  type RelayMode
} from '../../shared/hub/relay.ts'
import type { PhoneSocket } from '../remote/socket.ts'
import { VirtualSocket } from '../remote/socket.ts'
import { RelayChannel } from './channel.ts'
import { openStatus, randomB64u, sealStatus } from './crypto.ts'

/** Who this device is, as the verified chain says, while it is in the vault. */
export interface RemoteContext {
  account: string
  epoch: number
  me: { id: string; label: string; platform: string; signPriv: string }
  /** Every ACTIVE device of the verified, anchored chain (gotcha 140), this one included. */
  active: { id: string; label: string; platform: string; sign: string }[]
}

/** A relay socket, as much of `ws`'s WebSocket as this uses. */
export interface RelaySocket {
  readonly readyState: number
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  on(event: 'open', fn: () => void): unknown
  on(event: 'message', fn: (data: unknown, binary: boolean) => void): unknown
  on(event: 'close', fn: (code: number) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
}

/** The machine side: this computer's sessions and the phone server's handlers. */
export interface RemoteMachineDeps {
  /** Its live sessions, as the phone lists them (`RemoteServer.sessionRows`). */
  sessions(): Promise<RemoteRowLike[]>
  request(method: 'GET' | 'POST', path: string, body: unknown): Promise<{ status: number; body: unknown }>
  socket(path: string, sock: PhoneSocket): void
  /** The whole view, on every change. */
  emit(view: HubRemoteView): void
  /** One pty-socket frame for a remote tab on THIS machine. */
  frame(tabId: string, frame: RemoteTabFrame): void
}

export interface HubRemoteDeps extends RemoteMachineDeps {
  now(): number
  /** Null while this device is not signed in and in the vault. */
  context(): RemoteContext | null
  /** The current epoch's presence key, or null until the vault key is here. */
  presenceKey(epoch: number): Promise<Uint8Array | null>
  /** One frame on the presence socket; false when it is not open. */
  sendPresence(frame: PresenceClientFrame): boolean
  createRelay(host: string): Promise<{ relay: string }>
  openRelay(relay: string): Promise<RelaySocket>
  /** `hub.shareSessions`, read on every call. */
  sharing(): boolean
  /** `hub.grants`, read on every call. */
  grants(): Record<string, HubGrant>
  setGrant(device: string, grant: HubGrant | null): Promise<void>
  log(message: string, err?: unknown): void
  /** Tests only: the guest's keepalive, in real milliseconds (`RELAY_PING_MS`, `RELAY_PONG_WAIT_MS`). */
  keepAlive?: { pingMs: number; pongWaitMs: number }
}

/** Why a relay from, or a tab to, a device the verified chain no longer holds as active is ended. */
const NOT_A_DEVICE = 'That device is no longer one of this account’s devices.'
/** Reconnect tries before a tab gives up and offers Try again. */
const MAX_TRIES = 8
/** How long a host waits for `attach` after the handshake. */
const ATTACH_WAIT_MS = 15_000
/** A connecting tab says "waiting for the other machine to allow it" after this. */
const ASKING_HINT_MS = 1500
/** Relayed sockets one relay may hold open on a host. */
const SOCKETS_PER_RELAY = 8
/** Relays one host serves at once. */
const HOSTED_MAX = 8
/** A status that changed only in its activity times is resent at most this often. */
const STATUS_ACTIVITY_MS = 30_000
/** The pty socket's id inside a guest's channel. */
const PTY_SOCKET = 1

interface GuestTab {
  id: string
  device: string
  /** The host's name when the tab opened: the banner keeps it after the chain or presence forgets the device. */
  label: string
  ptyId: string
  title: string
  project: string
  state: RemoteTabState
  message: string | null
  tries: number
  /** A connect is under way (claimed before its first await, gotcha 20). */
  connecting: boolean
  /** Bumped per connect: a continuation acts only while it still names the tab's current attempt. */
  gen: number
  channel: RelayChannel | null
  timer: ReturnType<typeof setTimeout> | null
  hint: ReturnType<typeof setTimeout> | null
  /** The keepalive while the channel is open, and the wait for its pong. */
  ping: ReturnType<typeof setInterval> | null
  pongWait: ReturnType<typeof setTimeout> | null
  closed: boolean
}

interface HostRelay {
  relay: string
  guest: string
  /** The guest's signing key the handshake was checked against: a chain that stops holding it ends the relay. */
  guestKey: string | null
  channel: RelayChannel | null
  phase: 'handshake' | 'attach' | 'asking' | 'serving' | 'closed'
  ptyId: string | null
  title: string | null
  mode: RelayMode | null
  scope: RelayScope | null
  via: 'once' | 'always' | null
  sockets: Map<number, { path: string; sock: VirtualSocket }>
  since: number
  wait: ReturnType<typeof setTimeout> | null
}

interface PendingAsk {
  id: string
  relay: string
  device: string
  label: string
  platform: string
  fingerprint: string
  ptyId: string
  title: string
  expiresAt: number
  timer: ReturnType<typeof setTimeout>
}

export class HubRemote {
  private readonly d: HubRemoteDeps
  private online: string[]
  private statuses: Record<string, RemoteStatus>
  private presenceOpen: boolean
  private sent: { core: string; full: string; at: number; epoch: number } | null
  private publishing: boolean
  /** The `at` of the last status sent: the next is later, whatever the clock says. */
  private lastAt: number
  private pollTimer: ReturnType<typeof setInterval> | null
  private readonly tabs: Map<string, GuestTab>
  private readonly hosted: Map<string, HostRelay>
  private readonly asks: Map<string, PendingAsk>
  private once: OnceGrant[]
  /**
   * The newest `at` opened per device and epoch, for the life of the process:
   * never cleared by a presence reconnect or a device going offline, so a hub
   * cannot hand back an older status after either (it could, while the only
   * mark was the displayed status, which both clear).
   */
  private readonly statusMarks: Map<string, number>

  constructor(d: HubRemoteDeps) {
    this.d = d
    this.online = []
    this.statuses = {}
    this.presenceOpen = false
    this.sent = null
    this.publishing = false
    this.lastAt = 0
    this.pollTimer = null
    this.tabs = new Map()
    this.hosted = new Map()
    this.asks = new Map()
    this.once = []
    this.statusMarks = new Map()
  }

  /* ======================================================== the view */

  view(): HubRemoteView {
    const v = emptyRemoteView()
    const ctx = this.d.context()
    v.sharing = this.d.sharing()
    v.available = ctx !== null
    const label = (id: string): string => ctx?.active.find((a) => a.id === id)?.label ?? this.statuses[id]?.name ?? 'another device'
    if (ctx) v.machines = otherMachines({ me: ctx.me.id, active: ctx.active, online: this.online, statuses: this.statuses })
    v.tabs = [...this.tabs.values()].map((t) => ({
      id: t.id,
      device: t.device,
      deviceLabel: ctx?.active.find((a) => a.id === t.device)?.label ?? this.statuses[t.device]?.name ?? t.label,
      platform: ctx?.active.find((a) => a.id === t.device)?.platform ?? '',
      ptyId: t.ptyId,
      title: t.title,
      project: t.project,
      state: t.state,
      message: t.message
    }))
    v.guests = [...this.hosted.values()]
      .filter((h) => h.phase === 'serving')
      .map((h) => ({ relay: h.relay, device: h.guest, label: label(h.guest), ptyId: h.ptyId, title: h.title, since: h.since, via: h.via }))
    v.asks = [...this.asks.values()].map((a) => ({
      id: a.id,
      device: a.device,
      label: a.label,
      platform: a.platform,
      fingerprint: a.fingerprint,
      ptyId: a.ptyId,
      title: a.title,
      expiresAt: a.expiresAt
    }))
    v.grants = Object.entries(this.d.grants()).map(([device, g]) => ({ device, label: ctx?.active.find((a) => a.id === device)?.label ?? g.label, mode: g.mode, at: g.at }))
    return v
  }

  private emit(): void {
    try {
      this.d.emit(this.view())
    } catch (err) {
      this.d.log('hub remote: could not publish the view', err)
    }
  }

  /* ======================================================== presence */

  /** The presence socket opened: tell the others about this machine at once. */
  presenceOpened(): void {
    this.presenceOpen = true
    this.sent = null
    if (!this.pollTimer) {
      this.pollTimer = setInterval(() => void this.publish(), REMOTE_STATUS_POLL_MS)
      this.pollTimer.unref?.()
    }
    void this.publish()
  }

  /** It closed: nothing is known about anyone until it opens again. */
  presenceClosed(): void {
    this.presenceOpen = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
    this.online = []
    this.statuses = {}
    this.emit()
  }

  onOnline(online: string[]): void {
    this.online = [...online]
    for (const id of Object.keys(this.statuses)) if (!this.online.includes(id)) delete this.statuses[id]
    this.emit()
  }

  /** Another device's sealed status, as the hub forwarded it. */
  async onStatus(device: string, sealed: SealedStatus | null): Promise<void> {
    const ctx = this.d.context()
    if (!ctx || device === ctx.me.id || !ctx.active.some((a) => a.id === device)) return
    if (sealed === null) {
      delete this.statuses[device]
      this.emit()
      return
    }
    // Only the current epoch: a device removed by a revoke still holds every older key.
    if (sealed.epoch !== ctx.epoch) return
    const key = await this.d.presenceKey(ctx.epoch)
    if (!key) return
    const text = openStatus(key, { account: ctx.account, epoch: ctx.epoch, device }, sealed)
    const status = text === null ? null : parseRemoteStatus(text)
    if (!status) {
      this.d.log(`hub remote: a status from ${device} did not open`)
      return
    }
    /*
     * Older than one already opened from that device in this epoch: a replay,
     * refused whatever is on show. EQUAL is the same status again — the hub
     * hands every device's latest back on each presence connect — and is
     * taken, or a reconnect would blank the list until the device changed.
     */
    const mark = `${device}:${ctx.epoch}`
    const high = this.statusMarks.get(mark)
    if (high !== undefined && status.at < high) return
    this.statusMarks.set(mark, Math.max(high ?? 0, status.at))
    if (!newerStatus(this.statuses[device], status)) return
    this.statuses[device] = status
    this.emit()
  }

  /** Something about this machine's sessions may have changed: publish now, within the rate. */
  sessionsChanged(): void {
    void this.publish()
  }

  /**
   * Seal and send this machine's status when it changed (never more often than
   * `REMOTE_STATUS_MIN_MS`; a change only in activity times at most every
   * `STATUS_ACTIVITY_MS`). One pass at a time (gotcha 20).
   */
  async publish(force = false): Promise<void> {
    if (!this.presenceOpen || this.publishing) return
    const ctx = this.d.context()
    if (!ctx) return
    this.publishing = true
    try {
      const key = await this.d.presenceKey(ctx.epoch)
      if (!key) return
      const sharing = this.d.sharing()
      const rows = sharing ? await this.d.sessions() : []
      const now = this.d.now()
      // Strictly increasing per device (a hybrid clock): two statuses in one millisecond still order.
      const at = Math.max(now, this.lastAt + 1)
      const status = remoteStatusFrom({ at, name: ctx.me.label, platform: ctx.me.platform, open: sharing, rows })
      const full = stableJson({ ...status, at: 0 })
      const core = stableJson({ ...status, at: 0, sessions: status.sessions.map((s) => ({ ...s, lastActivityAt: 0 })) })
      const last = this.sent
      if (!force && last && last.epoch === ctx.epoch) {
        if (last.full === full) return
        const since = now - last.at
        if (last.core === core ? since < STATUS_ACTIVITY_MS : since < REMOTE_STATUS_MIN_MS) return
      }
      const sealed = this.sealToFit(key, ctx, status)
      if (!sealed) return
      if (this.d.sendPresence({ t: 'status', status: sealed })) {
        this.sent = { core, full, at: now, epoch: ctx.epoch }
        this.lastAt = at
      }
    } catch (err) {
      this.d.log('hub remote: could not publish this machine’s status', err)
    } finally {
      this.publishing = false
    }
  }

  /**
   * Seal `status` as the hub will take it. Each string is capped by code
   * points, not the whole: 24 sessions of emoji or CJK titles and folder
   * names seal past `HUB_LIMITS.statusBytes`, and the hub drops a status that
   * does not pass `sealedStatusProblem` without a word — the other machines
   * would keep the old list, and this one would think it had sent. So the
   * last-listed sessions (the phone's order: least urgent, least recent) go
   * until it fits. Null (logged) when even none fits.
   */
  private sealToFit(key: Uint8Array, ctx: RemoteContext, status: RemoteStatus): SealedStatus | null {
    const f = { account: ctx.account, epoch: ctx.epoch, device: ctx.me.id }
    for (let n = status.sessions.length; n >= 0; n--) {
      const sealed = sealStatus(key, f, JSON.stringify(n === status.sessions.length ? status : { ...status, sessions: status.sessions.slice(0, n) }))
      const problem = sealedStatusProblem(sealed)
      if (problem === null) {
        if (n < status.sessions.length) this.d.log(`hub remote: the status lists ${n} of ${status.sessions.length} sessions, to fit what the hub carries`)
        return sealed
      }
      if (problem !== 'too large') break
    }
    this.d.log('hub remote: this machine’s status could not be sealed as the hub takes it; not sent')
    return null
  }

  /* ======================================================== guest: remote tabs */

  /** Open one of another machine's sessions in a tab here. */
  open(device: string, ptyId: string): { ok: true; tab: string } | { ok: false; message: string } {
    const ctx = this.d.context()
    if (!ctx) return { ok: false, message: 'Sign in to your hub and join its vault on this computer first.' }
    if (device === ctx.me.id || !ctx.active.some((a) => a.id === device)) return { ok: false, message: 'That machine is not one of your devices.' }
    if (!isPtyId(ptyId)) return { ok: false, message: 'That is not a session.' }
    for (const t of this.tabs.values()) if (t.device === device && t.ptyId === ptyId && !t.closed) return { ok: true, tab: t.id }
    const summary = this.statuses[device]?.sessions.find((s) => s.ptyId === ptyId)
    const tab: GuestTab = {
      id: `rt-${randomB64u(9)}`,
      device,
      label: ctx.active.find((a) => a.id === device)?.label ?? this.statuses[device]?.name ?? 'another device',
      ptyId,
      title: summary?.title || summary?.project || 'Session',
      project: summary?.project ?? '',
      state: 'connecting',
      message: null,
      tries: 0,
      connecting: false,
      gen: 0,
      channel: null,
      timer: null,
      hint: null,
      ping: null,
      pongWait: null,
      closed: false
    }
    this.tabs.set(tab.id, tab)
    void this.connect(tab)
    this.emit()
    return { ok: true, tab: tab.id }
  }

  /** Keystrokes typed into a remote tab. */
  input(tabId: string, data: string): void {
    const t = this.tabs.get(tabId)
    if (!t || t.state !== 'open' || typeof data !== 'string' || data.length === 0) return
    t.channel?.send({ t: 'ws-msg', id: PTY_SOCKET, data: JSON.stringify({ type: 'input', data }) })
  }

  /** Try again after a refusal or a lost link. */
  retry(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t || t.closed || t.connecting || t.state === 'open' || t.state === 'connecting' || t.state === 'asking') return
    t.tries = 0
    t.state = 'connecting'
    t.message = null
    void this.connect(t)
    this.emit()
  }

  /** The tab closed here: the relay goes; nothing on the other machine is killed. */
  close(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t) return
    t.closed = true
    if (t.timer) clearTimeout(t.timer)
    if (t.hint) clearTimeout(t.hint)
    this.stopKeepAlive(t)
    t.gen++
    const ch = t.channel
    t.channel = null
    if (ch?.state === 'open') ch.send({ t: 'ws-close', id: PTY_SOCKET, code: 1000, reason: 'closed' })
    ch?.close('the tab was closed')
    this.tabs.delete(tabId)
    this.emit()
  }

  private async connect(t: GuestTab): Promise<void> {
    if (t.closed || t.connecting) return
    t.connecting = true
    const gen = ++t.gen
    const current = (): boolean => !t.closed && t.gen === gen
    try {
      const ctx = this.d.context()
      if (!ctx) throw new Error('This computer is not in your hub’s vault any more.')
      if (!this.online.includes(t.device)) throw new Error(`${this.nameOf(t.device)} is not online.`)
      const { relay } = await this.d.createRelay(t.device)
      if (!current()) return
      const socket = await this.d.openRelay(relay)
      if (!current()) {
        socket.close(1000, 'the tab was closed')
        return
      }
      const channel = new RelayChannel({
        role: 'guest',
        relay,
        account: ctx.account,
        me: { id: ctx.me.id, signPriv: ctx.me.signPriv },
        peer: t.device,
        peerKey: (id) => this.d.context()?.active.find((a) => a.id === id && a.id !== ctx.me.id)?.sign ?? null,
        io: { send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason) },
        events: {
          onOpen: () => {
            if (!current()) return
            this.keepAlive(t, channel, current)
            channel.send({ t: 'attach', ptyId: t.ptyId })
            t.hint = setTimeout(() => {
              if (current() && t.state === 'connecting') {
                t.state = 'asking'
                t.message = `Waiting for ${this.nameOf(t.device)} to allow this…`
                this.emit()
              }
            }, ASKING_HINT_MS)
          },
          onFrame: (f) => {
            if (current()) this.guestFrame(t, channel, f)
          },
          onClose: (reason) => {
            if (t.channel === channel) {
              t.channel = null
              this.stopKeepAlive(t)
            }
            if (current()) this.lost(t, reason)
          }
        }
      })
      t.channel = channel
      socket.on('open', () => channel.start())
      socket.on('message', (data, binary) => channel.receive(binary ? toBytes(data) : String(data), binary))
      socket.on('close', () => channel.close('the relay closed'))
      socket.on('error', () => undefined)
      if (socket.readyState === 1) channel.start()
    } catch (err) {
      if (current()) this.lost(t, err instanceof Error ? err.message : String(err))
    } finally {
      t.connecting = false
    }
  }

  private guestFrame(t: GuestTab, channel: RelayChannel, f: RelayInnerFrame): void {
    switch (f.t) {
      case 'ready':
        if (t.hint) clearTimeout(t.hint)
        t.state = 'open'
        t.message = null
        t.tries = 0
        channel.send({ t: 'ws-open', id: PTY_SOCKET, path: `/ws?ptyId=${encodeURIComponent(t.ptyId)}` })
        this.emit()
        return
      case 'refused':
        if (t.hint) clearTimeout(t.hint)
        t.state = 'refused'
        t.message = f.reason.slice(0, 300)
        t.gen++
        channel.close('refused')
        this.emit()
        return
      case 'ws-msg': {
        if (f.id !== PTY_SOCKET) return
        let msg: unknown
        try {
          msg = JSON.parse(f.data)
        } catch {
          return
        }
        if (!msg || typeof msg !== 'object' || typeof (msg as { type?: unknown }).type !== 'string') return
        this.d.frame(t.id, msg as RemoteTabFrame)
        if ((msg as { type: string }).type === 'exit') {
          t.state = 'ended'
          t.message = typeof (msg as { reason?: unknown }).reason === 'string' ? ((msg as { reason: string }).reason) : 'The session ended on the other machine.'
          this.emit()
        }
        return
      }
      case 'ws-close':
        if (f.id !== PTY_SOCKET || t.state === 'ended') return
        // The host closed the pty socket without an exit: the link is what failed.
        channel.close(f.reason || 'the other machine closed the session')
        return
      case 'ping':
        channel.send({ t: 'pong' })
        return
      case 'pong':
        if (t.pongWait) clearTimeout(t.pongWait)
        t.pongWait = null
        return
      default:
        return
    }
  }

  /**
   * While the channel is open, ping the host every `RELAY_PING_MS`. The hub
   * closes a relay that forwarded nothing for `RELAY_IDLE_MS`, and a tab on a
   * quiet session forwards nothing; its own WebSocket pings do not count.
   * A ping with no pong inside `RELAY_PONG_WAIT_MS` closes the channel, so a
   * host that stopped serving it is found and reconnected, not typed into.
   */
  private keepAlive(t: GuestTab, channel: RelayChannel, current: () => boolean): void {
    this.stopKeepAlive(t)
    const { pingMs, pongWaitMs } = this.d.keepAlive ?? { pingMs: RELAY_PING_MS, pongWaitMs: RELAY_PONG_WAIT_MS }
    t.ping = setInterval(() => {
      if (!current() || channel.state !== 'open') return this.stopKeepAlive(t)
      if (t.pongWait) return // the last one is still owed: its own timer decides
      if (!channel.send({ t: 'ping' })) return
      t.pongWait = setTimeout(() => {
        t.pongWait = null
        if (current() && channel.state === 'open') channel.close('the other machine stopped answering')
      }, pongWaitMs)
    }, pingMs)
    t.ping.unref?.()
  }

  private stopKeepAlive(t: GuestTab): void {
    if (t.ping) clearInterval(t.ping)
    if (t.pongWait) clearTimeout(t.pongWait)
    t.ping = null
    t.pongWait = null
  }

  private lost(t: GuestTab, reason: string): void {
    if (t.hint) clearTimeout(t.hint)
    if (t.closed || t.state === 'refused' || t.state === 'ended') {
      this.emit()
      return
    }
    t.tries++
    if (t.tries > MAX_TRIES) {
      t.state = 'lost'
      t.message = `Could not reach ${this.nameOf(t.device)}: ${reason}`
      this.emit()
      return
    }
    t.state = 'reconnecting'
    t.message = reason
    if (t.timer) clearTimeout(t.timer)
    t.timer = setTimeout(() => {
      t.timer = null
      void this.connect(t)
    }, reconnectDelayMs(t.tries - 1, Math.random()))
    this.emit()
  }

  private nameOf(device: string): string {
    return this.d.context()?.active.find((a) => a.id === device)?.label ?? this.statuses[device]?.name ?? 'The other machine'
  }

  /* ======================================================== host */

  /** The hub says `guest` asked for a relay to this machine. */
  async onRelay(relay: string, guest: string): Promise<void> {
    const ctx = this.d.context()
    if (!ctx || guest === ctx.me.id || !ctx.active.some((a) => a.id === guest)) {
      this.d.log(`hub remote: a relay from ${guest} was not taken (not an active device of this account)`)
      return
    }
    if (this.hosted.has(relay) || this.hosted.size >= HOSTED_MAX) return
    // Claimed before the first await (gotcha 20): a repeated frame cannot open it twice.
    const h: HostRelay = {
      relay,
      guest,
      guestKey: null,
      channel: null,
      phase: 'handshake',
      ptyId: null,
      title: null,
      mode: null,
      scope: null,
      via: null,
      sockets: new Map(),
      since: this.d.now(),
      wait: null
    }
    this.hosted.set(relay, h)
    let socket: RelaySocket
    try {
      socket = await this.d.openRelay(relay)
    } catch (err) {
      this.d.log('hub remote: could not open a relay a device asked for', err)
      this.hosted.delete(relay)
      return
    }
    if (h.phase === 'closed') {
      socket.close(1000, 'closed')
      return
    }
    const channel = new RelayChannel({
      role: 'host',
      relay,
      account: ctx.account,
      me: { id: ctx.me.id, signPriv: ctx.me.signPriv },
      peer: guest,
      peerKey: (id) => this.d.context()?.active.find((a) => a.id === id && a.id !== ctx.me.id)?.sign ?? null,
      io: { send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason) },
      events: {
        onOpen: () => {
          h.guestKey = channel.peerSignKey
          h.phase = 'attach'
          h.wait = setTimeout(() => channel.close('no session was named'), ATTACH_WAIT_MS)
        },
        onFrame: (f) => void this.hostFrame(h, channel, f),
        onClose: () => this.endHosted(h)
      }
    })
    h.channel = channel
    channel.start()
    socket.on('message', (data, binary) => channel.receive(binary ? toBytes(data) : String(data), binary))
    socket.on('close', () => channel.close('the relay closed'))
    socket.on('error', () => undefined)
  }

  private async hostFrame(h: HostRelay, channel: RelayChannel, f: RelayInnerFrame): Promise<void> {
    if (h.phase === 'closed') return
    // Every frame, not only the handshake: a device removed since is refused at its next keystroke.
    if (!this.guestHolds(h)) return this.refuse(h, channel, NOT_A_DEVICE)
    if (f.t === 'ping') {
      channel.send({ t: 'pong' })
      return
    }
    if (h.phase === 'attach') {
      if (h.wait) clearTimeout(h.wait)
      h.wait = null
      if (f.t !== 'attach') return this.refuse(h, channel, 'The first frame must name a session.')
      h.ptyId = f.ptyId
      h.phase = 'asking'
      await this.decide(h, channel)
      return
    }
    if (h.phase !== 'serving' || !h.mode || !h.scope) return
    switch (f.t) {
      case 'req': {
        const verdict = this.judge(h, f)
        if (!verdict.ok) {
          channel.send({ t: 'res', id: f.id, status: 403, body: { error: verdict.reason } })
          return
        }
        const answer = await this.d.request(f.method, f.path, f.body)
        if (h.phase === 'serving') channel.send({ t: 'res', id: f.id, status: answer.status, body: answer.body })
        return
      }
      case 'ws-open': {
        const verdict = this.judge(h, f)
        if (!verdict.ok || h.sockets.has(f.id) || h.sockets.size >= SOCKETS_PER_RELAY) {
          channel.send({ t: 'ws-close', id: f.id, code: 1008, reason: verdict.ok ? 'Too many sockets.' : verdict.reason })
          return
        }
        const id = f.id
        const sock = new VirtualSocket(
          (text) => {
            channel.send({ t: 'ws-msg', id, data: text })
          },
          (code, reason) => {
            h.sockets.delete(id)
            channel.send({ t: 'ws-close', id, code, reason })
          }
        )
        h.sockets.set(id, { path: f.path, sock })
        this.d.socket(f.path, sock)
        this.emit()
        return
      }
      case 'ws-msg': {
        const s = h.sockets.get(f.id)
        if (!s) return
        const verdict = relayFrameVerdict(h.mode, f, s.path)
        if (!verdict.ok) return
        s.sock.deliver(f.data)
        return
      }
      case 'ws-close': {
        const s = h.sockets.get(f.id)
        if (!s) return
        h.sockets.delete(f.id)
        s.sock.drop('closed on the other machine')
        return
      }
      default:
        return
    }
  }

  /** The guest is still a device this machine's chain holds as active, by the key its handshake was checked against. */
  private guestHolds(h: HostRelay): boolean {
    return this.holds(h.guest, h.guestKey)
  }

  /** `device` is another ACTIVE device of the verified chain (and, once pinned, under `key`: gotcha 140). */
  private holds(device: string, key: string | null): boolean {
    const ctx = this.d.context()
    return !!ctx && device !== ctx.me.id && ctx.active.some((a) => a.id === device && (key === null || a.sign === key))
  }

  /** The grant's mode, then the answer's reach. */
  private judge(h: HostRelay, f: RelayInnerFrame): { ok: true } | { ok: false; reason: string } {
    const mode = relayFrameVerdict(h.mode, f)
    if (!mode.ok) return mode
    return relayScopeVerdict(h.scope ?? { kind: 'session', ptyId: '' }, f)
  }

  private async decide(h: HostRelay, channel: RelayChannel): Promise<void> {
    const ctx = this.d.context()
    if (!ctx || !h.ptyId) return this.refuse(h, channel, 'This computer is not in your hub’s vault any more.')
    let rows: RemoteRowLike[] = []
    try {
      rows = await this.d.sessions()
    } catch (err) {
      this.d.log('hub remote: could not list sessions', err)
    }
    if (h.phase === 'closed') return
    const row = rows.find((r) => r.ptyId === h.ptyId) ?? null
    h.title = row ? row.title || row.project : null
    const now = this.d.now()
    this.once = pruneOnce(this.once, now)
    const decision = attachDecision({
      sharing: this.d.sharing(),
      grant: this.d.grants()[h.guest] ?? null,
      once: this.once,
      device: h.guest,
      ptyId: h.ptyId,
      session: { exists: row !== null, exited: row?.exited ?? true },
      hostName: ctx.me.label,
      now
    })
    if (decision.t === 'refuse') return this.refuse(h, channel, decision.reason)
    if (decision.t === 'allow') return this.serve(h, channel, decision.mode, decision.via)
    for (const a of this.asks.values()) {
      if (a.device === h.guest && a.ptyId === h.ptyId) return this.refuse(h, channel, 'This computer is already asking about that session.')
    }
    const peer = ctx.active.find((a) => a.id === h.guest)
    const id = `ask-${randomB64u(9)}`
    const ask: PendingAsk = {
      id,
      relay: h.relay,
      device: h.guest,
      label: peer?.label ?? this.statuses[h.guest]?.name ?? 'another device',
      platform: peer?.platform ?? '',
      fingerprint: peer ? keyFingerprint(peer.sign) : '?',
      ptyId: h.ptyId,
      title: h.title ?? 'a session',
      expiresAt: now + RELAY_ASK_MS,
      timer: setTimeout(() => void this.answer(id, 'deny', 'Nobody answered on the other machine in time.'), RELAY_ASK_MS)
    }
    this.asks.set(id, ask)
    this.emit()
  }

  /** The owner's answer here: Allow once, Always, or Deny. */
  async answer(askId: string, answer: AttachAnswer, why?: string): Promise<{ ok: boolean }> {
    const a = this.asks.get(askId)
    if (!a) return { ok: false }
    // Claimed before the first await (gotcha 20): a second press finds nothing.
    this.asks.delete(askId)
    clearTimeout(a.timer)
    const h = this.hosted.get(a.relay)
    const channel = h?.channel
    if (!h || !channel || h.phase !== 'asking') {
      this.emit()
      return { ok: false }
    }
    // Removed from the chain while the question waited: nothing it asked is served, and nothing is granted.
    if (!this.guestHolds(h)) {
      this.refuse(h, channel, NOT_A_DEVICE)
      return { ok: false }
    }
    if (answer === 'deny') {
      this.refuse(h, channel, why ?? `The owner of ${this.d.context()?.me.label ?? 'that computer'} said no.`)
      return { ok: true }
    }
    if (!this.d.sharing()) {
      this.refuse(h, channel, 'That computer stopped sharing its sessions.')
      return { ok: true }
    }
    if (answer === 'always') {
      await this.d.setGrant(h.guest, { mode: 'full', label: a.label, at: this.d.now() })
      if (!this.guestHolds(h)) {
        // The chain moved during the write: take the grant back before anything is served under it.
        await this.d.setGrant(h.guest, null)
        if (h.phase === 'asking') this.refuse(h, channel, NOT_A_DEVICE)
        return { ok: false }
      }
      if (h.phase !== 'asking') return { ok: false }
      this.serve(h, channel, 'full', 'always')
    } else {
      this.serve(h, channel, 'full', 'once')
    }
    return { ok: true }
  }

  private serve(h: HostRelay, channel: RelayChannel, mode: RelayMode, via: 'once' | 'always'): void {
    const ctx = this.d.context()
    if (!ctx || !h.ptyId) return this.refuse(h, channel, 'This computer is not in your hub’s vault any more.')
    if (!this.guestHolds(h)) return this.refuse(h, channel, NOT_A_DEVICE)
    h.mode = mode
    h.via = via
    /*
     * Both answers reach the session this relay attached to, and no more:
     * "Always" means "do not ask again for this device", not the whole phone
     * API. The guest opens one relay per tab and never needs another route.
     */
    h.scope = { kind: 'session', ptyId: h.ptyId }
    if (via === 'once') this.once = holdOnce(this.once, h.guest, h.ptyId)
    h.phase = 'serving'
    channel.send({ t: 'ready', mode, host: { label: ctx.me.label, platform: ctx.me.platform } })
    this.emit()
  }

  private refuse(h: HostRelay, channel: RelayChannel, reason: string): void {
    channel.send({ t: 'refused', reason })
    channel.close('refused')
    this.endHosted(h)
  }

  private endHosted(h: HostRelay): void {
    if (h.phase === 'closed') return
    const wasOnce = h.via === 'once' && h.ptyId !== null
    h.phase = 'closed'
    if (h.wait) clearTimeout(h.wait)
    for (const s of h.sockets.values()) s.sock.drop()
    h.sockets.clear()
    for (const [id, a] of this.asks) {
      if (a.relay !== h.relay) continue
      clearTimeout(a.timer)
      this.asks.delete(id)
    }
    this.hosted.delete(h.relay)
    if (wasOnce && h.ptyId) {
      const still = [...this.hosted.values()].some((o) => o.guest === h.guest && o.ptyId === h.ptyId && o.via === 'once')
      if (!still) this.once = releaseOnce(this.once, h.guest, h.ptyId, this.d.now())
    }
    this.emit()
  }

  /** "Disconnect": every device attached here goes, and every "Allow once" with it. */
  dropGuests(): void {
    this.once = []
    for (const h of [...this.hosted.values()]) {
      const ch = h.channel
      if (ch && ch.state === 'open') this.refuse(h, ch, 'The owner of this computer disconnected you.')
      else {
        ch?.close('disconnected')
        this.endHosted(h)
      }
    }
    for (const a of [...this.asks.keys()]) void this.answer(a, 'deny')
    this.emit()
  }

  /** The tick moved: off drops every guest; either way the status says so at once. */
  sharingChanged(): void {
    if (!this.d.sharing()) this.dropGuests()
    void this.publish(true)
    this.emit()
  }

  /** An "Always" is taken back: that device's relays riding on it go now. */
  async revokeGrant(device: string): Promise<void> {
    await this.d.setGrant(device, null)
    for (const h of [...this.hosted.values()]) {
      if (h.guest !== device || h.via !== 'always') continue
      const ch = h.channel
      if (ch && ch.state === 'open') this.refuse(h, ch, 'The owner of this computer took back this device’s access.')
      else this.endHosted(h)
    }
    this.emit()
  }

  /**
   * The verified chain moved (a sync pass, a revoke, the hub's "removed").
   * Every hosted relay and pending question whose guest is no longer an
   * active device — by the key its handshake pinned — ends now, not when the
   * relay next closes; every remote tab whose host is gone ends and is not
   * reconnected; "Allow once" and "Always" for a removed device go. With no
   * context at all (this device is out of the vault) everything goes.
   * `hostFrame`, `answer` and `serve` re-read the chain too, but only when a
   * frame or an answer comes; this is what ends a relay that has gone quiet,
   * and a tab here whose host was removed (a stolen laptop).
   */
  chainChanged(): void {
    const ctx = this.d.context()
    let moved = false
    for (const h of [...this.hosted.values()]) {
      if (this.guestHolds(h)) continue
      moved = true
      const ch = h.channel
      if (ch && ch.state === 'open') this.refuse(h, ch, NOT_A_DEVICE)
      else {
        ch?.close('not a device of this account')
        this.endHosted(h)
      }
    }
    for (const t of [...this.tabs.values()]) {
      if (t.closed || this.holds(t.device, t.channel?.peerSignKey ?? null)) continue
      // Already at rest (nothing open, nothing scheduled): its banner stands.
      const resting = t.state === 'lost' || t.state === 'refused' || t.state === 'ended'
      if (resting && !t.channel && !t.timer && !t.connecting) continue
      moved = true
      // No context: it is THIS computer that left the vault (revoked, signed out), not the other one.
      this.endTab(t, 'lost', ctx ? `${this.nameOf(t.device)} is no longer one of your devices.` : 'This computer is no longer in your hub’s vault.')
    }
    const before = this.once.length
    this.once = this.once.filter((g) => this.holds(g.device, null))
    if (this.once.length !== before) moved = true
    if (ctx) {
      for (const device of Object.keys(this.d.grants())) {
        if (this.holds(device, null)) continue
        moved = true
        void this.d.setGrant(device, null).catch((err) => this.d.log('hub remote: could not take back a removed device’s grant', err))
      }
    }
    if (moved) this.emit()
  }

  /** A tab that will not reconnect by itself: its channel and timers go, its banner says why. */
  private endTab(t: GuestTab, state: 'lost' | 'refused', message: string): void {
    if (t.timer) clearTimeout(t.timer)
    if (t.hint) clearTimeout(t.hint)
    t.timer = null
    t.hint = null
    this.stopKeepAlive(t)
    t.gen++
    const ch = t.channel
    t.channel = null
    t.state = state
    t.message = message
    ch?.close(message)
  }

  /** Sign-out, a revoke, quit: every relay and tab goes, and nothing is remembered. */
  reset(): void {
    for (const t of [...this.tabs.keys()]) this.close(t)
    for (const h of [...this.hosted.values()]) {
      h.channel?.close('signed out')
      this.endHosted(h)
    }
    this.once = []
    this.presenceClosed()
  }
}

function toBytes(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (Array.isArray(data)) {
    const parts = data as Uint8Array[]
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }
  return new Uint8Array(0)
}
