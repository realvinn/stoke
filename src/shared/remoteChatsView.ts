/*
 * What the renderer says about chat history across the owner's computers
 * (spec 2026-10-03 §4): the Settings › Account & sync row ("Let my other
 * computers search this computer's chat history"), the sidebar's "On
 * <computer>" groups, the viewer's header, and when a search should be asked
 * again. Pure, so verify:hub-relay holds the copy and the rules; the
 * components only draw what these return.
 *
 * Imports only src/shared by relative `.ts` path (gotcha 78).
 */
import type { HubPhase } from './hub/client.ts'
import { CHATS_PAUSED_SENTENCE, CHATS_REDACTION_BLOCK, type RemoteChatHit, type RemoteChatPeerView, type RemoteChatsResult, type RemoteChatsState } from './hub/remote.ts'

export const SHARE_CHATS_LABEL = 'Let my other computers search this computer’s chat history'
/** Said once the tick goes off: off is instant, and every chats relay closed with it. */
export const SHARE_CHATS_STOPPED = 'Stopped. Searches from other computers were closed.'
const SECRETS_LINE = 'Secrets are redacted; folders show by name.'

/** "Studio", "Studio and Laptop", "Studio, Laptop and NUC". */
export function namesList(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * Why the tick cannot go ON now, or null. Off is never refused. Only a device
 * in the vault shares (`chatsSharingEffective`); a device signed in but not in
 * the vault yet is told what it still has to do rather than to sign in. With
 * "Leave out anything that looks like an API key" off (`redactOn` false: the
 * view's `chatsBlocked === 'redaction-off'`) nothing could be found from
 * elsewhere, so the tick waits for it too — main refuses with the same words.
 */
export function shareChatsBlock(phase: HubPhase, chatIndexOn: boolean, redactOn = true): string | null {
  if (phase === 'new-account' || phase === 'locked') return 'Join this computer to your vault first.'
  if (phase !== 'active') return 'Sign in to Stoke Hub first.'
  if (!chatIndexOn) return 'Turn on Chat history first.'
  if (!redactOn) return CHATS_REDACTION_BLOCK
  return null
}

export interface ShareChatsRowView {
  checked: boolean
  /** The tick may be pressed: always to turn it off, to turn it on only when nothing blocks it. */
  enabled: boolean
  /** Why it cannot go on, or null. */
  blocked: string | null
  /** The sentence under the row. */
  hint: string
}

/**
 * The row's state and its words. `sharing` is `hub.shareChats` as main holds
 * it; `grants` are the devices holding "Always" for this computer's chat
 * history (`hub.chatGrants`), by the name the chain gives them. `redactOn`
 * is false while the view says `chatsBlocked === 'redaction-off'`: on, the
 * row then says sharing is paused (`CHATS_PAUSED_SENTENCE`); off, why it
 * cannot go on.
 */
export function shareChatsRow(f: { phase: HubPhase; chatIndexOn: boolean; redactOn?: boolean; sharing: boolean; grants: readonly string[] }): ShareChatsRowView {
  const blocked = shareChatsBlock(f.phase, f.chatIndexOn, f.redactOn ?? true)
  if (!f.sharing) {
    return { checked: false, enabled: blocked === null, blocked, hint: blocked ?? 'Off. Other computers can’t see chats on this one.' }
  }
  if (blocked === CHATS_REDACTION_BLOCK) return { checked: true, enabled: true, blocked, hint: CHATS_PAUSED_SENTENCE }
  if (blocked) return { checked: true, enabled: true, blocked, hint: `On, but nothing is shared while it can’t be: ${blocked}` }
  const who = f.grants.length
    ? `On. ${namesList(f.grants)} can search and read, but not change, chats on this computer.`
    : 'On. Your other computers ask here first, then can search and read, but not change, chats on this computer.'
  return { checked: true, enabled: true, blocked: null, hint: `${who} ${SECRETS_LINE}` }
}

/** One "On <computer>" group in the sidebar's "In conversations": its hits, or one line saying why there are none. */
export interface RemoteChatGroup {
  device: string
  computer: string
  state: RemoteChatsState
  /** Instead of hits: offline, not sharing, waiting, refused, failed, or nothing found. Null when there are hits. */
  line: string | null
  /** The line is a failure, read as `role="status"`. */
  failed: boolean
  hits: RemoteChatHit[]
}

/**
 * The guest's search results, one group per computer in main's order, never
 * merged with this computer's hits or each other's by score: a score from
 * another index ranks nothing here.
 */
export function remoteChatGroups(results: readonly RemoteChatsResult[], query: string): RemoteChatGroup[] {
  const q = query.trim()
  return results.map((r) => {
    const computer = r.label
    const base = { device: r.device, computer, state: r.state, failed: false, hits: [] as RemoteChatHit[] }
    switch (r.state) {
      case 'ok':
        return r.hits.length ? { ...base, line: null, hits: r.hits } : { ...base, line: `Nothing on ${computer} says “${q}”.` }
      case 'offline':
        return { ...base, line: `${computer} is offline — not searched` }
      case 'not-sharing':
        return { ...base, line: `${computer} isn’t sharing chat history` }
      case 'waiting':
        return { ...base, line: `Waiting for ${computer} to allow…` }
      case 'denied':
        return { ...base, line: r.message || `${computer} said no.`, failed: true }
      default:
        return { ...base, line: r.message || `${computer} couldn’t be searched.`, failed: true }
    }
  })
}

/** The viewer's header for a chat read from another computer: "On Studio · stoke", or "On Studio" with no folder. */
export function remoteChatWhere(computer: string, folder: string | null): string {
  return folder ? `On ${computer} · ${folder}` : `On ${computer}`
}

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
