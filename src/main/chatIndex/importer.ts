/**
 * An account export, handed over by the user, into the chat index. Runs only in
 * the chat-index worker (and `verify:chat-sources`), with sync reads for the
 * same reason `sources.ts` gives: the libuv pool is shared with pty writes.
 *
 * The file is recognised by its CONTENT, never its name or extension: a zip is
 * `PK` and its directory must list a `conversations.json` (or ChatGPT's
 * `conversations-NNN.json` shards); anything else must be a JSON array whose
 * objects are claude.ai conversations (`chat_messages`) or ChatGPT ones
 * (`mapping`). Only those members are read (`zip.ts`, which refuses bombs and
 * escaping names before inflating anything).
 *
 * The same caps and disclosure as a pass, applied to what the file holds:
 *
 * 1. **Rank** every conversation by its own last stamp, newest first — one
 *    `JSON.parse` per conversation, the array split by byte range
 *    (`forEachArrayObject`), so no file is ever one parse. A conversation id
 *    seen twice is one conversation, the newer copy.
 * 2. **Admit** the newest `perSource` (the per-tool cap: claude.ai is a tool),
 *    and never more than `total`.
 * 3. **Write** each, keyed by `(kind, conversation id)`: a conversation already
 *    in the index from an earlier export is replaced in place, never doubled.
 *    Its own title and stamps are kept; its text goes through the same rules as
 *    every local chat (`cleanText` via `push`: blobs out, keys redacted when
 *    asked, 64 KB a message) and the same per-chat cap (`chatKb`).
 * 4. **Hold** every import together to the caps (`capImports`) and the whole
 *    store to its ceiling (`evictToText`), as a pass does — and every pass
 *    holds them again, to its own caps, since the user can lower them later.
 *
 * A stop (Delete index, chat history switched off, quit) keeps what was
 * written, records how far it got, and answers `ok: false` saying so.
 *
 * Imported text lives in the index's store and nowhere else: the file is read
 * in place and never copied. Delete index removes it with everything; Remove
 * beside an import removes that file's chats.
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { basename } from 'node:path'
import {
  CHAT_EXPORT_LIMITS,
  CHAT_IMPORTS,
  importDisclosure,
  isChatSourceId,
  type ChatImportKind,
  type ChatImportResult,
  type ChatIndexOptions
} from '../../shared/chatIndex.ts'
import { exportIdentity, exportKindOf, foldExportConversation, forEachArrayObject } from './exports.ts'
import { planTrim } from './parse.ts'
import { readError } from './sources.ts'
import type { ChatStore, ImportTally } from './store.ts'
import { closeZip, openZip, readZipEntry, ZipError, type ZipLimits } from './zip.ts'

export interface ImportPlan {
  path: string
  options: ChatIndexOptions
  /** The store's text ceiling (`STORE_MAX_TEXT_BYTES`), passed so a suite can shrink it. */
  maxTextBytes: number
  /** A suite shrinks these to build a bomb small enough to ship. */
  limits?: ZipLimits
}

export interface ImportHooks {
  now: () => number
  /** Give the thread back between conversations, so a search is answered mid-import. */
  yieldTurn: () => Promise<void>
  cancelled: () => boolean
}

/** Conversations parsed between two yields while ranking. */
const RANK_BATCH = 100

/** A member of an export that holds conversations: `conversations.json`, or a ChatGPT shard. */
const CONVERSATIONS = /(^|\/)conversations(-\d+)?\.json$/i

