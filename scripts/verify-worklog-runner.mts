/*
 * The worklog agent proposes work into the user's real task boards, so the two
 * ways it can fail quietly are both covered here.
 *
 * The first is the model's reply. A run that comes back wrapped in a code fence,
 * or with a sentence either side, must still yield proposals - and a reply that
 * cannot be read must raise, never return an empty list. "This session had
 * nothing worth logging" and "the parse failed" look identical from the panel,
 * and one of them is the feature silently dying.
 *
 * The second is the queue. Sessions get rescanned, so duplicates pile up unless
 * the dedupe key holds; a rejection that comes back is worse, because it teaches
 * the user to turn the feature off.
 *
 * Everything here is pure. No `claude` process is spawned - the probe that
 * proved headless runs work cost $0.50, and a test suite is not the place to
 * spend that.
 *
 *   node scripts/verify-worklog-runner.mts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildHeadlessArgs, DEFAULT_HEADLESS_MODEL } from '../src/main/agent.ts'
import {
  MAX_DIGEST_CHARS,
  SCAN_DISALLOWED_TOOLS,
  WRITE_ORDER,
  WorklogParseError,
  applyRunOptions,
  buildApplyPrompt,
  buildScanPrompt,
  parseProposals,
  parseWrittenUrl,
  scanRunOptions,
  summariseTurns
} from '../src/main/worklog/runner.ts'
import {
  MAX_ENTRIES,
  WorklogQueue,
  dedupeKey,
  type ProposalDraft
} from '../src/main/worklog/queue.ts'
import type { TranscriptTurn } from '../src/main/sessionFile.ts'
import type { WorklogProposal } from '../src/shared/types.ts'

let failures = 0

/** Key order is not meaning - a reloaded record rebuilds its objects. */
function canon(v: unknown): string {
  return JSON.stringify(v, (_k, val) =>
    val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]])
        )
      : val
  )
}

function check(name: string, got: unknown, want: unknown): void {
  const ok = canon(got) === canon(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got ${canon(got)}, want ${canon(want)}`))
}

function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`)
}

/** Asserts the call raises, and that it raises the parse error specifically. */
function raises(name: string, fn: () => unknown): void {
  let thrown: unknown = null
  try {
    fn()
  } catch (err) {
    thrown = err
  }
  const isParseError = thrown instanceof WorklogParseError
  if (!isParseError) failures++
  console.log(
    `  ${isParseError ? 'PASS' : 'FAIL'}  ${name}` +
      (isParseError
        ? ''
        : `\n        expected a WorklogParseError, got ${
            thrown === null ? 'no throw at all' : String(thrown)
          }`)
  )
}

const dir = mkdtempSync(join(tmpdir(), 'stoke-worklog-'))
const queueFile = (name: string): string => join(dir, `${name}.json`)

/* ------------------------------------------------------------------ replies */

console.log('\nreading proposals out of a real reply')

const three = '[{"title":"Fixed the meter","body":"b","targets":["notion"]}]'

check('a bare JSON array parses', parseProposals(three).map((p) => p.title), ['Fixed the meter'])

check(
  'a fenced reply parses',
  parseProposals('Here you go:\n```json\n' + three + '\n```\nHope that helps.').map((p) => p.title),
  ['Fixed the meter']
)

check(
  'a fence with no language tag parses',
  parseProposals('```\n' + three + '\n```').map((p) => p.title),
  ['Fixed the meter']
)

check(
  'prose either side of the JSON parses',
  parseProposals(
    'I reviewed the session and produced two entries: [{"title":"a","body":"","targets":["notion"]},{"title":"b","body":"","targets":["clickup"]}] — let me know if you want more.'
  ).map((p) => p.title),
  ['a', 'b']
)

check(
  'a bracket in the prose does not steal the parse',
  parseProposals('I found [3] things worth logging: [{"title":"a"},{"title":"b"},{"title":"c"}]').map(
    (p) => p.title
  ),
  ['a', 'b', 'c']
)

