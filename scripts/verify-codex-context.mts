import { screenActivity } from '../src/shared/agentActivity.ts'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexContextWatcher } from '../src/main/codexContext.ts'
import { emptyCodexContext, foldCodexContext, codexContextSnapshot, codexRolloutMeta } from '../src/shared/codexContext.ts'
import type { ContextSnapshot } from '../src/shared/types.ts'

const line = (type: string, payload: unknown): string => JSON.stringify({ type, payload }) + '\n'
const count = (used: number, limit = 258400): string => line('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 9_000_000 }, last_token_usage: { total_tokens: used, input_tokens: used - 200, cached_input_tokens: 1000, output_tokens: 200 }, model_context_window: limit } })
const state = emptyCodexContext()
foldCodexContext(state, line('turn_context', { model: 'gpt-6.1-sol' }))
assert.equal(codexContextSnapshot(state, 't', 0).ready, false, 'a model alone cannot invent a context reading')
foldCodexContext(state, count(22000))
assert.equal(state.used, 22000, 'the lifetime total must never become the context meter')
foldCodexContext(state, line('event_msg', { type: 'token_count', info: null, rate_limits: {} }))
assert.equal(state.used, 22000, 'a quota-only update leaves the context reading intact')
foldCodexContext(state, line('compacted', {}))
assert.equal(state.used, null, 'a compaction withholds the pre-compaction reading until new usage arrives')
foldCodexContext(state, count(8000))
assert.equal(state.used, 8000, 'context can shrink after compaction')
foldCodexContext(state, line('turn_context', { model: 'gpt-6-astra' }))
assert.equal(state.used, null, 'switching models withholds the old token reading')
foldCodexContext(state, count(100, 0))
assert.equal(codexContextSnapshot(state, 't', 0).ready, false)
foldCodexContext(state, line('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 9_000_000 }, model_context_window: 258400 } }))
assert.equal(state.used, null, 'missing last-response usage has no cumulative fallback')
assert.equal(codexRolloutMeta(line('session_meta', { id: 'x', cwd: '/x', timestamp: 'bad' })), null)

assert.equal(screenActivity('✻ Thinking… (esc to interrupt)'), 'busy', 'SSH agent footer indicates active work')
assert.equal(screenActivity('Do you want to proceed?\n  1. Yes\n  2. No'), 'waiting', 'SSH permission prompt waits')
assert.equal(screenActivity('Enter to submit\nEsc to cancel\nesc to interrupt'), 'busy', 'SSH follow-up panel does not override active work')
assert.equal(screenActivity('ordinary tool output\n› ask anything'), null, 'output alone never implies thinking')
assert.equal(screenActivity('esc to interrupt\n' + 'old output\n'.repeat(20)), null, 'old scrollback cannot keep a session working')

// Lifecycle is independent of token usage and nonblocking follow-ups.
const activity = emptyCodexContext()
const event = (type: string, payload: unknown) => JSON.stringify({ timestamp: '2026-10-23T10:00:00Z', type, payload })
foldCodexContext(activity, event('event_msg', { type: 'task_started' }))
assert.equal(activity.activity?.status, 'busy')
foldCodexContext(activity, event('response_item', { type: 'function_call', name: 'request_user_input', call_id: 'async', arguments: JSON.stringify({ isBlocking: false }) }))
assert.equal(activity.activity?.status, 'busy', 'a nonblocking follow-up does not stop thinking')
foldCodexContext(activity, event('response_item', { type: 'function_call_output', call_id: 'async', output: 'pending' }))
assert.equal(activity.activity?.status, 'busy')
foldCodexContext(activity, event('response_item', { type: 'function_call', name: 'tools.request_user_input', call_id: 'question', arguments: JSON.stringify({ isBlocking: true }) }))
assert.equal(activity.activity?.status, 'waiting', 'a blocking question waits even on the active tab')
foldCodexContext(activity, event('response_item', { type: 'function_call_output', call_id: 'unrelated' }))
assert.equal(activity.activity?.status, 'waiting')
foldCodexContext(activity, event('response_item', { type: 'function_call_output', call_id: 'question' }))
assert.equal(activity.activity?.status, 'busy', 'answer resumes work')
foldCodexContext(activity, event('event_msg', { type: 'task_complete' }))
assert.equal(activity.activity?.status, 'idle')
foldCodexContext(activity, event('event_msg', { type: 'turn_started' }))
assert.equal(activity.activity?.status, 'busy', 'v2 lifecycle alias')
foldCodexContext(activity, event('event_msg', { type: 'turn_aborted' }))
assert.equal(activity.activity?.status, 'idle', 'cancelled turns stop pulsing')

const root = await mkdtemp(join(tmpdir(), 'stoke-codex-context-'))
const snapshots = new Map<string, ContextSnapshot>()
const watcher = new CodexContextWatcher(s => snapshots.set(s.sessionId, s))
const now = Date.now(), cwd = join(root, 'project'), home = join(root, 'account-one'), other = join(root, 'account-two')
const id = '00000000-0000-4000-8000-000000000001'
async function rollout(account: string, id: string, stamp: number, source: unknown = 'cli'): Promise<string> {
  const folder = join(account, 'sessions', '2026', '10', '10')
  await mkdir(folder, { recursive: true })
  const file = join(folder, `rollout-fixture-${id}.jsonl`)
  await writeFile(file, line('session_meta', { id, cwd, timestamp: new Date(stamp).toISOString(), source, originator: source === 'cli' ? 'codex-tui' : 'worker' }) + line('turn_context', { model: account === home ? 'gpt-6.1-sol' : 'other-model' }) + count(account === home ? 22000 : 43000))
  return file
}
async function until(test: () => boolean): Promise<void> {
  const end = Date.now() + 8000
  while (!test()) { assert(Date.now() < end, 'watcher did not publish the expected fixture'); await new Promise(r => setTimeout(r, 30)) }
}
try {
  const bystander = join(root, 'bystander'); await writeFile(bystander, 'keep')
  const file = await rollout(home, id, now)
  await rollout(other, id, now)
  await rollout(home, '00000000-0000-4000-8000-000000000002', now, { subagent: { parent_thread_id: id } })
  watcher.watch({ sessionId: 'one', home, cwd, startedAt: now })
  watcher.watch({ sessionId: 'two', home: other, cwd, startedAt: now })
  await until(() => snapshots.get('one')?.ready === true && snapshots.get('two')?.ready === true)
  assert.equal(snapshots.get('one')?.contextTokens, 22000)
  assert.equal(snapshots.get('one')?.agentResumeId, id, 'the native thread id is distinct from Stoke’s live key and survives for exact restore')
  assert.equal(snapshots.get('two')?.contextTokens, 43000, 'another account in the same folder stays isolated')
  const partial = count(5000)
  await appendFile(file, partial.slice(0, -3)); watcher.refresh('one')
  await new Promise(r => setTimeout(r, 150))
  assert.equal(snapshots.get('one')?.contextTokens, 22000, 'an unfinished append cannot replace a valid reading')
  await appendFile(file, partial.slice(-3)); watcher.refresh('one')
  await until(() => snapshots.get('one')?.contextTokens === 5000)
  await appendFile(file, JSON.stringify({ timestamp: new Date(now).toISOString(), type: 'event_msg', payload: { type: 'task_started' } }) + '\n')
  watcher.refresh('one')
  await until(() => snapshots.get('one')?.activity?.status === 'busy')
  watcher.unwatch('one')
  watcher.watch({ sessionId: 'resumed', home, cwd: '/different', startedAt: now + 60_000, resumeId: id })
  await until(() => snapshots.get('resumed')?.contextTokens === 5000)
  assert.equal(snapshots.get('resumed')?.activity, undefined, 'resuming an old thread never replays its old working indicator')
  watcher.watch({ sessionId: 'ambiguous', home: other, cwd, startedAt: now })
  await new Promise(r => setTimeout(r, 150))
  assert.equal(snapshots.get('ambiguous')?.ready, false, 'overlapping same-account launches cannot steal the existing rollout')
  await writeFile(file, line('session_meta', { id, cwd, timestamp: new Date(now).toISOString(), source: 'cli' }) + line('turn_context', { model: 'new-model' }) + count(3000))
  watcher.refresh('resumed')
  await until(() => snapshots.get('resumed')?.model === 'new-model' && snapshots.get('resumed')?.contextTokens === 3000)
  assert.equal(await readFile(bystander, 'utf8'), 'keep')
  console.log('PASS Codex lifecycle, blocking/nonblocking questions and stale-resume suppression; context: native last-response tokens, model changes, compaction, partial appends, resume, account isolation and ambiguous launch refusal')
} finally { watcher.disposeAll(); await rm(root, { recursive: true, force: true }) }
