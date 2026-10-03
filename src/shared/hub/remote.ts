/*
 * "Other machines": one signed-in desktop seeing, and opening, the sessions of
 * the owner's other desktops through the hub (spec §6).
 *
 * Two halves, both decided here and nowhere else:
 *
 * - The STATUS a device tells its other devices over presence: its name, its
 *   platform, and — only when its owner ticked "Let my other devices see and
 *   open my sessions" on THAT machine (`hub.shareSessions`, default off) — a
 *   summary of its sessions. Sealed under the epoch's presence key before it
 *   leaves (crypto.ts `sealStatus`), so the hub forwards bytes it cannot read.
 *   `parseRemoteStatus` is the only way one comes back in: every field is
 *   checked and cut to size, because it is text another machine chose.
 * - The HOST's rules for a relay that asks for one of its sessions: whether to
 *   serve it, ask the owner, or refuse (`attachDecision`), what a relay then
 *   reaches — its own session, under either answer (`relayScopeVerdict`) —
 *   and how long an "Allow once" lasts across a dropped link (`OnceGrant`,
 *   `ONCE_GRACE_MS`). An "Always" is a `HubGrant` in the host's own
 *   `hub.grants` (T0: never synced, so neither the hub nor any synced item
 *   can grant anything); revoking it is deleting it.
 * - CHAT HISTORY (spec 2026-10-03 §3): a status says `chats: true` while
 *   this machine shares it (`chatsSharingEffective`); a relay that attaches
 *   `{ kind: 'chats' }` is judged by its own rule (`chatsAttachDecision`), its
 *   own "Always" (`hub.chatGrants`) and its own "Allow once", and reaches
 *   exactly two GET routes (`relayScopeVerdict`'s `chats` scope). What it
 *   answers is cut to shape here (`remoteChatHitFrom`, `remoteChatFrom`) and
 *   read back as text another machine chose (`parseRemoteChatHits`,
 *   `parseRemoteChat`): a folder by its last segment, never a path.
 *
 * Pure (gotcha 27); imports only src/shared by relative `.ts` path (gotcha 78).
 */
import type { UsageWindow } from '../types.ts'
import type { ChatSearchHit, ChatTranscript } from '../chatIndex.ts'
import { isId, isRecord } from './codec.ts'
import {
  CHAT_HITS_MAX,
  isChatNativeId,
  isChatSource,
  isPtyId,
  relayRouteFor,
  type HubGrant,
  type RelayInnerFrame,
  type RelayMode,
  type RelayRefusalCode
} from './relay.ts'
import type { ChatGrant } from './settings.ts'

/* ------------------------------------------------------------ the status */

/** Sessions one status lists at most (the newest first, as the phone sorts them). */
export const REMOTE_MAX_SESSIONS = 24
/** A status is sent at most this often, however fast its sessions change. */
export const REMOTE_STATUS_MIN_MS = 3000
/** How often a device re-reads its own sessions to see whether its status moved. */
export const REMOTE_STATUS_POLL_MS = 4000

export type RemoteSessionState = 'waiting' | 'busy' | 'idle' | 'ended' | 'unknown'

/** One session, as another machine sees it in its list. Never a path, never a command. */
export interface RemoteSessionSummary {
  ptyId: string
  /** The project's folder name (or an SSH host's name), never its path. */
  project: string
  title: string | null
  status: RemoteSessionState
  /** The agent's display name ("Claude Code"). */
  agent: string
  /** Context used and the window, when known. */
  context: { used: number; limit: number } | null
  lastActivityAt: number | null
}

/** What one device tells the others about itself (the plaintext of a `SealedStatus`). */
export interface RemoteStatus {
  v: 1
  /** When it was made, ms: a later one replaces an earlier, never the reverse. */
  at: number
  name: string
  platform: string
  /** The owner let the other devices see and open this machine's sessions. False: `sessions` is empty. */
  open: boolean
  sessions: RemoteSessionSummary[]
  /**
   * The owner lets the other devices search this machine's chat history, and
   * it is on here (`chatsSharingEffective`). A guest opens a chats relay only
   * to a machine saying so. Absent in a status from before it: false.
   */
  chats: boolean
}

/** The phone API's session row, as much of it as a summary is made from (server.ts `RemoteSessionRow`). */
export interface RemoteRowLike {
  ptyId: string
  project: string
  title: string | null
  status: string
  agentName: string
  exited: boolean
  lastActivityAt: number | null
  context: { contextTokens: number; contextLimit: number; ready?: boolean } | null
}

const STATES: readonly RemoteSessionState[] = ['waiting', 'busy', 'idle', 'ended', 'unknown']

