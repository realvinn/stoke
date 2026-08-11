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
      // The payload states no severity at all. 'normal' here is only the
      // fallback for when nothing better is available — mergeUsageWindows
      // below is what actually gives a window the account's own severity
      // when the account has a matching one. The pace marker still tones it
      // regardless of severity.
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

/**
 * Combine the payload's windows with the account's, kind for kind, instead of
 * one source replacing the other outright.
 *
 * The payload is fresher when both exist — it is the CLI's own state as of
 * its last render, versus the account endpoint's occasional poll — so a
 * window it carries keeps the payload's `percent` and `resetsAt`. But the
 * payload states no severity (see the comment above), where the account does,
 * and on Windows/Linux — where the account call also works — a window the
 * account itself flags `warning` or `critical` must not be downgraded to
 * `normal` just because a payload happened to exist too. So severity comes
 * from the account's matching window when the account has one, and stays
 * `normal` otherwise.
 *
 * A window only the account carries (`weekly_scoped` — a model-scoped limit;
 * the payload never produces this kind) is kept rather than dropped: the
 * payload simply has no way to state it.
 *
 * Matched on `kind` ('session' | 'weekly' | 'weekly_scoped'), not `label` —
 * the payload only ever produces 'session' and 'weekly' (from
 * five_hour/seven_day), so kind cannot conflate two different windows the way
 * a scoped window's model-name label could.
 */
export function mergeUsageWindows(
  payloadWindows: UsageWindow[],
  accountWindows: UsageWindow[]
): UsageWindow[] {
  const payloadKinds = new Set(payloadWindows.map((w) => w.kind))
  const merged = payloadWindows.map((w) => {
    const match = accountWindows.find((a) => a.kind === w.kind)
    return match ? { ...w, severity: match.severity } : w
  })
  for (const a of accountWindows) {
    if (!payloadKinds.has(a.kind)) merged.push(a)
  }
  return merged
}
