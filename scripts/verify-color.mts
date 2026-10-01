/*
 * Colour maths against published reference values.
 *
 * APCA and OKLab are both easy to implement almost correctly, and the failure
 * mode is not an exception — it is a plausible number that quietly misjudges
 * every contrast pair on every page. These anchors come from the reference
 * implementations, so a regression here shows up as a wrong number rather than
 * as a crash.
 *
 * The maths is the first half. The second half points it at what actually
 * ships: every token in every built-in theme, on every ground app.css draws it
 * on, plus the accent matrix — any profile swatch can be active under any
 * theme, which is the pairing that shipped a 1.43:1 focus ring. Every coding
 * agent's colour is held to the same bars, since any agent can be open under
 * any theme.
 *
 *   node scripts/verify-color.mts
 */
import { deriveAccent } from '../src/shared/accent.ts'
import { AGENT_TEXT_WCAG, agentColorTokens } from '../src/shared/agentColors.ts'
import {
  apcaContrast,
  contrastRatio,
  oklchToRgb,
  over,
  parseColor,
  perceptualDistance,
  toHex,
  toOklch
} from '../src/shared/color.ts'
import type { Rgb } from '../src/shared/color.ts'
import {
  anchorShown,
  clamp01,
  clampHsv,
  colorName,
  FILL_VANISH_RATIO,
  fillVanishes,
  hexToHsv,
  hsvToHex,
  hsvToRgb,
  hueAt,
  hueName,
  hueRingGradient,
  INK_NOTE_DISTANCE,
  inkShift,
  intersectBox,
  parseTyped,
  placePopover,
  pureHue,
  rgbToHsv,
  ringOffset,
  sameColor,
  stepHue,
  stepSv,
  svAt,
  typedIsComplete,
  worstContrast,
  wrapHue
} from '../src/shared/colorPicker.ts'
import { neutralTokens, PAGE_CHROMA_MAX, TINT_MAX } from '../src/shared/ladder.ts'
import { meterScale, METER_WCAG } from '../src/shared/meter.ts'
import { PROFILE_SWATCHES } from '../src/shared/profiles.ts'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUILT_IN_THEMES } from '../src/shared/themes.ts'
import type { Theme } from '../src/shared/types.ts'

let failures = 0

function near(label: string, actual: number, expected: number, tolerance: number): void {
  const ok = Math.abs(actual - expected) <= tolerance
  if (!ok) failures++
  const shown = Number.isFinite(actual) ? actual.toFixed(3) : String(actual)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${shown.padStart(10)}  (expected ~${expected})`
  )
}

function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${JSON.stringify(actual)}`)
}

/**
 * A floor, which is what almost every contrast assertion is. `suffix` carries
 * the second metric into the trailing parenthetical, because a WCAG ratio
 * reported without its APCA reading hides exactly the disagreement this module
 * exists to surface.
 */
/** The mirror of `atLeast`, for a value that must stay BELOW a ceiling. */
function atMost(label: string, actual: number, ceiling: number, suffix = ''): void {
  const ok = actual <= ceiling
  if (!ok) failures++
  const shown = Number.isFinite(actual) ? actual.toFixed(2) : String(actual)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${shown.padStart(10)}  (expected <= ${
      Math.round(ceiling * 100) / 100
    }${suffix})`
  )
}

function atLeast(label: string, actual: number, floor: number, suffix = ''): void {
  const ok = actual >= floor
  if (!ok) failures++
  const shown = Number.isFinite(actual) ? actual.toFixed(2) : String(actual)
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${shown.padStart(10)}  (expected >= ${
      Math.round(floor * 100) / 100
    }${suffix})`
  )
}

/**
 * A measurement that is printed and NOT asserted, with no ok/FAIL of its own so
 * it can never be mistaken for one. Used where a number is knowingly wrong and
 * scheduled to be fixed: a baseline is worth having, a red run about something
 * already known is not.
 */
/** A plain condition, for the checks that are one yes-or-no. */
function okp(label: string, cond: boolean): void {
  if (!cond) failures++
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${label}`)
}

function note(label: string, value: string, suffix = ''): void {
  console.log(`     ${label.padEnd(46)} ${value.padStart(10)}${suffix}`)
}

const rgb = (r: number, g: number, b: number, a = 1): { r: number; g: number; b: number; a: number } => ({ r, g, b, a })
const WHITE = rgb(255, 255, 255)
const BLACK = rgb(0, 0, 0)

console.log('\n-- parsing --')
eq('rgb(1, 2, 3)', parseColor('rgb(1, 2, 3)'), rgb(1, 2, 3))
eq('rgba(1, 2, 3, 0.5)', parseColor('rgba(1, 2, 3, 0.5)'), rgb(1, 2, 3, 0.5))
eq('space syntax rgb(1 2 3 / 0.5)', parseColor('rgb(1 2 3 / 0.5)'), rgb(1, 2, 3, 0.5))
eq('#abc shorthand', parseColor('#abc'), rgb(170, 187, 204))
eq('#aabbcc', parseColor('#aabbcc'), rgb(170, 187, 204))
eq('transparent', parseColor('transparent'), rgb(0, 0, 0, 0))
eq('unparseable returns null', parseColor('some-var(--x)'), null)
eq('toHex round trip', toHex(parseColor('rgb(170, 187, 204)')!), '#aabbcc')

console.log('\n-- WCAG 2 contrast ratio --')
near('black on white', contrastRatio(BLACK, WHITE), 21, 0.01)
near('white on white', contrastRatio(WHITE, WHITE), 1, 0.001)
// #767676 on white is the canonical "exactly passes AA body text" pair.
near('#767676 on white', contrastRatio(parseColor('#767676')!, WHITE), 4.54, 0.02)

console.log('\n-- APCA lightness contrast --')
// Reference values from the APCA-W3 implementation.
near('black text on white bg', apcaContrast(BLACK, WHITE), 106.04, 0.5)
near('white text on black bg', apcaContrast(WHITE, BLACK), -107.88, 0.5)
near('identical colours', apcaContrast(WHITE, WHITE), 0, 0.001)
{
  const lc = apcaContrast(parseColor('#888')!, WHITE)
  const ok = lc > 55 && lc < 70
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${'#888 on white sits in the mid range'.padEnd(46)} ${lc.toFixed(3).padStart(10)}  (expected 55..70)`
  )
}
{
  // Polarity must flip the sign, which is the whole point of using APCA.
  const dark = apcaContrast(BLACK, WHITE)
  const light = apcaContrast(WHITE, BLACK)
  const ok = dark > 0 && light < 0
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${'polarity is signed'.padEnd(46)} ${dark > 0 && light < 0}`)
}

console.log('\n-- OKLCH --')
{
  const w = toOklch(WHITE)
  near('white lightness', w.l, 1, 0.002)
  near('white chroma', w.c, 0, 0.002)
}
{
  const red = toOklch(parseColor('#ff0000')!)
  near('red lightness', red.l, 0.6279, 0.002)
  near('red chroma', red.c, 0.2577, 0.002)
  near('red hue', red.h, 29.23, 0.5)
}

console.log('\n-- perceptual distance --')
{
  // The pair that motivated clustering: visually one colour, two hex codes.
  const d = perceptualDistance(parseColor('#3b82f6')!, parseColor('#3a81f5')!)
  const ok = d < 0.01
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${'near-identical blues collapse'.padEnd(46)} ${d.toFixed(5).padStart(10)}  (expected < 0.01)`
  )
}
{
  const d = perceptualDistance(parseColor('#3b82f6')!, parseColor('#dc2626')!)
  const ok = d > 0.2
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${'blue and red stay apart'.padEnd(46)} ${d.toFixed(5).padStart(10)}  (expected > 0.2)`
  )
}

console.log('\n-- the terminal: text on a translucent selection --')
/*
 * xterm composites `selectionBackground` over `background` itself and paints
 * the blend, so the ground selected text actually sits on is the alpha blend —
 * never the raw rgba() and never the theme background. `minimumContrastRatio`
 * is 1 in TerminalView, which is xterm's off switch, so nothing corrects a bad
 * pair afterwards: whatever these numbers say is what the user reads.
 *
 * The same `selectionForeground` is used whether the terminal has focus or not,
 * so it has to clear 4.5:1 against both grounds.
 */
/** The 16 palette slots, in ANSI order. Read again by the terminal.background section below. */
const ANSI_SLOTS = [
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite'
] as const

for (const theme of BUILT_IN_THEMES) {
  const term = theme.terminal
  const bg = parseColor(term.background)!
  const fg = parseColor(term.selectionForeground)
  const focusedRaw = parseColor(term.selectionBackground)
  const unfocusedRaw = parseColor(term.selectionInactiveBackground)

  if (!fg || !focusedRaw || !unfocusedRaw) {
    failures++
    console.log(
      `FAIL ${`${theme.id}: defines both selection keys`.padEnd(46)} ${'missing'.padStart(10)}  (selectionForeground=${String(
        term.selectionForeground
      )}, selectionInactiveBackground=${String(term.selectionInactiveBackground)})`
    )
    continue
  }

  const focused = over(focusedRaw, bg)
  const unfocused = over(unfocusedRaw, bg)

  for (const [state, ground] of [
    ['focused', focused],
    ['unfocused', unfocused]
  ] as const) {
    const ratio = contrastRatio(fg, ground)
    const ok = ratio >= 4.5
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`${theme.id}: selected text, ${state} (${toHex(ground)})`.padEnd(
        46
      )} ${ratio.toFixed(2).padStart(10)}  (expected >= 4.5)`
    )
  }

  // Why the override is not decorative: these are the palette entries that keep
  // their own colour, and fail, when selectionForeground is absent.
  const below = ANSI_SLOTS.filter((n) => contrastRatio(parseColor(term[n])!, focused) < 4.5)
  const okBelow = below.length >= 1
  if (!okBelow) failures++
  console.log(
    `${okBelow ? 'ok  ' : 'FAIL'} ${`${theme.id}: ansi colours needing the override`.padEnd(
      46
    )} ${`${below.length}/16`.padStart(10)}  (expected >= 1)`
  )

  // An unfocused selection must still read as a selection, and must not read as
  // a focused one. Both are the point of having the second colour at all.
  const seen = perceptualDistance(unfocused, bg)
  const apart = perceptualDistance(focused, unfocused)
  const okPair = seen > 0.02 && apart > 0.02
  if (!okPair) failures++
  console.log(
    `${okPair ? 'ok  ' : 'FAIL'} ${`${theme.id}: unfocused is visible and weaker`.padEnd(
      46
    )} ${`${seen.toFixed(4)}/${apart.toFixed(4)}`.padStart(10)}  (expected both > 0.02)`
  )
}

