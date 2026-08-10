/*
 * Colour maths against published reference values.
 *
 * APCA and OKLab are both easy to implement almost correctly, and the failure
 * mode is not an exception — it is a plausible number that quietly misjudges
 * every contrast pair on every page. These anchors come from the reference
 * implementations, so a regression here shows up as a wrong number rather than
 * as a crash.
 *
 *   node scripts/verify-color.mts
 */
import {
  apcaContrast,
  contrastRatio,
  over,
  parseColor,
  perceptualDistance,
  toHex,
  toOklch
} from '../src/shared/color.ts'
import type { Rgb } from '../src/shared/color.ts'
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
const SELECTION_ANSI = [
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
  const below = SELECTION_ANSI.filter((n) => contrastRatio(parseColor(term[n])!, focused) < 4.5)
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

console.log(failures ? `\n${failures} failure(s)` : '\nall colour checks pass')
process.exit(failures ? 1 : 0)
