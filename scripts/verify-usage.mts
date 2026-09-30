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
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import {
  BACKOFF_FIRST_MS,
  BACKOFF_MAX_MS,
  BACKOFF_STATED_MAX_MS,
  credentialSources,
  fetchUsage,
  findToken,
  freshestCredentials,
  keepLastGood,
  nextBackoff,
  parseUsage,
  readCredentials
} from '../src/main/usage.ts'
import { toSnapshot } from '../src/main/statusLine.ts'
import { keepUsage, mergeUsageWindows, statusLineWindows } from '../src/shared/statusLine.ts'
import {
  codexCredits,
  codexResetMs,
  codexUsageSnapshot,
  codexWindowLabel,
  lastCodexLimits
} from '../src/shared/codexUsage.ts'
import { nextUtcMidnight, openRouterResponse, parseOpenRouterKey } from '../src/shared/openRouterUsage.ts'
import { kimiAuthFrom, kimiCredentialsPath, kimiUsageResponse } from '../src/shared/kimiUsage.ts'
import {
  clineAuthFrom,
  clineBalanceResponse,
  clineBalanceUrl,
  clineBalanceUsd,
  clineBearer,
  clineProvidersPath
} from '../src/shared/clineUsage.ts'
import {
  chipRows,
  claudeWindowsFor,
  openRouterSharers,
  panelGroups,
  usageKey,
  usageRouteFor,
  type UsageRouteContext
} from '../src/shared/usageSources.ts'
import { balanceText, formatUsd, windowResetLabel } from '../src/shared/usageView.ts'
import { CODEX_TAIL_BYTES, newestRollouts, readCodexUsage, readTail } from '../src/main/codexUsage.ts'
import { fetchClineUsage, fetchKimiUsage } from '../src/main/usageVendors.ts'
import {
  fakeSnapshot,
  planUsageSources,
  toReading,
  USAGE_FLOORS,
  UsageScheduler,
  usagePlanInput,
  type UsagePlanInput
} from '../src/main/usageBoard.ts'
import type { AgentAccount } from '../src/shared/accounts.ts'
import type { StatusLineSnapshot, UsageReading, UsageSnapshot } from '../src/shared/types.ts'

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

/* ------------------------------------------------------------- backing off */
/*
 * The chip "never works" bug, in two halves.
 *
 * Measured 2026-09-02: the app took a 429 at 18:08 and set itself a flat
 * fifteen minutes, while a direct call with the same token answered 200 at
 * 18:16 — so it sat out roughly seven minutes of a limit that had lifted, and
 * threw its numbers away for the duration. Both halves are asserted here
 * because neither is reachable through the IPC handler that uses them.
 */
console.log('\nhow long to wait after a failed read')
check('a stated Retry-After is honoured exactly', nextBackoff(0, 30_000), 30_000)
check('and outranks whatever we had escalated to', nextBackoff(8 * 60_000, 5_000), 5_000)
check(
  'a nonsense Retry-After cannot retire the chip for the whole run',
  nextBackoff(0, 99 * 60 * 60_000),
  BACKOFF_STATED_MAX_MS
)
check('with nothing stated, the first wait is a minute, not fifteen', nextBackoff(0), BACKOFF_FIRST_MS)
check('a repeat failure doubles', nextBackoff(BACKOFF_FIRST_MS), 2 * BACKOFF_FIRST_MS)
check('and keeps doubling', nextBackoff(4 * 60_000), 8 * 60_000)
check('up to a ceiling', nextBackoff(BACKOFF_MAX_MS), BACKOFF_MAX_MS)
check('which it does not exceed on the way past', nextBackoff(10 * 60_000), BACKOFF_MAX_MS)
// A success resets the ladder to 0, so the next first failure starts over.
check('after a success the ladder starts again at a minute', nextBackoff(0), BACKOFF_FIRST_MS)

console.log('\na failed read keeps the numbers it failed to refresh')
const goodWindow = {
  kind: 'session' as const,
  label: '5 hours',
  percent: 17,
  severity: 'normal' as const,
  resetsAt: 1788352800000,
  elapsed: 0.1,
  active: true
}
const lastGood = {
  windows: [goodWindow],
  extraCredits: { percent: 0, enabled: false },
  fetchedAt: 1_000,
  error: null
}
const failed = {
  windows: [],
  extraCredits: null,
  fetchedAt: 9_000,
  error: 'Usage unavailable (429).',
  retryAfter: 60_000
}
const kept = keepLastGood(lastGood, failed, 69_000)
check('the windows survive', kept.windows, [goodWindow])
check('so does paid overage', kept.extraCredits, { percent: 0, enabled: false })
// The timestamp belongs to the DATA, not to the attempt — "as of 18:02" has to
// stay true, and it is what makes the meter start marking the reading stale.
check('the timestamp stays with the data it describes', kept.fetchedAt, 1_000)
check('the error is carried beside them, not instead of them', kept.error, 'Usage unavailable (429).')
check('and the next attempt is stated as an absolute time', kept.retryUntil, 69_000)
check(
  'with nothing good to keep, the failure stands alone',
  keepLastGood(null, failed, 69_000).windows,
  []
)
check(
  'an earlier snapshot that was itself empty is not treated as good',
  keepLastGood({ ...lastGood, windows: [] }, failed, 69_000).fetchedAt,
  9_000
)
/*
 * The regression this pair exists to catch: the meter reads windows off the
 * snapshot even when `error` is set, so a snapshot that dropped them would
 * silently blank the chip rather than fail anything.
 */
check(
  'a kept reading still merges as the account source',
  mergeUsageWindows([], kept.windows, -Infinity, kept.fetchedAt).length,
  1
)

