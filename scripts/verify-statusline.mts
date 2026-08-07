/*
 * Stoke's statusLine wrapper is the only channel that states a session's
 * context window before a token is spent, and the only source of plan limits
 * that works on macOS. Both halves fail silently when they fail: a payload
 * that never lands leaves the meter guessing 200k, and a wrapper that prints
 * something unexpected paints it straight into the user's terminal.
 *
 * So this exercises the REAL generated wrapper under this very node, rather
 * than a re-implementation of it.
 *
 *   node scripts/verify-statusline.mts
 */
import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import {
  readStatusLine,
  statusLineDir,
  statusLinePayloadFile,
  toSnapshot
} from '../src/main/statusLine.ts'
import type { StatusLinePayload } from '../src/shared/types.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

/** The payload captured from claude 2.1.221 after one real request. */
const REAL: StatusLinePayload = {
  session_id: 'a0e0ee79-0000-4000-8000-000000000000',
  model: { id: 'claude-opus-5', display_name: 'Opus 5' },
  context_window: {
    context_window_size: 1_000_000,
    used_percentage: 28,
    current_usage: { input_tokens: 10, cache_read_input_tokens: 15_645 }
  },
  exceeds_200k_tokens: false,
  rate_limits: {
    five_hour: { used_percentage: 15, resets_at: 1_786_078_200 },
    seven_day: { used_percentage: 3, resets_at: 1_786_647_600 }
  }
}

console.log('\nreading the payload')
const snap = toSnapshot('sess-1', REAL, 1_700_000_000_000)
check('the window comes straight out of the payload', snap.contextWindowSize, 1_000_000)
check('so does the percentage', snap.usedPercentage, 28)
check('and the model', [snap.modelId, snap.modelName], ['claude-opus-5', 'Opus 5'])
check('resets_at is seconds in, milliseconds out', snap.fiveHour?.resetsAt, 1_786_078_200_000)
check('the seven-day window converts the same way', snap.sevenDay?.resetsAt, 1_786_647_600_000)
check(
  'percentages carry over',
  [snap.fiveHour?.percent, snap.sevenDay?.percent],
  [15, 3]
)
check('the file mtime is carried as receivedAt', snap.receivedAt, 1_700_000_000_000)

console.log('\nthe payload names its own session, and that wins')
/*
 * The files are named after a KEY, which is the session id for every session
 * Stoke mints one for. A `--continue` session's id is picked by the CLI after
 * launch, so its files are named after a launch key instead — and the payload
 * is then the only place the real id appears at all. E Task 11 relies on this.
 */
check(
  'a payload read under a launch key reports the id the CLI actually chose',
  toSnapshot('launch-key-not-a-session', REAL, 1).sessionId,
  'a0e0ee79-0000-4000-8000-000000000000'
)
check(
  'and a payload that names no session falls back to the key it was read under',
  toSnapshot('launch-key-not-a-session', { context_window: { used_percentage: 4 } }, 1).sessionId,
  'launch-key-not-a-session'
)
check(
  'a blank session_id is not an id',
  toSnapshot('sess-9', { session_id: '   ' }, 1).sessionId,
  'sess-9'
)

console.log('\na CLI that drops fields degrades instead of throwing')
const bare = toSnapshot('sess-2', {}, 5)
check('no context window is null, not zero', bare.contextWindowSize, null)
check('no rate limits is null, not an empty reading', [bare.fiveHour, bare.sevenDay], [null, null])
check('exceeds_200k_tokens defaults to false', bare.exceeds200k, false)
check(
  'a window size outside anything plausible is refused, so it cannot hide an overflow',
  toSnapshot('sess-3', { context_window: { context_window_size: 9_000_000_000 } }, 5)
    .contextWindowSize,
  null
)
check(
  'a window size of zero is below WINDOW_MIN and is refused too',
  toSnapshot('sess-3b', { context_window: { context_window_size: 0 } }, 5).contextWindowSize,
  null
)
check(
  'a legitimate 200k window (Haiku, not just the 1M tier) survives untouched',
  toSnapshot('sess-3c', { context_window: { context_window_size: 200_000 } }, 5).contextWindowSize,
  200_000
)
check(
  'a rate limit with a percentage but no reset is still a reading',
  toSnapshot('sess-4', { rate_limits: { five_hour: { used_percentage: 40 } } }, 5).fiveHour,
  { percent: 40, resetsAt: null }
)
check(
  'a rate limit with a reset but no percentage is dropped entirely, reset and all — deliberate',
  toSnapshot('sess-4b', { rate_limits: { five_hour: { resets_at: 1_786_078_200 } } }, 5).fiveHour,
  null
)