console.log('\n-- the sidebar: selection must out-rank hover --')
/*
 * The selected project has to read as more chosen than the row the mouse
 * happens to be over. That is a distance, not a taste: how far each state
 * sits from the panel it is drawn on. Hover is `--surface-hover`; selection
 * is whatever `selectedBg` returns, which must stay in step with
 * `--surface-selected` in app.css. If you change one, change the other —
 * this is the assertion that catches it.
 */
/** `--surface-selected` in app.css: color-mix(in srgb, accent 18%, surface-hover). */
const SELECTED_ACCENT_MIX = 0.18

function selectedBg(t: Theme): Rgb {
  const a = parseColor(t.colors.accent)!
  const b = over(parseColor(t.colors.surfaceHover)!, parseColor(t.colors.bgSunken)!)
  const p = SELECTED_ACCENT_MIX
  return {
    r: a.r * p + b.r * (1 - p),
    g: a.g * p + b.g * (1 - p),
    b: a.b * p + b.b * (1 - p),
    a: 1
  }
}

for (const t of BUILT_IN_THEMES) {
  const panel = parseColor(t.colors.bgSunken)!
  const hoverD = perceptualDistance(panel, over(parseColor(t.colors.surfaceHover)!, panel))
  const selD = perceptualDistance(panel, over(selectedBg(t), panel))
  const ok = selD > hoverD
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}: selection vs hover`.padEnd(46)} ${selD
      .toFixed(4)
      .padStart(10)}  (expected > ${hoverD.toFixed(4)})`
  )
}

for (const t of BUILT_IN_THEMES) {
  // The row's own label still has to be readable on whatever selection is.
  const bg = over(selectedBg(t), parseColor(t.colors.bgSunken)!)
  const ratio = contrastRatio(parseColor(t.colors.text)!, bg)
  const ok = ratio >= 4.5
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}: label on a selected row`.padEnd(46)} ${ratio
      .toFixed(2)
      .padStart(10)}  (expected >= 4.5)`
  )
}

console.log('\n-- ink on a danger fill --')
/*
 * Two of the three `--on-danger` sites are button text, so this is a 4.5:1
 * bar, not a 3:1 one. The token has to clear it against every theme's danger
 * fill — a fill that is itself chosen for visibility, which is exactly why a
 * light ink on it does not work: white measures 2.89 / 2.84 / 2.70 on the
 * three dark themes, under half of AA.
 */
/** `--on-danger: var(--bg)` in app.css. If you change one, change the other. */
const ON_DANGER = (t: Theme): string => t.colors.bg

for (const t of BUILT_IN_THEMES) {
  const ratio = contrastRatio(parseColor(ON_DANGER(t))!, parseColor(t.colors.danger)!)
  const ok = ratio >= 4.5
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${`--on-danger on ${t.id}'s danger`.padEnd(46)} ${ratio
      .toFixed(2)
      .padStart(10)}  (expected >= 4.5)`
  )
}

console.log('\n-- why --on-danger stays right for a theme none of the four are --')
/*
 * The loop above only ever proves four numbers. A user can write their own
 * theme - `validateTheme` in shared/themes.ts fills gaps and checks shape,
 * never contrast - so "by construction" has to rest on something that holds
 * for a `--danger` no one has picked yet, not on a sample of four.
 *
 * That something is `contrastRatio`'s own symmetry: it ranks two colours by
 * luminance and divides the lighter by the darker, so which one is called
 * "ink" and which "fill" cannot change the number. `--danger` already has to
 * read as text on a `--bg`-rooted surface for three existing rules with no
 * ratio of its own - color: var(--danger) in .btn[data-variant='danger'],
 * .pill[data-tone='danger'] and .project-missing (app.css:707,895,1034) - and
 * none of that is checked for a custom theme either. `--on-danger: var(--bg)`
 * does not add a check; it makes the danger-fill case inherit that exact,
 * already-unchecked ratio instead of adding a second, different one. A theme
 * whose `--danger` is too close to `--bg` still breaks both sites - this
 * assertion proves they break by the same number, not that either passes.
 */
{
  const pairs: ReadonlyArray<readonly [Rgb, Rgb]> = [
    [BLACK, WHITE],
    [parseColor('#7b2d43')!, parseColor('#d2d205')!],
    ...BUILT_IN_THEMES.map(
      (t) => [parseColor(t.colors.bg)!, parseColor(t.colors.danger)!] as const
    )
  ]
  const ok = pairs.every(([a, b]) => contrastRatio(a, b) === contrastRatio(b, a))
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${'contrastRatio(a, b) === contrastRatio(b, a)'.padEnd(46)} ${`${pairs.length} pairs`.padStart(10)}  (holds for any colour, not just these four)`
  )
}

console.log('\n-- the context meter: green, orange, red on every theme --')
/*
 * --meter-low / --meter-mid / --meter-high, which `applyAppearance` (and the
 * phone's `loadTheme`) write from `meterScale`. Asserted against the real
 * function, not a copy of its output, for every built-in theme.
 *
 * Three properties, each the reason the scale exists at all:
 *
 *  - 3:1 on BOTH --bg and --bg-sunken (WCAG 1.4.11, a non-text graphic). The
 *    ring sits on --bg-sunken on an unselected tab and --bg on the selected
 *    one; the bar's own track is --bg-sunken. `METER_WCAG` is the module's own
 *    export, so this cannot pass by asserting a different number than it solves.
 *  - Adjacent tiers visibly different: perceptual distance >= 0.08, twice the
 *    0.04 this repo calls "the same colour" (gotcha 44). This is the property
 *    the theme's own semantics could NOT give: an orange solved like `warning`
 *    lands 0.05-0.07 from both `warning` and `danger`.
 *  - Still the colour it is named for. A floor can drag lightness far enough
 *    that chroma collapses or the hue shifts in the 8-bit rounding, which would
 *    satisfy the contrast rows and deliver a brown or a grey. The hues are the
 *    seed hues in shared/meter.ts, mirrored because the module exports no seed.
 *
 * Plus the one pairing the ring adds: at 81%+ the worklog dot is --bg drawn ON
 * a --meter-high disc, so that pair needs 3:1 too. `contrastRatio` is symmetric,
 * so it is the --bg floor read from the other side — asserted anyway, under its
 * own name, so a future change to the dot's fill has a row that says what broke.
 */
/** Mirrors the seed hues in shared/meter.ts. */
const METER_HUE = { low: 148, mid: 55, high: 27 } as const
/** Twice the 0.04 this repo treats as "the same colour". */
const METER_TIER_DISTANCE = 0.08
/** Below this a "traffic light" is a grey with a tint; every shipped tier is >= 0.153. */
const METER_MIN_CHROMA = 0.12
/** 8-bit rounding moves hue by well under a degree here; more means a clip moved it. */
const METER_HUE_TOLERANCE = 6

const hueGap = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180)

for (const t of BUILT_IN_THEMES) {
  const scale = meterScale(t.colors.bg, t.colors.bgSunken, t.appearance)
  const bg = parseColor(t.colors.bg)!
  const sunken = parseColor(t.colors.bgSunken)!
  const hover = parseColor(t.colors.surfaceHover)!
  for (const tier of ['low', 'mid', 'high'] as const) {
    const c = parseColor(scale[tier])!
    const onBg = contrastRatio(c, bg)
    const onSunken = contrastRatio(c, sunken)
    const o = toOklch(c)
    const ok =
      onBg >= METER_WCAG &&
      onSunken >= METER_WCAG &&
      o.c >= METER_MIN_CHROMA &&
      hueGap(o.h, METER_HUE[tier]) <= METER_HUE_TOLERANCE
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}: --meter-${tier} ${scale[tier]}`.padEnd(46)} ${`${onBg.toFixed(2)}/${onSunken.toFixed(
        2
      )}`.padStart(10)}  (expected >= ${METER_WCAG} on bg/sunken; C ${o.c.toFixed(3)} >= ${METER_MIN_CHROMA}, H ${o.h.toFixed(
        0
      )} ~${METER_HUE[tier]})`
    )
    // A hovered tab is a third ground the ring passes over. Not part of the
    // solve (it is transient, and in light mode it sits between the other
    // two), so it is printed, not asserted.
    note(`${t.id}: --meter-${tier} on --surface-hover`, contrastRatio(c, hover).toFixed(2))
  }
  const [low, mid, high] = [parseColor(scale.low)!, parseColor(scale.mid)!, parseColor(scale.high)!]
  atLeast(`${t.id}: green vs orange, perceptual distance`, perceptualDistance(low, mid), METER_TIER_DISTANCE)
  atLeast(`${t.id}: orange vs red, perceptual distance`, perceptualDistance(mid, high), METER_TIER_DISTANCE)
  atLeast(`${t.id}: --bg dot on the full ring's red disc`, contrastRatio(bg, high), 3)
}