function clip(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  // One line, no control characters: it is drawn as a label on another machine.
  // eslint-disable-next-line no-control-regex
  return [...v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()].slice(0, max).join('')
}

function count(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
}

/**
 * This device's status. `open` false lists no session at all — the tick is
 * what lets the other machines see them, not only open them. An ended
 * session is left out: it cannot be opened, and the list is for opening.
 */
export function remoteStatusFrom(f: { at: number; name: string; platform: string; open: boolean; rows: readonly RemoteRowLike[]; chats?: boolean }): RemoteStatus {
  const sessions = f.open
    ? f.rows
        .filter((r) => !r.exited && isPtyId(r.ptyId))
        .slice(0, REMOTE_MAX_SESSIONS)
        .map(
          (r): RemoteSessionSummary => ({
            ptyId: r.ptyId,
            project: clip(r.project, 80),
            title: r.title ? clip(r.title, 120) || null : null,
            status: (STATES as readonly string[]).includes(r.status) ? (r.status as RemoteSessionState) : 'unknown',
            agent: clip(r.agentName, 40),
            context:
              r.context && r.context.contextLimit > 0 && (r.context.ready ?? true)
                ? { used: Math.max(0, Math.round(r.context.contextTokens)), limit: Math.round(r.context.contextLimit) }
                : null,
            lastActivityAt: count(r.lastActivityAt)
          })
        )
    : []
  return { v: 1, at: Math.floor(f.at), name: clip(f.name, 64) || 'Stoke', platform: clip(f.platform, 24) || 'other', open: f.open, sessions, chats: f.chats === true }
}

/**
 * A status another device sealed, as this device will show it — or null for
 * anything that is not one. Every string is cut and stripped of control
 * characters, the list is capped, and a session that does not parse is
 * dropped rather than failing the whole status.
 */
export function parseRemoteStatus(text: string): RemoteStatus | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(v) || v.v !== 1 || count(v.at) === null || typeof v.open !== 'boolean' || !Array.isArray(v.sessions)) return null
  const sessions: RemoteSessionSummary[] = []
  for (const s of v.sessions.slice(0, REMOTE_MAX_SESSIONS)) {
    if (!isRecord(s) || !isPtyId(s.ptyId)) continue
    const ctx = isRecord(s.context) ? s.context : null
    const used = ctx ? count(ctx.used) : null
    const limit = ctx ? count(ctx.limit) : null
    sessions.push({
      ptyId: s.ptyId,
      project: clip(s.project, 80),
      title: typeof s.title === 'string' ? clip(s.title, 120) || null : null,
      status: typeof s.status === 'string' && (STATES as readonly string[]).includes(s.status) ? (s.status as RemoteSessionState) : 'unknown',
      agent: clip(s.agent, 40),
      context: used !== null && limit !== null && limit > 0 ? { used, limit } : null,
      lastActivityAt: count(s.lastActivityAt)
    })
  }
  return {
    v: 1,
    at: v.at as number,
    name: clip(v.name, 64) || 'Stoke',
    platform: clip(v.platform, 24) || 'other',
    open: v.open,
    sessions: v.open ? sessions : [],
    // Only the literal `true`: anything else is a machine not sharing.
    chats: v.chats === true
  }
}

/* ---------------------------------------------------- the host's rules */

/** How long an "Allow once" outlives the relay that got it, so a dropped link reattaches without asking again. */
export const ONCE_GRACE_MS = 2 * 60_000

/**
 * An "Allow once": this device, this session, while a relay holds it (`until`
 * null) and then for `ONCE_GRACE_MS`. In memory only — a restart forgets it.
 */
export interface OnceGrant {
  device: string
  ptyId: string
  until: number | null
}

export type AttachDecision =
  | { t: 'allow'; mode: RelayMode; via: 'always' | 'once' }
  | { t: 'ask' }
  | { t: 'refuse'; reason: string }

/**
 * What the host does with a relay that asks for `ptyId`, in order:
 * not sharing → refused (whatever was granted before: the tick is the master
 * switch); no such live session → refused; an "Always" grant → served in its
 * mode; an "Allow once" still holding for this device AND this session →
 * served; anything else → ask the owner.
 */
