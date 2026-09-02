import type { UsageWindow } from './types'

/**
 * The plan-limit chip's arithmetic, kept pure so a suite can hold it.
 *
 * The chip used to answer "% used" in two unlabelled numbers and leave the
 * reset time to a click and some mental arithmetic. What a person actually
 * asks is "how much is left and when does it come back", so everything here
 * is framed as remaining, with a clock time for the reset and a tone that
 * follows the account's own severity as well as the pace.
 */

/** The three tones a window can carry, worst last. */
export type UsageTone = 'normal' | 'warning' | 'critical'

const RANK: Record<UsageTone, number> = { normal: 0, warning: 1, critical: 2 }

/**
 * Colour follows the account's own severity, then an absolute ceiling, then
 * the pace. The ceiling is new: a window at 95% used and 96% elapsed is not
 * "ahead of pace", so the old rule left it muted — a 5-hour window about to
 * run out is the one state the chip exists to show.
 */
export function tone(w: UsageWindow): UsageTone {
  const sev = w.severity
  if (sev === 'critical' || sev === 'severe' || sev === 'exceeded') return 'critical'
  if (w.percent >= 90) return 'critical'
  if (sev === 'warning') return 'warning'
  if (w.elapsed !== null && w.percent > w.elapsed * 100 + 10) return 'warning'
  return 'normal'
}

/** The worst tone across the windows that run out, for the chip itself. */
export function worstTone(windows: UsageWindow[]): UsageTone {
  let worst: UsageTone = 'normal'
  for (const w of windows) if (RANK[tone(w)] > RANK[worst]) worst = tone(w)
  return worst
}

/** "88% left" — what the chip says instead of "12%". */
export function remainingLabel(w: UsageWindow): string {
  return `${Math.max(0, 100 - Math.round(w.percent))}% left`
}

/**
 * Time until the reset, compact.
 *
 * `resetsAt === null` used to mean only one thing: an account window that had
 * never been touched. From the statusLine payload it means something else too
 * — a window `reading()` parsed a percentage for but no reset for. So a null
 * reset no longer implies zero usage: with usage on the window this says the
 * reset time is unknown, rather than a false "unused" next to a percentage.
 */
export function countdown(resetsAt: number | null, percent: number, now: number): string {
  if (resetsAt === null) return percent > 0 ? 'reset unknown' : 'unused'
  const ms = resetsAt - now
  if (ms <= 0) return 'resetting'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/** Local wall-clock HH:MM. */
export function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/**
 * When the window resets, as a clock time a person can plan around, plus the
 * countdown. Same day: "resets 14:40 · in 2h 13m". Another day: the weekday
 * too, since "resets 09:00" is ambiguous for a week-long window.
 */
export function resetLabel(resetsAt: number | null, percent: number, now: number): string {
  if (resetsAt === null) return countdown(resetsAt, percent, now)
  if (resetsAt <= now) return 'resetting'
  const at = new Date(resetsAt)
  const today = new Date(now)
  const sameDay =
    at.getFullYear() === today.getFullYear() &&
    at.getMonth() === today.getMonth() &&
    at.getDate() === today.getDate()
  const when = sameDay
    ? clock(resetsAt)
    : `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${clock(resetsAt)}`
  return `resets ${when} · in ${countdown(resetsAt, percent, now)}`
}

/**
 * Whether a reading is old enough to say so. Three polls without a fresh
 * reading is well past a hiccup and well short of "hours old" — which is what
 * a payload becomes once its session ends and nothing rewrites it.
 */
export const STALE_AFTER_MS = 90_000

export function isStale(readAt: number, now: number): boolean {
  return Number.isFinite(readAt) && now - readAt > STALE_AFTER_MS
}

/** Short labels for the chip's two rows. */
export function shortLabel(w: UsageWindow): string {
  return w.kind === 'session' ? '5h' : w.kind === 'weekly' ? 'week' : w.label
}