/*
 * The claim "solved per theme" has to hold for a theme nobody has shipped.
 *
 * The twelve rows above prove twelve pages. A user's theme comes out of the
 * same generator with any hue, tint up to TINT_MAX, a page chroma up to its
 * ceiling and a near-black page — so the generator's range is swept, the same
 * shape as verify:theme-gen's contrast sweep. One line: every seed either keeps
 * all three floors and both distances, or the first few that did not are named.
 */
{
  let swept = 0
  const bad: string[] = []
  let closest = Infinity
  for (const appearance of ['dark', 'light'] as const) {
    for (let hue = 0; hue < 360; hue += 15) {
      for (const tint of [0, 1, TINT_MAX]) {
        for (const pageChroma of [0, PAGE_CHROMA_MAX[appearance]]) {
          for (const black of appearance === 'dark' ? [false, true] : [false]) {
            const n = neutralTokens(appearance, hue, tint, pageChroma, black)
            const s = meterScale(n.bg, n.bgSunken, appearance)
            const grounds = [parseColor(n.bg)!, parseColor(n.bgSunken)!]
            const tiers = [parseColor(s.low)!, parseColor(s.mid)!, parseColor(s.high)!]
            swept++
            const tag = `${appearance} h${hue} t${tint} pc${pageChroma}${black ? ' black' : ''}`
            for (const c of tiers) {
              const worst = Math.min(...grounds.map((g) => contrastRatio(c, g)))
              if (worst < METER_WCAG) bad.push(`${tag}: ${toHex(c)} ${worst.toFixed(2)}:1`)
            }
            const d = Math.min(perceptualDistance(tiers[0], tiers[1]), perceptualDistance(tiers[1], tiers[2]))
            closest = Math.min(closest, d)
            if (d < METER_TIER_DISTANCE) bad.push(`${tag}: tiers ${d.toFixed(3)} apart`)
          }
        }
      }
    }
  }
  const ok = bad.length === 0
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${`${swept} generated themes: floors + distinct tiers`.padEnd(46)} ${`${closest.toFixed(3)}`.padStart(10)}  (closest adjacent tiers; expected >= ${METER_TIER_DISTANCE})${
      ok ? '' : `  ${bad.slice(0, 4).join(' | ')}`
    }`
  )
}

console.log('\n-- the bypass mark: slate beads on the ring track --')
/*
 * `--ring-bypass` in app.css, mirrored: `color-mix(in oklab, --border-strong,
 * --text-faint)` on a dark theme and `... --text-faint 75%)` on a light one. If
 * you change one, change the other — this is the assertion that catches it.
 *
 * Mirrored faithfully rather than approximated: both inputs are opaque, so
 * CSS's premultiplied interpolation reduces to a plain lerp of OKLab L, a and b,
 * which is what `mixOklab` does, then rounds to the 8-bit value that paints. The
 * mix reconstructs ladder step 9, a mid-grey that is always in gamut, so no gamut
 * mapping can make Chromium's answer differ from this one by more than rounding.
 *
 * Held to 3:1 (WCAG 1.4.11) on --bg-sunken, an unselected tab, and on --bg, the
 * selected one. It replaced a --warning dash that measured 10:1 and was the
 * loudest mark on screen, on every tab, for a setting; the job now is to be
 * visible and quiet, and the floor is where "visible" stops. The half-way grey
 * is 2.38:1 on a light --bg-sunken, which is why light mixes further.
 */
const BYPASS_MIX: Record<Theme['appearance'], number> = { dark: 0.5, light: 0.75 }

function mixOklab(a: Rgb, b: Rgb, towardB: number): Rgb {
  const lab = (c: Rgb): [number, number, number] => {
    const o = toOklch(c)
    const h = (o.h * Math.PI) / 180
    return [o.l, o.c * Math.cos(h), o.c * Math.sin(h)]
  }
  const [l1, a1, b1] = lab(a)
  const [l2, a2, b2] = lab(b)
  const l = l1 + (l2 - l1) * towardB
  const x = a1 + (a2 - a1) * towardB
  const y = b1 + (b2 - b1) * towardB
  const out = oklchToRgb({ l, c: Math.hypot(x, y), h: (Math.atan2(y, x) * 180) / Math.PI })
  return { r: Math.round(out.r), g: Math.round(out.g), b: Math.round(out.b), a: 1 }
}

for (const t of BUILT_IN_THEMES) {
  const mark = mixOklab(
    parseColor(t.colors.borderStrong)!,
    parseColor(t.colors.textFaint)!,
    BYPASS_MIX[t.appearance]
  )
  const onSunken = contrastRatio(mark, parseColor(t.colors.bgSunken)!)
  const onBg = contrastRatio(mark, parseColor(t.colors.bg)!)
  const ok = onSunken >= 3 && onBg >= 3
  if (!ok) failures++
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}: --ring-bypass ${toHex(mark)}`.padEnd(46)} ${`${onSunken.toFixed(2)}/${onBg.toFixed(
      2
    )}`.padStart(10)}  (expected >= 3 on sunken/bg, APCA Lc ${Math.abs(
      apcaContrast(mark, parseColor(t.colors.bgSunken)!)
    ).toFixed(1)} on sunken)`
  )
  note(`${t.id}: --ring-bypass on --surface-hover`, contrastRatio(mark, parseColor(t.colors.surfaceHover)!).toFixed(2))
}

console.log('\n-- the full bar: the red fill against its own red-tinted track --')
/*
 * At 81%+ the bar's unfilled track is `color-mix(in srgb, --meter-high
 * <--meter-full-tint>, --bg-sunken)`, mirrored here: 30% on a dark theme, 15% on
 * a light one. Change one, change the other.
 *
 * The fill ends ON that track, so the edge that says how much is left is fill
 * against tint, and it is held to the same 3:1 as every other meter edge above.
 * It shipped at 30% for both appearances, which measured 2.57:1 on all three
 * light themes -- the one boundary in the meter under the floor, at the one
 * level where it matters most -- and no row here looked at it. The tint must
 * also stay a tint: at least 0.04 from the plain track (gotcha 44's "the same
 * colour"), or the floor could be met by not tinting at all. Both inputs are
 * opaque, so `srgb` interpolation is a plain lerp of the 8-bit channels.
 */
const FULL_TINT: Record<Theme['appearance'], number> = { dark: 0.3, light: 0.15 }

function tinted(red: Rgb, ground: Rgb, amount: number): Rgb {
  const at = (a: number, b: number): number => Math.round(a * amount + b * (1 - amount))
  return { r: at(red.r, ground.r), g: at(red.g, ground.g), b: at(red.b, ground.b), a: 1 }
}

for (const t of BUILT_IN_THEMES) {
  const red = parseColor(meterScale(t.colors.bg, t.colors.bgSunken, t.appearance).high)!
  const sunken = parseColor(t.colors.bgSunken)!
  const track = tinted(red, sunken, FULL_TINT[t.appearance])
  atLeast(`${t.id}: fill on its tinted track ${toHex(track)}`, contrastRatio(red, track), METER_WCAG)
  atLeast(`${t.id}: the tint still reads as a tint`, perceptualDistance(track, sunken), 0.04)
}

console.log('\n-- text tokens on the grounds they actually render on --')
/*
 * Four grounds, not one. The three text tokens are drawn on every panel the
 * app has, and the panels are not all `--bg`:
 *
 *   --bg            .main-col                                  (app.css:296)
 *   --bg-sunken     .titlebar :306, .sidebar :953, .worklog :1853,
 *                   .statusbar :2234, .activity :3038
 *   --surface       .worklog-item :1944, .usage-panel :2922
 *   --bg-elevated   .context-menu :2287, .palette :2360, .sheet :2421
 *
 * The list is the assertion. `--text-faint`'s own note in themes.ts records
 * what one ground buys you: the old value measured 5.10 against `--bg` and
 * 4.23 against `--surface`, and `--surface` is the ground `.field-hint`,
 * `.worklog-meta`, `.usage-note` and `.palette-item-path` actually land on. A
 * promise checked against one of four grounds is not a promise.
 *
 * APCA is printed beside every ratio even though only WCAG is asserted,
 * because the two disagree by polarity and the disagreement is systematic, not
 * noise. Daylight's `--text-faint` reads 5.03:1 / Lc 71.1 on its page; Ember's
 * reads 5.10:1 / Lc 36.7 on its own -- the same ratio, and only one of them is
 * a body-text pass under APCA. Every dark theme's faint text sits near Lc 37
 * at a comfortable 5:1. That gap is what the stage 2 ladder has to close, and
 * it is invisible if only the ratio is reported.
 */
const TEXT_TOKENS = [
  ['text', '--text'],
  ['textMuted', '--text-muted'],
  ['textFaint', '--text-faint']
] as const

const GROUNDS = [
  ['bg', '--bg'],
  ['bgSunken', '--bg-sunken'],
  ['surface', '--surface'],
  ['bgElevated', '--bg-elevated'],
  /*
   * The fifth ground, asserted now that the ladder can carry it.
   *
   * `.session-meta` (app.css:1286) and `.project-meta-note` (:1204) are
   * `color: var(--text-faint)` inside rows whose :hover background is
   * `--surface-hover` (:1261, :1015). Under the hand-picked palette this
   * measured 3.99-4.10 on the three dark themes and could not be fixed without
   * collapsing `--text-faint` to within 1.12:1 of `--text-muted`, because
   * `--surface-hover` sat too close to the text tokens in an uneven ramp. The
   * ladder solves the text rungs against step 4 -- which IS this ground -- so
   * it is now the tightest of the five by construction rather than the one that
   * was never checked.
   */
  ['surfaceHover', '--surface-hover']
] as const


for (const t of BUILT_IN_THEMES) {
  for (const [token, tokenName] of TEXT_TOKENS) {
    for (const [ground, groundName] of GROUNDS) {
      const fg = parseColor(t.colors[token])!
      const bg = parseColor(t.colors[ground])!
      atLeast(
        `${t.id}: ${tokenName} on ${groundName}`,
        contrastRatio(fg, bg),
        4.5,
        `, APCA Lc ${Math.abs(apcaContrast(fg, bg)).toFixed(1)}`
      )
    }
  }
}

console.log('\n-- every ansi colour on its own terminal background --')
/*
 * The selection section above measures the palette against the composited
 * selection, which is the rarer ground: almost every character a terminal ever
 * draws sits on `terminal.background` with nothing over it. Nothing checked
 * that, which is how Daylight shipped a palette whose eight bright slots were
 * all LIGHTER than their normals -- see the long note in themes.ts.
 *
 * Three slots are not body foregrounds — two on a dark theme, one on the light
 * one — and they are named here rather than skipped, because a silent
 * `continue` is indistinguishable from a bug:
 *
 *  - dark `black` is a BACKGROUND. Not an opinion: in all three dark themes it
 *    is the `surfaceHover` token verbatim, asserted below, so measuring text
 *    contrast on it is measuring the wrong thing. It reads 1.24-1.32.
 *  - dark `brightBlack` is the dim slot -- comments, dimmed output -- and
 *    measures 3.27 / 3.32 / 3.38. That is a real shortfall rather than a
 *    category error, and it is stage 2's to fix with the ladder; asserting 4.5
 *    on it today would only make the suite red about something already known.
 *  - light `brightWhite` is themes.ts's one stated deliberate exception, at
 *    3.04: the lightest slot on a light ground cannot also be the most
 *    legible, and 3.04 is what replaced the 1.10 it used to be.
 *
 * An exemption that stops being needed is reported, so the list cannot quietly
 * outlive the problem it was written for.
 */
const ANSI_EXEMPT: Record<Theme['appearance'], readonly string[]> = {
  dark: ['black', 'brightBlack'],
  light: ['brightWhite']
}

/*
 * What an exempt slot may not fall below. Measured today, rounded down to the
 * nearest tenth so an 8-bit re-derivation does not trip them.
 *
 * `black` on a dark theme is asserted by identity against --surface-hover just
 * above, so its floor here is nominal; the other two are real. Raise these if
 * the values improve -- they exist to stop a slot sliding back.
 */
const ANSI_EXEMPT_FLOOR: Record<string, number> = {
  black: 1,
  // 3.1, not 3.2: the generated ramp puts Nocturne's at 3.195, which prints as
  // "3.20" and fails a 3.2 floor. The floor is here to stop a slide, not to pin
  // a third decimal nobody can see.
  brightBlack: 3.1,
  brightWhite: 3.0
}

/** The six slots that carry hue. The four greys are a ramp and are judged as one. */
const ANSI_CHROMATIC = ['red', 'green', 'yellow', 'blue', 'magenta', 'cyan'] as const

for (const t of BUILT_IN_THEMES) {
  const bg = parseColor(t.terminal.background)!
  const exempt = ANSI_EXEMPT[t.appearance]

  if (t.appearance === 'dark') {
    /*
     * Turns "black is a background slot" from a claim into a measurement.
     *
     * It used to assert `black === surfaceHover` by identity, which held while
     * both were hand-picked and stopped holding the moment the palette was
     * generated -- the terminal ramp places `black` a twelfth of the way from
     * the page toward the ink, which is near `surfaceHover` but not on it.
     * Identity was never the property that mattered anyway. What matters is
     * that the slot stays close enough to the page to BE a background: a
     * `black` that drifted out to 3:1 would be exempted from the 4.5 floor
     * while no longer deserving the exemption.
     */
    atMost(
      `${t.id}: ansi black is still a background slot`,
      contrastRatio(parseColor(t.terminal.black)!, parseColor(t.terminal.background)!),
      2
    )
  }

  for (const slot of ANSI_SLOTS) {
    const ratio = contrastRatio(parseColor(t.terminal[slot])!, bg)
    if (exempt.includes(slot)) {
      /*
       * Exempt from 4.5, NOT from having a floor.
       *
       * An adversarial check on the first version of this section put
       * daylight's `brightWhite` back to #f4f4f5 -- a 1.00:1 slot, i.e. exactly
       * the "anything emitting ESC[97m was invisible" bug themes.ts records as
       * fixed -- and the suite stayed green, because an exempt slot only ever
       * emitted an unasserted note. An exemption that cannot fail in the
       * regression direction is not an exemption, it is a hole.
       *
       * So each exempt slot is held at the value it was deliberately parked
       * at. `black` on a dark theme is a background and is allowed to be
       * invisible; the rest have to stay at least where they are.
       */
      const floor = ANSI_EXEMPT_FLOOR[slot] ?? 1
      atLeast(`${t.id}: ansi ${slot} (exempt from 4.5, floor only)`, ratio, floor)
      if (ratio >= 4.5) {
        note(`${t.id}: ansi ${slot}`, ratio.toFixed(2), '  <- clears 4.5 now; drop it from ANSI_EXEMPT')
      }
      continue
    }
    atLeast(`${t.id}: ansi ${slot} on terminal.background`, ratio, 4.5)
  }
}

/*
 * Bright must not be weaker than normal, on the light theme.
 *
 * `bright` is the terminal's emphasis channel -- it is what SGR bold selects --
 * so on a light ground it has to move AWAY from white. Daylight used to move
 * every bright towards it, which put emphasised text below its own unemphasised
 * text in all eight slots and under 4.5:1 in five. This is the invariant that
 * was violated, so it is asserted directly rather than inferred from the floor.
 *
 * Chromatic slots only, and only the light theme. On a dark ground "brighter"
 * already means further from the background, so the invariant holds there by
 * construction and asserting it proves nothing. And the four grey slots are
 * deliberately one monotonic ramp (0 < 8 < 7 < 15), which on a light ground
 * means contrast FALLS along it: `brightWhite` out-contrasting `white` would
 * mean the ramp had broken, not that emphasis was working.
 */
for (const t of BUILT_IN_THEMES.filter((x) => x.appearance === 'light')) {
  const bg = parseColor(t.terminal.background)!
  for (const slot of ANSI_CHROMATIC) {
    const bright = `bright${slot[0].toUpperCase()}${slot.slice(1)}` as keyof Theme['terminal']
    const normalRatio = contrastRatio(parseColor(t.terminal[slot])!, bg)
    const brightRatio = contrastRatio(parseColor(t.terminal[bright])!, bg)
    atLeast(`${t.id}: ansi ${bright} >= ${slot}`, brightRatio, normalRatio)
  }
}

console.log('\n-- the accent as a foreground: every theme x every swatch --')
/*
 * The assertion that would have caught the shipped bug.
 *
 * `applyAppearance` derives all five accent tokens from ONE brand colour and
 * the active theme's page, on every path -- with a profile and without. So the
 * matrix is real: any swatch can be active under any theme, and before
 * `deriveAccent` existed all eight of them measured 1.43-2.66:1 against
 * Daylight's page while driving `:focus-visible` (app.css:224), `.ring
 * .ring-fill`'s stroke (:1366) and the selected tab's indicator. The suite next
 * door, verify-profiles.mts, asserted only `accentContrast` against `accent` --
 * the ink on the fill, which is a different pair entirely -- so `npm run check`
 * passed throughout. CLAUDE.md gotcha 31.
 *
 * The theme's own accent is included as a ninth source because "no profile
 * selected" is the default state and takes the identical code path.
 *
 * Three bars, three reasons:
 *  - 4.5:1 on `--bg`, because `--accent-ink` is `color:` in eight rules.
 *  - APCA Lc on `--bg`, because WCAG 2 and APCA disagree and neither implies
 *    the other: solving for Lc 60 alone lands at 3.6:1 on Daylight.
 *  - 3:1 on `--bg-sunken`, WCAG 1.4.11: the focus ring and the context ring's
 *    stroke are non-text graphics, and the chrome they are drawn over is
 *    sunken, not `--bg`. `deriveAccent` judges against `--bg` deliberately
 *    (the harder ground would darken every light accent past what the page
 *    needs), so the sunken case has to be checked rather than assumed -- it
 *    costs about 0.5:1 on Daylight, 4.84 -> 4.35.
 */
/** `ACCENT_LC` in shared/accent.ts. Mirrored: the module exports no constants. */
const ACCENT_LC = 60
/** `ACCENT_WCAG` there. */
const ACCENT_WCAG = 4.5
/** WCAG 1.4.11, non-text contrast. Not from accent.ts -- it never checks this ground. */
const RING_WCAG = 3

/*
 * `AT_FLOOR_TOLERANCE` in shared/accent.ts, mirrored, and it has to be honoured
 * here or this section asserts a bar the module was written not to meet. A
 * brand colour within 2 Lc of the floor is kept EXACTLY as authored, because
 * five of the eight shipped swatches sit a fraction under Lc 60 on a dark page
 * and nudging them would rewrite every dark theme's accent by one 8-bit step
 * for no legibility gain (#ff9552 -> #ff9756).
 *
 * So the bar depends on which branch ran, and that is observable from outside:
 * an ink identical to the brand hex was kept, anything else was solved for. A
 * kept ink gets the tolerance -- the six that use it measure 58.7-59.4 -- and a
 * SOLVED ink gets a strict Lc 60, with no tolerance at all, because there the
 * module chose the number and 59 would mean the solver missed.
 */
const AT_FLOOR_TOLERANCE = 2

for (const t of BUILT_IN_THEMES) {
  const sources = [
    { id: 'theme', accent: t.colors.accent },
    ...PROFILE_SWATCHES.map((s) => ({ id: s.id, accent: s.accent }))
  ]
  for (const src of sources) {
    const tokens = deriveAccent(src.accent, t.appearance, t.colors.bg)
    const ink = parseColor(tokens.accentInk)!
    const page = parseColor(t.colors.bg)!
    const sunken = parseColor(t.colors.bgSunken)!

    const kept = tokens.accentInk.toLowerCase() === src.accent.toLowerCase()
    const lcFloor = kept ? ACCENT_LC - AT_FLOOR_TOLERANCE : ACCENT_LC

    const onBg = contrastRatio(ink, page)
    const lcBg = Math.abs(apcaContrast(ink, page))
    const onSunken = contrastRatio(ink, sunken)

    const ok = onBg >= ACCENT_WCAG && lcBg >= lcFloor && onSunken >= RING_WCAG
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}/${src.id}: --accent-ink ${tokens.accentInk}`.padEnd(46)} ${`${onBg.toFixed(
        2
      )}/${lcBg.toFixed(1)}/${onSunken.toFixed(2)}`.padStart(10)}  (expected >= ${ACCENT_WCAG} / ${lcFloor}${
        kept ? ' kept' : ' solved'
      } / ${RING_WCAG})`
    )

    // The dead-band guarantee: a fill has a legible label at SOME ink, and the
    // fill is nudged out of the ~7 L* window where neither near-white nor
    // near-black reaches Lc 60 on it. No tolerance here -- where the nudge runs
    // it is chosen to clear the floor, so anything under it is the nudge failing.
    atLeast(
      `${t.id}/${src.id}: --accent-contrast on the fill`,
      Math.abs(apcaContrast(parseColor(tokens.accentContrast)!, parseColor(tokens.accent)!)),
      ACCENT_LC
    )

    /*
     * The SAME ink on the hover fill, which went unchecked until 0.9.3.
     *
     * There is one `--accent-contrast`, chosen for the solid fill;
     * `.btn[data-variant='primary']` sets `color` from it once and swaps only
     * background and border-color on :hover. So the label sits on two fills and
     * this suite measured one of them — while the hover was derived by moving
     * OKLCH L a fixed step away from the page, which moves it towards the ink
     * whenever the ink is the far one, i.e. usually.
     *
     * 28 of these 108 rows were below the floor when the assertion was added,
     * Clay's own shipped accent among them (63.3 solid, 57.7 hover), and every
     * built-in theme failed it under the Coral and Iris profiles. No tolerance,
     * for the same reason as the row above: the module picks this number, so
     * missing it is the derivation failing rather than an authored colour
     * sitting a fraction low.
     */
    atLeast(
      `${t.id}/${src.id}: --accent-contrast on the HOVER fill`,
      Math.abs(apcaContrast(parseColor(tokens.accentContrast)!, parseColor(tokens.accentHover)!)),
      ACCENT_LC
    )

    /*
     * And the hover must still LOOK like a hover. Clearing the floor by not
     * moving would satisfy the assertion above and silently delete the
     * affordance, so the distance is asserted too.
     */
    atLeast(
      `${t.id}/${src.id}: hover is visibly different from the fill`,
      Math.abs(toOklch(parseColor(tokens.accentHover)!).l - toOklch(parseColor(tokens.accent)!).l),
      0.015
    )
  }
}

console.log('\n-- agent colours: every agent seed as a foreground, on every theme --')
/*
 * `applyAppearance` writes `--agent-<id>-ink` for all eighteen agents through
 * `agentColorTokens`, which is `deriveAccent` per seed — the same derivation as
 * the accent matrix above, so the same three bars and the same kept/solved
 * tolerance. The ink is a GRAPHIC: the tab tag's 1px border, the rule along a
 * tab's foot, the 2px rule on the pane, the status-bar and launcher dots and
 * the plan-limit chip's edge. So 4.5:1 and Lc on `--bg`, and WCAG 1.4.11's 3:1
 * on the chrome — the sunken title bar and status bar, and a hovered tab.
 * Called through the function applyAppearance calls, so what is asserted is
 * what is painted.
 *
 * The tag's TEXT is not the ink, and this section used to say it was while
 * checking it at 3:1: on every light theme the ink measured 3.87-3.91:1 on the
 * title bar, where every unselected tab's tag sits — 54 of these 216 rows under
 * the 4.5:1 text floor, all three light themes, every agent. The text is its
 * own token now, asserted in the next section.
 */
for (const t of BUILT_IN_THEMES) {
  const page = parseColor(t.colors.bg)!
  const sunken = parseColor(t.colors.bgSunken)!
  const hover = parseColor(t.colors.surfaceHover)!
  for (const tok of agentColorTokens({}, t.appearance, t.colors)) {
    const ink = parseColor(tok.ink)!
    const kept = tok.ink.toLowerCase() === tok.seed.toLowerCase()
    const lcFloor = kept ? ACCENT_LC - AT_FLOOR_TOLERANCE : ACCENT_LC
    const onBg = contrastRatio(ink, page)
    const lcBg = Math.abs(apcaContrast(ink, page))
    const onChrome = Math.min(contrastRatio(ink, sunken), contrastRatio(ink, hover))
    const ok = onBg >= ACCENT_WCAG && lcBg >= lcFloor && onChrome >= RING_WCAG
    if (!ok) failures++
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${`${t.id}/${tok.key}: --agent-${tok.key}-ink ${tok.ink}`.padEnd(46)} ${`${onBg.toFixed(
        2
      )}/${lcBg.toFixed(1)}/${onChrome.toFixed(2)}`.padStart(10)}  (expected >= ${ACCENT_WCAG} / ${lcFloor}${
        kept ? ' kept' : ' solved'
      } / ${RING_WCAG})`
    )
  }
}

