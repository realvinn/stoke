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
 * - CHAT HISTORY (spec 2026-10-03 §3). As host: a relay that attaches
 *   `{ kind: 'chats' }` gets its own question ("search and read chat
 *   history"), its own grants (`hub.chatGrants`, a chats "Allow once" in
 *   `chatOnce`) and a scope of two GET routes; EVERY request re-checks the
 *   tick, chat history, the guest's place in the chain and the grant, and the
 *   tick going off ends every chats relay (`chatSharingChanged`). As guest:
 *   `searchChats` fans out to every online machine whose status says
 *   `chats: true`, over one chats relay per machine kept while the search is
 *   in use and closed after `CHATS_IDLE_MS`; `openRemoteChat` reads one.
 *
 * No electron import, so a suite can run two of these against a real hub.
 * No TypeScript parameter properties (strip-only mode).
 */
import { stableJson } from '../../shared/hub/codec.ts'
import { isGrid } from '../../shared/sizeClaim.ts'
import { CHAT_SEARCH_MIN_CHARS } from '../../shared/chatIndex.ts'
import { reconnectDelayMs, sealedStatusProblem, type PresenceClientFrame, type SealedStatus } from '../../shared/hub/protocol.ts'
import type { ChatGrant } from '../../shared/hub/settings.ts'
import {
  attachDecision,
  chatsAttachDecision,
  chatsSharingEffective,
  CHATS_ONCE_KEY,
  emptyRemoteView,
  holdOnce,
  newerStatus,
  onceHolds,
  otherMachines,
  parseRemoteChat,
  parseRemoteChatHits,
  parseRemoteSessionStatus,
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
  type RemoteChatOpen,
  type RemoteChatPeerState,
  type RemoteChatsResult,
  type RemoteChatsState,
  type RemoteRowLike,
  type RemoteSessionStatus,
  type RemoteStatus,
  type RemoteTabFrame,
  type RemoteTabState
} from '../../shared/hub/remote.ts'
import {
  CHAT_HITS_MAX,
  CHAT_QUERY_MAX,
  isChatNativeId,
  isChatSource,
  isPtyId,
  keyFingerprint,
  RELAY_ASK_MS,
  RELAY_PING_MS,
  RELAY_PONG_WAIT_MS,
  relayFrameVerdict,
  type HubGrant,
  type RelayInnerFrame,
  type RelayMode,
  type RelayRefusalCode
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
  /**
   * What this machine's own status bar says about ONE session — model,
   * effort, context, its account's usage — for a guest attached to it
   * (`RemoteSessionStatus`). Asked only for a serving relay's own session.
   * Absent: no status is sent.
   */
  sessionStatus?(ptyId: string): RemoteSessionStatus | null | Promise<RemoteSessionStatus | null>
  /**
   * This machine's own tab for a session draws a guest's resize and takes the
   * grid back when used here (main wires the relay server's `sized` hook), so
   * `ready` may say `sizes: true`. Absent: a guest sends this host no resize,
   * as it sends none to a host from before last active wins.
   */
  followsResize?: boolean
  /**
   * `settings.chatIndex === 'on'`, read on every call. Absent: this machine
   * never shares its chat history (no `chats: true`, every chats relay
   * refused). The two routes themselves are the relay server's
   * (`RemoteServer.serveChats`), reached through `request`.
   */
  chatIndexOn?(): boolean
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
  /** `hub.shareChats`, read on every call: "Let my other computers search this computer's chat history". */
  shareChats(): boolean
  /** `hub.chatGrants`, read on every call. Never `grants`: a session grant opens no chats. */
  chatGrants(): Record<string, ChatGrant>
  /** Give (`true`) or take back a device's chats "Always". Main refuses to give one while the tick is off. */
  setChatGrant(device: string, on: boolean): Promise<void>
  log(message: string, err?: unknown): void
  /** Tests only: the guest's keepalive, in real milliseconds (`RELAY_PING_MS`, `RELAY_PONG_WAIT_MS`). */
  keepAlive?: { pingMs: number; pongWaitMs: number }
  /** Tests only: the guest's chats timings, in real milliseconds (`CHATS_IDLE_MS`, `CHATS_WAIT_MS`, `CHATS_RETRY_MS`). */
  chatsTiming?: { idleMs?: number; waitMs?: number; retryMs?: number; requestMs?: number }
}

/** Why a relay from, or a tab to, a device the verified chain no longer holds as active is ended. */
const NOT_A_DEVICE = 'That device is no longer one of this account’s devices.'
/** Reconnect tries before a tab gives up and offers Try again. */
const MAX_TRIES = 8
const NOT_IN_VAULT = 'This computer is no longer in your hub’s vault.'
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
/** How often a host re-reads a served session's status, sending it only when it changed. */
const SESSION_STATUS_MS = 2000
/** A guest's chats relays close once no search or open has used them for this long. */
const CHATS_IDLE_MS = 2 * 60_000
/** How long one search waits for a chats relay to be served before it says `waiting`. */
const CHATS_WAIT_MS = 4000
/** A chats relay that failed is tried again by the first search this long after. */
const CHATS_RETRY_MS = 5000
/** One search's answer; an open's is three times it (a chat is up to 4 MiB). */
const CHATS_REQUEST_MS = 15_000
/** What the host's question names for a chats relay. */
const CHATS_TITLE = 'chat history'

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
  /** The host's last word on the session's model, context and usage, or null. */
  session: RemoteSessionStatus | null
  /**
   * The host's `ready` said `sizes: true` under a full grant: its own tab
   * follows this tab's resize. False until then, and for a host from before
   * last active wins, whose tab would keep its old grid while the pty took
   * this one's — the session drawn wrong at the desk (`resize`).
   */
  sizes: boolean
}

