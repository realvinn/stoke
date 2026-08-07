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
  RECALL_MAX_BUDGET_USD,
  RECALL_TOOLS,
  findExisting,
  formatRecall,
  invalidateRecall,
  parseRecall,
  recall,
  readExisting,
  recallRunOptions,
  recallToolsFor,
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

/*
 * Literal, by hand — deliberately NOT derived from `recallToolsFor` or
 * `TOOLS_FOR`. Every assertion below that names one of these lists exists to
 * catch the tool map in recall.ts being emptied or mis-split by accident; a
 * comparison built from the same function under test would pass no matter
 * what that function returned, including nothing at all. See the "empty
 * TOOLS_FOR" demonstration this suite's fix pass ran by hand — these are the
 * lines that must fail when it is.
 */
const NOTION_TOOLS_EXPECTED = [
  'mcp__claude_ai_Notion__notion-query-data-sources',
  'mcp__claude_ai_Notion__notion-search'
]
const CLICKUP_TOOLS_EXPECTED = [
  'mcp__claude_ai_ClickUp__clickup_filter_tasks',
  'mcp__claude_ai_ClickUp__clickup_get_list'
]
const RECALL_TOOLS_EXPECTED = [...NOTION_TOOLS_EXPECTED, ...CLICKUP_TOOLS_EXPECTED]

/* --------------------------------------------------------------- the run */

console.log('\nrecall reads, and can only read')

const opts = recallRunOptions(BOARDS)
check('the allowlist is exactly the read tools', opts.allowedTools, RECALL_TOOLS_EXPECTED)
check('RECALL_TOOLS is the same four tools', RECALL_TOOLS, RECALL_TOOLS_EXPECTED)
ok(
  'not one of them can create anything',
  !RECALL_TOOLS.some((t) => /create|update|delete|move|merge|comment/i.test(t)),
  RECALL_TOOLS.join(', ')
)
ok(
  'and it genuinely holds real tools rather than being vacuously empty',
  RECALL_TOOLS.includes('mcp__claude_ai_Notion__notion-search') &&
    RECALL_TOOLS.includes('mcp__claude_ai_ClickUp__clickup_get_list'),
  RECALL_TOOLS.join(', ')
)
ok('it runs cheap, because this is a listing not a judgement', opts.effort === 'low', String(opts.effort))
ok(
  'the ceiling is the shared constant, not a literal buried in the options',
  opts.maxBudgetUsd === RECALL_MAX_BUDGET_USD,
  `${opts.maxBudgetUsd} vs ${RECALL_MAX_BUDGET_USD}`
)
/*
 * An absolute band, deliberately, and not a comparison against a second
 * constant.
 *
 * "At least three times the measured cost" sounds stronger and is weaker: it
 * needs a second constant holding the measurement, and if nobody fills that in
 * the comparison reads `0 >= 0 * 3` and passes — so the suite goes green on a
 * $0 ceiling, which is a dead feature with a passing test. A band cannot pass
 * vacuously. The cap keeps it a ceiling rather than a blank cheque.
 *
 * The floor is 0.6, not the original 0.2. A floor of 0.2 only ever caught a
 * value nobody filled in — it said nothing about whether the value filled in
 * was actually workable. A real measurement against the live board
 * (Notion-only, 2026-08-07) put a single recall at `costUsd 0.5144943` for 30
 * records, so 0.2 admitted 0.3, 0.4 and 0.5 as "a real figure" while every one
 * of them sits below the measured cost — a ceiling that exhausts before the
 * read answers, reports an empty board, and has the scan propose creating
 * everything already tracked. That is spec §2.4.1 verbatim, the exact bug
 * this constant exists to fix. 0.6 is the smallest round number clear of the
 * measurement, with headroom for a real run to vary without landing back
 * under the floor by accident. The cap stays 3.0: roughly 6x the single-board
 * figure, comfortably above both boards at once, and still low enough to
 * catch a stray extra digit on the high end.
 */
ok(
  'the recall ceiling is above what would reproduce the budget-exhaustion bug, not merely above zero',
  RECALL_MAX_BUDGET_USD >= 0.6 && RECALL_MAX_BUDGET_USD <= 3.0,
  String(RECALL_MAX_BUDGET_USD)
)
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

/*
 * The cache is keyed on the target set, not merely on time.
 *
 * Before this, unticking ClickUp and scanning within the TTL would still be
 * served the two-board reading cached under the old settings — so the model
 * would be shown ClickUp records that a board-off scan should never see, and
 * the reverse: ticking ClickUp on would be served a Notion-only reading for
 * up to ten minutes, proposing creates for ClickUp work that already exists.
 * Both directions are asserted here: a narrower read is not served the wider
 * cache, and the wider cache is not clobbered or reused by the narrower one.
 */
console.log('\na cached reading for one target set is not served to a different one')

invalidateRecall()
const bothBoards = stub(
  '{"clickup":[{"id":"c1","title":"ClickUp thing"}],"notion":[{"id":"n1","title":"Notion thing"}]}'
)
const bothSnap = await recall({ ...BOARDS, targets: ['notion', 'clickup'], run: bothBoards.run }, 200_000)
check('the two-board read sees both boards', Object.keys(bothSnap.items).sort(), ['clickup', 'notion'])
check('read once so far', bothBoards.calls(), 1)

