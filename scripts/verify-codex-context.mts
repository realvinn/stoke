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
  watcher.unwatch('one')
  watcher.watch({ sessionId: 'resumed', home, cwd: '/different', startedAt: now + 60_000, resumeId: id })
  await until(() => snapshots.get('resumed')?.contextTokens === 5000)
  watcher.watch({ sessionId: 'ambiguous', home: other, cwd, startedAt: now })
  await new Promise(r => setTimeout(r, 150))
  assert.equal(snapshots.get('ambiguous')?.ready, false, 'overlapping same-account launches cannot steal the existing rollout')
  await writeFile(file, line('session_meta', { id, cwd, timestamp: new Date(now).toISOString(), source: 'cli' }) + line('turn_context', { model: 'new-model' }) + count(3000))
  watcher.refresh('resumed')
  await until(() => snapshots.get('resumed')?.model === 'new-model' && snapshots.get('resumed')?.contextTokens === 3000)
  assert.equal(await readFile(bystander, 'utf8'), 'keep')
  console.log('PASS Codex context: native last-response tokens, model changes, compaction, partial appends, resume, account isolation and ambiguous launch refusal')
} finally { watcher.disposeAll(); await rm(root, { recursive: true, force: true }) }
