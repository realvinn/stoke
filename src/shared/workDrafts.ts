import type { WorkView } from './workPlugin'

export const WORK_DRAFT_BUDGET_USD = 1
export type WorkDraftKind = 'brief' | 'summary' | 'complete'
export interface WorkDraftRequest {
  kind: WorkDraftKind
  target: 'task' | 'daily'
  id: string
  revision: number
  day: string
  relatedRevision?: number
  notes: string
}
export interface WorkDraft {
  id: string
  request: WorkDraftRequest
  createdAt: number
  state: 'drafting' | 'ready' | 'accepting' | 'accepted' | 'rejected' | 'failed'
  source: { title: string; body: string; project: string; status: string; evidence: string }
  proposal: { title: string; body: string; evidence: string } | null
  costUsd: number | null
  message: string
}
export interface WorkDraftState { schema: 1; revision: number; drafts: WorkDraft[] }
export interface WorkDraftView extends WorkDraftState { running: boolean }
export type WorkDraftResult = { ok: true; view: WorkDraftView; work?: WorkView } | { ok: false; message: string }

export interface WorkSessionNotes {
  ptyId: string
  sessionId: string
  capturedAt: number
  text: string
  turns: number
  truncated: boolean
}
export type WorkSessionNotesResult = { ok: true; notes: WorkSessionNotes } | { ok: false; message: string }