export function attachDecision(f: {
  sharing: boolean
  grant: HubGrant | null
  once: readonly OnceGrant[]
  device: string
  ptyId: string
  session: { exists: boolean; exited: boolean }
  hostName: string
  now: number
}): AttachDecision {
  if (!f.sharing) return { t: 'refuse', reason: `${f.hostName} is not sharing its sessions. Tick “Let my other devices see and open my sessions” there.` }
  if (!isId('device', f.device) || !isPtyId(f.ptyId)) return { t: 'refuse', reason: 'That is not a session this computer can open.' }
  if (!f.session.exists || f.session.exited) return { t: 'refuse', reason: `That session is no longer running on ${f.hostName}.` }
  if (f.grant) return { t: 'allow', mode: f.grant.mode, via: 'always' }
  if (onceHolds(f.once, f.device, f.ptyId, f.now)) return { t: 'allow', mode: 'full', via: 'once' }
  return { t: 'ask' }
}

export function onceHolds(once: readonly OnceGrant[], device: string, ptyId: string, now: number): boolean {
  return once.some((g) => g.device === device && g.ptyId === ptyId && (g.until === null || g.until > now))
}

/** An "Allow once" taken by a live relay: held until `releaseOnce`. */
export function holdOnce(once: readonly OnceGrant[], device: string, ptyId: string): OnceGrant[] {
  return [...once.filter((g) => !(g.device === device && g.ptyId === ptyId)), { device, ptyId, until: null }]
}

/** The last relay holding it went: it lasts `ONCE_GRACE_MS` more, for a reattach, then lapses. */
export function releaseOnce(once: readonly OnceGrant[], device: string, ptyId: string, now: number): OnceGrant[] {
  return once.map((g) => (g.device === device && g.ptyId === ptyId ? { ...g, until: now + ONCE_GRACE_MS } : g))
}

/** Every "once" that lapsed. */
export function pruneOnce(once: readonly OnceGrant[], now: number): OnceGrant[] {
  return once.filter((g) => g.until === null || g.until > now)
}

/**
 * What a relay the owner answered may reach: the one session it attached to,
 * under "Allow once" AND under "Always". "Always" only stops the question for
 * that device's next attach (to any running session); it never widened a
 * relay to the rest of the phone API — starting sessions, creating folders,
 * every project path and every past conversation — which the owner, asked
 * about one session, was never told about (found in review, 2026-10-01).
 */
export type RelayScope = { kind: 'session'; ptyId: string } | { kind: 'chats' }

/**
 * Whether a frame stays inside what the owner allowed. `relayFrameVerdict`
 * (relay.ts) is the grant's MODE; this is its REACH. The owner was asked
 * about ONE session, so a guest may open that session's pty socket, answer
 * that session's prompt, and read the host's name and theme to draw it — and
 * nothing else: no other pty, not even the session list (its rows carry every
 * session's folder path, which the presence summary leaves out on purpose),
 * no transcripts or history, no folders, no new sessions.
 *
 * A pty-socket frame (`ws-msg`: keys, a submit, a resize) is judged by the
 * socket it rides, `socketPath`: only one opened on THIS session's pty. The
 * resize a remote tab sends when it is used (shared/sizeClaim.ts) therefore
 * reaches the session the grant reaches and no other pty; a frame on no known
 * socket is outside.
 */
export function relayScopeVerdict(scope: RelayScope, frame: RelayInnerFrame, socketPath?: string): { ok: true } | { ok: false; reason: string } {
  if (scope.kind === 'chats') return chatsScopeVerdict(frame)
  const outside = { ok: false as const, reason: 'This connection reaches only the session it opened.' }
  const ownPty = (path: string): boolean => {
    const r = relayRouteFor('WS', path)
    if (!r || r.path !== '/ws') return false
    const q = path.indexOf('?')
    return new URLSearchParams(q < 0 ? '' : path.slice(q + 1)).get('ptyId') === scope.ptyId
  }
  switch (frame.t) {
    case 'ws-open':
      return ownPty(frame.path) ? { ok: true } : outside
    case 'ws-msg':
      return socketPath !== undefined && ownPty(socketPath) ? { ok: true } : outside
    case 'req': {
      const r = relayRouteFor(frame.method, frame.path)
      if (!r) return outside
      if (frame.method === 'GET' && (r.path === '/api/host' || r.path === '/api/theme')) return { ok: true }
      if (frame.method === 'POST' && r.path === '/api/sessions/:ptyId/answer') {
        const pathname = frame.path.split('?', 1)[0]
        return pathname === `/api/sessions/${scope.ptyId}/answer` ? { ok: true } : outside
      }
      return outside
    }
    default:
      return { ok: true }
  }
}

/**
 * A chats relay's reach (spec 2026-10-03 §3): `GET /api/chats/search` and
 * `GET /api/chats/open`, with the query `relayRouteFor` allows, and nothing
 * else — no socket (so no pty, ever), not the host's name or theme, no
 * session list, no transcript: `/api/transcript` serves a session unredacted.
 * The two routes are the read-only, always-redacted copies of what this
 * machine's own search box and chat viewer show.
 */
