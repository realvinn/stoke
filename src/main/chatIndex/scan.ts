/**
 * One indexing pass: list every enabled source, decide which chats are in
 * range under the caps, read only what changed, and prune what is gone.
 *
 * In this order, and the order is the design:
 *
 * 1. **List everything first**, newest first, under discovery's own cap. No
 *    chat is read yet, so a source that cannot be listed costs nothing.
 * 2. **Admit** the newest `perSource` of each source, then the newest `total`
 *    of those across all sources, after the imported conversations — held to
 *    this pass's caps first (`capImports`) — have taken their room. Deciding the whole range up front is what
 *    keeps the total cap stable: evicting after the fact would re-read the
 *    evicted chats on the next pass and evict them again, every pass. The
 *    store's size ceiling can only be learnt by reading, so it is the one cap
 *    that does evict after the fact — and it is turned into admission too: the
 *    newest mtime it evicted is remembered as a cut (`storeCutMs`) and nothing
 *    at or below it is admitted again. A file already found to hold no chat
 *    takes no slot while it is unchanged (`holdsNoChat`). Cline's imported
 *    copies are folded here too — a copy whose original its own tool still
 *    has is counted as a duplicate and never stored (164 of 172 Cline
 *    sessions on the machine measured were copies).
 * 3. **Read** each admitted chat that changed — appended bytes only for a
 *    JSONL file (gotcha 103's cursor checks), the whole document or row
 *    otherwise — until the pass's byte or time budget runs out. A pass that
 *    stops says so; the next one carries on, newest first, because the chats it
 *    reached are now unchanged and cost one stat each.
 * 4. **Prune** only a source that was listed in full: a chat gone from the
 *    source, or out of range, leaves the store. A source that could not be
 *    read, or stopped counting, prunes nothing (`sessionIndex.ts`'s rule).
 *
 * The caller hands in a clock, a yield and a cancel flag, so the worker can
 * answer a search between two chats and a suite can drive a pass with no
 * worker at all.
 */
import type { DatabaseSync } from 'node:sqlite'
import {
  CHAT_SOURCE_IDS,
  CHAT_STORE_MAX_TEXT_MB,
  isChatSourceId,
  type ChatCap,
  type ChatIndexOptions,
  type ChatPassSummary,
  type ChatSourceId
} from '../../shared/chatIndex.ts'
import { cleanText, firstPromptOf, planTrim, type ChatMeta } from './parse.ts'
import type { ChatStore, SourceStateRow } from './store.ts'
import {
  discovery,
  lineFolder,
  listSource,
  openReadOnly,
  readCline,
  readError,
  readJsonl,
  readOpencode,
  readZed,
  type Candidate,
  type Extracted,
  type Listing,
  type SourceEnv
} from './sources.ts'

const MIB = 1024 * 1024

/**
 * The store's hard ceiling, as chat TEXT: past it the oldest chats go, and the
 * status says so. Text, not the database's pages (`evictToText` says why).
 * A merged store is 1.73 bytes on disk per byte of text, measured on this
 * machine's real chats (122 chats, 6,189 messages, 3.81 MB of text, 6.58 MB
 * used after `optimize`; synthetic text measured 1.61–1.84), so 512 MB of text
 * is about 0.9 GB on disk — "about 1 GB" in the disclosure. Between merges the
 * file also carries deleted rows' tombstones, which FTS5's own automerge and
 * `tidy`'s optimize after a big pass fold away.
 */
export const STORE_MAX_TEXT_BYTES = CHAT_STORE_MAX_TEXT_MB * MIB

export interface PassPlan {
  env: SourceEnv
  options: ChatIndexOptions
  /** The ceiling, for a suite; `STORE_MAX_TEXT_BYTES` otherwise. */
  maxTextBytes?: number
}