/* ================================================================ accounts */
/*
 * Everything below is usage FOR EVERY ACCOUNT: each Claude sign-in's own
 * token and its own backoff, readings that never merge across accounts,
 * Codex's rollout limits, the OpenRouter key and Cline's balance. Every path
 * is synthetic (gotcha 74): a scratch home under the OS temp folder, with a
 * bystander file that must survive, and no read of the real Keychain — every
 * credential file below holds a LIVE token, so `readCredentials` never
 * reaches `security` (it only does when the file's token is missing or dead).
 */
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-verify-usage-')))
const bystander = join(scratch, 'bystander.txt')
writeFileSync(bystander, 'must survive')
const hash8 = (s: string): string => createHash('sha256').update(s.normalize('NFC')).digest('hex').substring(0, 8)
/*
 * A path the code built with node's `join` has backslashes on Windows, where
 * the portability leg runs this suite; compare it by its segments, not its
 * separator. Proven by rehearsing the suite with node:path's join swapped for
 * path.win32's: 10 of these checks failed on their forward-slash literals.
 */
const slashed = (p: string | undefined): string | undefined => p?.replaceAll('\\', '/')

console.log('\neach Claude account reads its own token, from its own two stores')
{
  const user = '/Users/v'
  const def = credentialSources(null, {}, user)
  check('the Default account: ~/.claude/.credentials.json', slashed(def.file), '/Users/v/.claude/.credentials.json')
  check('and the plain Keychain name it has always used', def.keychainService, 'Claude Code-credentials')
  const work = '/Users/v/.stoke/accounts/claude-work'
  const w = credentialSources(work, {}, user)
  check('an account: the file inside its own folder', slashed(w.file), `${work}/.credentials.json`)
  check('and the Keychain item named after its folder (sha256, NFC, 8 hex)', w.keychainService, `Claude Code-credentials-${hash8(work)}`)
  const other = credentialSources('/Users/v/.stoke/accounts/claude-side', {}, user)
  check('two accounts never share a file', other.file === w.file, false)
  check('or a Keychain item', other.keychainService === w.keychainService, false)
  const decomposed = '/Users/Zoé/.stoke/accounts/claude-work'
  check(
    'a decomposed folder name hashes as its composed form, as the CLI normalises it',
    credentialSources(decomposed, {}, user).keychainService,
    `Claude Code-credentials-${hash8('/Users/Zoé/.stoke/accounts/claude-work')}`
  )
  const inherited = credentialSources(null, { CLAUDE_CONFIG_DIR: '/cfg' }, user)
  check('Default under an inherited CLAUDE_CONFIG_DIR reads that folder', [slashed(inherited.file), inherited.keychainService], ['/cfg/.credentials.json', `Claude Code-credentials-${hash8('/cfg')}`])
  check('an account overrides an inherited one, as its launch does', slashed(credentialSources(work, { CLAUDE_CONFIG_DIR: '/cfg' }, user).file), `${work}/.credentials.json`)

  // Two synthetic homes, each with a live token of its own. The blob puts a
  // connector's token first, as the real one does (gotcha 36).
  const homeA = join(scratch, 'claude-a')
  const homeB = join(scratch, 'claude-b')
  const future = Date.now() + 3_600_000
  for (const [home, token] of [[homeA, 'sk-ant-oat-A'], [homeB, 'sk-ant-oat-B']] as const) {
    mkdirSync(home, { recursive: true })
    writeFileSync(
      join(home, '.credentials.json'),
      JSON.stringify({ mcpOAuth: { x: { accessToken: 'figu_NOT' } }, claudeAiOauth: { accessToken: token, expiresAt: future } })
    )
  }
  check('account A reads account A’s token', (await readCredentials(homeA))?.token, 'sk-ant-oat-A')
  check('account B reads account B’s', (await readCredentials(homeB))?.token, 'sk-ant-oat-B')
  check('and from the file, never the Keychain, while the file holds a live one', (await readCredentials(homeA))?.source, 'file')
}

