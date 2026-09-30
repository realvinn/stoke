/**
 * The colour picker's maths: HSV and back, where a point on the hue ring or
 * the saturation/brightness map lands, what an arrow key does, what the colour
 * is called, and where the popover goes.
 *
 * Split out of `ColorPicker.tsx` for the reason `notation.ts` was split out of
 * `ColorField.tsx` (gotcha 31): a rule inside a component is a rule no suite
 * can reach. `verify:color` asserts all of it.
 *
 * HSV rather than OKLCH for the controls, deliberately. The map is a square of
 * saturation against brightness over one hue, and in HSV every point of that
 * square is an sRGB colour — the two CSS gradients that paint it
 * (white→transparent across, black→transparent up, over the pure hue) ARE the
 * HSV formula, so the handle sits exactly on the colour it picks. An OKLCH
 * square has a ragged gamut edge in every hue, and half of it is unpickable.
 * The palette's own maths stays OKLCH: what the picker hands back is a hex,
 * and `deriveAccent` / `agentTokensFor` take it from there.
 *
 * Pure and DOM-free; compiled by both tsconfigs, so no `node:` import (gotcha
 * 27); loaded by a suite under strip-types, so shared imports are relative
 * with `.ts` (gotcha 78).
 */
import { contrastRatio, parseColor, perceptualDistance, toHex, toOklch, type Rgb } from './color.ts'
import { parseNotation } from './notation.ts'

/** Hue in degrees [0, 360), saturation and value (brightness) in [0, 1]. */
export interface Hsv {
  h: number
  s: number
  v: number
}

export function clamp01(x: number): number {
  return Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0
}

/** Any angle onto [0, 360). 360 is 0, -30 is 330; junk is 0. */
export function wrapHue(h: number): number {
  if (!Number.isFinite(h)) return 0
  const r = h % 360
  return r < 0 ? r + 360 : r
}

/** Clamp a stored or dragged HSV into range. */
export function clampHsv(c: Hsv): Hsv {
  return { h: wrapHue(c.h), s: clamp01(c.s), v: clamp01(c.v) }
}

/** HSV to sRGB, components 0-255 unrounded (toHex rounds). */
export function hsvToRgb(c: Hsv): Rgb {
  const { h, s, v } = clampHsv(c)
  const chroma = v * s
  const hp = h / 60
  const x = chroma * (1 - Math.abs((hp % 2) - 1))
  const [r, g, b] =
    hp < 1
      ? [chroma, x, 0]
      : hp < 2
        ? [x, chroma, 0]
        : hp < 3
          ? [0, chroma, x]
          : hp < 4
            ? [0, x, chroma]
            : hp < 5
              ? [x, 0, chroma]
              : [chroma, 0, x]
  const m = v - chroma
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255, a: 1 }
}

/** sRGB to HSV. A grey has no hue and reports 0; `hexToHsv` keeps the old one. */
export function rgbToHsv(c: Rgb): Hsv {
  const r = Math.min(255, Math.max(0, c.r)) / 255
  const g = Math.min(255, Math.max(0, c.g)) / 255
  const b = Math.min(255, Math.max(0, c.b)) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const d = max - min
  const v = max
  const s = max === 0 ? 0 : d / max
  if (d === 0) return { h: 0, s, v }
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return { h: wrapHue(h * 60), s, v }
}

export function hsvToHex(c: Hsv): string {
  return toHex(hsvToRgb(c))
}

/**
 * A stored colour as HSV, or null if it does not parse.
 *
 * `prev` is the picker's own position. A grey has no hue and black has no
 * saturation either, so reading one back from its hex would snap the ring to
 * red and the map to its left edge: drag brightness to the bottom and back up
 * and the colour you started from would be gone. Where the hex cannot say, the
 * previous position stands.
 */
export function hexToHsv(hex: string, prev?: Hsv): Hsv | null {
  const c = parseColor(hex)
  if (!c) return null
  const hsv = rgbToHsv(c)
  if (!prev) return hsv
  if (hsv.v === 0) return { h: prev.h, s: prev.s, v: 0 }
  if (hsv.s === 0) return { h: prev.h, s: 0, v: hsv.v }
  // The same 8-bit colour the picker already shows: keep the exact position,
  // so rounding to a hex never nudges a handle the user is not touching.
  if (toHex(c) === hsvToHex(prev)) return prev
  return hsv
}

