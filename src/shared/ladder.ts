/**
 * The twelve-step ladder every built-in theme is generated from.
 *
 * WHY THIS EXISTS. The four themes used to be forty-one hand-picked hex values
 * each, and every measurable defect in them came from the same cause: nothing
 * held the steps apart. Measured across the shipped palette --
 *
 *  - the surface ramps were uneven by 3.5x (Ember) to 6.3x (Nocturne) between
 *    the widest and narrowest consecutive step, and in all three dark themes
 *    the smallest gap was `surfaceHover -> border` (0.012-0.020 OKLCH L, a
 *    1.04:1 contrast), so a control's border was indistinguishable from the
 *    hover state right beside it;
 *  - `--border` and `--border-strong` measured APCA **Lc 0.00** against `--bg`
 *    in Ember -- below the discernibility floor -- while being the sole visual
 *    boundary of `.btn`, `.input`, `.select` and three more, across 56 uses;
 *  - the light theme's elevation had collapsed against the white ceiling: bg,
 *    surface and bgElevated spanned 0.033 OKLCH L at 1.05:1 and 1.04:1, with
 *    `bgElevated` literally `#ffffff` and no headroom left;
 *  - and it inverted its own direction, `surfaceHover` sitting BELOW `bg` while
 *    `surface` sat above it, so a button was lighter than the page at rest and
 *    darker than it hovered.
 *
 * A ladder fixes all four at once because the rungs are fixed first and the
 * colours are solved onto them, rather than chosen and then hopefully checked.
 *
 * SHAPE. Radix's twelve steps, whose semantics are worth stating because every
 * mapping below is an argument about which step a token belongs on:
 *
 *   1  app background                    7  UI element border, focus rings
 *   2  subtle background                 8  hovered / stronger border
 *   3  UI element background             9  solid background (the brand colour)
 *   4  hovered UI element background    10  hovered solid background
 *   5  active / selected UI element     11  low-contrast text
 *   6  subtle borders and separators    12  high-contrast text
 *
 * Steps 1-8 are an EVEN ramp in OKLCH L -- that is the fix for unevenness, and
 * it is why no two adjacent steps can be closer than any other pair. Steps 10,
 * 11 and 12 are not chosen but SOLVED, by bisecting for the lightness that
 * clears a contrast target against the hardest ground they land on. See
 * TEXT_WCAG for which ground that is and why it is not the page.
 *
 * ANCHORING. The dark ladder starts at Stoke's own floor -- Ember's existing
 * `bgSunken` -- rather than Radix's step 1, which is a visibly grey page. A
 * window that is mostly a terminal wants a page that does not glow beside the
 * xterm canvas. The span was then swept and the smallest one that clears the
 * border floors was taken. It cost nothing: the result lands within a few units
 * of Radix's own gray scale anyway (Radix dark 1 #111110, 2 #191918, 8 #706f6c).
 */
import {
  apcaContrast,
  contrastRatio,
  fitToSrgb,
  maxChroma,
  toHex,
  toOklch,
  type Oklch,
  type Rgb
} from './color.ts'

export type Appearance = 'light' | 'dark'

/**
 * Where the ramp starts and how far it runs, in OKLCH L.
 *
 * Both spans were chosen by sweeping and taking the smallest that clears the
 * border thresholds, not by taste:
 *
 *   dark 0.345  -> step 7 lands at APCA Lc 15.3-15.4 against step 2, clearing
 *                  APCA's Lc 15 discernibility floor for a divider or a ring,
 *                  and step 8 at Lc 20.3. At 0.30 they were Lc 11.4 and 16.0.
 *                  0.34 was tried first and left two of the four dark themes at
 *                  Lc 14.95 and 14.99 -- under the floor by 8-bit rounding at
 *                  their particular hues, which is a reason to widen the ramp
 *                  and not to lower the bar.
 *   light 0.17  -> step 7 at Lc 20.6, which is Primer's --borderColor-default
 *                  (Lc 20.5) almost exactly, and step 8 at Lc 24.9.
 *
 * Light runs downward from near-white; dark runs upward from near-black.
 */
