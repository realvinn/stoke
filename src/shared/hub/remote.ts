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
 *   serve it, ask the owner, or refuse (`attachDecision`), what an "Allow once"
 *   covers (`relayScopeVerdict`), and how long it lasts across a dropped link
 *   (`OnceGrant`, `ONCE_GRACE_MS`). An "Always" is a `HubGrant` in the host's
 *   own `hub.grants` (T0: never synced, so neither the hub nor any synced item
 *   can grant anything); revoking it is deleting it.
 *
 * Pure (gotcha 27); imports only src/shared by relative `.ts` path (gotcha 78).
 */
import { isId, isRecord } from './codec.ts'
import { isPtyId, relayRouteFor, type HubGrant, type RelayInnerFrame, type RelayMode } from './relay.ts'

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
export function remoteStatusFrom(f: { at: number; name: string; platform: string; open: boolean; rows: readonly RemoteRowLike[] }): RemoteStatus {
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
  return { v: 1, at: Math.floor(f.at), name: clip(f.name, 64) || 'Stoke', platform: clip(f.platform, 24) || 'other', open: f.open, sessions }
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
    sessions: v.open ? sessions : []
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

/** What a relay the owner answered may reach: every relayed route ("Always"), or one session ("Allow once"). */
export type RelayScope = { kind: 'any' } | { kind: 'session'; ptyId: string }

/**
 * Whether a frame stays inside what the owner allowed. `relayFrameVerdict`
 * (relay.ts) is the grant's MODE; this is its REACH. An "Allow once" was
 * asked about ONE session, so under it a guest may open that session's pty
 * socket, answer that session's prompt, and read the host's name and theme to
 * draw it — and nothing else: no other pty, not even the session list (its
 * rows carry every session's folder path, which the presence summary leaves
 * out on purpose), no transcripts or history, no folders, no new sessions.
 */
export function relayScopeVerdict(scope: RelayScope, frame: RelayInnerFrame): { ok: true } | { ok: false; reason: string } {
  if (scope.kind === 'any') return { ok: true }
  const outside = { ok: false as const, reason: 'You were allowed this one session only.' }
  switch (frame.t) {
    case 'ws-open': {
      const r = relayRouteFor('WS', frame.path)
      if (!r || r.path !== '/ws') return outside
      const q = frame.path.indexOf('?')
      const ptyId = new URLSearchParams(q < 0 ? '' : frame.path.slice(q + 1)).get('ptyId')
      return ptyId === scope.ptyId ? { ok: true } : outside
    }
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
  status: { at: number; open: boolean; sessions: RemoteSessionSummary[] } | null
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
        status: s ? { at: s.at, open: s.open, sessions: s.sessions } : null
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
}

/** A later status replaces an earlier one; an older one (a hub replaying) is ignored. */
export function newerStatus(have: RemoteStatus | undefined, got: RemoteStatus): boolean {
  return !have || got.at > have.at
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
}

/** Another device attached to a session HERE (this machine is the host), for the indicator. */
export interface RemoteGuestView {
  relay: string
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
}

export function emptyRemoteView(): HubRemoteView {
  return { available: false, sharing: false, machines: [], tabs: [], guests: [], asks: [], grants: [] }
}

/** A frame the guest renderer is handed for one remote tab: the pty socket's own frames, parsed. */
export type RemoteTabFrame = { type: string; [k: string]: unknown }
