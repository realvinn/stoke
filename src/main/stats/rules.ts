import { dayKey } from '../../shared/localDay.ts'
import { isUsefulPrompt, safeParse, textOf } from '../sessionFile.ts'

export const RULES_VERSION = 1
export const LINE_HEAD_BYTES = 4096
export type Role = 'top' | 'sub' | 'wf' | 'thread' | 'subthread'
export type Counter = 'added' | 'removed' | 'edits' | 'prompts' | 'sessions' | 'replies' | 'tokUncached' | 'tokCacheRead' | 'tokCacheWrite' | 'tokOut' | 'tcUncached' | 'tcCacheRead' | 'tcCacheWrite' | 'tcOut' | 'turnMs'
export interface Booker { add(day: string, counter: Counter, n: number): void; turn(startMs: number, endMs: number): void; model(day: string, model: string, replies: number, tokOut: number): void; seen(id: string): boolean; see(id: string, day: string): void }
export interface FileState { pending: Record<string, { tool: string; added: number; removed: number }>; msgs: [id: string, booked: number][]; responses: string[]; prompted: boolean; source?: 'user' | 'subagent'; model?: string; lastSig?: string; cwd?: string; zstdComplete?: boolean; scanComplete?: boolean }
export interface FoldCtx { role: Role; countFromMs: number; timeBeforeMs: number }
export function emptyFileState(): FileState { return { pending: {}, msgs: [], responses: [], prompted: false } }
export function linesOf(text: string): number { if (!text) return 0; return text.split('\n').length - (text.endsWith('\n') ? 1 : 0) }
const lines = (text: string): string[] => text ? text.replace(/\n$/, '').split('\n') : []
export function lineDiff(oldText: string, newText: string, cap = 2000): { added: number; removed: number } {
  const old = lines(oldText), next = lines(newText)
  let start = 0, a = old.length, b = next.length
  while (start < a && start < b && old[start] === next[start]) start++
  while (a > start && b > start && old[a - 1] === next[b - 1]) { a--; b-- }
  const n = a - start, m = b - start
  if (n + m > cap) return { added: m, removed: n }
  const v = new Map<number, number>([[1, 0]])
  for (let d = 0; d <= n + m; d++) for (let k = -d; k <= d; k += 2) {
    let x = k === -d || (k !== d && (v.get(k - 1) ?? -1) < (v.get(k + 1) ?? -1)) ? (v.get(k + 1) ?? 0) : (v.get(k - 1) ?? 0) + 1
    let y = x - k
    while (x < n && y < m && old[start + x] === next[start + y]) { x++; y++ }
    v.set(k, x)
    if (x >= n && y >= m) return { added: (d + m - n) / 2, removed: (d + n - m) / 2 }
  }
  return { added: m, removed: n }
}
export function unifiedDiffCounts(diff: string): { added: number; removed: number } {
  let added = 0, removed = 0
  for (const line of diff.split('\n')) { if (line.startsWith('+') && !line.startsWith('+++')) added++; else if (line.startsWith('-') && !line.startsWith('---')) removed++ }
  return { added, removed }
}
export function patchCounts(patch: unknown): { added: number; removed: number } | null {
  if (!Array.isArray(patch)) return null
  let added = 0, removed = 0
  for (const hunk of patch) {
    if (!hunk || typeof hunk !== 'object' || !Array.isArray((hunk as { lines?: unknown }).lines)) continue
    for (const line of (hunk as { lines: unknown[] }).lines) if (typeof line === 'string') { if (line.startsWith('+')) added++; else if (line.startsWith('-')) removed++ }
  }
  return { added, removed }
}
export function wantedClaude(head: Buffer, state: FileState, role: Role): boolean {
  const text = head.toString('utf8')
  if (/^\s*\{"type"\s*:\s*"api-request/.test(text)) return false
  return /"(?:type|role)"\s*:\s*"assistant"/.test(text) || (Object.keys(state.pending).length > 0 && /"type"\s*:\s*"tool_result"/.test(text)) || (role === 'top' && (/"role"\s*:\s*"user"/.test(text) || /"(?:queued_command|turn_duration)"/.test(text)))
}
export function wantedCodex(head: Buffer): boolean { return /"(?:session_meta|turn_context|token_usage_record|token_count|item_completed|task_complete)"/.test(head.toString('utf8')) }
const obj = (x: unknown): Record<string, unknown> => x && typeof x === 'object' && !Array.isArray(x) ? x as Record<string, unknown> : {}
const str = (x: unknown): string => typeof x === 'string' ? x : ''
const num = (x: unknown): number => typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0
function stamped(line: string, ctx: FoldCtx): { r: Record<string, unknown>; ts: number; day: string } | null {
  const r = safeParse(line)
  if (!r) return null
  const ts = Date.parse(str(r.timestamp))
  return Number.isFinite(ts) && ts >= ctx.countFromMs ? { r, ts, day: dayKey(ts) } : null
}
function addTurn(day: string, ts: number, duration: number, ctx: FoldCtx, book: Booker): void {
  const start = Math.max(ctx.countFromMs, ts - duration), end = Math.min(ctx.timeBeforeMs, ts)
  if (end > start) { book.add(day, 'turnMs', end - start); book.turn(start, end) }
}
function prompt(day: string, id: string, state: FileState, book: Booker): void {
  const key = `p:${id}`
  if (!id || book.seen(key)) return
  book.add(day, 'prompts', 1); book.see(key, day)
  if (!state.prompted) { state.prompted = true; book.add(day, 'sessions', 1) }
}
export function foldClaudeLine(line: string, state: FileState, ctx: FoldCtx, book: Booker): void {
  const item = stamped(line, ctx); if (!item) return
  const { r, day, ts } = item, message = obj(r.message), content = Array.isArray(message.content) ? message.content : []
  if (typeof r.cwd === 'string' && !state.cwd) state.cwd = r.cwd
  if (r.type === 'assistant') {
    const model = str(message.model), id = str(message.id), usage = obj(message.usage)
    if (id && model !== '<synthetic>') {
      const out = num(usage.output_tokens), index = state.msgs.findIndex(([key]) => key === id), old = index < 0 ? 0 : state.msgs[index][1]
      const first = !book.seen(`m:${id}`)
      if (first) {
        book.see(`m:${id}`, day); book.add(day, 'replies', 1); book.add(day, 'tokUncached', num(usage.input_tokens)); book.add(day, 'tokCacheRead', num(usage.cache_read_input_tokens)); book.add(day, 'tokCacheWrite', num(usage.cache_creation_input_tokens)); book.model(day, model || '?', 1, out)
      } else if (index >= 0 && out > old) book.model(day, model || '?', 0, out - old)
      if (index >= 0) state.msgs.splice(index, 1)
      state.msgs.push([id, Math.max(old, out)]); state.msgs = state.msgs.slice(-16)
      if (out > old && (index >= 0 || first)) book.add(day, 'tokOut', out - old)
    }
    for (const raw of content) {
      const part = obj(raw), input = obj(part.input), id = str(part.id), tool = str(part.name)
      if (part.type !== 'tool_use' || !id || book.seen(`e:${id}`)) continue
      let result = { added: 0, removed: 0 }
      if (tool === 'Edit') result = lineDiff(str(input.old_string), str(input.new_string))
      else if (tool === 'Write') result.added = linesOf(str(input.content))
      else if (tool === 'MultiEdit' && Array.isArray(input.edits)) for (const e of input.edits) { const x = obj(e), diff = lineDiff(str(x.old_string), str(x.new_string)); result.added += diff.added; result.removed += diff.removed }
      else if (tool === 'NotebookEdit' && input.edit_mode !== 'delete') result.added = linesOf(str(input.new_source))
      else continue
      state.pending[id] = { tool, ...result }
    }
  } else if (r.type === 'user') {
    const results = content.map(obj).filter(p => p.type === 'tool_result')
    for (const result of results) {
      const id = str(result.tool_use_id), p = state.pending[id]
      if (!p || result.is_error || book.seen(`e:${id}`)) continue
      const toolResult = obj(r.toolUseResult), patch = patchCounts(toolResult.structuredPatch)
      const counts = patch && (p.tool !== 'Write' || toolResult.type === 'update') ? patch : p
      book.add(day, 'added', counts.added); book.add(day, 'removed', counts.removed); book.add(day, 'edits', 1); book.see(`e:${id}`, day); delete state.pending[id]
    }
    if (ctx.role === 'top' && !results.length && !r.isMeta && !r.isCompactSummary && !r.isVisibleInTranscriptOnly && !r.isSidechain && (!r.origin || obj(r.origin).kind === 'human')) {
      const text = textOf(message.content) ?? ''
      if (!text.startsWith('<task-notification>') && !text.startsWith('[Request interrupted') && isUsefulPrompt(text)) prompt(day, str(r.uuid), state, book)
    }
  } else if (r.type === 'attachment' && ctx.role === 'top') {
    const a = obj(r.attachment)
    if (a.type === 'queued_command' && a.commandMode === 'prompt' && (!a.origin || obj(a.origin).kind === 'human')) prompt(day, str(a.source_uuid), state, book)
  } else if (r.type === 'system' && r.subtype === 'turn_duration' && ctx.role === 'top') addTurn(day, ts, num(r.durationMs), ctx, book)
}

export function foldCodexLine(line: string, state: FileState, ctx: FoldCtx, book: Booker): void {
  // Session identity and the selected model establish context even when the
  // record predates a reset; neither contributes counters on its own.
  const contextRecord = safeParse(line)
  if (contextRecord?.type === 'session_meta') { const payload = obj(contextRecord.payload); state.source = 'subagent' in obj(payload.source) ? 'subagent' : 'user'; if (typeof payload.cwd === 'string') state.cwd = payload.cwd; return }
  if (contextRecord?.type === 'turn_context') { const payload = obj(contextRecord.payload); if (typeof payload.model === 'string') state.model = payload.model; return }
  const item = stamped(line, ctx); if (!item) return
  const { r, day, ts } = item, payload = obj(r.payload)
  if (r.type === 'token_usage_record') {
    const response = str(payload.response_id || r.response_id), u = obj(payload.usage ?? r.usage), key = `m:${response}`
    if (!response || book.seen(key)) return
    book.see(key, day)
    const cached = num(u.cached_input_tokens), write = num(u.cache_write_input_tokens), input = num(u.input_tokens), out = num(u.output_tokens)
    book.add(day, 'tokUncached', Math.max(0, input - cached - write)); book.add(day, 'tokCacheRead', cached); book.add(day, 'tokCacheWrite', write); book.add(day, 'tokOut', out); book.add(day, 'replies', 1); book.model(day, state.model ?? '?', 1, out)
    return
  }
  if (r.type !== 'event_msg') return
  if (payload.type === 'item_completed') {
    const event = obj(payload.item), id = str(event.id)
    if (!id) return
    if ((event.type === 'UserMessage' || event.type === 'user_message') && ctx.role === 'thread' && state.source !== 'subagent') prompt(day, id, state, book)
    else if ((event.type === 'FileChange' || event.type === 'file_change') && event.status === 'completed' && !book.seen(`i:${id}`)) {
      let added = 0, removed = 0
      for (const raw of Object.values(obj(event.changes))) {
        const change = obj(raw), kind = str(change.kind || change.type)
        if (kind === 'add') added += linesOf(str(change.content))
        else if (kind === 'delete') removed += linesOf(str(change.content))
        else if (kind === 'update') { const diff = unifiedDiffCounts(str(change.unified_diff)); added += diff.added; removed += diff.removed }
      }
      book.add(day, 'added', added); book.add(day, 'removed', removed); book.add(day, 'edits', 1); book.see(`i:${id}`, day)
    }
  } else if (payload.type === 'token_count') {
    const u = obj(obj(payload.info).last_token_usage), sig = JSON.stringify(u)
    if (!Object.keys(u).length || sig === state.lastSig) return
    state.lastSig = sig
    const cached = num(u.cached_input_tokens), write = num(u.cache_write_input_tokens), input = num(u.input_tokens)
    book.add(day, 'tcUncached', Math.max(0, input - cached - write)); book.add(day, 'tcCacheRead', cached); book.add(day, 'tcCacheWrite', write); book.add(day, 'tcOut', num(u.output_tokens))
  } else if (payload.type === 'task_complete' && ctx.role === 'thread' && state.source !== 'subagent') addTurn(day, ts, num(payload.duration_ms), ctx, book)
}
