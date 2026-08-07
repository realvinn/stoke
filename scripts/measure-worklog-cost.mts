/*
 * What the worklog actually costs, measured rather than assumed.
 *
 * `recall.ts` capped a run at $0.15 and that run could not finish inside it —
 * which is spec §2.4.1, and the single reason the whole feature never did
 * anything. RECALL_MAX_BUDGET_USD and APPLY_MAX_BUDGET_USD ship as stated
 * figures with a stated derivation, so nothing depends on this tool having
 * been run; what it buys is the right to *tighten* them, and to replace the
 * assumed BUDGET_REFUSAL envelope in the two worklog suites with the observed
 * one.
 *
 * NOT part of `npm run check`. Both modes spawn a real `claude` and the recall
 * mode reads a live board through the user's own MCP connectors, so this costs
 * money and cannot run on a machine with no connectors — the same reason
 * verify:security is excluded.
 *
 * A bare `node scripts/measure-worklog-cost.mts` (or `npm run measure:worklog`
 * with no `-- recall`/`-- budget`) used to default to `recall` and quietly
 * spend real money against the live boards before printing a word — that
 * happened once, for real, during review of this file. There is no default
 * mode any more: an absent or unrecognised argument always falls through to
 * the usage line below and exits 1.
 *
 * Both paid modes additionally require STOKE_LIVE_WORKLOG_COST=1, the same
 * opt-in shape verify-usage.mts uses for its live account call. Unset, empty,
 * or "0" all refuse — only the literal string "1" runs anything.
 *
 *   STOKE_LIVE_WORKLOG_COST=1 node scripts/measure-worklog-cost.mts recall
 *   STOKE_LIVE_WORKLOG_COST=1 node scripts/measure-worklog-cost.mts budget
 */
import { runHeadless, type HeadlessResult } from '../src/main/agent.ts'
import { readExisting, recallRunOptions } from '../src/main/worklog/recall.ts'
import { DEFAULT_WORKLOG_BOARDS } from '../src/shared/worklog.ts'

const mode = process.argv[2]

function report(label: string, result: Pick<HeadlessResult, 'isError' | 'subtype' | 'costUsd' | 'durationMs' | 'text'>): void {
  console.log(`\n${label}`)
  console.log(`  isError    ${result.isError}`)
  console.log(`  subtype    ${JSON.stringify(result.subtype)}`)
  console.log(`  costUsd    ${result.costUsd}`)
  console.log(`  durationMs ${result.durationMs}`)
  console.log(`  text       ${JSON.stringify(String(result.text).slice(0, 600))}`)
}

/*
 * The point of no return for either paid mode. Prints, in plain English,
 * exactly what is about to happen and why it costs money, then refuses to go
 * any further unless STOKE_LIVE_WORKLOG_COST is the literal string "1" — an
 * unset, empty, or "0" value all fall through to the same refusal. This must
 * run, and must be able to stop the script, before either mode's first real
 * work — nothing above this point spends anything.
 */
function confirmLiveSpend(mode: 'recall' | 'budget'): void {
  const envVar = 'STOKE_LIVE_WORKLOG_COST'
  const readsBoards =
    mode === 'recall'
      ? ' It will also read your real, live Notion and ClickUp boards through their MCP connectors — this is your actual work data, not a test fixture.'
      : ''
  console.log(
    `\nAbout to spend real money: this starts an actual "claude" process and that is billed like any other Claude usage.${readsBoards}\n` +
      `Nothing has run yet, and nothing will unless you confirm.\n` +
      `To confirm, set ${envVar}=1 and run this again, e.g.:\n` +
      `  ${envVar}=1 npm run measure:worklog -- ${mode}\n`
  )
  if (process.env[envVar] !== '1') {
    console.log(`Refusing to continue: ${envVar} is not set to "1". Nothing was spent.`)
    process.exit(1)
  }
  console.log(`${envVar}=1 confirmed — continuing.`)
}

