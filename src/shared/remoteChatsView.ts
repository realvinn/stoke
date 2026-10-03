/*
 * What the renderer says about chat history across the owner's computers
 * (spec 2026-10-03 §4): the Settings › Account & sync row ("Let my other
 * computers search this computer's chat history"), the sidebar's "On
 * <computer>" groups, the viewer's header and its errors, and when a search
 * or a read should be asked again. Pure, so verify:hub-relay holds the copy
 * and the rules; the components only draw what these return.
 *
 * Imports only src/shared by relative `.ts` path (gotcha 78).
 */
import type { HubPhase } from './hub/client.ts'
import type {
  OtherMachineView,
  RemoteChatHit,
  RemoteChatPeerState,
  RemoteChatPeerView,
  RemoteChatsResult,
  RemoteChatsState
} from './hub/remote.ts'

export const SHARE_CHATS_LABEL = 'Let my other computers search this computer’s chat history'
/** Said once the tick goes off: off is instant, and every chats relay closed with it. */
export const SHARE_CHATS_STOPPED = 'Stopped. Searches from other computers were closed.'
const SECRETS_LINE = 'Secrets are redacted; folders show by name.'
/** Chat history's redaction tick, by the words its own row shows (ChatHistorySettings). */
export const REDACTION_SETTING = 'Leave out anything that looks like an API key'
/** The row while sharing is ticked but paused because that tick is off (`ShareChatsPaused`). */
export const SHARE_CHATS_PAUSED_REDACTION = `Paused: turn on ‘${REDACTION_SETTING}’ in Chat history to share it.`

/** "Studio", "Studio and Laptop", "Studio, Laptop and NUC". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Why the tick cannot go ON now, or null. Off is never refused. Only a device
 * in the vault shares (`chatsSharingEffective`); a device signed in but not in
 * the vault yet is told what it still has to do rather than to sign in. Chat
 * history's own redaction must be on too: a computer that keeps keys as typed
 * does not offer them to another (main pauses sharing while it is off).
 */
export function shareChatsBlock(phase: HubPhase, chatIndexOn: boolean, redactOn: boolean): string | null {
  if (phase === 'new-account' || phase === 'locked') return 'Join this computer to your vault first.'
  if (phase !== 'active') return 'Sign in to Stoke Hub first.'
  if (!chatIndexOn) return 'Turn on Chat history first.'
  if (!redactOn) return `Turn on ‘${REDACTION_SETTING}’ first.`
  return null
}

/**
 * Why sharing is ticked but not in force, as MAIN says it: `redaction-off`
 * while chat history's "Leave out anything that looks like an API key" is off.
 *
 * TODO(integrate): main's share state gains `paused?: 'redaction-off'` in a
 * parallel change. This reads it by that name off the view main pushes
 * (`HubRemoteView`); if theirs is named differently or lives elsewhere, point
 * `sharePausedOf` at it — it is the only reader. Until it lands nothing says
 * `paused`, and the row says what it says today.
 */
export type ShareChatsPaused = 'redaction-off'

export function sharePausedOf(view: object): ShareChatsPaused | null {
  const p = (view as { paused?: unknown }).paused
  return p === 'redaction-off' ? p : null
}

export interface ShareChatsRowView {
  checked: boolean
  /** The tick may be pressed: always to turn it off, to turn it on only when nothing blocks it. */
  enabled: boolean
  /** Why it cannot go on, or null. */
  blocked: string | null
  /** The sentence under the row. */
  hint: string
  /** Ticked, but main has paused it (`ShareChatsPaused`): the hint is a warning. */
  paused: boolean
}

/**
 * The row's state and its words. `sharing` is `hub.shareChats` as main holds
 * it; `grants` are the devices holding "Always" for this computer's chat
 * history (`hub.chatGrants`), by the name the chain gives them; `redactOn` is
 * chat history's redaction tick here; `paused` is main's word on whether the
 * tick is in force (`sharePausedOf`).
 *
 * While ticked, only MAIN's `paused` says the redaction tick stopped it, never
 * the setting alone: whether an off redaction pauses sharing is main's rule,
 * and the row must not claim nothing is shared while main still shares.
 */
export function shareChatsRow(f: {
  phase: HubPhase
  chatIndexOn: boolean
  redactOn: boolean
  sharing: boolean
  grants: readonly string[]
  paused: ShareChatsPaused | null
}): ShareChatsRowView {
  if (!f.sharing) {
    const blocked = shareChatsBlock(f.phase, f.chatIndexOn, f.redactOn)
    return { checked: false, enabled: blocked === null, blocked, hint: blocked ?? 'Off. Other computers can’t see chats on this one.', paused: false }
  }
  const blocked = shareChatsBlock(f.phase, f.chatIndexOn, true)
  if (blocked) return { checked: true, enabled: true, blocked, hint: `On, but nothing is shared while it can’t be: ${blocked}`, paused: false }
  if (f.paused === 'redaction-off') return { checked: true, enabled: true, blocked: null, hint: SHARE_CHATS_PAUSED_REDACTION, paused: true }
  const who = f.grants.length
    ? `On. ${namesList(f.grants)} can search and read, but not change, chats on this computer.`
    : 'On. Your other computers ask here first, then can search and read, but not change, chats on this computer.'
  return { checked: true, enabled: true, blocked: null, hint: `${who} ${SECRETS_LINE}`, paused: false }
}