console.log('\n-- agent colours: the tab tag\'s text on every ground under it --')
/*
 * `--agent-<id>-text` is `color:` on `.tab-agent`, a 0.75rem label, and it sits
 * on three grounds: `--bg` on the selected tab, `--bg-sunken` (the title bar)
 * on every other one, `--surface-hover` on a hovered or lifted one. Held to the
 * 4.5:1 the text tokens above are held to on the same grounds, and the APCA
 * reading printed beside each, as there.
 *
 * And the other half, which is what keeps the fix from repainting the dark
 * themes: wherever the ink already clears 4.5:1 on all three grounds, the text
 * IS the ink, byte for byte — the tag's label and its border stay one colour.
 * That is every dark built-in; asserted per theme, so a derivation change that
 * quietly darkened or lightened them shows up here.
 */
for (const t of BUILT_IN_THEMES) {
  const grounds = [
    ['--bg', parseColor(t.colors.bg)!],
    ['--bg-sunken', parseColor(t.colors.bgSunken)!],
    ['--surface-hover', parseColor(t.colors.surfaceHover)!]
  ] as const
  let inkClears = 0
  let same = 0
  for (const tok of agentColorTokens({}, t.appearance, t.colors)) {
    const text = parseColor(tok.text)!
    const ink = parseColor(tok.ink)!
    for (const [name, ground] of grounds) {
      atLeast(
        `${t.id}/${tok.key}: -text ${tok.text} on ${name}`,
        contrastRatio(text, ground),
        AGENT_TEXT_WCAG,
        `, APCA Lc ${Math.abs(apcaContrast(text, ground)).toFixed(1)}`
      )
    }
    if (grounds.every(([, g]) => contrastRatio(ink, g) >= AGENT_TEXT_WCAG)) {
      inkClears++
      if (tok.text === tok.ink) same++
    }
  }
  eq(`${t.id}: text is the ink wherever the ink clears (${inkClears} of 18)`, same, inkClears)
  if (t.appearance === 'dark') eq(`${t.id}: dark, so the ink clears for every agent`, inkClears, 18)
}