/** Two colour strings name the same 8-bit colour. */
export function sameColor(a: string, b: string): boolean {
  const x = parseColor(a)
  const y = parseColor(b)
  return !!x && !!y && toHex(x) === toHex(y)
}

/**
 * What was typed into the picker's hex field, as `#rrggbb`: any notation the
 * colour field takes (`parseNotation`: hex, rgb(), hsl(), oklch(), a few
 * names), plus a bare hex without its `#`, which is how a hex gets pasted.
 * Translucent colours are refused — every colour here is painted opaque.
 */
export function parseTyped(text: string): string | null {
  const t = text.trim()
  if (/^(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(t)) return parseNotation(`#${t}`)
  const c = parseColor(t)
  if (c && c.a < 1) return null
  const hex = parseNotation(t)
  return hex ? hex.toLowerCase() : null
}

/**
 * Whether the text is a whole colour yet, so the picker may follow it as it
 * is typed: six hex digits, or a closed function. "#e0" and "#e07" are on the
 * way to "#e07b2e", not colours to repaint to; Enter and blur take them.
 */
export function typedIsComplete(text: string): boolean {
  const t = text.trim()
  return /^#?[0-9a-f]{6}$/i.test(t) || /\)$/.test(t)
}

/* --------------------------------------------------------------- geometry */

/**
 * The hue under a point on the ring: 0° at the top, increasing clockwise —
 * exactly how `hueRingGradient` draws it (`conic-gradient(from 0deg …)`).
 */
export function hueAt(x: number, y: number, cx: number, cy: number): number {
  const dx = x - cx
  const dy = y - cy
  if (dx === 0 && dy === 0) return 0
  return wrapHue((Math.atan2(dx, -dy) * 180) / Math.PI)
}

/** Where a hue sits on a circle of `radius` round the centre, as an offset. */
export function ringOffset(h: number, radius: number): { x: number; y: number } {
  const a = (wrapHue(h) * Math.PI) / 180
  return { x: radius * Math.sin(a), y: -radius * Math.cos(a) }
}

/** Saturation across, brightness up: the point's colour on the map, clamped to its edges. */
export function svAt(
  x: number,
  y: number,
  box: { left: number; top: number; width: number; height: number }
): { s: number; v: number } {
  const s = box.width > 0 ? clamp01((x - box.left) / box.width) : 0
  const v = box.height > 0 ? clamp01(1 - (y - box.top) / box.height) : 0
  return { s, v }
}

/**
 * The ring's paint, from the same `hsvToHex` the picker reads back — so the
 * ring never shows a colour the handle would not pick. Seven stops are exact:
 * HSV's hue at full saturation and value is linear in sRGB between each
 * primary and secondary, and a gradient of legacy colours interpolates in
 * sRGB. Built here so no hex literal sits in a component (CLAUDE.md).
 */
export function hueRingGradient(): string {
  const stops = [0, 60, 120, 180, 240, 300, 360].map((h) => `${hsvToHex({ h: h % 360, s: 1, v: 1 })} ${h}deg`)
  return `conic-gradient(from 0deg, ${stops.join(', ')})`
}

/** The pure hue under the map: its top-right corner. */
export function pureHue(h: number): string {
  return hsvToHex({ h, s: 1, v: 1 })
}

/* --------------------------------------------------------------- keyboard */

/** One arrow press: a degree on the ring, a percent on the map. Shift is the big step. */
export const HUE_STEP = 1
export const HUE_STEP_BIG = 15
export const SV_STEP = 0.01
export const SV_STEP_BIG = 0.1

/**
 * The ring's keys, or null for a key it does not take. Right and Up turn it
 * clockwise (the value grows), Left and Down back; it wraps, since a hue is a
 * circle. Home is red (0°), End the last degree before it (359°); Page Up and
 * Page Down are the big step.
 */
export function stepHue(h: number, key: string, shift: boolean): number | null {
  const step = shift ? HUE_STEP_BIG : HUE_STEP
  switch (key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return wrapHue(Math.round(h) + step)
    case 'ArrowLeft':
    case 'ArrowDown':
      return wrapHue(Math.round(h) - step)
    case 'PageUp':
      return wrapHue(Math.round(h) + HUE_STEP_BIG)
    case 'PageDown':
      return wrapHue(Math.round(h) - HUE_STEP_BIG)
    case 'Home':
      return 0
    case 'End':
      return 359
    default:
      return null
  }
}

/**
 * The map's keys, or null for a key it does not take. Left and Right move
 * saturation, Up and Down brightness — the axes the handle moves along on
 * screen. Home and End jump to the grey and the vivid edge; Page Up and Page
 * Down are a big step of brightness. Values snap to whole percents, so a
 * position read back from a hex does not step by fractions.
 */
export function stepSv(sv: { s: number; v: number }, key: string, shift: boolean): { s: number; v: number } | null {
  const step = shift ? SV_STEP_BIG : SV_STEP
  const pct = (x: number): number => clamp01(Math.round(x * 100) / 100)
  switch (key) {
    case 'ArrowRight':
      return { s: pct(sv.s + step), v: sv.v }
    case 'ArrowLeft':
      return { s: pct(sv.s - step), v: sv.v }
    case 'ArrowUp':
      return { s: sv.s, v: pct(sv.v + step) }
    case 'ArrowDown':
      return { s: sv.s, v: pct(sv.v - step) }
    case 'PageUp':
      return { s: sv.s, v: pct(sv.v + SV_STEP_BIG) }
    case 'PageDown':
      return { s: sv.s, v: pct(sv.v - SV_STEP_BIG) }
    case 'Home':
      return { s: 0, v: sv.v }
    case 'End':
      return { s: 1, v: sv.v }
    default:
      return null
  }
}

/* ----------------------------------------------------------------- naming */

/**
 * Hue names, each up to the degree it ends at. HSV hue, the one the ring is
 * drawn in, so "the handle is on the orange part" and "orange" agree.
 */
const HUES: readonly [number, string][] = [
  [12, 'red'],
  [38, 'orange'],
  // Amber has a band of its own: #ffbf00 (h45) and an ochre like #c4942d
  // (h41) were both called "yellow", which neither looks like.
  [50, 'amber'],
  [65, 'yellow'],
  [95, 'lime'],
  [150, 'green'],
  [175, 'teal'],
  [195, 'cyan'],
  [222, 'azure'],
  [252, 'blue'],
  [270, 'violet'],
  [295, 'purple'],
  [325, 'magenta'],
  [350, 'pink'],
  [360, 'red']
]

export function hueName(h: number): string {
  const x = wrapHue(h)
  for (const [end, name] of HUES) if (x < end) return name
  return 'red'
}

/**
 * A plain name for a colour, for a screen reader's `aria-valuetext` and the
 * picker's own caption: "vivid orange", "dark blue", "pale pink", "light
 * red", "light grey". Greys are named by brightness alone, because their hue
 * is noise. "light" is the bright half-saturated band between pale and plain:
 * a salmon (#ffa192) is not what "red" makes anyone picture.
 */
export function colorName(c: Hsv): string {
  const { h, s, v } = clampHsv(c)
  if (v < 0.12) return 'black'
  if (s < 0.1) {
    if (v > 0.93) return 'white'
    return v > 0.7 ? 'light grey' : v < 0.35 ? 'dark grey' : 'grey'
  }
  const name = hueName(h)
  if (v < 0.4) return `dark ${name}`
  if (s < 0.35 && v > 0.75) return `pale ${name}`
  if (s < 0.35) return `greyish ${name}`
  if (s < 0.5 && v > 0.85) return `light ${name}`
  if (s > 0.8 && v > 0.8) return `vivid ${name}`
  return name
}

/* -------------------------------------------------------------------- ink */

/**
 * How far the ink Stoke paints can be from the pick before the picker says so:
 * the repo's "visibly a different tier" bar (AGENT_CLEAR_DISTANCE, verify:color's
 * METER_TIER_DISTANCE). Under it the two read as one colour, so a note would be
 * noise; over it, "why is my tag darker than what I picked" deserves an answer.
 */
export const INK_NOTE_DISTANCE = 0.08

/**
 * Whether `deriveAccent` moved the pick far enough to mention, and which way.
 * Null when it did not, or when either colour does not parse.
 */
export function inkShift(pick: string, ink: string): { distance: number; darker: boolean } | null {
  const a = parseColor(pick)
  const b = parseColor(ink)
  if (!a || !b) return null
  const distance = perceptualDistance(a, b)
  if (distance < INK_NOTE_DISTANCE) return null
  return { distance, darker: toOklch(b).l < toOklch(a).l }
}

/**
 * Under this contrast against the page a FILL stops having an edge: a primary
 * button in it is a label floating on nothing. Not WCAG's 3:1 for graphics —
 * every button here also has its label, and 3:1 would refuse most mid-dark
 * colours on a dark theme — but the point where the shape itself is gone
 * (a near-black #261104 measured 1.01:1 on Ember's page).
 */
export const FILL_VANISH_RATIO = 1.5

/**
 * The worst contrast a fill has against the grounds it is painted on, when it
 * is under `FILL_VANISH_RATIO` — so the picker can say so — else null.
 */
export function fillVanishes(fill: string, grounds: readonly string[]): number | null {
  const f = parseColor(fill)
  if (!f) return null
  let worst = Infinity
  for (const g of grounds) {
    const c = parseColor(g)
    if (c) worst = Math.min(worst, contrastRatio(f, c))
  }
  return worst < FILL_VANISH_RATIO ? worst : null
}

/**
 * The worst contrast a text colour has on the grounds it is painted on: the
 * figure the picker prints ("the tag reads at 9.2:1"), measured rather than
 * the floor it was solved to.
 */
export function worstContrast(text: string, grounds: readonly string[]): number | null {
  const t = parseColor(text)
  if (!t) return null
  let worst = Infinity
  for (const g of grounds) {
    const c = parseColor(g)
    if (c) worst = Math.min(worst, contrastRatio(t, c))
  }
  return Number.isFinite(worst) ? worst : null
}

/* -------------------------------------------------------------- placement */

export interface Box {
  left: number
  top: number
  right: number
  bottom: number
}

/**
 * Where the popover goes, as `position: fixed` offsets.
 *
 * Below its swatch if it fits there, else above if it fits there, else on the
 * roomier side — and NEVER over the swatch. The first cut clamped the popover
 * into the window instead, which slid it over the swatch and the field it was
 * editing whenever neither side had room (Interface scale 1.4), and over the
 * swatch again when a popover opened above grew downward. So:
 *  - below is held by its TOP and above by its BOTTOM, the edge beside the
 *    swatch; anything that changes its height moves the far edge, never the
 *    near one;
 *  - `maxHeight` is the room on that side, and the popover scrolls inside it
 *    when its content is taller.
 * `height` is the popover's natural height (its content's, not a capped box).
 * Left-aligned with the swatch, slid left as far as needed at the right edge.
 */
export interface Placement {
  left: number
  /** Set when below: the popover's top edge. */
  top: number | null
  /** Set when above: the distance from the window's bottom to the popover's. */
  bottom: number | null
  maxHeight: number
  side: 'below' | 'above'
}

export function placePopover(
  anchor: Box,
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  gap: number,
  margin: number
): Placement {
  const below = viewport.height - margin - (anchor.bottom + gap)
  const above = anchor.top - gap - margin
  const side: 'below' | 'above' =
    size.height <= below ? 'below' : size.height <= above ? 'above' : below >= above ? 'below' : 'above'
  const left = Math.round(Math.max(margin, Math.min(anchor.left, viewport.width - margin - size.width)))
  return side === 'below'
    ? { left, top: Math.round(anchor.bottom + gap), bottom: null, maxHeight: Math.max(0, Math.floor(below)), side }
    : {
        left,
        top: null,
        bottom: Math.round(viewport.height - (anchor.top - gap)),
        maxHeight: Math.max(0, Math.floor(above)),
        side
      }
}

/**
 * Whether the swatch a popover hangs off is still where the user can see it:
 * its centre inside every box that clips it (each scrolling ancestor and the
 * window, intersected by the caller). Once it is not — the Settings pane
 * scrolled it away — the popover has nothing to hang off, and the picker
 * closes (keeping the pick, as a click elsewhere does) rather than float over
 * the sheet's header attached to nothing.
 */
export function anchorShown(anchor: Box, clip: Box): boolean {
  const x = (anchor.left + anchor.right) / 2
  const y = (anchor.top + anchor.bottom) / 2
  return x >= clip.left && x <= clip.right && y >= clip.top && y <= clip.bottom
}

/** Two boxes' overlap (empty boxes have right < left or bottom < top). */
export function intersectBox(a: Box, b: Box): Box {
  return {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom)
  }
}
