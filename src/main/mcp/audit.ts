import type { WebContents } from 'electron'
import { withCdp, type OnEvent, type Send } from './cdp.ts'
import type { NetEntry } from '../browser.ts'

/**
 * A passive security and hygiene audit of a page the browser already loaded.
 *
 * The line this stays behind: everything here reads what Chromium already
 * received or rendered — response headers, cookies, the DOM, the scripts that
 * were parsed, the requests the page itself issued. Nothing probes. No path is
 * guessed at, no payload is sent, no request is made that the page did not make
 * on its own. That keeps the tool usable against a site without arranging
 * authorisation first, and it is the difference between an audit and a scan.
 *
 * The cost of staying passive is honest gaps: a header only present on other
 * routes will not be seen, and "not observed" is reported as exactly that
 * rather than as absence.
 */

type Severity = 'high' | 'medium' | 'low' | 'note' | 'ok'

interface Finding {
  severity: Severity
  area: string
  what: string
  detail?: string
}

interface PageEvidence {
  url: string
  origin: string
  https: boolean
  crossOriginScripts: { src: string; integrity: boolean; crossorigin: boolean }[]
  crossOriginStyles: { href: string; integrity: boolean }[]
  inlineScriptCount: number
  debugMarkers: string[]
  formsPostingInsecurely: string[]
  externalLinksWithoutRel: number
}

interface CdpCookie {
  name: string
  domain: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: string
  session: boolean
  partitionKey?: unknown
}

const SEVERITY_ORDER: Record<Severity, number> = { high: 0, medium: 1, low: 2, note: 3, ok: 4 }

