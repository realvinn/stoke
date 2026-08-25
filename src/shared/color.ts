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

  /*
   * Display-P3, converted rather than read as if it were sRGB.
   *
   * Treating the three components as sRGB is the tempting one-liner and it is
   * wrong by a visible amount: color(display-p3 1 0 0) is a red no sRGB display
   * can show, and calling it #ff0000 understates its chroma. The primaries are
   * converted properly and the result is left UNCLAMPED, so a caller can still
   * see that it fell outside the gamut; toHex clamps at the end.
   */
  const p3 = /^color\(display-p3\s+([^)]+)\)$/.exec(s)
  if (p3) {
    const parts = p3[1].split(/[\s/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const lin = (v: number): number =>
      Math.abs(v) <= 0.04045 ? v / 12.92 : Math.sign(v) * Math.pow((Math.abs(v) + 0.055) / 1.055, 2.4)
    const r = lin(parseFloat(parts[0]))
    const g = lin(parseFloat(parts[1]))
    const b = lin(parseFloat(parts[2]))
    // P3 -> XYZ(D65) -> sRGB, folded into one matrix.
    const R = 1.2249401762 * r - 0.2249401762 * g + 0.0 * b
    const G = -0.0420569547 * r + 1.0420569547 * g + 0.0 * b
    const B = -0.0196375546 * r - 0.0786360454 * g + 1.0982736 * b
    return {
      r: gammaEncode(R) * 255,
      g: gammaEncode(G) * 255,
      b: gammaEncode(B) * 255,
      a: parts[3] === undefined ? 1 : parseFloat(parts[3])
    }
  }

  /*
   * oklch() and oklab().
   *
   * Not an optional nicety: Chromium 150 — the engine Electron 43 ships —
   * keeps computed colour values in `oklch()` serialisation, so getComputedStyle
   * returns "oklch(0.7 0.15 51)" rather than an rgb() equivalent. Without these
   * two branches every contrast and APCA reading taken off a live page returns
   * null while the code still appears to work, which is the failure mode this
   * whole module exists to avoid.
   *
   * `none` is a valid component meaning "missing", and it behaves as 0 in every
   * conversion, so it is read as 0 rather than rejected.
   */
  const okl = /^okl(ch|ab)\(([^)]+)\)$/.exec(s)
  if (okl) {
    const parts = okl[2].split(/[\s/]+/).filter(Boolean)
    if (parts.length < 3) return null
    const n = (t: string, pct: number): number =>
      t === 'none' ? 0 : t.endsWith('%') ? (parseFloat(t) / 100) * pct : parseFloat(t)
    const alpha = parts[3] === undefined ? 1 : n(parts[3], 1)
    const l = n(parts[0], 1)
    if (okl[1] === 'ch') {
      const c = n(parts[1], 0.4)
      // A bare hue is degrees; the other <angle> units are legal in CSS.
      const raw = parts[2]
      const deg = raw === 'none'
        ? 0
        : raw.endsWith('turn')
          ? parseFloat(raw) * 360
          : raw.endsWith('rad')
            ? (parseFloat(raw) * 180) / Math.PI
            : raw.endsWith('grad')
              ? parseFloat(raw) * 0.9
              : parseFloat(raw)
      return { ...oklchToRgb({ l, c, h: deg }), a: alpha }
    }
    const a = n(parts[1], 0.4)
    const b = n(parts[2], 0.4)
    return { ...oklabToRgb(l, a, b), a: alpha }
  }

  return null
}

/** sRGB transfer function, the inverse of `srgbChannel` below. */
function gammaEncode(x: number): number {
  return x >= 0.0031308 ? 1.055 * Math.pow(x, 1 / 2.4) - 0.055 : 12.92 * x
}

/**
 * OKLab to linear-light sRGB, deliberately unclamped.
 *
 * Callers that need to know whether a colour is representable check the raw
 * components; `oklchToRgb` clamps only at the encode step. That distinction is
 * what makes `maxChroma` possible.
 */
function oklabToLinear(l: number, a: number, b: number): [number, number, number] {
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b
  const s_ = l - 0.0894841775 * a - 1.291485548 * b

  const L = l_ * l_ * l_
  const M = m_ * m_ * m_
  const S = s_ * s_ * s_

  return [
    4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S,
    -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S,
    -0.0041960863 * L - 0.7034186147 * M + 1.707614701 * S
  ]
}

function oklabToRgb(l: number, a: number, b: number): Rgb {
  const [r, g, bl] = oklabToLinear(l, a, b)
  const enc = (v: number): number => Math.min(255, Math.max(0, gammaEncode(v) * 255))
  return { r: enc(r), g: enc(g), b: enc(bl), a: 1 }
}

/** The inverse of `toOklch`. Out-of-gamut components are clamped on encode. */
export function oklchToRgb(o: Oklch): Rgb {
  const hr = (o.h * Math.PI) / 180
  return oklabToRgb(o.l, o.c * Math.cos(hr), o.c * Math.sin(hr))
}

/** Whether an OKLCH triple is representable in sRGB without clamping. */
export function inSrgbGamut(o: Oklch): boolean {
  const hr = (o.h * Math.PI) / 180
  const [r, g, b] = oklabToLinear(o.l, o.c * Math.cos(hr), o.c * Math.sin(hr))
  // A tolerance, because the round trip is not bit-exact and a colour one part
  // in ten thousand outside the cube is not a colour anyone can see the edge of.
  const e = 1e-4
  return r >= -e && r <= 1 + e && g >= -e && g <= 1 + e && b >= -e && b <= 1 + e
}

/**
 * The largest chroma representable at this lightness and hue, by bisection.
 *
 * 40 iterations over [0, 0.4] resolves to about 4e-13, far finer than the 8-bit
 * output can express, so the loop is bounded rather than convergence-tested.
 */
export function maxChroma(l: number, h: number): number {
  let lo = 0
  let hi = 0.4
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2
    if (inSrgbGamut({ l, c: mid, h })) lo = mid
    else hi = mid
  }
  return lo
}

/**
 * Clamp into sRGB by reducing chroma only, preserving lightness and hue.
 *
 * Component clamping is the obvious alternative and it silently changes the
 * hue: authored oklch(0.62 0.30 55) clamps to rgb(255,3,0), which measures back
 * as hue 29.3 — a 26 degree error that no contrast calculation would predict.
 * Chroma reduction is the only clamp that keeps the colour recognisable.
 */
export function fitToSrgb(o: Oklch): Rgb {
  const c = Math.min(o.c, maxChroma(o.l, o.h))
  return oklchToRgb({ ...o, c })
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