export interface PassHooks {
  now: () => number
  /** Give the thread back between two chats (the worker answers a search there). */
  yieldTurn: () => Promise<void>
  cancelled: () => boolean
  progress: (p: { source: ChatSourceId; done: number; total: number }) => void
}

function keyOf(source: string, nativeId: string): string {
  return `${source}:${nativeId}`
}

/**
 * The listing's fields win where it has them (Codex's thread name, a Cowork
 * title); the read's fill the rest.
 *
 * A title and a first prompt from a tool's OWN listing are text like any
 * message — Codex's `first_user_message` is the user's first words verbatim,
 * and a Cline title is often its prompt — so they go through `cleanText` as
 * the read's do (`foldClaudeLine`'s ai-title, `push`'s first prompt). They did
 * not: a key pasted into a Codex chat's first message was redacted in the
 * message and stored whole as the chat's first prompt, which search hands
 * back on every hit.
 */
export function mergeMeta(read: ChatMeta, listed: Partial<ChatMeta>, redact: boolean): ChatMeta {
  const out = { ...read }
  for (const k of Object.keys(listed) as (keyof ChatMeta)[]) {
    const v = listed[k]
    if (v !== null && v !== undefined) (out[k] as unknown) = v
  }
  if (listed.title) out.title = cleanText(listed.title, { redact, maxBytes: 1024 }) || read.title
  if (listed.firstPrompt) out.firstPrompt = firstPromptOf(cleanText(listed.firstPrompt, { redact })) || read.firstPrompt
  return out
}

/**
 * Clean every chat the store holds that was not cleaned with the rules in
 * force now (`ChatStore.staleChatIds`), one chat per transaction, giving the
 * thread back between two (a search is answered there) and stopping where a
 * cancel or the pass's deadline says — the next pass carries on from the
 * oldest left. Returns how many it cleaned.
 */
export async function recleanStale(
  store: ChatStore,
  hooks: Pick<PassHooks, 'now' | 'yieldTurn' | 'cancelled'> & { deadline?: number }
): Promise<number> {
  let done = 0
  // A chat named twice was not raised by its clean: stop rather than spin on it for the rest of the pass.
  const tried = new Set<number>()
  for (;;) {
    const ids = store.staleChatIds(50).filter((id) => !tried.has(id))
    if (ids.length === 0) return done
    for (const id of ids) {
      tried.add(id)
      if (hooks.cancelled() || (hooks.deadline !== undefined && hooks.now() >= hooks.deadline)) return done
      if (store.recleanChat(id)) done++
      await hooks.yieldTurn()
    }
  }
}

interface SourcePlan {
  id: ChatSourceId
  listing: Listing
  /** Admitted, newest first. */
  admitted: Candidate[]
  duplicates: number
  cappedBy: ChatCap | null
}

/**
 * A file read before and found to hold no chat — a subagent's while those are
 * off, or nothing to index — and unchanged since. It takes no slot under the
 * caps: counted as one, an empty transcript would push a real chat out of the
 * newest N on every pass while never answering a search itself.
 */
function holdsNoChat(store: ChatStore, c: Candidate): boolean {
  const f = store.getFile(c.locator)
  return f !== null && f.chatId === null && f.size === c.size && f.mtimeMs === c.mtimeMs
}

