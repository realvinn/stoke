/*
 * Recall is the run that reads the user's real Notion and ClickUp boards before
 * anything is proposed, and it is the only read in the feature that touches
 * them. Three things about it can fail quietly, so all three are covered here.
 *
 * The first is the allowlist. Recall runs without `--strict-mcp-config`, because
 * it needs the user's own connectors — which puts every write tool of those same
 * servers one name away. The list has to be exact, and it has to stay exact.
 *
 * The second is the parse. A recall that comes back unreadable must degrade to
 * "could not look", never to "the boards are empty": told the boards are empty,
 * the scan proposes creating everything, which is precisely the duplication
 * recall exists to prevent.
 *
 * The third is the cache. Auto-scan can fire for two sessions in the same
 * second, and without single-flighting that is two live reads billed for one
 * answer.
 *
 * Nothing here spawns `claude`; the runner is injected.
 *
 *   node scripts/verify-worklog-recall.mts
 */
import {
  EMPTY_RECALL,
  MAX_RECALL_CHARS,
  MAX_RECALL_ITEMS,
  RECALL_TOOLS,
  findExisting,
  formatRecall,
  invalidateRecall,
  parseRecall,
  recall,
  readExisting,
  recallRunOptions,
  statusesFor
} from '../src/main/worklog/recall.ts'
import type { HeadlessOptions, HeadlessResult } from '../src/main/agent.ts'

let failures = 0

function canon(v: unknown): string {
  return JSON.stringify(v)
}

function check(name: string, got: unknown, want: unknown): void {
  const pass = canon(got) === canon(want)
  if (!pass) failures++
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass ? '' : `\n        got ${canon(got)}, want ${canon(want)}`)
  )
}

