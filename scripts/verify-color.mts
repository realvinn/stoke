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
  parseColor,
  perceptualDistance,
  toHex,
  toOklch
} from '../src/shared/color.ts'

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

console.log(failures ? `\n${failures} failure(s)` : '\nall colour checks pass')
process.exit(failures ? 1 : 0)