const notionOnly2 = stub('{"notion":[{"id":"n1","title":"Notion thing"}]}')
const notionSnap = await recall({ ...BOARDS, targets: ['notion'], run: notionOnly2.run }, 200_001)
check(
  'a notion-only read is not served the cached two-board answer — it reads for itself',
  notionOnly2.calls(),
  1
)
check('so its snapshot has no clickup key at all', notionSnap.items.clickup, undefined)

const stillBoth = await recall({ ...BOARDS, targets: ['notion', 'clickup'], run: bothBoards.run }, 200_002)
check(
  'and the two-board cache is unaffected — the narrower read did not overwrite or evict it',
  bothBoards.calls(),
  1
)
check('it still holds the clickup record', stillBoth.items.clickup?.[0].id, 'c1')

// The mirror order: cache the narrow reading first, then ask for the wider set.
invalidateRecall()
const clickupOnly2 = stub('{"clickup":[{"id":"c1","title":"ClickUp thing"}]}')
await recall({ ...BOARDS, targets: ['clickup'], run: clickupOnly2.run }, 300_000)
const widerAfterNarrow = await recall({ ...BOARDS, targets: ['notion', 'clickup'], run: bothBoards.run }, 300_001)
check(
  'asking for both boards after a narrower cache is not served the narrow answer',
  widerAfterNarrow.items.notion?.[0]?.id,
  'n1'
)

console.log('\nreading one board when only one is switched on')

const notionOnly = recallRunOptions({ ...BOARDS, targets: ['notion'] })
check(
  'the allowlist drops every ClickUp tool',
  notionOnly.allowedTools,
  NOTION_TOOLS_EXPECTED
)
ok(
  'so a ClickUp read is not even possible',
  !(notionOnly.allowedTools ?? []).some((t) => /clickup/i.test(t)),
  (notionOnly.allowedTools ?? []).join(', ')
)
ok(
  // The check above (no clickup-shaped name) would also pass on an allowlist
  // with nothing in it at all. This is the assertion that catches that: it
  // fails unless a real Notion read tool is actually present.
  'and it genuinely contains a real notion read tool, not just an absence of clickup ones',
  (notionOnly.allowedTools ?? []).includes('mcp__claude_ai_Notion__notion-search'),
  (notionOnly.allowedTools ?? []).join(', ')
)
ok(
  'the prompt names Notion',
  notionOnly.prompt.includes('collection://abc'),
  notionOnly.prompt
)
ok(
  'and never mentions the ClickUp list, which nothing will read',
  !notionOnly.prompt.includes('901615258684'),
  notionOnly.prompt
)
ok(
  'it still asks for the status vocabulary, which open pages do not carry',
  /every value its status/.test(notionOnly.prompt),
  notionOnly.prompt
)

const clickupOnly = recallRunOptions({ ...BOARDS, targets: ['clickup'] })
check(
  'the mirror case keeps exactly the clickup read tools',
  clickupOnly.allowedTools,
  CLICKUP_TOOLS_EXPECTED
)
ok(
  'so it drops Notion entirely',
  !(clickupOnly.allowedTools ?? []).some((t) => /notion/i.test(t)),
  (clickupOnly.allowedTools ?? []).join(', ')
)
ok(
  // Names the specific tool CLAUDE.md gotcha 16 depends on: a board's closed
  // statuses are on none of its open tasks, so this one has to survive every
  // target combination or nothing can ever be marked done.
  'including clickup_get_list, which is the only way a closed status is ever discovered',
  (clickupOnly.allowedTools ?? []).includes('mcp__claude_ai_ClickUp__clickup_get_list'),
  (clickupOnly.allowedTools ?? []).join(', ')
)
ok(
  'and still asks the list for its own closed statuses',
  /every status it offers/.test(clickupOnly.prompt),
  clickupOnly.prompt
)

check('no targets at all allows no tools', recallToolsFor([]), [])

console.log('\nan empty allowlist is not the same as no tools')

{
  /*
   * agent.ts only pushes `--allowedTools` when the array is non-empty
   * (`opts.allowedTools?.length`), so `allowedTools: []` alone does not
   * restrict anything — it omits the flag and the run inherits the CLI's
   * default permissions, which include every Notion and ClickUp *write*
   * tool. The property that actually matters is `safeMode`: it switches
   * every MCP server off unconditionally, so no tool of either server is
   * reachable no matter what `allowedTools` says. That is what this asserts
   * directly, rather than trusting the empty array to mean what it looks
   * like it means.
   */
  const zeroTargetRun = recallRunOptions({ ...BOARDS, targets: [] })
  ok(
    'a zero-target run turns safe mode on, so no MCP tool — read or write — is reachable',
    zeroTargetRun.safeMode === true,
    canon(zeroTargetRun)
  )
  const bothTargetsRun = recallRunOptions(BOARDS)
  ok(
    'the ordinary two-board run stays non-hermetic, since it exists to reach the boards',
    bothTargetsRun.safeMode !== true,
    canon(bothTargetsRun)
  )
}

{
  /*
   * Nowhere to read is a configuration, not a failure: `error` must stay
   * unset, or the scan prompt would tell the model the boards "could not be
   * read" and it would propose creates for everything.
   */
  const stubbed = stub('{"notion":[]}')
  const snap = await readExisting({ ...BOARDS, targets: [], run: stubbed.run }, 42)
  check('no board configured runs nothing at all', stubbed.calls(), 0)
  check('and reports an empty reading rather than an error', snap.error, undefined)
  check('stamped with the time it was decided', snap.readAt, 42)
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
