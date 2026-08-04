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
  MAX_TITLE_CHARS,
  SCAN_DISALLOWED_TOOLS,
  WRITE_ORDER,
  WorklogParseError,
  applyRunOptions,
  buildApplyPrompt,
  buildScanPrompt,
  groundProposals,
  parseProposals,
  parseWrittenUrl,
  scanRunOptions,
  summariseTurns,
  tidyTitle
} from '../src/main/worklog/runner.ts'
import { MAX_RECALL_CHARS, formatRecall, type RecallSnapshot } from '../src/main/worklog/recall.ts'
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

/*
 * The single letters below come back capitalised because every parsed title now
 * goes through tidyTitle. That is the point of it, so these assert the tidied
 * form rather than the raw one - the shapes being tested here are the JSON, not
 * the wording.
 */
check(
  'prose either side of the JSON parses',
  parseProposals(
    'I reviewed the session and produced two entries: [{"title":"a","body":"","targets":["notion"]},{"title":"b","body":"","targets":["clickup"]}] — let me know if you want more.'
  ).map((p) => p.title),
  ['A', 'B']
)

check(
  'a bracket in the prose does not steal the parse',
  parseProposals('I found [3] things worth logging: [{"title":"a"},{"title":"b"},{"title":"c"}]').map(
    (p) => p.title
  ),
  ['A', 'B', 'C']
)

check(
  'a {"proposals": [...]} wrapper parses',
  parseProposals('{"proposals":[{"title":"a","body":"x","targets":["clickup"]}]}').map((p) => p.title),
  ['A']
)

