/**
 * Deriving the four accent tokens for a given appearance.
 *
 * This exists because of a bug that shipped for several releases and that no
 * suite could see. A profile auto-activates from the active tab's cwd, and
 * `applyAppearance` wrote the profile's four hand-authored accent hexes onto
 * `:root` with no appearance check. Every profile accent is tuned for a dark
 * ground, so on the light theme they measured 1.43:1 (Amber) to 2.52:1 (Coral)
 * against the page -- and `--accent` is not decoration there: it is the app-wide
 * `:focus-visible` outline, the context ring's stroke, the tab indicator and an
 * input's focus border. The keyboard focus indicator was effectively invisible
 * in light mode.
 *
 * `verify:profiles` asserted only `accentContrast` against `accent` -- the ink
 * on the fill -- so `npm run check` passed throughout. CLAUDE.md gotcha 31.
 *
 * The fix is to stop storing four colours and start storing one, then derive
 * the rest against the ground they will actually be drawn on. A swatch's
 * `accent` is the brand colour: its hue and chroma are what the user picked and
 * are preserved. Only lightness moves, and only when the stored value does not
 * already clear the floor -- so every dark theme keeps the exact accents it has
 * always had, byte for byte, and only the light case changes.
 */
import {
  apcaContrast,
  contrastRatio,
  fitToSrgb,
  maxChroma,
  parseColor,
  toHex,
  toOklch,
  type Oklch,
  type Rgb
} from './color.ts'

export type Appearance = 'light' | 'dark'

export interface AccentTokens {
  /** The brand colour, verbatim. A fill: buttons, chips, the primary action. */
  accent: string
  accentHover: string
  accentSoft: string
  /** Label drawn ON an `accent` fill. */
  accentContrast: string
  /**
   * The accent as a foreground: `color:`, the focus ring, the context ring's
   * stroke, the tab indicator.
   *
   * Separate from `accent` because the two roles have opposite requirements and
   * cannot share a value across both appearances. A fill wants the brand colour
   * unchanged -- someone who picked Coral should get coral -- while a
   * foreground has to clear 4.5:1 and Lc 60 against the page, which on a light
   * page no vivid accent does. Collapsing them is what produced a 1.43:1 focus
   * ring; deriving the fill instead would have silently restyled three of the
   * eight shipped swatches in dark mode, which is a product decision rather
   * than a fix.
   *
   * On a dark page this equals `accent` for most swatches, because there the
   * brand colour already clears both floors.
   */
  accentInk: string
}

/**
 * Both floors, because the two metrics disagree and both have a job.
 *
 * `--accent` is not decoration: it is `color:` in eight rules in app.css as
 * well as the focus ring, so it has to survive a WCAG audit at 4.5:1 AND be
 * perceptually legible by APCA at Lc 60. Neither implies the other here.
 * Measured on Daylight, solving for Lc 60 alone lands at 3.6:1 -- APCA is
 * content and WCAG is not -- so the requirement is the conjunction.
 *
 * The relaxed pair is for a hue that cannot reach the strict pair anywhere in
 * sRGB. No shipped swatch needs it; a user-picked one might.
 */
const ACCENT_LC = 60
const ACCENT_WCAG = 4.5
const ACCENT_LC_FLOOR = 45
const ACCENT_WCAG_FLOOR = 3

/**
 * How close to the floor counts as already there.
 *
 * Without this, five of the eight shipped swatches sit a fraction under Lc 60
 * on a dark page (Ember measures 59.x) and would be nudged by one 8-bit step --
 * #ff9552 to #ff9756 -- changing every dark theme's accent for no legibility
 * gain whatever. A colour within this band is left exactly as authored.
 */
const AT_FLOOR_TOLERANCE = 2

/** How far the hover state moves, in OKLCH L, away from the page. */
const HOVER_STEP = 0.035

/**
 * The smallest hover move still worth calling a hover.
 *
 * Below this the fill is the same colour to the eye, so a button that measured
 * legible would look inert instead. When the preferred direction cannot hold
 * the ink at ACCENT_LC with at least this much movement, the hover goes the
 * OTHER way rather than shrinking to nothing — see `hoverFor`.
 */
const MIN_HOVER_STEP = 0.018

/**
 * The soft wash is alpha, not a solid, and that is load-bearing.
 *
 * It is drawn on four different grounds (`--bg`, `--bg-sunken`, `--surface`,
 * `--bg-elevated`). An alpha fill self-corrects its direction against whatever
 * it lands on -- measured, rgba(255,149,82,0.14) is +9.58 L* over Ember's page
 * and -3.09 L* over Daylight's -- where a solid would be right on one ground
 * and wrong on the other three.
 *
 * The alpha itself still has to differ by appearance. At 0.14 over a near-white
 * the wash darkens the ground by only about 1.1:1, which drags accent-on-wash
 * down to 3.81:1; light needs roughly half again as much to make the same
 * perceptual step.
 */