const RAMP: Record<Appearance, { from: number; span: number }> = {
  dark: { from: 0.1564, span: 0.345 },
  light: { from: 0.991, span: -0.17 }
}

/**
 * Where a `black` dark ladder starts instead: step 1 within a few units of
 * true black (#040303), so on an OLED panel the chrome all but disappears and
 * the terminal card is the only lit surface. Not L 0 exactly: APCA soft-clamps
 * the darkest greys, and against a #010101 page the subtle border measured
 * Lc 0.00 by the repo's own maths — a hairline nobody could see. 0.10 is the
 * lowest start at which `borderSubtle` clears the Lc 9.5 floor verify:color
 * holds it to, swept across hues. The span is stretched so step 8 lands where
 * it always does; the ramp stays even, and the two border rungs are re-solved
 * against the darker page by the guards in `neutralLadder`. Overriding `bg` by
 * hand was the first attempt, and it broke that evenness.
 */
const BLACK_FROM = 0.1

/**
 * Chroma per step for a NEUTRAL scale, rising through the mid steps.
 *
 * The profile is Radix sand's: almost achromatic at the page, a little more
 * through the middle, easing back at the ink end. The ceiling matters -- past
 * about C 0.020 at L* 96 a neutral stops reading as a warm grey and starts
 * reading as cream. Calibrated: at L* 96 / hue 55, C 0.002 is imperceptible,
 * C 0.010 is perceptibly warm, C 0.020 is cream, C 0.030 is peach. Ember's own
 * `bg` has always been C 0.0064 and nobody has ever called it beige.
 */
const NEUTRAL_CHROMA = [0.0022, 0.003, 0.0038, 0.0046, 0.0054, 0.0062, 0.007, 0.0078] as const

/** Chroma for steps 10-12, where the neutral is carrying text. */
const INK_CHROMA = { low: 0.006, high: 0.008 } as const

/**
 * How hard the neutral is tinted, as a multiplier on the two profiles above.
 *
 * `1` is the calibration those constants were chosen at and is the default
 * everywhere, so every theme that existed before this parameter regenerates
 * byte-for-byte. It exists because the profile above is deliberately pinned at
 * the imperceptible end -- its own comment records the calibration, "C 0.002 is
 * imperceptible, C 0.010 is perceptibly warm, C 0.020 is cream" -- and the page
 * step is C 0.0022. Hue is therefore free to be anything at all without the
 * page changing: measured across the six built-ins, every dark page sits at
 * C 0.003-0.005 over a 200-degree hue spread, and Ember and Clay ship a
 * BYTE-IDENTICAL `bg` and `text` while nominally being a warm grey and a
 * terracotta.
 *
 * So "the themes all look the same" was not a matter of taste and not fixable
 * by picking different hues: at this chroma there is nothing for a hue to
 * change. The multiplier is what makes the neutral hue mean something, which is
 * also what makes it worth putting a hue control in front of someone.
 *
 * The ceiling is measured, not taste, and it is set by CONTRAST rather than by
 * how colourful the page looks. Chroma at a fixed OKLCH L costs a little APCA
 * contrast, and `RAMP`'s span was swept to be the SMALLEST that clears the
 * Lc 15 border floor -- so there is almost no headroom to spend: sweeping every
 * hue at 5-degree steps in both appearances, the worst `border` measures
 * Lc 15.08 at tint 2.0 and hovers at 15.0 all the way up, then falls under the
 * floor at **tint 2.85** for four of 144 seeds. That is the same 8-bit rounding
 * cliff at particular hues that `RAMP`'s own comment records at Lc 14.95.
 *
 * 2.5 is therefore the ceiling: comfortably below the first observed failure,
 * and past the ~2x where the page stops reading as a tinted grey anyway. The
 * promise this keeps is the one the whole seed design rests on -- no position
 * of any slider can produce an illegible palette -- and `verify:theme-gen`
 * sweeps the full range to hold it.
 */