console.log('\nnumeric fields are never coerced from strings')
/*
 * The whole point of this parser is that it trusts `typeof`, never `Number(v)`
 * / `parseInt` / `+v`. A CLI that ever sent a numeric field as a string (or a
 * refactor that started coercing one) must fall back to null, not a confident
 * wrong number. Pinned on every numeric field the parser reads, not just the
 * two context ones.
 */
check(
  'a string-typed context_window_size is refused, not parsed',
  toSnapshot(
    's',
    { context_window: { context_window_size: '1000000', used_percentage: '28' } } as never,
    0
  ).contextWindowSize,
  null
)
check(
  'a string-typed used_percentage is refused the same way',
  toSnapshot(
    's',
    { context_window: { context_window_size: '1000000', used_percentage: '28' } } as never,
    0
  ).usedPercentage,
  null
)
check(
  'a string-typed rate-limit used_percentage is refused, dropping the whole reading',
  toSnapshot(
    'sess-6',
    { rate_limits: { five_hour: { used_percentage: '40', resets_at: 1_786_078_200 } } } as never,
    0
  ).fiveHour,
  null
)
check(
  'a string-typed resets_at is refused on its own — the percent survives, the reset does not',
  toSnapshot(
    'sess-7',
    { rate_limits: { five_hour: { used_percentage: 40, resets_at: '1786078200' } } } as never,
    0
  ).fiveHour,
  { percent: 40, resetsAt: null }
)

console.log('\na non-string session id degrades instead of throwing')
/*
 * TypeScript blocks this in-repo, but Task 10 wires readStatusLine behind IPC,
 * where a renderer argument arrives as `any`. A non-string id must not reach
 * key()'s .replace unguarded.
 */
check('a numeric session id reads as nothing, never a throw', readStatusLine(12345 as never), null)

console.log('\nreading it back off disk')
const dirExistedBefore = existsSync(statusLineDir())
const readId = 'stoke-verify-read'
const readFile = statusLinePayloadFile(readId)
mkdirSync(dirname(readFile), { recursive: true })
writeFileSync(readFile, JSON.stringify(REAL), 'utf8')
/*
 * A known mtime, set after the write so the OS-assigned "now" doesn't get to
 * masquerade as it. utimesSync takes epoch SECONDS; mtimeMs (and receivedAt)
 * is epoch MILLISECONDS — this is the boundary itself, so the test has to
 * cross it explicitly rather than accept whatever the clock says.
 */
const knownMtimeSeconds = 1_700_000_000
utimesSync(readFile, knownMtimeSeconds, knownMtimeSeconds)
const fromDisk = readStatusLine(readId)
check('a written payload reads back', fromDisk?.contextWindowSize, 1_000_000)
check(
  'and receivedAt is the file mtime in milliseconds, not Date.now()',
  fromDisk?.receivedAt,
  knownMtimeSeconds * 1000
)
check('an unknown session reads as nothing at all', readStatusLine('stoke-verify-missing'), null)
writeFileSync(readFile, 'not json', 'utf8')
check('a truncated or garbled file reads as nothing, never a throw', readStatusLine(readId), null)
rmSync(readFile, { force: true })
if (!dirExistedBefore) {
  try {
    rmSync(statusLineDir(), { recursive: true, force: true })
  } catch {
    // Another process may be using the directory; leaving it behind is
    // harmless, and this fixture must never fail the suite on cleanup.
  }
}
check('the payload directory lives under the system temp dir', statusLineDir().startsWith(tmpdir()), true)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
