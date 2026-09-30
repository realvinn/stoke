/**
 * One indexing pass: list every enabled source, decide which chats are in
 * range under the caps, read only what changed, and prune what is gone.
 *
 * In this order, and the order is the design:
 *
 * 1. **List everything first**, newest first, under discovery's own cap. No
 *    chat is read yet, so a source that cannot be listed costs nothing.
 * 2. **Admit** the newest `perSource` of each source, then the newest `total`
 *    of those across all sources. Deciding the whole range up front is what
 *    keeps the total cap stable: evicting after the fact would re-read the
 *    evicted chats on the next pass and evict them again, every pass. Cline's
 *    imported copies are folded here too — a copy whose original its own tool
 *    still has is counted as a duplicate and never stored (164 of 172 Cline
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
  isChatSourceId,
  type ChatCap,
  type ChatIndexOptions,
  type ChatPassSummary,
  type ChatSourceId
} from '../../shared/chatIndex.ts'
import { planTrim, type ChatMeta } from './parse.ts'
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

/** The store's hard ceiling: past it the oldest chats go, and the status says so. */
export const STORE_MAX_BYTES = 1024 * MIB

export interface PassPlan {
  env: SourceEnv
  options: ChatIndexOptions
  maxStoreBytes?: number
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

/** The listing's fields win where it has them (Codex's thread name, a Cowork title); the read's fill the rest. */
function mergeMeta(read: ChatMeta, listed: Partial<ChatMeta>): ChatMeta {
  const out = { ...read }
  for (const k of Object.keys(listed) as (keyof ChatMeta)[]) {
    const v = listed[k]
    if (v !== null && v !== undefined) (out[k] as unknown) = v
  }
  return out
}

interface SourcePlan {
  id: ChatSourceId
  listing: Listing
  /** Admitted, newest first. */
  admitted: Candidate[]
  duplicates: number
  cappedBy: ChatCap | null
}

export async function runPass(store: ChatStore, plan: PassPlan, hooks: PassHooks): Promise<ChatPassSummary> {
  const started = hooks.now()
  const { caps } = plan.options
  const byteBudget = Math.max(1, Math.floor(caps.passMb * MIB))
  const deadline = started + caps.passSeconds * 1000
  const fileBytes = Math.max(64, Math.floor(caps.fileMb * MIB))
  const chatBytes = Math.max(64, Math.floor(caps.chatKb * 1024))
  const redact = plan.options.redact

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
   * range it is the cap that bound, and the status names it.
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
    return {
      id,
      listing,
      admitted: own.slice(0, caps.perSource),
      duplicates,
      cappedBy: own.length > caps.perSource ? 'perSource' : listing.atLeast ? 'discovery' : null
    }
  })
  const everyone = plans.flatMap((p) => p.admitted).sort((a, b) => b.mtimeMs - a.mtimeMs)
  const admitted = new Set(everyone.slice(0, caps.total).map((c) => keyOf(c.source, c.nativeId)))
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
          if (prev && prev.size === c.size && prev.mtimeMs === c.mtimeMs) {
            // Unchanged. A row with no chat is a file read before and found to be a subagent's.
            if (prev.chatId === null) keep.delete(c.nativeId)
            continue
          }
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
              ex = readJsonl(c.path, prev?.chatId === null ? null : prev, fileBytes, lineFolder(c.kind, redact))
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
          const meta = mergeMeta(ex.fold.meta, c.meta)
          /*
           * Held to the chat's text cap BEFORE it reaches the store: inserting a
           * 30 MB transcript's every line into FTS only to delete most of it
           * again is the slowest thing a pass could do. The store trims again
           * across what it already held (`trimChat`).
           */
          const drop = new Set(planTrim(ex.fold.messages.map((m) => Buffer.byteLength(m.text, 'utf8')), chatBytes))
          const messages = drop.size ? ex.fold.messages.filter((_, k) => !drop.has(k)) : ex.fold.messages
          store.tx(() => {
            const chatId = store.upsertChat(p.id, c.nativeId, meta, { subagent: c.subagent || ex.fold.subagent, dedupeKey: c.dedupeKey })
            if (ex.mode === 'replace') store.clearMessages(chatId)
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

  /* The store's own ceiling, a backstop past the count caps. */
  for (const s of store.evictToBytes(plan.maxStoreBytes ?? STORE_MAX_BYTES)) store.setCappedBy(s, 'store')
  store.tidy(chatsUpdated > 50)
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
