import type { WebContents } from 'electron'
import { captureSnapshot, DESIGN_PROPS, withCdp, type SnapshotDoc, type Send } from './cdp.ts'
import {
  apcaContrast,
  contrastRatio,
  over,
  toHex,
  toOklch,
  perceptualDistance,
  type Rgb
  /*
   * Relative with an explicit .ts, not the @shared alias: main-process modules
   * run directly under node --experimental-strip-types, which does not resolve
   * the alias. Type-only imports may use it, since those are erased.
   */
} from '../../shared/color.ts'

/**
 * What a page looks like, as text an agent can reason about.
 *
 * The whole design rests on one measurement: a DOMSnapshot of a content-heavy
 * page returns roughly two megabytes of computed styles for thirteen thousand
 * nodes in a couple of hundred milliseconds. That is far too much to hand to a
 * model and far more than enough to answer every question worth asking, so all
 * the work happens here and only the digest travels.
 *
 * The report is flat annotated lines rather than nested JSON. A design system
 * is a set of repeated decisions, and "value (n uses, x%)" states the decision
 * and its weight in a form that reads like a design-system README, which is
 * both denser than JSON and closer to how the answer gets used.
 */

export interface DesignOptions {
  limit?: number
  contrastDetail?: boolean
}

interface Tally {
  weight: number
  count: number
}

class Counter {
  private readonly map = new Map<string, Tally>()

  add(key: string, weight = 1): void {
    const cur = this.map.get(key)
    if (cur) {
      cur.weight += weight
      cur.count += 1
    } else {
      this.map.set(key, { weight, count: 1 })
    }
  }

  get total(): number {
    let n = 0
    for (const v of this.map.values()) n += v.weight
    return n
  }

