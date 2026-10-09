import { DAILY_STATES, TASK_STATES, validWorkDay } from '../../shared/workPlugin.ts'
import { notionId } from '../../shared/workNotion.ts'
import type { NotionFields, NotionPage, WorkNotionState } from '../../shared/workNotion.ts'

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const number = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const text = (v: unknown, max: number, required = false): boolean => typeof v === 'string' && v.length <= max && !/\u0000/.test(v) && (!required || !!v.trim())
function refuse(): never { throw new Error('The saved Notion journal cannot be read. Keep it for recovery; no new writes were started.') }
function fields(v: unknown): v is NotionFields {
  return record(v) && text(v.title, 240, true) && text(v.body, 16000) && text(v.status, 240, true) && text(v.identity, 100, true) && text(v.evidence, 8000) && (v.project === undefined || text(v.project, 2048)) && (v.day === undefined || validWorkDay(v.day)) && (v.taskPageId === undefined || v.taskPageId === null || !!notionId(v.taskPageId))
}
function page(v: unknown): v is NotionPage {
  if (!record(v) || !notionId(v.id) || !notionId(v.source) || !text(v.editedAt, 100, true) || !fields(v.fields) || !text(v.url, 2048, true)) return false
  try {
    const url = new URL(v.url as string)
    return url.protocol === 'https:' && !url.username && !url.password && (url.hostname === 'notion.so' || url.hostname.endsWith('.notion.so') || url.hostname.endsWith('.notion.site'))
  } catch { return false }
}

export const emptyNotionState = (): WorkNotionState => ({ schema: 1, revision: 0, config: null, links: [], operations: [] })
/** Refuse corrupt/future journals: forgetting an uncertain create can duplicate a real row. */
export function readNotionState(raw: unknown): WorkNotionState {
  if (!record(raw) || raw.schema !== 1 || !number(raw.revision) || !Array.isArray(raw.links) || raw.links.length > 10000 || !Array.isArray(raw.operations) || raw.operations.length > 200) refuse()
  if (raw.config !== null) {
    const c = raw.config
    if (!record(c) || !text(c.connectionId, 100, true) || !record(c.task) || !record(c.daily)) refuse()
    if (c.taskLabel !== undefined && !text(c.taskLabel, 1000) || c.dailyLabel !== undefined && !text(c.dailyLabel, 1000)) refuse()
    for (const map of [c.task, c.daily]) {
      if (!notionId(map.source) || !record(map.states) || !['title', 'body', 'status', 'identity', 'evidence'].every((key) => text(map[key], 100, true))) refuse()
    }
    if (!text(c.task.project, 100, true) || !text(c.daily.day, 100, true) || !text(c.daily.task, 100, true)) refuse()
    if (!TASK_STATES.every((s) => text((c.task as Record<string, Record<string, unknown>>).states[s], 240, true)) || !DAILY_STATES.every((s) => text((c.daily as Record<string, Record<string, unknown>>).states[s], 240, true))) refuse()
  }
  const linkIds = new Set<string>()
  for (const link of raw.links) {
    if (!page(link) || record(link) && link.localBase !== undefined && !fields(link.localBase) || !record(link) || !text(link.connectionId, 100, true) || !text(link.recordId, 100, true)) refuse()
    if (link.fields.identity !== link.recordId || link.localBase !== undefined && (!fields(link.localBase) || link.localBase.identity !== link.recordId)) refuse()
    const key = `${link.connectionId}:${link.recordId}`
    if (linkIds.has(key)) refuse()
    linkIds.add(key)
  }
  const operationIds = new Set<string>()
  for (const operation of raw.operations) {
    if (!record(operation) || !text(operation.id, 100, true) || operationIds.has(operation.id as string) || !text(operation.connectionId, 100, true) || !number(operation.createdAt) || !text(operation.message, 2048) || !['pending', 'partial', 'unknown', 'conflict', 'completed'].includes(operation.state as string) || !Array.isArray(operation.steps) || operation.steps.length < 1 || operation.steps.length > 2) refuse()
    operationIds.add(operation.id as string)
    const records = new Set<string>()
    for (const step of operation.steps) {
      if (!record(step) || !['task', 'daily'].includes(step.kind as string) || !text(step.recordId, 100, true) || records.has(step.recordId as string) || !number(step.revision) || !fields(step.desired) || !fields(step.local) || step.desired.identity !== step.recordId || !['pending', 'creating', 'updating', 'unknown', 'conflict', 'confirmed'].includes(step.state as string) || step.page !== null && !page(step.page) || step.base !== null && !page(step.base) || step.taskId !== undefined && step.taskId !== null && !text(step.taskId, 100, true)) refuse()
      if (step.local.identity !== step.recordId || step.page !== null && step.page.fields.identity !== step.recordId) refuse()
      if (step.base !== null && (!record(step.base) || step.base.connectionId !== operation.connectionId || step.base.recordId !== step.recordId || step.base.fields.identity !== step.recordId || step.base.localBase !== undefined && (!fields(step.base.localBase) || step.base.localBase.identity !== step.recordId))) refuse()
      records.add(step.recordId as string)
      if (step.kind === 'task' && step.desired.project === undefined || step.kind === 'daily' && !validWorkDay(step.desired.day)) refuse()
      if (step.state === 'confirmed' && step.page === null) refuse()
    }
    if (operation.state === 'completed' && operation.steps.some((s) => s.state !== 'confirmed')) refuse()
  }
  return structuredClone(raw) as unknown as WorkNotionState
}