/* -------------------------------------------------------- the host's refusals */

/**
 * Why another computer refused a chats relay, as THIS computer says it. The
 * host's own sentence is written from its side ("This computer's owner took
 * back this device's access…"), so a guest rewords it by code.
 *
 * TODO(integrate): a parallel change makes the host send a code with every
 * chats refusal, carried on the result (src/shared/hub/remote.ts). Until it
 * lands this is a local list, `chatRefusalCodeOf` finds no code on anything
 * main sends, and the host's sentence shows as it does today. When merging,
 * point `ChatRefusalCode` and `chatRefusalCodeOf` at theirs and give every
 * code of theirs a line in `chatRefusalLine`.
 */
export type ChatRefusalCode = 'not-sharing' | 'chat-history-off' | 'redaction-off' | 'denied' | 'revoked' | 'not-a-device' | 'busy'
const CHAT_REFUSAL_CODES: readonly string[] = ['not-sharing', 'chat-history-off', 'redaction-off', 'denied', 'revoked', 'not-a-device', 'busy']

/** The refusal code a result, a peer or a failed open carries, or null (none sent, or one this build does not know). */
export function chatRefusalCodeOf(r: object): ChatRefusalCode | null {
  const c = (r as { code?: unknown }).code
  return typeof c === 'string' && CHAT_REFUSAL_CODES.includes(c) ? (c as ChatRefusalCode) : null
}

/** One code's sentence, from the guest's side. */
export function chatRefusalLine(computer: string, code: ChatRefusalCode): string {
  switch (code) {
    case 'not-sharing':
      return `${computer} isn’t sharing chat history any more.`
    case 'chat-history-off':
      return `${computer} has chat history turned off.`
    case 'redaction-off':
      return `${computer} paused sharing: ‘${REDACTION_SETTING}’ is off there.`
    case 'denied':
      return `${computer} said no.`
    case 'revoked':
      return `${computer} took back this computer’s access to its chat history.`
    case 'not-a-device':
      return `${computer} doesn’t know this computer as one of your devices.`
    case 'busy':
      return `${computer} is busy. Try again in a moment.`
  }
}

/** A refusal's line: the guest's own sentence for a known code, else the one main sent, else `fallback`. */
function refusalOr(computer: string, r: object & { message: string | null }, fallback: string): string {
  const code = chatRefusalCodeOf(r)
  return code ? chatRefusalLine(computer, code) : r.message || fallback
}

/* ------------------------------------------------------ the sidebar's groups */

/**
 * Which of the owner's other computers share chat history, as this window has
 * seen them: `live` online and saying `chats: true` now; `seen` saying so the
 * last time each was seen — an offline one included, dropped only once it is
 * seen online saying it does not share. Nothing is stored: a computer that
 * went offline before this window saw it share is simply not listed.
 */
export interface ChatSharers {
  live: ReadonlySet<string>
  seen: ReadonlySet<string>
}

export const NO_CHAT_SHARERS: ChatSharers = { live: new Set(), seen: new Set() }

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false
  for (const x of a) if (!b.has(x)) return false
  return true
}

/**
 * The next `ChatSharers` from main's view of the other machines, and whether
 * the search on screen should be asked again because one started or stopped
 * sharing, or went offline or came back while sharing (`changed`). Returns
 * `prev` itself when nothing moved, so a caller can keep it in state.
 */
export function chatSharersStep(
  prev: ChatSharers,
  view: { available: boolean; machines: readonly Pick<OtherMachineView, 'id' | 'status'>[] }
): { next: ChatSharers; changed: boolean } {
  if (!view.available) {
    if (prev.live.size === 0 && prev.seen.size === 0) return { next: prev, changed: false }
    return { next: NO_CHAT_SHARERS, changed: prev.live.size > 0 }
  }
  const live = new Set<string>()
  const seen = new Set(prev.seen)
  for (const m of view.machines) {
    if (m.status?.chats === true) {
      live.add(m.id)
      seen.add(m.id)
    } else if (m.status) {
      // Online and saying it does not share. One with no status yet has said nothing, and keeps what it last said.
      seen.delete(m.id)
    }
  }
  const changed = !sameSet(live, prev.live)
  if (!changed && sameSet(seen, prev.seen)) return { next: prev, changed: false }
  return { next: { live, seen }, changed }
}

/** One answer from main's `searchChats`, with the query it was asked for. */
export interface RemoteChatsAnswer {
  query: string
  results: readonly RemoteChatsResult[]
}

export const NO_REMOTE_CHATS: RemoteChatsAnswer = { query: '', results: [] }

/** One "On <computer>" group in the sidebar's "In conversations": its hits, or one line saying why there are none. */
export interface RemoteChatGroup {
  device: string
  computer: string
  state: RemoteChatsState
  /** Instead of hits: offline, waiting, refused, failed, or nothing found. Null when there are hits. */
  line: string | null
  /** The line is a failure, read as `role="status"`. */
  failed: boolean
  hits: RemoteChatHit[]
  /** It answered an earlier query than the box holds now: drawn dimmed, as pending, until the new answer lands. */
  stale: boolean
}

