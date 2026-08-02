/**
 * Colour maths for design analysis.
 *
 * Three jobs, each needing a different model:
 *
 *  - WCAG 2 contrast ratio, because it is what accessibility conformance is
 *    still written against and what an auditor will check.
 *  - APCA lightness contrast, because WCAG 2's ratio is known to misjudge
 *    dark-mode and near-black pairs, and the two disagree sharply enough that
 *    reporting only one is misleading. Both are reported; neither is hidden.
 *  - OKLab, because clustering colours by hex treats #3b82f6 and #3a81f5 as two
 *    entries in a palette when a reader sees one. Perceptual distance is the
 *    only way to get a palette that matches what is on screen.
 */

export interface Rgb {
  r: number
  g: number
  b: number
  a: number
}

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0],
  white: [255, 255, 255],
  red: [255, 0, 0],
  green: [0, 128, 0],
  blue: [0, 0, 255],
  gray: [128, 128, 128],
  grey: [128, 128, 128]
}

/**
 * Parse the colour syntaxes a computed style actually yields.
 *
 * Chromium normalises most authored colours to `rgb()` / `rgba()`, but it emits
 * `color(srgb ...)` for wide-gamut authored values and bare keywords survive in
 * a few places, so all three are handled. Anything unrecognised returns null
 * rather than a guess: a wrong colour silently corrupts every contrast number
 * downstream, whereas a missing one merely drops a row from the report.
 */
export function parseColor(input: string | undefined | null): Rgb | null {
  if (!input) return null
  const s = input.trim().toLowerCase()
  if (!s || s === 'none' || s === 'currentcolor') return null
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }

  if (NAMED[s]) {
    const [r, g, b] = NAMED[s]
    return { r, g, b, a: 1 }
  }

  if (s.startsWith('#')) {
    const hex = s.slice(1)
    const grab = (i: number, len: number): number =>
      len === 1
        ? parseInt(hex[i] + hex[i], 16)
        : parseInt(hex.slice(i * 2, i * 2 + 2), 16)
    if (hex.length === 3 || hex.length === 4) {
      return {
        r: grab(0, 1),
        g: grab(1, 1),
        b: grab(2, 1),
        a: hex.length === 4 ? grab(3, 1) / 255 : 1
      }
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: grab(0, 2),
        g: grab(1, 2),
        b: grab(2, 2),
        a: hex.length === 8 ? grab(3, 2) / 255 : 1
      }
    }
    return null
  }

  // rgb(1 2 3 / 0.5) and rgb(1, 2, 3, 0.5) are both current syntax.
  const fn = /^rgba?\(([^)]+)\)$/.exec(s)
  if (fn) {
    const parts = fn[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const num = (t: string, scale: number): number =>
      t.endsWith('%') ? (parseFloat(t) / 100) * scale : parseFloat(t)
    return {
      r: num(parts[0], 255),
      g: num(parts[1], 255),
      b: num(parts[2], 255),
      a: parts[3] === undefined ? 1 : num(parts[3], 1)
    }
  }

  const wide = /^color\(srgb\s+([^)]+)\)$/.exec(s)
  if (wide) {
    const parts = wide[1].split(/[\s/]+/).filter(Boolean)
    if (parts.length < 3) return null
    return {
      r: parseFloat(parts[0]) * 255,
      g: parseFloat(parts[1]) * 255,
      b: parseFloat(parts[2]) * 255,
      a: parts[3] === undefined ? 1 : parseFloat(parts[3])
    }
  }

  return null
}

export function toHex(c: Rgb): string {
  const h = (n: number): string =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

/** Composite a translucent colour over an opaque one. */
export function over(fg: Rgb, bg: Rgb): Rgb {
  if (fg.a >= 1) return fg
  const a = fg.a
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
    a: 1
  }
}

/* ------------------------------------------------------------------ WCAG 2 */

