/**
 * Whether the first-run campfire plays, and nothing about how it looks.
 *
 * The whole decision is one pure function over two strings — what version was
 * last seen, and what version is running — precisely so it can be asserted
 * without a window. Everything the splash actually DOES (mounting it, writing
 * the flag back, the timer) is a side effect inside a closure, which is the one
 * shape `npm run check` cannot see (gotcha 31); `verify:welcome` covers this
 * half and the CDP run covers the other.
 *
 * Why a version and not a boolean. A boolean answers "has this machine ever run
 * Stoke", which stops being the interesting question the moment there is a
 * second release: an upgrade is the other moment worth marking, and a boolean
 * has already been spent. Recording the version answers both, costs the same
 * one settings field, and degrades correctly — a file written before this key
 * existed reads as `null`, which is "never seen", which is right for it.
 */

/** How long the splash stays up on its own, in ms. */
export const WELCOME_DISMISS_MS = 3200

/** The most a stored version string may be before it is treated as junk. */
export const WELCOME_SEEN_MAX = 64

export type WelcomeReason =
  /** Nothing recorded: a fresh install, or a settings file older than this key. */
  | 'install'
  /** Recorded, and this build is newer. */
  | 'upgrade'
  /** Recorded, and this build is older — a rollback, or two builds sharing a profile. */
  | 'downgrade'
  /** Recorded and identical. The case that must never play. */
  | 'seen'
  /** The running version could not be read at all. */
  | 'unknown'

export interface WelcomePlan {
  play: boolean
  reason: WelcomeReason
  /**
   * What to store once the splash has been dismissed, or null when there is
   * nothing worth storing. Part of the plan rather than left to the caller so
   * the rule that decides to play and the rule that stops it playing again can
   * never come apart — a caller that recorded something else would loop.
   */
  record: string | null
}

interface Parsed {
  major: number
  minor: number
  patch: number
  /** Prerelease identifiers, empty for a final release. */
  pre: string[]
}

/**
 * Semver, minus build metadata.
 *
 * `+build` is parsed and thrown away because semver says it takes no part in
 * precedence, and `app.getVersion()` never carries one anyway. Anything that is
 * not three dot-separated numbers is refused outright rather than coerced:
 * `Number('x')` is NaN and every comparison against NaN is false, so a lenient
 * parse would make two different versions compare equal and silently mean
 * "seen".
 */
function parseVersion(raw: string): Parsed | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] ? m[4].split('.') : []
  }
}

/** -1, 0 or 1, by semver precedence. */
function compare(a: Parsed, b: Parsed): -1 | 0 | 1 {
  for (const [x, y] of [
    [a.major, b.major],
    [a.minor, b.minor],
    [a.patch, b.patch]
  ]) {
    if (x !== y) return x < y ? -1 : 1
  }
  // "A pre-release version has lower precedence than the normal version."
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const n = Math.min(a.pre.length, b.pre.length)
  for (let i = 0; i < n; i++) {
    const x = a.pre[i]
    const y = b.pre[i]
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    // Numeric identifiers compare numerically and always rank below
    // alphanumeric ones, so 0.9.4-beta.2 sorts under 0.9.4-beta.rc.
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1
    if (xn !== yn) return xn ? -1 : 1
    return x < y ? -1 : 1
  }
  if (a.pre.length === b.pre.length) return 0
  return a.pre.length < b.pre.length ? -1 : 1
}

/**
 * Repair whatever is in `settings.welcomeSeenVersion`.
 *
 * It lives here rather than with the size clamps in `ui.ts` on purpose: this is
 * the same "what counts as a version" rule `welcomePlan` applies, and two copies
 * of one rule in two files is the defect gotcha 62 names. A value that clears
 * this clamp is one `parseVersion` will accept, by construction.
 *
 * Anything refused becomes `null`, which reads as "never seen" and plays the
 * splash once. That is the safe direction: the other one is a machine that can
 * never be shown it again and has no way to say so.
 */
export function clampWelcomeSeen(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const v = value.trim()
  if (!v || v.length > WELCOME_SEEN_MAX) return null
  return parseVersion(v) ? v : null
}

/**
 * Should the campfire play, and what should be recorded when it is dismissed.
 *
 * `current` unreadable is deliberately NOT a reason to play. Playing would be
 * the friendly-looking choice and it is the one that cannot stop: with nothing
 * to record, the next launch asks the same question and gets the same answer,
 * for ever.
 */
export function welcomePlan(seen: string | null | undefined, current: string): WelcomePlan {
  const now = parseVersion(typeof current === 'string' ? current : '')
  if (!now) return { play: false, reason: 'unknown', record: null }
  const record = current.trim()

  const before = parseVersion(clampWelcomeSeen(seen) ?? '')
  if (!before) return { play: true, reason: 'install', record }

  const order = compare(before, now)
  if (order === 0) return { play: false, reason: 'seen', record }
  return { play: true, reason: order < 0 ? 'upgrade' : 'downgrade', record }
}
