/*
 * Plan-limit parsing, and the pace marker in particular.
 *
 * The marker is derived from a reset time and an assumed window length, so a
 * wrong derivation does not throw — it renders a plausible bar in the wrong
 * place, which is the failure mode this project keeps producing. These anchors
 * have arithmetic answers, so a regression shows up as a wrong number.
 *
 * The last section calls the live account. It is opt-in behind
 * STOKE_LIVE_USAGE=1 and does not run as part of `npm run check`, because it
 * needs the network and a signed-in account — not because of the platform. It
 * used to fail on macOS every time: the OAuth token lives in the login
 * Keychain, not in ~/.claude/.credentials.json, and `readCredentials` only
 * looked at the file. It reads both now, so this section passes here, and the
 * plan-limit chip no longer needs a running session to say anything at all.
 * The merge section below still matters — the payload remains the fresher of
 * the two sources whenever a session is up.
 *
 *   node scripts/verify-usage.mts
 *   STOKE_LIVE_USAGE=1 node scripts/verify-usage.mts
 */
import { fetchUsage, findToken, freshestCredentials, parseUsage } from '../src/main/usage.ts'
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
check(
  'a fractional account percent is rounded at the edge, as the payload side already is (gotcha 21)',
  parseUsage({ limits: [{ kind: 'session', percent: 27.500000001 }] }, now).windows[0].percent,
  28
)

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
 * The account route needs the network and a signed-in token, which is why it
 * is opt-in rather than part of `npm run check`. It is the one source that
 * answers with no session running, so a failure here is the difference between
 * a chip that works when the app is idle and one that does not.
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

/*
 * The payload is the fresher of the two here, which is the ordinary
 * during-a-session case: `at` is when it was written and the account's poll
 * landed a minute earlier. Stating both instants is the point — the merge
 * compares them rather than assuming the payload always wins, and the
 * reversed case is asserted below.
 */
const accountAt = at - 60_000
const merged = mergeUsageWindows(fromLine, fromAccount, at, accountAt)
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

/*
 * The same two real parsers, with the freshness the other way round: an app
 * that has been idle long enough for the account poll to overtake the last
 * session's payload. This is the composition the chip is in whenever no
 * session is running, and until the merge compared timestamps the payload's
 * hour-old figures won it — which is what "the numbers never move" was.
 */
const overtaken = mergeUsageWindows(fromLine, fromAccount, at - 3_600_000, at)
check(
  'once the account poll is the fresher read, its figures are what the chip draws',
  [overtaken[0].kind, overtaken[0].percent],
  ['session', 9]
)
check(
  'and the payload-only weekly window is still there beside it, rather than being dropped with its source',
  overtaken.map((w) => w.kind).sort(),
  ['session', 'weekly', 'weekly_scoped']
)

console.log('\nand when the account route cannot answer — offline, or signed out')
check(
  'with nothing from the account, the payload alone still draws both its windows — ' +
    'the meter does not go blank just because auth failed',
  mergeUsageWindows(fromLine, [], at, -Infinity).map((w) => w.kind),
  ['session', 'weekly']
)

console.log('\nwhich token is picked out of a credential blob')
/*
 * The macOS Keychain blob is not just the account. `mcpOAuth` holds one record
 * per connected MCP server, several with a non-empty `accessToken` of their
 * own, and it is enumerated BEFORE `claudeAiOauth`. A first-match-wins scan
 * therefore returned a connector's token, and the endpoint answered 401 —
 * which reads exactly like being signed out, on the one platform where being
 * signed out was already the expected outcome. This is the shape of the real
 * blob read from this machine's login Keychain, with the values replaced.
 */
const blob = {
  mcpOAuth: {
    'plugin:productivity:notion|eac663db': { serverName: 'notion', accessToken: '' },
    'plugin:figma:figma|d39d3b62': { serverName: 'figma', accessToken: 'figu_NOTTHEONE' }
  },
  claudeAiOauth: {
    accessToken: 'sk-ant-oat-REAL',
    refreshToken: 'sk-ant-ort-REAL',
    expiresAt: 1787221714592
  }
}

check('a connector token sitting first does not win', findToken(blob), 'sk-ant-oat-REAL')
check(
  'the prefixed value wins from anywhere, whatever the key is called',
  findToken({ mcpOAuth: { a: { accessToken: 'figu_X' } }, someNewShape: { blob: 'sk-ant-oat-2' } }),
  'sk-ant-oat-2'
)
check(
  'with no prefixed value anywhere, an access-token-shaped key still answers',
  findToken({ claudeAiOauth: { accessToken: 'legacy-shape' } }),
  'legacy-shape'
)
check(
  'but never one belonging to a connector',
  findToken({ mcpOAuth: { a: { accessToken: 'figu_X' } } }),
  null
)
check('nothing at all is null, not a throw', findToken(null), null)

console.log('\nwhich of two credential stores to believe')
/*
 * A macOS machine can hold BOTH `~/.claude/.credentials.json` and the login
 * Keychain item, and they disagree. Measured here: the file held a token that
 * had expired 24 hours earlier while the Keychain held one good for another 8,
 * and the file was read first — so the chip said "Claude Code sign-in has
 * expired" and could never refresh again, with a working credential sitting
 * beside it. Gotcha 36 recorded that the file "does not exist on macOS", which
 * was true when it was written and is not any more; preferring by LOCATION was
 * only ever safe while one of the two could not exist.
 */
const t0 = 1_000_000
const live = { token: 'live', expiresAt: t0 + 60_000, source: 'keychain' as const }
const stale = { token: 'stale', expiresAt: t0 - 60_000, source: 'file' as const }
const undated = { token: 'undated', expiresAt: null, source: 'file' as const }

check('a live token beats a stale one whatever order they arrive in', freshestCredentials([stale, live], t0)?.token, 'live')
check('and the other way round', freshestCredentials([live, stale], t0)?.token, 'live')
check(
  'a token with no stated expiry counts as usable, because it is',
  freshestCredentials([stale, undated], t0)?.token,
  'undated'
)
check('with nothing live, the least stale still comes back so the message can name a time', freshestCredentials([stale], t0)?.token, 'stale')
check('two live ones: the later expiry wins', freshestCredentials([live, { ...live, token: 'later', expiresAt: t0 + 120_000 }], t0)?.token, 'later')
check('nulls are skipped', freshestCredentials([null, stale, null], t0)?.token, 'stale')
check('and nothing at all is null rather than a throw', freshestCredentials([null, null], t0), null)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
// Setting the code rather than calling process.exit: the socket from the live
// request is still closing, and exiting under it trips a libuv assertion on
// Windows that looks like a failure when the run actually succeeded.
process.exitCode = failures ? 1 : 0
