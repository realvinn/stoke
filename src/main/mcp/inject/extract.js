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
  if (window.__stoke && window.__stoke.version === 6) return

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
    /*
     * `display: contents` generates no box at all, so getBoundingClientRect is
     * 0x0 even though every child renders normally. Judging it by its rect
     * prunes the whole subtree: claude.com wraps its entire page in one
     * (`.cds-root`), and the extractor returned 0 characters for a document
     * holding 4,688. The element is a pass-through, so defer to its children.
     */
    if (style.display === 'contents') {
      /*
       * `display` computes to `contents` even inside a `display: none` ancestor,
       * so returning true unconditionally would let genuinely hidden content
       * reach find() and snapshot(), which call visible() without walking up.
       * checkVisibility consults the whole ancestor chain.
       */
      return el.checkVisibility ? el.checkVisibility() : true
    }
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

  /* ------------------------------------------------------------ shadow DOM */

  /*
   * Web components put their real content behind a shadow root, where an
   * ordinary querySelectorAll cannot reach. Piercing open roots is the
   * difference between reading a component-built page and reading an empty one.
   * Closed roots are unreachable by design and are simply invisible here.
   */
  function deepQueryAll(root, selector) {
    const out = root.querySelectorAll ? [...root.querySelectorAll(selector)] : []
    const hosts = root.querySelectorAll ? root.querySelectorAll('*') : []
    for (const host of hosts) {
      if (host.shadowRoot) out.push(...deepQueryAll(host.shadowRoot, selector))
    }
    return out
  }

  /** Every root holding text: the document plus each open shadow root. */
  function textRoots() {
    const roots = document.body ? [document.body] : []
    for (const host of document.querySelectorAll('*')) {
      if (host.shadowRoot) roots.push(host.shadowRoot)
    }
    return roots
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

    for (const el of deepQueryAll(document, INTERACTIVE)) {
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

  /*
   * Site chrome differs from content structurally rather than textually, and
   * three signals catch nearly all of it: an ARIA landmark that says "this is
   * not the article", a sectioning tag meaning the same thing, and the small
   * set of class-name conventions that are genuinely unambiguous.
   *
   * A previous version of this file declared a STRIP selector list and then
   * never referenced it anywhere. The filter that actually ran was a tag-only
   * set with no HEADER and no landmark rules, which is why documentation sites
   * leaked their navigation into every read.
   */
  const CHROME_ROLES = new Set([
    'navigation',
    'banner',
    'contentinfo',
    'complementary',
    'search',
    'menubar',
    'menu',
    'toolbar',
    'tablist'
  ])

  const CHROME_NAME =
    /(^|[\s_-])(nav|navbar|navigation|menu|sidebar|breadcrumbs?|pagination|paginator|toolbar|masthead|banner|advert|advertisement|cookie|consent|newsletter|subscribe|social|share|skip-link|screen-reader|sr-only|visually-hidden)([\s_-]|$)/i

  const HARD_SKIP = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'SVG',
    'CANVAS',
    'TEMPLATE',
    'LINK',
    'META',
    'OBJECT',
    'EMBED'
  ])

  function isChrome(el) {
    if (HARD_SKIP.has(el.tagName)) return true
    if (el.getAttribute('aria-hidden') === 'true') return true

    const role = (el.getAttribute('role') || '').toLowerCase()
    if (role && CHROME_ROLES.has(role)) return true

    const tag = el.tagName
    if (tag === 'NAV' || tag === 'FOOTER' || tag === 'ASIDE') return true
    // <header> is chrome at page level but legitimate inside an article.
    if (tag === 'HEADER' && !el.closest('article,[role="article"]')) return true
    if (tag === 'FORM' && (role === 'search' || el.querySelector('input[type="search"]'))) return true

    const cls = typeof el.className === 'string' ? el.className : ''
    return CHROME_NAME.test(cls) || CHROME_NAME.test(el.id || '')
  }

  /** True when any ancestor up to (but excluding) `stopAt` is site chrome. */
  function inChrome(el, stopAt) {
    let node = el.parentElement
    while (node && node !== stopAt) {
      if (isChrome(node)) return true
      node = node.parentElement
    }
    return false
  }

  /*
   * Controls and links need opposite treatment, which one rule cannot give.
   *
   * A button or tab is never prose: "Copy page", "Open search", "iOS" are pure
   * chrome. A link very often IS the prose — on an aggregator the headline is a
   * link and nothing else, so dropping links empties the page. Treating the two
   * alike is what first stripped Hacker News down to rank numbers and scores.
   */
  const CONTROL_ROLES = new Set([
    'button',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'option',
    'switch',
    'checkbox',
    'radio'
  ])

  function isControl(el) {
    if (el.tagName === 'BUTTON') return true
    if (el.tagName === 'A' && !el.hasAttribute('href')) return true
    return CONTROL_ROLES.has((el.getAttribute('role') || '').toLowerCase())
  }

  /** Share of an element's text that sits inside a control rather than prose. */
  function linkRatio(el) {
    const total = clean(el.textContent || '').length
    if (!total) return 1
    let linked = 0
    for (const a of el.querySelectorAll('a,button,[role="link"],[role="button"],[role="tab"]')) {
      linked += clean(a.textContent || '').length
    }
    return linked / total
  }

  /**
   * Score by text that is NOT inside links: navigation and related-link blocks
   * are link-dense, article bodies are not. Paragraph count breaks ties toward
   * prose when two candidates carry a similar number of characters.
   */
  function density(el) {
    const total = clean(el.textContent || '').length
    if (total < 200) return 0
    let linkChars = 0
    for (const a of el.querySelectorAll('a')) linkChars += clean(a.textContent || '').length
    return total - linkChars * 1.5 + el.querySelectorAll('p').length * 60
  }

  function mainContent() {
    for (const sel of ['main', '[role="main"]', 'article', '#content', '#main']) {
      const el = document.querySelector(sel)
      if (el && clean(el.textContent || '').length > 200) return el
    }
    if (!document.body) return document.documentElement
    let best = document.body
    let bestScore = 0
    for (const el of document.body.querySelectorAll('div,section,article,td')) {
      if (isChrome(el)) continue
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

  /**
   * Tables do two unrelated jobs. A data table has headers and uniform scalar
   * cells and belongs in markdown. A layout table is a grid of page regions and
   * has to be walked as ordinary content instead, or every region collapses
   * into one crammed row — which is precisely what Hacker News produced.
   */
  function isLayoutTable(table) {
    const role = (table.getAttribute('role') || '').toLowerCase()
    if (role === 'presentation' || role === 'none') return true
    if (role === 'table' || role === 'grid') return false

    // A table containing another table is scaffolding around it.
    if (table.querySelector('table')) return true

    const rows = [...table.rows]
    if (rows.length <= 1) return true
    let cols = 0
    for (const r of rows) if (r.cells.length > cols) cols = r.cells.length
    if (cols <= 1) return true

    // Headers or a caption are a deliberate statement that this is data.
    if (table.querySelector('th') || table.querySelector('caption')) return false

    // Cells holding block-level content are positioning it, not tabulating it.
    for (const cell of table.querySelectorAll('td')) {
      if (cell.querySelector('div,p,ul,ol,form,section,article,h1,h2,h3,h4,pre')) return true
    }
    return false
  }

  function tableToMarkdown(table) {
    const rows = [...table.rows].filter(visible).slice(0, 60)
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

  function toMarkdown(root) {
    const parts = []

    const walk = (node, depth) => {
      if (depth > 40) return
      for (const el of [...(node.children || [])]) {
        if (isChrome(el) || el.tagName === 'IFRAME') continue
        if (!visible(el)) continue

        const tag = el.tagName.toLowerCase()

        /*
         * Drop controls, keep links. The old leaf branch printed any childless
         * element's text, so a bare button became a paragraph and documentation
         * pages emitted "Copy page" / "iOS" / "Android" as prose. Long controls
         * are cards wrapping real content, so those are still walked. Nothing
         * is lost: every control still reaches the agent through
         * browser_snapshot, with a ref to act on.
         */
        if (isControl(el) && clean(el.textContent || '').length < 200) continue

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
          const items = [...el.children].filter((li) => li.tagName === 'LI' && visible(li))
          // Several short entries that are nothing but links: a menu, not content.
          if (items.length >= 3 && linkRatio(el) > 0.85) {
            const chars = items.reduce((n, li) => n + clean(li.textContent || '').length, 0)
            if (chars / items.length < 40) continue
          }
          const ordered = tag === 'ol'
          let i = 1
          for (const li of items) {
            const text = clean(inlineText(li))
            if (text) parts.push(`${ordered ? `${i++}.` : '-'} ${text}`)
          }
          continue
        }
        if (tag === 'table') {
          if (isLayoutTable(el)) {
            walkLayout(el, depth)
            continue
          }
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
        // A web component keeps its content behind a shadow root; the light
        // children, when there are any, are the slotted content beside it.
        if (el.shadowRoot) {
          walk(el.shadowRoot, depth + 1)
          if (el.children.length) walk(el, depth + 1)
          continue
        }
        // Leaf-ish container with text and no block children: emit it directly.
        if (!el.children.length) {
          const text = clean(inlineText(el))
          if (!text) continue
          // Keep a standalone link recognisable as one, so the agent can follow
          // it without a second round trip through browser_snapshot.
          if (tag === 'a' && el.getAttribute('href')) {
            parts.push(`[${text}](${shortUrl(el.href)})`)
          } else {
            parts.push(text)
          }
          continue
        }
        walk(el, depth + 1)
      }
    }

    /*
     * A layout table's row is one record — a story, a search result, a file in
     * a listing — spread across cells for positioning. Descending into it cell
     * by cell shreds that record into a line per fragment, which is how Hacker
     * News came out as a column of bare rank numbers and scores. Joining the
     * cells of a row back together restores the thing the row was describing.
     */
    const walkLayout = (table, depth) => {
      for (const row of [...table.rows]) {
        if (!visible(row)) continue
        // A row carrying real structure is a region, not a record: descend.
        if (row.querySelector('table,ul,ol,pre,h1,h2,h3,h4,article,section')) {
          walk(row, depth + 1)
          continue
        }
        const cells = [...row.cells]
          .filter(visible)
          .map((cell) => clean(inlineText(cell)))
          .filter(Boolean)
        if (cells.length) parts.push(cells.join(' · '))
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

  /*
   * One definition, used by both outline() and section(). They index into the
   * same list, so any divergence would make browser_read({section: n}) return
   * a different section than the outline advertised.
   */
  /*
   * The dominant body text size, measured rather than declared. A page whose
   * <body> says 16px may set every paragraph to 18px, and the comparison that
   * matters for spotting a heading is against the prose the reader is actually
   * looking at. Weighted by characters so one stray large caption cannot win.
   */
  function bodyFontSize(root) {
    const tally = new Map()
    /*
     * Only the characters an element renders *itself*, not its whole subtree.
     * Counting subtree text charges every wrapper for the prose beneath it, so
     * ten nesting levels at 16px outweigh the 18px paragraphs they contain and
     * the answer drifts to the outermost container's size - the opposite of
     * what this is for.
     */
    for (const el of deepQueryAll(root, 'p,li,td,dd,blockquote,span,div')) {
      let own = 0
      for (const node of el.childNodes) {
        if (node.nodeType === 3) own += clean(node.nodeValue || '').length
      }
      if (own < 20 || !visible(el)) continue
      const px = Math.round(parseFloat(getComputedStyle(el).fontSize))
      if (!px) continue
      tally.set(px, (tally.get(px) || 0) + own)
    }
    let best = 16
    let bestChars = 0
    for (const [px, chars] of tally) {
      if (chars > bestChars) {
        bestChars = chars
        best = px
      }
    }
    return best
  }

  /*
   * Marketing pages routinely ship no headings at all. mistral.ai renders every
   * section title as a plain <div> with a large font, so an outline built from
   * h1-h6 reported "no headings found" on a page carrying sixty of them.
   *
   * A heading is a visual fact before it is a semantic one, so when the markup
   * is silent, infer it the way a reader does: short standalone text set larger
   * than the surrounding prose, or the same size and markedly heavier. Distinct
   * sizes then rank onto levels, largest first.
   */
  function visualHeadings(root) {
    const base = bodyFontSize(root)
    const found = []

    for (const el of deepQueryAll(root, 'div,span,p,dt,figcaption,summary')) {
      if (isChrome(el) || inChrome(el, root) || isControl(el)) continue
      // A real heading's own <span> is not a second heading.
      if (el.closest('h1,h2,h3,h4,h5,h6,[role="heading"]')) continue
      // Emphasis inside prose is not a heading, however bold.
      if (el.parentElement && el.parentElement.closest('p,blockquote,dd')) continue

      const text = clean(inlineText(el))
      if (!text || text.length > 120) continue

      /*
       * An inline box surrounded by more text is a phrase within a run of
       * prose, not a title above one. Excluding list items and table cells
       * outright was too blunt - a store's product grid keeps its names in
       * <li>, and scorptec.com.au lost its entire outline to that rule.
       */
      const disp = getComputedStyle(el).display
      if (disp === 'inline' || disp === 'inline-block') {
        const around = clean(el.parentElement ? el.parentElement.textContent || '' : '')
        if (around.length > text.length * 1.3) continue
      }
      // Leaf-ish: nothing beneath it carries text of its own, so we name the
      // element that actually paints the words rather than a wrapper.
      if ([...el.children].some((c) => clean(c.textContent || '').length)) continue
      if (!visible(el)) continue

      const style = getComputedStyle(el)
      const px = Math.round(parseFloat(style.fontSize)) || base
      const weight = parseInt(style.fontWeight, 10) || 400
      if (px < base * 1.15 && !(px >= base && weight >= 700)) continue

      found.push({ el, px, text })
    }

    const sizes = [...new Set(found.map((f) => f.px))].sort((a, b) => b - a)
    return found.map((f) => ({
      el: f.el,
      rank: sizes.indexOf(f.px) + 1,
      text: f.text
    }))
  }

  /*
   * Below this many real headings a page is treated as unmarked-up and the
   * visual pass takes over. Pages that do mark their headings keep their own
   * structure untouched - inferring alongside good markup only adds noise.
   */
  const HEADING_FLOOR = 4

  function headings(root) {
    const real = deepQueryAll(root, 'h1,h2,h3,h4,h5,h6,[role="heading"]')
      .filter((h) => visible(h) && !inChrome(h, root))
      .map((h) => ({
        el: h,
        level: Number(h.tagName[1]) || Number(h.getAttribute('aria-level')) || 2,
        text: clean(h.textContent).slice(0, 120)
      }))

    if (real.length >= HEADING_FLOOR) return real

    /*
     * The two level scales mean different things - an h-tag number is semantic,
     * an inferred rank is "how big relative to the other sizes on this page".
     * Comparing them directly lets a large pull-quote outrank a real <h2> and
     * truncate its section, so inferred headings are pushed below every real
     * one instead of competing with them.
     */
    const floor = real.length ? Math.max(...real.map((h) => h.level)) : 0
    const seen = new Set(real.map((h) => h.el))
    const inferred = visualHeadings(root)
      .filter((h) => !seen.has(h.el))
      .map((h) => ({ el: h.el, text: h.text, level: Math.min(6, floor + h.rank) }))
    const merged = [...real, ...inferred]
    merged.sort((a, b) => {
      if (a.el === b.el) return 0
      const rel = a.el.compareDocumentPosition(b.el)
      if (rel & Node.DOCUMENT_POSITION_FOLLOWING) return -1
      if (rel & Node.DOCUMENT_POSITION_PRECEDING) return 1
      return 0
    })
    return merged
  }

  function outline() {
    const root = mainContent()
    return headings(root).map((h, i) => ({
      index: i,
      level: h.level,
      text: h.text.slice(0, 120)
    }))
  }

  /** Everything from heading `index` until the next heading of same-or-higher level. */
  function section(index) {
    const root = mainContent()
    const heads = headings(root)
    const head = heads[index]
    if (!head) return null

    const start = head.el
    const level = head.level

    /*
     * Collect the LIVE elements of the section, never clones.
     *
     * This used to copy each node into a detached <div> and render that. Every
     * clone has `isConnected === false`, `visible()` rejects on exactly that,
     * and so toMarkdown filtered out the entire section: `read({section})`
     * returned an empty body on every page, real <h2> headings included. It went
     * unnoticed because nothing asserted on it.
     *
     * toMarkdown only ever reads `node.children`, so a plain object holding the
     * live elements is a valid root and keeps them attached to the document.
     */
    const stops = new Map(heads.map((h) => [h.el, h.level]))
    const range = [start]
    // Descendants follow their ancestor contiguously in document order, so one
    // guard is enough to avoid emitting a subtree twice.
    let guard = start

    let node = start
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT)
    walker.currentNode = start
    while ((node = walker.nextNode())) {
      const stopLevel = stops.get(node)
      if (stopLevel !== undefined && stopLevel <= level) break
      if (guard.contains(node)) continue
      range.push(node)
      guard = node
    }

    return { heading: head.text, markdown: toMarkdown({ children: range }) }
  }

  /* ------------------------------------------------------------------ find */

  function find(query, limit) {
    const q = String(query).toLowerCase()
    const max = limit || 12
    const hits = []
    for (const root of textRoots()) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
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
      // Sections are bounded by the next peer heading, but the last heading on
      // a page runs to the end of it, so the cap still has to apply here.
      const cap = o.maxChars || 20000
      return {
        url: location.href,
        title: document.title,
        heading: s.heading,
        markdown: s.markdown.slice(0, cap),
        truncated: s.markdown.length > cap,
        totalChars: s.markdown.length
      }
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
    version: 6,
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