/**
 * Guest side: one other machine's chat history, reached over ONE chats relay
 * while a search here uses it. Kept, with its refusal, until the search goes
 * idle, so a "Deny" is not asked again at every keystroke.
 */
interface ChatPeer {
  device: string
  label: string
  state: RemoteChatPeerState
  message: string | null
  channel: RelayChannel | null
  /** Bumped per connect and at the end: a continuation acts only while it names the current attempt. */
  gen: number
  /** A connect is under way (claimed before its first await, gotcha 20). */
  connecting: boolean
  hint: ReturnType<typeof setTimeout> | null
  /** Searches waiting for the relay to be served, refused or lost. */
  waiters: Set<() => void>
  nextId: number
  pending: Map<number, (answer: { status: number; body: unknown } | null) => void>
  /** Real ms when it reached `error`: the first search `CHATS_RETRY_MS` later connects afresh. */
  failedAt: number
  closed: boolean
}

interface HostRelay {
  relay: string
  guest: string
  /** What the relay attached for: one session, or this machine's chat history. Null until it says. */
  kind: 'session' | 'chats' | null
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
  /** The session status last sent, serialised, so an unchanged one is not sent again. */
  statusSent: string | null
  /** A status read is under way (claimed before its await, gotcha 20). */
  statusBusy: boolean
}

