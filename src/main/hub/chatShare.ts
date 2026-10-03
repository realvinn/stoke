/*
 * This computer's chat history as the owner's OTHER computers may read it
 * (spec 2026-10-03 §3): the two routes the relay instance of the phone server
 * answers (`answerChatsRoute`, called from `RemoteServer.api` only where
 * `chatsRouteFor` says `relay`), and what they read (`sharedChats`).
 *
 * The rules this file keeps, whatever the chat index's own settings say:
 * - everything that leaves is redacted: the index's own secret patterns
 *   (`redact`, chatIndex/parse.ts `redactSecrets`) run again over every title,
 *   snippet and message, and a snippet whose text that changes gets its
 *   highlight ranges recomputed on the redacted text;
 * - a folder leaves by its last segment only (`folderName`), never a path;
 * - a chat in a folder the owner hid (`hiddenProjects`) is neither found nor
 *   opened: the same 404 as a chat that does not exist, so the route is no
 *   existence probe;
 * - nothing answers while chat history is off.
 *
 * The HOST's grant and scope are judged before any of this runs
 * (`HubRemote`); this is what a judged request reads.
 *
 * No electron import, so `verify:hub-relay` runs it against a real
 * `redactSecrets`. Imports only src/shared by relative `.ts` path (gotcha 78).
 */
import { CHAT_SEARCH_MIN_CHARS, highlightRanges, type ChatSearchHit, type ChatTranscript } from '../../shared/chatIndex.ts'
import { CHAT_HITS_MAX, CHAT_QUERY_MAX, isChatNativeId, isChatSource } from '../../shared/hub/relay.ts'
import { remoteChatFrom, remoteChatHitFrom, type RemoteChat, type RemoteChatHit } from '../../shared/hub/remote.ts'

export type ChatsRefusal = { ok: false; status: number; error: string }

/** What the two routes read: already cut to what may leave this machine. */
export interface SharedChats {
  search(q: string, limit: number): Promise<{ ok: true; hits: RemoteChatHit[] } | ChatsRefusal>
  open(source: string, nativeId: string): Promise<{ ok: true; chat: RemoteChat } | ChatsRefusal>
}

/**
 * The chat index as `sharedChats` reaches it. Every function is read per call
 * (gotcha 111): the relay instance of the phone server outlives any setting.
 */
export interface ChatIndexAccess {
  /** `settings.chatIndex === 'on'`. */
  indexOn(): boolean
  /**
   * The index's own "Leave out anything that looks like an API key"
   * (`chatIndexOptions.redact`). While it is off the store holds text as it
   * was typed, and a search over it answers yes or no for any prefix of a
   * secret even when every snippet is redacted on the way out — so nothing is
   * searched from another computer until the store serves cleaned text.
   * TODO(integrate): drop this guard once `search`/`open` below ask the
   * store for cleaned rows whatever this setting says (spec §1's forced
   * redaction, built in parallel in src/main/chatIndex/).
   */
  storedRedacted(): boolean
  /** A chat whose folder the owner hid (`hiddenProjects`, `isInside`): it never leaves. */
  hidden(cwd: string): boolean
  /** The index's search, best hit per chat (`ChatIndexHost.search`). */
  search(q: string, limit: number): Promise<ChatSearchHit[]>
  /** A chat's index id by its tool and the tool's own id (`ChatIndexHost.find`), or null. */
  find(source: string, nativeId: string): Promise<number | null>
  /** One chat as the viewer reads it, redaction forced on (`ChatIndexHost.open`). */
  open(chatId: number): Promise<ChatTranscript | null>
  /** The index's own secret patterns (chatIndex/parse.ts `redactSecrets`). */
  redact(text: string): string
}

const OFF: ChatsRefusal = { ok: false, status: 503, error: 'Chat history is off on that computer.' }
const UNREDACTED: ChatsRefusal = {
  ok: false,
  status: 503,
  error: 'That computer keeps its chat history with keys left in, so it isn’t searched from other computers. Tick “Leave out anything that looks like an API key” in its Settings › Chat history.'
}
const MISSING: ChatsRefusal = { ok: false, status: 404, error: 'That chat isn’t on that computer any more.' }

/** The guarded, redacted reader the relay instance serves (`RemoteServer.serveChats`). */
export function sharedChats(a: ChatIndexAccess): SharedChats {
  return {
    async search(q, limit) {
      if (!a.indexOn()) return OFF
      if (!a.storedRedacted()) return UNREDACTED
      const query = q.slice(0, CHAT_QUERY_MAX)
      if (query.trim().length < CHAT_SEARCH_MIN_CHARS) return { ok: true, hits: [] }
      const found = await a.search(query, Math.max(1, Math.min(CHAT_HITS_MAX, Math.floor(limit))))
      // Read again after the await: a switch-off while the worker searched answers nothing.
      if (!a.indexOn()) return OFF
      const hits = found
        .filter((h) => !h.cwd || !a.hidden(h.cwd))
        .slice(0, CHAT_HITS_MAX)
        .map((h) => {
          const text = a.redact(h.snippet.text)
          // The ranges point into the text as stored: once redaction moves it, mark the redacted text afresh.
          const ranges = text === h.snippet.text ? h.snippet.ranges : highlightRanges(text, query)
          return remoteChatHitFrom({
            ...h,
            title: h.title === null ? null : a.redact(h.title),
            firstPrompt: h.firstPrompt === null ? null : a.redact(h.firstPrompt),
            snippet: { text, ranges }
          })
        })
      return { ok: true, hits }
    },
    async open(source, nativeId) {
      if (!a.indexOn()) return OFF
      if (!a.storedRedacted()) return UNREDACTED
      if (!isChatSource(source) || !isChatNativeId(nativeId)) return MISSING
      const id = await a.find(source, nativeId)
      if (id === null) return MISSING
      const t = await a.open(id)
      if (!a.indexOn()) return OFF
      if (!t || (t.cwd && a.hidden(t.cwd))) return MISSING
      const redacted: ChatTranscript = {
        ...t,
        title: t.title === null ? null : a.redact(t.title),
        messages: t.messages.map((m) => ({ ...m, text: a.redact(m.text) }))
      }
      return { ok: true, chat: remoteChatFrom(redacted, nativeId) }
    }
  }
}

/**
 * One `/api/chats/*` request on the relay instance, as `{status, body}`.
 * The query was already held to `relayRouteFor`'s shape by the host's
 * verdicts; it is read again here, because this is the handler.
 */
export async function answerChatsRoute(chats: SharedChats, route: 'search' | 'open', params: URLSearchParams): Promise<{ status: number; body: unknown }> {
  if (route === 'search') {
    const q = params.get('q') ?? ''
    if (q.length === 0 || q.length > CHAT_QUERY_MAX) return { status: 400, body: { error: `A search is 1 to ${CHAT_QUERY_MAX} characters.` } }
    const raw = params.get('limit')
    const limit = raw === null ? CHAT_HITS_MAX : Number(raw)
    if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_HITS_MAX) return { status: 400, body: { error: `limit is 1 to ${CHAT_HITS_MAX}.` } }
    const r = await chats.search(q, limit)
    return r.ok ? { status: 200, body: { hits: r.hits } } : { status: r.status, body: { error: r.error } }
  }
  const source = params.get('source')
  const id = params.get('id')
  if (!isChatSource(source) || !isChatNativeId(id)) return { status: 400, body: { error: 'Name a chat by its source and id.' } }
  const r = await chats.open(source, id)
  return r.ok ? { status: 200, body: r.chat } : { status: r.status, body: { error: r.error } }
}