export const TINT_MIN = 0
export const TINT_MAX = 2.5
export const TINT_DEFAULT = 1

export function clampTint(v: number): number {
  return Number.isFinite(v) ? Math.min(TINT_MAX, Math.max(TINT_MIN, v)) : TINT_DEFAULT
}

/**
 * A floor on the chroma of steps 1-5 — the page and its panels — independent
 * of the tint multiplier above.
 *
 * The tint cannot make a theme look different, and that is measurable rather
 * than taste: its ceiling is set by the border floor, and at that ceiling the
 * page lands at C 0.006-0.008, which is under this repo's own 0.04 "same
 * colour" threshold against Ember. Meanwhile the dark themes people actually
 * recognise sit far above it — measured in OKLCH, Nord's page is C 0.023,
 * Dracula 0.022, Tokyo Night 0.021, Catppuccin Mocha 0.030, Rosé Pine 0.026,
 * Solarized 0.049. So the tint reaches the borders and the text, where the
 * contrast budget is spent, and the page needs a control of its own.
 *
 * Steps 6-12 are left to the tint alone. The border and text rungs are solved
 * against step 4, which this DOES move, so the three text rungs and the
 * semantic colours re-solve against the painted page; the two border rungs are
 * held to their Lc 15 floor by `verify:theme-gen`'s sweep, which is what set
 * the ceilings: dark 0.045 keeps `border` at Lc 15.2-15.3 across every hue,
 * and light is capped far lower because ladder.ts calibrates C 0.020 at L* 96
 * as already cream.
 */
export const PAGE_CHROMA_MAX: Record<Appearance, number> = { dark: 0.045, light: 0.015 }

export function clampPageChroma(v: number | undefined, appearance: Appearance): number {
  if (v === undefined || !Number.isFinite(v)) return 0
  return Math.min(PAGE_CHROMA_MAX[appearance], Math.max(0, v))
}

/**
 * What the three text rungs have to clear, and against WHICH ground.
 *
 * Two decisions here, both learned the hard way.
 *
 * FIRST, the ground is step 4, not step 2. Radix defines steps 11 and 12 by
 * APCA against step 2, but Stoke draws `--text-faint` on five different
 * grounds, and the binding one is whichever sits closest in lightness -- the
 * LIGHTEST ground in dark mode and the DARKEST in light mode. Both happen to be
 * step 4 (`surfaceHover` in dark, `bgSunken` in light), so one rule covers both.
 * Solving against the page instead is exactly how `--text-faint` came to
 * promise 4.5:1 "on bg", deliver 5.10 there, and measure 3.99 on a hovered row.
 *
 * SECOND, the targets are WCAG ratios rather than APCA Lc. APCA is the better
 * judge of perceived legibility and it is still reported, but solving for
 * Lc 60 alone lands the light theme's muted text at 3.59:1 -- APCA is content
 * and WCAG is not, the same divergence the accent derivation hit. WCAG is what
 * an audit checks, so WCAG is what is solved for.
 *
 * The three ratios are not invented: they are what the dark ladder already
 * produces at these rungs (4.61 / 6.43 / 10.74 on Ember), so pinning them keeps
 * every dark theme where it is while dragging the light one up to match.
 */
const TEXT_WCAG = { faint: 4.5, muted: 6.0, strong: 10.0 } as const

/** APCA's discernibility floor for a divider or a ring; what `border` is held to. */
const BORDER_LC = 15
/** What `borderSubtle` is held to: the separator step, quieter than a control's edge. */
const BORDER_SUBTLE_LC = 9.5

export interface Ladder {
  /** Steps 1..12, as hex. Index 0 is step 1. */
  steps: string[]
  appearance: Appearance
}

function lc(a: Rgb, b: Rgb): number {
  return Math.abs(apcaContrast(a, b))
}

/** 8-bit, so every measurement matches the hex that will actually be painted. */
function round(c: Rgb): Rgb {
  return { r: Math.round(c.r), g: Math.round(c.g), b: Math.round(c.b), a: c.a }
}

