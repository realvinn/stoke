/**
 * The main process's handle on the chat-index worker. It owns nothing but a
 * Worker and a table of pending requests: every read of a chat, every write of
 * the store, every search runs in the worker (`worker.ts`), so nothing here can
 * hold the event loop — gotcha 40's rule, which the pty writes depend on.
 *
 * The worker starts on first use and stops after `IDLE_MS` with nothing to do,
 * so a machine that said "Not now" never runs one after the offer's detection,
 * and one that said yes pays for a thread only while it is indexing or being
 * searched. A pass is claimed before its first await (gotcha 20): a second ask
 * while one runs is remembered, once, and run when it ends.
 */
import { Worker } from 'node:worker_threads'
import type {
  ChatDetection,
  ChatImportResult,
  ChatIndexOptions,
  ChatIndexStatus,
  ChatPassSummary,
  ChatSearchHit,
  ChatTranscript
} from '../../shared/chatIndex.ts'
import type { PassPlan } from './scan.ts'
import type { SourceEnv } from './sources.ts'
import type { WorkerData, WorkerEvent, WorkerReply, WorkerRequest, WorkerResults } from './protocol.ts'

/** A worker with nothing pending for this long is stopped; the next ask starts another. */
const IDLE_MS = 5 * 60_000

type Op = keyof WorkerResults
type Body<K extends Op> = Omit<Extract<WorkerRequest, { op: K }>, 'id' | 'op'>

export interface ChatIndexHostOptions {
  workerPath: string
  dir: string
  /** A status the worker pushed: a pass started, moved on, or ended. */
  onStatus: (s: ChatIndexStatus) => void
  /** Anything the worker could not do, for the log. */
  onError?: (err: Error) => void
}

export class ChatIndexHost {
  private readonly opts: ChatIndexHostOptions
  private worker: Worker | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private scanning = false
  private queued: PassPlan | null = null
  private idle: ReturnType<typeof setTimeout> | null = null
  private importing = false
  /** When the last pass ended, for the focus trigger's five-minute floor. */
  lastPassAt = 0

  constructor(opts: ChatIndexHostOptions) {
    this.opts = opts
  }

  private ensure(): Worker {
    if (this.worker) return this.worker
    const data: WorkerData = { dir: this.opts.dir }
    const w = new Worker(this.opts.workerPath, {
      workerData: data,
      // Bounds the heap a hostile or enormous file could make it take.
      resourceLimits: { maxOldGenerationSizeMb: 512 }
    })
    w.on('message', (m: WorkerReply | WorkerEvent) => {
      if ('event' in m) {
        this.opts.onStatus(m.status)
        return
      }
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      if (m.ok) p.resolve(m.value)
      else p.reject(new Error(m.error))
      this.armIdle()
    })
    w.on('error', (err) => this.opts.onError?.(err))
    w.on('exit', () => {
      if (this.worker === w) this.worker = null
      for (const [, p] of this.pending) p.reject(new Error('The chat index stopped.'))
      this.pending.clear()
      this.scanning = false
    })
    this.worker = w
    return w
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    if (this.pending.size > 0 || this.scanning) return
    this.idle = setTimeout(() => {
      if (this.pending.size === 0 && !this.scanning) void this.stop()
    }, IDLE_MS)
    this.idle.unref?.()
  }

  private request<K extends Op>(op: K, body: Body<K>): Promise<WorkerResults[K]> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    const id = ++this.seq
    return new Promise<WorkerResults[K]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      try {
        this.ensure().postMessage({ ...body, id, op })
      } catch (err) {
        this.pending.delete(id)
        reject(err as Error)
      }
    })
  }

  detect(env: SourceEnv, subagents: boolean): Promise<ChatDetection> {
    return this.request('detect', { env, subagents })
  }

  status(): Promise<ChatIndexStatus> {
    return this.request('status', {})
  }

  search(query: string, limit: number): Promise<ChatSearchHit[]> {
    return this.request('search', { query, limit })
  }

  get running(): boolean {
    return this.scanning
  }

  /**
   * Run a pass. Claimed synchronously: a second call while one runs replaces
   * the queued plan (the newest settings win) and returns null at once.
   */
  scan(plan: PassPlan): Promise<ChatPassSummary | null> {
    if (this.scanning) {
      this.queued = plan
      return Promise.resolve(null)
    }
    this.scanning = true
    return this.request('scan', { plan }).finally(() => {
      this.scanning = false
      this.lastPassAt = Date.now()
      const next = this.queued
      this.queued = null
      if (next) void this.scan(next).catch((e: Error) => this.opts.onError?.(e))
      else this.armIdle()
    })
  }

  /** Stop the running pass, and any import, where they are (chat history switched off); nothing written is lost. */
  cancel(): Promise<void> {
    this.queued = null
    if (!this.worker) return Promise.resolve()
    return this.request('cancel', {}).then(() => undefined)
  }

  /**
   * Read an export into the store. Claimed synchronously (gotcha 20): a second
   * import while one runs is refused at once rather than queued — the user
   * pressed twice, or dropped two files, and one answer is the right one.
   */
  importExport(path: string, options: ChatIndexOptions): Promise<ChatImportResult> {
    if (this.importing) return Promise.resolve({ ok: false, error: 'An import is already running.' })
    this.importing = true
    return this.request('import', { path, options }).finally(() => {
      this.importing = false
    })
  }

  get importRunning(): boolean {
    return this.importing
  }

  /** One chat for the viewer: re-read from its source, or the store's copy for an import. */
  open(chatId: number, env: SourceEnv, redact: boolean, fileMb: number): Promise<ChatTranscript | null> {
    return this.request('open', { chatId, env, redact, fileMb })
  }

  removeImport(importId: number): Promise<void> {
    return this.request('removeImport', { importId }).then(() => undefined)
  }

  /**
   * Every local chat gone, imports kept; the caller starts the pass that reads
   * the tools again. Stops the running pass, never an import: that carries on.
   */
  rebuild(): Promise<void> {
    this.queued = null
    return this.request('rebuild', {}).then(() => undefined)
  }

  /** Delete the whole store: the running pass and any import are stopped first. */
  deleteIndex(): Promise<void> {
    this.queued = null
    return this.request('delete', {}).then(() => undefined)
  }

  /** Close the store and end the thread; bounded, since it runs at quit. */
  async stop(): Promise<void> {
    const w = this.worker
    if (!w) return
    this.queued = null
    await Promise.race([this.request('close', {}).catch(() => null), new Promise((r) => setTimeout(r, 1500))])
    if (this.worker === w) this.worker = null
    await w.terminate().catch(() => 0)
  }
}
