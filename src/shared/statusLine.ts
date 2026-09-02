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
 * Which statusLine reading answers for the account-wide rate limits.
 *
 * "Newest arrival wins" is what both processes used to do, and it is wrong for
 * this one field group, because **a payload states no rate limits until the
 * first render after an API response completes** (gotcha 21). A tab that was
 * just opened therefore writes the newest payload on the machine and states
 * nothing — and under a plain newest-wins rule it EVICTS a live session's real
 * figures. Reproduced through the real `toSnapshot`: session A carrying
 * `session:18%, weekly:61%` at t-10s against a one-second-old session B
 * carrying none selects B, and the chip gets `[]`.
 *
 * That is the exact opposite of the intent stated where the value is kept —
 * "the rate limits in it are account-wide, so any open session's payload
 * answers for all of them". A payload with no rate limits answers for nothing,
 * so it must not be allowed to answer.
 *
 * The eviction is also sticky rather than momentary: the idle session's later
 * pushes carry its own older payload mtime, so it keeps losing the comparison
 * and cannot win its numbers back until its CLI happens to render a fresh
 * status line.
 *
 * `five_hour` and `seven_day` are independently optional (gotcha 21 again), so
 * this is per window rather than all-or-nothing: a newer payload stating only
 * the five-hour window must not take the weekly one down with it.
 *
 * Everything that is genuinely per-session — the context window, the model, the
 * prompt id, the CLI version — still comes from the newer snapshot. Only the
 * two account-wide readings are retained.
 *
 * The timestamp is that of the OLDEST reading being presented, so a borrowed
 * window can never be advertised as fresher than it is. That errs toward the
 * account endpoint winning the merge below, which is the safe direction: it is
 * authoritative and it is the only source that has the model-scoped window at
 * all. Overstating a payload's freshness is precisely the bug gotcha 45
 * documents.
 */
export function keepUsage(
  prev: StatusLineSnapshot | null,
  next: StatusLineSnapshot
): StatusLineSnapshot {
  if (!prev) return next
  const [newer, older] = next.receivedAt >= prev.receivedAt ? [next, prev] : [prev, next]
  const fiveHour = newer.fiveHour ?? older.fiveHour
  const sevenDay = newer.sevenDay ?? older.sevenDay
  const borrowed =
    (newer.fiveHour === null && fiveHour !== null) || (newer.sevenDay === null && sevenDay !== null)
  return {
    ...newer,
    fiveHour,
    sevenDay,
    receivedAt: borrowed ? older.receivedAt : newer.receivedAt
  }
}

/**
 * Combine the payload's windows with the account's, kind for kind, instead of
 * one source replacing the other outright.
 *
 * Two rules, and they answer different questions.
 *
 * **Figures come from whichever source was read more recently.** `payloadAt`
 * is the payload file's mtime and `accountAt` is when the endpoint answered;
 * the newer of the two states `percent` and `resetsAt`. That "whichever" used
 * to be an unconditional "the payload", on the reasoning that a payload is
 * seconds old where the account is a poll — true *while a session is running*,
 * and false the moment one is not. The payload is the CLI's state as of its
 * last render, and nothing rewrites it after the session ends: `lastStatusLine`
 * in the main process is kept for the whole run precisely so the chip does not
 * blank when the last tab closes, so an hours-old reading stayed on screen,
 * outranking a 30-second-old account poll, for as long as the app was open.
 * From outside that is a chip that has stopped working — the numbers simply
 * never move again, however much of the plan gets spent. Comparing the two
 * timestamps costs nothing and is right in both directions.
 *
 * **Severity always comes from the account**, whichever source won above,
 * because the payload has no field for it (see `statusLineWindows`). A window
 * the account flags `warning` or `critical` must not be downgraded to `normal`
 * just because a payload happened to be fresher.
 *
 * A window only one source carries is kept rather than dropped —
 * `weekly_scoped` is a model-scoped limit the payload has no way to state at
 * all, and the payload's two windows are all there is when the account cannot
 * be reached.
 *
 * Matched on `kind` ('session' | 'weekly' | 'weekly_scoped'), not `label` —
 * the payload only ever produces 'session' and 'weekly' (from
 * five_hour/seven_day), so kind cannot conflate two different windows the way
 * a scoped window's model-name label could.
 *
 * @param payloadAt epoch ms the payload was written, or -Infinity for "no
 *   payload", which makes the account win every comparison by construction.
 * @param accountAt epoch ms the account answered, likewise.
 */
export function mergeUsageWindows(
  payloadWindows: UsageWindow[],
  accountWindows: UsageWindow[],
  payloadAt: number,
  accountAt: number
): UsageWindow[] {
  // Ties go to the payload: within a live session the two are often stamped in
  // the same millisecond, and there the payload really is the fresher of the
  // two — it is rewritten continuously, while the account reading is at best
  // as new as the poll that fetched it.
  const payloadWins = payloadAt >= accountAt

  const out: UsageWindow[] = []
  const seen = new Set<UsageWindow['kind']>()

  // Ordered by the winning source first, so the chip's rows do not reshuffle
  // when the two swap over.
  const [first, second] = payloadWins
    ? [payloadWindows, accountWindows]
    : [accountWindows, payloadWindows]

  for (const w of [...first, ...second]) {
    if (seen.has(w.kind)) continue
    seen.add(w.kind)
    const fromAccount = accountWindows.find((a) => a.kind === w.kind)
    out.push(fromAccount ? { ...w, severity: fromAccount.severity } : w)
  }
  return out
}