export async function auditSecurity(wc: WebContents, network: NetEntry[]): Promise<string> {
  const evidence = (await wc.executeJavaScript(EVIDENCE_SCRIPT, true)) as PageEvidence

  const { cookies, sourceMaps } = await withCdp(wc, async (send: Send, on: OnEvent) => {
    const maps: string[] = []
    const off = on((method, params) => {
      if (method !== 'Debugger.scriptParsed') return
      const p = params as { url?: string; sourceMapURL?: string }
      // Inline data: URLs embed the map rather than exposing a file; only a real
      // URL means a .map is reachable on the origin.
      if (p.sourceMapURL && !p.sourceMapURL.startsWith('data:') && p.url) maps.push(p.url)
    })
    let jar: CdpCookie[] = []
    try {
      // Enabling the Debugger replays scriptParsed for everything already
      // loaded, so the maps are found without requesting anything.
      await send('Debugger.enable')
      await new Promise((r) => setTimeout(r, 350))
      await send('Debugger.disable').catch(() => undefined)
      const res = await send<{ cookies?: CdpCookie[] }>('Network.getAllCookies')
      jar = res.cookies ?? []
    } catch {
      // A page mid-navigation can tear the session down; report what was
      // gathered rather than failing the whole audit.
    }
    off()
    return { cookies: jar, sourceMaps: maps }
  })

  const doc = [...network].reverse().find((e) => e.type === 'mainFrame' && e.headers)
  const h = normalise(doc?.headers)
  const findings: Finding[] = []
  const add = (severity: Severity, area: string, what: string, detail?: string): void => {
    findings.push({ severity, area, what, detail })
  }

  /* ------------------------------------------------------------ transport */

  if (!evidence.https) {
    add('high', 'Transport', 'Page served over plain HTTP', 'Everything below is moot without TLS.')
  }

  /*
   * Every check below reads response headers, and "header absent" and "headers
   * never captured" are different claims that look identical once rendered.
   * The first version reported a missing CSP, missing HSTS and missing nosniff
   * on a site that sends all three, purely because the log had been cleared —
   * confident, specific, and entirely fabricated. Nothing header-derived is
   * claimed unless a document response was actually seen.
   */
  const sawHeaders = Boolean(doc)

  const hsts = h['strict-transport-security']
  if (evidence.https && sawHeaders) {
    if (!hsts) {
      add('medium', 'Transport', 'No Strict-Transport-Security', 'A first visit can still be downgraded.')
    } else {
      const maxAge = Number(/max-age=(\d+)/i.exec(hsts)?.[1] ?? 0)
      if (maxAge < 15768000) {
        add('low', 'Transport', `HSTS max-age is ${maxAge}s`, 'Six months (15768000) is the usual floor.')
      } else {
        add('ok', 'Transport', `HSTS present, max-age ${maxAge}s`)
      }
      if (!/includeSubDomains/i.test(hsts)) {
        add('note', 'Transport', 'HSTS without includeSubDomains')
      }
    }
  }

  /* ----------------------------------------------------------------- CSP */

  const cspHeader = sawHeaders ? h['content-security-policy'] : undefined
  const cspReportOnly = sawHeaders ? h['content-security-policy-report-only'] : undefined
  if (sawHeaders && !cspHeader) {
    add(
      'high',
      'CSP',
      cspReportOnly ? 'CSP is report-only, so it enforces nothing' : 'No Content-Security-Policy',
      'The single most effective control against injected script.'
    )
  }
  const csp = parseCsp(cspHeader || cspReportOnly || '')
  if (cspHeader) findings.push(...evaluateCsp(csp))

  const frameAncestors = csp['frame-ancestors']
  const xfo = h['x-frame-options']
  if (!sawHeaders) {
    // Nothing header-derived can be judged; say so once instead of listing
    // every header as missing.
  } else if (!frameAncestors) {
    if (xfo) {
      add(
        'low',
        'Framing',
        `Only X-Frame-Options (${xfo}) guards against framing`,
        "CSP frame-ancestors supersedes it and accepts an origin list; XFO is a legacy fallback."
      )
    } else {
      add('medium', 'Framing', 'No frame-ancestors and no X-Frame-Options', 'The page can be framed anywhere.')
    }
  } else {
    add('ok', 'Framing', `frame-ancestors ${frameAncestors.join(' ')}`)
  }

  /* ------------------------------------------------------- other headers */

  if (sawHeaders) {
    if (h['x-content-type-options']?.toLowerCase() !== 'nosniff') {
      add('low', 'Headers', 'No X-Content-Type-Options: nosniff')
    } else {
      add('ok', 'Headers', 'nosniff set')
    }

    const referrer = h['referrer-policy']
    if (!referrer) {
      add('low', 'Headers', 'No Referrer-Policy', 'Chrome defaults to strict-origin-when-cross-origin.')
    } else if (/unsafe-url|^origin$|no-referrer-when-downgrade/i.test(referrer)) {
      add('low', 'Headers', `Referrer-Policy ${referrer} leaks more than needed`)
    } else {
      add('ok', 'Headers', `Referrer-Policy ${referrer}`)
    }

    if (!h['permissions-policy']) {
      add('note', 'Headers', 'No Permissions-Policy', 'Powerful features are left at their defaults.')
    }

    const coop = h['cross-origin-opener-policy']
    const coep = h['cross-origin-embedder-policy']
    if (!coop) {
      add('low', 'Isolation', 'No Cross-Origin-Opener-Policy', 'same-origin blocks cross-window references.')
    } else {
      add('ok', 'Isolation', `COOP ${coop}${coep ? `, COEP ${coep}` : ''}`)
    }
  }

  for (const [dead, why] of [
    ['x-xss-protection', 'the auditor it controlled no longer exists in any current engine'],
    ['expect-ct', 'Certificate Transparency is enforced by default; the header is a no-op'],
    ['feature-policy', 'superseded entirely by Permissions-Policy']
  ]) {
    if (h[dead]) add('note', 'Headers', `${dead} is obsolete`, `Safe to remove — ${why}.`)
  }

  /* --------------------------------------------------------------- cookies */

  const origin = safeHost(evidence.url)
  const relevant = cookies.filter((c) => origin.endsWith(c.domain.replace(/^\./, '')))
  for (const c of relevant.slice(0, 40)) {
    const problems: string[] = []
    if (evidence.https && !c.secure) problems.push('not Secure')
    if (!c.httpOnly) problems.push('readable by script (no HttpOnly)')
    if (!c.sameSite || c.sameSite === 'None') {
      if (c.sameSite === 'None' && !c.secure) problems.push('SameSite=None without Secure, so it is rejected')
      else if (!c.sameSite) problems.push('no SameSite (Chrome treats it as Lax)')
    }
    if (c.name.startsWith('__Host-') && (!c.secure || c.path !== '/' || c.domain.startsWith('.'))) {
      problems.push('violates its own __Host- prefix rules')
    }
    if (c.name.startsWith('__Secure-') && !c.secure) problems.push('violates its own __Secure- prefix rule')
    if (problems.length) {
      add(problems.some((p) => p.includes('Secure')) ? 'medium' : 'low', 'Cookies', `${c.name}: ${problems.join('; ')}`)
    }
  }
  if (relevant.length && !findings.some((f) => f.area === 'Cookies')) {
    add('ok', 'Cookies', `${relevant.length} cookie(s), all correctly flagged`)
  }

  /* -------------------------------------------------- content and mixing */

  if (evidence.https) {
    const insecure = network.filter((e) => e.url.startsWith('http://') && !e.url.startsWith('http://localhost'))
    if (insecure.length) {
      add(
        'high',
        'Mixed content',
        `${insecure.length} subresource request(s) over plain HTTP`,
        [...new Set(insecure.map((e) => safeHost(e.url)))].slice(0, 5).join(', ')
      )
    }
    if (evidence.formsPostingInsecurely.length) {
      add('high', 'Mixed content', `${evidence.formsPostingInsecurely.length} form(s) post to http://`,
        evidence.formsPostingInsecurely.slice(0, 3).join(', '))
    }
  }

  const noSri = evidence.crossOriginScripts.filter((s) => !s.integrity)
  if (noSri.length) {
    add(
      'low',
      'Subresource integrity',
      `${noSri.length} cross-origin script(s) without integrity`,
      'SRI fits versioned, immutable assets. Analytics and tag managers that update in place cannot use it, so treat this as a prompt to check which is which: ' +
        [...new Set(noSri.map((s) => safeHost(s.src)).filter(Boolean))].slice(0, 5).join(', ')
    )
  }

  if (sourceMaps.length) {
    add(
      'medium',
      'Source maps',
      `${sourceMaps.length} script(s) reference a source map`,
      'If this is production, original sources are reachable: ' +
        [...new Set(sourceMaps.map((u) => shortPath(u)))].slice(0, 4).join(', ')
    )
  }

  if (evidence.debugMarkers.length) {
    add('medium', 'Debug output', 'Development build or debug UI is live', evidence.debugMarkers.join(', '))
  }

  const thirdParties = [...new Set(network.map((e) => safeHost(e.url)))].filter(
    (host) => host && host !== origin
  )
  if (thirdParties.length) {
    add(
      'note',
      'Third parties',
      `${thirdParties.length} distinct external origin(s) contacted`,
      thirdParties.slice(0, 8).join(', ') + (thirdParties.length > 8 ? ', …' : '')
    )
  }

  /* -------------------------------------------------------------- render */

  findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
  const out: string[] = []
  out.push(`SECURITY REVIEW OF ${evidence.url}`)
  if (!sawHeaders) {
    out.push('  NO RESPONSE HEADERS WERE CAPTURED, so nothing header-based was judged:')
    out.push('  not CSP, HSTS, framing, nosniff, referrer policy or cross-origin isolation.')
    out.push('  This is not a pass on any of them. Reload with')
    out.push('  browser_history({action:"reload"}) and run this again to include them.')
  }
  const counts = { high: 0, medium: 0, low: 0, note: 0, ok: 0 }
  for (const f of findings) counts[f.severity]++
  out.push(
    `  ${counts.high} high · ${counts.medium} medium · ${counts.low} low · ${counts.note} note · ${counts.ok} pass`
  )
  out.push('')

  let lastSeverity = ''
  for (const f of findings) {
    if (f.severity !== lastSeverity) {
      out.push(f.severity.toUpperCase())
      lastSeverity = f.severity
    }
    out.push(`  [${f.area}] ${f.what}`)
    if (f.detail) out.push(`      ${f.detail}`)
  }

  out.push('')
  out.push('Passive only: headers, cookies, certificates, console, DOM and the requests the')
  out.push('page itself made. Nothing was probed, so a control present on other routes will')
  out.push('not appear here, and a gap means "not observed" rather than "absent".')
  return out.join('\n')
}

