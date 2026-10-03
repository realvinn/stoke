/*
 * This computer's chat history as the owner's OTHER computers may read it
 * (spec 2026-10-03 §3): the two routes the relay instance of the phone server
 * answers (`answerChatsRoute`, called from `RemoteServer.api` only where
 * `chatsRouteFor` says `relay`), and what they read (`sharedChats`).
 *
 * The rules this file keeps, whatever the chat index's own settings say:
 * - everything that leaves was cleaned AT THE SOURCE: the index searches only
 *   chats stored cleaned by today's rules and re-reads an opened chat with
 *   redaction forced (`ChatIndexHost.searchCleaned`/`openCleaned`, spec §1),
 *   whatever the local redaction setting says. A search over raw stored text
 *   would answer yes or no for any prefix of a secret however its snippets
 *   were redacted afterwards (gotcha 156), so that is the guarantee; the index's secret
 *   patterns (`redact`, chatIndex/parse.ts `redactSecrets`) then run again
 *   over every title, snippet, message, folder name and id as a second belt,
 *   and a snippet whose text that changes gets its highlight ranges
 *   recomputed. The belt runs AFTER the text is cut to shape
 *   (`remoteChatHitFrom`, `remoteChatFrom`), over the bytes that are sent:
 *   shaping once DELETED control characters after the patterns had run, so a
 *   key the index stored split by a bare `\r` left joined and whole
 *   (re-review of 62b4ae6). A chat whose id the patterns would change is not sent at all:
 *   it could not be opened by the id it would leave under;
 * - nothing answers while chat history is off, nor while its "Leave out
 *   anything that looks like an API key" is: chats stored then are raw, the
 *   cleaned search does not find them, and a guest would be told a chat that
 *   is here is not (`chatsShareBlock`'s pause; `HubRemote` refuses first);
 * - a folder leaves by its last segment only (`folderName`), never a path;
 * - a chat in a folder the owner hid (`hiddenProjects`) is neither found nor
 *   opened: the same 404 as a chat that does not exist, so the route is no
 *   existence probe. Nor may a hidden chat take a PLACE in the answer: with
 *   the guest's limit applied before the filter, `limit=1` answered nothing
 *   where `limit=2` answered one hit, which said a hidden chat matched and
 *   ranked first. The index leaves hidden folders out before ITS limit
 *   (`searchCleaned`'s `hidden`), and this asks it for `CHAT_HITS_MAX` and cuts
 *   to the guest's limit only after its own filters.
 *
 * The HOST's grant and scope are judged before any of this runs
 * (`HubRemote`); this is what a judged request reads.
 *
 * No electron import, so `verify:hub-relay` runs it against a real
 * `redactSecrets`. Imports only src/shared by relative `.ts` path (gotcha 78).
 */
import { CHAT_SEARCH_MIN_CHARS, highlightRanges, isChatOrigin, type ChatOrigin, type ChatSearchHit, type ChatTranscript } from '../../shared/chatIndex.ts'
import { CHAT_HITS_MAX, CHAT_QUERY_MAX, isChatNativeId, isChatSource } from '../../shared/hub/relay.ts'
import { remoteChatFrom, remoteChatHitFrom, type ChatsRefusalCode, type RemoteChat, type RemoteChatHit } from '../../shared/hub/remote.ts'

export type ChatsRefusal = { ok: false; status: number; error: string; code?: ChatsRefusalCode }

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
  /** `settings.chatIndexOptions.redact` ("Leave out anything that looks like an API key"). Off, nothing is served. */
  redactOn(): boolean
  /** A chat whose folder the owner hid (`hiddenProjects`, `isInside`): it never leaves. */
  hidden(cwd: string): boolean
  /**
   * The index's search over CLEANED rows only, best hit per chat, hidden
   * folders left out before its limit (`ChatIndexHost.searchCleaned`): a chat
   * stored while redaction was off is not found until a pass with it on has
   * cleaned it, never served raw.
   */
  search(q: string, limit: number): Promise<ChatSearchHit[]>
  /**
   * One chat by its tool and the tool's own id, re-read with redaction forced
   * on, or the index's copy only if that was cleaned by today's rules
   * (`ChatIndexHost.openCleaned`); null for anything else.
   */
  open(source: ChatOrigin, nativeId: string): Promise<ChatTranscript | null>
  /** The index's own secret patterns (chatIndex/parse.ts `redactSecrets`). */
  redact(text: string): string
}