  ranked(limit = 12): { key: string; weight: number; count: number; share: number }[] {
    const total = this.total || 1
    return [...this.map.entries()]
      .map(([key, v]) => ({ key, weight: v.weight, count: v.count, share: v.weight / total }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, limit)
  }

  get size(): number {
    return this.map.size
  }
}

const px = (v: string | undefined): number | null => {
  if (!v) return null
  const m = /^(-?[\d.e+]+)px$/i.exec(v.trim())
  return m ? parseFloat(m[1]) : null
}

const pct = (n: number): string => `${Math.round(n * 100)}%`

/* ------------------------------------------------------- colour resolution */

interface PageFacts {
  colors: Record<string, [number, number, number, number] | null>
  prefersDark: boolean
  colorScheme: string
}

/**
 * Resolve CSS colour strings to sRGB bytes using Chrome's own colour engine.
 *
 * Computed styles are no longer rgb(). A page authored in OKLCH — which now
 * means any Tailwind v4 site — reports `oklab(0.13 -0.004 -0.028 / 0.9)` and
 * `lab(1.9 0.28 -5.49)`, and a parser that only understands rgb() and hex
 * silently drops every one of them. The first version of this file reported
 * "0 background colours" on a page with 336 of them for exactly that reason.
 *
 * Hand-rolling Lab and Oklab conversions would work, but the D50 white point,
 * the Bradford adaptation and the gamut clamp are each an opportunity to be
 * quietly wrong in a way no test would catch. Painting one pixel and reading it
 * back asks the browser what it actually drew, which is the number contrast
 * maths is supposed to be about anyway.
 *
 * One round trip for every distinct string on the page, not one per node.
 */
async function resolvePageColors(wc: WebContents, values: string[]): Promise<PageFacts> {
  const payload = JSON.stringify(values)
  return (await wc.executeJavaScript(
    `(() => {
      const values = ${payload}
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      const ctx = canvas.getContext('2d', { willReadFrequently: true })
      const colors = {}
      for (const v of values) {
        if (!v || !CSS.supports('color', v)) { colors[v] = null; continue }
        ctx.clearRect(0, 0, 1, 1)
        ctx.fillStyle = v
        ctx.fillRect(0, 0, 1, 1)
        const d = ctx.getImageData(0, 0, 1, 1).data
        colors[v] = [d[0], d[1], d[2], d[3] / 255]
      }
      return {
        colors,
        prefersDark: matchMedia('(prefers-color-scheme: dark)').matches,
        colorScheme: getComputedStyle(document.documentElement).colorScheme || 'normal'
      }
    })()`,
    true
  )) as PageFacts
}

/* ------------------------------------------------------------------ report */

interface ContrastMiss {
  where: string
  sample: string
  fontPx: number
  bold: boolean
  fg: string
  bg: string
  ratio: number
  lc: number
  needsRatio: number
}

export async function analyseDesign(wc: WebContents, opts: DesignOptions = {}): Promise<string> {
  const limit = opts.limit ?? 12

  const { snap, mediaPx } = await withCdp(wc, async (send: Send) => {
    const captured = await captureSnapshot(send)
    let breakpoints: number[] = []
    try {
      await send('DOM.enable')
      await send('CSS.enable')
      const media = await send<{ medias?: { text?: string }[] }>('CSS.getMediaQueries')
      const found = new Set<number>()
      for (const m of media.medias ?? []) {
        for (const hit of (m.text ?? '').matchAll(/(?:min|max)-width\s*:\s*([\d.]+)px/g)) {
          found.add(Math.round(parseFloat(hit[1])))
        }
      }
      breakpoints = [...found].sort((a, b) => a - b)
      await send('CSS.disable').catch(() => undefined)
      await send('DOM.disable').catch(() => undefined)
    } catch {
      // Media queries are a nice-to-have. A page with no author stylesheets, or
      // cross-origin sheets Chrome will not enumerate, simply reports none.
    }
    return { snap: captured, mediaPx: breakpoints }
  })

  const doc = snap.documents?.[0]
  if (!doc) return 'No document captured. Is a page open?'

  const S = (i: number | undefined): string =>
    i === undefined || i < 0 ? '' : (snap.strings[i] ?? '')

  const propIndex = new Map<string, number>()
  DESIGN_PROPS.forEach((p, i) => propIndex.set(p, i))
  const styleOf = (layoutIdx: number, prop: string): string => {
    const row = doc.layout.styles[layoutIdx]
    const at = propIndex.get(prop)
    if (!row || at === undefined) return ''
    return S(row[at])
  }

  /* -------- resolve every distinct colour once, through the browser -------- */

  const colorProps = ['color', 'background-color', 'border-top-color']
  const distinct = new Set<string>()
  for (let i = 0; i < doc.layout.nodeIndex.length; i++) {
    for (const p of colorProps) {
      const v = styleOf(i, p)
      if (v) distinct.add(v)
    }
    // Shadow colours are embedded in a compound value rather than being a
    // property of their own, so pull them out for the same resolution pass.
    for (const token of styleOf(i, 'box-shadow').match(COLOR_TOKEN) ?? []) distinct.add(token)
  }
  const facts = await resolvePageColors(wc, [...distinct])
  const colorCache = new Map<string, Rgb | null>()
  const col = (value: string): Rgb | null => {
    if (!value) return null
    if (colorCache.has(value)) return colorCache.get(value) ?? null
    const raw = facts.colors[value]
    const out: Rgb | null = raw ? { r: raw[0], g: raw[1], b: raw[2], a: raw[3] } : null
    colorCache.set(value, out)
    return out
  }

  /* -------- node identity and ancestry -------- */

  const layoutOf = new Map<number, number>()
  for (let i = 0; i < doc.layout.nodeIndex.length; i++) layoutOf.set(doc.layout.nodeIndex[i], i)

  const attrsOf = (nodeIdx: number): Record<string, string> => {
    const flat = doc.nodes.attributes?.[nodeIdx] ?? []
    const out: Record<string, string> = {}
    for (let i = 0; i + 1 < flat.length; i += 2) out[S(flat[i])] = S(flat[i + 1])
    return out
  }

  const describe = (nodeIdx: number): string => {
    let idx = nodeIdx
    // Text nodes carry no attributes; name the element they sit in.
    while (idx >= 0 && doc.nodes.nodeType[idx] !== 1) idx = doc.nodes.parentIndex[idx] ?? -1
    if (idx < 0) return '?'
    const tag = S(doc.nodes.nodeName[idx]).toLowerCase() || '?'
    const a = attrsOf(idx)
    if (a.id) return `${tag}#${a.id}`
    const cls = (a.class || '').trim().split(/\s+/).filter(Boolean).slice(0, 2)
    return cls.length ? `${tag}.${cls.join('.')}` : tag
  }

  /*
   * The background a reader actually sees behind a run of text.
   *
   * DOMSnapshot advertises includeBlendedBackgroundColors and returns an array
   * of the right length filled entirely with empty strings, so contrast checks
   * built on it reported "nothing fails" on every page — vacuous rather than
   * passing, which is the worst shape a result can take. Compositing the
   * ancestor chain by hand is well defined and gives the same answer, provided
   * it stops at an image or gradient instead of guessing what is underneath.
   */
  const bgCache = new Map<number, Rgb | null>()
  const effectiveBackground = (nodeIdx: number): Rgb | null => {
    const cached = bgCache.get(nodeIdx)
    if (cached !== undefined) return cached

    const chain: number[] = []
    const layers: Rgb[] = []
    let idx = nodeIdx
    let resolved: Rgb | null = null

    while (idx >= 0) {
      chain.push(idx)
      const cachedHere = bgCache.get(idx)
      if (cachedHere !== undefined && idx !== nodeIdx) {
        resolved = cachedHere
        break
      }
      const li = layoutOf.get(idx)
      if (li !== undefined) {
        const image = styleOf(li, 'background-image')
        if (image && image !== 'none') {
          resolved = null
          break
        }
        const c = col(styleOf(li, 'background-color'))
        if (c && c.a > 0.004) {
          layers.push(c)
          if (c.a >= 0.999) {
            resolved = c
            break
          }
        }
      }
      idx = doc.nodes.parentIndex[idx] ?? -1
    }

    let out: Rgb | null = null
    if (resolved) {
      // Composite the translucent layers gathered on the way down onto the
      // first opaque one, nearest layer last.
      out = resolved
      const translucent = layers.filter((l) => l.a < 0.999)
      for (let i = translucent.length - 1; i >= 0; i--) out = over(translucent[i], out)
    }
    for (const n of chain) if (!bgCache.has(n)) bgCache.set(n, out)
    return out
  }

  /* -------- accumulate -------- */

  const typeScale = new Counter()
  const families = new Counter()
  const textColors = new Counter()
  const bgColors = new Counter()
  const spacing = new Counter()
  const radii = new Counter()
  const shadows = new Counter()
  const displays = new Counter()
  const gridCols = new Counter()
  const zLayers = new Counter()

  const contrastMisses: ContrastMiss[] = []
  let textNodes = 0
  let contrastChecked = 0
  let contrastUnknown = 0
  let widestContent = 0

  const layoutCount = doc.layout.nodeIndex.length

  for (let i = 0; i < layoutCount; i++) {
    const nodeIdx = doc.layout.nodeIndex[i]
    const bounds = doc.layout.bounds[i] ?? [0, 0, 0, 0]
    const area = Math.max(0, bounds[2]) * Math.max(0, bounds[3])
    const isText = doc.nodes.nodeType[nodeIdx] === 3
    const text = S(doc.layout.text?.[i])

    const display = styleOf(i, 'display')
    if (display && !isText) displays.add(display, 1)
    if (display === 'grid' || display === 'inline-grid') {
      const cols = styleOf(i, 'grid-template-columns')
      if (cols && cols !== 'none') gridCols.add(cols.length > 70 ? `${cols.slice(0, 67)}…` : cols)
    }
    const z = styleOf(i, 'z-index')
    if (z && z !== 'auto' && z !== '0') zLayers.add(`${z} ${describe(nodeIdx)}`)

    const maxW = px(styleOf(i, 'max-width'))
    if (maxW && maxW > 320 && maxW < 3000 && maxW > widestContent) widestContent = maxW

    if (!isText && area > 0) {
      const radius = describeRadius(styleOf(i, 'border-radius'))
      if (radius) radii.add(radius, 1)

      const shadow = describeShadow(styleOf(i, 'box-shadow'), col)
      if (shadow) shadows.add(shadow, 1)

      const bg = col(styleOf(i, 'background-color'))
      if (bg && bg.a > 0.02) bgColors.add(toHex(bg), area)

      for (const prop of [
        'margin-top',
        'margin-bottom',
        'padding-top',
        'padding-left',
        'padding-bottom',
        'gap'
      ]) {
        const v = px(styleOf(i, prop))
        if (v !== null && v > 0 && v < 400) spacing.add(String(Math.round(v)), 1)
      }
    }

    if (!isText || !text.trim()) continue
    const weight = text.trim().length
    textNodes += 1

    const size = px(styleOf(i, 'font-size')) ?? 0
    const fw = styleOf(i, 'font-weight') || '400'
    const lh = styleOf(i, 'line-height')
    const family = styleOf(i, 'font-family')

    if (size > 0) {
      const lhPx = px(lh)
      const ratio = lhPx && size ? (lhPx / size).toFixed(2) : lh || 'normal'
      typeScale.add(`${Math.round(size)}px/${fw}/${ratio}`, weight)
    }
    if (family) families.add(family.split(',')[0].replace(/["']/g, '').trim(), weight)

    const fg = col(styleOf(i, 'color'))
    if (!fg) continue
    textColors.add(toHex(fg), weight)

    const bg = effectiveBackground(nodeIdx)
    if (!bg) {
      contrastUnknown += 1
      continue
    }
    contrastChecked += 1

    // Text may itself be translucent; composite it before judging.
    const ink = fg.a < 1 ? over(fg, bg) : fg
    const bold = Number(fw) >= 700 || fw === 'bold'
    // WCAG 2 "large text": 24px, or 18.66px when bold.
    const large = size >= 24 || (bold && size >= 18.66)
    const needsRatio = large ? 3 : 4.5

    const ratio = contrastRatio(ink, bg)
    if (ratio < needsRatio) {
      contrastMisses.push({
        where: describe(nodeIdx),
        sample: text.trim().slice(0, 40),
        fontPx: Math.round(size),
        bold,
        fg: toHex(ink),
        bg: toHex(bg),
        ratio,
        lc: apcaContrast(ink, bg),
        needsRatio
      })
    }
  }

  /* -------- derive -------- */

  const palette = clusterColors(bgColors.ranked(60), 0.03)
  const inkPalette = clusterColors(textColors.ranked(60), 0.03)

  const spacingRanked = spacing.ranked(40)
  const spacingValues = [...new Set(spacingRanked.map((r) => Number(r.key)))].sort((a, b) => a - b)
  const base = inferBaseUnit(spacingValues)
  const onScale = base ? spacingValues.filter((v) => v % base === 0) : spacingValues
  const drift = base
    ? spacingRanked
        .filter((r) => Number(r.key) % base !== 0)
        .sort((a, b) => b.weight - a.weight)
        .slice(0, 8)
    : []

  /* -------- render -------- */

  const out: string[] = []
  out.push(`DESIGN OF ${S(doc.documentURL)}`)
  out.push(
    `  ${textNodes} text runs, ${layoutCount} laid-out nodes, ` +
      `rendered in ${facts.prefersDark ? 'DARK' : 'LIGHT'} mode (color-scheme: ${facts.colorScheme})`
  )
  if (facts.prefersDark) {
    out.push('  The OS prefers dark, so a theme-aware page is showing its dark palette here.')
  }
  out.push('')

  out.push(`TYPE SCALE (${typeScale.size} distinct size/weight/leading combinations)`)
  for (const r of typeScale.ranked(limit)) {
    out.push(`  ${r.key.padEnd(24)} ${pct(r.share).padStart(4)} of text`)
  }
  const famRows = families.ranked(5)
  if (famRows.length) {
    out.push(`  families: ${famRows.map((f) => `${f.key} ${pct(f.share)}`).join(' | ')}`)
  }
  out.push('')

  out.push(`INK (${inkPalette.length} text colours after perceptual merge)`)
  for (const c of inkPalette.slice(0, limit)) {
    out.push(`  ${c.hex.padEnd(10)} ${pct(c.share).padStart(4)} of text   ${oklchOf(c.hex)}`)
  }
  out.push('')

  out.push(`SURFACES (${palette.length} background colours after perceptual merge)`)
  for (const c of palette.slice(0, limit)) {
    out.push(`  ${c.hex.padEnd(10)} ${pct(c.share).padStart(4)} of painted area   ${oklchOf(c.hex)}`)
  }
  out.push('')

  if (spacingValues.length) {
    out.push(
      `SPACING  base unit ${base ? `${base}px` : 'none detected'}` +
        (base ? `, ${onScale.length}/${spacingValues.length} distinct values on the scale` : '')
    )
    out.push(`  on scale: ${onScale.slice(0, 16).join(', ')}`)
    if (drift.length) {
      out.push(`  off scale: ${drift.map((d) => `${d.key}px (x${d.count})`).join(', ')}`)
    }
    out.push('')
  }

  if (radii.size) {
    out.push('RADII')
    for (const r of radii.ranked(6)) out.push(`  ${r.key.padEnd(24)} x${r.count}`)
    out.push('')
  }

  if (shadows.size) {
    out.push(`SHADOWS (${shadows.size} distinct)`)
    for (const r of shadows.ranked(5)) out.push(`  ${r.key}  x${r.count}`)
    out.push('')
  }

  out.push('LAYOUT')
  out.push(`  ${displays.ranked(6).map((d) => `${d.key} x${d.count}`).join(' | ')}`)
  if (widestContent) out.push(`  widest max-width: ${widestContent}px`)
  for (const g of gridCols.ranked(3)) out.push(`  grid: ${g.key} (x${g.count})`)
  if (mediaPx.length) {
    out.push(`  breakpoints declared: ${mediaPx.join(', ')}px`)
  }
  if (zLayers.size) {
    out.push(`  z-layers: ${zLayers.ranked(6).map((z) => z.key).join(' | ')}`)
  }
  out.push('')

  out.push(`CONTRAST (${contrastChecked} text runs checked, ${contrastUnknown} skipped)`)
  if (contrastUnknown) {
    out.push('  Skipped runs sit on an image or gradient, where no single backdrop colour exists.')
  }
  if (!contrastChecked) {
    out.push('  Nothing could be checked — treat this as unknown, not as a pass.')
  } else if (!contrastMisses.length) {
    out.push('  No text fails WCAG 2 AA against its composited background.')
  } else {
    /*
     * One bad colour pair usually appears dozens of times, and listing every
     * instance costs a great deal of context to say one thing. Group by the
     * decision that is actually wrong — this foreground, on that background, at
     * that size — and name a few places it shows up.
     */
    const groups = new Map<string, { miss: ContrastMiss; count: number; where: Set<string> }>()
    for (const m of contrastMisses) {
      const key = `${m.fg}|${m.bg}|${m.fontPx}|${m.bold}`
      const g = groups.get(key)
      if (g) {
        g.count += 1
        g.where.add(m.where)
      } else {
        groups.set(key, { miss: m, count: 1, where: new Set([m.where]) })
      }
    }
    const ranked = [...groups.values()].sort((a, b) => a.miss.ratio - b.miss.ratio)
    const shown = ranked.slice(0, opts.contrastDetail ? 40 : 12)
    out.push(
      `  ${contrastMisses.length} text run(s) below WCAG 2 AA, in ${groups.size} distinct pairing(s):`
    )
    for (const g of shown) {
      const m = g.miss
      out.push(
        `  ${m.ratio.toFixed(2)}:1 (needs ${m.needsRatio}) Lc ${m.lc.toFixed(0)}  ` +
          `${m.fg} on ${m.bg}  ${m.fontPx}px${m.bold ? ' bold' : ''}  x${g.count}`
      )
      out.push(
        `      ${[...g.where].slice(0, 3).join(', ')}${g.where.size > 3 ? ', …' : ''}  e.g. "${m.sample}"`
      )
    }
    if (ranked.length > shown.length) {
      out.push(`  ...and ${ranked.length - shown.length} more pairings`)
    }
    out.push('  Lc is APCA lightness contrast: |Lc| >= 60 for body text, >= 45 for large.')
    out.push('  WCAG 2 and APCA disagree on dark and near-black pairs; both are shown.')
  }

  return out.join('\n')
}

/* ----------------------------------------------------------------- helpers */

/**
 * Chrome clamps an enormous radius rather than reporting what was authored, so
 * `border-radius: 9999px` comes back as 33554400px. Reporting that verbatim is
 * noise; every author who wrote it meant "pill".
 */
function describeRadius(value: string): string | null {
  if (!value || value === '0px') return null
  const n = px(value)
  if (n !== null && n >= 1000) return 'pill (fully rounded)'
  return value.length > 30 ? `${value.slice(0, 27)}…` : value
}

/** Every colour token inside a compound value such as box-shadow. */
export const COLOR_TOKEN = /(?:rgba?|hsla?|oklab|oklch|lab|lch|color)\([^)]*\)|#[0-9a-fA-F]{3,8}\b/g

/**
 * Utility CSS emits a shadow slot per layer whether or not the layer is used,
 * so most elements carry `rgba(0, 0, 0, 0) 0px 0px 0px 0px` several times over.
 * Those draw nothing and would otherwise dominate the frequency table.
 *
 * Colours are rewritten to hex, because a shadow reading
 * `oklab(0.999994 0.0000455678 0.0000200868 / 0.1)` tells a reader nothing that
 * `#ffffff1a` does not tell them immediately.
 */
function describeShadow(value: string, resolve: (s: string) => Rgb | null): string | null {
  if (!value || value === 'none') return null
  const kept = value.split(/,(?![^(]*\))/).map((s) => s.trim()).filter((s) => {
    const colors = s.match(COLOR_TOKEN) ?? []
    // A layer whose every colour is fully transparent paints nothing.
    return !(colors.length && colors.every((c) => (resolve(c)?.a ?? 1) < 0.004))
  })
  if (!kept.length) return null

  const joined = kept
    .map((s) =>
      s.replace(COLOR_TOKEN, (m) => {
        const c = resolve(m)
        if (!c) return m
        const alpha = c.a >= 0.999 ? '' : Math.round(c.a * 255).toString(16).padStart(2, '0')
        return `${toHex(c)}${alpha}`
      })
    )
    .join(', ')
  return joined.length > 72 ? `${joined.slice(0, 69)}…` : joined
}

function oklchOf(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const rgb: Rgb = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  const o = toOklch(rgb)
  return `oklch(${o.l.toFixed(3)} ${o.c.toFixed(3)} ${o.h.toFixed(1)})`
}

interface Swatch {
  hex: string
  share: number
  weight: number
}

/**
 * Merge swatches a reader would call one colour. Hex equality reports #3b82f6
 * and #3a81f5 as two palette entries; perceptual distance in OKLab collapses
 * them, which is what makes the palette match what is on screen rather than
 * what is in the stylesheet.
 */
function clusterColors(
  ranked: { key: string; weight: number }[],
  threshold: number
): Swatch[] {
  const clusters: { rep: Rgb; hex: string; weight: number }[] = []
  for (const entry of ranked) {
    const n = parseInt(entry.key.slice(1), 16)
    if (Number.isNaN(n)) continue
    const rgb: Rgb = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
    const near = clusters.find((c) => perceptualDistance(c.rep, rgb) < threshold)
    if (near) {
      near.weight += entry.weight
    } else {
      // Entries arrive heaviest first, so the first of a cluster is its best
      // representative and later members only add weight.
      clusters.push({ rep: rgb, hex: entry.key, weight: entry.weight })
    }
  }
  const total = clusters.reduce((n, c) => n + c.weight, 0) || 1
  return clusters
    .sort((a, b) => b.weight - a.weight)
    .map((c) => ({ hex: c.hex, weight: c.weight, share: c.weight / total }))
}

/**
 * Infer the spacing base unit by finding the divisor that explains the most
 * observed values. A design system almost always has one; naming it turns a
 * list of numbers into a rule and makes the exceptions worth reporting.
 */
function inferBaseUnit(values: number[]): number {
  const distinct = [...new Set(values.filter((v) => v > 0))]
  if (distinct.length < 3) return 0
  let best = 0
  let bestScore = 0
  for (const candidate of [8, 4, 6, 10, 12, 16, 5, 3, 2]) {
    const hits = distinct.filter((v) => v % candidate === 0).length
    // Larger units explain less by accident, so weight them slightly higher.
    const score = hits * Math.log2(candidate + 1)
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }
  const coverage = distinct.filter((v) => v % best === 0).length / distinct.length
  return coverage >= 0.5 ? best : 0
}

export type { SnapshotDoc }