console.log('\neach account keeps its own backoff and its own last good reading')
{
  const win = (percent: number): UsageSnapshot['windows'][number] => ({ kind: 'session', label: '5 hours', percent, severity: 'normal', resetsAt: null, elapsed: null, active: true })
  const ok = (percent: number, at: number, accountId: string): UsageSnapshot => ({ windows: [win(percent)], extraCredits: null, fetchedAt: at, error: null, source: 'anthropic', accountId })
  const limited = (at: number, accountId: string): UsageSnapshot => ({ windows: [], extraCredits: null, fetchedAt: at, error: 'Usage unavailable (429).', retryAfter: 900_000, source: 'anthropic', accountId })
  const s = new UsageScheduler()
  const F = USAGE_FLOORS.anthropic
  const calls: Record<string, number> = {}
  const counted = (key: string, snap: UsageSnapshot) => async (): Promise<UsageSnapshot> => {
    calls[key] = (calls[key] ?? 0) + 1
    return snap
  }
  const t0 = 1_000_000
  await s.read('anthropic:default', 'poll', t0, counted('anthropic:default', ok(10, t0, 'default')), F)
  await s.read('anthropic:claude-work', 'poll', t0, counted('anthropic:claude-work', ok(55, t0, 'claude-work')), F)
  // The work account is rate-limited on its next read; Default is not.
  await s.read('anthropic:claude-work', 'poll', t0 + 31_000, counted('anthropic:claude-work', limited(t0 + 31_000, 'claude-work')), F)
  check('a 429 on one account backs off that account', s.backoffOf('anthropic:claude-work'), 900_000)
  check('and only that one', s.backoffOf('anthropic:default'), 0)
  check('it keeps its OWN last good figures through the 429', s.peek('anthropic:claude-work')?.windows.map((w) => w.percent), [55])
  check('stamped as its own', s.peek('anthropic:claude-work')?.accountId, 'claude-work')
  await s.read('anthropic:default', 'poll', t0 + 62_000, counted('anthropic:default', ok(12, t0 + 62_000, 'default')), F)
  await s.read('anthropic:claude-work', 'message', t0 + 62_000, counted('anthropic:claude-work', ok(99, t0 + 62_000, 'claude-work')), F)
  check('Default is read on its own schedule meanwhile', calls['anthropic:default'], 2)
  check('while the paused account is not knocked on, even for a message', calls['anthropic:claude-work'], 2)
  check('and neither reading ever took the other’s figures', [s.peek('anthropic:default')?.windows[0].percent, s.peek('anthropic:claude-work')?.windows[0].percent], [12, 55])
  // Two reads of one key at once share one request (gotcha 20's claim).
  let slow = 0
  const pending = async (): Promise<UsageSnapshot> => {
    slow++
    await new Promise((r) => setTimeout(r, 5))
    return ok(1, t0, 'claude-x')
  }
  await Promise.all([s.read('anthropic:claude-x', 'poll', t0, pending, F), s.read('anthropic:claude-x', 'poll', t0, pending, F)])
  check('two reads arriving together make one request', slow, 1)
  await s.read('anthropic:default', 'message', t0 + 62_000 + F.message - 1, counted('anthropic:default', ok(13, 0, 'default')), F)
  const inside = calls['anthropic:default']
  await s.read('anthropic:default', 'message', t0 + 62_000 + F.message + 1, counted('anthropic:default', ok(14, 0, 'default')), F)
  check('a message may pre-empt the poll floor, but not its own', [inside, calls['anthropic:default']], [2, 3])
  // A balance-only source keeps its figures through a failure too.
  const balance: UsageSnapshot = { windows: [], extraCredits: null, fetchedAt: 5, error: null, source: 'cline', balances: [{ label: 'Credits', amount: 1.5, unit: 'usd' }] }
  const down: UsageSnapshot = { windows: [], extraCredits: null, fetchedAt: 9, error: 'Cline balance unavailable (503).' }
  check('a balance-only reading is a good one to keep (Cline)', keepLastGood(balance, down, 99).balances?.[0].amount, 1.5)
  s.retain(['anthropic:default'])
  check('a removed account’s state is forgotten, so a new one of that id starts clean', s.peek('anthropic:claude-work'), null)
}

console.log('\nno reading ever merges across accounts, in either direction')
{
  const at = 1_786_076_400_000
  const line = (accountId: string | undefined, five: number): StatusLineSnapshot => ({
    ...toSnapshot(`s-${accountId}`, { session_id: `s-${accountId}`, rate_limits: { five_hour: { used_percentage: five, resets_at: 1_786_078_200 } } }, at),
    ...(accountId ? { accountId } : {})
  })
  const acct = (accountId: string, five: number, fetchedAt: number): UsageSnapshot => ({
    ...parseUsage({ limits: [{ kind: 'session', percent: five, resets_at: null, is_active: true }, { kind: 'weekly_scoped', percent: 3, scope: { model: { display_name: 'Fable' } } }] }, fetchedAt),
    accountId
  })
  const workLine = line('claude-work', 90)
  const defaultSnap = acct('default', 9, at + 1000)
  const forDefault = claudeWindowsFor('default', workLine, defaultSnap, at)
  check('Default with account 2’s payload beside it: only Default’s figures', forDefault.windows.map((w) => `${w.kind}:${w.percent}`), ['session:9', 'weekly_scoped:3'])
  check('and the other payload counts as no payload at all', forDefault.payloadAt, -Infinity)
  const forWork = claudeWindowsFor('claude-work', workLine, defaultSnap, at)
  check('account 2 with Default’s account reading beside it: only its own payload', forWork.windows.map((w) => `${w.kind}:${w.percent}`), ['session:90'])
  check('and Default’s reading counts as none', forWork.accountAt, -Infinity)
  check('an older payload with no account id is the Default account’s', claudeWindowsFor('default', line(undefined, 44), null, at).windows.map((w) => w.percent), [44])
  check('never another account’s', claudeWindowsFor('claude-work', line(undefined, 44), null, at).windows, [])
  const codexShaped: UsageSnapshot = { ...defaultSnap, source: 'codex' }
  check('a Codex reading is never taken as a Claude account’s', claudeWindowsFor('default', null, codexShaped, at).windows, [])
  // keepUsage within and across accounts, both orders.
  const quietWork = { ...line('claude-work', 0), fiveHour: null, receivedAt: at + 5000 }
  check('keepUsage within one account borrows the older figures', keepUsage(workLine, quietWork).fiveHour?.percent, 90)
  check('keepUsage never borrows across accounts (Default after account 2)', keepUsage(workLine, { ...quietWork, accountId: 'default' }).fiveHour, null)
  check('nor the other way round (account 2 after Default)', keepUsage(line('default', 9), quietWork).fiveHour, null)
}