/* ----------------------------------------------------------------- helpers */

function normalise(h: Record<string, string[]> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v.join(', ')
  return out
}

function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

function shortPath(url: string): string {
  try {
    const u = new URL(url)
    return u.pathname.split('/').pop() || u.pathname
  } catch {
    return url.slice(0, 40)
  }
}

function parseCsp(value: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const directive of value.split(';')) {
    const parts = directive.trim().split(/\s+/).filter(Boolean)
    if (!parts.length) continue
    out[parts[0].toLowerCase()] = parts.slice(1)
  }
  return out
}

/**
 * Grade a CSP the way Google's own guidance does, rather than by presence.
 *
 * A header-presence check calls a host allowlist a pass, and it is not one:
 * allowlists are routinely bypassed through JSONP endpoints and framework
 * gadgets on the very domains they permit. The recommendation that holds up is
 * a nonce or hash plus 'strict-dynamic'.
 */
function evaluateCsp(csp: Record<string, string[]>): Finding[] {
  const out: Finding[] = []
  const scriptSrc = csp['script-src'] ?? csp['default-src']
  if (!scriptSrc) {
    out.push({ severity: 'high', area: 'CSP', what: 'No script-src and no default-src to fall back to' })
    return out
  }

  const has = (token: string): boolean => scriptSrc.some((s) => s.toLowerCase() === token)
  const hasNonceOrHash = scriptSrc.some((s) => /^'(nonce-|sha\d{3}-)/i.test(s))
  const strictDynamic = has("'strict-dynamic'")

  if (has("'unsafe-inline'") && !hasNonceOrHash) {
    out.push({
      severity: 'high',
      area: 'CSP',
      what: "script-src allows 'unsafe-inline' with no nonce or hash",
      detail: 'This is the case CSP exists to prevent; the policy stops almost nothing.'
    })
  } else if (has("'unsafe-inline'") && hasNonceOrHash) {
    out.push({
      severity: 'note',
      area: 'CSP',
      what: "'unsafe-inline' present alongside a nonce",
      detail: 'Modern browsers ignore it when a nonce is present; it is a fallback for old ones.'
    })
  }

  if (has("'unsafe-eval'")) {
    out.push({ severity: 'medium', area: 'CSP', what: "script-src allows 'unsafe-eval'" })
  }

  const wildcards = scriptSrc.filter((s) => s === '*' || s === 'https:' || s === 'data:' || s.startsWith('*.'))
  if (wildcards.length && !strictDynamic) {
    out.push({
      severity: 'high',
      area: 'CSP',
      what: `script-src contains wildcard source(s): ${wildcards.join(' ')}`,
      detail: 'Any script on a permitted host can be used to bypass the policy.'
    })
  }

  const hostAllowlist = scriptSrc.filter((s) => !s.startsWith("'") && s !== '*' && !s.endsWith(':'))
  if (hostAllowlist.length && !strictDynamic) {
    out.push({
      severity: 'medium',
      area: 'CSP',
      what: `script-src is a host allowlist (${hostAllowlist.length} host(s)) without 'strict-dynamic'`,
      detail: "Allowlists are bypassable via JSONP and framework gadgets; nonce + 'strict-dynamic' is the current recommendation."
    })
  }

  if (hasNonceOrHash && strictDynamic) {
    out.push({ severity: 'ok', area: 'CSP', what: "script-src uses a nonce or hash with 'strict-dynamic'" })
  }

  if (!csp['object-src'] && !csp['default-src']) {
    out.push({ severity: 'medium', area: 'CSP', what: "No object-src 'none'", detail: 'Plugin content can still execute.' })
  }
  if (!csp['base-uri']) {
    out.push({
      severity: 'medium',
      area: 'CSP',
      what: 'No base-uri',
      detail: 'An injected <base> tag can redirect every relative script URL.'
    })
  }
  return out
}

/*
 * Runs in the page. Reads only what has already been rendered.
 */
const EVIDENCE_SCRIPT = `(() => {
  const https = location.protocol === 'https:'
  const origin = location.origin

  const crossOriginScripts = [...document.querySelectorAll('script[src]')]
    .map((s) => { try { return { url: new URL(s.src, location.href), el: s } } catch { return null } })
    .filter((x) => x && x.url.origin !== origin)
    .map((x) => ({ src: x.url.href, integrity: x.el.hasAttribute('integrity'), crossorigin: x.el.hasAttribute('crossorigin') }))

  const crossOriginStyles = [...document.querySelectorAll('link[rel="stylesheet"][href]')]
    .map((s) => { try { return { url: new URL(s.href, location.href), el: s } } catch { return null } })
    .filter((x) => x && x.url.origin !== origin)
    .map((x) => ({ href: x.url.href, integrity: x.el.hasAttribute('integrity') }))

  const debugMarkers = []
  if (document.querySelector('nextjs-portal, #__next-build-watcher')) debugMarkers.push('Next.js dev overlay')
  if (document.querySelector('vite-error-overlay') || window.__vite_plugin_react_preamble_installed__) debugMarkers.push('Vite dev client')
  if (window.$RefreshReg$ !== undefined) debugMarkers.push('React Fast Refresh (development build)')
  if (document.querySelector('#djDebug, .djdt-panel')) debugMarkers.push('Django Debug Toolbar')
  if (/Werkzeug|Traceback \\(most recent call last\\)/.test(document.body?.innerText?.slice(0, 4000) || '')) debugMarkers.push('server traceback rendered in the page')
  if (window.__REDUX_DEVTOOLS_EXTENSION__ && window.__DEV__) debugMarkers.push('__DEV__ flag is true')

  const formsPostingInsecurely = [...document.querySelectorAll('form[action]')]
    .map((f) => { try { return new URL(f.action, location.href) } catch { return null } })
    .filter((u) => u && u.protocol === 'http:' && u.hostname !== 'localhost')
    .map((u) => u.href.slice(0, 90))

  const externalLinksWithoutRel = [...document.querySelectorAll('a[target="_blank"]')]
    .filter((a) => !/noopener/.test(a.rel || '')).length

  return {
    url: location.href, origin, https,
    crossOriginScripts, crossOriginStyles,
    inlineScriptCount: document.querySelectorAll('script:not([src])').length,
    debugMarkers, formsPostingInsecurely, externalLinksWithoutRel
  }
})()`