console.log('\n-- the colour picker: HSV, the ring and the map, keys, names, placement --')
/*
 * `shared/colorPicker.ts`, the maths behind every colour field's wheel. Each
 * block is a rule the picker leans on: a hex read into HSV and written back is
 * the same hex (or the handles drift on their own); the ring's 0° is its top
 * and turns clockwise, exactly as its conic gradient paints; the map's two CSS
 * gradients composite to the HSV colour the handle reports; arrow keys wrap on
 * the ring and clamp on the map; a grey or black keeps the hue it came from.
 */
{
  // Round trips: every 17th step of each channel, 4,096 colours.
  let bad = 0
  let first = ''
  for (let r = 0; r <= 255; r += 17) {
    for (let g = 0; g <= 255; g += 17) {
      for (let b = 0; b <= 255; b += 17) {
        const hex = toHex(rgb(r, g, b))
        const back = hsvToHex(rgbToHsv(rgb(r, g, b)))
        if (back !== hex) {
          bad++
          first ||= `${hex} -> ${back}`
        }
      }
    }
  }
  eq(`hex -> HSV -> hex is the same hex for 4096 colours${first ? ` (first miss ${first})` : ''}`, bad, 0)
  eq('the primaries and secondaries', [0, 60, 120, 180, 240, 300].map((h) => hsvToHex({ h, s: 1, v: 1 })), [
    '#ff0000',
    '#ffff00',
    '#00ff00',
    '#00ffff',
    '#0000ff',
    '#ff00ff'
  ])
  eq('hue 360 is hue 0, -120 is 240, 750 is 30', [360, -120, 750].map((h) => hsvToHex({ h, s: 1, v: 1 })), [
    '#ff0000',
    '#0000ff',
    hsvToHex({ h: 30, s: 1, v: 1 })
  ])
  eq('wrapHue: 360, -30, 719.5, NaN', [360, -30, 719.5, NaN].map(wrapHue), [0, 330, 359.5, 0])
  eq('clampHsv pulls every channel into range', clampHsv({ h: 370, s: -1, v: 2 }), { h: 10, s: 0, v: 1 })
  eq('out-of-range saturation and value clamp before converting', hsvToHex({ h: 30, s: 1.5, v: -0.2 }), '#000000')
  eq('clamp01 of junk is 0', [NaN, Infinity, -Infinity, 0.5].map(clamp01), [0, 0, 0, 0.5])

  // Greys and black: the hex cannot say the hue, so the position stands.
  eq('a grey reports hue 0 and no saturation', [rgbToHsv(rgb(128, 128, 128)).h, rgbToHsv(rgb(128, 128, 128)).s], [0, 0])
  eq(
    'but read back into the picker it keeps the hue it was dragged from',
    hexToHsv('#808080', { h: 200, s: 0.6, v: 0.8 }),
    { h: 200, s: 0, v: rgbToHsv(rgb(128, 128, 128)).v }
  )
  eq('and black keeps the hue AND the saturation: only brightness went', hexToHsv('#000000', { h: 200, s: 0.6, v: 0.8 }), {
    h: 200,
    s: 0.6,
    v: 0
  })
  {
    const at = { h: 123.4, s: 0.567, v: 0.891 }
    eq('the hex the picker already shows keeps its exact position (no drift from rounding)', hexToHsv(hsvToHex(at), at), at)
  }
  eq('an unparseable colour is null', hexToHsv('nonsense'), null)
  eq('sameColor ignores case and notation', [sameColor('#E07B2E', 'rgb(224, 123, 46)'), sameColor('#e07b2e', '#e07b2f')], [true, false])

  // Typed values.
  eq(
    'parseTyped: hex with or without #, 3 or 6 digits, any case, and every notation',
    ['#E07B2E', 'e07b2e', 'abc', '#abc', 'rgb(224, 123, 46)', 'hsl(26 73% 53%)'].map(parseTyped),
    ['#e07b2e', '#e07b2e', '#aabbcc', '#aabbcc', '#e07b2e', parseTyped('hsl(26 73% 53%)')]
  )
  okp('an oklch() typed in is fitted into sRGB, not refused', /^#[0-9a-f]{6}$/.test(parseTyped('oklch(0.7 0.4 51)') ?? ''))
  eq('parseTyped refuses junk, a short hex, and anything translucent', ['nonsense', '#12345', 'transparent', '#e07b2e80', ''].map(parseTyped), [
    null,
    null,
    null,
    null,
    null
  ])
  eq('typedIsComplete: six digits or a closed function, never a prefix', ['#e07', 'e07b2e', '#E07B2E', 'rgb(1 2 3)', 'rgb(1 2'].map(typedIsComplete), [
    false,
    true,
    true,
    true,
    false
  ])

  // The ring: 0° at the top, clockwise, as `conic-gradient(from 0deg …)` paints.
  eq('hueAt: top, right, bottom, left of the centre', [hueAt(50, 0, 50, 50), hueAt(100, 50, 50, 50), hueAt(50, 100, 50, 50), hueAt(0, 50, 50, 50)], [0, 90, 180, 270])
  eq('the centre itself is 0, not NaN', hueAt(50, 50, 50, 50), 0)
  {
    let worst = 0
    for (let h = 0; h < 360; h += 7.5) {
      const p = ringOffset(h, 80)
      const back = hueAt(100 + p.x, 100 + p.y, 100, 100)
      worst = Math.max(worst, Math.abs(((back - h + 540) % 360) - 180))
    }
    near('ringOffset and hueAt invert each other (worst error, degrees)', worst, 0, 1e-9)
  }
  const ring = hueRingGradient()
  eq('the ring is painted from hsvToHex, seven exact stops, red at both ends', ring, `conic-gradient(from 0deg, ${[0, 60, 120, 180, 240, 300, 360].map((h) => `${hsvToHex({ h: h % 360, s: 1, v: 1 })} ${h}deg`).join(', ')})`)
  eq('pureHue is the top-right corner of the map', pureHue(240), '#0000ff')

  // The map: saturation across, brightness up, clamped at its edges.
  const box = { left: 10, top: 20, width: 100, height: 200 }
  eq('svAt corners: top-left, top-right, bottom-left, bottom-right', [svAt(10, 20, box), svAt(110, 20, box), svAt(10, 220, box), svAt(110, 220, box)], [
    { s: 0, v: 1 },
    { s: 1, v: 1 },
    { s: 0, v: 0 },
    { s: 1, v: 0 }
  ])
  eq('a drag past the edge clamps to it', [svAt(-50, -50, box), svAt(500, 500, box)], [{ s: 0, v: 1 }, { s: 1, v: 0 }])
  eq('a map with no size yet reads 0, not NaN', svAt(5, 5, { left: 0, top: 0, width: 0, height: 0 }), { s: 0, v: 0 })
  {
    /*
     * The map is `linear-gradient(to top, black, transparent), linear-gradient(to
     * right, white, transparent), <pure hue>`, composited in sRGB. That IS HSV:
     * across, white fades to the hue (s); up, a black veil of alpha 1 - v. So the
     * colour under the handle is the colour the handle reports.
     */
    let worst = 0
    for (const h of [0, 37, 120, 205, 300]) {
      const hue = hsvToRgb({ h, s: 1, v: 1 })
      for (let s = 0; s <= 1; s += 0.125) {
        for (let v = 0; v <= 1; v += 0.125) {
          const white = { r: 255 * (1 - s) + hue.r * s, g: 255 * (1 - s) + hue.g * s, b: 255 * (1 - s) + hue.b * s }
          const painted = { r: white.r * v, g: white.g * v, b: white.b * v }
          const said = hsvToRgb({ h, s, v })
          worst = Math.max(worst, Math.abs(painted.r - said.r), Math.abs(painted.g - said.g), Math.abs(painted.b - said.b))
        }
      }
    }
    near('the map’s two CSS gradients composite to exactly the HSV colour (worst channel error)', worst, 0, 1e-9)
  }

  // Keys.
  eq('ring: Left from 0 wraps to 359, Right from 359 to 0', [stepHue(0, 'ArrowLeft', false), stepHue(359, 'ArrowRight', false)], [359, 0])
  eq('ring: Up/Down move like Right/Left; Shift is 15°', [stepHue(10, 'ArrowUp', false), stepHue(10, 'ArrowDown', false), stepHue(10, 'ArrowRight', true), stepHue(10, 'ArrowLeft', true)], [11, 9, 25, 355])
  eq('ring: Home, End, Page Up, Page Down', [stepHue(200, 'Home', false), stepHue(200, 'End', false), stepHue(200, 'PageUp', false), stepHue(200, 'PageDown', false)], [0, 359, 215, 185])
  eq('ring: a fractional hue steps from its whole degree', stepHue(10.6, 'ArrowRight', false), 12)
  eq('ring: a key it does not take is null (Enter, Tab and letters pass through)', ['Enter', 'Tab', 'a'].map((k) => stepHue(10, k, false)), [null, null, null])
  eq(
    'map: arrows move the axis they point along, 1% or 10% with Shift',
    [stepSv({ s: 0.5, v: 0.5 }, 'ArrowRight', false), stepSv({ s: 0.5, v: 0.5 }, 'ArrowLeft', true), stepSv({ s: 0.5, v: 0.5 }, 'ArrowUp', true), stepSv({ s: 0.5, v: 0.5 }, 'ArrowDown', false)],
    [{ s: 0.51, v: 0.5 }, { s: 0.4, v: 0.5 }, { s: 0.5, v: 0.6 }, { s: 0.5, v: 0.49 }]
  )
  eq('map: clamped at every edge', [stepSv({ s: 1, v: 1 }, 'ArrowRight', true), stepSv({ s: 0, v: 0 }, 'ArrowDown', true)], [{ s: 1, v: 1 }, { s: 0, v: 0 }])
  eq('map: Home and End are the grey and the vivid edge; Page keys step brightness', [stepSv({ s: 0.3, v: 0.4 }, 'Home', false), stepSv({ s: 0.3, v: 0.4 }, 'End', false), stepSv({ s: 0.3, v: 0.4 }, 'PageUp', false), stepSv({ s: 0.3, v: 0.4 }, 'PageDown', false)], [
    { s: 0, v: 0.4 },
    { s: 1, v: 0.4 },
    { s: 0.3, v: 0.5 },
    { s: 0.3, v: 0.3 }
  ])
  eq('map: a value read from a hex snaps to a whole percent on the first press', stepSv({ s: 0.5327, v: 0.5 }, 'ArrowRight', false), { s: 0.54, v: 0.5 })
  eq('map: a key it does not take is null', stepSv({ s: 0.5, v: 0.5 }, 'Enter', false), null)

  // Names, for aria-valuetext.
  eq(
    'colorName: vivid, plain, dark, pale, greyish, and the greys by brightness',
    [
      colorName({ h: 30, s: 1, v: 1 }),
      colorName(rgbToHsv(parseColor('#de7b2e')!)),
      colorName({ h: 240, s: 0.9, v: 0.3 }),
      colorName({ h: 210, s: 0.2, v: 0.95 }),
      colorName({ h: 120, s: 0.25, v: 0.5 }),
      colorName({ h: 0, s: 0, v: 0.05 }),
      colorName({ h: 0, s: 0.02, v: 0.98 }),
      colorName({ h: 77, s: 0.05, v: 0.8 }),
      colorName({ h: 77, s: 0.05, v: 0.5 }),
      colorName({ h: 77, s: 0.05, v: 0.2 })
    ],
    ['vivid orange', 'orange', 'dark blue', 'pale azure', 'greyish green', 'black', 'white', 'light grey', 'grey', 'dark grey']
  )
  /*
   * Found by the visual QA: a salmon (Ember's --danger, #ffa192) was "red",
   * and an ochre (#c4942d, h41) and an amber (#ffbf00, h45) were "yellow".
   */
  eq(
    'colorName: light for the bright half-saturated band, and amber between orange and yellow',
    ['#ffa192', '#c4942d', '#ffbf00', '#ffd700', '#e07b2e'].map((x) => colorName(rgbToHsv(parseColor(x)!))),
    ['light red', 'amber', 'vivid amber', 'vivid yellow', 'orange']
  )
  eq('hueName wraps red round both ends', [hueName(0), hueName(355), hueName(360), hueName(-5)], ['red', 'red', 'red', 'red'])
  eq('Codex’s seed is named as the purple it was asked to be', hueName(rgbToHsv(parseColor('#ba66e9')!).h), 'purple')

  // The "Stoke paints it darker" note.
  eq('inkShift: no note for an ink the eye reads as the pick', inkShift('#de7b2e', '#dd7b2e'), null)
  {
    const s = inkShift('#f0ebd9', '#6a6656')
    okp(`inkShift: a pale pick solved dark for a light theme is noted, as darker (${s?.distance.toFixed(3)})`, s !== null && s.darker && s.distance >= INK_NOTE_DISTANCE)
  }
  eq('inkShift: junk is no note', inkShift('nonsense', '#000000'), null)

  // The fill that vanishes, and the figure the picker prints.
  {
    const gone = fillVanishes('#261104', ['#181716', '#0d0c0c'])
    okp(`fillVanishes: a near-black fill on Ember's page is reported (${gone?.toFixed(2)}:1, under ${FILL_VANISH_RATIO})`, gone !== null && gone < FILL_VANISH_RATIO)
  }
  eq('fillVanishes: a fill with an edge is not', fillVanishes('#ff9552', ['#181716', '#0d0c0c']), null)
  eq('fillVanishes: junk is not reported', fillVanishes('nonsense', ['#181716']), null)
  near('worstContrast: black text on white and grey is the grey', worstContrast('#000000', ['#ffffff', '#777777'])!, contrastRatio(parseColor('#000000')!, parseColor('#777777')!), 1e-9)

  // Placement: below, flipped above, never over the swatch, scrolling in its room.
  const vp = { width: 1000, height: 800 }
  const sz = { width: 250, height: 400 }
  eq(
    'fits below: below, left-aligned, held by its top one gap under the swatch',
    placePopover({ left: 100, top: 100, right: 132, bottom: 122 }, sz, vp, 6, 8),
    { left: 100, top: 128, bottom: null, maxHeight: 664, side: 'below' }
  )
  eq(
    'no room below, room above: above, held by its BOTTOM one gap over the swatch, so growing moves its top',
    placePopover({ left: 100, top: 700, right: 132, bottom: 722 }, sz, vp, 6, 8),
    { left: 100, top: null, bottom: 106, maxHeight: 686, side: 'above' }
  )
  eq(
    'at the right edge: slid left to stay in the window',
    placePopover({ left: 900, top: 100, right: 932, bottom: 122 }, sz, vp, 6, 8).left,
    742
  )
  {
    /*
     * The QA's scale-1.4 case: a swatch at y 300-331 and a 605px picker in an
     * 800px window. Neither side fits. The first cut clamped the top to 257,
     * over the swatch; now it takes the roomier side and scrolls there.
     */
    const a = { left: 100, top: 300, right: 145, bottom: 331 }
    const p = placePopover(a, { width: 347, height: 605 }, vp, 8.4, 8)
    eq('room on neither side: the roomier side (below), capped to its room', p, { left: 100, top: 339, bottom: null, maxHeight: 452, side: 'below' })
    okp('and the popover never covers its swatch', p.top !== null && p.top >= a.bottom)
    const q = placePopover({ left: 100, top: 480, right: 145, bottom: 511 }, { width: 347, height: 605 }, vp, 8.4, 8)
    okp(
      `and above, its bottom edge stays over the swatch (bottom ${q.bottom}, swatch top ${480})`,
      q.side === 'above' && q.bottom !== null && vp.height - q.bottom <= 480 && q.maxHeight === Math.floor(480 - 8.4 - 8)
    )
  }
  {
    // Every swatch position down an 800px window, for a picker too tall for either side.
    let covered = 0
    for (let top = 10; top < 780; top += 5) {
      const a = { left: 100, top, right: 132, bottom: top + 22 }
      const p = placePopover(a, { width: 250, height: 900 }, vp, 6, 8)
      const box = p.side === 'below' ? { top: p.top!, bottom: p.top! + p.maxHeight } : { top: vp.height - p.bottom! - p.maxHeight, bottom: vp.height - p.bottom! }
      if (box.top < a.bottom && box.bottom > a.top) covered++
      if (box.top < 8 - 0.5 || box.bottom > vp.height - 8 + 0.5) covered++
    }
    eq('a picker taller than the window, anywhere down it: never over its swatch, never off screen', covered, 0)
  }

  // The swatch scrolled away closes it.
  const clip = { left: 0, top: 100, right: 800, bottom: 600 }
  eq(
    'anchorShown: inside the pane, half out past its top, wholly out',
    [
      anchorShown({ left: 10, top: 200, right: 42, bottom: 222 }, clip),
      anchorShown({ left: 10, top: 95, right: 42, bottom: 117 }, clip),
      anchorShown({ left: 10, top: 80, right: 42, bottom: 102 }, clip),
      anchorShown({ left: 10, top: -70, right: 42, bottom: -48 }, clip)
    ],
    [true, true, false, false]
  )
  eq('intersectBox: the overlap of the window and a pane', intersectBox({ left: 0, top: 0, right: 1000, bottom: 800 }, { left: 200, top: 60, right: 1200, bottom: 700 }), {
    left: 200,
    top: 60,
    right: 1000,
    bottom: 700
  })
}

{
  /*
   * The wheel's two handles, from app.css's own declarations. The QA drove a
   * vivid amber (h45) into the map's top-right corner and the map handle sat
   * 5px inside the ring handle: the map was sized from the hole and ignored
   * both handles and their halos. `--cp-map` is now solved from the six
   * `.color-picker` tokens; this evaluates exactly what the stylesheet says, at
   * the Interface scales Settings offers, and holds the corner handle's outer
   * edge short of the ring handle's inner edge.
   */
  const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src', 'styles', 'app.css'), 'utf8')
  const rule = (sel: string): string => {
    const m = css.match(new RegExp(`\\n${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`))
    return m ? m[1] : ''
  }
  const decl = (body: string, prop: string): string => body.match(new RegExp(`(?:^|[;\\s])${prop}:\\s*([^;]+);`))?.[1].trim() ?? ''
  {
    // A picker short of room scrolls inside its box; Cancel and Done must stay on screen
    // (review, 2026-10-02: cut in half at scale 1, gone at 1.4). Chromium measures a sticky
    // offset from the scroll container's CONTENT edge, so the row reaches the border only
    // with a bottom of minus the picker's padding, matched by its own margin and padding.
    const pickerPad = decl(rule('.color-picker'), 'padding')
    const actions = rule('.cp-actions')
    eq(
      'the action row sticks to the picker’s bottom border, out over its padding',
      [decl(actions, 'position'), decl(actions, 'bottom'), decl(actions, 'background'), pickerPad],
      ['sticky', 'calc(-1 * var(--space-12))', 'var(--bg-elevated)', 'var(--space-12)']
    )
  }
  const tokens: Record<string, string> = {}
  for (const m of rule('.color-picker').matchAll(/(--cp-[a-z-]+):\s*([^;]+);/g)) tokens[m[1]] = m[2].trim()
  tokens['--cp-map'] = decl(rule('.cp-map'), '--cp-map')
  /** A calc() of rem, px and the tokens above, in px at `rem`. Only arithmetic survives to the eval. */
  const px = (expr: string, rem: number, depth = 0): number => {
    if (depth > 8 || !expr) return NaN
    const flat = expr
      .replace(/var\((--[a-z-]+)\)/g, (_, name: string) => `(${px(tokens[name] ?? '', rem, depth + 1)})`)
      .replace(/calc\(/g, '(')
      .replace(/(-?[\d.]+)rem/g, (_, n: string) => `(${Number(n) * rem})`)
      .replace(/(-?[\d.]+)px/g, (_, n: string) => `(${n})`)
    if (!/^[\d.\s()+\-*/eE]+$/.test(flat)) return NaN
    return Number(new Function(`return (${flat})`)())
  }
  okp('the six wheel tokens and --cp-map are all declared', ['--cp-size', '--cp-ring-w', '--cp-ring-handle', '--cp-map-handle', '--cp-halo', '--cp-clear', '--cp-map'].every((t) => tokens[t]))
  eq('both handles are sized and haloed by those tokens', [decl(rule('.cp-ring-handle'), 'width'), decl(rule('.cp-map-handle'), 'width')], ['var(--cp-ring-handle)', 'var(--cp-map-handle)'])
  okp('and both halos are --cp-halo', [rule('.cp-ring-handle'), rule('.cp-map-handle')].every((b) => /0 0 0 var\(--cp-halo\) var\(--cp-black\)/.test(b)))
  for (const scale of [0.8, 1, 1.2, 1.4]) {
    const rem = 16 * scale
    const size = px('var(--cp-size)', rem)
    const ringW = px('var(--cp-ring-w)', rem)
    const halo = px('var(--cp-halo)', rem)
    const ringInner = size / 2 - ringW / 2 - px('var(--cp-ring-handle)', rem) / 2 - halo
    const side = px('var(--cp-map)', rem)
    const mapOuter = side / Math.SQRT2 + px('var(--cp-map-handle)', rem) / 2 + halo
    const hole = size / 2 - ringW
    okp(
      `scale ${scale}: the map handle at a corner ends ${(ringInner - mapOuter).toFixed(2)}px short of the ring handle (map ${side.toFixed(1)}px, hole radius ${hole.toFixed(1)})`,
      // A visible gap, not a kiss: at 1px the two black halos read as touching.
      ringInner - mapOuter >= 2 && side / Math.SQRT2 < hole
    )
  }
}

console.log('\n-- the ladder: borders and the surface ramp --')
/*
 * These were baseline rows until the ladder landed, and promoting them is the
 * point of the exercise. Before: Ember's `--border` measured 1.33:1 / APCA
 * Lc 0.00 against its own page -- below the discernibility floor -- while being
 * the sole visual boundary of `.btn`, `.input`, `.select`, `.profile-chip`,
 * `.activity-period` and `.worklog-item` across 56 uses. Three of the four
 * themes were at Lc 0.00.
 *
 * `Lc 0.00` was not "identical luminance". `apcaContrast` clips to exactly 0
 * below its LO_CLIP of 0.1 (color.ts), which after the 0.027 offset is about
 * Lc 7.3 -- so a 0.00 meant "below the clip", and the borders were.
 *
 * The floors are APCA's own: Lc 15 is the discernibility minimum for a divider
 * or a focus ring, which is exactly what the dark ramp's span was swept to
 * reach. Light clears it comfortably at Lc 20.6, which is Primer's
 * --borderColor-default almost to the decimal.
 *
 * EVENNESS is the other half, and it is what "the themes look muddy" measured
 * as. In every hand-picked theme the smallest gap in the surface ramp was
 * `surfaceHover -> border` and the largest was `border -> borderStrong`, a
 * ratio of 3.5x (Ember) to 6.3x (Nocturne) -- so a control's border was
 * indistinguishable from the hover state beside it. The ladder makes steps 1-8
 * an even ramp by construction; 1.5 is slack for 8-bit rounding, not for a
 * design decision.
 */
const RAMP = ['bgSunken', 'bg', 'bgElevated', 'surface', 'surfaceHover'] as const

/** APCA's discernibility floor for a divider or a ring. */
const BORDER_LC = 15
/** `--border-subtle` is a separator, not a control boundary, so it may be quieter. */
const BORDER_SUBTLE_LC = 9.5
const RAMP_EVENNESS = 1.5

for (const t of BUILT_IN_THEMES) {
  const bg = parseColor(t.colors.bg)!
  const surface = parseColor(t.colors.surface)!
  const lcOn = (hex: string, ground: typeof bg): number =>
    Math.abs(apcaContrast(parseColor(hex)!, ground))

  atLeast(`${t.id}: --border on --bg`, lcOn(t.colors.border, bg), BORDER_LC, ' Lc')
  atLeast(
    `${t.id}: --border-strong on --bg`,
    lcOn(t.colors.borderStrong, bg),
    BORDER_LC,
    ' Lc'
  )
  atLeast(
    `${t.id}: --border-subtle on --bg`,
    lcOn(t.colors.borderSubtle, bg),
    BORDER_SUBTLE_LC,
    ' Lc'
  )
  note(
    `${t.id}: --border on --surface`,
    `${contrastRatio(parseColor(t.colors.border)!, surface).toFixed(2)}:1 Lc ${lcOn(t.colors.border, surface).toFixed(2)}`
  )

  // Sorted, because the ramp's ORDER differs by appearance -- light mode's
  // chrome is recessed and its controls are raised -- while its evenness must
  // not. Duplicates are dropped: `bgElevated` and `surface` share a rung on
  // purpose, since a floating panel is told apart by shadow and border rather
  // than by lightness.
  const ls = [...new Set(RAMP.map((k) => toOklch(parseColor(t.colors[k])!).l.toFixed(4)))]
    .map(Number)
    .sort((a, b) => a - b)
  const gaps = ls.slice(1).map((l, i) => l - ls[i])
  note(
    `${t.id}: surface ramp, OKLCH L`,
    ls.map((l) => l.toFixed(3)).join('  ')
  )
  atMost(
    `${t.id}: ramp evenness, widest/narrowest step`,
    Math.max(...gaps) / Math.min(...gaps),
    RAMP_EVENNESS,
    'x'
  )
}

/*
 * The tally, and it has to stay the last statement in this file.
 *
 * There was no tally at all until 0.9.3. `failures` was declared, incremented
 * by all four assertion helpers, printed as `FAIL` on every failing line — and
 * then simply discarded when the script ended, because nothing in the 722 lines
 * above ever touched `process.exitCode` or `process.exit`. `node
 * scripts/verify-color.mts; echo $?` printed 0 no matter what the run said.
 *
 * That is worse than the gotcha 50 shape it resembles. There, an exit code was
 * assigned too early, so a third of verify-tabs could not fail; here NONE of
 * this file could fail, and this file is the only automated check for the APCA
 * and WCAG maths, the ladder's Lc floors, and the accent-ink derivation across
 * every built-in theme crossed with every profile swatch — the two things
 * gotchas 43 and 44 exist to protect. `npm run check` would have gone green
 * over a regression that reprinted gotcha 44's 1.43:1 focus ring, and so would
 * the release gate, which runs this suite as its own CI step.
 *
 * Counterfactual, measured both ways before this line was added: with a floor
 * forced to fail the run printed FAIL and exited 0; with this line it exits 1.
 */

/*
 * ------------------------------------------------------------ token defined?
 *
 * Every `var(--token)` written without a fallback, against every name anything
 * actually defines. A custom property that does not exist is invalid at
 * computed-value time, so the whole declaration is dropped — silently, with no
 * console warning and no visual clue beyond the property simply not applying.
 *
 * `.field-stamp` asked for `var(--space-6)` and the scale is 4, 8, 12, 16, 24,
 * 32, 48. It had no left margin at all and read as a rendering quirk. Nothing
 * in the check chain could see it: a typo in a token name is not a type error,
 * it does not throw, and the build emits it unchanged. This is the only check
 * that can, and it is why gotcha 22 says to rename a token rather than
 * renumber it in place.
 *
 * Definitions come from three places because tokens do: `--x:` in any
 * stylesheet, the theme colours pushed onto :root by `applyTheme` (camelCase
 * keys through the same kebab conversion `theme.ts` uses), and the literal
 * `setProperty('--x', …)` calls for everything derived at runtime.
 */
console.log('\nCSS tokens: every var(--x) without a fallback resolves')

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.(css|tsx|ts)$/.test(full)) out.push(full)
  }
  return out
}

