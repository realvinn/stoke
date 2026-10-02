/**
 * Main's handle on Find in a conversation's worker (`transcriptFind.worker.ts`).
 *
 * It owns a Worker and the requests waiting on it, and one rule: every search
 * answers within `budgetMs`. A user's regex can backtrack without end, and a
 * thread stuck in `RegExp.exec` cannot be interrupted — only terminated — so a
 * search past its budget ends the worker, answers `timeout`, and the next
 * search starts a fresh one. The worker also stops after `idleMs` with nothing
 * to do, so a bar opened once costs a thread for a minute, not for the session.
 */
import { Worker } from 'node:worker_threads'
import type { FindAnswer, FindOptions } from '../shared/transcriptFind.ts'

export type FindWorkerSource = { kind: 'file'; file: string } | { kind: 'text'; key: string; text: string }

export interface FindWorkerRequest extends FindOptions {
  id: number
  query: string
  includeTools: boolean
  source: FindWorkerSource
}

export type FindWorkerValue = FindAnswer & { partial: boolean }

export type FindWorkerReply = { id: number; ok: true; value: FindWorkerValue } | { id: number; ok: false; error: string }

export type FindHostAnswer =
  | { ok: true; value: FindWorkerValue }
  | { ok: false; timeout: boolean; error: string }

export interface TranscriptFindHostOptions {
  workerPath: string
  /** How long one search may run before the worker is ended. */
  budgetMs?: number
  idleMs?: number
  /** Builds the thread; a test hands in its own. */
  spawn?: (path: string) => Worker
}

const BUDGET_MS = 2_000
const IDLE_MS = 60_000

export class TranscriptFindHost {
  private readonly opts: TranscriptFindHostOptions
  private worker: Worker | null = null
  private seq = 0
  private pending = new Map<number, { resolve: (a: FindHostAnswer) => void; timer: ReturnType<typeof setTimeout> }>()
  private idle: ReturnType<typeof setTimeout> | null = null

  constructor(opts: TranscriptFindHostOptions) {
    this.opts = opts
  }

  private ensure(): Worker {
    if (this.worker) return this.worker
    const w = this.opts.spawn
      ? this.opts.spawn(this.opts.workerPath)
      : new Worker(this.opts.workerPath, { resourceLimits: { maxOldGenerationSizeMb: 512 } })
    w.on('message', (m: FindWorkerReply) => {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      clearTimeout(p.timer)
      p.resolve(m.ok ? { ok: true, value: m.value } : { ok: false, timeout: false, error: m.error })
      this.armIdle()
    })
    w.on('error', () => this.end(w, 'The search stopped.'))
    w.on('exit', () => this.end(w, 'The search stopped.'))
    this.worker = w
    return w
  }

  /** Answer everything still waiting on `w` and forget it. */
  private end(w: Worker, error: string, timeout = false): void {
    if (this.worker !== w) return
    this.worker = null
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.resolve({ ok: false, timeout, error })
    }
    this.pending.clear()
  }

  private armIdle(): void {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    if (this.pending.size > 0) return
    this.idle = setTimeout(() => {
      if (this.pending.size === 0) void this.stop()
    }, this.opts.idleMs ?? IDLE_MS)
    this.idle.unref?.()
  }

  find(req: Omit<FindWorkerRequest, 'id'>): Promise<FindHostAnswer> {
    if (this.idle) clearTimeout(this.idle)
    this.idle = null
    const id = ++this.seq
    return new Promise<FindHostAnswer>((resolve) => {
      let w: Worker
      try {
        w = this.ensure()
      } catch (err) {
        resolve({ ok: false, timeout: false, error: (err as Error).message })
        return
      }
      const timer = setTimeout(() => {
        // Past the budget: the thread is stuck in the pattern. Ending it is the
        // only way back, and it answers every search waiting on it.
        this.end(w, 'That pattern took too long to search with.', true)
        void w.terminate().catch(() => 0)
      }, this.opts.budgetMs ?? BUDGET_MS)
      this.pending.set(id, { resolve, timer })
      try {
        w.postMessage({ ...req, id })
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        resolve({ ok: false, timeout: false, error: (err as Error).message })
      }
    })
  }

  async stop(): Promise<void> {
    const w = this.worker
    if (!w) return
    this.end(w, 'The search stopped.')
    await w.terminate().catch(() => 0)
  }
}