function chatsScopeVerdict(frame: RelayInnerFrame): { ok: true } | { ok: false; reason: string } {
  const outside = { ok: false as const, reason: 'This connection reaches only chat history search.' }
  switch (frame.t) {
    case 'ws-open':
    case 'ws-msg':
      return outside
    case 'req': {
      if (frame.method !== 'GET') return outside
      const r = relayRouteFor('GET', frame.path)
      return r && (r.path === '/api/chats/search' || r.path === '/api/chats/open') ? { ok: true } : outside
    }
    default:
      return { ok: true }
  }
}

/** The owner's three answers to "Let <device> open <session>?". */
export type AttachAnswer = 'once' | 'always' | 'deny'

export function isAttachAnswer(v: unknown): v is AttachAnswer {
  return v === 'once' || v === 'always' || v === 'deny'
}

/* ------------------------------------------------------- what is shown */

/** One of the owner's other devices, online now, as the "Other machines" list draws it. */
export interface OtherMachineView {
  id: string
  label: string
  platform: string
  /** Null until its first status arrived (or it could not be opened). */
  status: { at: number; open: boolean; sessions: RemoteSessionSummary[]; chats: boolean } | null
}

/**
 * The list: every OTHER device the verified chain holds as active (by id AND
 * key, gotcha 140 — the caller passes only those), that the hub says is
 * online, with the status it last sealed. A status for a device that is not
 * online, not active, or this device itself is never shown.
 */
