import type { ContextSnapshot } from './types.ts'

const record = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
const tokens = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null
export interface CodexContextState { model: string | null; used: number | null; limit: number | null; input: number; cached: number; output: number }
export const emptyCodexContext = (): CodexContextState => ({ model: null, used: null, limit: null, input: 0, cached: 0, output: 0 })

/** Codex's status card uses last_token_usage.total_tokens; total_token_usage is cumulative billing. */
export function foldCodexContext(state: CodexContextState, line: string): void {
  if (!line.includes('"turn_context"') && !line.includes('"token_count"') && !line.includes('"compacted"')) return
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return }
  const r = record(raw), p = record(r?.payload)
  if (!r || !p) return
  if (r.type === 'compacted') { state.used = null; return }
  if (r.type === 'turn_context' && typeof p.model === 'string' && p.model.length <= 256) {
    if (state.model && state.model !== p.model) state.used = null
    state.model = p.model
  }
  if (r.type !== 'event_msg' || p.type !== 'token_count') return
  const info = record(p.info)
  // Rate-limit-only events have info:null and say nothing new about context.
  if (!info) return
  const usage = record(info.last_token_usage)
  const used = tokens(usage?.total_tokens), limit = tokens(info?.model_context_window)
  if (used === null || limit === null || limit === 0) { state.used = null; return }
  state.used = used
  state.limit = limit
  state.input = tokens(usage?.input_tokens) ?? 0
  state.cached = tokens(usage?.cached_input_tokens) ?? 0
  state.output = tokens(usage?.output_tokens) ?? 0
}

export function codexContextSnapshot(state: CodexContextState, sessionId: string, updatedAt: number): ContextSnapshot {
  return { sessionId, model: state.model, contextTokens: state.used ?? 0, contextLimit: state.limit ?? 0, inputTokens: Math.max(0, state.input - state.cached), cacheReadTokens: state.cached, cacheCreationTokens: 0, outputTokens: state.output, messageCount: 0, title: null, updatedAt, ready: state.used !== null && state.limit !== null, permissionMode: null }
}

export interface CodexRolloutMeta { id: string; cwd: string; startedAt: number; cli: boolean }
export function codexRolloutMeta(line: string): CodexRolloutMeta | null {
  let raw: unknown
  try { raw = JSON.parse(line) } catch { return null }
  const r = record(raw), p = record(r?.payload)
  if (r?.type !== 'session_meta' || !p || typeof p.id !== 'string' || typeof p.cwd !== 'string' || typeof p.timestamp !== 'string') return null
  const startedAt = Date.parse(p.timestamp)
  if (!Number.isFinite(startedAt)) return null
  return { id: p.id, cwd: p.cwd, startedAt, cli: p.source === 'cli' || p.source === 'tui' || p.originator === 'codex-tui' && !record(p.source)?.subagent }
}