function srgbChannel(c: number): number {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export function relativeLuminance(c: Rgb): number {
  return 0.2126 * srgbChannel(c.r) + 0.7152 * srgbChannel(c.g) + 0.0722 * srgbChannel(c.b)
}

/** WCAG 2 contrast ratio, 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a)
  const l2 = relativeLuminance(b)
  const hi = Math.max(l1, l2)
  const lo = Math.min(l1, l2)
  return (hi + 0.05) / (lo + 0.05)
}

/* --------------------------------------------------------------------- APCA */

/*
 * APCA-W3 (0.1.9 constants). Unlike the WCAG 2 ratio this is polarity-aware —
 * dark-on-light and light-on-dark are different problems and get different
 * numbers — and it is signed: positive Lc means dark text on a light ground.
 * Only the magnitude matters for judging legibility.
 */
const MAIN_TRC = 2.4
const NORM_BG = 0.56
const NORM_TXT = 0.57
const REV_TXT = 0.62
const REV_BG = 0.65
const BLK_THRS = 0.022
const BLK_CLMP = 1.414
const SCALE_BOW = 1.14
const SCALE_WOB = 1.14
const LO_BOW_OFFSET = 0.027
const LO_WOB_OFFSET = 0.027
const DELTA_Y_MIN = 0.0005
const LO_CLIP = 0.1

function apcaY(c: Rgb): number {
  const f = (v: number): number => Math.pow(Math.max(0, Math.min(255, v)) / 255, MAIN_TRC)
  return 0.2126729 * f(c.r) + 0.7151522 * f(c.g) + 0.072175 * f(c.b)
}

function softClampBlack(y: number): number {
  return y > BLK_THRS ? y : y + Math.pow(BLK_THRS - y, BLK_CLMP)
}

/**
 * Lightness contrast, roughly -108 to +106. Sign encodes polarity; the usual
 * reading thresholds are |Lc| >= 60 for body text, >= 45 for large text and
 * >= 30 for anything that must merely be perceivable.
 */
export function apcaContrast(text: Rgb, background: Rgb): number {
  const yTxt = softClampBlack(apcaY(text))
  const yBg = softClampBlack(apcaY(background))
  if (Math.abs(yBg - yTxt) < DELTA_Y_MIN) return 0

  if (yBg > yTxt) {
    const sapc = (Math.pow(yBg, NORM_BG) - Math.pow(yTxt, NORM_TXT)) * SCALE_BOW
    return sapc < LO_CLIP ? 0 : (sapc - LO_BOW_OFFSET) * 100
  }
  const sapc = (Math.pow(yBg, REV_BG) - Math.pow(yTxt, REV_TXT)) * SCALE_WOB
  return sapc > -LO_CLIP ? 0 : (sapc + LO_WOB_OFFSET) * 100
}

/* -------------------------------------------------------------------- OKLab */

function linear(c: number): number {
  const s = Math.max(0, Math.min(255, c)) / 255
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
}

export interface Oklch {
  l: number
  c: number
  h: number
}

/** Björn Ottosson's sRGB to OKLab, then to cylindrical OKLCH. */
export function toOklch(rgb: Rgb): Oklch {
  const r = linear(rgb.r)
  const g = linear(rgb.g)
  const b = linear(rgb.b)

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)

  const okL = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s
  const okA = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s
  const okB = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s

  const chroma = Math.hypot(okA, okB)
  let hue = (Math.atan2(okB, okA) * 180) / Math.PI
  if (hue < 0) hue += 360
  return { l: okL, c: chroma, h: hue }
}

/**
 * Perceptual distance in OKLab. Used only to decide whether two swatches are
 * "the same colour" for palette purposes, so the crude Euclidean form is
 * enough — nothing here depends on it being a calibrated difference metric.
 */
export function perceptualDistance(a: Rgb, b: Rgb): number {
  const x = toOklch(a)
  const y = toOklch(b)
  const dh = ((x.h - y.h + 540) % 360) - 180
  const chordal = 2 * Math.sqrt(x.c * y.c) * Math.sin((dh * Math.PI) / 360)
  return Math.hypot(x.l - y.l, x.c - y.c, chordal)
}