console.log('\nwhich reading answers for which tab')
{
  const acc = (id: string, cli: AgentAccount['cli'], kind: AgentAccount['kind'] = 'login'): AgentAccount => ({ id, cli, label: id, kind, home: kind === 'login' ? `/h/${id}` : '', apiKey: kind === 'key' ? 'k' : '' })
  const accounts = {
    'claude-work': acc('claude-work', 'claude'),
    'codex-work': acc('codex-work', 'codex'),
    'cline-two': acc('cline-two', 'cline'),
    'grok-key': acc('grok-key', 'grok', 'key')
  }
  const ctx: UsageRouteContext = { accounts, claudeAuth: 'default', endpointModes: {} }
  const route = (cli: AgentAccount['cli'], accountId: string, c: UsageRouteContext = ctx): string | null => {
    const r = usageRouteFor({ cli, accountId }, c)
    return r ? usageKey(r.source, r.accountId) : null
  }
  check('Claude on Default: its account', route('claude', 'default'), 'anthropic:default')
  check('Claude on a second account: that account', route('claude', 'claude-work'), 'anthropic:claude-work')
  check('Claude’s Default account routed to OpenRouter spends the key', route('claude', 'default', { ...ctx, claudeAuth: 'openrouter' }), 'openrouter:key')
  check('but a second Claude account is its own sign-in whatever Providers says', route('claude', 'claude-work', { ...ctx, claudeAuth: 'openrouter' }), 'anthropic:claude-work')
  check('Codex on Default: its home’s rollouts', route('codex', 'default'), 'codex:default')
  check('Codex on an account: that account’s', route('codex', 'codex-work'), 'codex:codex-work')
  check('Codex pointed at OpenRouter: the key', route('codex', 'default', { ...ctx, endpointModes: { codex: 'openrouter' } }), 'openrouter:key')
  check('Codex on a custom endpoint: nothing readable', route('codex', 'default', { ...ctx, endpointModes: { codex: 'custom' } }), null)
  check('Cline: its account’s balance', route('cline', 'cline-two'), 'cline:cline-two')
  check('Grok on its own sign-in: nothing readable', route('grok', 'default'), null)
  check('Grok on OpenRouter: the key', route('grok', 'default', { ...ctx, endpointModes: { grok: 'openrouter' } }), 'openrouter:key')
  check('a key account: its key’s usage is not readable', route('grok', 'grok-key'), null)
  check('another agent’s account id: nothing, never Default’s figures', route('claude', 'codex-work'), null)
  check('a removed account: nothing, never Default’s figures', route('claude', 'claude-gone'), null)
  check(
    'the key is shared by exactly the agents pointed at it',
    openRouterSharers({ claudeAuth: 'openrouter', endpointModes: { codex: 'openrouter', grok: 'openrouter', crush: 'openrouter', aider: 'custom' } }),
    ['claude', 'codex', 'grok']
  )

  const input: UsagePlanInput = usagePlanInput({
    accounts,
    providers: { claudeAuth: 'openrouter', openrouterApiKey: 'sk-or-SECRET' },
    agents: { endpoints: { codex: { mode: 'openrouter' } } }
  })
  const plans = planUsageSources(input, { CODEX_HOME: '/c' }, '/Users/v')
  check('every source: each agent’s Default and login accounts, then the key', plans.map((p) => p.key), [
    'anthropic:default',
    'anthropic:claude-work',
    'codex:default',
    'codex:codex-work',
    'kimi:default',
    'cline:default',
    'cline:cline-two',
    'openrouter:key'
  ])
  check('the Default Codex home is CODEX_HOME as inherited', plans.find((p) => p.key === 'codex:default')?.codexHome, '/c')
  check('a Codex account’s is its own home', plans.find((p) => p.key === 'codex:codex-work')?.codexHome, '/h/codex-work')
  check('a Cline account reads providers.json under its own CLINE_DIR', slashed(plans.find((p) => p.key === 'cline:cline-two')?.clinePath), '/h/cline-two/data/settings/providers.json')
  check('the key’s row says who shares it', plans.find((p) => p.key === 'openrouter:key')?.detail, 'shared by 2 agents')
  const wire = JSON.stringify(plans.map((p) => toReading(p, { windows: [], extraCredits: null, fetchedAt: 0, error: null })))
  check('what reaches the renderer never carries the key', wire.includes('sk-or-SECRET'), false)
  check('or a path to a token', wire.includes('providers.json'), false)
  check('no key, no OpenRouter row', planUsageSources({ ...input, openrouterKey: '' }, {}, '/Users/v').some((p) => p.source === 'openrouter'), false)
}