export async function runPass(store: ChatStore, plan: PassPlan, hooks: PassHooks): Promise<ChatPassSummary> {
  const started = hooks.now()
  const { caps } = plan.options
  const byteBudget = Math.max(1, Math.floor(caps.passMb * MIB))
  const deadline = started + caps.passSeconds * 1000
  const fileBytes = Math.max(64, Math.floor(caps.fileMb * MIB))
  const chatBytes = Math.max(64, Math.floor(caps.chatKb * 1024))
  const redact = plan.options.redact
  const maxTextBytes = plan.maxTextBytes ?? STORE_MAX_TEXT_BYTES

  /*
   * 0. What this pass is asked for. When it is not what the last pass was
   * asked for — a source, a cap, the subagent switch — two memos stop being
   * true: the files remembered as holding no chat (a Codex subagent's, while
   * those were off) and the store's cut (the ceiling bound under other caps).
   * Both go, so this pass works the answer out again. Only the user changes
   * the options, so this cannot become the every-pass re-read the cut stops.
   */
  const passKey = JSON.stringify({ options: plan.options, maxTextBytes })
  if (store.passKey() !== passKey) {
    store.tx(() => {
      store.forgetEmptyFiles()
      store.setStoreCutMs(null)
      store.setPassKey(passKey)
    })
  }
  const cutMs = store.storeCutMs() ?? -Infinity

  /*
   * 0b. Redaction on: every chat stored without it — while it was off, or by
   * an older rule set — is cleaned again first, in place, before this pass
   * reads anything (`recleanStale`). Without this a chat whose file had not
   * changed since redaction was turned back on kept its keys in the index for
   * as long as the file stayed unchanged: a pass only re-reads what changed.
   */
  let recleaned = 0
  if (redact) recleaned = await recleanStale(store, { ...hooks, deadline })

  /* 1. List. A source switched off leaves the store entirely. */
  const listed: { id: ChatSourceId; listing: Listing }[] = []
  for (const id of CHAT_SOURCE_IDS) {
    if (!plan.options.sources[id]) {
      if (store.count(id) > 0 || store.getSourceState(id)) store.removeSource(id)
      continue
    }
    // Discovery keeps its own wall-clock budget; the pass's clock is the caller's.
    listed.push({ id, listing: listSource(id, plan.env, plan.options.subagents, discovery(Date.now())) })
  }

  /*
   * 2. Admit. Cline's copies are folded first: a copy whose original its own
   * tool still HAS — in that tool's range or not, and a subagent's or archived
   * thread withheld from the index too (`withheld`) — is that tool's chat,
   * governed by that tool's caps, and is never stored as Cline's. Only a copy
   * whose original is gone (Claude Code's 30-day cleanup, say) is kept, as the
   * last record of it. Measured on the machine this was written on, folding
   * only against originals IN RANGE left the newest 20 Cline sessions as 19
   * copies of Codex and Claude chats that Codex's own cap had just left out:
   * the per-source cap walked round through Cline. And counting only what a
   * tool indexes, 19 of the next 20 were copies of Codex SUBAGENT threads —
   * the "subagents off" switch walked round the same way.
   *
   * Then the newest `perSource` of what is left of each source, then the
   * newest `total` across every source. Where the total cap cuts a source's
   * range it is the cap that bound, and the status names it. The store's cut
   * ends a source's range where it falls, and names itself the same way.
   */
  const originals = new Set(
    listed
      .filter((l) => l.id !== 'cline')
      .flatMap((l) => [...l.listing.candidates.map((c) => keyOf(c.source, c.nativeId)), ...(l.listing.withheld ?? []).map((id) => keyOf(l.id, id))])
  )
  const plans: SourcePlan[] = listed.map(({ id, listing }) => {
    let duplicates = 0
    const own = listing.candidates.filter((c) => {
      if (!c.dedupeKey) return true
      const [src, ...rest] = c.dedupeKey.split(':')
      const dup = isChatSourceId(src) && (originals.has(c.dedupeKey) || store.hasChat(src, rest.join(':')))
      if (dup) duplicates++
      return !dup
    })
    // Newest first, so the first candidate at or below the cut ends the range: every one after it is older.
    const admitted: Candidate[] = []
    let cappedBy: ChatCap | null = listing.atLeast ? 'discovery' : null
    for (const c of own) {
      if (admitted.length >= caps.perSource) {
        cappedBy = 'perSource'
        break
      }
      if (c.mtimeMs <= cutMs) {
        cappedBy = 'store'
        break
      }
      if (!holdsNoChat(store, c)) admitted.push(c)
    }
    return { id, listing, admitted, duplicates, cappedBy }
  })
  /*
   * Imported conversations count toward the total: "chats in all" is every
   * chat the index holds, not every chat a pass reads. They are never ranked
   * here — a pass could not bring one back — so they take their room first.
   *
   * Held to THIS pass's caps before that room is worked out, not only the
   * caps they were imported under: an import is capped when it runs, and the
   * user can lower the caps after it (Light, or a smaller number). Without
   * this, 2,000 ChatGPT and 2,000 claude.ai conversations imported under the
   * defaults stayed at 4,000 under Light's 500 per tool and 1,500 in all, and
   * left local chats a room of max(0, 1,500 − 4,000) = 0 — so step 4 pruned
   * every chat of every tool and the index held nothing but the imports, more
   * of them than either cap now allowed. Cheap when nothing is over: two
   * ordered selects of the imported rows.
   */
  store.capImports(caps.perSource, caps.total)
  const room = Math.max(0, caps.total - store.importedCount())
  const everyone = plans.flatMap((p) => p.admitted).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const admitted = new Set(everyone.slice(0, room).map((c) => keyOf(c.source, c.nativeId)))
  for (const p of plans) {
    const before = p.admitted.length
    p.admitted = p.admitted.filter((c) => admitted.has(keyOf(c.source, c.nativeId)))
    if (p.admitted.length < before) p.cappedBy = 'total'
  }

  /* 3. Read what changed, under the pass's budget. */
  let bytesRead = 0
  let filesRead = 0
  let chatsUpdated = 0
  let stoppedBy: ChatCap | null = null
  for (const p of plans) {
    const keep = new Set(p.admitted.map((c) => c.nativeId))
    let srcBytes = 0
    let db: DatabaseSync | null = null
    let dbError: string | null = null
    if (p.listing.error === null && !stoppedBy) {
      try {
        for (let i = 0; i < p.admitted.length; i++) {
          if (hooks.cancelled()) break
          if (bytesRead >= byteBudget) {
            stoppedBy = 'bytes'
            break
          }
          if (hooks.now() >= deadline) {
            stoppedBy = 'time'
            break
          }
          const c = p.admitted[i]
          if (i % 20 === 0) hooks.progress({ source: p.id, done: i, total: p.admitted.length })
          const prev = store.getFile(c.locator)
          // Unchanged since it was read: one stat, nothing more. (One holding no chat was never admitted.)
          if (prev && prev.size === c.size && prev.mtimeMs === c.mtimeMs) continue
          let ex: Extracted
          try {
            if (c.kind === 'opencode' || c.kind === 'zed') {
              if (!db && !dbError) {
                try {
                  db = openReadOnly(c.path)
                } catch (err) {
                  dbError = readError(err)
                }
              }
              if (!db) break
              ex = c.kind === 'opencode' ? readOpencode(db, c, redact) : readZed(db, c, fileBytes, redact)
            } else if (c.kind === 'cline') {
              ex = readCline(c, fileBytes, redact)
            } else {
              // No chat behind the row: read it whole, so its first record is seen again.
              ex = readJsonl(c.path, prev?.chatId === null ? null : prev, fileBytes, lineFolder(c.kind, redact, c.subagent))
            }
          } catch {
            // One unreadable chat does not stop its source.
            continue
          }
          bytesRead += ex.bytesRead
          srcBytes += ex.bytesRead
          filesRead++
          if (ex.fold.subagent && !plan.options.subagents) {
            // Only the file said so (a rollout listed without Codex's threads
            // table): remembered, so it is not read again until it changes.
            keep.delete(c.nativeId)
            const stale = store.chatId(p.id, c.nativeId)
            store.tx(() => {
              if (stale !== null) store.deleteChat(stale)
              store.putFile({ locator: c.locator, source: p.id, chatId: null, ...ex.file })
            })
            continue
          }
          const meta = mergeMeta(ex.fold.meta, c.meta, redact)
          const whole = ex.mode === 'replace'
          const known = store.chatId(p.id, c.nativeId)
          if (ex.fold.messages.length === 0 && !meta.title && (whole || known === null)) {
            /*
             * Nothing to search: no message and no title. Never stored — an
             * empty chat row answers no search and would still count as
             * indexed — but remembered, so it is not read again, and takes no
             * slot (`holdsNoChat`), until it changes.
             */
            keep.delete(c.nativeId)
            store.tx(() => {
              if (known !== null) store.deleteChat(known)
              store.putFile({ locator: c.locator, source: p.id, chatId: null, ...ex.file })
            })
            continue
          }
          /*
           * Held to the chat's text cap BEFORE it reaches the store: inserting a
           * 30 MB transcript's every line into FTS only to delete most of it
           * again is the slowest thing a pass could do. The store trims again
           * across what it already held (`trimChat`).
           */
          const drop = new Set(planTrim(ex.fold.messages.map((m) => Buffer.byteLength(m.text, 'utf8')), chatBytes))
          const messages = drop.size ? ex.fold.messages.filter((_, k) => !drop.has(k)) : ex.fold.messages
          store.tx(() => {
            const chatId = store.upsertChat(p.id, c.nativeId, meta, { subagent: c.subagent || ex.fold.subagent, dedupeKey: c.dedupeKey, whole, redact })
            if (whole) store.clearMessages(chatId)
            store.appendMessages(chatId, messages)
            store.trimChat(chatId, chatBytes)
            if (ex.truncated || drop.size) store.markTruncated(chatId)
            store.putFile({ locator: c.locator, source: p.id, chatId, ...ex.file })
          })
          chatsUpdated++
          await hooks.yieldTurn()
        }
      } finally {
        ;(db as DatabaseSync | null)?.close()
      }
    }
    hooks.progress({ source: p.id, done: p.admitted.length, total: p.admitted.length })

    /* 4. Prune, only after a complete listing and a pass nobody cancelled. */
    if (p.listing.complete && p.listing.error === null && !hooks.cancelled()) {
      const gone = store.chatsOf(p.id).filter((r) => !keep.has(r.nativeId))
      if (gone.length) store.tx(() => gone.forEach((r) => store.deleteChat(r.id)))
    }
    // A range the pass did not finish says so before any count cap: "Still indexing".
    const reached = !stoppedBy || p.admitted.every((c) => store.getFile(c.locator) !== null)
    const state: SourceStateRow = {
      found: p.listing.error ? (store.getSourceState(p.id)?.found ?? null) : p.listing.candidates.length,
      foundAtLeast: p.listing.atLeast,
      target: p.admitted.length,
      duplicates: p.duplicates,
      bytesRead: srcBytes,
      cappedBy: reached ? p.cappedBy : stoppedBy,
      lastPassMs: hooks.now(),
      error: p.listing.error ?? dbError
    }
    store.putSourceState(p.id, state)
  }

  /*
   * The store's own ceiling, a backstop past the count caps. It evicts the
   * oldest by admission key, and the newest key it evicted becomes the cut the
   * next pass admits above. Without that the evicted chats — their read
   * positions deleted with them — were admitted again, read whole and evicted
   * again on every pass, each time up to the pass's whole byte and time budget.
   */
  const evicted = store.evictToText(maxTextBytes)
  for (const s of evicted.sources) store.setCappedBy(s, 'store')
  if (evicted.newestMs !== null) store.setStoreCutMs(Math.max(evicted.newestMs, cutMs))
  store.tidy(chatsUpdated + recleaned > 50)
  const summary: ChatPassSummary = {
    startedMs: started,
    ms: hooks.now() - started,
    bytesRead,
    filesRead,
    chatsUpdated,
    stoppedBy
  }
  store.putLastPass(summary)
  return summary
}