interface PendingAsk {
  id: string
  /** `chats`: "search and read chat history"; an answer then writes `hub.chatGrants`, never `hub.grants`. */
  kind: 'session' | 'chats'
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
  /** Re-reads every served session's status while any relay is serving. */
  private statusTimer: ReturnType<typeof setInterval> | null
  private readonly tabs: Map<string, GuestTab>
  private readonly hosted: Map<string, HostRelay>
  private readonly asks: Map<string, PendingAsk>
  private once: OnceGrant[]
  /** Chats "Allow once", keyed `CHATS_ONCE_KEY`: a list of its own, so no session's once is ever read for chats. */
  private chatOnce: OnceGrant[]
  /** Guest side: one per other machine a search here is reaching. */
  private readonly chatPeers: Map<string, ChatPeer>
  private chatsIdle: ReturnType<typeof setTimeout> | null
  /** Whether the last status sent said `chats: true`: a fall to false ends every chats relay. */
  private chatsWere: boolean
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
    this.statusTimer = null
    this.tabs = new Map()
    this.hosted = new Map()
    this.asks = new Map()
    this.once = []
    this.chatOnce = []
    this.chatPeers = new Map()
    this.chatsIdle = null
    this.chatsWere = false
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
      message: t.message,
      session: t.session
    }))
    v.guests = [...this.hosted.values()]
      .filter((h) => h.phase === 'serving')
      .map((h) => ({
        relay: h.relay,
        kind: h.kind === 'chats' ? ('chats' as const) : ('session' as const),
        device: h.guest,
        label: label(h.guest),
        ptyId: h.ptyId,
        title: h.title,
        since: h.since,
        via: h.via
      }))
    v.asks = [...this.asks.values()].map((a) => ({
      id: a.id,
      kind: a.kind,
      device: a.device,
      label: a.label,
      platform: a.platform,
      fingerprint: a.fingerprint,
      ptyId: a.ptyId,
      title: a.title,
      expiresAt: a.expiresAt
    }))
    v.grants = Object.entries(this.d.grants()).map(([device, g]) => ({ device, label: ctx?.active.find((a) => a.id === device)?.label ?? g.label, mode: g.mode, at: g.at }))
    v.sharingChats = this.d.shareChats()
    v.chatsEffective = this.chatsEffective()
    v.chatGrants = Object.keys(this.d.chatGrants()).map((device) => {
      const a = ctx?.active.find((x) => x.id === device)
      return { device, label: a?.label ?? this.statuses[device]?.name ?? 'another device', platform: a?.platform ?? '', fingerprint: a ? keyFingerprint(a.sign) : '?' }
    })
    v.chatPeers = [...this.chatPeers.values()].map((p) => ({ device: p.device, label: p.label, state: p.state, message: p.message }))
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
    this.pushStatuses()
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
      /*
       * Chat history off, or the tick: no status says `chats: true`, and any
       * chats relay still open ends now rather than at its next request (the
       * poll is what notices a chat history switched off in Settings).
       */
      const chats = this.chatsEffective()
      if (this.chatsWere && !chats) this.endChats(`${ctx.me.label} stopped sharing its chat history.`)
      this.chatsWere = chats
      const now = this.d.now()
      // Strictly increasing per device (a hybrid clock): two statuses in one millisecond still order.
      const at = Math.max(now, this.lastAt + 1)
      const status = remoteStatusFrom({ at, name: ctx.me.label, platform: ctx.me.platform, open: sharing, rows, chats })
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
      closed: false,
      session: null,
      sizes: false
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

  /**
   * The remote tab is being used here: ask the host to size the pty to this
   * pane's grid (shared/sizeClaim.ts decides when). The phone's own resize
   * frame, so the host's phone server applies it, remembers its own size, and
   * puts it back when the last remote viewer leaves. Never to a host whose
   * `ready` did not say `sizes` (an older Stoke: its own tab would go on
   * drawing its old grid over output laid out for this one). False when
   * nothing was sent.
   */
  resize(tabId: string, cols: number, rows: number): boolean {
    const t = this.tabs.get(tabId)
    if (!t || t.state !== 'open' || !t.sizes || !t.channel || !isGrid({ cols, rows })) return false
    return t.channel.send({ t: 'ws-msg', id: PTY_SOCKET, data: JSON.stringify({ type: 'resize', cols, rows, force: true }) })
  }

  /** Try again after a refusal or a lost link. */
  retry(tabId: string): void {
    const t = this.tabs.get(tabId)
    if (!t || t.closed || t.connecting || t.state === 'open' || t.state === 'connecting' || t.state === 'asking') return
    // Nothing to try while THIS computer is out of the vault: the banner stays as final as it was.
    if (!this.d.context()) {
      this.endTab(t, 'lost', NOT_IN_VAULT)
      this.emit()
      return
    }
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
      if (!ctx) {
        // Final, not a lost link: `lost` would schedule eight more rounds (about three minutes)
        // that can never succeed, showing "Reconnecting…" (found in review, 2026-10-02).
        this.endTab(t, 'lost', NOT_IN_VAULT)
        this.emit()
        return
      }
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
        // Only a host that says its own tab follows takes a resize from here (relay.ts `ready`).
        t.sizes = f.mode === 'full' && f.sizes === true
        channel.send({ t: 'ws-open', id: PTY_SOCKET, path: `/ws?ptyId=${encodeURIComponent(t.ptyId)}` })
        this.emit()
        return
      case 'status': {
        // Text another machine chose: parsed and cut, and drawn only for this tab.
        const next = parseRemoteSessionStatus(f.status)
        if (JSON.stringify(next) === JSON.stringify(t.session)) return
        t.session = next
        this.emit()
        return
      }
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
      kind: null,
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
      wait: null,
      statusSent: null,
      statusBusy: false
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
      h.phase = 'asking'
      if (f.kind === 'chats') {
        h.kind = 'chats'
        this.decideChats(h, channel)
        return
      }
      h.kind = 'session'
      h.ptyId = f.ptyId
      await this.decide(h, channel)
      return
    }
    if (h.phase !== 'serving' || !h.mode || !h.scope) return
    if (h.kind === 'chats') return this.hostChatsFrame(h, channel, f)
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
        // The grant's mode, then its reach: keys and a resize go only to this relay's own session's pty.
        const verdict = relayFrameVerdict(h.mode, f, s.path)
        if (!verdict.ok || !relayScopeVerdict(h.scope, f, s.path).ok) return
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
      if (a.kind === 'session' && a.device === h.guest && a.ptyId === h.ptyId) return this.refuse(h, channel, 'This computer is already asking about that session.', 'busy')
    }
    const peer = ctx.active.find((a) => a.id === h.guest)
    const id = `ask-${randomB64u(9)}`
    const ask: PendingAsk = {
      id,
      kind: 'session',
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
      this.refuse(h, channel, why ?? `The owner of ${this.d.context()?.me.label ?? 'that computer'} said no.`, 'denied')
      return { ok: true }
    }
    if (a.kind === 'chats') return this.answerChats(h, channel, answer)
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

  /* ---------------------------------------------- host: chat history */

  /** `hub.shareChats`, chat history on, and this device in the vault (`chatsSharingEffective`), read now. */
  private chatsEffective(): boolean {
    return chatsSharingEffective({ share: this.d.shareChats(), indexOn: this.d.chatIndexOn?.() === true, inVault: this.d.context() !== null })
  }

  /** A chats relay's first decision: refuse, serve under a chats grant, or ask "search and read chat history?". */
  private decideChats(h: HostRelay, channel: RelayChannel): void {
    const ctx = this.d.context()
    if (!ctx) return this.refuse(h, channel, 'This computer is not in your hub’s vault any more.', 'not-sharing')
    const now = this.d.now()
    this.chatOnce = pruneOnce(this.chatOnce, now)
    const decision = chatsAttachDecision({
      sharing: this.d.shareChats(),
      indexOn: this.d.chatIndexOn?.() === true,
      grant: this.d.chatGrants()[h.guest] ?? null,
      once: this.chatOnce,
      device: h.guest,
      hostName: ctx.me.label,
      now
    })
    if (decision.t === 'refuse') return this.refuse(h, channel, decision.reason, decision.code)
    if (decision.t === 'allow') return this.serveChats(h, channel, decision.via)
    for (const a of this.asks.values()) {
      if (a.kind === 'chats' && a.device === h.guest) return this.refuse(h, channel, 'This computer is already asking about its chat history.', 'busy')
    }
    const peer = ctx.active.find((a) => a.id === h.guest)
    const id = `ask-${randomB64u(9)}`
    this.asks.set(id, {
      id,
      kind: 'chats',
      relay: h.relay,
      device: h.guest,
      label: peer?.label ?? this.statuses[h.guest]?.name ?? 'another device',
      platform: peer?.platform ?? '',
      fingerprint: peer ? keyFingerprint(peer.sign) : '?',
      ptyId: '',
      title: CHATS_TITLE,
      expiresAt: now + RELAY_ASK_MS,
      timer: setTimeout(() => void this.answer(id, 'deny', 'Nobody answered on the other machine in time.'), RELAY_ASK_MS)
    })
    this.emit()
  }

  /** The owner's Allow once or Always to a chats question (Deny was handled with the sessions'). */
  private async answerChats(h: HostRelay, channel: RelayChannel, answer: 'once' | 'always'): Promise<{ ok: boolean }> {
    if (!this.chatsEffective()) {
      this.refuse(h, channel, 'That computer stopped sharing its chat history.', 'not-sharing')
      return { ok: true }
    }
    if (answer === 'always') {
      await this.d.setChatGrant(h.guest, true)
      // The chain, or the tick, moved during the write: take it back before anything is served under it.
      if (!this.guestHolds(h) || !this.chatsEffective()) {
        await this.d.setChatGrant(h.guest, false)
        if (h.phase === 'asking') this.refuse(h, channel, this.guestHolds(h) ? 'That computer stopped sharing its chat history.' : NOT_A_DEVICE, this.guestHolds(h) ? 'not-sharing' : 'not-a-device')
        return { ok: false }
      }
      if (h.phase !== 'asking') return { ok: false }
      this.serveChats(h, channel, 'always')
    } else {
      this.serveChats(h, channel, 'once')
    }
    return { ok: true }
  }

  private serveChats(h: HostRelay, channel: RelayChannel, via: 'once' | 'always'): void {
    const ctx = this.d.context()
    if (!ctx) return this.refuse(h, channel, 'This computer is not in your hub’s vault any more.', 'not-sharing')
    if (!this.guestHolds(h)) return this.refuse(h, channel, NOT_A_DEVICE, 'not-a-device')
    // Read-only, and two routes: `relayScopeVerdict`'s chats scope.
    h.mode = 'view'
    h.via = via
    h.scope = { kind: 'chats' }
    if (via === 'once') this.chatOnce = holdOnce(this.chatOnce, h.guest, CHATS_ONCE_KEY)
    h.phase = 'serving'
    channel.send({ t: 'ready', mode: 'view', host: { label: ctx.me.label, platform: ctx.me.platform } })
    this.emit()
  }

  /**
   * Whether a serving chats relay may have its next request, read NOW (spec
   * §3: "on every request the host re-checks"): the tick and chat history
   * (`chatsEffective`), and its grant — an "Always" still in
   * `hub.chatGrants`, or the "Allow once" it was served under still held.
   * The guest's place in the chain is `hostFrame`'s first check.
   */
  private chatsAllowed(h: HostRelay): { ok: true } | { ok: false; reason: string; code: RelayRefusalCode } {
    const ctx = this.d.context()
    if (!ctx || !this.chatsEffective()) return { ok: false, reason: `${ctx?.me.label ?? 'That computer'} stopped sharing its chat history.`, code: 'not-sharing' }
    const always = this.d.chatGrants()[h.guest] === 'always'
    const once = h.via === 'once' && onceHolds(this.chatOnce, h.guest, CHATS_ONCE_KEY, this.d.now())
    if (!always && !once) return { ok: false, reason: 'This computer’s owner took back this device’s access to its chat history.', code: 'denied' }
    return { ok: true }
  }

  /** One frame on a serving chats relay: the two GET routes, nothing else. */
  private async hostChatsFrame(h: HostRelay, channel: RelayChannel, f: RelayInnerFrame): Promise<void> {
    switch (f.t) {
      case 'req': {
        const allowed = this.chatsAllowed(h)
        if (!allowed.ok) return this.refuse(h, channel, allowed.reason, allowed.code)
        const verdict = this.judge(h, f)
        if (!verdict.ok) {
          channel.send({ t: 'res', id: f.id, status: 403, body: { error: verdict.reason } })
          return
        }
        const answer = await this.d.request(f.method, f.path, f.body)
        // Read again after the await: a switch-off or a removal meanwhile sends nothing it read.
        if (h.phase === 'serving' && this.guestHolds(h) && this.chatsAllowed(h).ok) channel.send({ t: 'res', id: f.id, status: answer.status, body: answer.body })
        return
      }
      case 'ws-open':
        // No socket at all: a chats relay never reaches a pty.
        channel.send({ t: 'ws-close', id: f.id, code: 1008, reason: 'This connection reaches only chat history search.' })
        return
      default:
        return
    }
  }

  /** Every chats relay served or asking here ends, and every chats "Allow once" with it. */
  private endChats(reason: string): void {
    this.chatOnce = []
    for (const h of [...this.hosted.values()]) {
      if (h.kind !== 'chats') continue
      const ch = h.channel
      if (ch && ch.state === 'open') this.refuse(h, ch, reason, 'not-sharing')
      else {
        ch?.close('stopped sharing')
        this.endHosted(h)
      }
    }
  }

  /**
   * The chats tick (or chat history) moved. Off ends every chats relay and
   * question at once (spec §3, "turning the switch off closes every chats
   * relay"); either way the status says so at once.
   */
  chatSharingChanged(): void {
    if (!this.chatsEffective()) this.endChats(`${this.d.context()?.me.label ?? 'That computer'} stopped sharing its chat history.`)
    this.chatsWere = this.chatsEffective()
    void this.publish(true)
    this.emit()
  }

  /** A chats "Always" taken back (Settings' Remove): that device's chats relays, and its chats "Allow once", go now. */
  async revokeChatGrant(device: string): Promise<void> {
    await this.d.setChatGrant(device, false)
    this.chatOnce = this.chatOnce.filter((g) => g.device !== device)
    for (const h of [...this.hosted.values()]) {
      if (h.guest !== device || h.kind !== 'chats') continue
      const ch = h.channel
      if (ch && ch.state === 'open') this.refuse(h, ch, 'This computer’s owner took back this device’s access to its chat history.', 'denied')
      else this.endHosted(h)
    }
    this.emit()
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
    channel.send({
      t: 'ready',
      mode,
      host: { label: ctx.me.label, platform: ctx.me.platform },
      ...(this.d.followsResize ? { sizes: true } : {})
    })
    void this.pushStatus(h)
    this.armStatus()
    this.emit()
  }

  /* ---------------------------------------------- the served session's status */

  /** While any relay is serving, re-read each one's session status on a timer; none serving, no timer. */
  private armStatus(): void {
    const serving = [...this.hosted.values()].some((h) => h.phase === 'serving')
    if (serving && !this.statusTimer && this.d.sessionStatus) {
      this.statusTimer = setInterval(() => this.pushStatuses(), SESSION_STATUS_MS)
      this.statusTimer.unref?.()
    } else if (!serving && this.statusTimer) {
      clearInterval(this.statusTimer)
      this.statusTimer = null
    }
  }

  private pushStatuses(): void {
    for (const h of this.hosted.values()) if (h.phase === 'serving') void this.pushStatus(h)
  }

  /**
   * The status of THIS relay's session (`h.ptyId`, the one its scope reaches)
   * and no other, sent when it differs from the last one sent. One read at a
   * time per relay (gotcha 20); a relay that stopped serving meanwhile gets
   * nothing.
   */
  private async pushStatus(h: HostRelay): Promise<void> {
    const read = this.d.sessionStatus
    if (!read || h.statusBusy || h.phase !== 'serving' || !h.ptyId) return
    h.statusBusy = true
    try {
      const status = await read(h.ptyId)
      if (h.phase !== 'serving' || !status || !this.guestHolds(h)) return
      const text = stableJson(status)
      if (text === h.statusSent) return
      if (h.channel?.send({ t: 'status', status })) h.statusSent = text
    } catch (err) {
      this.d.log('hub remote: could not read a served session’s status', err)
    } finally {
      h.statusBusy = false
    }
  }

  private refuse(h: HostRelay, channel: RelayChannel, reason: string, code?: RelayRefusalCode): void {
    channel.send(code ? { t: 'refused', reason, code } : { t: 'refused', reason })
    channel.close('refused')
    this.endHosted(h)
  }

  private endHosted(h: HostRelay): void {
    if (h.phase === 'closed') return
    const wasOnce = h.via === 'once' && h.ptyId !== null
    const wasChatsOnce = h.kind === 'chats' && h.via === 'once' && h.phase === 'serving'
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
    this.armStatus()
    if (wasOnce && h.ptyId) {
      const still = [...this.hosted.values()].some((o) => o.guest === h.guest && o.ptyId === h.ptyId && o.via === 'once')
      if (!still) this.once = releaseOnce(this.once, h.guest, h.ptyId, this.d.now())
    }
    if (wasChatsOnce) {
      // A search that pauses and comes back within the grace is not asked again (`ONCE_GRACE_MS`).
      const still = [...this.hosted.values()].some((o) => o.guest === h.guest && o.kind === 'chats' && o.via === 'once')
      if (!still) this.chatOnce = releaseOnce(this.chatOnce, h.guest, CHATS_ONCE_KEY, this.d.now())
    }
    this.emit()
  }

  /** "Disconnect": every device attached here goes, and every "Allow once" with it. */
  dropGuests(): void {
    this.once = []
    this.chatOnce = []
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

  /**
   * The sessions tick moved: off drops every SESSION guest and its "Allow
   * once"; either way the status says so at once. A chats relay is the chats
   * tick's (`chatSharingChanged`), and a relay that has not said what it is
   * for yet is judged when it does.
   */
  sharingChanged(): void {
    if (!this.d.sharing()) {
      this.once = []
      for (const h of [...this.hosted.values()]) {
        if (h.kind !== 'session') continue
        const ch = h.channel
        if (ch && ch.state === 'open') this.refuse(h, ch, 'The owner of this computer disconnected you.')
        else {
          ch?.close('disconnected')
          this.endHosted(h)
        }
      }
    }
    void this.publish(true)
    this.emit()
  }

  /** An "Always" is taken back: that device's session relays riding on it go now (its chats grant is `revokeChatGrant`'s). */
  async revokeGrant(device: string): Promise<void> {
    await this.d.setGrant(device, null)
    for (const h of [...this.hosted.values()]) {
      if (h.guest !== device || h.via !== 'always' || h.kind !== 'session') continue
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
      this.endTab(t, 'lost', ctx ? `${this.nameOf(t.device)} is no longer one of your devices.` : NOT_IN_VAULT)
    }
    const before = this.once.length + this.chatOnce.length
    this.once = this.once.filter((g) => this.holds(g.device, null))
    this.chatOnce = this.chatOnce.filter((g) => this.holds(g.device, null))
    if (this.once.length + this.chatOnce.length !== before) moved = true
    if (ctx) {
      for (const device of Object.keys(this.d.grants())) {
        if (this.holds(device, null)) continue
        moved = true
        void this.d.setGrant(device, null).catch((err) => this.d.log('hub remote: could not take back a removed device’s grant', err))
      }
      // Removing a device ends its chats grant too (spec 2026-10-03 §3): a revoked laptop searches nothing here.
      for (const device of Object.keys(this.d.chatGrants())) {
        if (this.holds(device, null)) continue
        moved = true
        void this.d.setChatGrant(device, false).catch((err) => this.d.log('hub remote: could not take back a removed device’s chats grant', err))
      }
    }
    // Guest side: a search reaching a machine the chain no longer holds stops reaching it.
    for (const p of [...this.chatPeers.values()]) {
      if (this.holds(p.device, p.channel?.peerSignKey ?? null)) continue
      moved = true
      this.dropPeer(p, 'the device is no longer one of yours')
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
    this.chatOnce = []
    this.endChatSearch()
    this.presenceClosed()
  }

  /* ======================================================== guest: chat history */

  /**
   * Search every other machine's chat history (spec 2026-10-03 §3): each
   * online machine whose status says `chats: true` is asked over its own
   * chats relay, opened by the first search and kept while searches keep
   * coming (`CHATS_IDLE_MS`). Never merged: one result per machine the chain
   * holds, with its hits or why there are none — `offline`, `not-sharing`,
   * `waiting` (its owner is being asked, or the relay is still coming up),
   * `denied`, `error`. A machine that answers later moves `chatPeers` in the
   * view, which is the renderer's cue to search again. Nothing is stored.
   */
  async searchChats(q: unknown): Promise<RemoteChatsResult[]> {
    const ctx = this.d.context()
    if (!ctx || typeof q !== 'string') return []
    let query = q.slice(0, CHAT_QUERY_MAX)
    // Never cut a surrogate pair in half: `encodeURIComponent` throws on a lone one.
    if (/[\ud800-\udbff]$/.test(query)) query = query.slice(0, -1)
    if (query.trim().length < CHAT_SEARCH_MIN_CHARS) return []
    let encoded: string
    try {
      encoded = encodeURIComponent(query)
    } catch {
      return []
    }
    this.touchChats()
    const others = ctx.active.filter((a) => a.id !== ctx.me.id)
    const results = await Promise.all(
      others.map((a) => this.searchOne(a, `/api/chats/search?q=${encoded}&limit=${CHAT_HITS_MAX}`))
    )
    return results.sort((a, b) => a.label.localeCompare(b.label) || a.device.localeCompare(b.device))
  }

  /** Read one chat another machine's search found, through the same chats relay. Read-only; nothing is kept here. */
  async openRemoteChat(device: unknown, source: unknown, nativeId: unknown): Promise<RemoteChatOpen> {
    const ctx = this.d.context()
    if (!ctx) return { ok: false, state: 'error', message: NOT_IN_VAULT }
    const a = typeof device === 'string' && device !== ctx.me.id ? ctx.active.find((x) => x.id === device) : undefined
    if (!a) return { ok: false, state: 'error', message: 'That computer is not one of your devices.' }
    if (!isChatSource(source) || !isChatNativeId(nativeId)) return { ok: false, state: 'error', message: 'That is not a chat.' }
    this.touchChats()
    const reach = await this.reachChats(a)
    if ('state' in reach) return { ok: false, state: reach.state, message: reach.message }
    const answer = await this.chatRequest(reach.peer, `/api/chats/open?source=${encodeURIComponent(source)}&id=${encodeURIComponent(nativeId)}`, this.chatsMs('requestMs', CHATS_REQUEST_MS) * 3)
    const failed = this.failedAnswer(reach.peer, answer, `${reach.label} could not open that chat.`)
    if (failed) return { ok: false, state: failed.state, message: failed.message ?? '' }
    const chat = parseRemoteChat(answer!.body)
    if (!chat) return { ok: false, state: 'error', message: `${reach.label} answered with something that is not a chat.` }
    return { ok: true, device: a.id, label: reach.label, chat }
  }

  /** The search box closed: every chats relay this machine holds goes now, not after `CHATS_IDLE_MS`. */
  endChatSearch(): void {
    if (this.chatsIdle) clearTimeout(this.chatsIdle)
    this.chatsIdle = null
    if (this.chatPeers.size === 0) return
    for (const p of [...this.chatPeers.values()]) this.dropPeer(p, 'the search ended')
    this.emit()
  }

  private chatsMs(key: 'idleMs' | 'waitMs' | 'retryMs' | 'requestMs', dflt: number): number {
    return this.d.chatsTiming?.[key] ?? dflt
  }

  /** A search or an open used the chats relays: they stay another `CHATS_IDLE_MS`. */
  private touchChats(): void {
    if (this.chatsIdle) clearTimeout(this.chatsIdle)
    this.chatsIdle = setTimeout(() => {
      this.chatsIdle = null
      this.endChatSearch()
    }, this.chatsMs('idleMs', CHATS_IDLE_MS))
    this.chatsIdle.unref?.()
  }

  private async searchOne(a: { id: string; label: string; platform: string }, path: string): Promise<RemoteChatsResult> {
    const label = this.statuses[a.id]?.name || a.label
    const base = { device: a.id, label, platform: a.platform, hits: [] }
    const reach = await this.reachChats(a)
    if ('state' in reach) return { ...base, state: reach.state, message: reach.message }
    const answer = await this.chatRequest(reach.peer, path, this.chatsMs('requestMs', CHATS_REQUEST_MS))
    const failed = this.failedAnswer(reach.peer, answer, `${label} could not search its chat history.`)
    if (failed) return { ...base, state: failed.state, message: failed.message }
    const hits = parseRemoteChatHits(answer!.body)
    if (!hits) return { ...base, state: 'error', message: `${label} answered with something that is not a search.` }
    return { ...base, state: 'ok', message: null, hits }
  }

  /**
   * A served chats relay to `a`, or why there is none: offline and not
   * sharing are read from presence without opening anything; otherwise the
   * machine's peer, opened if need be, waited for up to `CHATS_WAIT_MS`.
   */
  private async reachChats(a: { id: string; label: string }): Promise<{ peer: ChatPeer; label: string } | { state: RemoteChatsState; message: string }> {
    const label = this.statuses[a.id]?.name || a.label
    if (!this.online.includes(a.id)) {
      // Not reached, and not kept: an offline machine's relay would fail anyway.
      const p = this.chatPeers.get(a.id)
      if (p) {
        this.dropPeer(p, 'offline')
        this.emit()
      }
      return { state: 'offline', message: `${label} is offline — not searched.` }
    }
    if (this.statuses[a.id]?.chats !== true) return { state: 'not-sharing', message: `${label} isn’t sharing chat history.` }
    const p = this.chatPeer(a.id, label)
    await this.settle(p, this.chatsMs('waitMs', CHATS_WAIT_MS))
    if (p.state === 'open') return { peer: p, label }
    return this.peerState(p)
  }

  /** What a peer that is not `open` says, as a search result's state. */
  private peerState(p: ChatPeer): { state: RemoteChatsState; message: string } {
    switch (p.state) {
      case 'connecting':
        return { state: 'waiting', message: `Still reaching ${p.label}…` }
      case 'waiting':
        return { state: 'waiting', message: `Waiting for ${p.label} to allow it…` }
      case 'denied':
      case 'not-sharing':
        return { state: p.state, message: p.message ?? `${p.label} said no.` }
      default:
        return { state: 'error', message: p.message ?? `${p.label} could not be reached.` }
    }
  }

  /** Null when `answer` is a 200; otherwise the state to say (the peer's own, if it ended meanwhile). */
  private failedAnswer(p: ChatPeer, answer: { status: number; body: unknown } | null, fallback: string): { state: RemoteChatsState; message: string } | null {
    if (answer && answer.status === 200) return null
    if (p.state !== 'open') return this.peerState(p)
    if (!answer) return { state: 'error', message: `${p.label} did not answer in time.` }
    const body = answer.body as { error?: unknown } | null
    const said = body && typeof body.error === 'string' ? oneLine(body.error) : ''
    return { state: 'error', message: said || fallback }
  }

  /**
   * The machine's peer: the live one, or a new one connecting. A Deny stands
   * until the search ends, so its owner is not asked again at every keystroke;
   * a failure, or "not sharing" from a machine whose status says it is, is
   * tried again `CHATS_RETRY_MS` later.
   */
  private chatPeer(device: string, label: string): ChatPeer {
    const have = this.chatPeers.get(device)
    const retryable = have !== undefined && (have.state === 'error' || have.state === 'not-sharing')
    if (have && (!retryable || Date.now() - have.failedAt < this.chatsMs('retryMs', CHATS_RETRY_MS))) return have
    if (have) this.dropPeer(have, 'trying again')
    const p: ChatPeer = {
      device,
      label,
      state: 'connecting',
      message: null,
      channel: null,
      gen: 0,
      connecting: false,
      hint: null,
      waiters: new Set(),
      nextId: 0,
      pending: new Map(),
      failedAt: 0,
      closed: false
    }
    this.chatPeers.set(device, p)
    void this.connectChats(p)
    this.emit()
    return p
  }

  private async connectChats(p: ChatPeer): Promise<void> {
    if (p.closed || p.connecting) return
    p.connecting = true
    const gen = ++p.gen
    const current = (): boolean => !p.closed && p.gen === gen
    try {
      const ctx = this.d.context()
      if (!ctx) return this.peerEnded(p, 'error', NOT_IN_VAULT)
      const { relay } = await this.d.createRelay(p.device)
      if (!current()) return
      const socket = await this.d.openRelay(relay)
      if (!current()) {
        socket.close(1000, 'the search ended')
        return
      }
      const channel = new RelayChannel({
        role: 'guest',
        relay,
        account: ctx.account,
        me: { id: ctx.me.id, signPriv: ctx.me.signPriv },
        peer: p.device,
        peerKey: (id) => this.d.context()?.active.find((a) => a.id === id && a.id !== ctx.me.id)?.sign ?? null,
        io: { send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason) },
        events: {
          onOpen: () => {
            if (!current()) return
            channel.send({ t: 'attach', kind: 'chats' })
            p.hint = setTimeout(() => {
              if (!current() || p.state !== 'connecting') return
              p.state = 'waiting'
              p.message = `Waiting for ${p.label} to allow it…`
              this.wake(p)
              this.emit()
            }, ASKING_HINT_MS)
          },
          onFrame: (f) => {
            if (current()) this.guestChatsFrame(p, channel, f)
          },
          onClose: (reason) => {
            if (p.channel === channel) p.channel = null
            if (current()) this.peerEnded(p, 'error', reason)
          }
        }
      })
      p.channel = channel
      socket.on('open', () => channel.start())
      socket.on('message', (data, binary) => channel.receive(binary ? toBytes(data) : String(data), binary))
      socket.on('close', () => channel.close('the relay closed'))
      socket.on('error', () => undefined)
      if (socket.readyState === 1) channel.start()
    } catch (err) {
      if (current()) this.peerEnded(p, 'error', err instanceof Error ? err.message : String(err))
    } finally {
      p.connecting = false
    }
  }

  private guestChatsFrame(p: ChatPeer, channel: RelayChannel, f: RelayInnerFrame): void {
    switch (f.t) {
      case 'ready':
        if (p.hint) clearTimeout(p.hint)
        p.hint = null
        p.state = 'open'
        p.message = null
        this.wake(p)
        this.emit()
        return
      case 'refused': {
        const state: RemoteChatPeerState = f.code === 'not-sharing' ? 'not-sharing' : f.code === 'denied' ? 'denied' : 'error'
        this.peerEnded(p, state, oneLine(f.reason))
        return
      }
      case 'res': {
        const settle = p.pending.get(f.id)
        if (settle) settle({ status: f.status, body: f.body })
        return
      }
      case 'ping':
        channel.send({ t: 'pong' })
        return
      default:
        return
    }
  }

  /** The peer's relay ended (refused, lost, or failed to open): it stays, saying why, until retried or the search ends. */
  private peerEnded(p: ChatPeer, state: RemoteChatPeerState, message: string): void {
    if (p.closed) return
    if (p.hint) clearTimeout(p.hint)
    p.hint = null
    p.state = state
    p.message = message
    p.failedAt = Date.now()
    p.gen++
    const ch = p.channel
    p.channel = null
    ch?.close(message)
    for (const settle of [...p.pending.values()]) settle(null)
    p.pending.clear()
    this.wake(p)
    this.emit()
  }

  /** Gone for good (the search ended, the device left): its relay closes and it is forgotten. */
  private dropPeer(p: ChatPeer, why: string): void {
    p.closed = true
    if (p.hint) clearTimeout(p.hint)
    p.hint = null
    p.gen++
    const ch = p.channel
    p.channel = null
    ch?.close(why)
    for (const settle of [...p.pending.values()]) settle(null)
    p.pending.clear()
    this.wake(p)
    if (this.chatPeers.get(p.device) === p) this.chatPeers.delete(p.device)
  }

  private wake(p: ChatPeer): void {
    for (const w of [...p.waiters]) w()
  }

  /** Resolves once the peer is past `connecting` (served, asking, refused or lost), or after `ms`. */
  private settle(p: ChatPeer, ms: number): Promise<void> {
    if (p.state !== 'connecting') return Promise.resolve()
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        p.waiters.delete(done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      p.waiters.add(done)
    })
  }

  /** One GET over a served chats relay, answered by its `res` or null (lost, or not in `ms`). */
  private chatRequest(p: ChatPeer, path: string, ms: number): Promise<{ status: number; body: unknown } | null> {
    const ch = p.channel
    if (!ch || p.state !== 'open') return Promise.resolve(null)
    const id = ++p.nextId
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        p.pending.delete(id)
        resolve(null)
      }, ms)
      p.pending.set(id, (answer) => {
        clearTimeout(timer)
        p.pending.delete(id)
        resolve(answer)
      })
      if (!ch.send({ t: 'req', id, method: 'GET', path })) p.pending.get(id)?.(null)
    })
  }
}

/** A sentence another machine sent, as one line of at most 300 characters. */
function oneLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 300)
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