console.log('\nCodex: the limits its last turn stated, from a rollout’s tail')
{
  const now = Date.parse('2026-09-28T07:00:00Z')
  const tc = (rl: unknown, stamp = '2026-09-28T06:07:36.795Z', extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ timestamp: stamp, type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: {} }, rate_limits: rl, ...extra } })
  // The exact shape read off this machine's rollout, values included.
  const real = {
    limit_id: 'codex',
    limit_name: null,
    primary: { used_percent: 0.0, window_minutes: 300, resets_at: 1790593487 },
    secondary: { used_percent: 4.0, window_minutes: 10080, resets_at: 1791008940 },
    credits: { has_credits: false, unlimited: false, balance: null },
    individual_limit: null,
    spend_control_reached: null,
    plan_type: 'team',
    rate_limit_reached_type: null
  }
  const snap = codexUsageSnapshot(lastCodexLimits(tc(real)), now, null)
  check('the two windows, named as the chip names them', snap.windows.map((w) => `${w.kind}:${w.label}:${w.percent}`), ['session:5 hours:0', 'weekly:Weekly:4'])
  check('resets_at is epoch SECONDS, made ms in one place', snap.windows.map((w) => w.resetsAt), [1790593487000, 1791008940000])
  check('the pace marker from the stated window length', snap.windows[0].elapsed, Math.max(0, Math.min(1, (now - (1790593487000 - 300 * 60_000)) / (300 * 60_000))))
  check('the plan as Codex names it', snap.plan, 'team')
  check('no credits row when it has none', snap.balances, undefined)
  check('the reading is as of the turn that stated it, not now', snap.fetchedAt, Date.parse('2026-09-28T06:07:36.795Z'))
  check('and says it is the last turn’s', snap.asOfLastTurn, true)
  check('float noise is rounded', codexUsageSnapshot(lastCodexLimits(tc({ ...real, primary: { ...real.primary, used_percent: 27.500000000000004 } })), now, null).windows[0].percent, 28)
  const noLimits = [tc(real, '2026-09-28T06:00:00Z'), tc(null, '2026-09-28T06:30:00Z'), JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'rate_limits token_count' } })].join('\n')
  check('a later token_count WITHOUT rate_limits does not hide the one before it', lastCodexLimits(noLimits)?.at, Date.parse('2026-09-28T06:00:00Z'))
  const none = codexUsageSnapshot(lastCodexLimits([tc(null), '{"type":"session_meta"}'].join('\n')), now, 123)
  check('a rollout with no limits at all: no windows, and a note, not an error', [none.windows.length, none.error, typeof none.note], [0, null, 'string'])
  const onlyPrimary = codexUsageSnapshot(lastCodexLimits(tc({ ...real, secondary: null })), now, null)
  check('a missing secondary window is simply absent, never 0%', onlyPrimary.windows.map((w) => w.kind), ['session'])
  const noPercent = codexUsageSnapshot(lastCodexLimits(tc({ ...real, primary: { window_minutes: 300, resets_at: 1790593487 } })), now, null)
  check('a window with no used_percent is unknown, not 0%', noPercent.windows.map((w) => w.kind), ['weekly'])
  const later = Date.parse('2026-09-28T12:00:00Z')
  const reset = codexUsageSnapshot(lastCodexLimits(tc(real)), later, null)
  check('a window whose reset passed since that turn is dropped, not drawn at its old figure', reset.windows.map((w) => w.kind), ['weekly'])
  check('and the note says so', /reset since the last Codex turn/.test(reset.note ?? ''), true)
  const buckets = [tc({ ...real, primary: { ...real.primary, used_percent: 10 } }), tc({ ...real, limit_id: 'codex_other_model', primary: { ...real.primary, used_percent: 80 } })].join('\n')
  check('the plan’s own bucket wins over a newer model bucket', lastCodexLimits(buckets)?.primary?.percent, 10)
  check('a tail that begins mid-line skips the fragment', lastCodexLimits(`d":1}}\n${tc(real)}\n`)?.planType, 'team')
  check('an older Codex’s resets_in_seconds counts from the turn', codexResetMs({ resets_in_seconds: 60 }, 1_000_000), 1_060_000)
  check('a reset that is neither is unknown', codexResetMs({}, 1_000_000), null)
  check('a day-long window is named for its length', codexWindowLabel(1440, false), { kind: 'other', label: 'Daily', short: '1d' })
  check('credits: unlimited says so', codexCredits({ hasCredits: true, unlimited: true, balance: null }), { label: 'Credits', amount: null, unit: 'credits', text: 'unlimited' })
  check('credits: a balance is whole credits, never dollars', codexCredits({ hasCredits: true, unlimited: false, balance: '239.6' }), { label: 'Credits', amount: 240, unit: 'credits' })
  check('credits: a balance it will not state is "available"', codexCredits({ hasCredits: true, unlimited: false, balance: null })?.text, 'available')
  check('and it prints as credits', balanceText({ label: 'Credits', amount: 240, unit: 'credits' }), '240 credits')

  // The reader, against a synthetic CODEX_HOME.
  const home = join(scratch, 'codex-home')
  const day = (d: string): string => {
    const dir = join(home, 'sessions', '2026', '09', d)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const older = join(day('27'), 'rollout-2026-09-27T10-00-00-a.jsonl')
  writeFileSync(older, [JSON.stringify({ type: 'session_meta', payload: {} }), tc({ ...real, primary: { ...real.primary, used_percent: 33 } })].join('\n') + '\n')
  // Resumed later: an OLDER day's file written last.
  const resumed = join(day('26'), 'rollout-2026-09-26T09-00-00-b.jsonl')
  writeFileSync(resumed, tc({ ...real, primary: { ...real.primary, used_percent: 61 } }) + '\n')
  // The newest day holds a session with no finished turn.
  const empty = join(day('28'), 'rollout-2026-09-28T11-00-00-c.jsonl')
  writeFileSync(empty, JSON.stringify({ type: 'session_meta', payload: {} }) + '\n')
  const s = (t: number): Date => new Date(t)
  utimesSync(older, s(1_790_000_000_000), s(1_790_000_000_000))
  utimesSync(resumed, s(1_790_000_500_000), s(1_790_000_500_000))
  utimesSync(empty, s(1_790_001_000_000), s(1_790_001_000_000))
  const found = await newestRollouts(join(home, 'sessions'))
  check('rollouts come newest-written first, whatever day folder holds them', found.map((f) => basename(f.path)), [
    'rollout-2026-09-28T11-00-00-c.jsonl',
    'rollout-2026-09-26T09-00-00-b.jsonl',
    'rollout-2026-09-27T10-00-00-a.jsonl'
  ])
  const read = await readCodexUsage(home, now)
  check('the newest rollout that states limits answers; one with none is walked past', read.windows[0]?.percent, 61)
  // A tail read of a file far bigger than the tail, starting inside a 4-byte character.
  const big = join(day('25'), 'rollout-2026-09-25T09-00-00-d.jsonl')
  const filler = JSON.stringify({ type: 'response_item', payload: { text: '\u{1F600}'.repeat(CODEX_TAIL_BYTES / 2) } })
  writeFileSync(big, `${filler}\n${tc({ ...real, primary: { ...real.primary, used_percent: 7 } })}\n`)
  const tail = await readTail(big)
  check('the tail is cut at a newline before decoding: no replacement character', tail.includes('�'), false)
  check('and holds the last line whole', lastCodexLimits(tail)?.primary?.percent, 7)
  check('a home with no sessions folder: a note, never an error', (await readCodexUsage(join(scratch, 'no-codex'), now)).error, null)
}