check(
  'a {"proposals": [...]} wrapper parses',
  parseProposals('{"proposals":[{"title":"a","body":"x","targets":["clickup"]}]}').map((p) => p.title),
  ['a']
)

check(
  'a lone object is treated as one proposal',
  parseProposals('{"title":"a","body":"x","targets":["notion"]}').map((p) => p.title),
  ['a']
)

check(
  'a body containing brackets and quotes survives',
  parseProposals('[{"title":"a","body":"see [1] and \\"quoted\\" text","targets":["notion"]}]')[0].body,
  'see [1] and "quoted" text'
)

console.log('\nnothing to log is not the same as a failure')

check('an empty array is an empty list, not an error', parseProposals('[]'), [])
check('an empty array inside a fence is too', parseProposals('```json\n[]\n```'), [])
check('a bare NONE is an empty list', parseProposals('NONE'), [])

raises('an empty reply raises', () => parseProposals(''))
raises('whitespace only raises', () => parseProposals('   \n  '))
raises('prose with no JSON at all raises', () => parseProposals('I could not find anything to log.'))
raises('truncated JSON raises', () => parseProposals('[{"title":"a","body":"unterminated'))
raises('an entry with no title raises', () => parseProposals('[{"body":"x","targets":["notion"]}]'))
raises('an entry that is not an object raises', () => parseProposals('[1,2,3]'))
raises('a blank title raises', () => parseProposals('[{"title":"   ","body":"x"}]'))
raises('JSON that is not proposals at all raises', () => parseProposals('{"status":"ok","count":2}'))

console.log('\ntargets')
check(
  'an unknown destination is dropped and the rest kept',
  parseProposals('[{"title":"a","targets":["notion","jira"]}]')[0].targets,
  ['notion']
)
check(
  'no usable destination falls back to both, for the user to trim',
  parseProposals('[{"title":"a","targets":["jira"]}]')[0].targets,
  ['notion', 'clickup']
)
check(
  'a missing targets field falls back to both',
  parseProposals('[{"title":"a"}]')[0].targets,
  ['notion', 'clickup']
)
check(
  'a repeated destination is only written once',
  parseProposals('[{"title":"a","targets":["clickup","clickup"]}]')[0].targets,
  ['clickup']
)

console.log('\nthe URL a write run reports')
check('JSON holding a url', parseWrittenUrl('{"url":"https://app.clickup.com/t/abc"}'), 'https://app.clickup.com/t/abc')
check(
  'a fenced url',
  parseWrittenUrl('```json\n{"url":"https://www.notion.so/page-1"}\n```'),
  'https://www.notion.so/page-1'
)
check(
  'a url mentioned in prose',
  parseWrittenUrl('Created the task: https://app.clickup.com/t/xyz.'),
  'https://app.clickup.com/t/xyz'
)
check('no url at all is null, not a guess', parseWrittenUrl('Done.'), null)
check('a non-http url is not accepted from JSON', parseWrittenUrl('{"url":"clickup://t/abc"}'), null)

/* ------------------------------------------------------------------ digest */

console.log('\nthe digest sent to the model')

const turn = (role: 'user' | 'assistant', text: string, tools: string[] = []): TranscriptTurn => ({
  role,
  text,
  tools,
  at: null
})

const long: TranscriptTurn[] = [turn('user', 'Build the worklog runner, please.')]
for (let i = 0; i < 300; i++) {
  long.push(turn('assistant', `step ${i} ${'x'.repeat(2000)}`, ['Read', 'Edit', 'Edit']))
  long.push(turn('user', `and now step ${i} ${'y'.repeat(2000)}`))
}
long.push(turn('assistant', 'Done. The queue still needs the 200 cap tested.'))

