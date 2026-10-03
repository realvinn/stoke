/**
 * The chat index's worker thread: the store's only writer, and the only place
 * any chat source is read. Built as its own bundle (`?modulePath` in
 * index.ts), started lazily by `ChatIndexHost`, and never on the main thread:
 * a pass reads hundreds of megabytes and parses JSON the whole time, and on the
 * main thread that would be exactly the stall gotchas 40 and 103 exist for —
 * no pty byte reaching a terminal while it ran.
 *
 * A pass yields between two chats (`setImmediate`), so a search asked mid-pass
 * is answered within one chat's read rather than after the whole pass.
 */
import { parentPort, workerData } from 'node:worker_threads'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { CHAT_SOURCE_IDS, emptyChatStatus, type ChatIndexStatus, type ChatPassSummary } from '../../shared/chatIndex.ts'
import { ChatStore, skipFolders, STORE_FILE } from './store.ts'
import { runPass, STORE_MAX_TEXT_BYTES } from './scan.ts'
import { detectSource, discovery } from './sources.ts'
import { importExport } from './importer.ts'
import { openChat, openChatCleaned } from './viewer.ts'
import type { WorkerData, WorkerEvent, WorkerReply, WorkerRequest } from './protocol.ts'

const port = parentPort
if (!port) throw new Error('chat-index worker started outside a worker thread')
const { dir } = workerData as WorkerData

let store: ChatStore | null = null
let running: Promise<ChatPassSummary> | null = null
/** An import in progress: one at a time, and Delete index waits for it like a pass. */
let importing: Promise<unknown> | null = null
/*
 * Two stop flags, not one. A pass and an import each clear their own when they
 * start, and Rebuild stops only the pass: it keeps imports, so it has no reason
 * to stop one — with a shared flag it did, and a pass starting mid-import
 * cleared a stop that was meant for the import.
 */
let stopPass = false
let stopImport = false
let progress: ChatIndexStatus['progress'] = null

/** The store, opened on first need — and never CREATED just to answer a status or a search. */
function openStore(create: boolean): ChatStore | null {
  if (store) return store
  if (!create && !ChatStore.exists(dir)) return null
  store = ChatStore.open(dir)
  return store
}

function statusNow(): ChatIndexStatus {
  const state = running ? 'running' : 'idle'
  try {
    const s = openStore(false)
    return s ? s.status(state, progress) : emptyChatStatus(join(dir, STORE_FILE), state)
  } catch (err) {
    return { ...emptyChatStatus(join(dir, STORE_FILE), 'error'), error: `The index could not be opened (${(err as Error).message}).` }
  }
}

let lastEmit = 0
function emit(force = false): void {
  const now = Date.now()
  if (!force && now - lastEmit < 300) return
  lastEmit = now
  const ev: WorkerEvent = { event: 'status', status: statusNow() }
  port!.postMessage(ev)
}

function reply(id: number, value: unknown): void {
  const r: WorkerReply = { id, ok: true, value }
  port!.postMessage(r)
}

function fail(id: number, err: unknown): void {
  const r: WorkerReply = { id, ok: false, error: err instanceof Error ? err.message : String(err) }
  port!.postMessage(r)
}

/** Stop the pass and any import, and wait for both: Delete index and quit. */
async function settle(): Promise<void> {
  stopPass = true
  stopImport = true
  if (running) await running.catch(() => null)
  if (importing) await importing.catch(() => null)
}

port.on('message', async (msg: WorkerRequest) => {
  try {
    switch (msg.op) {
      case 'detect': {
        const sources = CHAT_SOURCE_IDS.map((id) => detectSource(id, msg.env, msg.subagents, discovery(Date.now())))
        reply(msg.id, { sources, at: Date.now() })
        return
      }
      case 'scan': {
        // One pass at a time; the host queues the next.
        if (running) return reply(msg.id, null)
        stopPass = false
        const s = openStore(true)!
        const pass = runPass(s, msg.plan, {
          now: Date.now,
          yieldTurn: () => new Promise((r) => setImmediate(r)),
          cancelled: () => stopPass,
          progress: (p) => {
            progress = p
            emit()
          }
        })
        running = pass
        emit(true)
        try {
          reply(msg.id, await pass)
        } finally {
          running = null
          progress = null
          emit(true)
        }
        return
      }
      case 'search': {
        const s = openStore(false)
        reply(msg.id, s ? s.search(msg.query, msg.limit, { redact: msg.redact, skip: skipFolders(msg.hidden ?? [], process.platform) }) : [])
        return
      }
      case 'status':
        reply(msg.id, statusNow())
        return
      case 'cancel':
        // Chat history switched off: nothing more is read, from a tool or a file.
        stopPass = true
        stopImport = true
        reply(msg.id, null)
        return
      case 'delete': {
        await settle()
        if (store) store.destroy()
        else rmSync(dir, { recursive: true, force: true })
        store = null
        reply(msg.id, null)
        emit(true)
        return
      }
      case 'close': {
        await settle()
        store?.close()
        store = null
        reply(msg.id, null)
        return
      }
      case 'import': {
        if (importing) return reply(msg.id, { ok: false, error: 'An import is already running.' })
        stopImport = false
        const s = openStore(true)!
        const job = importExport(s, { path: msg.path, options: msg.options, maxTextBytes: STORE_MAX_TEXT_BYTES }, {
          now: Date.now,
          yieldTurn: () => new Promise((r) => setImmediate(r)),
          cancelled: () => stopImport
        })
        importing = job
        try {
          reply(msg.id, await job)
        } finally {
          importing = null
          emit(true)
        }
        return
      }
      case 'open': {
        const s = openStore(false)
        reply(msg.id, s ? openChat(s, msg.chatId, msg.env, { redact: msg.redact, fileBytes: Math.max(64, Math.floor(msg.fileMb * 1024 * 1024)) }) : null)
        return
      }
      case 'openCleaned': {
        const s = openStore(false)
        reply(msg.id, s ? openChatCleaned(s, msg.source, msg.nativeId, msg.env, { fileBytes: Math.max(64, Math.floor(msg.fileMb * 1024 * 1024)) }) : null)
        return
      }
      case 'removeImport': {
        const s = openStore(false)
        if (s) {
          s.removeImport(msg.importId)
          s.tidy(false)
        }
        reply(msg.id, null)
        emit(true)
        return
      }
      case 'rebuild': {
        // The pass only: an import running beside it carries on, and Rebuild keeps what it writes.
        stopPass = true
        if (running) await running.catch(() => null)
        const s = openStore(false)
        if (s) {
          s.clearLocal()
          s.tidy(true)
        }
        reply(msg.id, null)
        emit(true)
        return
      }
    }
  } catch (err) {
    fail(msg.id, err)
  }
})