console.log('\nOpenRouter: the key’s own usage, from /api/v1/key')
{
  const now = Date.parse('2026-09-30T18:00:00Z')
  const body = {
    data: {
      label: 'sk-or-v1-abc...xyz',
      limit: 20,
      limit_remaining: 13.5,
      limit_reset: 'monthly',
      include_byok_in_limit: false,
      usage: 41.2,
      usage_daily: 0.84,
      usage_weekly: 3.1,
      usage_monthly: 6.5,
      is_free_tier: false,
      free_model_daily_requests: { used: 12, limit: 1000, remaining: 988 }
    }
  }
  const snap = parseOpenRouterKey(body, now)
  check('two windows: the key limit and the free-model day', snap.windows.map((w) => `${w.label}:${w.percent}`), ['Key limit:33', 'Free models:1'])
  check('the key limit resets by rule, said rather than computed', windowResetLabel(snap.windows[0], now), 'resets monthly')
  check('the free-model day comes back at UTC midnight', snap.windows[1].resetsAt, Date.parse('2026-10-01T00:00:00Z'))
  check('money is dollars, as stated', snap.balances?.map((b) => `${b.label}=${balanceText(b)}`), ['Key limit left=$13.50', 'Used today=$0.84', 'This month=$6.50', 'Free requests left=988 of 1000'])
  check('the key’s label (part of the key) is never carried', JSON.stringify(snap).includes('sk-or'), false)
  const unlimited = parseOpenRouterKey({ data: { ...body.data, limit: null, limit_remaining: null } }, now)
  check('a null limit: no key-limit window', unlimited.windows.map((w) => w.label), ['Free models'])
  check('and says "no limit", never $0', balanceText(unlimited.balances![0]), 'no limit')
  const freeTier = parseOpenRouterKey({ data: { usage: 0, is_free_tier: true, limit: null, limit_remaining: null } }, now)
  check('a free-tier key says so', freeTier.plan, 'free tier')
  check('with no free_model_daily_requests, no free window rather than a guessed one', freeTier.windows, [])
  check('a body with no data is an error, not zeros', parseOpenRouterKey({}, now).error !== null, true)
  check('401: the key was refused', openRouterResponse(401, null, now).error, 'OpenRouter refused the key in Settings › Agents › Claude Code › Provider & keys.')
  check('429 with Retry-After: the wait it asked for', openRouterResponse(429, null, now, 30).retryAfter, 30_000)
  check('500 with no header: no invented wait', openRouterResponse(500, null, now).retryAfter, undefined)
  check('UTC midnight is computed in UTC', nextUtcMidnight(Date.parse('2026-09-30T23:59:59Z')), Date.parse('2026-10-01T00:00:00Z'))
}

console.log('\nCline: the balance its own CLI shows, in its own unit')
{
  const now = Date.parse('2026-09-30T18:00:00Z')
  const file = (auth: Record<string, unknown> | null, settings: Record<string, unknown> = {}) => ({
    version: 1,
    providers: { cline: { settings: { provider: 'cline', ...settings, ...(auth ? { auth } : {}) }, tokenSource: 'oauth' } }
  })
  const auth = { accessToken: 'workos:eyJ.fake.sig', refreshToken: 'r', expiresAt: now + 60_000, accountId: 'usr-0123456789abcdef' }
  const ok = clineAuthFrom(file(auth), {}, now)
  check('a live sign-in: the token as stored, the user id', ok.ok ? [ok.bearer, ok.userId] : ok, ['workos:eyJ.fake.sig', 'usr-0123456789abcdef'])
  check('a token without the prefix gets it, as Cline sends it', clineBearer('abc'), 'workos:abc')
  check('any case of the prefix is kept as it is', clineBearer('WorkOS:abc'), 'WorkOS:abc')
  check('the balance URL names the user', clineBalanceUrl('usr-1'), 'https://api.cline.bot/api/v1/users/usr-1/balance')
  const expired = clineAuthFrom(file({ ...auth, expiresAt: now - 1 }), {}, now)
  check('an expired sign-in is never sent (only Cline refreshes it)', expired.ok ? 'sent' : expired.kind, 'expired')
  const jwt = (exp: number): string => `workos:x.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.sig`
  const byJwt = clineAuthFrom(file({ ...auth, expiresAt: undefined, accessToken: jwt(Math.floor(now / 1000) + 600) }), {}, now)
  check('with no expiresAt, the JWT’s own exp decides', byJwt.ok, true)
  const undated = clineAuthFrom(file({ ...auth, expiresAt: undefined, accessToken: 'workos:opaque' }), {}, now)
  check('with no expiry anywhere it counts as expired, as Cline treats it', undated.ok ? 'sent' : undated.kind, 'expired')
  const elsewhere = clineAuthFrom(file(auth, { baseUrl: 'https://evil.example' }), {}, now)
  check('a Cline pointed at another server: its token goes nowhere', elsewhere.ok ? 'sent' : elsewhere.kind, 'elsewhere')
  check('nor under a staging environment', (clineAuthFrom(file(auth), { CLINE_ENVIRONMENT: 'staging' }, now) as { kind?: string }).kind, 'elsewhere')
  check('its own production URL written out is fine', clineAuthFrom(file(auth, { baseUrl: 'https://api.cline.bot/' }), {}, now).ok, true)
  check('signed out: says so', (clineAuthFrom(file(null), {}, now) as { kind?: string }).kind, 'signed-out')
  check('an account id that is not an id is refused', (clineAuthFrom(file({ ...auth, accountId: '../me' }), {}, now) as { kind?: string }).kind, 'signed-out')

  check('micro-dollars: 500_000 is $0.50, as its CLI’s own test says', clineBalanceUsd(500_000), 0.5)
  const env200 = clineBalanceResponse(200, { success: true, data: { balance: 12_345_678, userId: 'usr-1' } }, now)
  check('an enveloped answer: the balance in dollars', env200.balances?.[0].amount, 12.345678)
  check('printed exactly as Cline prints it', balanceText(env200.balances![0]), '$12.35')
  check('a bare answer works too', clineBalanceResponse(200, { balance: 5_000_000, userId: 'usr-1' }, now).balances?.[0].amount, 5)
  check('thousands are grouped en-US', formatUsd(12345.678), '$12,345.68')
  check('401: the stored sign-in was refused', clineBalanceResponse(401, { error: 'unauthorized' }, now).error, 'Cline refused its stored sign-in. Open Cline to sign in again.')
  check('and no balance is kept from it', clineBalanceResponse(401, null, now).balances, undefined)
  check('success:false is a failure, not zero', clineBalanceResponse(200, { success: false, error: 'x' }, now).error !== null, true)
  check('a balance that is not a number is unknown, not $0', clineBalanceResponse(200, { success: true, data: { balance: '12' } }, now).error, 'Cline answered without a balance.')
  check('429 carries its Retry-After', clineBalanceResponse(429, null, now, 60).retryAfter, 60_000)
  const pathOf = (env: Record<string, string>): string | undefined => slashed(clineProvidersPath(env, '/Users/v', join))
  check('providers.json: ~/.cline by default', pathOf({}), '/Users/v/.cline/data/settings/providers.json')
  check('CLINE_DIR moves it', pathOf({ CLINE_DIR: '/c' }), '/c/data/settings/providers.json')
  check('CLINE_DATA_DIR outranks CLINE_DIR', pathOf({ CLINE_DIR: '/c', CLINE_DATA_DIR: '/d' }), '/d/settings/providers.json')
  check('CLINE_PROVIDER_SETTINGS_PATH outranks both', pathOf({ CLINE_DIR: '/c', CLINE_PROVIDER_SETTINGS_PATH: '/p.json' }), '/p.json')

  // The reader, against synthetic files — none of which may reach the network.
  const dir = join(scratch, 'cline')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'providers.json')
  writeFileSync(p, JSON.stringify(file({ ...auth, expiresAt: Date.now() - 1 })))
  const before = readFileSync(p, 'utf8')
  const read = await fetchClineUsage(p, {}, Date.now())
  check('an expired token on disk: an error that says to open Cline, and no request', read.error?.startsWith('Cline’s sign-in has expired'), true)
  check('and the file is left exactly as it was (never refreshed, never rewritten)', readFileSync(p, 'utf8'), before)
  writeFileSync(p, JSON.stringify(file(null)))
  check('signed out on disk: a note, not an error to back off from', (await fetchClineUsage(p, {}, Date.now())).error, null)
  check('no providers.json at all: the same', (await fetchClineUsage(join(dir, 'none.json'), {}, Date.now())).error, null)
}