function at(l: number, c: number, h: number): Rgb {
  return round(fitToSrgb({ l, c: Math.min(c, maxChroma(l, h)), h }))
}

/**
 * The lightness, moving away from `ground`, that first reaches `target` Lc.
 *
 * Bisection, then a nudge past the boundary: bisection converges to within a
 * hair of the threshold and 8-bit rounding can drop it back on the wrong side.
 */
function solveLc(target: number, ground: Rgb, hue: number, chroma: number, away: 1 | -1): number {
  return solve((l) => lc(at(l, chroma, hue), ground) >= target, ground, away)
}

/** The same search, against a WCAG ratio rather than an APCA reading. */
function solveWcag(target: number, ground: Rgb, hue: number, chroma: number, away: 1 | -1): number {
  return solve((l) => contrastRatio(at(l, chroma, hue), ground) >= target, ground, away)
}

function solve(ok: (l: number) => boolean, ground: Rgb, away: 1 | -1): number {
  const far = away === 1 ? 1 : 0
  if (!ok(far)) return far

  let lo = toOklch(ground).l
  let hi = far
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (!ok(mid)) lo = mid
    else hi = mid
  }
  for (let i = 0; i < 24 && !ok(hi); i++) hi = Math.min(1, Math.max(0, hi + away * 0.002))
  return hi
}

/**
 * Build a neutral ladder at one hue.
 *
 * Steps 10, 11 and 12 are solved against step 4 -- the hardest ground text
 * lands on in either appearance -- and are what `--text-faint`, `--text-muted`
 * and `--text` become. Only step 9 is interpolated: on a chromatic scale it is
 * the brand colour, and a neutral scale has no real use for it.
 */
export function neutralLadder(
  appearance: Appearance,
  hue: number,
  tint = TINT_DEFAULT,
  pageChroma = 0,
  black = false
): Ladder {
  const from = appearance === 'dark' && black ? BLACK_FROM : RAMP[appearance].from
  // Step 8 stays put, so a black ladder is steeper rather than shifted.
  const span = appearance === 'dark' && black ? RAMP.dark.from + RAMP.dark.span - BLACK_FROM : RAMP[appearance].span
  const away: 1 | -1 = appearance === 'dark' ? 1 : -1
  const k = clampTint(tint)
  const pc = clampPageChroma(pageChroma, appearance)
  const inkLow = INK_CHROMA.low * k
  const inkHigh = INK_CHROMA.high * k

  // Steps 1-5 carry at least the page chroma; `at()` clamps to what sRGB can
  // hold at each lightness, so a dark page asks for less than it is given.
  const chromaAt = (i: number): number => (i < 5 ? Math.max(NEUTRAL_CHROMA[i] * k, pc) : NEUTRAL_CHROMA[i] * k)

  const rungs = Array.from({ length: 8 }, (_, i) => from + (span * i) / 7)
  const steps: Oklch[] = rungs.map((l, i) => ({ l, c: chromaAt(i), h: hue }))

  /*
   * The border floor, held by construction rather than by a swept ceiling.
   *
   * `RAMP`'s span is the smallest that clears APCA Lc 15 for step 7 against
   * the page at tint 1 and no page chroma. Any chroma on the page or the
   * border costs a little contrast, and at particular hues 8-bit rounding
   * drops step 7 to Lc 14.9 — the same cliff `RAMP`'s comment records. Rather
   * than lower the ceilings until a 5-degree sweep happens to pass, step 7 is
   * moved outward until it clears, and step 8 keeps its one-rung lead. At the
   * historical seed (tint 1, page chroma 0) the rung already clears, so the
   * `max` leaves every shipped theme byte-identical; `verify:theme-gen` pins
   * that, and sweeps every hue, tint and page chroma for the floor.
   */
  const page = at(rungs[1], chromaAt(1), hue)
  const need6 = solveLc(BORDER_SUBTLE_LC, page, hue, chromaAt(5), away)
  if (away === 1 ? need6 > steps[5].l : need6 < steps[5].l) steps[5].l = need6
  const need7 = solveLc(BORDER_LC, page, hue, chromaAt(6), away)
  if (away === 1 ? need7 > steps[6].l : need7 < steps[6].l) {
    const lead = rungs[7] - rungs[6]
    steps[6].l = need7
    steps[7].l = Math.min(1, Math.max(0, need7 + lead))
  }

  /*
   * Step 4 is the hardest ground for text in BOTH appearances -- see
   * TEXT_WCAG. It is rebuilt from the SCALED chroma rather than the constant,
   * so the three text rungs are solved against the ground that will actually
   * be painted. Solving against the untinted step 4 would leave the ratios
   * nominally correct and measurably wrong at any tint but 1, which is the
   * same class of error as TEXT_WCAG's own note about solving against the page
   * instead of the binding ground. The same expression as `steps`, so a page
   * chroma moves this ground too.
   */
  const hardest = at(rungs[3], chromaAt(3), hue)
  const l10 = solveWcag(TEXT_WCAG.faint, hardest, hue, inkLow, away)
  const l11 = solveWcag(TEXT_WCAG.muted, hardest, hue, inkLow, away)
  const l12 = solveWcag(TEXT_WCAG.strong, hardest, hue, inkHigh, away)

  // Step 9 is a solid mid-grey, the only rung a neutral scale has no real use
  // for -- a chromatic scale's 9 is the brand colour. Interpolated so the
  // ladder stays complete rather than sparse.
  const l9 = rungs[7] + (l10 - rungs[7]) / 2

  const out = [
    ...steps.map((o) => toHex(at(o.l, o.c, o.h))),
    toHex(at(l9, inkLow, hue)),
    toHex(at(l10, inkLow, hue)),
    toHex(at(l11, inkLow, hue)),
    toHex(at(l12, inkHigh, hue))
  ]
  return { steps: out, appearance }
}

