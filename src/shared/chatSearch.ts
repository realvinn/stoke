import { isChatOrigin, type ChatOrigin } from './chatIndex.ts'

/** Last-activity dates are inclusive at the start and exclusive at the end. */
export interface ChatSearchFilters {
  afterMs?: number
  beforeMs?: number
  source?: ChatOrigin
  model?: string
  folder?: string
  /** First-to-last recorded activity, including idle time. */
  minSpanMs?: number
  maxSpanMs?: number
  /** Latest reported context snapshot, not lifetime usage or billing. */
  minContextTokens?: number
  maxContextTokens?: number
}

/** The renderer is not a trusted source of SQL parameters. Unknown fields are dropped. */
export function clampChatSearchFilters(value: unknown): ChatSearchFilters {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  const out: ChatSearchFilters = {}
  for (const key of ['afterMs', 'beforeMs', 'minSpanMs', 'maxSpanMs', 'minContextTokens', 'maxContextTokens'] as const) {
    const n = raw[key]
    if (typeof n === 'number' && Number.isSafeInteger(n) && n >= 0) out[key] = n
  }
  if (isChatOrigin(raw.source)) out.source = raw.source
  for (const key of ['model', 'folder'] as const) {
    const text = raw[key]
    if (typeof text === 'string' && text.trim()) out[key] = text.trim().slice(0, 200)
  }
  return out
}

export function hasChatSearchFilters(filters: ChatSearchFilters): boolean {
  return Object.keys(clampChatSearchFilters(filters)).length > 0
}

/** Local calendar boundaries, including DST days that are not 24 hours long. */
export function chatDateBoundary(value: string, end: boolean): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return undefined
  const [year, month, day] = match.slice(1).map(Number)
  if (year < 100) return undefined
  const date = new Date(year, month - 1, day)
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) return undefined
  if (end) date.setDate(date.getDate() + 1)
  return date.getTime()
}