const SOFT_ALPHA: Record<Appearance, number> = { dark: 0.14, light: 0.22 }

/** Candidate inks for a filled accent button's label. */
const INK_LIGHT = '#ffffff'
const INK_DARK = '#12100e'

function lc(fg: Rgb, bg: Rgb): number {
  return Math.abs(apcaContrast(fg, bg))
}

/**
 * The lightness, searching away from `ground`, at which this hue first clears
 * BOTH thresholds. Returns null when the hue cannot get there inside sRGB.
 *
 * Bisection rather than a closed form because APCA is a piecewise polynomial
 * with clamps, and because the chroma ceiling moves with lightness -- the
 * function being inverted is not one anybody would want to invert by hand.
 * Both metrics are monotone in distance from the ground, so their conjunction
 * is too, and bisection stays valid.
 */
function solveL(
  minLc: number,
  minWcag: number,
  ground: Rgb,
  hue: number,
  chroma: number,
  away: 1 | -1
): number | null {
  const groundL = toOklch(ground).l
  /*
   * Rounded, deliberately. `fitToSrgb` returns fractional components but what
   * ships is an 8-bit hex, so a threshold has to be tested against the value
   * that will actually be painted. Testing the unrounded one converged the
   * light-theme inks to 4.49:1 against a 4.5 requirement -- a failure that
   * would only have surfaced later, in the suite written to catch it.
   */
  const at = (l: number): Rgb => round(fitToSrgb({ l, c: Math.min(chroma, maxChroma(l, hue)), h: hue }))
  const ok = (l: number): boolean => {
    const c = at(l)
    return lc(c, ground) >= minLc && contrastRatio(c, ground) >= minWcag
  }

  // The far end of the search. Away from a light page means darker, and vice
  // versa; if even the extreme cannot clear it, no lightness can.
  const far = away === 1 ? 1 : 0
  if (!ok(far)) return null

  let lo = groundL
  let hi = far
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (!ok(mid)) lo = mid
    else hi = mid
  }

  // Bisection lands within a hair of the boundary and can settle a hair on the
  // wrong side of it once rounded; nudge until it is unambiguously past.
  for (let i = 0; i < 24 && !ok(hi); i++) {
    hi = clamp01(hi + away * 0.002)
  }
  return hi
}

/** 8-bit components, so a measurement matches the hex that will be painted. */
function round(c: Rgb): Rgb {
  return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: c.a }
}

/**
 * Derive the four accent custom properties for one appearance.
 *
 * `pageBg` is the ground the accent is judged against. `--bg` rather than
 * `--bg-sunken` even though the sunken chrome is a slightly harder ground:
 * judging against the harder one would darken every light-mode accent past
 * what the page needs, and the eight `color: var(--accent)` sites are spread
 * across both. The gap is about 4 Lc.
 */