/*
 * Comments are stripped first, and not for tidiness: the prose in this repo
 * quotes token names constantly, and the first run of this check failed on a
 * `var(--x)` inside the comment that explains the check.
 */
const stripComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^\s*\/\/.*$/gm, ' ')

/** camelCase theme key -> `--kebab-case`, the same conversion `theme.ts` makes. */
const cssVar = (key: string): string => `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`

const defined = new Set<string>()
const usedIn = new Map<string, Set<string>>()

for (const theme of BUILT_IN_THEMES) {
  for (const key of Object.keys(theme.colors ?? {})) defined.add(cssVar(key))
}

for (const file of sourceFiles(SRC)) {
  const text = stripComments(readFileSync(file, 'utf8'))
  for (const m of text.matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(m[1])
  for (const m of text.matchAll(/setProperty\(\s*['"`](--[a-z0-9-]+)['"`]/gi)) defined.add(m[1])
  // A `var(--x, fallback)` is a deliberate optional read and is left alone.
  for (const m of text.matchAll(/var\(\s*(--[a-z0-9-]+)\s*\)/gi)) {
    const where = usedIn.get(m[1]) ?? new Set<string>()
    where.add(file.slice(SRC.length + 1))
    usedIn.set(m[1], where)
  }
}

const undefinedTokens = [...usedIn.keys()].filter((t) => !defined.has(t)).sort()
for (const token of undefinedTokens) {
  failures++
  console.log(`  FAIL  ${token} is read but never defined\n        used in ${[...usedIn.get(token)!].join(', ')}`)
}
console.log(
  `  ${undefinedTokens.length ? 'FAIL' : 'PASS'}  ${usedIn.size} tokens read without a fallback, ` +
    `${defined.size} defined, ${undefinedTokens.length} unresolved`
)

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