/**
 * A chromatic value placed at a target APCA contrast against the page.
 *
 * Used for `success`/`warning`/`danger`, which are drawn as text far more often
 * than as fills in this app. The hue and the chroma budget come from the
 * theme; only lightness is solved, so a theme's semantic colours stay
 * recognisably themselves while becoming legible.
 *
 * Yellow and orange are why the chroma is clamped per-hue rather than shared:
 * yellow's sRGB chroma cusp sits at L* 90.8, but the highest L* that clears
 * Lc 60 on a near-white page is 63.2 -- so an "accessible yellow" in light mode
 * is an olive or a brown, and asking for more chroma than that just clips.
 */
export function semantic(
  hue: number,
  chroma: number,
  page: Rgb,
  appearance: Appearance,
  targetLc = 60
): string {
  const away: 1 | -1 = appearance === 'dark' ? 1 : -1
  return toHex(at(solveLc(targetLc, page, hue, chroma, away), chroma, hue))
}

/**
 * Which rung each of the eighteen theme tokens sits on.
 *
 * THE TWO COLUMNS DISAGREE ON PURPOSE, and that is the whole reason this table
 * exists rather than one shared list.
 *
 * In dark mode there is headroom above the page, so raised means lighter and
 * everything reads the same way: page, then panels, then controls, then their
 * hover, each one step up.
 *
 * In light mode there is no headroom above white, so the rule inverts:
 * INTERACTION DARKENS, and elevation is carried by border and shadow rather
 * than by lightness. That is Material 3's own conclusion -- its light
 * containers run 98 -> 90, getting DARKER than the surface, while its dark
 * containers run 6 -> 22, getting lighter -- and it is what removes the
 * measured inversion where `surfaceHover` sat below `bg` while `surface` sat
 * above it.
 *
 * `bgElevated` sharing a rung with `surface` is deliberate in both columns.
 * A floating panel is told apart from the page by its shadow and its 1px
 * border, not by a lightness step: in light mode the step alone measures
 * Lc 0.00 and cannot do the job at all, and having it try is what pushed
 * `bgElevated` to #ffffff with nowhere left to go.
 */
