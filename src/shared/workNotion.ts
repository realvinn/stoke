import type { WorkDailyStatus, WorkTaskStatus } from './workPlugin'

export interface NotionProperty {
  id: string
  name: string
  type: string
  options: string[]
  relatedSource: string | null
}
export interface NotionSource {
  id: string
  name: string
  properties: NotionProperty[]
}
export interface NotionTableMap {
  source: string
  title: string
  body: string
  status: string
  identity: string
  evidence: string
}
export interface NotionTaskMap extends NotionTableMap {
  project: string
  states: Record<WorkTaskStatus, string>
}
export interface NotionDailyMap extends NotionTableMap {
  day: string
  task: string
  states: Record<WorkDailyStatus, string>
}
export interface WorkNotionConfig {
  connectionId: string
  taskLabel?: string
  dailyLabel?: string
  task: NotionTaskMap
  daily: NotionDailyMap
}
/** Only owned, mapped fields; no block content or unrelated properties. */
export interface NotionFields {
  title: string
  body: string
  status: string
  identity: string
  evidence: string
  project?: string
  day?: string
  taskPageId?: string | null
}
export interface NotionPage {
  id: string
  url: string
  source: string
  editedAt: string
  fields: NotionFields
}
export interface WorkNotionLink extends NotionPage {
  connectionId: string
  recordId: string
  localBase?: NotionFields
}
export interface WorkNotionStep {
  kind: 'task' | 'daily'
  recordId: string
  revision: number
  desired: NotionFields
  local: NotionFields
  taskId?: string | null
  base: WorkNotionLink | null
  state: 'pending' | 'creating' | 'updating' | 'unknown' | 'conflict' | 'confirmed'
  page: NotionPage | null
}
export interface WorkNotionOperation {
  id: string
  connectionId: string
  createdAt: number
  state: 'pending' | 'partial' | 'unknown' | 'conflict' | 'completed'
  message: string
  steps: WorkNotionStep[]
}
export interface WorkNotionState {
  schema: 1
  revision: number
  config: WorkNotionConfig | null
  links: WorkNotionLink[]
  operations: WorkNotionOperation[]
}
export interface WorkNotionView extends WorkNotionState { tokenPresent: boolean; running: boolean }
export type WorkNotionResult = { ok: true; view: WorkNotionView } | { ok: false; message: string; view?: WorkNotionView }
export interface WorkNotionPublishRequest {
  kind: 'task' | 'daily'
  id: string
  revision: number
  day: string
  relatedRevision?: number
  connectionId: string
}
export function notionId(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const plain = value.replace(/-/g, '')
  if (!/^[0-9a-f]{32}$/i.test(plain)) return null
  return `${plain.slice(0, 8)}-${plain.slice(8, 12)}-${plain.slice(12, 16)}-${plain.slice(16, 20)}-${plain.slice(20)}`.toLowerCase()
}

/** Concurrent edits to the same field return to review; independent edits merge. */
export function mergeNotionFields(base: NotionFields, local: NotionFields, remote: NotionFields, localBase: NotionFields = base): { fields: NotionFields; conflicts: string[] } {
  const fields = { ...remote }
  const conflicts: string[] = []
  for (const field of Object.keys(local) as (keyof NotionFields)[]) {
    const ours = local[field]; const before = base[field]; const theirs = remote[field]
    if (ours !== localBase[field]) {
      if (theirs !== before && theirs !== ours) conflicts.push(field)
      else Object.assign(fields, { [field]: ours })
    }
  }
  return { fields, conflicts }
}
