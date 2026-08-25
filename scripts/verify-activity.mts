/**
 * The activity report is the only answer to "what did I work on this week", so
 * the two numbers it states have to be defensible: active time, and lines
 * written. Both are easy to get subtly wrong in ways that still render.
 *
 * Active time is the one with a real trap in it. A session's wall-clock span is
 * not time worked — a real transcript on this machine spans 127.7 hours and
 * holds 12.5 hours of activity at a 5-minute idle cap, 18.4 at 15 minutes — so
 * a report that subtracted first from last would overstate a week by a factor
 * of seven and look entirely plausible doing it.
 *
 *   node scripts/verify-activity.mts
 */
import { bucketActiveMs, dayKey, IDLE_GAP_MS } from '../src/main/activity.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const MIN = 60_000
/** 2026-08-25 in local time, so day boundaries are exercised in the local zone. */
const at = (h: number, m = 0): number => new Date(2026, 7, 25, h, m, 0, 0).getTime()

console.log('\nactive time')

const short = bucketActiveMs([at(9), at(9, 5), at(9, 9)])
check(
  'gaps under the cap accumulate in full',
  short.get(dayKey(at(9))) === 9 * MIN,
  String(short.get(dayKey(at(9))))
)

const long = bucketActiveMs([at(9), at(14)])
check(
  'a gap over the cap contributes exactly the cap, not zero and not its full length',
  long.get(dayKey(at(9))) === IDLE_GAP_MS,
  String(long.get(dayKey(at(9))))
)

const none = bucketActiveMs([at(9)])
check('a single stamp is no elapsed time', none.size === 0)

check('an empty session buckets nothing', bucketActiveMs([]).size === 0)

const unsorted = bucketActiveMs([at(9, 9), at(9), at(9, 5)])
check(
  'stamps out of order are sorted, not treated as negative gaps',
  unsorted.get(dayKey(at(9))) === 9 * MIN,
  String(unsorted.get(dayKey(at(9))))
)

console.log(failed === 0 ? '\nall pass' : `\n${failed} failure(s)`)
process.exitCode = failed === 0 ? 0 : 1
