import { DAILY_STATES, TASK_STATES, validWorkDay } from '../../shared/workPlugin.ts'
import { notionId } from '../../shared/workNotion.ts'
import type { NotionDailyMap, NotionFields, NotionPage, NotionProperty, NotionSource, NotionTableMap, NotionTaskMap, WorkNotionConfig } from '../../shared/workNotion.ts'

export const NOTION_VERSION = '2026-03-11'
const ROOT = 'https://api.notion.com/v1'
const MAX_RESPONSE = 2 * 1024 * 1024
const TIMEOUT_MS = 20_000

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
function string(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value) || required && !value.trim()) throw new NotionError('Notion returned a field Stoke cannot read safely.', false)
  return value
}
function richText(value: unknown, max: number): string {
  if (!Array.isArray(value) || value.length > 100) throw new NotionError('Notion returned unreadable text.', false)
  const text = value.map((r) => {
    if (record(r) && typeof r.plain_text === 'string') return r.plain_text
    if (record(r) && record(r.text) && typeof r.text.content === 'string') return r.text.content
    throw new NotionError('Notion returned unreadable text.', false)
  }).join('')
  return string(text, max)
}
/** Split by the API's 2,000-character limit without severing UTF-16 surrogate pairs. */
export function notionText(value: string): { type: 'text'; text: { content: string } }[] {
  const chunks: { type: 'text'; text: { content: string } }[] = []
  for (let at = 0; at < value.length;) {
    let end = Math.min(at + 2000, value.length)
    if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1])) end--
    chunks.push({ type: 'text', text: { content: value.slice(at, end) } }); at = end
  }
  return chunks
}
export class NotionError extends Error {
  readonly uncertain: boolean
  readonly status: number | null
  constructor(message: string, uncertain: boolean, status: number | null = null) {
    super(message); this.name = 'NotionError'; this.uncertain = uncertain; this.status = status
  }
}
function apiMessage(status: number): string {
  if (status === 401) return 'Notion refused the token. Replace it in the Work connection settings.'
  if (status === 403 || status === 404) return 'Notion could not open this table or page. Share both tables and their related database with the connection.'
  if (status === 429) return 'Notion is rate limiting requests. Wait before retrying.'
  if (status === 400) return 'Notion refused the mapped fields. Inspect the table properties and status options again.'
  if (status === 409) return 'Notion reported a conflict. Refresh the record before retrying.'
  return `Notion returned HTTP ${status}. Check the operation before retrying.`
}

