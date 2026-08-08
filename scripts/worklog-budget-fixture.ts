/*
 * The shape a budget-exhausted headless run actually returns.
 *
 * Shared by scripts/verify-worklog-runner.mts and scripts/verify-worklog-recall.mts
 * so the two suites cannot quietly disagree about what a refusal looks like
 * (plan-resolutions.md, "Task 24 — the BUDGET_REFUSAL fixture is shared, not
 * copied byte-for-byte into two suites. Put it in one module both suites
 * import.").
 *
 * OBSERVED, not assumed — measured on `claude` 2.1.221, 2026-08-08, via
 * `STOKE_LIVE_WORKLOG_COST=1 node scripts/measure-worklog-cost.mts budget`
 * (equivalently `npm run measure:worklog -- budget`): a trivial prompt run
 * under a $0.0001 ceiling nothing can fit inside. The raw envelope:
 *
 *   {
 *     "is_error": true,
 *     "num_turns": 1,
 *     "stop_reason": "end_turn",
 *     "total_cost_usd": 0.115134,
 *     "terminal_reason": "budget_exhausted",
 *     "subtype": "error_max_budget_usd",
 *     "errors": ["Reached maximum budget ($0.0001)"],
 *     "type": "result",
 *     "duration_ms": 2202
 *   }
 *
 * The one thing the earlier, assumed version of this fixture got wrong: it
 * had the refusal arriving as readable prose in `result` (this file's
 * `text`), e.g. "Reached the maximum budget of $0.15 for this run." It does
 * not — `text` is EMPTY. Everything readable lives in `errors`; `subtype` is
 * an internal identifier with no prose in it at all. Both `isBudgetExhausted()`
 * (src/main/agent.ts) and `budgetEvidence()` (src/main/worklog/runner.ts) were
 * written to keep matching once the real strings replaced the assumed ones —
 * see the assertions under "a run that ran out of money says so" in
 * scripts/verify-worklog-runner.mts for the proof that they still do.
 */
export const BUDGET_REFUSAL = {
  isError: true,
  subtype: 'error_max_budget_usd',
  text: '',
  errors: ['Reached maximum budget ($0.0001)'],
  terminalReason: 'budget_exhausted'
}
