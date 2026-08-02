import type { WebContents } from 'electron'
import type { NetEntry } from '../browser.ts'

/**
 * What a page is built with.
 *
 * Wappalyzer, the obvious answer, went closed-source in August 2023: the
 * GPL-licensed fingerprint database moved into the commercial product and the
 * npm package was deprecated. The community forks that continue from that last
 * public snapshot are frozen at a 2023 ruleset, which is exactly the wrong
 * vintage for the question a developer actually asks — "what is this dev server
 * running" — where the answer is usually a framework that has shipped several
 * major versions since.
 *
 * So detection is done from live evidence instead of a signature database:
 * runtime globals the framework itself installs, DOM markers it emits, build
 * output paths, and response headers. These cannot go stale, because they are
 * the framework's own fingerprints rather than someone's notes about them.
 */

export interface Detection {
  name: string
  category: string
  version?: string
  evidence: string
}

interface PageDetections {
  detections: Detection[]
  url: string
  title: string
  scriptOrigins: string[]
}

export async function detectStack(wc: WebContents, network: NetEntry[]): Promise<string> {
  const page = (await wc.executeJavaScript(DETECT_SCRIPT, true)) as PageDetections
  const found = [...page.detections]

  /* -------- evidence only the network layer has -------- */

  const doc = [...network].reverse().find((e) => e.type === 'mainFrame' && e.headers)
  const headers = normaliseHeaders(doc?.headers)

  const headerHints: [string, string, string][] = [
    ['x-powered-by', 'Runtime', ''],
    ['server', 'Server', ''],
    ['x-vercel-id', 'Vercel', 'Hosting'],
    ['x-vercel-cache', 'Vercel', 'Hosting'],
    ['cf-ray', 'Cloudflare', 'CDN'],
    ['x-nf-request-id', 'Netlify', 'Hosting'],
    ['x-amz-cf-id', 'CloudFront', 'CDN'],
    ['x-served-by', 'Fastly', 'CDN'],
    ['x-github-request-id', 'GitHub Pages', 'Hosting'],
    ['x-shopify-stage', 'Shopify', 'Commerce'],
    ['x-drupal-cache', 'Drupal', 'CMS'],
    ['x-generator', 'Generator', '']
  ]

  for (const [header, name, category] of headerHints) {
    const value = headers[header]
    if (!value) continue
    if (category) {
      found.push({ name, category, evidence: `${header} header` })
    } else {
      found.push({ name: value.slice(0, 60), category: name, evidence: `${header}: ${value.slice(0, 60)}` })
    }
  }

  /* -------- de-duplicate, preferring the entry that carries a version -------- */

  const byName = new Map<string, Detection>()
  for (const d of found) {
    const key = d.name.toLowerCase()
    const prior = byName.get(key)
    if (!prior || (!prior.version && d.version)) byName.set(key, d)
  }

  const order = [
    'Framework',
    'Meta-framework',
    'UI library',
    'Build tool',
    'CSS',
    'CMS',
    'Commerce',
    'Runtime',
    'Server',
    'Hosting',
    'CDN',
    'Analytics',
    'Library',
    'Generator'
  ]
  const groups = new Map<string, Detection[]>()
  for (const d of byName.values()) {
    const list = groups.get(d.category) ?? []
    list.push(d)
    groups.set(d.category, list)
  }

  const out: string[] = [`STACK OF ${page.url}`, `  ${page.title}`, '']
  if (!byName.size) {
    out.push('  Nothing recognised. A static page with no framework runtime looks like this.')
  }
  for (const category of [...order, ...[...groups.keys()].filter((c) => !order.includes(c))]) {
    const list = groups.get(category)
    if (!list?.length) continue
    out.push(`${category.toUpperCase()}`)
    for (const d of list.sort((a, b) => a.name.localeCompare(b.name))) {
      out.push(`  ${(d.name + (d.version ? ` ${d.version}` : '')).padEnd(28)} ${d.evidence}`)
    }
    out.push('')
  }

  const thirdParty = page.scriptOrigins.filter((o) => {
    try {
      return new URL(o).origin !== new URL(page.url).origin
    } catch {
      return false
    }
  })
  if (thirdParty.length) {
    out.push(`THIRD-PARTY SCRIPT ORIGINS (${thirdParty.length})`)
    for (const o of thirdParty.slice(0, 15)) out.push(`  ${o}`)
    out.push('')
  }

  out.push('Detected from runtime globals, DOM markers, build paths and response headers,')
  out.push('not from a signature database — nothing here can be stale, but a framework that')
  out.push('leaves no runtime trace (fully static output) will not be seen.')
  return out.join('\n')
}