/** What another vendor's export looks like, to say which one it is rather than "not an export". */
function foreignExport(names: string[]): string | null {
  if (names.some((n) => /Gemini Apps\//i.test(n) || /^Takeout\//.test(n))) return 'a Google Takeout (Gemini)'
  if (names.some((n) => /grok/i.test(n))) return 'a Grok'
  return null
}

const UNSUPPORTED =
  'Stoke reads claude.ai and ChatGPT exports. Gemini’s Takeout and Grok’s export have no documented format yet, so they are not read.'

function firstBytes(path: string, n: number): Buffer {
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(n)
    const got = readSync(fd, buf, 0, n, 0)
    return buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}

/** The documents that may hold conversations: every matching zip member, or the file itself. */
function documents(path: string, bytes: number, limits: ZipLimits): Buffer[] {
  const head = firstBytes(path, 4)
  if (head.length >= 2 && head[0] === 0x50 && head[1] === 0x4b) {
    const z = openZip(path, limits)
    try {
      const members = z.entries.filter((e) => CONVERSATIONS.test(e.name.replace(/\\/g, '/')) && !e.name.endsWith('/'))
      if (members.length === 0) {
        const foreign = foreignExport(z.entries.map((e) => e.name))
        throw new ZipError(foreign ? `This looks like ${foreign} export. ${UNSUPPORTED}` : `This archive holds no conversations.json. ${UNSUPPORTED}`)
      }
      const total = members.reduce((n, e) => n + e.size, 0)
      if (total > limits.memberBytes) {
        throw new ZipError(
          `The conversations in this archive are ${Math.round(total / 1024 ** 2).toLocaleString('en-US')} MB unpacked; Stoke reads up to ${Math.round(limits.memberBytes / 1024 ** 2).toLocaleString('en-US')} MB.`
        )
      }
      return members.map((e) => readZipEntry(z, e, limits))
    } finally {
      closeZip(z)
    }
  }
  if (bytes > limits.memberBytes) {
    throw new ZipError(`The file is ${Math.round(bytes / 1024 ** 2).toLocaleString('en-US')} MB; Stoke reads up to ${Math.round(limits.memberBytes / 1024 ** 2).toLocaleString('en-US')} MB.`)
  }
  return [readFileSync(path)]
}

interface Ranked {
  doc: number
  start: number
  end: number
  id: string
  updatedMs: number
}

export async function importExport(store: ChatStore, plan: ImportPlan, hooks: ImportHooks): Promise<ChatImportResult> {
  const limits = plan.limits ?? CHAT_EXPORT_LIMITS
  const { caps, redact } = plan.options
  let bytes: number
  try {
    const st = statSync(plan.path)
    if (!st.isFile()) return { ok: false, error: 'That is not a file.' }
    bytes = st.size
  } catch (err) {
    return { ok: false, error: readError(err) }
  }

  /*
   * 1. Rank. The array is split into byte ranges first — a scan, no parsing —
   * and then each range is parsed with a yield every `RANK_BATCH`, so a search
   * asked mid-import waits for one batch rather than the whole file: measured
   * on a 155 MB synthetic ChatGPT export, parsing it in one turn held the
   * thread 328 ms.
   */
  let docs: Buffer[]
  let kind: ChatImportKind | null = null
  const byId = new Map<string, Ranked>()
  let complete = true
  try {
    docs = documents(plan.path, bytes, limits)
    for (let d = 0; d < docs.length; d++) {
      const buf = docs[d]
      const ranges: [number, number][] = []
      const res = forEachArrayObject(buf, (start, end) => ranges.push([start, end]))
      let seen = 0
      for (let i = 0; i < ranges.length; i++) {
        if (i % RANK_BATCH === RANK_BATCH - 1) {
          await hooks.yieldTurn()
          if (hooks.cancelled()) return { ok: false, error: 'The import was stopped.' }
        }
        const [start, end] = ranges[i]
        let doc: unknown
        try {
          doc = JSON.parse(buf.toString('utf8', start, end))
        } catch {
          continue
        }
        const k = exportKindOf(doc)
        if (!k) continue
        // One file is one vendor's: the first conversation recognised decides.
        kind ??= k
        if (k !== kind) continue
        const ident = exportIdentity(doc, k)
        if (!ident) continue
        seen++
        const prev = byId.get(ident.id)
        const updatedMs = ident.updatedMs ?? 0
        if (!prev || updatedMs > prev.updatedMs) byId.set(ident.id, { doc: d, start, end, id: ident.id, updatedMs })
      }
      if (!res.complete && seen > 0) complete = false
      await hooks.yieldTurn()
      if (hooks.cancelled()) return { ok: false, error: 'The import was stopped.' }
    }
  } catch (err) {
    if (err instanceof ZipError) return { ok: false, error: err.message }
    if (err instanceof SyntaxError) return { ok: false, error: `This is not a claude.ai or ChatGPT export: its conversations are not a JSON list. ${UNSUPPORTED}` }
    return { ok: false, error: readError(err) }
  }
  const importKind = kind
  if (!importKind) return { ok: false, error: `No claude.ai or ChatGPT conversations were found in this file. ${UNSUPPORTED}` }

  /* 2. Admit. */
  const ranked = [...byId.values()].sort((a, b) => b.updatedMs - a.updatedMs || (a.id < b.id ? -1 : 1))
  const room = Math.max(0, Math.min(caps.perSource, caps.total))
  const admitted = ranked.slice(0, room)
  const cappedBy: ImportTally['cappedBy'] = ranked.length > room ? (caps.total < caps.perSource ? 'total' : 'perSource') : null

  /*
   * 3. Write. `admitted` stays the number the caps let in; a stop leaves
   * `added + updated + empty` short of it, and that shortfall is what the
   * record says (`importDisclosure`). It used to be recorded and answered as a
   * whole import — `ok: true`, "Imported all N conversations." — when Delete
   * index, switching chat history off or quitting stopped it part-way.
   */
  const chatBytes = Math.max(64, Math.floor(caps.chatKb * 1024))
  const importId = store.addImport(importKind, basename(plan.path), bytes, hooks.now(), ranked.length)
  const tally: ImportTally = { admitted: admitted.length, added: 0, updated: 0, empty: 0, truncated: 0, cappedBy }
  let stopped = false
  try {
    for (let i = 0; i < admitted.length; i++) {
      if (hooks.cancelled()) {
        stopped = true
        break
      }
      const r = admitted[i]
      let conv: ReturnType<typeof foldExportConversation>
      try {
        conv = foldExportConversation(JSON.parse(docs[r.doc].toString('utf8', r.start, r.end)), importKind, redact)
      } catch {
        conv = null
      }
      if (!conv || (conv.fold.messages.length === 0 && !conv.fold.meta.title)) {
        tally.empty++
        continue
      }
      const { fold } = conv
      const drop = new Set(planTrim(fold.messages.map((m) => Buffer.byteLength(m.text, 'utf8')), chatBytes))
      const messages = drop.size ? fold.messages.filter((_, k) => !drop.has(k)) : fold.messages
      store.tx(() => {
        const existed = store.chatId(importKind, conv!.id) !== null
        const chatId = store.upsertChat(importKind, conv!.id, fold.meta, { subagent: false, dedupeKey: null, whole: true })
        store.clearMessages(chatId)
        store.appendMessages(chatId, messages)
        const trimmed = store.trimChat(chatId, chatBytes)
        if (drop.size || trimmed) {
          store.markTruncated(chatId)
          tally.truncated++
        }
        store.setImportId(chatId, importId)
        if (existed) tally.updated++
        else tally.added++
      })
      if (i % 50 === 49) await hooks.yieldTurn()
    }
  } finally {
    store.finishImport(importId, tally)
  }

  /* 4. Hold. */
  store.capImports(caps.perSource, caps.total)
  const evicted = store.evictToText(plan.maxTextBytes)
  for (const s of evicted.sources) if (isChatSourceId(s)) store.setCappedBy(s, 'store')
  if (evicted.newestMs !== null) store.setStoreCutMs(Math.max(evicted.newestMs, store.storeCutMs() ?? -Infinity))
  store.dropSupersededImports(importKind, importId)
  // No whole-index rewrite on the way out of a stop: quitting gives the worker 1.5 s (`ChatIndexHost.stop`).
  store.tidy(!stopped && tally.added + tally.updated > 50)
  const record = store.importRecord(importId)
  if (!record) return { ok: false, error: 'The import was written, but its record could not be read back.' }
  /*
   * Stopped part-way: what it wrote stays, searchable and under the caps, and
   * its record says how far it got. Answered as a failure, as a stop while
   * ranking is, so the note under the button is a warning and no pass follows.
   */
  if (stopped) return { ok: false, error: `${CHAT_IMPORTS[importKind].label}, ${record.fileName}: ${importDisclosure(record, caps)}` }
  // Said, not hidden: a file cut short is the likeliest reason for fewer conversations than expected.
  const warning = complete
    ? null
    : `The file ends early — the ${CHAT_IMPORTS[importKind].label} may not have finished downloading — so only the conversations before the cut were read.`
  return { ok: true, record, warning }
}
