/**
 * The chat-index worker's wire: what main asks, what the worker answers, and
 * what it pushes unasked. Types only, so both ends import it at no cost.
 */
import type { ChatDetection, ChatIndexStatus, ChatPassSummary, ChatSearchHit } from '../../shared/chatIndex.ts'
import type { PassPlan } from './scan.ts'
import type { SourceEnv } from './sources.ts'

export interface WorkerData {
  /** The store's directory, `<userData>/chat-index`. */
  dir: string
}

export type WorkerRequest =
  | { id: number; op: 'detect'; env: SourceEnv; subagents: boolean }
  | { id: number; op: 'scan'; plan: PassPlan }
  | { id: number; op: 'search'; query: string; limit: number }
  | { id: number; op: 'status' }
  | { id: number; op: 'cancel' }
  | { id: number; op: 'delete' }
  | { id: number; op: 'close' }

/** What each request resolves to. */
export interface WorkerResults {
  detect: ChatDetection
  /** Null when a pass was already running (the host queues one more). */
  scan: ChatPassSummary | null
  search: ChatSearchHit[]
  status: ChatIndexStatus
  cancel: null
  delete: null
  close: null
}

export type WorkerReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }

/** Pushed while a pass runs (throttled) and when one starts and ends. */
export interface WorkerEvent {
  event: 'status'
  status: ChatIndexStatus
}