console.log('\nKimi Code: its own /usages, with the token its sign-in left')
{
  const now = Date.parse('2026-09-30T18:00:00Z')
  const tok = (extra: Record<string, unknown> = {}) => ({ access_token: 'kimi-at', refresh_token: 'r', expires_at: Math.floor(now / 1000) + 600, scope: '', token_type: 'Bearer', expires_in: 900, ...extra })
  const ok = kimiAuthFrom(tok(), {}, now)
  check('a live token is sent as stored', ok.ok ? ok.bearer : ok, 'kimi-at')
  check('expires_at is epoch SECONDS: one past it is not sent', (kimiAuthFrom(tok({ expires_at: Math.floor(now / 1000) - 1 }), {}, now) as { kind?: string }).kind, 'expired')
  check('expires_at 0 is never refreshed by Kimi, so it is sent as Kimi would', kimiAuthFrom(tok({ expires_at: 0 }), {}, now).ok, true)
  check('an empty access_token is a revoked one: signed out', (kimiAuthFrom(tok({ access_token: '' }), {}, now) as { kind?: string }).kind, 'signed-out')
  check('a Kimi pointed at another server: nothing is sent', (kimiAuthFrom(tok(), { KIMI_CODE_BASE_URL: 'https://x' }, now) as { kind?: string }).kind, 'elsewhere')
  check('the token lives in the home\u2019s credentials/kimi-code.json', [kimiCredentialsPath({}, '/Users/v', join), kimiCredentialsPath({ KIMI_CODE_HOME: '/k' }, '/Users/v', join)].map(slashed), ['/Users/v/.kimi-code/credentials/kimi-code.json', '/k/credentials/kimi-code.json'])
  const body = { usages: { limit_5h: { used_ratio: 0.1825, reset_time: '2026-09-30T20:00:00Z' }, limit_7d: { used_ratio: '0.4' }, limit_month_total: { used_ratio: 1.7 }, limit_month_code: { used_ratio: 0.2 } }, boosterWallet: { balance: { type: 'BOOSTER', amount: 5_000_000 } } }
  const snap = kimiUsageResponse(200, body, now)
  check('used_ratio 0-1 is percent used, rounded as its /usage prints it', snap.windows.map((w) => `${w.label}:${w.percent}`), ['5 hours:18', 'Weekly:40', 'Monthly:100'])
  check('reset_time is a date string, parsed as its own /usage parses it', snap.windows[0].resetsAt, Date.parse('2026-09-30T20:00:00Z'))
  check('a window with no reset stated has no pace marker', snap.windows[1].elapsed, null)
  check('the month\u2019s code breakdown is not a window of its own', snap.windows.length, 3)
  check('the booster wallet (cents, maybe CNY) is not shown as dollars', snap.balances, undefined)
  check('an omitted window is absent, never 0%', kimiUsageResponse(200, { usages: { limit_7d: { used_ratio: 0.5 } } }, now).windows.map((w) => w.kind), ['weekly'])
  check('a body with no usages is an error, not zeros', kimiUsageResponse(200, {}, now).error !== null, true)
  check('401: the stored sign-in was refused', kimiUsageResponse(401, null, now).error?.startsWith('Kimi Code refused'), true)
  const dir = join(scratch, 'kimi', 'credentials')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'kimi-code.json')
  writeFileSync(file, JSON.stringify(tok({ expires_at: Math.floor(Date.now() / 1000) - 60 })))
  const before = readFileSync(file, 'utf8')
  check('an expired token on disk: an error, and no request', (await fetchKimiUsage(file, {}, Date.now())).error?.startsWith('Kimi Code\u2019s sign-in has expired'), true)
  check('and the file is left exactly as it was', readFileSync(file, 'utf8'), before)
  check('no credentials at all: a note, not an error', (await fetchKimiUsage(join(dir, 'none.json'), {}, Date.now())).error, null)
}