export function deriveAccent(accent: string, appearance: Appearance, pageBg: string): AccentTokens {
  const ground = parseColor(pageBg)
  const brand = parseColor(accent)

  // Nothing here may throw: it runs inside the one effect that writes every
  // colour to :root, and a throw there leaves the app with no palette at all.
  if (!ground || !brand) {
    return {
      accent,
      accentHover: accent,
      accentSoft: accent,
      accentContrast: appearance === 'dark' ? INK_LIGHT : INK_DARK,
      accentInk: accent
    }
  }

  const away: 1 | -1 = appearance === 'dark' ? 1 : -1
  const { h: hue, c: chroma } = toOklch(brand)

  /* ------------------------------------------------------------ the fill */

  /*
   * The fill keeps the brand colour, and only moves for the one failure a fill
   * can actually have: landing in the dead band.
   *
   * There is a roughly 7 L* window (about L* 66-78, varying by hue) in which
   * NEITHER near-white nor near-ink reaches Lc 60 on the fill, so a filled
   * button has no legible label at any ink. Where that happens the fill is
   * nudged out of the band rather than the label accepted as unreadable.
   *
   * THREE shipped swatches need it -- Coral #ff6b6b, Iris #b48ef7 and Azure
   * #6ea8fe all sit in the band -- so this branch is exercised by real data
   * rather than kept for a hypothetical. Measured: without it their labels
   * come out at Lc 55.4, 56.0 and 58.0.
   */
  const white = parseColor(INK_LIGHT)!
  const ink = parseColor(INK_DARK)!
  const bestInkLc = (c: Rgb): number => Math.max(lc(white, round(c)), lc(ink, round(c)))

  let solid = toOklch(brand)
  if (bestInkLc(brand) < ACCENT_LC) {
    // Walk both ways and take whichever escapes the band sooner, so the nudge
    // is the smallest one that works rather than an arbitrary direction.
    let best: Oklch | null = null
    for (const dir of [1, -1] as const) {
      for (let step = 0.005; step <= 0.25; step += 0.005) {
        const cand: Oklch = { l: clamp01(solid.l + dir * step), c: chroma, h: hue }
        if (bestInkLc(fitToSrgb(cand)) >= ACCENT_LC) {
          if (!best || Math.abs(cand.l - solid.l) < Math.abs(best.l - solid.l)) best = cand
          break
        }
      }
    }
    if (best) solid = best
  }

  const solidRgb = fitToSrgb(solid)
  const contrast = lc(white, solidRgb) >= lc(ink, solidRgb) ? INK_LIGHT : INK_DARK

  /*
   * The hover fill has to hold the SAME ink, and it was never checked against
   * it.
   *
   * `--accent-contrast` is chosen once, for the solid fill, and app.css sets it
   * once: `.btn[data-variant='primary']` declares `color: var(--accent-contrast)`
   * and swaps only background and border-color on :hover. So the label sits on
   * both fills and only one of them was ever measured. Moving L by a fixed
   * HOVER_STEP away from the page moves the fill TOWARDS the ink whenever the
   * ink is the far one — which is the ordinary case — so hover always costs
   * contrast, and for a fill that started near the floor it costs enough to
   * cross it.
   *
   * Measured across every built-in theme crossed with every theme and profile
   * accent, 108 combinations: 28 came out under Lc 60 on hover, including
   * Clay's own shipped accent against its own hover (63.3 solid, 57.7 hover)
   * — so this was not only reachable by a user-chosen profile colour. With
   * profiles Coral or Iris active it failed on every built-in theme.
   *
   * Fixed by measuring rather than by shrinking the constant, which would have
   * dulled the hover everywhere to fix it in a quarter of cases.
   */
  const hover = hoverFor(solid, chroma, hue, away, parseColor(contrast)!)

  const a = SOFT_ALPHA[appearance]
  const soft = `rgba(${Math.round(solidRgb.r)}, ${Math.round(solidRgb.g)}, ${Math.round(solidRgb.b)}, ${a})`

  /* ------------------------------------------------------------- the ink */

  /*
   * Keep the brand colour here too when it already clears both floors, which
   * is the common case on a dark page. The tolerance matters: five of the eight
   * shipped swatches sit a fraction under Lc 60 on Ember, and without it they
   * would each shift by one 8-bit step for no legibility gain.
   */
  const inkAlready =
    lc(brand, ground) >= ACCENT_LC - AT_FLOOR_TOLERANCE && contrastRatio(brand, ground) >= ACCENT_WCAG
  const inkL = inkAlready
    ? null
    : (solveL(ACCENT_LC, ACCENT_WCAG, ground, hue, chroma, away) ??
      solveL(ACCENT_LC_FLOOR, ACCENT_WCAG_FLOOR, ground, hue, chroma, away))

  return {
    accent: toHex(solidRgb),
    accentHover: toHex(fitToSrgb(hover)),
    accentSoft: soft,
    accentContrast: contrast,
    accentInk: inkL === null ? toHex(brand) : toHex(fitToSrgb({ l: inkL, c: chroma, h: hue }))
  }
}

/**
 * The hover fill: as much movement as the ink can survive, in the direction
 * that reads as "raised" for this appearance.
 *
 * Three tiers, in order, and the first that holds Lc 60 against `ink` wins.
 *
 *  1. The full HOVER_STEP away from the page. The overwhelmingly common case,
 *     and the reason 80 of the 108 measured combinations are byte-identical to
 *     what shipped before this function existed.
 *  2. A shorter step in that same direction, down to MIN_HOVER_STEP. Keeps the
 *     conventional direction — lighter on dark, darker on light — and merely
 *     asks for less of it.
 *  3. The full step the OTHER way. Moving away from the ink can only raise the
 *     contrast, so this always holds; it is last because it inverts the
 *     affordance, and worth taking only when the alternative is a hover nobody
 *     can see or a label nobody can read.
 *
 * The solid itself is the floor of the search: `bestInkLc(solid) >= ACCENT_LC`
 * is guaranteed above by the dead-band escape, so tier 3 cannot fail to find
 * something and the function always returns a legible fill.
 */
function hoverFor(solid: Oklch, chroma: number, hue: number, away: 1 | -1, ink: Rgb): Oklch {
  const at = (delta: number): Oklch => ({ l: clamp01(solid.l + delta), c: chroma, h: hue })
  const holds = (cand: Oklch): boolean => lc(ink, round(fitToSrgb(cand))) >= ACCENT_LC

  for (let step = HOVER_STEP; step >= MIN_HOVER_STEP; step -= 0.001) {
    const cand = at(away * step)
    if (holds(cand)) return cand
  }

  const flipped = at(-away * HOVER_STEP)
  if (holds(flipped)) return flipped

  // Unreachable given the dead-band escape, but a hover identical to the fill
  // is the honest degenerate answer rather than an illegible one.
  return solid
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n))
}
