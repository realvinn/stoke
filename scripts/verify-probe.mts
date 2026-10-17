/** Probe journals must identify a CLI launch, never just a reusable PID.
 * All files and credentials below are owned fixtures; no app is launched. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseAgentRecords, readAgentRecords, selectAgentRecord } from './probe/agent-records.mjs'
import { logicalTerminalText } from './probe/terminal-text.mjs'
import headless from '@xterm/headless'

let failures = 0
function check(name: string, run: () => void): void {
  try { run(); console.log(`  PASS  ${name}`) } catch (error) { failures++; console.error(`  FAIL  ${name}\n    ${String(error)}`) }
}
const journal = (events: unknown[]): string => events.map(event => JSON.stringify(event)).join('\n') + '\n'
const start = (t: number, cwd: string, argv: string[], env: Record<string, string> = {}) => ({ kind: 'start', t, cwd, argv, env })
const folder = 'D:\\a\\_temp\\probe\\codex-api-project'
// The launch/PID combination observed on Windows x64 CI 38660058298:
// Claude's closed --continue process and the later Codex API process share 5908.
const claude = parseAgentRecords('claude-5908.jsonl', journal([
  start(1792024114586, 'D:\\a\\_temp\\probe\\project-continue', ['--continue']),
  { kind: 'exit', t: 1792024119000 }
]))
const codex = parseAgentRecords('codex-5908.jsonl', journal([
  start(1792024149494, folder, ['-m', 'openai/api-probe-edited', '-c', 'model_providers.stoke_account.wire_api="responses"', '-c', 'model_providers.stoke_account.requires_openai_auth=false'], { STOKE_ACCOUNT_API_KEY: '<set, 35 chars>' }),
  { kind: 'input', t: 1792024149500, line: 'owned message' }
]))
check('the observed cross-CLI PID reuse selects the actual Codex API launch', () => {
  const records = [...claude, ...codex]
  assert.equal(records.find(record => record.pid === 5908)?.id, 'claude', 'the old lookup would choose the closed Claude process')
  const record = selectAgentRecord(records, 'codex', 5908, folder)
  assert.equal(record?.id, 'codex')
  assert.equal(record?.start.env.STOKE_ACCOUNT_API_KEY, '<set, 35 chars>')
  assert.equal(record?.start.argv[record.start.argv.indexOf('-m') + 1], 'openai/api-probe-edited')
  assert.ok(record?.start.argv.includes('model_providers.stoke_account.wire_api="responses"'))
  assert.ok(record?.start.argv.includes('model_providers.stoke_account.requires_openai_auth=false'))
})
check('a missing CLI or wrong launch folder cannot borrow another process', () => {
  assert.equal(selectAgentRecord([...claude, ...codex], 'opencode', 5908), null)
  assert.equal(selectAgentRecord([...claude, ...codex], 'codex', 5908, 'D:\\wrong-project'), null)
  assert.equal(selectAgentRecord([...claude, ...codex], '', 5908), null)
})
check('retained Windows paths compare across separators and case', () => {
  assert.equal(selectAgentRecord(codex, 'codex', 5908, 'd:/a/_temp/probe/codex-api-project')?.key, codex[0].key)
})

const initial = [
  { kind: 'account-identity', t: 190 },
  start(200, folder, ['-m', 'old-model']),
  { kind: 'mcp', t: 210, url: 'https://example.test/old' },
  { kind: 'exit', t: 220 }
]
const reused = [
  ...initial,
  { kind: 'account-login', t: 230 }, // A one-shot reuse is not part of the closed epoch.
  start(100, folder, ['-m', 'new-model']), // Wall time can move backwards.
  { kind: 'mcp', t: 110, url: 'https://example.test/new' },
  start(100, 'D:\\a\\_temp\\probe\\other-project', ['-m', 'other-model']),
  { kind: 'input', t: 120, line: 'other epoch' }
]
const epochs = parseAgentRecords('codex-88.jsonl', journal(reused))
check('each start in an append journal becomes a separate stable epoch', () => {
  assert.equal(epochs.length, 3)
  assert.deepEqual(epochs.map(record => record.startIndex), [1, 5, 7])
  assert.equal(new Set(epochs.map(record => record.key)).size, 3)
})
check('events never cross start, exit or pre-start boundaries', () => {
  assert.deepEqual(epochs.map(record => record.events.map(event => event.kind)), [['start', 'mcp', 'exit'], ['start', 'mcp'], ['start', 'input']])
  assert.equal(epochs[1].events.find(event => event.kind === 'mcp')?.url, 'https://example.test/new')
  assert.ok(!epochs[1].events.some(event => event.kind === 'exit'))
})
check('the latest matching epoch wins even after a clock rollback', () => {
  assert.equal(selectAgentRecord(epochs, 'codex', 88, folder)?.start.argv[1], 'new-model')
  assert.equal(selectAgentRecord(epochs, 'codex', 88)?.start.argv[1], 'other-model')
})
check('epoch freshness sees reused PIDs as fresh after a relaunch', () => {
  const before = parseAgentRecords('codex-88.jsonl', journal(initial))
  const seenEpochs = new Set(before.map(record => record.key))
  const seenPids = new Set(before.map(record => record.pid))
  assert.equal(epochs.filter(record => !seenPids.has(record.pid)).length, 0, 'PID-only freshness misses the new processes')
  assert.deepEqual(epochs.filter(record => !seenEpochs.has(record.key)).map(record => record.start.argv[1]), ['new-model', 'other-model'])
})
check('a concurrently appended partial line does not corrupt a complete epoch', () => {
  const complete = journal(initial)
  assert.deepEqual(parseAgentRecords('codex-88.jsonl', complete + '{"kind":"start","cwd":'), parseAgentRecords('codex-88.jsonl', complete))
})
check('a malformed completed record remains a visible failure', () => {
  assert.throws(() => parseAgentRecords('codex-88.jsonl', '{}\n'), /Invalid probe event codex-88.jsonl:1/)
  assert.throws(() => parseAgentRecords('codex-88.jsonl', '{\n'), /Malformed probe journal codex-88.jsonl:1/)
})
const directory = mkdtempSync(join(tmpdir(), 'stoke-probe-records-'))
try {
  writeFileSync(join(directory, 'claude-5908.jsonl'), journal([start(1, folder, ['--continue'])]))
  writeFileSync(join(directory, 'codex-5908.jsonl'), journal([start(2, folder, ['-m', 'first']), { kind: 'exit' }, start(3, folder, ['-m', 'latest'])]))
  writeFileSync(join(directory, 'ignore.txt'), 'not a journal')
  check('directory discovery includes separate epochs and scopes the CLI', () => {
    assert.equal(readAgentRecords(directory).length, 3)
    assert.equal(readAgentRecords(directory, 'codex').length, 2)
    assert.equal(selectAgentRecord(readAgentRecords(directory), 'codex', 5908, folder)?.start.argv[1], 'latest')
  })
  check('relaunch selection without a known PID retains CLI and folder scope', () => {
    assert.equal(selectAgentRecord(readAgentRecords(directory), 'codex', undefined, folder)?.start.argv[1], 'latest')
  })
} finally { rmSync(directory, { recursive: true, force: true }) }

for (const cols of [16, 25, 26, 28, 32, 80]) {
  const term = new headless.Terminal({ cols, rows: 8, allowProposedApi: true })
  try {
    await new Promise<void>(resolve => term.write('before\r\nSTOKE-PROBE opencode ready pid=8392\r\nafter', resolve))
    check('native agent banners survive soft wrapping at ' + cols + ' columns', () => {
      const text = logicalTerminalText(term.buffer.active)
      assert.ok(text.includes('before\nSTOKE-PROBE opencode ready pid=8392\nafter'))
      assert.equal(/STOKE-PROBE opencode ready pid=(\d+)/.exec(text)?.[1], '8392')
      if (cols === 26) {
        const physical = Array.from({ length: term.buffer.active.length }, (_, row) => term.buffer.active.getLine(row)?.translateToString(true)).join('\n')
        assert.equal(/STOKE-PROBE opencode ready pid=(\d+)/.exec(physical), null, 'the previous physical-line parser loses this banner')
      }
    })
  } finally { term.dispose() }
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