console.log('\nthe fixture a driven run uses (STOKE_FAKE_USAGE=multi) goes through the real parsers')
{
  const now = Date.parse('2026-09-30T18:00:00Z')
  const input = usagePlanInput({
    accounts: { 'claude-work': { id: 'claude-work', cli: 'claude', label: 'Work', kind: 'login', home: '/h/cw', apiKey: '' }, 'codex-work': { id: 'codex-work', cli: 'codex', label: 'Work', kind: 'login', home: '/h/xw', apiKey: '' } },
    providers: { claudeAuth: 'default', openrouterApiKey: '' },
    agents: { endpoints: {} }
  })
  const plans = planUsageSources(input, {}, '/Users/v', 'multi')
  const snaps = Object.fromEntries(plans.map((p) => [p.key, fakeSnapshot(p, now, 'multi')]))
  check('multi lists the key even with none set, so it can be looked at', plans.some((p) => p.key === 'openrouter:key'), true)
  check('Claude Default keeps the fixture it always had', snaps['anthropic:default'].windows.map((w) => w.percent), [9, 64, 0])
  check('a second Claude account has figures of its own', snaps['anthropic:claude-work'].windows[0].percent === 9, false)
  check('each is stamped with its account', snaps['anthropic:claude-work'].accountId, 'claude-work')
  check('the Codex account’s float noise is rounded by the real parser', snaps['codex:codex-work'].windows.map((w) => w.percent), [71, 35])
  check('and its credits come through as credits', balanceText(snaps['codex:codex-work'].balances![0]), '240 credits')
  check('Cline’s 12_340_000 micro-dollars read $12.34', balanceText(snaps['cline:default'].balances![0]), '$12.34')
  check('with any other value only Claude’s accounts are faked', fakeSnapshot(plans.find((p) => p.key === 'codex:default')!, now, '1').windows, [])
  const readings: UsageReading[] = plans.map((p) => toReading(p, snaps[p.key]))
  const groups = panelGroups(readings, 'codex:codex-work')
  check('the panel groups by agent, the shared key last', groups.map((g) => `${g.title}:${g.readings.length}`), ['Claude Code:2', 'Codex CLI:2', 'Kimi Code:1', 'Cline:1', 'OpenRouter:1'])
  const bare = readings.map((r) => (r.source === 'cline' ? { ...r, snapshot: { ...r.snapshot, balances: [] } } : r))
  check('a source with no reading is hidden', panelGroups(bare, 'codex:codex-work').map((g) => g.title), ['Claude Code', 'Codex CLI', 'Kimi Code', 'OpenRouter'])
  check('unless it is the tab in front, so its note is not lost', panelGroups(bare, 'cline:default').map((g) => g.title), ['Claude Code', 'Codex CLI', 'Kimi Code', 'Cline', 'OpenRouter'])
  check('the chip’s rows for Codex: its 5 hours and weekly', chipRows(snaps['codex:default'].windows).map((w) => w.short), ['5h', 'week'])
  check('for OpenRouter, its first two windows', chipRows(snaps['openrouter:key'].windows).map((w) => w.short), ['key', 'free'])
}

/*
 * Live, and opt-in with the account call above: this machine's own newest
 * Codex rollout (read-only), and Cline's balance ONLY when ~/.cline holds a
 * sign-in that is still live — an expired one is reported and never sent.
 * Figures are printed; nothing about the account is.
 */
if (process.env.STOKE_LIVE_USAGE === '1') {
  console.log('\nlive: this machine’s Codex and Cline')
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  if (existsSync(join(codexHome, 'sessions'))) {
    const live = await readCodexUsage(codexHome)
    if (live.error) {
      console.log(`  FAIL  ${live.error}`)
      failures++
    } else if (!live.windows.length) {
      console.log(`  SKIP  no Codex rollout here states limits: ${live.note}`)
    } else {
      console.log(`  PASS  Codex: ${live.windows.map((w) => `${w.label} ${w.percent}%`).join(', ')}; plan ${live.plan ?? 'unstated'}; as of ${new Date(live.fetchedAt).toISOString()}`)
    }
  } else {
    console.log('  SKIP  no Codex sessions folder on this machine')
  }
  const clinePath = clineProvidersPath(process.env, homedir(), join)
  const cline = await fetchClineUsage(clinePath, process.env)
  if (cline.balances?.length) console.log(`  PASS  Cline balance present (${cline.balances.length} figure)`)
  else console.log(`  SKIP  Cline: ${cline.error ?? cline.note ?? 'no reading'}`)
}

rmSync(join(scratch, 'claude-a'), { recursive: true, force: true })
rmSync(join(scratch, 'claude-b'), { recursive: true, force: true })
rmSync(join(scratch, 'codex-home'), { recursive: true, force: true })
rmSync(join(scratch, 'cline'), { recursive: true, force: true })
rmSync(join(scratch, 'kimi'), { recursive: true, force: true })
check('the bystander beside every synthetic home survived', readFileSync(bystander, 'utf8'), 'must survive')
rmSync(scratch, { recursive: true, force: true })

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
// Setting the code rather than calling process.exit: the socket from the live
// request is still closing, and exiting under it trips a libuv assertion on
// Windows that looks like a failure when the run actually succeeded.
process.exitCode = failures ? 1 : 0