const digest = summariseTurns(long)
ok(
  `a 600-turn transcript is capped at ${MAX_DIGEST_CHARS} characters`,
  digest.length <= MAX_DIGEST_CHARS,
  `digest was ${digest.length} characters`
)
ok(
  'the raw transcript is far bigger than what is sent',
  long.reduce((n, t) => n + t.text.length, 0) > digest.length * 100,
  'the digest is not actually compressing anything'
)
ok('the opening ask survives', digest.includes('Build the worklog runner'), digest.slice(0, 200))
ok(
  'the closing turn survives',
  digest.includes('The queue still needs the 200 cap tested.'),
  digest.slice(-200)
)
ok('the elided middle is marked', /\(\d+ turns elided\)/.test(digest), digest.slice(0, 400))
ok('repeated tools are counted, not listed', digest.includes('Edit x2'), digest.slice(0, 400))
check('an empty transcript digests to nothing', summariseTurns([]), '')

const shortDigest = summariseTurns([turn('user', 'fix the meter'), turn('assistant', 'fixed it')])
check('a short session is not elided', /elided/.test(shortDigest), false)

const prompt = buildScanPrompt({
  sessionId: 'abc-123',
  cwd: 'G:\\Code\\gitea-company\\refinity',
  group: 'gitea-company',
  title: 'Worklog runner',
  digest
})
ok(
  'the scan prompt stays small',
  prompt.length <= MAX_DIGEST_CHARS + 2000,
  `prompt was ${prompt.length} characters`
)
ok('the scan prompt names the project', prompt.includes('refinity'), prompt.slice(0, 200))
ok('the scan prompt asks for JSON only', /JSON array and nothing else/.test(prompt))
ok('the scan prompt gives an empty-list escape hatch', prompt.includes('reply with exactly: []'))

/* ------------------------------------------------------- the runs are safe */

console.log('\nthe scan run is read-only and cheap by construction')

for (const tool of ['Bash', 'Edit', 'Write', 'Task', 'WebFetch', 'WebSearch']) {
  ok(`${tool} is denied to the scan`, SCAN_DISALLOWED_TOOLS.includes(tool))
}
check('ClickUp is written before Notion', WRITE_ORDER, ['clickup', 'notion'])

// The real options scanSession uses, not a copy of them: every assertion below
// is a promise about the actual run.
const scanArgs = buildHeadlessArgs(
  scanRunOptions('a prompt holding & | ^ < > which cmd.exe would eat', {})
)
ok(
  'the prompt is never an argv element',
  !scanArgs.some((a) => a.includes('cmd.exe would eat')),
  scanArgs.join(' ')
)
check('print mode with a JSON envelope', [scanArgs[0], scanArgs[1], scanArgs[2]], ['-p', '--output-format', 'json'])
check(
  'the model is pinned to sonnet',
  scanArgs[scanArgs.indexOf('--model') + 1],
  DEFAULT_HEADLESS_MODEL
)
check('sonnet really is the default', DEFAULT_HEADLESS_MODEL, 'sonnet')
ok('a hard budget cap is set', scanArgs.includes('--max-budget-usd'))
ok('agent runs are not persisted as sessions', scanArgs.includes('--no-session-persistence'))
ok('the scan loads no MCP servers', scanArgs.includes('--strict-mcp-config'))
ok('the scan loads no CLAUDE.md, skills or hooks', scanArgs.includes('--safe-mode'))
ok(
  'permissions are never bypassed',
  !scanArgs.some((a) => a.includes('dangerously') || a.includes('bypassPermissions')),
  scanArgs.join(' ')
)
check(
  'denied tools go in as one comma-joined argument',
  scanArgs[scanArgs.indexOf('--disallowedTools') + 1],
  SCAN_DISALLOWED_TOOLS.join(',')
)

ok('effort is pinned rather than inherited', scanArgs.includes('--effort'), scanArgs.join(' '))

const proposal = (over: Partial<WorklogProposal> = {}): WorklogProposal => ({
  id: 'id-1',
  sessionId: 's-1',
  cwd: 'G:\\Code\\gitea-company\\refinity',
  group: 'gitea-company',
  title: 'Fixed the meter',
  body: 'The context meter read zero on resumed sessions.',
  targets: ['notion', 'clickup'],
  status: 'pending',
  createdAt: 1,
  ...over
})