/**
 * The guest's search results, one group per computer in main's order, never
 * merged with this computer's hits or each other's by score: a score from
 * another index ranks nothing here.
 *
 * Only a computer that shares gets a group. Main answers for every other
 * device in the vault; one that does not share is left out rather than given
 * an "isn't sharing" line on every search. `sharers` is `ChatSharers.seen`:
 * the computers this window last saw saying `chats: true`, an offline one
 * included — so "offline — not searched" is said only of a computer that was
 * sharing when last seen, and one seen to stop sharing loses its group at
 * once, before the search its status cued has answered. (Main pushes a status
 * before it can answer a search that read it, so a computer that answered is
 * already in `sharers`.)
 *
 * `answer.query` is what the results answered; `query` is the box now. A
 * group from an older query is `stale`, and its words quote the query it
 * answered, never the one typed since.
 */
export function remoteChatGroups(answer: RemoteChatsAnswer, query: string, sharers: ReadonlySet<string>): RemoteChatGroup[] {
  const asked = answer.query.trim()
  const stale = asked !== query.trim()
  const out: RemoteChatGroup[] = []
  for (const r of answer.results) {
    if (r.state === 'not-sharing' || !sharers.has(r.device)) continue
    const computer = r.label
    const base = { device: r.device, computer, state: r.state, failed: false, hits: [] as RemoteChatHit[], stale }
    switch (r.state) {
      case 'ok':
        out.push(r.hits.length ? { ...base, line: null, hits: r.hits } : { ...base, line: `Nothing on ${computer} says “${asked}”.` })
        break
      case 'offline':
        out.push({ ...base, line: `${computer} is offline — not searched` })
        break
      case 'waiting':
        out.push({ ...base, line: `Waiting for ${computer} to allow…` })
        break
      case 'denied':
        out.push({ ...base, line: refusalOr(computer, r, `${computer} said no.`), failed: true })
        break
      default:
        out.push({ ...base, line: refusalOr(computer, r, `${computer} couldn’t be searched.`), failed: true })
    }
  }
  return out
}

/* ------------------------------------------------------------- the viewer */

/** The viewer's header for a chat read from another computer: "On Studio · stoke", or "On Studio" with no folder. */
export function remoteChatWhere(computer: string, folder: string | null): string {
  return folder ? `On ${computer} · ${folder}` : `On ${computer}`
}

/**
 * Why a chat from another computer could not be read, in the viewer's words.
 * Offline has its own sentence — "not searched" is the sidebar's, and this was
 * an open; a refusal is reworded by its code (`chatRefusalLine`); anything
 * else is main's own sentence, already from this computer's side.
 */
export function remoteOpenLine(computer: string, r: { state: RemoteChatsState; message: string | null }): string {
  if (r.state === 'offline') return `${computer} is offline — open it again when it’s back.`
  if (r.state === 'waiting') return r.message || `Waiting for ${computer} to allow it…`
  return refusalOr(computer, r, `${computer} could not open this chat.`)
}

/**
 * The viewer's watch on the relay a read from another computer goes through.
 * Call it with `awaited: false` when a read starts, then on every peer state
 * seen after and when the read ends, carrying `awaited` forward. It reads
 * again by itself (`reload`) once the read has FAILED and the computer's
 * chats relay is open, having been not open at some moment since the read
 * began — its owner allowed it, or it came up — whichever of the two landed
 * first. A read that failed while the relay stayed open (it did not answer in
 * time) waits for "Try again", or it would read again for ever.
 */
export function remoteReadWatch(awaited: boolean, f: { failed: boolean; peer: RemoteChatPeerState | null }): { awaited: boolean; reload: boolean } {
  const now = awaited || f.peer !== 'open'
  return { awaited: now, reload: f.failed && now && f.peer === 'open' }
}

/* ------------------------------------------------- asking a search again */

/**
 * Whether the search on screen should be asked again: a computer the last
 * answer had no hits from because it was waiting (its owner was asked) or had
 * failed has since moved to `open` or `denied` — the answer is ready now.
 * `seen` is the set of `device:state` pairs from the last call; a peer that
 * merely closed (the idle close) asks nothing, or a typed query left in the
 * box would keep every relay open for ever.
 */
export function chatsSearchAgain(
  seen: ReadonlySet<string>,
  peers: readonly RemoteChatPeerView[],
  results: readonly RemoteChatsResult[]
): { seen: Set<string>; again: boolean } {
  const now = new Set(peers.filter((p) => p.state === 'open' || p.state === 'denied').map((p) => `${p.device}:${p.state}`))
  const stale = new Set(results.filter((r) => r.state !== 'ok').map((r) => r.device))
  let again = false
  for (const key of now) {
    if (seen.has(key)) continue
    const device = key.slice(0, key.lastIndexOf(':'))
    if (stale.has(device)) again = true
  }
  return { seen: now, again }
}
