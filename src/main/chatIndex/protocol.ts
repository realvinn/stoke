/**
 * The chat-index worker's wire: what main asks, what the worker answers, and
 * what it pushes unasked. Types only, so both ends import it at no cost.
 */
import type {
  ChatDetection,
  ChatImportResult,
  ChatIndexOptions,
  ChatIndexStatus,
  ChatOrigin,
  ChatPassSummary,
  ChatSearchHit,
  ChatTranscript
} from '../../shared/chatIndex.ts'
import type { PassPlan } from './scan.ts'
import type { SourceEnv } from './sources.ts'

export interface WorkerData {
  /** The store's directory, `<userData>/chat-index`. */
  dir: string
}

export type WorkerRequest =
  | { id: number; op: 'detect'; env: SourceEnv; subagents: boolean }
  | { id: number; op: 'scan'; plan: PassPlan }
  /** `redact: 'force'`: only chats cleaned with the rules in force now, whatever the setting (store.ts `search`). */
  | { id: number; op: 'search'; query: string; limit: number; redact?: 'force' }
  | { id: number; op: 'status' }
  | { id: number; op: 'cancel' }
  | { id: number; op: 'delete' }
  | { id: number; op: 'close' }
  /** An account export the user handed over, read and written into the store (importer.ts). */
  | { id: number; op: 'import'; path: string; options: ChatIndexOptions }
  /** One chat for the viewer: a local one re-read from its source, an import from the store (viewer.ts). */
  | { id: number; op: 'open'; chatId: number; env: SourceEnv; redact: boolean | 'force'; fileMb: number }
  /** One chat by its tool's own id, always cleaned (viewer.ts `openChatCleaned`): what another computer opens. */
  | { id: number; op: 'openCleaned'; source: ChatOrigin; nativeId: string; env: SourceEnv; fileMb: number }
  | { id: number; op: 'removeImport'; importId: number }
  /** Every local chat and read position gone, imports kept; the next pass reads the tools again. */
  | { id: number; op: 'rebuild' }
  /** A chat's store id by its tool and the tool's own id: another computer names a chat that way, never by store id. */
  | { id: number; op: 'find'; source: string; nativeId: string }

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
  import: ChatImportResult
  open: ChatTranscript | null
  openCleaned: ChatTranscript | null
  removeImport: null
  rebuild: null
  find: number | null
}

export type WorkerReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string }

/** Pushed while a pass runs (throttled) and when one starts and ends. */
export interface WorkerEvent {
  event: 'status'
  status: ChatIndexStatus
}
