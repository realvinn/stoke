import type { StatusLineSnapshot, UsageWindow } from './types'

/**
 * The statusLine payload's rate limits, in the shape the usage meter already
 * draws.
 *
 * Shared rather than renderer-local so a verify suite can pin the mapping —
 * and deliberately producing `UsageWindow`, not a second shape, so one
 * component renders both sources and the two can never drift into disagreeing
 * about what "5 hours" means.
 */

/** Window lengths, so the pace marker has a start as well as an end. */
export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

/**
 * How far through its window a limit is, 0-1, or null when the reset time is
 * unknown. `resets_at` gives only the end, so the start is inferred from the
 * window's fixed length.
 */
export function elapsedFraction(
  resetsAt: number | null,
  windowMs: number,
  now: number
): number | null {
  if (resetsAt === null) return null
  const startedAt = resetsAt - windowMs
  return Math.max(0, Math.min(1, (now - startedAt) / windowMs))
}

export function statusLineWindows(snap: StatusLineSnapshot, now: number): UsageWindow[] {
  const out: UsageWindow[] = []
  if (snap.fiveHour) {
    out.push({
      kind: 'session',
      label: '5 hours',
      percent: Math.round(snap.fiveHour.percent),
      // The payload states no severity, and inventing one would colour a bar
      // by a rule the account does not use. The pace marker still tones it.
      severity: 'normal',
      resetsAt: snap.fiveHour.resetsAt,
      elapsed: elapsedFraction(snap.fiveHour.resetsAt, FIVE_HOUR_MS, now),
      active: true
    })
  }
  if (snap.sevenDay) {
    out.push({
      kind: 'weekly',
      label: 'Weekly',
      percent: Math.round(snap.sevenDay.percent),
      severity: 'normal',
      resetsAt: snap.sevenDay.resetsAt,
      elapsed: elapsedFraction(snap.sevenDay.resetsAt, SEVEN_DAY_MS, now),
      active: true
    })
  }
  return out
}