export interface NotionDeps { fetch?: typeof fetch; timeoutMs?: number }
export class NotionClient {
  private token: string
  private fetcher: typeof fetch
  private timeout: number
  constructor(token: string, deps: NotionDeps = {}) {
    if (!token || token.length > 8192 || /[\r\n\u0000]/.test(token)) throw new NotionError('Add a valid Notion integration token first.', false)
    this.token = token; this.fetcher = deps.fetch ?? fetch; this.timeout = deps.timeoutMs ?? TIMEOUT_MS
  }
  private async request(method: 'GET' | 'POST' | 'PATCH', path: string, body: unknown, external?: AbortSignal): Promise<Record<string, unknown>> {
    const controller = new AbortController()
    const stop = (): void => controller.abort()
    external?.addEventListener('abort', stop, { once: true })
    if (external?.aborted) controller.abort()
    const timer = setTimeout(stop, this.timeout)
    let sent = false
    try {
      controller.signal.throwIfAborted(); sent = true
      const response = await this.fetcher(`${ROOT}${path}`, {
        method, signal: controller.signal, redirect: 'error',
        headers: { authorization: `Bearer ${this.token}`, 'notion-version': NOTION_VERSION, accept: 'application/json', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      if (!response.ok) {
        void response.body?.cancel().catch(() => {})
        throw new NotionError(apiMessage(response.status), ![400, 401, 403, 404, 409, 429].includes(response.status), response.status)
      }
      if (!response.headers.get('content-type')?.toLowerCase().includes('application/json') || Number(response.headers.get('content-length')) > MAX_RESPONSE) {
        void response.body?.cancel().catch(() => {})
        throw new NotionError('Notion returned an unreadable or oversized answer. Check the operation before retrying.', true)
      }
      const reader = response.body?.getReader()
      if (!reader) throw new NotionError('Notion returned an empty answer. Check the operation before retrying.', true)
      const parts: Uint8Array[] = []; let count = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          count += value.byteLength
          if (count > MAX_RESPONSE) throw new NotionError('Notion returned an oversized answer. Check the operation before retrying.', true)
          parts.push(value)
        }
      } finally { void reader.cancel().catch(() => {}) }
      let value: unknown
      try { value = JSON.parse(Buffer.concat(parts).toString('utf8')) } catch { throw new NotionError('Notion returned invalid JSON. Check the operation before retrying.', true) }
      if (!record(value)) throw new NotionError('Notion returned an unreadable answer. Check the operation before retrying.', true)
      return value
    } catch (err) {
      if (err instanceof NotionError) throw err
      throw new NotionError(external?.aborted ? 'The Notion operation stopped. Check its saved result before retrying.' : 'Notion did not answer in time. Check the saved operation before retrying.', sent)
    } finally { clearTimeout(timer); external?.removeEventListener('abort', stop) }
  }
  async source(id: string, signal?: AbortSignal): Promise<NotionSource> {
    const normalized = notionId(id)
    if (!normalized) throw new NotionError('Use a Notion data source ID, rather than a page link.', false)
    const data = await this.request('GET', `/data_sources/${normalized}`, undefined, signal)
    if (data.object !== 'data_source' || notionId(data.id) !== normalized || !record(data.properties) || Object.keys(data.properties).length > 1000) throw new NotionError('Notion returned an unreadable table schema.', false)
    const properties: NotionProperty[] = []
    for (const [name, raw] of Object.entries(data.properties)) {
      if (!record(raw)) throw new NotionError('Notion returned an unreadable property schema.', false)
      const type = string(raw.type, 100, true)
      const detail = record(raw[type]) ? raw[type] as Record<string, unknown> : null
      const options = detail && Array.isArray(detail.options) ? detail.options.map((r) => record(r) ? string(r.name, 240, true) : '').filter(Boolean) : []
      if (options.length > 1000) throw new NotionError('The Notion status vocabulary is too large.', false)
      properties.push({ id: string(raw.id, 100, true), name: string(name, 240, true), type, options, relatedSource: detail ? notionId(detail.data_source_id) : null })
    }
    return { id: normalized, name: richText(data.title ?? [], 1000) || 'Untitled table', properties }
  }
  async find(map: NotionTableMap, identity: string, signal?: AbortSignal): Promise<NotionPage | null> {
    const source = notionId(map.source)
    if (!source) throw new NotionError('The Notion table ID is invalid.', false)
    const result = await this.request('POST', `/data_sources/${source}/query`, { filter: { property: map.identity, rich_text: { equals: identity } }, page_size: 2 }, signal)
    if (result.object !== 'list' || !Array.isArray(result.results) || typeof result.has_more !== 'boolean') throw new NotionError('Notion returned an unreadable lookup. Retry the lookup before creating a row.', false)
    if (record(result.request_status) && result.request_status.type !== 'complete') throw new NotionError('Notion returned an incomplete lookup. Retry the lookup before creating a row.', false)
    if (!Array.isArray(result.results) || result.has_more === true || result.results.length > 1) throw new NotionError('Several Notion rows use this Stoke ID. Resolve the duplicates before retrying.', false)
    if (result.results.length === 0) return null
    const page = parseNotionPage(result.results[0], map)
    if (page.fields.identity !== identity) throw new NotionError('Notion returned a row with another Stoke ID.', false)
    return page
  }
  async page(id: string, map: NotionTableMap, signal?: AbortSignal): Promise<NotionPage> {
    const normalized = notionId(id)
    if (!normalized) throw new NotionError('The saved Notion page ID is invalid.', false)
    const page = parseNotionPage(await this.request('GET', `/pages/${normalized}`, undefined, signal), map)
    if (page.id !== normalized) throw new NotionError('Notion returned a different page from the one requested.', false)
    return page
  }
  async create(map: NotionTableMap, fields: NotionFields, schema: NotionSource, signal?: AbortSignal): Promise<NotionPage> {
    const body = { parent: { type: 'data_source_id', data_source_id: schema.id }, properties: notionProperties(map, fields, schema) }
    const raw = await this.request('POST', '/pages', body, signal)
    try {
      const page = parseNotionPage(raw, map)
      if (page.fields.identity !== fields.identity) throw new NotionError('Notion returned a row with another Stoke ID.', true)
      return page
    } catch (err) { throw new NotionError(err instanceof Error ? err.message : 'Notion returned an unreadable created row.', true) }
  }
  async update(id: string, map: NotionTableMap, fields: NotionFields, schema: NotionSource, signal?: AbortSignal): Promise<NotionPage> {
    const normalized = notionId(id)
    if (!normalized) throw new NotionError('The saved Notion page ID is invalid.', false)
    const raw = await this.request('PATCH', `/pages/${normalized}`, { properties: notionProperties(map, fields, schema) }, signal)
    try {
      const page = parseNotionPage(raw, map)
      if (page.id !== normalized || page.fields.identity !== fields.identity) throw new NotionError('Notion returned a row with another identity.', true)
      return page
    } catch (err) { throw new NotionError(err instanceof Error ? err.message : 'Notion returned an unreadable updated row.', true) }
  }
}

function property(schema: NotionSource, id: unknown, types: readonly string[]): NotionProperty {
  const found = schema.properties.find((p) => p.id === id)
  if (!found || !types.includes(found.type)) throw new NotionError(`Choose a ${types.join(' or ')} property for each mapped field.`, false)
  return found
}
/** Status options come from the schema, including closed states absent from open rows. */
export function validateNotionMapping(raw: unknown, taskSchema: NotionSource, dailySchema: NotionSource): Omit<WorkNotionConfig, 'connectionId'> {
  if (!record(raw) || !record(raw.task) || !record(raw.daily) || !record(raw.task.states) || !record(raw.daily.states)) throw new NotionError('Map both Work tables first.', false)
  if (taskSchema.id === dailySchema.id || notionId(raw.task.source) !== taskSchema.id || notionId(raw.daily.source) !== dailySchema.id) throw new NotionError('Choose two different Notion data sources.', false)
  const table = (r: Record<string, unknown>, schema: NotionSource): NotionTableMap => {
    const result = { source: schema.id, title: property(schema, r.title, ['title']).id, body: property(schema, r.body, ['rich_text']).id, status: property(schema, r.status, ['status', 'select']).id, identity: property(schema, r.identity, ['rich_text']).id, evidence: property(schema, r.evidence, ['rich_text']).id }
    if (new Set(Object.values(result)).size !== Object.values(result).length) throw new NotionError('Give each Work field its own Notion property.', false)
    return result
  }
  const taskBase = table(raw.task, taskSchema); const dailyBase = table(raw.daily, dailySchema)
  const states = <T extends string>(r: Record<string, unknown>, all: readonly T[], schema: NotionSource, statusId: string): Record<T, string> => {
    const options = property(schema, statusId, ['status', 'select']).options
    const result = Object.fromEntries(all.map((state) => [state, string(r[state], 240, true)])) as Record<T, string>
    if (Object.values(result).some((s) => !options.includes(s as string)) || new Set(Object.values(result)).size !== all.length) throw new NotionError('Map every Work state to a distinct status from this table.', false)
    return result
  }
  const task: NotionTaskMap = { ...taskBase, project: property(taskSchema, raw.task.project, ['rich_text']).id, states: states(raw.task.states, TASK_STATES, taskSchema, taskBase.status) }
  const relation = property(dailySchema, raw.daily.task, ['relation'])
  if (relation.relatedSource !== taskSchema.id) throw new NotionError('The daily task relation must point to the selected task data source. Share both databases with the connection.', false)
  const daily: NotionDailyMap = { ...dailyBase, day: property(dailySchema, raw.daily.day, ['date']).id, task: relation.id, states: states(raw.daily.states, DAILY_STATES, dailySchema, dailyBase.status) }
  for (const map of [task, daily]) {
    const ids = Object.entries(map).filter(([key]) => key !== 'source' && key !== 'states').map(([, v]) => v)
    if (new Set(ids).size !== ids.length) throw new NotionError('Give each Work field its own Notion property.', false)
  }
  return { task, daily }
}

export function notionProperties(map: NotionTableMap, fields: NotionFields, schema: NotionSource): Record<string, unknown> {
  if (notionId(map.source) !== schema.id) throw new NotionError('The table schema changed. Inspect the connection again.', false)
  const status = property(schema, map.status, ['status', 'select'])
  if (!status.options.includes(fields.status)) throw new NotionError('That status is no longer available in Notion. Inspect the connection again.', false)
  const out: Record<string, unknown> = Object.create(null)
  property(schema, map.title, ['title']); property(schema, map.body, ['rich_text'])
  property(schema, map.identity, ['rich_text']); property(schema, map.evidence, ['rich_text'])
  out[map.title] = { title: notionText(string(fields.title, 240, true)) }
  out[map.body] = { rich_text: notionText(string(fields.body, 16000)) }
  out[map.identity] = { rich_text: notionText(string(fields.identity, 100, true)) }
  out[map.evidence] = { rich_text: notionText(string(fields.evidence, 8000)) }
  out[map.status] = { [status.type]: { name: fields.status } }
  if ('project' in map) out[property(schema, map.project, ['rich_text']).id] = { rich_text: notionText(string(fields.project ?? '', 2048)) }
  if ('day' in map) {
    if (!validWorkDay(fields.day)) throw new NotionError('Choose a valid daily date.', false)
    out[property(schema, map.day, ['date']).id] = { date: { start: fields.day } }
    const linked = fields.taskPageId ? notionId(fields.taskPageId) : null
    if (fields.taskPageId && !linked) throw new NotionError('The linked task page is invalid.', false)
    out[property(schema, (map as NotionDailyMap).task, ['relation']).id] = { relation: linked ? [{ id: linked }] : [] }
  }
  return out
}

export function parseNotionPage(raw: unknown, map: NotionTableMap): NotionPage {
  if (!record(raw) || raw.object !== 'page' || !record(raw.properties) || !record(raw.parent) || notionId(raw.parent.data_source_id) !== notionId(map.source) || raw.in_trash === true || raw.is_archived === true || raw.archived === true) throw new NotionError('The Notion row is missing, archived or belongs to a different table.', false)
  const id = notionId(raw.id)
  if (!id) throw new NotionError('Notion returned an invalid page ID.', false)
  let url: URL
  try { url = new URL(string(raw.url, 2048, true)) } catch { throw new NotionError('Notion returned an invalid page link.', false) }
  if (url.protocol !== 'https:' || !(url.hostname === 'notion.so' || url.hostname.endsWith('.notion.so') || url.hostname.endsWith('.notion.site')) || url.username || url.password) throw new NotionError('Notion returned an invalid page link.', false)
  const owned = (id: string, types: string[]): Record<string, unknown> => {
    const found = Object.values(raw.properties as Record<string, unknown>).find((p) => record(p) && p.id === id)
    if (!record(found) || !types.includes(found.type as string)) throw new NotionError('The Notion property mapping changed. Inspect the connection again.', false)
    return found
  }
  const readText = (id: string, type: string, max: number): string => richText(owned(id, [type])[type], max)
  const status = owned(map.status, ['status', 'select'])
  const selected = status[status.type as string]
  if (!record(selected)) throw new NotionError('The Notion row needs a mapped status.', false)
  const fields: NotionFields = { title: string(readText(map.title, 'title', 240), 240, true), body: readText(map.body, 'rich_text', 16000), status: string(selected.name, 240, true), identity: readText(map.identity, 'rich_text', 100), evidence: readText(map.evidence, 'rich_text', 8000) }
  if ('project' in map) fields.project = readText(string(map.project, 100, true), 'rich_text', 2048)
  if ('day' in map) {
    const date = owned(string(map.day, 100, true), ['date']).date
    if (!record(date) || !validWorkDay(date.start) || date.end != null) throw new NotionError('The daily Notion row needs one date without a time or range.', false)
    fields.day = date.start
    const relation = owned((map as NotionDailyMap).task, ['relation'])
    if (!Array.isArray(relation.relation) || relation.relation.length > 1 || relation.has_more === true) throw new NotionError('The daily Notion row must link to at most one task.', false)
    fields.taskPageId = relation.relation.length ? notionId(record(relation.relation[0]) ? relation.relation[0].id : null) : null
    if (relation.relation.length && !fields.taskPageId) throw new NotionError('The daily Notion relation is unreadable.', false)
  }
  return { id, url: url.toString(), source: notionId(map.source)!, editedAt: string(raw.last_edited_time, 100, true), fields }
}
