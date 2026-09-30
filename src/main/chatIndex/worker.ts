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
import { ChatStore, STORE_FILE } from './store.ts'
import { runPass, STORE_MAX_TEXT_BYTES } from './scan.ts'
import { detectSource, discovery } from './sources.ts'
import { importExport } from './importer.ts'
import { openChat } from './viewer.ts'
import type { WorkerData, WorkerEvent, WorkerReply, WorkerRequest } from './protocol.ts'

const port = parentPort
if (!port) throw new Error('chat-index worker started outside a worker thread')
const { dir } = workerData as WorkerData

let store: ChatStore | null = null
let running: Promise<ChatPassSummary> | null = null
let cancel = false
/** An import in progress: one at a time, and Delete index waits for it like a pass. */
let importing: Promise<unknown> | null = null
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

async function settle(): Promise<void> {
  cancel = true
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
        cancel = false
        const s = openStore(true)!
        const pass = runPass(s, msg.plan, {
          now: Date.now,
          yieldTurn: () => new Promise((r) => setImmediate(r)),
          cancelled: () => cancel,
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
        reply(msg.id, s ? s.search(msg.query, msg.limit) : [])
        return
      }
      case 'status':
        reply(msg.id, statusNow())
        return
      case 'cancel':
        cancel = true
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
        cancel = false
        const s = openStore(true)!
        const job = importExport(s, { path: msg.path, options: msg.options, maxTextBytes: STORE_MAX_TEXT_BYTES }, {
          now: Date.now,
          yieldTurn: () => new Promise((r) => setImmediate(r)),
          cancelled: () => cancel
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
        await settle()
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
