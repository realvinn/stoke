/*
 * The shape a budget-exhausted headless run is assumed to return.
 *
 * Shared by scripts/verify-worklog-runner.mts and scripts/verify-worklog-recall.mts
 * so the two suites cannot quietly disagree about what a refusal looks like
 * (plan-resolutions.md, "Task 24 — the BUDGET_REFUSAL fixture is shared, not
 * copied byte-for-byte into two suites. Put it in one module both suites
 * import.").
 *
 * THIS HAS NOT BEEN OBSERVED. Neither `subtype` nor `text` is a documented
 * interface of the `claude` CLI — that is exactly why `isBudgetExhausted()`
 * (src/main/agent.ts) is a substring test on both fields rather than an
 * equality test on either. Every assertion built on this fixture is written
 * to keep passing once the real strings replace these two.
 *
 * `STOKE_LIVE_WORKLOG_COST=1 node scripts/measure-worklog-cost.mts budget`
 * (equivalently `STOKE_LIVE_WORKLOG_COST=1 npm run measure:worklog -- budget`)
 * is the tool that would confirm this. It spends real money running a trivial
 * prompt under a budget nothing can fit inside, and prints the CLI's actual
 * `subtype` and `text`. Replace the two strings below with what it prints;
 * nothing downstream needs to change for that to keep working — that is the
 * point of matching on the word "budget" rather than on the sentence around
 * it.
 */
export const BUDGET_REFUSAL = {
  isError: true,
  subtype: 'error_max_budget_exceeded',
  text: 'Reached the maximum budget of $0.15 for this run.'
}
