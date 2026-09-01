/**
 * Reading and writing one colour in the notation a person thinks in.
 *
 * Split out of `ColorField.tsx` rather than left beside it for the reason this
 * repo keeps relearning (gotcha 31): a pure rule inside a component is a rule
 * no suite can reach. `parseNotation` is the only place in Stoke that turns
 * arbitrary typed text into a colour, so it is exactly the kind of thing that
 * should be asserted directly rather than through a rendered input.
 *
 * Everything is STORED as `#rrggbb` regardless of how it was typed, because
 * that is what `ThemeColors` has always held and what every suite in
 * `scripts/` parses. These four are ways to type a value, not formats to keep.
 */
import { parseColor, toHex, toOklch, fitToSrgb, type Rgb } from './color.ts'

export type Notation = 'oklch' | 'hsl' | 'rgb' | 'hex'

export const NOTATIONS: { id: Notation; label: string }[] = [
  { id: 'oklch', label: 'OKLCH' },
  { id: 'hsl', label: 'HSL' },
  { id: 'rgb', label: 'RGB' },
  { id: 'hex', label: 'Hex' }
]

/** sRGB -> HSL. Local because `color.ts` has no need of HSL anywhere else. */
function toHsl(c: Rgb): { h: number; s: number; l: number } {
  const r = c.r / 255
  const g = c.g / 255
  const b = c.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return { h: 0, s: 0, l }
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h =
    max === r
      ? ((g - b) / d + (g < b ? 6 : 0)) * 60
      : max === g
        ? ((b - r) / d + 2) * 60
        : ((r - g) / d + 4) * 60
  return { h, s, l }
}

/**
 * Write the value out in one notation.
 *
 * Rounded to what the notation can actually resolve rather than to a fixed
 * number of places: an OKLCH lightness of 0.7703 and 0.7700 are the same
 * 8-bit colour, so printing four decimals invites edits that do nothing and
 * then read as the field being broken.
 */
export function format(hex: string, notation: Notation): string {
  const c = parseColor(hex)
  if (!c) return hex
  if (notation === 'hex') return toHex(c)
  if (notation === 'rgb') return `rgb(${c.r} ${c.g} ${c.b})`
  if (notation === 'hsl') {
    const { h, s, l } = toHsl(c)
    return `hsl(${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`
  }
  const o = toOklch(c)
  return `oklch(${o.l.toFixed(3)} ${o.c.toFixed(3)} ${o.h.toFixed(1)})`
}

/**
 * Read a value in any of the four notations back to `#rrggbb`.
 *
 * `parseColor` already handles hex, `rgb()` and named colours. The two it does
 * not are handled here, and OKLCH is the one that needs care: a value typed in
 * OKLCH can name a colour sRGB cannot show, so it is passed through
 * `fitToSrgb` -- the same gamut mapping the ladder uses -- rather than being
 * rejected. Refusing it would make the most useful notation the one that most
 * often says no.
 */
export function parseNotation(input: string): string | null {
  const s = input.trim()
  const ok = /^oklch\(\s*([\d.]+%?)\s+([\d.]+)\s+([\d.]+)\s*\)$/i.exec(s)
  if (ok) {
    const l = ok[1].endsWith('%') ? parseFloat(ok[1]) / 100 : parseFloat(ok[1])
    return toHex(fitToSrgb({ l, c: parseFloat(ok[2]), h: parseFloat(ok[3]) }))
  }
  const hsl = /^hsl\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%\s*\)$/i.exec(s)
  if (hsl) {
    const h = parseFloat(hsl[1]) / 360
    const sat = parseFloat(hsl[2]) / 100
    const li = parseFloat(hsl[3]) / 100
    const q = li < 0.5 ? li * (1 + sat) : li + sat - li * sat
    const p = 2 * li - q
    const ch = (t: number): number => {
      let x = t
      if (x < 0) x += 1
      if (x > 1) x -= 1
      if (x < 1 / 6) return p + (q - p) * 6 * x
      if (x < 1 / 2) return q
      if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
      return p
    }
    return toHex({
      r: Math.round(ch(h + 1 / 3) * 255),
      g: Math.round(ch(h) * 255),
      b: Math.round(ch(h - 1 / 3) * 255),
      a: 1
    })
  }
  const c = parseColor(s)
  return c ? toHex(c) : null
}
