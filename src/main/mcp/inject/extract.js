/*
 * Runs inside the browsed page. Deliberately dependency-free and self-contained
 * so it can be injected as a single string with no bundling step.
 *
 * The goal throughout is a representation an agent can act on cheaply:
 *  - prose as markdown with structure intact, not raw HTML and not flat text
 *  - interactive elements as a short ref list, so clicks never need a selector
 *  - everything filtered to what is actually visible on the page
 *
 * Installed once per document as window.__stoke; the main process re-injects
 * automatically after a navigation clears it.
 */
;(() => {
  if (window.__stoke && window.__stoke.version === 1) return

  /** ref -> element, rebuilt by snapshot(). Cleared implicitly on navigation. */
  const refs = new Map()
  let refSeq = 0

  /* ----------------------------------------------------------- visibility */

  function visible(el) {
    if (!el || !el.isConnected) return false
    if (el.closest('[aria-hidden="true"]')) return false
    const style = getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    if (Number(style.opacity) === 0) return false
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    // Parked far offscreen (a common way to hide things without display:none).
    if (r.bottom < -2000 || r.right < -2000) return false
    return true
  }

  /* ------------------------------------------------- accessible name/role */

  function labelFor(el) {
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`)
      if (lab) return lab.textContent
    }
    const wrap = el.closest('label')
    return wrap ? wrap.textContent : ''
  }

  function accName(el) {
    const byLabelledBy = el.getAttribute('aria-labelledby')
    if (byLabelledBy) {
      const text = byLabelledBy
        .split(/\s+/)
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((n) => n.textContent || '')
        .join(' ')
      if (text.trim()) return clean(text)
    }
    const candidates = [
      el.getAttribute('aria-label'),
      labelFor(el),
      el.getAttribute('alt'),
      el.getAttribute('title'),
      el.getAttribute('placeholder'),
      el.tagName === 'INPUT' && el.type === 'submit' ? el.value : '',
      el.textContent
    ]
    for (const c of candidates) {
      const t = clean(c || '')
      if (t) return t.length > 120 ? `${t.slice(0, 117)}…` : t
    }
    return ''
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    const tag = el.tagName.toLowerCase()
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'summary') return 'disclosure'
    if (tag === 'input') {
      const t = (el.type || 'text').toLowerCase()
      if (t === 'checkbox') return 'checkbox'
      if (t === 'radio') return 'radio'
      if (t === 'submit' || t === 'button' || t === 'reset') return 'button'
      if (t === 'range') return 'slider'
      return 'textbox'
    }
    if (el.isContentEditable) return 'textbox'
    return 'generic'
  }

  function clean(s) {
    return String(s).replace(/\s+/g, ' ').trim()
  }

  /* -------------------------------------------------------------- snapshot */

  const INTERACTIVE = [
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    'summary',
    '[contenteditable=""]',
    '[contenteditable="true"]',
    '[role="button"]',
    '[role="link"]',
    '[role="tab"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="combobox"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',')

  function snapshot(opts) {
    const limit = (opts && opts.limit) || 200
    refs.clear()
    refSeq = 0

    const out = []
    const seen = new Set()

    for (const el of document.querySelectorAll(INTERACTIVE)) {
      if (seen.has(el) || !visible(el)) continue
      seen.add(el)

      const ref = `e${++refSeq}`
      refs.set(ref, el)

      const item = { ref, role: roleOf(el), name: accName(el) }

      if (el.tagName === 'A' && el.href) item.href = shortUrl(el.href)
      if (el.disabled) item.disabled = true
      if (el.checked) item.checked = true
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        if (el.value) item.value = el.value.length > 60 ? `${el.value.slice(0, 57)}…` : el.value
      }
      if (el.tagName === 'SELECT') {
        item.options = [...el.options].slice(0, 25).map((o) => o.value || o.text)
        item.value = el.value
      }
      // Position helps the model reason about "the button at the top".
      const r = el.getBoundingClientRect()
      item.y = Math.round(r.top + window.scrollY)

      out.push(item)
      if (out.length >= limit) break
    }

    return { url: location.href, title: document.title, elements: out }
  }

  function shortUrl(href) {
    try {
      const u = new URL(href, location.href)
      if (u.origin === location.origin) return u.pathname + u.search + u.hash
      return u.href.length > 100 ? `${u.href.slice(0, 97)}…` : u.href
    } catch {
      return href
    }
  }

  function resolve(ref) {
    const el = refs.get(ref)
    if (!el || !el.isConnected) return null
    return el
  }

  /* ------------------------------------------------- main content picking */

  const STRIP =
    'script,style,noscript,svg,canvas,iframe,template,nav,header,footer,aside,form[role="search"],' +
    '[role="navigation"],[role="banner"],[role="contentinfo"],[role="complementary"],' +
    '[aria-hidden="true"],.advertisement,.ad,.cookie,.newsletter'

  /**
   * Score by text that is NOT inside links: navigation and related-link blocks
   * are link-dense, article bodies are not. Cheap and works on most sites.
   */
  function density(el) {
    const total = (el.textContent || '').trim().length
    if (total < 200) return 0
    let linkChars = 0
    for (const a of el.querySelectorAll('a')) linkChars += (a.textContent || '').length
    return total - linkChars * 1.5
  }

  function mainContent() {
    for (const sel of ['main', '[role="main"]', 'article', '#content', '#main']) {
      const el = document.querySelector(sel)
      if (el && (el.textContent || '').trim().length > 200) return el
    }
    let best = document.body
    let bestScore = 0
    const candidates = document.body ? document.body.querySelectorAll('div,section,article,td') : []
    for (const el of candidates) {
      const score = density(el)
      if (score > bestScore) {
        bestScore = score
        best = el
      }
    }
    return best
  }

  /* ------------------------------------------------------ HTML -> markdown */

  function inlineText(node) {
    let out = ''
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue
      } else if (child.nodeType === 1) {
        if (!visible(child) && child.tagName !== 'BR') continue
        const tag = child.tagName.toLowerCase()
        if (tag === 'br') out += '\n'
        else if (tag === 'code') out += '`' + clean(child.textContent) + '`'
        else if (tag === 'strong' || tag === 'b') out += `**${inlineText(child).trim()}**`
        else if (tag === 'em' || tag === 'i') out += `*${inlineText(child).trim()}*`
        else if (tag === 'a' && child.getAttribute('href')) {
          const label = inlineText(child).trim()
          if (label) out += `[${label}](${shortUrl(child.href)})`
        } else if (tag === 'img') {
          const alt = child.getAttribute('alt')
          if (alt) out += `![${clean(alt)}]`
        } else {
          out += inlineText(child)
        }
      }
    }
    return out
  }

  function tableToMarkdown(table) {
    const rows = [...table.querySelectorAll('tr')].filter(visible)
    if (!rows.length) return ''
    const cells = rows.map((tr) =>
      [...tr.children].map((td) => clean(inlineText(td)).replace(/\|/g, '\\|') || ' ')
    )
    const width = Math.max(...cells.map((r) => r.length))
    const pad = (r) => {
      const copy = r.slice()
      while (copy.length < width) copy.push(' ')
      return copy
    }
    const head = pad(cells[0])
    const body = cells.slice(1).map(pad)
    const lines = [
      `| ${head.join(' | ')} |`,
      `| ${head.map(() => '---').join(' | ')} |`,
      ...body.map((r) => `| ${r.join(' | ')} |`)
    ]
    return lines.join('\n')
  }

  const BLOCK_SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'SVG',
    'CANVAS',
    'IFRAME',
    'TEMPLATE',
    'NAV',
    'FOOTER',
    'ASIDE'
  ])

  function toMarkdown(root) {
    const parts = []

    const walk = (node, depth) => {
      if (depth > 40) return
      for (const el of node.children) {
        if (BLOCK_SKIP.has(el.tagName)) continue
        if (!visible(el)) continue

        const tag = el.tagName.toLowerCase()

        if (/^h[1-6]$/.test(tag)) {
          const text = clean(inlineText(el))
          if (text) parts.push(`${'#'.repeat(Number(tag[1]))} ${text}`)
          continue
        }
        if (tag === 'p') {
          const text = inlineText(el).trim()
          if (text) parts.push(text)
          continue
        }
        if (tag === 'pre') {
          const code = el.textContent.replace(/\n+$/, '')
          if (code.trim()) {
            const lang = (el.querySelector('code')?.className || '').match(/language-(\w+)/)
            parts.push('```' + (lang ? lang[1] : '') + '\n' + code + '\n```')
          }
          continue
        }
        if (tag === 'ul' || tag === 'ol') {
          const ordered = tag === 'ol'
          let i = 1
          for (const li of el.children) {
            if (li.tagName !== 'LI' || !visible(li)) continue
            const text = clean(inlineText(li))
            if (text) parts.push(`${ordered ? `${i++}.` : '-'} ${text}`)
          }
          continue
        }
        if (tag === 'table') {
          const md = tableToMarkdown(el)
          if (md) parts.push(md)
          continue
        }
        if (tag === 'blockquote') {
          const text = clean(inlineText(el))
          if (text) parts.push(`> ${text}`)
          continue
        }
        if (tag === 'hr') {
          parts.push('---')
          continue
        }
        // Leaf-ish container with text and no block children: emit it directly.
        if (!el.children.length) {
          const text = clean(inlineText(el))
          if (text) parts.push(text)
          continue
        }
        walk(el, depth + 1)
      }
    }

    walk(root, 0)

    // Collapse repeated blank output and duplicate consecutive lines.
    const seen = []
    for (const p of parts) {
      if (!p.trim()) continue
      if (seen.length && seen[seen.length - 1] === p) continue
      seen.push(p)
    }
    return seen.join('\n\n')
  }

  /* --------------------------------------------------------------- outline */

  function outline() {
    const root = mainContent()
    const heads = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible)
    return heads.map((h, i) => ({
      index: i,
      level: Number(h.tagName[1]),
      text: clean(h.textContent).slice(0, 120)
    }))
  }

  /** Everything from heading `index` until the next heading of same-or-higher level. */
  function section(index) {
    const root = mainContent()
    const heads = [...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].filter(visible)
    const start = heads[index]
    if (!start) return null

    const level = Number(start.tagName[1])
    const holder = document.createElement('div')
    holder.appendChild(start.cloneNode(true))

    let node = start
    // Walk forward in document order, stopping at the next peer heading.
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    walker.currentNode = start
    while ((node = walker.nextNode())) {
      if (/^H[1-6]$/.test(node.tagName) && Number(node.tagName[1]) <= level) break
      if (node.parentElement && holder.contains(node.parentElement)) continue
      holder.appendChild(node.cloneNode(true))
    }
    return { heading: clean(start.textContent), markdown: toMarkdown(holder) }
  }

  /* ------------------------------------------------------------------ find */

  function find(query, limit) {
    const q = String(query).toLowerCase()
    const max = limit || 12
    const hits = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const text = node.nodeValue
      if (!text || text.length < 2) continue
      const idx = text.toLowerCase().indexOf(q)
      if (idx === -1) continue
      const parent = node.parentElement
      if (!parent || !visible(parent)) continue

      const from = Math.max(0, idx - 90)
      const to = Math.min(text.length, idx + q.length + 90)
      const nearest = parent.closest(INTERACTIVE)
      let ref = null
      if (nearest) {
        for (const [k, v] of refs) if (v === nearest) ref = k
      }
      hits.push({
        text: clean(text.slice(from, to)),
        heading: nearestHeading(parent),
        ref
      })
      if (hits.length >= max) break
    }
    return hits
  }

  function nearestHeading(el) {
    let node = el
    while (node) {
      let sib = node.previousElementSibling
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName)) return clean(sib.textContent).slice(0, 80)
        sib = sib.previousElementSibling
      }
      node = node.parentElement
    }
    return null
  }

  /* ----------------------------------------------------------------- reads */

  function read(opts) {
    const o = opts || {}
    let root

    if (o.ref) {
      const el = resolve(o.ref)
      if (!el) return { error: `ref ${o.ref} is stale — take a new snapshot` }
      root = el
    } else if (typeof o.section === 'number') {
      const s = section(o.section)
      if (!s) return { error: `no section at index ${o.section}` }
      return { url: location.href, title: document.title, heading: s.heading, markdown: s.markdown }
    } else if (o.full) {
      root = document.body
    } else {
      root = mainContent()
    }

    let markdown = toMarkdown(root)
    const totalChars = markdown.length
    let truncated = false
    const maxChars = o.maxChars || 20000
    if (markdown.length > maxChars) {
      markdown = markdown.slice(0, maxChars)
      truncated = true
    }

    return {
      url: location.href,
      title: document.title,
      markdown,
      truncated,
      totalChars,
      outline: outline()
    }
  }

  /* --------------------------------------------------------------- actions */

  function centreOf(el) {
    el.scrollIntoView({ block: 'center', inline: 'center' })
    const r = el.getBoundingClientRect()
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  }

  function describe(el) {
    return `${roleOf(el)} "${accName(el)}"`
  }

  window.__stoke = {
    version: 1,
    snapshot,
    read,
    outline,
    section,
    find,
    resolve,
    centreOf,
    describe,
    visible,
    // Cheap signature used by the main process to detect what changed.
    signature: () => {
      const md = toMarkdown(mainContent())
      return { url: location.href, title: document.title, lines: md.split('\n') }
    }
  }
})()
