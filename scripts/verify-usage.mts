/*
 * Plan-limit parsing, and the pace marker in particular.
 *
 * The marker is derived from a reset time and an assumed window length, so a
 * wrong derivation does not throw — it renders a plausible bar in the wrong
 * place, which is the failure mode this project keeps producing. These anchors
 * have arithmetic answers, so a regression shows up as a wrong number.
 *
 * The last section calls the live account, so it needs Claude Code signed in.
 *
 *   node scripts/verify-usage.mts
 */
import { fetchUsage, parseUsage } from '../src/main/usage.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

const HOUR = 3_600_000
const now = Date.parse('2026-08-02T12:00:00Z')

const paceWith = (hoursRemaining: number): number | null =>
  parseUsage(
    {
      limits: [
        {
          kind: 'session',
          percent: 10,
          severity: 'normal',
          resets_at: new Date(now + hoursRemaining * HOUR).toISOString(),
          is_active: true
        }
      ]
    },
    now
  ).windows[0].elapsed

console.log('\npace marker across a 5-hour window')
check('a fresh window sits at the start', paceWith(5), 0)
check('2.5 hours in sits exactly halfway', paceWith(2.5), 0.5)
check('4 hours in sits at 0.8', paceWith(1), 0.8)
check('an expired window clamps to the end', paceWith(-1), 1)
check('a reset further out than the window clamps to the start', paceWith(9), 0)

console.log('\nwindow shape')
const snap = parseUsage(
  {
    limits: [
      { kind: 'session', percent: 8, severity: 'normal', resets_at: null, is_active: false },
      { kind: 'weekly_all', percent: 27, severity: 'normal', resets_at: null, is_active: true },
      {
        kind: 'weekly_scoped',
        percent: 0,
        severity: 'normal',
        resets_at: null,
        is_active: false,
        scope: { model: { display_name: 'Fable' } }
      }
    ],
    extra_usage: { is_enabled: false, utilization: null }
  },
  now
)
check('every window is kept', snap.windows.length, 3)
check('the session window is named for its length', snap.windows[0].label, '5 hours')
check('the all-models weekly window is named Weekly', snap.windows[1].label, 'Weekly')
check('a scoped window takes the model name', snap.windows[2].label, 'Fable')
check('no reset time means no marker rather than a wrong one', snap.windows[0].elapsed, null)
check('percent survives', snap.windows[1].percent, 27)

console.log('\nmalformed input degrades rather than throwing')
check('empty object', parseUsage({}, now).windows.length, 0)
check('null', parseUsage(null, now).windows.length, 0)
check(
  'an impossible percent is clamped',
  parseUsage({ limits: [{ kind: 'session', percent: 999 }] }, now).windows[0].percent,
  100
)
check(
  'a non-numeric percent reads as zero',
  parseUsage({ limits: [{ kind: 'session', percent: 'x' }] }, now).windows[0].percent,
  0
)

console.log('\nthe live account')
const live = await fetchUsage()
if (live.retryAfter) {
  /*
   * The endpoint is rate-limiting or down. That is the environment, not the
   * code, and failing the suite for it would train everyone to ignore a red
   * run. Reporting unavailability here is the parser behaving correctly.
   */
  console.log(`  SKIP  ${live.error} Backing off ${Math.round(live.retryAfter / 60_000)} min.`)
} else if (live.error) {
  console.log(`  FAIL  ${live.error}`)
  failures++
} else if (!live.windows.length) {
  console.log('  FAIL  the endpoint answered but reported no windows')
  failures++
} else {
  console.log(`  PASS  ${live.windows.length} windows`)
  for (const w of live.windows) {
    const resets = w.resetsAt
      ? new Date(w.resetsAt).toISOString().slice(0, 16).replace('T', ' ')
      : 'never used'
    const pace = w.elapsed === null ? '  n/a' : `${String(Math.round(w.elapsed * 100)).padStart(3)}%`
    const ahead = w.elapsed !== null && w.percent > w.elapsed * 100 ? '  <- ahead of pace' : ''
    console.log(
      `        ${w.label.padEnd(8)} used ${String(w.percent).padStart(3)}%   pace ${pace}   resets ${resets}${ahead}`
    )
  }
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
// Setting the code rather than calling process.exit: the socket from the live
// request is still closing, and exiting under it trips a libuv assertion on
// Windows that looks like a failure when the run actually succeeded.
process.exitCode = failures ? 1 : 0