const clickupPrompt = buildApplyPrompt(proposal(), 'clickup')
const notionPrompt = buildApplyPrompt(proposal(), 'notion')
ok('the ClickUp prompt names the settled list', clickupPrompt.includes('901615258684'))
ok('the ClickUp prompt does not mention Notion', !/notion/i.test(clickupPrompt), clickupPrompt)
ok(
  'the Notion prompt names the settled data source',
  notionPrompt.includes('collection://368d3f2d-1f02-817c-b193-000b208e36bd')
)
ok('the Notion prompt does not mention ClickUp', !/clickup/i.test(notionPrompt), notionPrompt)
ok('both prompts ask for the URL back', /\{"url"/.test(clickupPrompt) && /\{"url"/.test(notionPrompt))

const writeArgs = buildHeadlessArgs(applyRunOptions(proposal(), 'clickup'))
check(
  'a write run allows exactly one tool',
  writeArgs[writeArgs.indexOf('--allowedTools') + 1],
  'mcp__claude_ai_ClickUp__clickup_create_task'
)
check(
  'and the Notion write allows only its own',
  buildHeadlessArgs(applyRunOptions(proposal(), 'notion'))[
    buildHeadlessArgs(applyRunOptions(proposal(), 'notion')).indexOf('--allowedTools') + 1
  ],
  'mcp__claude_ai_Notion__notion-create-pages'
)
ok(
  'a write run does not strip its MCP servers, or it could not write',
  !writeArgs.includes('--strict-mcp-config'),
  writeArgs.join(' ')
)
ok(
  'a write run never bypasses permissions either',
  !writeArgs.some((a) => a.includes('dangerously') || a.includes('bypassPermissions')),
  writeArgs.join(' ')
)
ok('a write run is budget-capped too', writeArgs.includes('--max-budget-usd'))

/* ------------------------------------------------------------------- queue */

console.log('\nthe queue')

const draft = (over: Partial<ProposalDraft> = {}): ProposalDraft => ({
  sessionId: 's-1',
  cwd: 'G:\\Code\\gitea-company\\refinity',
  group: 'gitea-company',
  title: 'Fixed the meter',
  body: 'body',
  targets: ['notion'],
  ...over
})

const q1 = new WorklogQueue(queueFile('dedupe'))
check('the first add lands', q1.add([draft()]).length, 1)
check('re-scanning the same session adds nothing', q1.add([draft()]).length, 0)
check('and the queue still holds one entry', q1.list().length, 1)
check(
  'a reworded title is the same proposal',
  q1.add([draft({ title: '  fixed the METER.  ' })]).length,
  0
)
check('a different title is a different proposal', q1.add([draft({ title: 'Cover the 1M tier' })]).length, 1)
check(
  'the same title in another session is its own proposal',
  q1.add([draft({ sessionId: 's-2' })]).length,
  1
)
check('the queue now holds three', q1.list().length, 3)
check('newest first', q1.list()[0].title, 'Fixed the meter')
check(
  'the dedupe key normalises punctuation and case',
  dedupeKey({ sessionId: 's-1', title: 'Fixed the Meter!' }),
  dedupeKey({ sessionId: 's-1', title: 'fixed  the  meter' })
)
check(
  'ids are stable across rescans',
  q1.list().map((p) => p.id),
  new WorklogQueue(queueFile('dedupe')).list().map((p) => p.id)
)

console.log('\na rejection is permanent')

const rejectFile = queueFile('reject')
const q2 = new WorklogQueue(rejectFile)
const [added] = q2.add([draft()])
q2.reject(added.id)
check('rejecting marks it', q2.get(added.id)?.status, 'rejected')

const reloaded = new WorklogQueue(rejectFile)
check('the rejection survives a reload', reloaded.get(added.id)?.status, 'rejected')
check('and a rescan does not bring it back', reloaded.add([draft()]).length, 0)
check('the queue still holds exactly one entry', reloaded.list().length, 1)
check('which is still rejected', reloaded.list()[0].status, 'rejected')

console.log('\naccepting, and a half-written accept')

const acceptFile = queueFile('accept')
const q3 = new WorklogQueue(acceptFile)
const [accepted] = q3.add([draft({ targets: ['notion', 'clickup'] })])
q3.accept(accepted.id)
q3.update(accepted.id, { urls: { clickup: 'https://app.clickup.com/t/abc' } })
check('the ClickUp url is stored the moment it arrives', q3.get(accepted.id)?.urls, {
  clickup: 'https://app.clickup.com/t/abc'
})
q3.update(accepted.id, { error: 'notion write failed' })
check(
  'a later failure does not wipe the url that succeeded',
  q3.get(accepted.id)?.urls?.clickup,
  'https://app.clickup.com/t/abc'
)
check('and the failure is visible', q3.get(accepted.id)?.error, 'notion write failed')
q3.update(accepted.id, { urls: { notion: 'https://www.notion.so/p' }, error: '' })
check('a retry merges rather than replaces', q3.get(accepted.id)?.urls, {
  clickup: 'https://app.clickup.com/t/abc',
  notion: 'https://www.notion.so/p'
})
check('and clears the error', q3.get(accepted.id)?.error, undefined)
check(
  'all of it survives a reload',
  new WorklogQueue(acceptFile).get(accepted.id)?.urls,
  { clickup: 'https://app.clickup.com/t/abc', notion: 'https://www.notion.so/p' }
)

console.log('\na queue file that cannot be read')

const corrupt = queueFile('corrupt')
writeFileSync(corrupt, '{"items": [ this is not json', 'utf8')
const q4 = new WorklogQueue(corrupt)
check('a corrupt file degrades to an empty queue', q4.list(), [])
check('and the queue still works afterwards', q4.add([draft()]).length, 1)
check('rewriting it repairs the file', new WorklogQueue(corrupt).list().length, 1)

check('a missing file is an empty queue', new WorklogQueue(queueFile('missing')).list(), [])

const halfBad = queueFile('half-bad')
writeFileSync(
  halfBad,
  JSON.stringify([
    { id: 'a', sessionId: 's', title: 'kept', body: 'b', targets: ['notion'], status: 'rejected', createdAt: 1 },
    { id: 'b', sessionId: 's' },
    'not a record',
    { id: 'c', sessionId: 's', title: 'also kept', status: 'nonsense', createdAt: 2 }
  ]),
  'utf8'
)
const q5 = new WorklogQueue(halfBad)
check('unreadable records are dropped, readable ones kept', q5.list().map((p) => p.title), [
  'also kept',
  'kept'
])
check('an unknown status falls back to pending', q5.get('c')?.status, 'pending')
check('a record with no targets gets both', q5.get('c')?.targets, ['notion', 'clickup'])

console.log('\nthe cap')

const capFile = queueFile('cap')
const q6 = new WorklogQueue(capFile)
q6.add(Array.from({ length: MAX_ENTRIES + 50 }, (_, i) => draft({ title: `entry ${i}` })))
check(`the queue caps at ${MAX_ENTRIES}`, q6.list().length, MAX_ENTRIES)
check('the newest entry is kept', q6.list()[0].title, `entry ${MAX_ENTRIES + 49}`)
check('the oldest is gone', q6.list().some((p) => p.title === 'entry 0'), false)
check('the cap survives a reload', new WorklogQueue(capFile).list().length, MAX_ENTRIES)

const evictFile = queueFile('evict')
const q7 = new WorklogQueue(evictFile)
const first = q7.add([draft({ title: 'written already' })])[0]
q7.accept(first.id)
const second = q7.add([draft({ title: 'said no to this' })])[0]
q7.reject(second.id)
q7.add(Array.from({ length: MAX_ENTRIES }, (_, i) => draft({ title: `filler ${i}` })))
check('an accepted entry is evicted first', q7.get(first.id), null)
check('the rejection is kept, so it cannot come back', q7.get(second.id)?.status, 'rejected')

rmSync(dir, { recursive: true, force: true })

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
