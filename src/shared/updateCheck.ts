/*
 * "Up to date, checked at 14:32" — the shape of the quiet answer.
 *
 * Both update panels used to say nothing but a full stop. Stoke's own said
 * "Version 0.9.5. Up to date." and the CLI's said "Running 2.1.270, latest is
 * 2.1.270.", and in each case the reader is left with the one question the
 * panel is there to answer: *when did you last actually look?* A version line
 * with no timestamp is indistinguishable from a version line written at boot
 * and never refreshed, which is exactly what a stale checker looks like.
 *
 * Pure and dependency-free so `verify:updates` can pin every boundary. Compiled
 * by both tsconfigs, so no `node:` import (gotcha 27).
 */

/** Minute, in ms. */
const MINUTE = 60_000
/** Hour, in ms. */
const HOUR = 60 * MINUTE

/**
 * What kind of answer `checkedLabel` gave, separated from the words so a suite
 * can assert the boundaries without asserting the prose. Changing "just now" to
 * "a moment ago" should not fail a test about the one-minute threshold.
 */
export type CheckedKind = 'never' | 'just-now' | 'minutes' | 'today' | 'earlier'

export interface CheckedLabel {
  kind: CheckedKind
  /** The short line to paint beside the badge. Empty for 'never'. */
  text: string
  /** The full stamp, for a `title=`. Empty for 'never'. */
  title: string
}

/** Fixed rather than locale-derived, so the same instant reads the same everywhere. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/**
 * How to say when the last check happened.
 *
 * Four bands, each chosen because it is what a person would actually say:
 *
 *   under a minute   "just now"          — a press they have just made
 *   under an hour    "6 min ago"         — relative is the useful frame here
 *   today            "at 14:32"          — "7 hours ago" is arithmetic homework
 *   before today     "12 Sep at 14:32"   — the date starts to matter
 *
 * 24-hour `HH:MM` and a fixed month table rather than `toLocaleString`, on
 * purpose: a locale-formatted string is untestable without pinning the runner's
 * locale AND timezone, and this is the line whose whole job is to be precise. A
 * test can build its input from local calendar parts and get the same answer in
 * any timezone.
 *
 * A `checkedAt` in the FUTURE is clamped to 'just now' rather than rendered as
 * "-3 min ago": clocks move, machines sleep and resume, and NTP steps them
 * backwards. A negative age is a fact about the clock, not about the check.
 *
 * @param checkedAt epoch ms of the last check, or null if there has never been one.
 * @param now       epoch ms, injected so this is a pure function of its inputs.
 */
export function checkedLabel(checkedAt: number | null, now: number): CheckedLabel {
  if (checkedAt === null || !Number.isFinite(checkedAt) || checkedAt <= 0) {
    return { kind: 'never', text: '', title: '' }
  }

  const then = new Date(checkedAt)
  const nowDate = new Date(now)
  const stamp = `${then.getDate()} ${MONTHS[then.getMonth()]} ${then.getFullYear()}, ${hhmm(then)}`
  const age = now - checkedAt

  if (age < MINUTE) return { kind: 'just-now', text: 'checked just now', title: stamp }
  if (age < HOUR) {
    const mins = Math.floor(age / MINUTE)
    return { kind: 'minutes', text: `checked ${mins} min ago`, title: stamp }
  }
  if (sameDay(then, nowDate)) return { kind: 'today', text: `checked at ${hhmm(then)}`, title: stamp }
  return {
    kind: 'earlier',
    text: `checked ${then.getDate()} ${MONTHS[then.getMonth()]} at ${hhmm(then)}`,
    title: stamp
  }
}

/** Everything a panel needs to draw the quiet state, or null when it is not quiet. */
export interface UpToDate {
  /** The pill's words. */
  badge: string
  /** The muted line beside it. */
  checked: string
  /** The pill's `title=`, the full stamp. */
  title: string
}

/**
 * The badge for Stoke's own updates, or null when there is something to say
 * instead.
 *
 * Null is returned for every state that is NOT "nothing to do": downloading, a
 * download waiting to install, an error, a blocked install, an available
 * version, and an unsupported (source) build. Each of those already has its own
 * sentence, and a green "Up to date" badge sitting above an error is worse than
 * no badge at all — which is the failure this ordering exists to prevent, and
 * the same ordering bug the panel above already had once (testing
 * `availableVersion` before `error`, so every failure after one was found had
 * nowhere to appear).
 */
export function selfUpToDate(
  state: {
    supported: boolean
    availableVersion: string | null
    downloaded: boolean
    downloading: boolean
    error: string | null
    blocked: string | null
    checkedAt: number | null
    currentVersion: string
  },
  now: number
): UpToDate | null {
  if (!state.supported) return null
  if (state.downloading || state.downloaded) return null
  if (state.error !== null) return null
  if (state.availableVersion !== null) return null
  // `blocked` deliberately does NOT suppress the badge when there is nothing to
  // install: a build that could not install an update it does not need is up to
  // date in every sense the reader cares about. It suppresses only via
  // `availableVersion` above, which is the case where it actually bites.
  const when = checkedLabel(state.checkedAt, now)
  return { badge: 'Up to date', checked: when.text, title: when.title }
}

/**
 * The same, for the Claude Code CLI.
 *
 * Stricter than it looks, and every clause is a state that must NOT show a
 * green badge:
 *   - `error`          the registry could not be reached, so "up to date" is a
 *                      guess wearing a fact's clothes
 *   - `updateAvailable` there is something to do
 *   - `current === null` the installed version could not be read at all, which
 *                      is how a missing `claude` produces a perfectly
 *                      successful registry lookup and a false all-clear
 *   - `latest === null` nothing came back to compare against
 *   - a lagging channel is handled by the caller's own row and is not a state
 *     this badge should overwrite; `behindLatest` therefore suppresses it too,
 *     since "up to date" is precisely the wrong word for an install twenty-two
 *     releases behind `latest` on a pinned channel (gotcha 46).
 */
export function cliUpToDate(
  info: {
    current: string | null
    latest: string | null
    updateAvailable: boolean
    error: string | null
    checkedAt: number
    behindLatest: unknown | null
  } | null,
  now: number
): UpToDate | null {
  if (info === null) return null
  if (info.error !== null) return null
  if (info.updateAvailable) return null
  if (info.current === null || info.latest === null) return null
  if (info.behindLatest !== null && info.behindLatest !== undefined) return null
  const when = checkedLabel(info.checkedAt, now)
  return { badge: `Up to date`, checked: when.text, title: when.title }
}
