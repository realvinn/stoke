/**
 * The context meter's three colours: green, orange, red.
 *
 * The meter used to be the brand accent while healthy, `--warning` from 70% and
 * `--danger` from 90% on the bar -- and `--warning` at 90% on the tab ring, on
 * purpose, because red in the tab strip was reserved for the worklog dot. The
 * ask was real traffic-light colours: 0-30% green, 31-60% orange, 61-80% red,
 * 81%+ solid red (`contextLevel.ts` owns the bands; this owns the paint).
 *
 * None of the theme's own tokens can supply them, and that is measured rather
 * than assumed. `success`/`warning`/`danger` are solved as TEXT colours (|Lc| 64
 * dark, 72 light -- themeGen.ts), which makes them pastel on a dark page: mint,
 * gold and a coral at OKLCH L 0.80 C 0.12 that reads pink, not red. And there is
 * no orange at all: a hue-55 orange solved the same way lands 0.05-0.07 in
 * perceptual distance from BOTH `warning` and `danger`, where this repo already
 * calls 0.04 "the same colour" (gotcha 44). So these are a separate,
 * graphics-grade scale, derived when the theme is applied -- the same split as
 * `--accent` (a fill) against `--accent-ink` (a foreground), gotcha 44.
 *
 * Derived at apply time rather than stored on `ThemeColors`, so none of the
 * twelve generated literals in themes.ts moves (gotcha 43), `validateTheme`'s
 * whitelist is untouched, and a custom theme gets a scale solved against its own
 * page instead of one filled in from Ember's. The renderer writes it in
 * `applyAppearance`; the phone calls the same function in `loadTheme`, so the
 * two cannot drift.
 *
 * No `node:` import and nothing browser-only: the renderer, the phone bundle and
 * `verify:color` (under node's strip-types) all load this file as it is.
 */
import type { Appearance } from './ladder.ts'
import { contrastRatio, fitToSrgb, maxChroma, parseColor, toHex, type Oklch, type Rgb } from './color.ts'

export interface MeterScale {
  /** 0-30%: green. `--meter-low`. */
  low: string
  /** 31-60%: orange. `--meter-mid`. */
  mid: string
  /**
   * 61% and up: red. `--meter-high`. The 81%+ tier is this same red; what
   * changes there is shape -- a solid disc in the ring, a red-tinted track under
   * the bar -- because "solid" is what the ask said, not "redder".
   */
  high: string
}

/**
 * WCAG 1.4.11: a meter is a non-text graphic, so 3:1 against what it is drawn
 * on. Held against BOTH `--bg` and `--bg-sunken`, i.e. against whichever of the
 * two is harder for this colour: the tab ring sits on `--bg-sunken` for an
 * unselected tab and `--bg` for the selected one, and the bar's own track is
 * `--bg-sunken`. Exported so `verify:color` asserts the number this module
 * solves to rather than a copy of it.
 */
export const METER_WCAG = 3

/**
 * The colour each tier aims for before the floor is applied.
 *
 * Hues are the ask's: green 148 (the same hue as `success`), orange 55, red 27.
 * Chroma is high on purpose -- these are signal colours, not text -- and is
 * clipped per lightness by `fitToSrgb`, so asking for more than sRGB holds at a
 * hue only ever returns the gamut edge, never a shifted hue.
 *
 * Lightness is per tier, and that is what keeps orange and red apart. Solved to
 * one shared contrast target the two land at the same luminance and are
 * separated by hue alone, which measured 0.093 in perceptual distance on the
 * dark themes -- barely over the 0.08 "visibly a different tier" bar. With the
 * orange lighter than the red, as a real traffic light's is, they measure
 * 0.128 dark and 0.118 light.
 *
 * Dark: every value already clears 3:1 on every dark built-in with room to
 * spare (the red is the tightest at 5.2:1), so they paint exactly as written --
 * roughly Tailwind's green/orange/red 500. Light: the orange cannot be both
 * orange and 3:1 on a light sunken ground at L 0.62, so the floor below moves
 * it, which is the case the solver exists for.
 */
const SEED: Record<Appearance, Record<keyof MeterScale, Oklch>> = {
  dark: {
    low: { l: 0.72, c: 0.19, h: 148 },
    mid: { l: 0.74, c: 0.18, h: 55 },
    high: { l: 0.66, c: 0.21, h: 27 }
  },
  light: {
    low: { l: 0.55, c: 0.16, h: 148 },
    mid: { l: 0.62, c: 0.19, h: 55 },
    high: { l: 0.56, c: 0.21, h: 27 }
  }
}

/** 8-bit, so a measurement matches the hex that will actually be painted (gotcha 44). */
function round(c: Rgb): Rgb {
  return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: c.a }
}

/**
 * One tier: the seed if it already clears the floor on every ground, otherwise
 * the smallest move in lightness that does.
 *
 * Kept-if-already-fine rather than always solved, which is `deriveAccent`'s rule
 * for the same reason: a solve-to-the-floor on a dark page lands every tier at
 * exactly 3:1, which is L ~0.5 -- where orange is brown and red is maroon. The
 * floor is a guarantee, not a target.
 *
 * `away` is the direction that raises contrast against a page of this
 * appearance. Bisection is valid on [seed, far] because contrast with both
 * grounds only grows once the colour is past them; if the far end still fails
 * (a custom "dark" theme whose page is mid-grey), the other direction is tried,
 * and if that fails too the seed is returned as written -- nothing here may
 * throw, for the same reason as `deriveAccent`: it runs inside the one effect
 * that writes every colour to :root.
 */
function solveTier(seed: Oklch, grounds: Rgb[], away: 1 | -1): string {
  const at = (l: number): Rgb =>
    round(fitToSrgb({ l, c: Math.min(seed.c, maxChroma(l, seed.h)), h: seed.h }))
  const ok = (l: number): boolean => grounds.every((g) => contrastRatio(at(l), g) >= METER_WCAG)

  if (ok(seed.l)) return toHex(at(seed.l))

  for (const dir of [away, -away] as const) {
    const far = dir === 1 ? 1 : 0
    if (!ok(far)) continue
    let lo = seed.l
    let hi: number = far
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2
      if (ok(mid)) hi = mid
      else lo = mid
    }
    // Bisection settles within a hair of the boundary and 8-bit rounding can
    // drop it back on the wrong side; nudge until it is unambiguously past.
    for (let i = 0; i < 24 && !ok(hi); i++) hi = Math.min(1, Math.max(0, hi + dir * 0.002))
    return toHex(at(hi))
  }
  return toHex(at(seed.l))
}

/**
 * The three meter colours for a theme, solved against its own two grounds.
 *
 * Pure and total: an unparseable ground returns the seeds unsolved rather than
 * throwing, since a missing palette is worse than an unsolved one.
 */
export function meterScale(bg: string, bgSunken: string, appearance: Appearance): MeterScale {
  const seeds = SEED[appearance === 'light' ? 'light' : 'dark']
  const page = parseColor(bg)
  const sunken = parseColor(bgSunken)
  if (!page || !sunken) {
    const plain = (o: Oklch): string => toHex(fitToSrgb(o))
    return { low: plain(seeds.low), mid: plain(seeds.mid), high: plain(seeds.high) }
  }
  const away: 1 | -1 = appearance === 'light' ? -1 : 1
  const grounds = [page, sunken]
  return {
    low: solveTier(seeds.low, grounds, away),
    mid: solveTier(seeds.mid, grounds, away),
    high: solveTier(seeds.high, grounds, away)
  }
}
