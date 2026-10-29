import './suite-tmpdir.mts'
import { emptyFileState, foldClaudeLine, foldCodexLine, lineDiff, linesOf, patchCounts, unifiedDiffCounts, wantedClaude, type Booker, type Counter } from '../src/main/stats/rules.ts'
import { StatsStore, type FileBatch, type FileRow } from '../src/main/stats/store.ts'
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { listStatsFiles, runStatsPass, type StatsPlan } from '../src/main/stats/pass.ts'
import { ChatIndexHost } from '../src/main/chatIndex/host.ts'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
let failures = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
function recorder(): { book: Booker; sums: Partial<Record<Counter, number>> } {
  const sums: Partial<Record<Counter, number>> = {}, seen = new Set<string>()
  return { sums, book: { add: (_day, key, n) => { sums[key] = (sums[key] ?? 0) + n }, turn: () => {}, model: () => {}, seen: id => seen.has(id), see: id => { seen.add(id) } } }
}
const stamp = '2026-10-28T04:00:00.000Z'
const context = { role: 'top' as const, countFromMs: 0, timeBeforeMs: Date.parse(stamp) + 1 }
const json = (record: Record<string, unknown>): string => JSON.stringify({ timestamp: stamp, ...record })
check('line counts respect trailing newlines', ['', 'a', 'a\n', 'a\nb'].map(linesOf), [0, 1, 1, 2])
check('line diff counts insertions and removals', [lineDiff('a\nb\nc', 'a\nB\nc'), lineDiff('a\nb', 'a\nb\nc'), lineDiff('a\nb', 'c\nd', 1)], [{ added: 1, removed: 1 }, { added: 1, removed: 0 }, { added: 2, removed: 2 }])
check('unified diff ignores file headers', unifiedDiffCounts('--- a/file\n+++ b/file\n-old\n+new\n+more'), { added: 2, removed: 1 })
check('structured patches count their hunk lines', patchCounts([{ lines: [' unchanged', '-old', '+new', '+more'] }]), { added: 2, removed: 1 })
const r = recorder(), state = emptyFileState()
const use = json({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'edit1', name: 'Edit', input: { old_string: 'a\nb', new_string: 'a\nB\nC' } }] } })
const result = json({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'edit1' }] } })
foldClaudeLine(use, state, context, r.book); foldClaudeLine(result, state, context, r.book); foldClaudeLine(use, state, context, r.book); foldClaudeLine(result, state, context, r.book)
check('Claude edits are counted once after their result', [r.sums.added, r.sums.removed, r.sums.edits], [2, 1, 1])
check('API request copies are not read', wantedClaude(Buffer.from('{"type":"api-request-blob","role":"assistant"'), state, 'top'), false)
const c = recorder(), codex = emptyFileState()
const change = json({ type: 'event_msg', payload: { type: 'item_completed', item: { id: 'item1', type: 'FileChange', status: 'completed', changes: { file: { kind: 'update', unified_diff: '-old\n+new\n+extra' } } } } })
foldCodexLine(change, codex, { ...context, role: 'thread' }, c.book); foldCodexLine(change, codex, { ...context, role: 'thread' }, c.book)
check('completed Codex changes are counted once', [c.sums.added, c.sums.removed, c.sums.edits], [2, 1, 1])
foldCodexLine('{not json', codex, { ...context, role: 'thread' }, c.book)
check('malformed records do not change totals', c.sums.edits, 1)
const tokens = recorder(), tokenState = emptyFileState()
for (const output of [10, 30, 52]) foldClaudeLine(json({ type: 'assistant', message: { id: 'response', model: 'model', usage: { input_tokens: 5, output_tokens: output }, content: [] } }), tokenState, context, tokens.book)
check('repeated message records add input once and output deltas', [tokens.sums.tokUncached, tokens.sums.tokOut, tokens.sums.replies], [5, 52, 1])
const counts = recorder(), countState = emptyFileState()
const countLine = json({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 20, cached_input_tokens: 5, output_tokens: 7 } } } })
foldCodexLine(countLine, countState, { ...context, role: 'thread' }, counts.book); foldCodexLine(countLine, countState, { ...context, role: 'thread' }, counts.book)
check('repeated Codex usage events are not counted twice', [counts.sums.tcUncached, counts.sums.tcCacheRead, counts.sums.tcOut], [15, 5, 7])
const store = StatsStore.open(mkdtempSync(join(tmpdir(), 'stats-index-')))
const plan = { ledger: 'example-ledger', countFromMs: 0, timeBeforeMs: 1000 }
const fresh = store.adopt(plan), storeId = store.storeId
check('store is rebuilt only when its plan changes', [fresh, store.adopt(plan), store.adopt({ ...plan, ledger: 'another-ledger' }), store.storeId !== storeId], [true, false, true, true])
const row: FileRow = { key: 'one', agent: 'claude', role: 'top', path: '/fixture', form: 'jsonl', dev: 1, ino: 1, size: 1, mtimeMs: 1, offset: 1, state: emptyFileState(), project: null, goneMs: null }
const batch: FileBatch = { counters: new Map([['2026-10-27', { added: 5, turnMs: 120_000 }]]), busy: new Map([['2026-10-27', Uint8Array.from([3])]]), models: new Map(), seen: new Map([['e:edit', '2026-10-27']]) }
store.commit(row, batch, true); store.commit(row, batch, true)
const summary = store.months('all')[0].days['2026-10-27']
check('rereading a file replaces its counters and retains its busy bitmap', [summary.added, summary.estAgentMs, summary.estBusyMs, store.seen('e:edit')], [5, 120_000, 120_000, true])
store.markGone(row.key, 2000)
check('deleted transcript keeps its recorded totals', store.months('all')[0].days['2026-10-27'].added, 5)
const cleared = store.commit(row, { counters: new Map(), busy: new Map(), models: new Map(), seen: new Map() }, true)
check('a rewritten empty transcript reports its old month for clearing', store.months(cleared), [{ month: '2026-10', days: {} }])
store.close()
const home = mkdtempSync(join(tmpdir(), 'stats-source-'))
const project = join(home, '.claude', 'projects', '-project')
mkdirSync(project, { recursive: true })
const transcript = join(project, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl')
writeFileSync(transcript, `${use}\n${result}\n`)
const passStore = StatsStore.open(join(home, 'stats'))
const passPlan: StatsPlan = { ledger: 'test-ledger', countFromMs: 0, timeBeforeMs: Date.parse(stamp) + 1, env: { home, env: {}, platform: process.platform }, codexHomes: [], reportAll: true, budgetMs: 10_000 }
const hooks = { yieldTurn: async () => {}, cancelled: () => false, now: () => Date.now() }
check('discovery finds the synthetic Claude transcript', listStatsFiles(passPlan).files.map(f => f.role), ['top'])
const first = await runStatsPass(passPlan, passStore, hooks)
check('first pass records the synthetic edit', first.months[0].days[Object.keys(first.months[0].days)[0]].added, 2)
const secondUse = use.replaceAll('edit1', 'edit2'), secondResult = result.replaceAll('edit1', 'edit2')
appendFileSync(transcript, `${secondUse}\n${secondResult}\n`)
const second = await runStatsPass(passPlan, passStore, hooks)
check('append adds only new work', second.months[0].days[Object.keys(second.months[0].days)[0]].added, 4)
writeFileSync(transcript, `${use}\n${result}\n`)
const rewritten = await runStatsPass(passPlan, passStore, hooks)
check('truncating a transcript replaces its old contribution', rewritten.months[0].days[Object.keys(rewritten.months[0].days)[0]].added, 2)
const codexDir = join(home, '.codex', 'sessions', '2026', '10', '28')
mkdirSync(codexDir, { recursive: true })
const compressed = join(codexDir, 'rollout-2026-10-28-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl.zst')
const codexMeta = json({ type: 'session_meta', payload: { cwd: join(home, 'project'), source: 'cli' } })
writeFileSync(compressed, zstdCompressSync(Buffer.from(`${codexMeta}\n${change}\n`)))
const zipped = await runStatsPass(passPlan, passStore, hooks)
check('compressed Codex transcripts are indexed', [zipped.filesPending, zipped.months[0].days[Object.keys(zipped.months[0].days)[0]].added], [0, 4])
const unchanged = await runStatsPass(passPlan, passStore, hooks)
check('unchanged compressed transcripts are not read again', unchanged.bytesRead, 0)
const interruptedHome = mkdtempSync(join(tmpdir(), 'stats-zstd-resume-'))
const interruptedDir = join(interruptedHome, '.codex', 'sessions', '2026', '10', '28')
mkdirSync(interruptedDir, { recursive: true })
writeFileSync(join(interruptedDir, 'rollout-2026-10-28-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl.zst'), zstdCompressSync(Buffer.from(`${codexMeta}\n${change}\n`)))
const interruptedStore = StatsStore.open(join(interruptedHome, 'stats'))
const interruptedPlan = { ...passPlan, env: { ...passPlan.env, home: interruptedHome }, budgetMs: 1 }
let fakeNow = 0
const paused = await runStatsPass(interruptedPlan, interruptedStore, { yieldTurn: async () => { fakeNow++ }, cancelled: () => false, now: () => fakeNow })
const resumed = await runStatsPass({ ...interruptedPlan, budgetMs: 10_000 }, interruptedStore, { yieldTurn: async () => {}, cancelled: () => false, now: () => fakeNow })
check('compressed scan resumes after a bounded pass without double counting', [paused.stoppedBy, resumed.filesPending, resumed.months[0].days[Object.keys(resumed.months[0].days)[0]].added], ['time', 0, 2])
interruptedStore.close()
const plainHome = mkdtempSync(join(tmpdir(), 'stats-jsonl-resume-'))
const plainDir = join(plainHome, '.claude', 'projects', '-project')
mkdirSync(plainDir, { recursive: true })
writeFileSync(join(plainDir, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'), `${'{}\n'.repeat(360_000)}${use}\n${result}\n`)
const plainStore = StatsStore.open(join(plainHome, 'stats'))
const plainPlan = { ...passPlan, env: { ...passPlan.env, home: plainHome }, budgetMs: 1 }
let plainClock = 0
const plainPaused = await runStatsPass(plainPlan, plainStore, { yieldTurn: async () => { plainClock++ }, cancelled: () => false, now: () => plainClock })
const plainResumed = await runStatsPass({ ...plainPlan, budgetMs: 10_000 }, plainStore, { yieldTurn: async () => {}, cancelled: () => false, now: () => plainClock })
check('a partial JSONL scan resumes even if its size is unchanged', [plainPaused.stoppedBy, plainResumed.filesPending, plainResumed.months[0].days[Object.keys(plainResumed.months[0].days)[0]].added], ['time', 0, 2])
plainStore.close()
passStore.close()
const workerHome = mkdtempSync(join(tmpdir(), 'stats-worker-'))
const host = new ChatIndexHost({ workerPath: fileURLToPath(new URL('../src/main/chatIndex/worker.ts', import.meta.url)), dir: join(workerHome, 'chat-index'), statsDir: join(workerHome, 'stats'), onStatus: () => {} })
const workerResult = await host.statsPass({ ...passPlan, budgetMs: 10_000 })
check('worker counts the synthetic transcript fixtures without creating a chat index', [workerResult?.months[0].days[Object.keys(workerResult.months[0].days)[0]].added, existsSync(join(workerHome, 'chat-index'))], [4, false])
await host.deleteIndex()
check('deleting the chat index keeps the Stats store', existsSync(join(workerHome, 'stats', 'agents.sqlite')), true)
await host.stop()
console.log(failures ? `\n${failures} failure(s)` : '\nall pass')
process.exitCode = failures ? 1 : 0
