import type { StokePluginManifest } from './plugins'

export const TASK_STATES = ['Idea', 'Approved', 'Working', 'Completed'] as const
export const DAILY_STATES = ['To-Do', 'Working on', 'Completed'] as const
export type WorkTaskStatus = typeof TASK_STATES[number]
export type WorkDailyStatus = typeof DAILY_STATES[number]

export interface WorkTask {
  id: string
  revision: number
  title: string
  brief: string
  project: string
  status: WorkTaskStatus
  sessionId: string | null
  evidence: string
  /** Durable import receipt; lets a restarted connector finish its journal safely. */
  notionConfirmation?: string
  createdAt: number
  updatedAt: number
}
export interface WorkDaily {
  id: string
  revision: number
  day: string
  timezone: string
  taskId: string | null
  title: string
  status: WorkDailyStatus
  notes: string
  evidence: string
  notionConfirmation?: string
  sessionId: string | null
  createdAt: number
  updatedAt: number
}
export interface WorkState {
  schema: 1
  revision: number
  enabled: boolean
  tasks: WorkTask[]
  daily: WorkDaily[]
}
export interface WorkView extends WorkState { manifest: StokePluginManifest }
export type WorkCommand =
  | { kind: 'enable'; enabled: boolean }
  | { kind: 'idea'; title: string; brief: string; project: string }
  | { kind: 'edit'; id: string; revision: number; title: string; brief: string; project: string }
  | { kind: 'approve' | 'start'; id: string; revision: number; day: string; sessionId?: string }
  | { kind: 'complete'; id: string; revision: number; day: string; evidence: string }
  | { kind: 'plan'; id: string; revision: number; day: string }
  | { kind: 'daily'; day: string; title: string; notes: string }
  | { kind: 'daily-edit'; id: string; revision: number; status: WorkDailyStatus; notes: string; evidence: string }

export type WorkResult = { ok: true; view: WorkView } | { ok: false; message: string }

export function localWorkDay(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function validWorkDay(day: unknown): day is string {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false
  const parsed = new Date(`${day}T12:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day
}
