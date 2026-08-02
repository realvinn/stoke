import type { WebContents } from 'electron'
import { withCdp, type OnEvent, type Send } from './cdp.ts'

/**
 * Why a page is slow, as a checklist rather than a data dump.
 *
 * Full Lighthouse was the obvious route and is the wrong one here: its
 * navigation mode wants exclusive control of the target and forces its own
 * reload, which fights with the session the user is actually looking at. The
 * approach that works is the one Chrome's own DevTools MCP takes — record real
 * measurements, then compress hard before anything reaches the model. That tool
 * turns a 29.8 MB trace into roughly four kilobytes of text, and the ratio is
 * the product, not the trace.
 *
 * Coverage is the one measurement that cannot be taken after the fact: unused
 * bytes are only meaningful if tracking started before the bytes arrived. That
 * is the entire reason this reloads by default.
 */

export interface PerfOptions {
  /** Reload to measure a cold load. Without it, coverage and timing are stale. */
  reload?: boolean
}

interface ResourceEntry {
  url: string
  type: string
  transfer: number
  decoded: number
  duration: number
  start: number
  blocking: boolean
  cached: boolean
}

interface ImageIssue {
  src: string
  natural: string
  displayed: string
  wastedPx: number
  format: string
  lazy: boolean
  sized: boolean
}

interface PageMetrics {
  url: string
  painted: boolean
  ttfb: number
  fcp: number
  lcp: number
  lcpElement: string
  cls: number
  clsCulprits: string[]
  domContentLoaded: number
  loadEvent: number
  longTasks: { count: number; total: number; longest: number }
  domNodes: number
  domDepth: number
  resources: ResourceEntry[]
  images: ImageIssue[]
  fonts: { family: string; display: string }[]
  renderBlocking: string[]
  transferTotal: number
}

const verdict = (value: number, good: number, poor: number): string =>
  value <= good ? 'good' : value <= poor ? 'needs improvement' : 'POOR'

const kb = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`

const ms = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(2)}s` : `${Math.round(n)}ms`)