export function otherMachines(f: {
  me: string
  active: readonly { id: string; label: string; platform: string }[]
  online: readonly string[]
  statuses: Readonly<Record<string, RemoteStatus>>
}): OtherMachineView[] {
  const online = new Set(f.online)
  return f.active
    .filter((d) => d.id !== f.me && online.has(d.id))
    .map((d) => {
      const s = f.statuses[d.id]
      return {
        id: d.id,
        label: s?.name || d.label,
        platform: d.platform,
        status: s ? { at: s.at, open: s.open, sessions: s.sessions, chats: s.chats } : null
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
}

/**
 * A later status replaces the one on show. Replay protection is NOT this
 * alone — the shown status is cleared on every presence reconnect and
 * offline — but `HubRemote`'s per-(device, epoch) mark, which never is.
 */
export function newerStatus(have: RemoteStatus | undefined, got: RemoteStatus): boolean {
  return !have || got.at > have.at
}

/* --------------------------------------------- the attached session's status */

/**
 * What the HOST's own status bar and usage chip say about the one session a
 * relay attached to — its model and effort, its context, and its account's
 * plan-limit windows — so the guest's status bar can say it too. Sent inside
 * the encrypted channel (`{ t: 'status' }`, relay.ts) on attach and when it
 * changes, and only for the relay's own session (`HubRemote.pushStatus`):
 * nothing about any other session on the host ever rides it.
 */
export interface RemoteSessionStatus {
  /** The model id as the host's bar reads it (payload first, then transcript, then launch flag), or null. */
  model: string | null
  /** The launch effort when one was chosen, or null for the default. */
  effort: string | null
  /** The agent's id (`claude`, `codex`, …), for its label and whether `model` is a Claude id. */
  agent: string
  /** Context used and the window, once the host has a reading. */
  context: { used: number; limit: number } | null
  /** The chip's windows for the session's account (`chipRows`), newest reading; empty for none. */
  usage: UsageWindow[]
  /** When those figures were read on the host, ms, or null. */
  usageAt: number | null
}

/** Windows one status carries at most. The chip draws two. */
export const REMOTE_USAGE_MAX = 4

const USAGE_KINDS: readonly UsageWindow['kind'][] = ['session', 'weekly', 'weekly_scoped', 'other']

function finite(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/** A usage window another machine sent, or null: every field checked and cut, like a status. */
function parseUsageWindow(v: unknown): UsageWindow | null {
  if (!isRecord(v) || !(USAGE_KINDS as readonly unknown[]).includes(v.kind)) return null
  const percent = finite(v.percent)
  if (percent === null) return null
  const elapsed = finite(v.elapsed)
  const resetsAt = finite(v.resetsAt)
  const label = clip(v.label, 40)
  if (!label) return null
  const short = clip(v.short, 12)
  const note = clip(v.resetNote, 60)
  return {
    kind: v.kind as UsageWindow['kind'],
    label,
    ...(short ? { short } : {}),
    ...(note ? { resetNote: note } : {}),
    percent: Math.min(100, Math.max(0, percent)),
    severity: clip(v.severity, 16),
    resetsAt: resetsAt !== null && resetsAt > 0 ? resetsAt : null,
    elapsed: elapsed === null ? null : Math.min(1, Math.max(0, elapsed)),
    active: v.active === true
  }
}

/**
 * The host's side: the status of the relay's own session, rounded so a
 * window's pace marker creeping on does not count as a change every pass.
 */
export function remoteSessionStatusFrom(f: {
  model: string | null
  effort: string | null
  agent: string
  context: { used: number; limit: number } | null
  usage: readonly UsageWindow[]
  usageAt: number | null
}): RemoteSessionStatus {
  return {
    model: f.model ? clip(f.model, 80) || null : null,
    effort: f.effort && f.effort !== 'default' ? clip(f.effort, 16) || null : null,
    agent: clip(f.agent, 24) || 'claude',
    context:
      f.context && f.context.limit > 0
        ? { used: Math.max(0, Math.round(f.context.used)), limit: Math.round(f.context.limit) }
        : null,
    usage: f.usage.slice(0, REMOTE_USAGE_MAX).map((w) => ({
      ...w,
      percent: Math.round(w.percent),
      elapsed: w.elapsed === null ? null : Math.round(w.elapsed * 100) / 100
    })),
    usageAt: f.usageAt !== null && Number.isFinite(f.usageAt) ? Math.floor(f.usageAt) : null
  }
}

/**
 * The guest's side: a status the host sent, as this machine will draw it, or
 * null for anything that is not one. Text another machine chose, so every
 * string is cut and stripped of control characters and every number bounded.
 */
export function parseRemoteSessionStatus(v: unknown): RemoteSessionStatus | null {
  if (!isRecord(v)) return null
  const ctx = isRecord(v.context) ? v.context : null
  const used = ctx ? count(ctx.used) : null
  const limit = ctx ? count(ctx.limit) : null
  const usage: UsageWindow[] = []
  if (Array.isArray(v.usage)) {
    for (const w of v.usage.slice(0, REMOTE_USAGE_MAX)) {
      const parsed = parseUsageWindow(w)
      if (parsed) usage.push(parsed)
    }
  }
  return {
    model: typeof v.model === 'string' ? clip(v.model, 80) || null : null,
    effort: typeof v.effort === 'string' ? clip(v.effort, 16) || null : null,
    agent: clip(v.agent, 24) || 'claude',
    context: used !== null && limit !== null && limit > 0 ? { used, limit } : null,
    usage,
    usageAt: count(v.usageAt)
  }
}

export type RemoteTabState = 'connecting' | 'asking' | 'open' | 'reconnecting' | 'refused' | 'ended' | 'lost'

/** A remote tab on THIS machine (the guest), as the renderer draws its banner. */
export interface RemoteTabView {
  id: string
  device: string
  deviceLabel: string
  platform: string
  ptyId: string
  title: string
  project: string
  state: RemoteTabState
  /** One sentence for the banner, or null. */
  message: string | null
  /** The session's model, context and usage as the host last said (`RemoteSessionStatus`), or null. */
  session: RemoteSessionStatus | null
}

/** Another device attached to a session HERE (this machine is the host), for the indicator. */
export interface RemoteGuestView {
  relay: string
  /** `chats`: it is searching or reading this machine's chat history (`ptyId` and `title` null). */
  kind: 'session' | 'chats'
  device: string
  label: string
  ptyId: string | null
  title: string | null
  since: number
  via: 'once' | 'always' | null
}

/** The owner's question on the host. */
export interface RemoteAskView {
  id: string
  /**
   * `session`: "Let <device> open <title> on this computer?"; `chats`: "Let
   * <device> search and read chat history on this computer?" (`ptyId` is '').
   * The answers are the same three, and each scope keeps its own grants.
   */
  kind: 'session' | 'chats'
  device: string
  label: string
  platform: string
  /** The asking device's signing-key fingerprint (relay.ts `keyFingerprint`). */
  fingerprint: string
  ptyId: string
  title: string
  expiresAt: number
}

export interface RemoteGrantView {
  device: string
  label: string
  mode: RelayMode
  at: number
}

/** A device holding "Always" for this machine's chat history (`hub.chatGrants`), for Settings' list with Remove. */
export interface RemoteChatGrantView {
  device: string
  label: string
  platform: string
  /** Its signing-key fingerprint (relay.ts `keyFingerprint`), or '?' for a device the chain no longer lists. */
  fingerprint: string
}

export type RemoteChatPeerState = 'connecting' | 'waiting' | 'open' | 'denied' | 'not-sharing' | 'error'

/** One other machine's chat history as THIS machine (the guest) is reaching it: a relay per machine while searching. */
export interface RemoteChatPeerView {
  device: string
  label: string
  state: RemoteChatPeerState
  message: string | null
}

/** Everything the renderer shows about "Other machines", pushed whole on every change. */
export interface HubRemoteView {
  /** Signed in and in the vault: the list and the tick mean something. */
  available: boolean
  /** This machine's tick: "Let my other devices see and open my sessions". */
  sharing: boolean
  machines: OtherMachineView[]
  tabs: RemoteTabView[]
  guests: RemoteGuestView[]
  asks: RemoteAskView[]
  grants: RemoteGrantView[]
  /** This machine's tick: "Let my other computers search this computer's chat history" (`hub.shareChats`). */
  sharingChats: boolean
  /** Whether that tick is in force now: it also needs chat history on and this device in the vault. */
  chatsEffective: boolean
  chatGrants: RemoteChatGrantView[]
  /**
   * Guest side: each other machine a search here is reaching. A peer moving
   * from `waiting` to `open` (its owner allowed it) is the renderer's cue to
   * search again.
   */
  chatPeers: RemoteChatPeerView[]
}

export function emptyRemoteView(): HubRemoteView {
  return {
    available: false,
    sharing: false,
    machines: [],
    tabs: [],
    guests: [],
    asks: [],
    grants: [],
    sharingChats: false,
    chatsEffective: false,
    chatGrants: [],
    chatPeers: []
  }
}

/** A frame the guest renderer is handed for one remote tab: the pty socket's own frames, parsed. */
export type RemoteTabFrame = { type: string; [k: string]: unknown }

/* ------------------------------------------------- chat history (spec 2026-10-03) */

/**
 * Whether this machine's chat history is shared NOW: the owner's tick
 * (`hub.shareChats`), chat history itself on, and this device in the vault.
 * `HubRemote` re-reads each on every request, so turning any one off stops
 * the next search, and the status stops saying `chats: true`.
 */
export function chatsSharingEffective(f: { share: boolean; indexOn: boolean; inVault: boolean }): boolean {
  return f.share && f.indexOn && f.inVault
}

/** The key a chats "Allow once" is held under, in a list of its own: never the sessions' list. */
export const CHATS_ONCE_KEY = 'chats'

export type ChatsDecision =
  | { t: 'allow'; via: 'always' | 'once' }
  | { t: 'ask' }
  | { t: 'refuse'; code: RelayRefusalCode; reason: string }

/**
 * What the host does with a relay that attaches `{ kind: 'chats' }`, in
 * order: not sharing, or chat history off → refused (whatever was granted:
 * the tick is the master switch); an "Always" in `hub.chatGrants` → served;
 * a chats "Allow once" still holding for this device → served; anything else
 * → ask the owner. A SESSION grant is never read here, and `once` must be the
 * chats list, never the sessions' (`HubRemote.chatOnce`).
 */
export function chatsAttachDecision(f: {
  sharing: boolean
  indexOn: boolean
  grant: ChatGrant | null
  once: readonly OnceGrant[]
  device: string
  hostName: string
  now: number
}): ChatsDecision {
  if (!isId('device', f.device)) return { t: 'refuse', code: 'not-a-device', reason: 'That is not one of this account’s devices.' }
  if (!f.sharing) return { t: 'refuse', code: 'not-sharing', reason: `${f.hostName} isn’t sharing its chat history.` }
  if (!f.indexOn) return { t: 'refuse', code: 'not-sharing', reason: `${f.hostName} has chat history turned off.` }
  if (f.grant === 'always') return { t: 'allow', via: 'always' }
  if (onceHolds(f.once, f.device, CHATS_ONCE_KEY, f.now)) return { t: 'allow', via: 'once' }
  return { t: 'ask' }
}

/** What a guest's search says per computer: its hits, or why there are none. */
export type RemoteChatsState = 'ok' | 'offline' | 'not-sharing' | 'waiting' | 'denied' | 'error'

/** One hit from another computer's chat history: its folder by NAME only, its text redacted there. */
export interface RemoteChatHit {
  /** The chat's tool (`claude`, `codex`, …) or import (`export-chatgpt`). */
  source: string
  /** The tool's own id for it, which `openRemoteChat` names it by. */
  nativeId: string
  title: string | null
  /** The last segment of the chat's folder, never its path. */
  folder: string | null
  updatedMs: number | null
  role: 'user' | 'assistant' | 'title'
  snippet: string
  /** Where the query matched in `snippet`: UTF-16 offsets, sorted and apart. */
  ranges: [number, number][]
}

export interface RemoteChatsResult {
  device: string
  label: string
  platform: string
  state: RemoteChatsState
  /** One sentence for a state that is not `ok`, or null. */
  message: string | null
  hits: RemoteChatHit[]
}

export interface RemoteChatMessage {
  role: 'user' | 'assistant'
  text: string
  atMs: number | null
}

/** One chat from another computer, as its read-only viewer shows it. No path, no host-local id. */
export interface RemoteChat {
  source: string
  nativeId: string
  title: string | null
  folder: string | null
  createdMs: number | null
  updatedMs: number | null
  messages: RemoteChatMessage[]
  /** Some of it is not shown: the host's viewer cut it, or it did not fit `REMOTE_CHAT_MAX_BYTES`. */
  partial: boolean
  /** The host's own note on where the text came from ("this is the index’s copy"), or null. */
  note: string | null
}

export type RemoteChatOpen =
  | { ok: true; device: string; label: string; chat: RemoteChat }
  | { ok: false; state: RemoteChatsState; message: string }

/** The most one chat sent across may weigh, in UTF-8 bytes of its text (the viewer's own bound, `CHAT_VIEW_MAX_BYTES`). */
export const REMOTE_CHAT_MAX_BYTES = 4 * 1024 * 1024
/** A snippet's length at most, in UTF-16 units: FTS5's snippets are a few dozen words. */
const SNIPPET_MAX = 1000
/** Messages one chat carries at most: each is a node in the viewer. */
const REMOTE_CHAT_MAX_MESSAGES = 20_000

/**
 * A chat's folder as another machine may see it: its LAST path segment, on
 * either separator — never the path, which names the user and every folder
 * above (spec 2026-10-03, the rules). A root (`/`, `C:\`) names none.
 */
export function folderName(cwd: unknown): string | null {
  if (typeof cwd !== 'string') return null
  const parts = cwd.split(/[\\/]+/).filter((p) => p.length > 0)
  const last = parts[parts.length - 1] ?? ''
  if (!last || /^[A-Za-z]:$/.test(last)) return null
  return clip(last, 120) || null
}

function stamp(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null
}

/** Ranges that fit `len`, each `[start, end)` with start < end, sorted and apart; anything else is dropped. */
function cleanRanges(v: unknown, len: number): [number, number][] {
  if (!Array.isArray(v)) return []
  const out: [number, number][] = []
  let at = 0
  for (const r of v.slice(0, 64)) {
    if (!Array.isArray(r) || r.length !== 2) continue
    const [a, b] = r as unknown[]
    if (count(a) === null || count(b) === null) continue
    const start = a as number
    const end = b as number
    if (start < at || end <= start || end > len) continue
    out.push([start, end])
    at = end
  }
  return out
}

/** Chat text: every control character but tab and newline goes (it is drawn as text on another machine). */
function chatText(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
  return t.length > max ? t.slice(0, max) : t
}

/**
 * The host's side: one of its own search hits as it may leave this machine.
 * The folder becomes its name; the chat-index id and the path stay here, and
 * the first prompt only stands in for a missing title. The text must already
 * be redacted (`sharedChats`, main): this only cuts it to shape.
 */
export function remoteChatHitFrom(hit: Pick<ChatSearchHit, 'source' | 'nativeId' | 'title' | 'firstPrompt' | 'cwd' | 'updatedMs' | 'role' | 'snippet'>): RemoteChatHit {
  const snippet = chatText(hit.snippet.text, SNIPPET_MAX)
  const title = clip(hit.title ?? hit.firstPrompt ?? '', 200)
  return {
    source: String(hit.source),
    nativeId: hit.nativeId,
    title: title || null,
    folder: folderName(hit.cwd),
    updatedMs: stamp(hit.updatedMs),
    role: hit.role,
    snippet,
    ranges: cleanRanges(hit.snippet.ranges, snippet.length)
  }
}

/**
 * The guest's side: a search answer another machine sent, as this machine
 * will draw it, or null for anything that is not one. At most
 * `CHAT_HITS_MAX` hits; a hit that does not parse is dropped, not trusted.
 */
export function parseRemoteChatHits(body: unknown): RemoteChatHit[] | null {
  if (!isRecord(body) || !Array.isArray(body.hits)) return null
  const out: RemoteChatHit[] = []
  for (const h of body.hits.slice(0, CHAT_HITS_MAX)) {
    if (!isRecord(h) || !isChatSource(h.source) || !isChatNativeId(h.nativeId)) continue
    if (h.role !== 'user' && h.role !== 'assistant' && h.role !== 'title') continue
    const snippet = chatText(h.snippet, SNIPPET_MAX)
    const title = typeof h.title === 'string' ? clip(h.title, 200) : ''
    out.push({
      source: h.source,
      nativeId: h.nativeId,
      title: title || null,
      folder: folderName(h.folder),
      updatedMs: stamp(h.updatedMs),
      role: h.role,
      snippet,
      ranges: cleanRanges(h.ranges, snippet.length)
    })
  }
  return out
}

/** UTF-8 bytes of `s`, without an encoder (both projects compile this). */
function utf8Bytes(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** The opening and the newest messages that fit `cap`, the middle left out (`planTrim`'s shape). */
function fitMessages(ms: readonly RemoteChatMessage[], cap: number): { messages: RemoteChatMessage[]; cut: boolean } {
  const sizes = ms.map((m) => utf8Bytes(m.text) + 64)
  if (sizes.reduce((a, b) => a + b, 0) <= cap) return { messages: [...ms], cut: false }
  const head: RemoteChatMessage[] = []
  const tail: RemoteChatMessage[] = []
  let lo = 0
  let hi = ms.length - 1
  let used = 0
  let front = true
  while (lo <= hi) {
    const i = front ? lo : hi
    if (used + sizes[i] > cap) break
    used += sizes[i]
    if (front) head.push(ms[lo++])
    else tail.unshift(ms[hi--])
    front = !front
  }
  if (head.length === 0 && tail.length === 0 && ms.length > 0) {
    // One message past the cap on its own: its opening, cut by characters well inside the bound.
    return { messages: [{ ...ms[0], text: ms[0].text.slice(0, Math.floor(cap / 4)) }], cut: true }
  }
  return { messages: [...head, ...tail], cut: true }
}

/**
 * The host's side: a chat its viewer read (`openChat`, already redacted by
 * `sharedChats`) as it may leave this machine: the folder by name, no
 * chat-index id, no path, at most `REMOTE_CHAT_MAX_BYTES` of text.
 */
export function remoteChatFrom(
  t: Pick<ChatTranscript, 'source' | 'title' | 'cwd' | 'createdMs' | 'updatedMs' | 'messages' | 'partial' | 'fallback'>,
  nativeId: string
): RemoteChat {
  const messages = t.messages
    .slice(0, REMOTE_CHAT_MAX_MESSAGES)
    .map((m) => ({ role: m.role, text: chatText(m.text, REMOTE_CHAT_MAX_BYTES), atMs: stamp(m.atMs) }))
  const fit = fitMessages(messages, REMOTE_CHAT_MAX_BYTES)
  const title = clip(t.title ?? '', 200)
  return {
    source: String(t.source),
    nativeId,
    title: title || null,
    folder: folderName(t.cwd),
    createdMs: stamp(t.createdMs),
    updatedMs: stamp(t.updatedMs),
    messages: fit.messages,
    partial: t.partial || fit.cut || t.messages.length > REMOTE_CHAT_MAX_MESSAGES,
    note: t.fallback ? clip(t.fallback, 300) || null : null
  }
}

/** The guest's side: a chat another machine sent, checked and cut like everything else it sends; null if it is not one. */
export function parseRemoteChat(body: unknown): RemoteChat | null {
  if (!isRecord(body) || !isChatSource(body.source) || !isChatNativeId(body.nativeId) || !Array.isArray(body.messages)) return null
  const messages: RemoteChatMessage[] = []
  for (const m of body.messages.slice(0, REMOTE_CHAT_MAX_MESSAGES)) {
    if (!isRecord(m) || (m.role !== 'user' && m.role !== 'assistant') || typeof m.text !== 'string') continue
    messages.push({ role: m.role, text: chatText(m.text, REMOTE_CHAT_MAX_BYTES), atMs: stamp(m.atMs) })
  }
  const fit = fitMessages(messages, REMOTE_CHAT_MAX_BYTES)
  const title = typeof body.title === 'string' ? clip(body.title, 200) : ''
  const note = typeof body.note === 'string' ? clip(body.note, 300) : ''
  return {
    source: body.source,
    nativeId: body.nativeId,
    title: title || null,
    folder: folderName(body.folder),
    createdMs: stamp(body.createdMs),
    updatedMs: stamp(body.updatedMs),
    messages: fit.messages,
    partial: body.partial === true || fit.cut || body.messages.length > REMOTE_CHAT_MAX_MESSAGES,
    note: note || null
  }
}