check(
  'a lone object is treated as one proposal',
  parseProposals('{"title":"a","body":"x","targets":["notion"]}').map((p) => p.title),
  ['A']
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
check(
  'JSON holding a url',
  parseWrittenUrl('{"url":"https://app.clickup.com/t/abc"}', 'clickup'),
  'https://app.clickup.com/t/abc'
)
check(
  'a fenced url',
  parseWrittenUrl('```json\n{"url":"https://www.notion.so/page-1"}\n```', 'notion'),
  'https://www.notion.so/page-1'
)
check(
  'a url mentioned in prose',
  parseWrittenUrl('Created the task: https://app.clickup.com/t/xyz.', 'clickup'),
  'https://app.clickup.com/t/xyz'
)
check('no url at all is null, not a guess', parseWrittenUrl('Done.', 'clickup'), null)
check(
  'a non-http url is not accepted from JSON',
  parseWrittenUrl('{"url":"clickup://t/abc"}', 'clickup'),
  null
)
/*
 * The reply routinely mentions links that are not the record: a doc it read, an
 * example. Accepting one marks the item written and files a dead link the user
 * only discovers by clicking it.
 */
check(
  'an unrelated link is not mistaken for the record',
  parseWrittenUrl('Created it. See https://example.com/docs for background.', 'clickup'),
  null
)
check(
  'the other destination\'s link is not accepted either',
  parseWrittenUrl('https://www.notion.so/page-1', 'clickup'),
  null
)

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

/* ------------------------------------------------------------------ titles */

/*
 * The user's ask, verbatim: titles should read like "Added [Feature]" or
 * "Fixed [Bug]" - plain enough for someone who was not there, specific enough to
 * be worth reading. Prompt wording moves the average; these are the cases it
 * does not catch, and the title is the only part of a proposal the user reads
 * before deciding.
 */
console.log('\ntitles are plain English, whatever the model sends')

check('a conventional-commit prefix is stripped', tidyTitle('feat: add ssh sessions'), 'Add ssh sessions')
check(
  'so is a scoped one, including the breaking-change bang',
  tidyTitle('fix(worklog)!: dedupe key collision'),
  'Dedupe key collision'
)
check('bold markers go', tidyTitle('**Added SSH sessions**'), 'Added SSH sessions')
check('so do backticks', tidyTitle('Fixed `contextLimitFor`'), 'Fixed contextLimitFor')
check('a heading marker goes', tidyTitle('## Added the worklog panel'), 'Added the worklog panel')
check('a bullet marker goes', tidyTitle('- Added the worklog panel'), 'Added the worklog panel')
check('a trailing full stop goes', tidyTitle('Added the worklog panel.'), 'Added the worklog panel')
check('surrounding quotes go', tidyTitle('"Added the worklog panel"'), 'Added the worklog panel')
check('newlines collapse', tidyTitle('Added the\n  worklog panel'), 'Added the worklog panel')
check('the first letter is raised', tidyTitle('added the worklog panel'), 'Added the worklog panel')
check('a markdown-wrapped commit prefix is still caught', tidyTitle('**fix:** the meter'), 'The meter')
check('an empty title stays empty', tidyTitle('   '), '')

const longSource = 'Added SSH sessions to the launcher and wired the host picker into settings as well'
const longTitle = tidyTitle(longSource)
ok(
  'a long title is cut to the cap',
  longTitle.length <= MAX_TITLE_CHARS + 1,
  `${longTitle.length} chars: ${longTitle}`
)
/*
 * A word-boundary cut, checked against the source rather than by pattern: the
 * kept text must be a prefix of the original AND the very next character must be
 * the space it was cut at. A title chopped mid-word reads as a bug in Stoke, and
 * it is the first thing the user sees.
 */
const kept = longTitle.slice(0, -1)
ok(
  'and cut at a word boundary, not mid-word',
  longSource.startsWith(kept) && longSource[kept.length] === ' ',
  `kept "${kept}", next char ${JSON.stringify(longSource[kept.length])}`
)
ok('and says it was cut', longTitle.endsWith('…'), longTitle)

/* ------------------------------------------------------ create, or update */

console.log('\nan update names one board and one record')

const updateReply =
  '[{"kind":"update","target":"clickup","id":"abc123","status":"complete","title":"finished the ssh work","body":"done"},' +
  ' {"kind":"create","title":"Cover the 1M tier","body":"x","targets":["clickup"]}]'
const parsedUpdate = parseProposals(updateReply)

check('the kind survives', parsedUpdate[0].kind, 'update')
check('so does the board', parsedUpdate[0].target, 'clickup')
check('and the id', parsedUpdate[0].existingId, 'abc123')
check('and the status', parsedUpdate[0].newStatus, 'complete')
check(
  'an update targets only the board holding the record',
  parsedUpdate[0].targets,
  ['clickup']
)
check('a create alongside it is still a create', parsedUpdate[1].kind, 'create')

check(
  'an update with no id is read as a create, because it addresses nothing',
  parseProposals('[{"kind":"update","target":"clickup","title":"a","body":"b"}]')[0].kind,
  'create'
)
check(
  'and so is one with no board',
  parseProposals('[{"kind":"update","id":"abc","title":"a","body":"b"}]')[0].kind,
  'create'
)

/* ------------------------------------------------- grounding against recall */

/*
 * The point where a model's claim about somebody else's workspace stops being
 * taken on trust. Both checks exist because the alternative is a write that
 * fails at ClickUp's API with an error the user can do nothing about.
 */
console.log('\nupdates are checked against what the boards actually hold')

const snapshot: RecallSnapshot = {
  readAt: 1_000,
  items: {
    clickup: [
      { id: 'abc123', title: 'Ship SSH sessions', status: 'in progress', url: 'https://app.clickup.com/t/abc123' },
      { id: 'def456', title: 'Theme editor', status: 'open' }
    ],
    notion: [{ id: 'n-1', title: 'Week of 4 August', status: 'Draft' }]
  },
  /*
   * The closed state is here and on no task, which is exactly the point. Recall
   * lists *open* records, so a vocabulary inferred from them could never contain
   * "complete" - and the agent could read a board but never finish anything on
   * it. It is read off the list itself for that reason.
   */
  statuses: { clickup: ['open', 'in progress', 'complete'], notion: ['Draft', 'Published'] }
}
const where = { sessionId: 's1', cwd: 'G:\\Code\\personal\\Stoke', group: 'personal' }

const grounded = groundProposals(
  [
    { kind: 'update', target: 'clickup', existingId: 'abc123', newStatus: 'complete', title: 'A', body: '', targets: ['clickup'] },
    { kind: 'update', target: 'clickup', existingId: 'nope999', title: 'B', body: '', targets: ['clickup'] },
    { kind: 'update', target: 'clickup', existingId: 'def456', newStatus: 'Done', title: 'C', body: '', targets: ['clickup'] },
    { kind: 'create', title: 'D', body: '', targets: ['notion'] }
  ],
  where,
  snapshot
)

check('a real id stays an update', grounded.drafts[0].kind, 'update')
check('and carries the record it changes', grounded.drafts[0].existing?.clickup?.id, 'abc123')
check(
  'a status the board actually uses is kept',
  grounded.drafts[0].newStatus?.clickup,
  'complete'
)
check('an id nobody has seen is filed as a create instead', grounded.drafts[1].kind, 'create')
check('and it is counted, not swallowed', grounded.demoted, 1)
check('an invented status is dropped', grounded.drafts[2].newStatus, undefined)
check('but the update itself survives as a note', grounded.drafts[2].kind, 'update')
check('a create is left alone', grounded.drafts[3].kind, 'create')
check('a manual scan does not mark anything auto', grounded.drafts[0].auto, undefined)
check(
  'an automatic scan marks every draft',
  groundProposals([{ kind: 'create', title: 'A', body: '', targets: ['notion'] }], { ...where, auto: true }, snapshot)
    .drafts[0].auto,
  true
)

/* ------------------------------------------------- the update write itself */

console.log('\nwriting an update touches one record and nothing else')

const updateProposal: WorklogProposal = {
  id: 'p1',
  sessionId: 's1',
  cwd: 'G:\\Code\\personal\\Stoke',
  group: 'personal',
  title: 'Finished the SSH work',
  body: 'Shipped it.',
  targets: ['clickup'],
  kind: 'update',
  existing: { clickup: { id: 'abc123', title: 'Ship SSH sessions', status: 'in progress', url: 'https://app.clickup.com/t/abc123' } },
  newStatus: { clickup: 'complete' },
  status: 'pending',
  createdAt: 0
}

const updateOpts = applyRunOptions(updateProposal, 'clickup')
check(
  'an update uses the update tools, never the create one',
  updateOpts.allowedTools,
  ['mcp__claude_ai_ClickUp__clickup_update_task', 'mcp__claude_ai_ClickUp__clickup_create_comment']
)
ok(
  'no create tool is reachable from an update run',
  !updateOpts.allowedTools?.some((t) => t.includes('create_task')),
  JSON.stringify(updateOpts.allowedTools)
)

const updatePrompt = buildApplyPrompt(updateProposal, 'clickup')
ok('the prompt names the record id', updatePrompt.includes('abc123'), updatePrompt.slice(0, 200))
ok('and the status to set', updatePrompt.includes('"complete"'), updatePrompt.slice(0, 300))
ok(
  'the note goes on as a comment, because update_task replaces the description',
  updatePrompt.includes('clickup_create_comment'),
  updatePrompt
)
ok('and it creates nothing', /Do not.*creat/i.test(updatePrompt), updatePrompt)

const noStatus = buildApplyPrompt({ ...updateProposal, newStatus: {} }, 'clickup')
ok('with no status, the prompt says leave it', /Do not change its status/.test(noStatus), noStatus)

/*
 * An update with no record to change must refuse rather than fall back to
 * creating: guessing there would file a duplicate into a live board.
 */
const orphan = buildApplyPrompt({ ...updateProposal, existing: {} }, 'clickup')
ok('an update naming no record does nothing at all', /Do nothing and change nothing/.test(orphan), orphan)
ok('and says why', orphan.includes('names no record'), orphan)

check(
  'a create still uses exactly one tool',
  applyRunOptions({ ...updateProposal, kind: 'create', existing: undefined }, 'clickup').allowedTools,
  ['mcp__claude_ai_ClickUp__clickup_create_task']
)
check(
  'and a proposal with no kind at all is treated as a create',
  applyRunOptions({ ...updateProposal, kind: undefined, existing: undefined }, 'notion').allowedTools,
  ['mcp__claude_ai_Notion__notion-create-pages']
)

/* --------------------------------------------------- recall in the prompt */

console.log('\nrecall reaches the prompt without unbounding it')

/*
 * A realistically large recall block, not a one-line fixture: the ceiling below
 * is what stops a busy board turning every scan into an expensive one, and a
 * 60-character `existing` would pass it with formatRecall's clip deleted.
 */
const bigRecall = formatRecall({
  readAt: 1,
  statuses: { clickup: ['open', 'in progress', 'complete'] },
  items: {
    clickup: Array.from({ length: 30 }, (_, i) => ({
      id: `task-${i}`,
      title: `A tracked piece of work with a realistically long title, number ${i}`,
      status: i % 2 ? 'open' : 'in progress'
    }))
  }
})
ok('the recall fixture is genuinely large', bigRecall.length > 1500, `${bigRecall.length} chars`)

const withRecall = buildScanPrompt({
  sessionId: 'abc-123',
  cwd: 'G:\\Code\\personal\\Stoke',
  group: 'personal',
  digest,
  existing: `ClickUp:\n- [clickup:abc123] Ship SSH sessions (status: in progress)\n${bigRecall}`
})
ok('the ids reach the model', withRecall.includes('clickup:abc123'), withRecall.slice(0, 400))
ok('so do the statuses', withRecall.includes('in progress'), withRecall.slice(0, 400))
ok(
  'and the whole thing stays bounded',
  withRecall.length <= MAX_DIGEST_CHARS + MAX_RECALL_CHARS + 2000,
  `prompt was ${withRecall.length} characters`
)

/*
 * The distinction that makes recall worth having. Told nothing, a model
 * reasonably assumes the boards are empty and proposes a create for everything -
 * which is the exact duplication recall was added to stop.
 */
const failedRecall = buildScanPrompt({ sessionId: 'a', cwd: 'x', group: 'g', digest, recallFailed: true })
ok(
  'a failed read is never reported as an empty board',
  failedRecall.includes('could not be read') && !failedRecall.includes('boards are empty'),
  failedRecall.slice(0, 600)
)
const emptyRecall = buildScanPrompt({ sessionId: 'a', cwd: 'x', group: 'g', digest })
ok('and an empty board is stated as one', emptyRecall.includes('boards are empty'), emptyRecall.slice(0, 600))

/* ------------------------------------------------- the queue holds updates */

console.log('\nthe queue keeps an update distinct, and keeps old ids intact')

/*
 * The regression that would be silent and awful: proposal ids are a hash of the
 * dedupe key and rejections are tombstones keyed on it, so any change to the
 * *create* key resurrects every proposal the user has ever said no to.
 */
check(
  'the create key is byte-for-byte what it was before updates existed',
  dedupeKey({ sessionId: 's1', title: 'Fix the meter' }),
  's1|fix the meter'
)
check(
  'an explicit create kind does not change it either',
  dedupeKey({ sessionId: 's1', title: 'Fix the meter', kind: 'create' }),
  's1|fix the meter'
)

const updateIdentity = {
  sessionId: 's1',
  title: 'Finished the SSH work',
  kind: 'update' as const,
  existing: { clickup: { id: 'abc123', title: 'Ship SSH sessions' } }
}
check(
  'an update is keyed on the record it changes, not its wording',
  dedupeKey(updateIdentity),
  's1|update|clickup:abc123'
)
check(
  'so rewording it does not queue a second one',
  dedupeKey({ ...updateIdentity, title: 'Wrapped up the SSH work' }),
  dedupeKey(updateIdentity)
)
ok(
  'but an update and a create never collide',
  dedupeKey(updateIdentity) !== dedupeKey({ sessionId: 's1', title: 'Finished the SSH work' })
)

const qU = new WorklogQueue(queueFile('updates'))
const addedUpdate = qU.add([
  {
    sessionId: 's1',
    cwd: 'G:\\Code\\personal\\Stoke',
    group: 'personal',
    title: 'Finished the SSH work',
    body: 'Shipped it.',
    targets: ['clickup'],
    kind: 'update',
    existing: { clickup: { id: 'abc123', title: 'Ship SSH sessions', status: 'in progress' } },
    newStatus: { clickup: 'complete' },
    auto: true
  }
])
check('one update queued', addedUpdate.length, 1)

const reloadedUpdate = new WorklogQueue(queueFile('updates')).get(addedUpdate[0].id)
check('the kind survives a reload', reloadedUpdate?.kind, 'update')
check('so does the record it changes', reloadedUpdate?.existing?.clickup?.id, 'abc123')
check('and the status move', reloadedUpdate?.newStatus?.clickup, 'complete')
check('and the fact it was found automatically', reloadedUpdate?.auto, true)

/*
 * A stored update whose record did not survive names nothing that can be
 * changed, so it must come back as the create the write path would treat it as -
 * not as an update with nowhere to go.
 */
writeFileSync(
  queueFile('broken'),
  JSON.stringify([
    {
      id: 'x1',
      sessionId: 's1',
      cwd: '',
      group: '',
      title: 'Orphaned update',
      body: '',
      targets: ['clickup'],
      kind: 'update',
      newStatus: { clickup: 'complete' },
      status: 'pending',
      createdAt: 1
    }
  ]),
  'utf8'
)
const rehydrated = new WorklogQueue(queueFile('broken')).get('x1')
check('an update with no record rehydrates as a create', rehydrated?.kind, 'create')
check('and drops the status it could not have applied', rehydrated?.newStatus, undefined)

/* --------------------------------------------- written, but with no link */

/*
 * The marker that stops Try again duplicating a live record, checked ACROSS A
 * RELOAD rather than in memory.
 *
 * `applyProposal` writes `urls[target] = ''` for "reached, no link back", and
 * the retry guard keys off the *presence* of that entry. A reload used to drop
 * it for being falsy, so the marker survived until the next restart and no
 * longer — and the first Try again after a restart created a second real
 * ClickUp task. Testing it in memory passed the whole time.
 */
console.log('\na destination reached without a link stays reached after a restart')

const noLinkFile = queueFile('nolink')
const qL = new WorklogQueue(noLinkFile)
const half = qL.add([draft({ title: 'Wrote it, got no link back' })])[0]
qL.update(half.id, { status: 'failed', urls: { clickup: '', notion: 'https://www.notion.so/x' } })

const afterReload = new WorklogQueue(noLinkFile).get(half.id)
check('the empty marker survives the reload', afterReload?.urls?.clickup, '')
check('and so does the real link beside it', afterReload?.urls?.notion, 'https://www.notion.so/x')
ok(
  'so the retry guard still sees ClickUp as reached',
  afterReload?.urls?.clickup !== undefined,
  JSON.stringify(afterReload?.urls)
)

/* ------------------------------------------------- a rejection is a rejection */

/*
 * An update and a create are keyed differently on purpose, which leaves a hole:
 * reject an update, let recall fail on the next scan, and the same sentence
 * comes back as a create under a different key. The user said no once.
 */
console.log('\nsaying no to an update also says no to the same work as a create')

const crossFile = queueFile('cross')
const qX = new WorklogQueue(crossFile)
const asUpdate = qX.add([
  {
    ...draft({ title: 'Finished the SSH work' }),
    kind: 'update',
    targets: ['clickup'],
    existing: { clickup: { id: 'abc123', title: 'Ship SSH sessions' } }
  }
])[0]
qX.reject(asUpdate.id)

check(
  'the same work proposed as a create is refused',
  qX.add([draft({ title: 'Finished the SSH work' })]).length,
  0
)
check('and still refused after a reload', new WorklogQueue(crossFile).add([draft({ title: 'Finished the SSH work' })]).length, 0)
check(
  'but genuinely different work is not',
  qX.add([draft({ title: 'Started the theme editor' })]).length,
  1
)

/*
 * Only *rejections* cross-block. A pending create must not swallow an update
 * that says the same thing, because the update is the better-informed of the
 * two and losing it would be a silent downgrade.
 */
const qP = new WorklogQueue(queueFile('pending-cross'))
qP.add([draft({ title: 'Finished the SSH work' })])
check(
  'a merely pending create does not block the update',
  qP.add([
    {
      ...draft({ title: 'Finished the SSH work' }),
      kind: 'update',
      targets: ['clickup'],
      existing: { clickup: { id: 'abc123', title: 'Ship SSH sessions' } }
    }
  ]).length,
  1
)

rmSync(dir, { recursive: true, force: true })

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