function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`)
}

type Runner = (opts: HeadlessOptions) => Promise<HeadlessResult>

/** A runner that answers with a fixed reply and counts how often it was asked. */
function stub(reply: string, isError = false): { run: Runner; calls: () => number } {
  let calls = 0
  const run: Runner = async () => {
    calls++
    return {
      text: reply,
      isError,
      subtype: null,
      costUsd: 0.01,
      durationMs: 10,
      numTurns: 1,
      sessionId: null,
      permissionDenials: [],
      raw: {}
    }
  }
  return { run, calls: () => calls }
}

const BOARDS = { clickupListId: '901615258684', notionDataSource: 'collection://abc' }

/* --------------------------------------------------------------- the run */

console.log('\nrecall reads, and can only read')

const opts = recallRunOptions(BOARDS)
check('the allowlist is exactly the read tools', opts.allowedTools, RECALL_TOOLS)
ok(
  'not one of them can create anything',
  !RECALL_TOOLS.some((t) => /create|update|delete|move|merge|comment/i.test(t)),
  RECALL_TOOLS.join(', ')
)
ok('it runs cheap, because this is a listing not a judgement', opts.effort === 'low', String(opts.effort))
ok('and under a budget ceiling', (opts.maxBudgetUsd ?? 1) <= 0.15, String(opts.maxBudgetUsd))
/*
 * Deliberately NOT strictMcp and NOT safeMode: both switch MCP servers off
 * entirely, and recall exists to talk to them. That is exactly why the allowlist
 * above has to be exact rather than a prefix.
 */
ok('MCP is left on, because it is the whole point', !opts.strictMcp && !opts.safeMode)
ok('the prompt names both destinations', opts.prompt.includes('901615258684') && opts.prompt.includes('collection://abc'))
ok('and asks for the status vocabulary, not only the statuses in use', /every status it offers/.test(opts.prompt), opts.prompt)

/* ------------------------------------------------------------ the parsing */

console.log('\nreading a reply, however it arrives')

const good =
  '{"clickup":[{"id":"abc123","title":"Ship SSH sessions","status":"in progress","url":"https://app.clickup.com/t/abc123"}],' +
  '"clickupStatuses":["open","in progress","complete"],' +
  '"notion":[{"id":"n-1","title":"Week of 4 August","status":"Draft","url":"https://www.notion.so/n-1"}]}'

const parsed = parseRecall(good, 1_000)
check('the clickup record is read', parsed.items.clickup?.[0].id, 'abc123')
check('with its status', parsed.items.clickup?.[0].status, 'in progress')
check('and its url', parsed.items.clickup?.[0].url, 'https://app.clickup.com/t/abc123')
check('the notion record too', parsed.items.notion?.[0].title, 'Week of 4 August')
check('the vocabulary survives', parsed.statuses?.clickup, ['open', 'in progress', 'complete'])
check('the read time is recorded', parsed.readAt, 1_000)
check('and nothing failed', parsed.error, undefined)

check(
  'a code fence is tolerated',
  parseRecall('```json\n' + good + '\n```', 1).items.clickup?.[0].id,
  'abc123'
)
check(
  'so is prose either side',
  parseRecall(`Here is what I found: ${good} — hope that helps.`, 1).items.clickup?.[0].id,
  'abc123'
)

/*
 * A record with no id can never be addressed by an update, so listing it would
 * only tempt the scan into referencing something the write path cannot find.
 */
check(
  'a record with no id is dropped',
  parseRecall('{"clickup":[{"title":"No id here"},{"id":"x","title":"Fine"}]}', 1).items.clickup?.length,
  1
)
check(
  'a record with no title is dropped too',
  parseRecall('{"clickup":[{"id":"x"}]}', 1).items.clickup,
  undefined
)
check(
  'the same id twice is one record',
  parseRecall('{"clickup":[{"id":"x","title":"A"},{"id":"x","title":"A again"}]}', 1).items.clickup?.length,
  1
)
check(
  'a non-https url is not kept',
  parseRecall('{"clickup":[{"id":"x","title":"A","url":"javascript:alert(1)"}]}', 1).items.clickup?.[0].url,
  undefined
)
check(
  'the item list is capped',
  parseRecall(
    JSON.stringify({ clickup: Array.from({ length: 100 }, (_, i) => ({ id: `t${i}`, title: `Task ${i}` })) }),
    1
  ).items.clickup?.length,
  MAX_RECALL_ITEMS
)

/*
 * The distinction the whole feature rests on. An unreadable reply must never
 * look like an empty board.
 */
console.log('\ncould not look is not the same as nothing there')

const broken = parseRecall('I was unable to reach ClickUp, sorry.', 5)
ok('an unreadable reply is an error', !!broken.error, canon(broken))
check('and reports no records', broken.items, {})
ok('an empty reply is an error too', !!parseRecall('', 5).error)
ok(
  'unrelated JSON in the reply is not mistaken for an answer',
  !!parseRecall('{"note":"nothing to report"}', 5).error,
  canon(parseRecall('{"note":"nothing to report"}', 5))
)
check('a genuinely empty board is not an error', parseRecall('{"clickup":[],"notion":[]}', 5).error, undefined)

/* ---------------------------------------------------------- the rendering */

console.log('\nwhat the scan prompt is shown')

const rendered = formatRecall(parsed)
ok('ids are included, because an update has to name one', rendered.includes('[clickup:abc123]'), rendered)
ok('so are the statuses in use', rendered.includes('in progress'), rendered)
ok('and the vocabulary, beside the board it belongs to', rendered.includes('statuses: open, in progress, complete'), rendered)
check('an empty snapshot renders to nothing at all', formatRecall(EMPTY_RECALL), '')

const huge = parseRecall(
  JSON.stringify({
    clickup: Array.from({ length: MAX_RECALL_ITEMS }, (_, i) => ({
      id: `task-${i}`,
      title: `A task with a fairly long title, number ${i}, to push the rendering past its ceiling`
    }))
  }),
  1
)
ok(
  // +1 for the ellipsis: clip cuts to the cap and then marks the cut, which is
  // how every other bound in this feature behaves.
  'the rendering is bounded however much comes back',
  formatRecall(huge).length <= MAX_RECALL_CHARS + 1,
  `${formatRecall(huge).length} characters`
)

/* --------------------------------------------------------- the vocabulary */

console.log('\nthe statuses an update may use')

const statuses = statusesFor(parsed, 'clickup')
ok('a declared status is allowed', statuses.has('complete'))
ok('a status only seen on a task is allowed too', statuses.has('in progress'))
ok('an invented one is not', !statuses.has('done'), [...statuses].join(', '))
check(
  'a board with no vocabulary read still allows what it demonstrably uses',
  [...statusesFor({ readAt: 1, items: { notion: [{ id: 'n', title: 't', status: 'Draft' }] } }, 'notion')],
  ['draft']
)
check('and a board with nothing read allows nothing', [...statusesFor(EMPTY_RECALL, 'clickup')], [])

check('a known id is found', findExisting(parsed, 'clickup', 'ABC123')?.title, 'Ship SSH sessions')
check('an unknown one is not', findExisting(parsed, 'clickup', 'nope'), null)

/* --------------------------------------------------------------- the read */

console.log('\na failed read degrades, it does not throw')

const failing = await readExisting({
  ...BOARDS,
  run: async () => {
    throw new Error('claude is not installed')
  }
})
ok('a runner that throws comes back as an error', failing.error?.includes('not installed'), canon(failing))
check('with no records', failing.items, {})

const errored = await readExisting({ ...BOARDS, run: stub('the connector is not authorised', true).run })
ok('so does a run that reports an error', !!errored.error, canon(errored))

/* -------------------------------------------------------------- the cache */

console.log('\nthe boards are read once, not once per scan')

invalidateRecall()
const counted = stub(good)
const [a, b] = await Promise.all([
  recall({ ...BOARDS, run: counted.run }, 10_000),
  recall({ ...BOARDS, run: counted.run }, 10_000)
])
check('two scans in the same instant read the boards once', counted.calls(), 1)
check('and both get the same answer', a.items.clickup?.[0].id, b.items.clickup?.[0].id)

const soonAfter = await recall({ ...BOARDS, run: counted.run }, 10_000 + 60_000)
check('a scan a minute later reuses it', counted.calls(), 1)
check('and it is still the same reading', soonAfter.readAt, 10_000)

await recall({ ...BOARDS, run: counted.run }, 10_000 + 11 * 60_000)
check('past the TTL it reads again', counted.calls(), 2)

/*
 * After a write the cached reading is stale, and the record just written is the
 * one the next scan most needs to know about — leave it cached and the next scan
 * proposes creating it all over again.
 */
invalidateRecall()
await recall({ ...BOARDS, run: counted.run }, 10_000 + 11 * 60_000)
check('and invalidating forces one immediately', counted.calls(), 3)

/*
 * The race that made invalidation a no-op.
 *
 * A read takes tens of seconds. If the user accepts a proposal while one is in
 * flight, `cached = null` is set and then immediately overwritten by the
 * pending read's own `.then` — so a snapshot taken *before* the write stayed
 * cached for the full TTL, the record just created was invisible to every scan
 * for ten minutes, and the same work came back as a create.
 */
console.log('\na read that started before a write must not install itself after it')

invalidateRecall()
let releaseSlow: ((v: string) => void) | null = null
const slowRun: Runner = async () => {
  const text = await new Promise<string>((r) => {
    releaseSlow = r
  })
  return {
    text,
    isError: false,
    subtype: null,
    costUsd: 0.01,
    durationMs: 10,
    numTurns: 1,
    sessionId: null,
    permissionDenials: [],
    raw: {}
  }
}

const stale = '{"clickup":[{"id":"before","title":"Before the write"}]}'
const inFlight = recall({ ...BOARDS, run: slowRun }, 50_000)
await new Promise((r) => setTimeout(r, 0))
// The accept lands mid-read.
invalidateRecall()
releaseSlow?.(stale)
await inFlight

const fresh = '{"clickup":[{"id":"before","title":"Before the write"},{"id":"new","title":"The record just written"}]}'
const next = await recall({ ...BOARDS, run: stub(fresh).run }, 50_100)
check(
  'the next scan reads the boards again rather than reusing the pre-write snapshot',
  next.items.clickup?.length,
  2
)
ok(
  'so it knows about the record that was just written',
  !!next.items.clickup?.some((i) => i.id === 'new'),
  JSON.stringify(next.items.clickup)
)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
