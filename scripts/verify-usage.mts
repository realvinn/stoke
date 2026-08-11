/*
 * Plan-limit parsing, and the pace marker in particular.
 *
 * The marker is derived from a reset time and an assumed window length, so a
 * wrong derivation does not throw — it renders a plausible bar in the wrong
 * place, which is the failure mode this project keeps producing. These anchors
 * have arithmetic answers, so a regression shows up as a wrong number.
 *
 * The last section calls the live account. It is opt-in behind
 * STOKE_LIVE_USAGE=1 and does not run as part of `npm run check` — on macOS
 * it fails every time, because the OAuth token lives in the login Keychain,
 * not in ~/.claude/.credentials.json (CLAUDE.md, Task 14's finding). The
 * section above it proves the path that works everywhere instead: the
 * statusLine payload, merged with whatever the account route did or didn't
 * answer, the same way UsageMeter.tsx merges them for real.
 *
 *   node scripts/verify-usage.mts
 *   STOKE_LIVE_USAGE=1 node scripts/verify-usage.mts
 */
import { fetchUsage, parseUsage } from '../src/main/usage.ts'
import { toSnapshot } from '../src/main/statusLine.ts'
import { mergeUsageWindows, statusLineWindows } from '../src/shared/statusLine.ts'

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

/*
 * The account route needs the network and a token, and on macOS it has
 * neither: the OAuth token is in the login Keychain, not in
 * ~/.claude/.credentials.json, so this section reports "Not signed in to
 * Claude Code." and fails. That is exactly why the merge section above
 * exists — and why this half is opt-in, so the rest of the suite can be
 * part of `npm run check`.
 */
if (process.env.STOKE_LIVE_USAGE === '1') {
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
} else {
  console.log('\n  SKIP  the live account call (set STOKE_LIVE_USAGE=1 to run it)')
}

console.log('\nwhat the chip actually draws when both sources answer at once')
/*
 * verify-statusline.mts already proves statusLineWindows() and
 * mergeUsageWindows() in detail, against the same captured 2.1.221 payload —
 * repeating those checks here would be the exact duplication
 * the H3 ruling rules out. What that suite never does is
 * call parseUsage(), the account-route parser this file alone owns, and
 * merge ITS real output with a real payload the way UsageMeter.tsx actually
 * does it. That composition — not either parser in isolation — is this
 * suite's own job, and it is the thing that was never provable on a machine
 * where the account route fails outright.
 */
const PAYLOAD = {
  session_id: 'a0e0ee79-0000-4000-8000-000000000000',
  model: { id: 'claude-opus-5', display_name: 'Opus 5' },
  context_window: { context_window_size: 1_000_000, used_percentage: 28 },
  exceeds_200k_tokens: false,
  rate_limits: {
    five_hour: { used_percentage: 15, resets_at: 1_786_078_200 },
    seven_day: { used_percentage: 3, resets_at: 1_786_647_600 }
  }
}
/** Half an hour before the five-hour window in PAYLOAD resets. */
const at = 1_786_076_400_000
const fromLine = statusLineWindows(toSnapshot('usage-1', PAYLOAD, at), at)

/**
 * The account's own answer at the same instant: a warning severity on the
 * very window the payload also reports — from an earlier poll, so its own
 * percent and reset time are deliberately stale — plus the model-scoped
 * window only the account route ever produces at all.
 */
const fromAccount = parseUsage(
  {
    limits: [
      {
        kind: 'session',
        percent: 9,
        severity: 'warning',
        resets_at: new Date(1_786_070_000_000).toISOString(),
        is_active: true
      },
      {
        kind: 'weekly_scoped',
        percent: 61,
        severity: 'normal',
        resets_at: null,
        is_active: false,
        scope: { model: { display_name: 'Fable' } }
      }
    ]
  },
  at
).windows

const merged = mergeUsageWindows(fromLine, fromAccount)
check(
  'all three windows reach the chip: the two the payload states, plus the one only the account can',
  merged.map((w) => w.kind),
  ['session', 'weekly', 'weekly_scoped']
)
check(
  "the session window's figures are the payload's fresher ones, not the account's stale poll",
  [merged[0].percent, merged[0].resetsAt],
  [15, 1_786_078_200_000]
)
check(
  "but its severity is the account's — the one field the payload has no way to state at all",
  merged[0].severity,
  'warning'
)
check(
  'the Fable window rides along exactly as parseUsage itself built it from the account JSON',
  [merged[2].label, merged[2].percent, merged[2].severity, merged[2].active],
  ['Fable', 61, 'normal', false]
)

console.log('\nand on this machine, where the account route never answers at all')
check(
  'with nothing from the account, the payload alone still draws both its windows — ' +
    'the meter does not go blank just because auth failed',
  mergeUsageWindows(fromLine, []).map((w) => w.kind),
  ['session', 'weekly']
)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
// Setting the code rather than calling process.exit: the socket from the live
// request is still closing, and exiting under it trips a libuv assertion on
// Windows that looks like a failure when the run actually succeeded.
process.exitCode = failures ? 1 : 0