const OFF: ChatsRefusal = { ok: false, status: 503, error: 'Chat history is off on that computer.', code: 'history-off' }
const PAUSED: ChatsRefusal = {
  ok: false,
  status: 503,
  error: 'That computer has paused sharing its chat history: “Leave out anything that looks like an API key” is off there.',
  code: 'redaction-off'
}
const MISSING: ChatsRefusal = { ok: false, status: 404, error: 'That chat isn’t on that computer any more.' }

/** The guarded, redacted reader the relay instance serves (`RemoteServer.serveChats`). */
export function sharedChats(a: ChatIndexAccess): SharedChats {
  /** Why nothing may be read now, or null: asked before the index is, and again after its await. */
  const shut = (): ChatsRefusal | null => (!a.indexOn() ? OFF : !a.redactOn() ? PAUSED : null)
  /** The folder's name (already its last segment) through the patterns too. */
  const named = <T extends { folder: string | null }>(x: T): T => (x.folder === null ? x : { ...x, folder: a.redact(x.folder) })
  return {
    async search(q, limit) {
      const before = shut()
      if (before) return before
      const query = q.slice(0, CHAT_QUERY_MAX)
      if (query.trim().length < CHAT_SEARCH_MIN_CHARS) return { ok: true, hits: [] }
      const want = Math.max(1, Math.min(CHAT_HITS_MAX, Math.floor(limit)))
      // Always the most there may be; the guest's limit is taken only after the filters below.
      const found = await a.search(query, CHAT_HITS_MAX)
      // Read again after the await: a switch-off while the worker searched answers nothing.
      const after = shut()
      if (after) return after
      const hits = found
        .filter((h) => (!h.cwd || !a.hidden(h.cwd)) && a.redact(h.nativeId) === h.nativeId)
        .slice(0, want)
        .map((h) => {
          // Shaped first, judged after: the patterns see exactly the bytes that leave.
          const shaped = remoteChatHitFrom(h, query)
          const snippet = a.redact(shaped.snippet)
          // The ranges point into the shaped text: once redaction moves it, mark the redacted text afresh.
          const ranges = snippet === shaped.snippet ? shaped.ranges : highlightRanges(snippet, query)
          return named({ ...shaped, title: shaped.title === null ? null : a.redact(shaped.title), snippet, ranges })
        })
      return { ok: true, hits }
    },
    async open(source, nativeId) {
      const before = shut()
      if (before) return before
      if (!isChatSource(source) || !isChatOrigin(source) || !isChatNativeId(nativeId) || a.redact(nativeId) !== nativeId) return MISSING
      const t = await a.open(source, nativeId)
      const after = shut()
      if (after) return after
      if (!t || (t.cwd && a.hidden(t.cwd))) return MISSING
      // Shaped first (controls, the size cut), judged after: the patterns see exactly the bytes that leave.
      const shaped = remoteChatFrom(t, nativeId)
      const chat: RemoteChat = {
        ...shaped,
        title: shaped.title === null ? null : a.redact(shaped.title),
        messages: shaped.messages.map((m) => ({ ...m, text: a.redact(m.text) }))
      }
      return { ok: true, chat: named(chat) }
    }
  }
}

/**
 * One `/api/chats/*` request on the relay instance, as `{status, body}`.
 * The query was already held to `relayRouteFor`'s shape by the host's
 * verdicts; it is read again here, because this is the handler. A refusal's
 * body carries its `ChatsRefusalCode` beside the sentence, for the guest to
 * word itself.
 */
export async function answerChatsRoute(chats: SharedChats, route: 'search' | 'open', params: URLSearchParams): Promise<{ status: number; body: unknown }> {
  const refused = (r: ChatsRefusal): { status: number; body: unknown } => ({ status: r.status, body: r.code ? { error: r.error, code: r.code } : { error: r.error } })
  if (route === 'search') {
    const q = params.get('q') ?? ''
    if (q.length === 0 || q.length > CHAT_QUERY_MAX) return { status: 400, body: { error: `A search is 1 to ${CHAT_QUERY_MAX} characters.` } }
    const raw = params.get('limit')
    const limit = raw === null ? CHAT_HITS_MAX : Number(raw)
    if (!Number.isInteger(limit) || limit < 1 || limit > CHAT_HITS_MAX) return { status: 400, body: { error: `limit is 1 to ${CHAT_HITS_MAX}.` } }
    const r = await chats.search(q, limit)
    return r.ok ? { status: 200, body: { hits: r.hits } } : refused(r)
  }
  const source = params.get('source')
  const id = params.get('id')
  if (!isChatSource(source) || !isChatNativeId(id)) return { status: 400, body: { error: 'Name a chat by its source and id.' } }
  const r = await chats.open(source, id)
  return r.ok ? { status: 200, body: r.chat } : refused(r)
}