export async function analysePerformance(wc: WebContents, opts: PerfOptions = {}): Promise<string> {
  const reload = opts.reload !== false

  let cssUnused = 0
  let cssTotal = 0
  let jsUnused = 0
  let jsTotal = 0
  let coverageTaken = false

  if (reload) {
    await withCdp(wc, async (send: Send, on: OnEvent) => {
      try {
        await send('DOM.enable')
        await send('CSS.enable')
        await send('Profiler.enable')
        await send('Page.enable')
        // detailed:false keeps coverage at function granularity. Block-level
        // coverage on a large bundle returns a payload big enough to be a
        // problem in itself, and the extra precision changes no advice.
        await send('Profiler.startPreciseCoverage', { detailed: false, callCount: false })
        await send('CSS.startRuleUsageTracking')

        const loaded = new Promise<void>((resolve) => {
          const off = on((method) => {
            if (method === 'Page.loadEventFired') {
              off()
              resolve()
            }
          })
          setTimeout(() => {
            off()
            resolve()
          }, 25_000)
        })

        await send('Page.reload', { ignoreCache: true })
        await loaded
        // Late work — hydration, lazy images, deferred script — lands after the
        // load event, and it is exactly the work that hurts.
        await new Promise((r) => setTimeout(r, 1800))

        const css = await send<{ ruleUsage?: { styleSheetId: string; startOffset: number; endOffset: number; used: boolean }[] }>(
          'CSS.stopRuleUsageTracking'
        )
        /*
         * Two corrections, both found by disbelieving the output.
         *
         * Rule usage accumulates an entry every time a rule is evaluated rather
         * than one per rule, so the same span is reported repeatedly. Summing
         * the raw list claimed 448 MB of CSS for a site shipping a few hundred
         * kilobytes, so distinct spans count once.
         *
         * More importantly, the returned array is not a census of every rule —
         * it reports the ones that were exercised. Deriving "unused" from its
         * used:false entries gave 0% unused on Wikipedia, which loads a large
         * shared stylesheet and cannot possibly use all of it. The denominator
         * has to come from the stylesheets themselves.
         */
        const usedSpans = new Map<string, [number, number]>()
        const sheetIds = new Set<string>()
        for (const rule of css.ruleUsage ?? []) {
          sheetIds.add(rule.styleSheetId)
          if (!rule.used) continue
          usedSpans.set(`${rule.styleSheetId}:${rule.startOffset}-${rule.endOffset}`, [
            rule.startOffset,
            rule.endOffset
          ])
        }
        let cssUsed = 0
        for (const [, [start, end]] of usedSpans) cssUsed += Math.max(0, end - start)

        for (const styleSheetId of sheetIds) {
          try {
            const sheet = await send<{ text?: string }>('CSS.getStyleSheetText', { styleSheetId })
            cssTotal += sheet.text?.length ?? 0
          } catch {
            // A sheet the page has already discarded cannot be measured; it
            // drops out of both sides of the ratio rather than skewing one.
          }
        }
        cssUnused = Math.max(0, cssTotal - cssUsed)

        const js = await send<{
          result?: { url: string; functions: { ranges: { startOffset: number; endOffset: number; count: number }[] }[] }[]
        }>('Profiler.takePreciseCoverage')
        for (const script of js.result ?? []) {
          if (!script.url || script.url.startsWith('extensions::')) continue
          /*
           * V8 hands back nested ranges: a covered function contains uncovered
           * sub-ranges, which contain covered ones again. Summing the covered
           * ones double-counts wildly — the first version reported 0% unused on
           * every script, which is not a number any real page produces.
           *
           * The uncovered regions are exactly the count === 0 ranges, so merge
           * those into disjoint intervals and measure them instead.
           */
          let scriptTotal = 0
          const dead: [number, number][] = []
          for (const fn of script.functions ?? []) {
            for (const range of fn.ranges ?? []) {
              if (range.endOffset > scriptTotal) scriptTotal = range.endOffset
              if (range.count === 0) dead.push([range.startOffset, range.endOffset])
            }
          }
          dead.sort((a, b) => a[0] - b[0])
          let unused = 0
          let cursor = -1
          for (const [start, end] of dead) {
            const from = Math.max(start, cursor)
            if (end > from) {
              unused += end - from
              cursor = end
            }
          }
          jsTotal += scriptTotal
          jsUnused += Math.min(unused, scriptTotal)
        }
        coverageTaken = true

        await send('Profiler.stopPreciseCoverage').catch(() => undefined)
        await send('Profiler.disable').catch(() => undefined)
        await send('CSS.disable').catch(() => undefined)
        await send('DOM.disable').catch(() => undefined)
        await send('Page.disable').catch(() => undefined)
      } catch {
        // Coverage is the optional half. Timing below still works without it.
      }
    })
  }

  const m = (await wc.executeJavaScript(METRICS_SCRIPT, true)) as PageMetrics

  /* -------------------------------------------------------------- render */

  const out: string[] = []
  out.push(`PERFORMANCE OF ${m.url}`)
  out.push(
    reload
      ? '  Measured on a cold reload with cache disabled.'
      : '  Measured on the page as it stands; timings are from whenever it last loaded.'
  )
  out.push('')

  out.push('CORE WEB VITALS')
  if (!m.painted) {
    /*
     * The agent's page is mounted but hidden, so Chromium lays it out and runs
     * its script without ever drawing it. Paint-derived metrics simply do not
     * exist in that state, and reporting the zeros as "LCP 0ms, good" is the
     * most misleading thing this tool could say.
     */
    out.push('  LCP, FCP and CLS are UNAVAILABLE: the page never painted.')
    out.push('  Chromium skips painting for a hidden view, so there is no paint timing to')
    out.push('  read. Open the browser panel in Stoke and run this again for those three.')
  } else {
    out.push(
      `  LCP  ${ms(m.lcp).padStart(8)}  ${verdict(m.lcp, 2500, 4000)}${m.lcpElement ? `   element: ${m.lcpElement}` : ''}`
    )
    out.push(`  CLS  ${m.cls.toFixed(3).padStart(8)}  ${verdict(m.cls, 0.1, 0.25)}`)
    out.push(`  FCP  ${ms(m.fcp).padStart(8)}  ${verdict(m.fcp, 1800, 3000)}`)
  }
  out.push(`  TTFB ${ms(m.ttfb).padStart(8)}  ${verdict(m.ttfb, 800, 1800)}`)
  out.push(
    `  TBT  ${ms(m.longTasks.total).padStart(8)}  ${verdict(m.longTasks.total, 200, 600)}   ` +
      `${m.longTasks.count} long task(s), longest ${ms(m.longTasks.longest)}`
  )
  out.push('  INP cannot be measured without a real interaction; TBT is the lab proxy for it.')
  if (m.painted && m.clsCulprits.length) {
    out.push(`  shifted: ${m.clsCulprits.slice(0, 4).join(', ')}`)
  }
  out.push('')

  out.push('WEIGHT')
  const byType = new Map<string, { count: number; bytes: number }>()
  for (const r of m.resources) {
    const cur = byType.get(r.type) ?? { count: 0, bytes: 0 }
    cur.count += 1
    cur.bytes += r.transfer
    byType.set(r.type, cur)
  }
  out.push(`  ${m.resources.length} requests, ${kb(m.transferTotal)} transferred`)
  for (const [type, v] of [...byType.entries()].sort((a, b) => b[1].bytes - a[1].bytes).slice(0, 7)) {
    out.push(`    ${type.padEnd(12)} ${String(v.count).padStart(3)} req  ${kb(v.bytes).padStart(9)}`)
  }
  const heaviest = [...m.resources].sort((a, b) => b.transfer - a.transfer).slice(0, 5)
  if (heaviest.length) {
    out.push('  heaviest:')
    for (const r of heaviest) out.push(`    ${kb(r.transfer).padStart(9)}  ${ms(r.duration).padStart(7)}  ${shorten(r.url)}`)
  }
  out.push('')

  if (coverageTaken) {
    out.push('UNUSED BYTES  (parsed but never executed or matched on this page)')
    out.push(
      `  JS   ${kb(jsUnused).padStart(9)} of ${kb(jsTotal)}  ${jsTotal ? Math.round((jsUnused / jsTotal) * 100) : 0}% unused`
    )
    out.push(
      `  CSS  ${kb(cssUnused).padStart(9)} of ${kb(cssTotal)}  ${cssTotal ? Math.round((cssUnused / cssTotal) * 100) : 0}% unused`
    )
    out.push('  Route-split code legitimately shows as unused here; a single-route site should not.')
    out.push('')
  }

  const findings: string[] = []

  if (m.renderBlocking.length) {
    findings.push(
      `${m.renderBlocking.length} render-blocking resource(s) in <head>: ${m.renderBlocking.slice(0, 4).map(shorten).join(', ')}`
    )
  }

  const unsized = m.images.filter((i) => !i.sized)
  if (unsized.length) {
    findings.push(
      `${unsized.length} image(s) without width/height, which is the usual cause of layout shift: ` +
        unsized.slice(0, 3).map((i) => shorten(i.src)).join(', ')
    )
  }

  const oversized = m.images.filter((i) => i.wastedPx > 2_000_000).sort((a, b) => b.wastedPx - a.wastedPx)
  if (oversized.length) {
    findings.push(`${oversized.length} image(s) served far larger than displayed:`)
    for (const i of oversized.slice(0, 4)) {
      findings.push(`    ${shorten(i.src)}  ${i.natural} shown at ${i.displayed}`)
    }
  }

  const legacy = m.images.filter((i) => /jpe?g|png|gif/i.test(i.format))
  if (legacy.length > 3) {
    findings.push(`${legacy.length} image(s) in a legacy format; AVIF or WebP would typically halve them.`)
  }

  const badFonts = m.fonts.filter((f) => f.display === 'auto' || f.display === 'block')
  if (badFonts.length) {
    findings.push(
      `${badFonts.length} font face(s) with font-display: ${badFonts[0].display} — text stays invisible while they load. Use swap or optional.`
    )
  }

  if (m.domNodes > 1500) {
    findings.push(`${m.domNodes} DOM nodes, ${m.domDepth} levels deep. Above ~1500 nodes, style and layout costs climb.`)
  }

  const origin = safeOrigin(m.url)
  const thirdParty = m.resources.filter((r) => safeOrigin(r.url) !== origin)
  const thirdPartyBytes = thirdParty.reduce((n, r) => n + r.transfer, 0)
  if (thirdPartyBytes > 0) {
    const byOrigin = new Map<string, number>()
    for (const r of thirdParty) byOrigin.set(safeOrigin(r.url), (byOrigin.get(safeOrigin(r.url)) ?? 0) + r.transfer)
    const top = [...byOrigin.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
    findings.push(
      `Third parties account for ${kb(thirdPartyBytes)} (${Math.round((thirdPartyBytes / (m.transferTotal || 1)) * 100)}% of transfer): ` +
        top.map(([o, b]) => `${o.replace(/^https?:\/\//, '')} ${kb(b)}`).join(', ')
    )
  }

  out.push(`FINDINGS (${findings.length})`)
  if (!findings.length) out.push('  Nothing actionable found in the checks that run here.')
  for (const f of findings) out.push(f.startsWith('    ') ? f : `  - ${f}`)

  return out.join('\n')
}

function shorten(url: string): string {
  try {
    const u = new URL(url)
    const file = u.pathname.split('/').pop() || u.pathname
    return `${u.host}/…/${file}`.slice(0, 64)
  } catch {
    return url.slice(0, 64)
  }
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

/*
 * Runs in the page after load. Every observer uses buffered: true, which is
 * what makes it possible to read entries that were recorded before this script
 * existed — otherwise measuring a load would require instrumenting it first.
 */
const METRICS_SCRIPT = `(async () => {
  const nav = performance.getEntriesByType('navigation')[0] || {}
  const paint = performance.getEntriesByType('paint')
  const fcp = (paint.find((p) => p.name === 'first-contentful-paint') || {}).startTime || 0

  const collect = (type, ms) => new Promise((resolve) => {
    const entries = []
    let obs
    try {
      obs = new PerformanceObserver((list) => entries.push(...list.getEntries()))
      obs.observe({ type, buffered: true })
    } catch { resolve([]); return }
    setTimeout(() => { try { obs.disconnect() } catch {} ; resolve(entries) }, ms)
  })

  const [lcpEntries, shifts, tasks] = await Promise.all([
    collect('largest-contentful-paint', 250),
    collect('layout-shift', 250),
    collect('longtask', 250)
  ])

  const lastLcp = lcpEntries[lcpEntries.length - 1]
  const describe = (el) => {
    if (!el) return ''
    const tag = el.tagName ? el.tagName.toLowerCase() : '?'
    if (el.id) return tag + '#' + el.id
    const cls = (typeof el.className === 'string' ? el.className : '').trim().split(/\\s+/).filter(Boolean).slice(0, 2)
    return cls.length ? tag + '.' + cls.join('.') : tag
  }

  let cls = 0
  const culprits = new Set()
  for (const s of shifts) {
    if (s.hadRecentInput) continue
    cls += s.value
    for (const src of s.sources || []) if (src.node) culprits.add(describe(src.node))
  }

  let longTotal = 0, longest = 0
  for (const t of tasks) {
    // Total Blocking Time counts only the part of a task beyond 50ms.
    longTotal += Math.max(0, t.duration - 50)
    longest = Math.max(longest, t.duration)
  }

  const resources = performance.getEntriesByType('resource').map((r) => ({
    url: r.name,
    type: r.initiatorType || 'other',
    transfer: r.transferSize || 0,
    decoded: r.decodedBodySize || 0,
    duration: r.duration || 0,
    start: r.startTime || 0,
    blocking: (r.renderBlockingStatus || '') === 'blocking',
    cached: (r.transferSize || 0) === 0 && (r.decodedBodySize || 0) > 0
  }))

  const renderBlocking = []
  for (const el of document.head.querySelectorAll('script[src]:not([async]):not([defer]):not([type="module"])')) {
    renderBlocking.push(el.src)
  }
  for (const el of document.head.querySelectorAll('link[rel="stylesheet"]:not([media="print"])')) {
    renderBlocking.push(el.href)
  }

  const images = [...document.querySelectorAll('img')].map((img) => {
    const rect = img.getBoundingClientRect()
    const dw = Math.round(rect.width * (window.devicePixelRatio || 1))
    const dh = Math.round(rect.height * (window.devicePixelRatio || 1))
    const wasted = Math.max(0, img.naturalWidth * img.naturalHeight - dw * dh)
    const ext = (img.currentSrc || img.src || '').split('?')[0].split('.').pop() || ''
    return {
      src: img.currentSrc || img.src || '',
      natural: img.naturalWidth + 'x' + img.naturalHeight,
      displayed: Math.round(rect.width) + 'x' + Math.round(rect.height),
      wastedPx: rect.width > 0 ? wasted : 0,
      format: ext.slice(0, 5),
      lazy: img.loading === 'lazy',
      sized: img.hasAttribute('width') && img.hasAttribute('height')
    }
  }).filter((i) => i.src)

  const fonts = []
  for (const sheet of document.styleSheets) {
    try {
      for (const rule of sheet.cssRules) {
        if (rule.constructor.name === 'CSSFontFaceRule' || rule.type === 5) {
          fonts.push({
            family: (rule.style.getPropertyValue('font-family') || '').replace(/["']/g, '').slice(0, 30),
            display: rule.style.getPropertyValue('font-display') || 'auto'
          })
        }
      }
    } catch { /* cross-origin stylesheet: rules are not readable, which is expected */ }
  }

  let depth = 0
  const measure = (node, d) => {
    if (d > depth) depth = d
    for (const c of node.children) measure(c, d + 1)
  }
  try { measure(document.body, 1) } catch {}

  return {
    url: location.href,
    // Paint timing only exists if the page actually painted. A view that is
    // mounted but hidden lays out and runs script without ever painting, so a
    // zero here means "never drawn", not "drawn instantly".
    painted: paint.length > 0,
    ttfb: Math.max(0, (nav.responseStart || 0) - (nav.requestStart || 0)),
    fcp,
    lcp: lastLcp ? lastLcp.startTime : 0,
    lcpElement: lastLcp ? describe(lastLcp.element) : '',
    cls,
    clsCulprits: [...culprits],
    domContentLoaded: nav.domContentLoadedEventEnd || 0,
    loadEvent: nav.loadEventEnd || 0,
    longTasks: { count: tasks.length, total: longTotal, longest },
    domNodes: document.querySelectorAll('*').length,
    domDepth: depth,
    resources,
    images,
    fonts,
    renderBlocking,
    transferTotal: resources.reduce((n, r) => n + r.transfer, 0) + (nav.transferSize || 0)
  }
})()`