if (mode === 'recall') {
  confirmLiveSpend('recall')
  /*
   * A deliberately generous ceiling. The point of this run is to find out what
   * the read costs, and a ceiling below that would abort it and measure the
   * ceiling instead — which is precisely the bug being measured.
   */
  const opts = {
    ...DEFAULT_WORKLOG_BOARDS,
    targets: ['notion'] as const,
    maxBudgetUsd: 2,
    timeoutMs: 300_000
  }
  console.log('running a Notion-only recall against the real board…')
  console.log(`  allowed tools: ${(recallRunOptions(opts).allowedTools ?? []).join(', ')}`)
  const started = Date.now()
  const snapshot = await readExisting(opts)
  console.log(`\nwall clock  ${Date.now() - started}ms`)
  console.log(`records     ${(snapshot.items.notion ?? []).length}`)
  console.log(`statuses    ${JSON.stringify(snapshot.statuses?.notion ?? [])}`)
  console.log(`error       ${JSON.stringify(snapshot.error ?? null)}`)
  console.log(
    '\nreadExisting does not report cost. Re-run the same options through runHeadless for it:'
  )
  const raw = await runHeadless(recallRunOptions(opts))
  report('the same read, measured', raw)
  console.log(
    `\n>>> a Notion-only recall cost $${raw.costUsd} on ${new Date().toISOString().slice(0, 10)}.`
  )
  console.log(
    '>>> If that is comfortably below RECALL_MAX_BUDGET_USD (0.6), you may tighten the constant\n' +
      '>>> in src/main/worklog/recall.ts to about four times this figure, and APPLY_MAX_BUDGET_USD\n' +
      '>>> in src/main/worklog/runner.ts alongside it. Keep both inside the 0.2–1.5 band the\n' +
      '>>> suites assert. If it is ABOVE 0.6, raise them instead — a ceiling under the real cost\n' +
      '>>> is the bug this whole workstream exists to fix.'
  )
} else if (mode === 'budget') {
  confirmLiveSpend('budget')
  /*
   * A ceiling nothing can fit inside, so the CLI has to refuse. The whole
   * purpose is the shape of that refusal: `subtype` and the result text are
   * what `isBudgetExhausted` matches on, and guessing them is how a budget
   * failure keeps arriving as an empty result.
   */
  console.log('running a trivial prompt under a $0.0001 ceiling…')
  try {
    const result = await runHeadless({
      prompt: 'Reply with the single word: ok',
      maxBudgetUsd: 0.0001,
      strictMcp: true,
      safeMode: true,
      effort: 'low',
      timeoutMs: 120_000
    })
    report('the refusal', result)
    console.log(`\nraw envelope:\n${JSON.stringify(result.raw, null, 2)}`)
    console.log(
      '\n>>> Copy the subtype and the first line of the text above into the BUDGET_REFUSAL\n' +
        '>>> fixture in BOTH scripts/verify-worklog-runner.mts and\n' +
        '>>> scripts/verify-worklog-recall.mts, keeping the two copies identical. The assertions\n' +
        '>>> around them do not change: isBudgetExhausted matches /budget/i on either field, so a\n' +
        '>>> real envelope must still be recognised and a plain failure must still not be.'
    )
  } catch (err) {
    console.log('\nit threw instead of returning an envelope:')
    console.log(String(err))
    console.log(
      '\n>>> Budget exhaustion has no envelope on this CLI version. Leave BUDGET_REFUSAL as it\n' +
        '>>> is and open an issue: agent.ts keeps a non-zero exit that still printed a result,\n' +
        '>>> so a throw here means the CLI stopped printing one and isBudgetExhausted is never\n' +
        '>>> reached — a different bug from the one it was written for.'
    )
  }
} else {
  console.log('usage: node scripts/measure-worklog-cost.mts [recall|budget]')
  process.exitCode = 1
}