function normaliseHeaders(h: Record<string, string[]> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(h ?? {})) out[k.toLowerCase()] = v.join(', ')
  return out
}

/*
 * Runs in the page. Each probe is written to fail closed: an exception in one
 * detector must not cost every later detector, because the interesting pages
 * are exactly the ones with unusual globals.
 */
const DETECT_SCRIPT = `(() => {
  const out = []
  const add = (name, category, evidence, version) => out.push({ name, category, evidence, version })
  const attempt = (fn) => { try { fn() } catch {} }
  const w = window

  /* ---- component frameworks: look for the runtime's own markers ---- */

  attempt(() => {
    // React attaches fiber keys to the DOM nodes it owns; this survives
    // minification and works whether or not devtools are installed.
    const host = [...document.querySelectorAll('*')].slice(0, 400)
      .find((el) => Object.keys(el).some((k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$')))
    const hook = w.__REACT_DEVTOOLS_GLOBAL_HOOK__
    let version
    attempt(() => { for (const r of hook?.renderers?.values?.() ?? []) if (r?.version) version = r.version })
    if (host || (hook && hook.renderers?.size)) add('React', 'UI library', host ? 'fiber keys on DOM nodes' : 'devtools hook', version)
  })

  attempt(() => {
    if (w.__VUE__ || document.querySelector('[data-v-app]') || [...document.querySelectorAll('*')].slice(0, 300).some((el) => el.__vue_app__ || el.__vue__)) {
      add('Vue', 'UI library', w.__VUE__ ? '__VUE__ global' : 'component instance on DOM')
    }
  })

  attempt(() => {
    const ng = document.querySelector('[ng-version]')
    if (ng) add('Angular', 'Framework', 'ng-version attribute', ng.getAttribute('ng-version') || undefined)
  })

  attempt(() => {
    if (document.querySelector('[class*="svelte-"]') || w.__svelte) add('Svelte', 'UI library', 'scoped svelte- classes')
  })

  attempt(() => { if (w._$HY) add('Solid', 'UI library', '_$HY hydration global') })
  attempt(() => { if (document.querySelector('[q\\\\:container]')) add('Qwik', 'Framework', 'q:container attribute') })
  attempt(() => { if (w.Alpine) add('Alpine.js', 'Library', 'Alpine global', w.Alpine.version) })
  attempt(() => { if (w.htmx) add('htmx', 'Library', 'htmx global', w.htmx.version) })
  attempt(() => { if (w.jQuery) add('jQuery', 'Library', 'jQuery global', w.jQuery.fn && w.jQuery.fn.jquery) })

  /* ---- meta-frameworks: usually a data global plus a build path ---- */

  attempt(() => {
    if (w.__NEXT_DATA__ || w.next || document.querySelector('#__next, script[src*="/_next/"]')) {
      add('Next.js', 'Meta-framework', w.__NEXT_DATA__ ? '__NEXT_DATA__ payload' : '/_next/ build output', w.next?.version)
    }
  })
  attempt(() => { if (w.__NUXT__ || w.$nuxt || document.querySelector('script[src*="/_nuxt/"]')) add('Nuxt', 'Meta-framework', '__NUXT__ / _nuxt build output') })
  attempt(() => { if (w.__sveltekit_1 || Object.keys(w).some((k) => k.startsWith('__sveltekit'))) add('SvelteKit', 'Meta-framework', '__sveltekit global') })
  attempt(() => { if (w.__remixContext) add('Remix', 'Meta-framework', '__remixContext global') })
  attempt(() => { if (w.___gatsby || document.querySelector('#___gatsby')) add('Gatsby', 'Meta-framework', '___gatsby root') })
  attempt(() => { if (document.querySelector('astro-island, [astro-island]') || document.querySelector('script[src*="/_astro/"]')) add('Astro', 'Meta-framework', 'astro-island / _astro output') })
  attempt(() => { if (w.__NEXT_DATA__ === undefined && document.querySelector('script[type="application/json"][data-sveltekit-fetched]')) add('SvelteKit', 'Meta-framework', 'sveltekit fetched payload') })

  /* ---- build tooling, inferred from what it emits ---- */

  attempt(() => {
    if (document.querySelector('script[type="module"][src*="/assets/index-"], script[src*="/@vite/"]') || w.__vite_plugin_react_preamble_installed__) {
      add('Vite', 'Build tool', 'vite asset naming or dev client')
    }
  })
  attempt(() => { if (w.webpackChunk || w.__webpack_require__ || Object.keys(w).some((k) => k.startsWith('webpackChunk'))) add('webpack', 'Build tool', 'webpack runtime global') })
  attempt(() => { if (w.$RefreshReg$ !== undefined) add('React Fast Refresh', 'Build tool', '$RefreshReg$ present (dev build)') })
  attempt(() => { if (w.turbopack || Object.keys(w).some((k) => k.toLowerCase().includes('turbopack'))) add('Turbopack', 'Build tool', 'turbopack runtime global') })

  /* ---- CSS ---- */

  attempt(() => {
    const probe = getComputedStyle(document.documentElement)
    // Tailwind v3 and v4 both register --tw- custom properties at :root.
    const tw = probe.getPropertyValue('--tw-ring-offset-width') || probe.getPropertyValue('--tw-border-style')
    if (tw) add('Tailwind CSS', 'CSS', '--tw- custom properties at :root')
    else if (document.querySelector('[class*="flex "], [class]')) {
      const cls = [...document.querySelectorAll('[class]')].slice(0, 200).map((e) => e.className).join(' ')
      if (/\\b(?:text-(?:xs|sm|lg|xl)|bg-\\w+-\\d{2,3}|flex-col|items-center)\\b/.test(cls)) {
        add('Tailwind CSS', 'CSS', 'utility class naming (no custom properties found)')
      }
    }
  })
  attempt(() => { if (document.querySelector('[class*="MuiBox-"], [class*="MuiButton-"]')) add('Material UI', 'CSS', 'Mui* class names') })
  attempt(() => { if (w.bootstrap || document.querySelector('[class*="col-md-"], [class*="navbar-toggler"]')) add('Bootstrap', 'CSS', 'bootstrap grid or component classes') })
  attempt(() => { if (document.querySelector('style[data-styled], style[data-emotion]')) add(document.querySelector('style[data-styled]') ? 'styled-components' : 'Emotion', 'CSS', 'runtime style tag') })

  /* ---- platforms ---- */

  attempt(() => { if (w.Shopify) add('Shopify', 'Commerce', 'Shopify global') })
  attempt(() => { if (w.wp || document.querySelector('link[href*="/wp-content/"], script[src*="/wp-includes/"]')) add('WordPress', 'CMS', '/wp-content/ or /wp-includes/ assets') })
  attempt(() => { if (w.Squarespace) add('Squarespace', 'CMS', 'Squarespace global') })
  attempt(() => { if (w.Webflow) add('Webflow', 'CMS', 'Webflow global') })
  attempt(() => { if (w.wixPerformanceMeasurements || document.querySelector('[data-wix-\\\\w]')) add('Wix', 'CMS', 'Wix runtime markers') })

  attempt(() => {
    const gen = document.querySelector('meta[name="generator"]')
    if (gen && gen.content) add(gen.content.slice(0, 60), 'Generator', 'meta generator tag')
  })

  /* ---- analytics and product tooling ---- */

  const analytics = [
    ['gtag', 'Google Analytics'], ['dataLayer', 'Google Tag Manager'], ['ga', 'Google Analytics'],
    ['plausible', 'Plausible'], ['umami', 'Umami'], ['posthog', 'PostHog'], ['analytics', 'Segment'],
    ['mixpanel', 'Mixpanel'], ['amplitude', 'Amplitude'], ['Sentry', 'Sentry'], ['__SENTRY__', 'Sentry'],
    ['clarity', 'Microsoft Clarity'], ['fathom', 'Fathom'], ['Intercom', 'Intercom'], ['hj', 'Hotjar']
  ]
  for (const [key, name] of analytics) {
    attempt(() => { if (w[key]) add(name, 'Analytics', key + ' global') })
  }

  const scriptOrigins = [...new Set([...document.querySelectorAll('script[src]')]
    .map((s) => { try { return new URL(s.src, location.href).origin } catch { return '' } })
    .filter(Boolean))]

  return { detections: out, url: location.href, title: document.title, scriptOrigins }
})()`