const STEP_FOR: Record<Appearance, Record<string, number>> = {
  dark: {
    bgSunken: 1,
    bg: 2,
    bgElevated: 3,
    surface: 3,
    surfaceHover: 4,
    surfaceActive: 5,
    borderSubtle: 6,
    border: 7,
    borderStrong: 8,
    textFaint: 10,
    textMuted: 11,
    text: 12
  },
  light: {
    // Chrome is RECESSED here, not raised: the titlebar, sidebar and status bar
    // sit below the page rather than above it, which is the only direction
    // available once the page is already near-white.
    bgSunken: 4,
    bg: 2,
    bgElevated: 1,
    surface: 1,
    surfaceHover: 3,
    surfaceActive: 5,
    borderSubtle: 6,
    border: 7,
    borderStrong: 8,
    textFaint: 10,
    textMuted: 11,
    text: 12
  }
}

/** Resolve the neutral tokens for one appearance, hue and tint. */
export function neutralTokens(
  appearance: Appearance,
  hue: number,
  tint = TINT_DEFAULT,
  pageChroma = 0,
  black = false
): Record<string, string> {
  const ladder = neutralLadder(appearance, hue, tint, pageChroma, black)
  const out: Record<string, string> = {}
  for (const [token, step] of Object.entries(STEP_FOR[appearance])) {
    out[token] = ladder.steps[step - 1]
  }
  return out
}

/* ------------------------------------------------------------- terminal */

/**
 * The sixteen ANSI slots, generated rather than hand-picked.
 *
 * A light ANSI palette is not a dark one with the background swapped, and the
 * three ways they differ are all counter-intuitive enough that Daylight got
 * every one of them wrong by hand:
 *
 * 1. BRIGHT IS DARKER on a light ground. `bright` is what SGR bold selects, so
 *    it has to GAIN contrast, which means moving away from the background --
 *    lighter on a dark page, darker on a light one. Daylight had all eight
 *    brights lighter than their normals, so contrast fell in all eight and
 *    emphasised text was the least legible text on screen.
 *
 * 2. THE GREYS ARE A RAMP, NOT A POLARITY. Slots 0/8/7/15 run darkest to
 *    lightest in one monotonic line. Daylight had `white` at 1.22:1 and
 *    `brightWhite` at 1.10:1 -- anything emitting ESC[37m was invisible.
 *    Inverting the pair outright, as Catppuccin Latte and Rosé Pine Dawn do,
 *    was measured and rejected: it does not fix the problem, it moves it to
 *    `black` at 1.52:1.
 *
 * 3. CHROMA IS PER HUE. At L* ~47 sRGB allows far more chroma for red and
 *    magenta than for yellow or cyan, so one global saturation either clips the
 *    warm hues or leaves the cool ones flat. Each slot takes the most its own
 *    hue can hold at the lightness that clears the floor.
 */
const ANSI_HUE = {
  red: 29,
  green: 148,
  yellow: 85,
  blue: 250,
  magenta: 320,
  cyan: 195
} as const

/** As colourful as each hue can be while still clearing the contrast floor. */
const ANSI_CHROMA = 0.16

export interface TerminalPalette {
  [slot: string]: string
}

/**
 * Build the sixteen slots plus the greys against a given background.
 *
 * `normalWcag` is the floor every chromatic slot must clear; the bright variant
 * is placed one step further from the background, so it necessarily clears it
 * too. The greys are placed as four rungs of one ramp between the background
 * and the foreground.
 */
