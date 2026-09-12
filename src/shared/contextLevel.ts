/**
 * How full a context window is, and which of the meter's four tiers that is.
 *
 * One module with no imports, so the desktop renderer, the phone bundle (the
 * `@shared` alias) and a node strip-types suite all run the same two functions.
 * The rule used to live in four hand copies -- ContextMeter.tsx's private
 * `level()` and three inline ternaries in src/remote/main.ts (the session card,
 * the history row and the terminal's meter chip) -- none exported and none
 * under a suite.
 *
 * The tiers are the ask's: 0-30% green, 31-60% orange, 61-80% red, 81%+ solid
 * red. The paint is `meter.ts`; this is only which tier.
 */

/**
 * New names rather than the old `ok`/`warn`/`critical`, on purpose (gotcha 22):
 * a stylesheet rule still keyed on an old name now matches nothing, so a missed
 * selector shows up as a meter with no colour rather than quietly painting the
 * old amber at 81%.
 */
export type ContextLevel = 'low' | 'mid' | 'high' | 'full'

/**
 * The percent the meter prints -- the caption and the ring's tooltip -- and the
 * one the tier is chosen from, so the colour and the number cannot disagree.
 * They used to: the tier was read off the unrounded ratio while the UI printed
 * `Math.round(ratio * 100)`, so 69.6% said "70%" and was still the healthy
 * colour.
 *
 * `used * 100 / limit` rather than `(used / limit) * 100`: the same number,
 * except that the second form rounds a true half down in places --
 * `(57 / 200) * 100` is 28.499999999999996, so 28.5% printed "28" -- and a
 * printed percent should round the way a reader would.
 *
 * Zero for anything that is not a usable reading: no limit, a limit of 0, a
 * negative or NaN count. Clamped at 100, because an over-full window is full.
 */
export function contextPercent(used: number, limit: number): number {
  if (!(limit > 0) || !(used > 0)) return 0
  return Math.round(Math.min(100, (used * 100) / limit))
}

/**
 * The tier for a percent from `contextPercent`.
 *
 * Banded on the ROUNDED percent, because the bands are integers with gaps
 * (30|31, 60|61, 80|81): on an unrounded one, 30.4% would fall in no band at
 * all. Banding the number the user reads makes the colour change exactly when
 * the printed figure goes from 30 to 31. On the raw ratio that is: below 0.305
 * low, below 0.605 mid, below 0.805 high, otherwise full.
 *
 * Written `>=` from the top so that NaN, which fails every comparison, falls
 * through to `low`. An ascending `<=` chain sends NaN to its last branch and
 * paints solid red.
 */
export function contextLevel(pct: number): ContextLevel {
  if (pct >= 81) return 'full'
  if (pct >= 61) return 'high'
  if (pct >= 31) return 'mid'
  return 'low'
}