export function terminalPalette(
  appearance: Appearance,
  background: string,
  foreground: string,
  normalWcag = 4.5
): TerminalPalette {
  const bg = round(fitToSrgb(toOklch(parseHexOrThrow(background))))
  const away: 1 | -1 = appearance === 'dark' ? 1 : -1
  const step = 0.075

  const out: TerminalPalette = {}
  for (const [name, hue] of Object.entries(ANSI_HUE)) {
    const l = solveWcag(normalWcag, bg, hue, ANSI_CHROMA, away)
    const bright = Math.min(1, Math.max(0, l + away * step))
    out[name] = toHex(at(l, ANSI_CHROMA, hue))
    out[`bright${name[0].toUpperCase()}${name.slice(1)}`] = toHex(at(bright, ANSI_CHROMA, hue))
  }

  /*
   * The four greys: one monotonic ramp, `black` always the darkest and
   * `brightWhite` always the lightest, in BOTH appearances.
   *
   * That ordering is the part worth stating, because it is what decides where
   * the ramp's ends sit -- and the ends are the whole difficulty.
   *
   * On a DARK theme the background is at the dark end, so `black` lands on it.
   * That is correct and universal: slot 0 is a background slot on a dark
   * scheme, which is why verify:color exempts it from the 4.5 floor there and
   * asserts it equals `--surface-hover` instead.
   *
   * On a LIGHT theme the background is at the LIGHT end, so it is
   * `brightWhite` that would vanish into it -- and that is exactly the bug this
   * palette had, at 1.10:1. Running the ramp all the way to the page would
   * reproduce it. So the light end stops short, at whatever lightness still
   * clears `GREY_FLOOR` against the page. The lightest slot on a light ground
   * cannot also be a strong foreground; it can at least be visible.
   *
   * Note what is NOT done here: inverting the pair so `black` becomes a light
   * grey, as Catppuccin Latte and Rosé Pine Dawn do. Measured, that does not
   * fix the problem, it moves it -- `black` lands at 1.52:1 and `brightBlack`
   * at 2.37:1 -- and it costs the one thing a program can actually rely on,
   * that ESC[30m is dark.
   */
  const bgL = toOklch(bg).l
  const ink = parseHexOrThrow(foreground)
  const fgL = toOklch(ink).l
  const greyHue = toOklch(ink).h

  const darkEnd = Math.min(bgL, fgL)
  const lightEnd =
    appearance === 'dark'
      ? Math.max(bgL, fgL)
      : // Pull the light end in off the page until it is at least discernible.
        solveWcag(GREY_FLOOR, bg, greyHue, 0.008, -1)

  const rung = (t: number): string => toHex(at(darkEnd + (lightEnd - darkEnd) * t, 0.008, greyHue))
  // On dark, t=0 lands on the page, which is what `black` should be. On light,
  // t=0 lands on the ink, which is also what `black` should be.
  out.black = appearance === 'dark' ? rung(0.12) : rung(0)
  // 0.45, not 0.4: at 0.4 a dark theme's brightBlack measured 2.79:1, under the
  // 3.2 floor verify:color pins it at. It is the 'dim/comment' slot, so it is
  // allowed to be quiet -- but not to slip below where it already was.
  /*
   * ...and never under the dim-text floor verify:color holds it to. On the
   * warm-grey ladders rung(0.45) clears 3.2:1 on its own, so this changes
   * nothing they ship; on a `black` ladder the page is at L 0 and the same
   * fraction lands at 2.3:1, so the slot is pushed out to the floor instead.
   */
  const dimFloor = toHex(at(solveWcag(BRIGHT_BLACK_WCAG, bg, greyHue, 0.008, away), 0.008, greyHue))
  const dimRung = appearance === 'dark' ? rung(0.45) : rung(0.3)
  out.brightBlack =
    contrastRatio(parseHexOrThrow(dimRung), bg) >= BRIGHT_BLACK_WCAG ? dimRung : dimFloor
  out.white = appearance === 'dark' ? rung(0.72) : rung(0.62)
  out.brightWhite = rung(1)
  return out
}

/**
 * The least a light theme's lightest ANSI grey may contrast with its page.
 *
 * 3:1 is WCAG 1.4.11's non-text minimum. It is not 4.5 because nothing can be:
 * the slot's whole job is to be the palest one, and the alternative to a floor
 * here is the 1.10:1 this palette used to ship.
 */
const GREY_FLOOR = 3

/** The least `brightBlack` — the dim/comment slot — may contrast with the page. */
const BRIGHT_BLACK_WCAG = 3.2

/** Local, because color.ts's parseColor is nullable and this file needs a value. */
function parseHexOrThrow(hex: string): Rgb {
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
}
