/**
 * One editor group of Work mode: a tab strip, breadcrumbs and the code. It
 * owns no document state: the root's reducer (shared/workModeDoc.ts) does,
 * and this draws the active tab's document and reports the pointer.
 *
 * Soft wrap, never a sideways scroll (prove Finding 1): a line wider than the
 * editor goes on over more visual rows with no line number, indented like the
 * line (`wrapLayout`). The caret, the current-line band, the pointer's aim and
 * hole filling all count visual rows; the code area cannot scroll sideways
 * (`overflow-x: hidden`, `scrollLeft` kept at 0).
 *
 * File text is untrusted, so tokens are rendered as React text only, never as
 * raw HTML anywhere in Work mode (verify:work-mode holds it).
 * Only the lines in view (±10) are rendered.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { tokenizeLine, type Grammar, type LexState } from '@shared/workModeHighlight'
import { lineOfVisual, splitTokens, wrapColumns, wrapLayout, type DocState, type LineWrap, type PreparedFile, type View, type WrapLayout } from '@shared/workModeDoc'
import { IconChevron, IconClose } from './Icons'

export interface EditorTab {
  key: string
  name: string
  /** The folder, shown when two tabs share a name. */
  dir: string | null
  ext: string
  dirty: boolean
}

interface Props {
  group: 0 | 1
  focused: boolean
  tabs: EditorTab[]
  activeTab: number
  file: PreparedFile | null
  doc: DocState | null
  /** Moves each time this group's caret is aimed, so the caret glides slower for an aim than for a key. */
  aimTick: number
  reducedMotion: boolean
  onTab: (index: number) => void
  onClose: (index: number) => void
  /** `row` and `view` are VISUAL rows; `tops` maps them to lines (`WrapLayout.tops`). */
  onPointer: (group: 0 | 1, row: number, view: View, tops: Int32Array | null, x: number, y: number, at: number) => void
  onPress: (group: 0 | 1, row: number, view: View, tops: Int32Array | null) => void
  onEnter: (group: 0 | 1) => void
}

const OVERSCAN = 10

/**
 * A press on a tab must not take focus. Every key in Work mode types, and a
 * key typed while a clicked button holds focus makes Chromium match
 * `:focus-visible` on it, so the ring meant for keyboard focus drew round the
 * tab (prove Finding 5). Focus stays on the overlay; a ring shows only for
 * focus the keyboard really moved.
 */
const keepFocus = (e: React.MouseEvent): void => e.preventDefault()

interface LineProps {
  top: number
  number: number
  text: string
  state: LexState
  grammar: Grammar
  lang?: string
  current: boolean
  mark: boolean
  guides: number
  guideStep: number
  /** Where each visual row starts in `text` (`wrapStarts`). */
  starts: readonly number[]
  /** Columns a continuation row is indented by (`wrapIndent`). */
  contIndent: number
}

/** One line of code: its first visual row carries the number, continuation rows none, all of them the current-line band. */
const CodeLine = memo(function CodeLine({ top, number, text, state, grammar, lang, current, mark, guides, guideStep, starts, contIndent }: LineProps): React.JSX.Element {
  const rows = useMemo(() => splitTokens(tokenizeLine(grammar, text, state, lang).tokens, starts), [grammar, text, state, lang, starts])
  const contGuides = contIndent > 0 ? Math.min(guides, Math.floor(contIndent / guideStep)) : 0
  return (
    <div className="wm-line" style={{ top }} data-current={current || undefined}>
      {rows.map((parts, k) => (
        <div key={k} className="wm-row" data-wrapped={k > 0 || undefined}>
          <span className="wm-gutter">{k === 0 ? number : ''}</span>
          <span className="wm-text" style={k > 0 && contIndent > 0 ? { paddingLeft: `${contIndent}ch` } : undefined}>
            {Array.from({ length: k === 0 ? guides : contGuides }, (_, g) => (
              <span key={`g${g}`} className="wm-guide" style={{ left: `${g * guideStep}ch` }} aria-hidden="true" />
            ))}
            {parts.map((t, i) => (t.kind === 'text' ? t.text : <span key={i} className={`wm-t-${t.kind}`}>{t.text}</span>))}
            {mark && k === rows.length - 1 && <span className="wm-mark" data-caret-mark="" />}
          </span>
        </div>
      ))}
    </div>
  )
})

/** Words that read like a call followed by a block but open no symbol: `if (x) {`. */
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'else', 'do', 'return', 'foreach', 'elif', 'unless', 'until'])

/** The function or class the caret is in (or, in Markdown, the heading it is under), looking up the typed lines. */
function enclosingSymbol(file: PreparedFile, doc: DocState): string | null {
  if (file.grammar === 'markdown') {
    for (let i = doc.caret, seen = 0; i >= 0 && seen < 400; i--, seen++) {
      if (doc.typed[i] < 0 || doc.typed[i] < file.lines[i].length) continue
      const m = /^ {0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/.exec(file.lines[i])
      if (m) return m[1].slice(0, 48)
    }
    return null
  }
  const caretIndent = file.indent[doc.caret] ?? 0
  const def = /(?:function\*?|class|def|fn|func|interface|struct|impl|module)\s+([A-Za-z_$][\w$]*)|^\s*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(|^\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/
  for (let i = doc.caret - 1, seen = 0; i >= 0 && seen < 400; i--, seen++) {
    if (doc.typed[i] < 0 || doc.typed[i] < file.lines[i].length) continue
    if (file.indent[i] >= caretIndent && i !== doc.caret) continue
    const m = def.exec(file.lines[i])
    const name = m ? (m[1] ?? m[2] ?? m[3] ?? null) : null
    if (name && !CONTROL_WORDS.has(name)) return name
  }
  return null
}

export function WorkModeEditor({ group, focused, tabs, activeTab, file, doc, aimTick, reducedMotion, onTab, onClose, onPointer, onPress, onEnter }: Props): React.JSX.Element {
  const codeRef = useRef<HTMLDivElement>(null)
  const linesRef = useRef<HTMLDivElement>(null)
  const caretRef = useRef<HTMLDivElement>(null)
  const probeRef = useRef<HTMLDivElement>(null)
  const measureRef = useRef<HTMLSpanElement>(null)
  // The real line height and character width, measured from a probe (font and size come from the terminal settings).
  const [metrics, setMetrics] = useState({ line: 20, ch: 7.8 })
  const [scroll, setScroll] = useState({ top: 0, height: 600, width: 600 })
  const lastAim = useRef(aimTick)
  const stillTimer = useRef<number | undefined>(undefined)
  const wrapCache = useRef<{ file: PreparedFile | null; map: Map<number, LineWrap> }>({ file: null, map: new Map() })
  const lineHeight = metrics.line

  const gutterCh = String(file?.lines.length ?? 1).length + 3
  const cols = wrapColumns(scroll.width, metrics.ch, gutterCh)
  const layout: WrapLayout | null = useMemo(() => {
    if (!file || !doc) return null
    if (wrapCache.current.file !== file) wrapCache.current = { file, map: new Map() }
    return wrapLayout(file, doc, cols, wrapCache.current.map)
  }, [file, doc?.typed, cols])
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const refs = layout?.refs ?? []
  const caretRowIndex = useMemo(() => (doc && layout ? layout.refs.indexOf(doc.caret) : -1), [layout, doc?.caret])
  const symbol = useMemo(() => (file && doc ? enclosingSymbol(file, doc) : null), [file, doc?.caret, doc?.typed])

  useLayoutEffect(() => {
    const probe = probeRef.current
    const measure = measureRef.current
    if (!probe || !measure) return
    const read = (): void => {
      const line = probe.getBoundingClientRect().height
      const ch = measure.getBoundingClientRect().width / 10
      setMetrics((cur) => (line > 4 && ch > 1 && (cur.line !== line || cur.ch !== ch) ? { line, ch } : cur))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(probe)
    ro.observe(measure)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const el = codeRef.current
    if (!el) return
    let frame = 0
    const read = (): void => {
      frame = 0
      // Nothing scrolls the code sideways; a stray programmatic scroll is put back (no line is ever cut on its left).
      if (el.scrollLeft !== 0) el.scrollLeft = 0
      setScroll((cur) => (cur.top === el.scrollTop && cur.height === el.clientHeight && cur.width === el.clientWidth ? cur : { top: el.scrollTop, height: el.clientHeight, width: el.clientWidth }))
    }
    const onScroll = (): void => {
      if (!frame) frame = requestAnimationFrame(read)
    }
    read()
    el.addEventListener('scroll', onScroll, { passive: true })
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', onScroll)
      ro.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [])

  // Place the caret on its marker (the end of its line's last visual row), then keep that row three rows inside the view, vertically only.
  useLayoutEffect(() => {
    const caret = caretRef.current
    const lines = linesRef.current
    const code = codeRef.current
    if (!caret || !lines || !code || !doc || !layout || caretRowIndex < 0) return
    const mark = lines.querySelector('[data-caret-mark]')
    const x = mark ? mark.getBoundingClientRect().left - lines.getBoundingClientRect().left : 0
    const visualRow = layout.tops[caretRowIndex] + layout.wraps[caretRowIndex].starts.length - 1
    const y = visualRow * lineHeight
    const aimed = lastAim.current !== aimTick
    lastAim.current = aimTick
    caret.toggleAttribute('data-aim', aimed)
    caret.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`
    caret.setAttribute('data-still', '')
    window.clearTimeout(stillTimer.current)
    stillTimer.current = window.setTimeout(() => caret.removeAttribute('data-still'), 500)

    const margin = 3 * lineHeight
    let top = code.scrollTop
    if (y < code.scrollTop + margin) top = Math.max(0, y - margin)
    else if (y + lineHeight > code.scrollTop + code.clientHeight - margin) top = y + lineHeight - code.clientHeight + margin
    if (code.scrollLeft !== 0) code.scrollLeft = 0
    if (top !== code.scrollTop) {
      // Reduced motion is checked in code: CSS cannot reach scrollTo (gotcha 105's note).
      if (aimed && !reducedMotion) code.scrollTo({ top, behavior: 'smooth' })
      else {
        code.scrollTop = top
        // Draw the rows for the new place now, not a frame later: a tab switched to must never show empty rows.
        setScroll((cur) => (cur.top === code.scrollTop ? cur : { ...cur, top: code.scrollTop }))
      }
    }
    // Only when the document or the caret moved: a wheel scroll away from the caret is the person's, and stays.
  }, [doc, file, layout, caretRowIndex, lineHeight, aimTick, reducedMotion])

  useEffect(() => () => window.clearTimeout(stillTimer.current), [])

  const viewOf = (el: HTMLElement): View => ({
    first: Math.floor(el.scrollTop / lineHeight),
    last: Math.max(0, Math.floor((el.scrollTop + el.clientHeight) / lineHeight) - 1)
  })
  const rowAt = (el: HTMLElement, clientY: number): number => Math.max(0, Math.floor((clientY - el.getBoundingClientRect().top + el.scrollTop) / lineHeight))

  const tops = layout?.tops ?? new Int32Array(1)
  const total = tops[refs.length] ?? 0
  const first = Math.max(0, lineOfVisual(tops, Math.floor(scroll.top / lineHeight)) - OVERSCAN)
  const last = Math.min(refs.length - 1, lineOfVisual(tops, Math.ceil((scroll.top + scroll.height) / lineHeight)) + OVERSCAN)
  const shown: number[] = []
  for (let r = first; r <= last; r++) shown.push(r)
  if (caretRowIndex >= 0 && (caretRowIndex < first || caretRowIndex > last)) shown.push(caretRowIndex)
  const step = file?.indentInfo.size ?? 4
  const crumbs = file ? file.path.split('/') : []

  return (
    <section className="wm-group" data-focused={focused || undefined} aria-label={file ? `Editor: ${file.path}` : 'Editor'}>
      <div className="wm-tabs" role="tablist">
        {tabs.map((t, i) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            className="wm-tab"
            data-active={i === activeTab || undefined}
            aria-selected={i === activeTab}
            onMouseDown={keepFocus}
            onClick={() => onTab(i)}
            tabIndex={-1}
          >
            <span className="wm-glyph" data-ext={t.ext} aria-hidden="true" />
            <span className="wm-tab-name">{t.name}</span>
            {t.dir && <span className="wm-tab-dir">{t.dir}</span>}
            <span
              className="wm-tab-close"
              role="button"
              aria-label={`Close ${t.name}`}
              onClick={(e) => {
                e.stopPropagation()
                onClose(i)
              }}
            >
              {t.dirty ? <span className="wm-tab-dot" aria-hidden="true" /> : <IconClose />}
            </span>
          </button>
        ))}
      </div>
      <div className="wm-crumbs">
        {crumbs.map((c, i) => (
          <span key={i} className="wm-status-item">
            {i > 0 && <IconChevron className="wm-crumb-sep" />}
            {c}
          </span>
        ))}
        {symbol && (
          <span className="wm-status-item">
            <IconChevron className="wm-crumb-sep" />
            <span className="wm-crumb-symbol">{symbol}</span>
          </span>
        )}
      </div>
      <div
        ref={codeRef}
        className="wm-code"
        style={{ ['--wm-gutter' as string]: `${gutterCh}ch` } as React.CSSProperties}
        onPointerEnter={() => onEnter(group)}
        onPointerMove={(e) => {
          const el = e.currentTarget
          onPointer(group, rowAt(el, e.clientY), viewOf(el), layoutRef.current?.tops ?? null, e.clientX, e.clientY, e.timeStamp)
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          const el = e.currentTarget
          onPress(group, rowAt(el, e.clientY), viewOf(el), layoutRef.current?.tops ?? null)
        }}
      >
        <div className="wm-probe" ref={probeRef} aria-hidden="true">
          <span ref={measureRef}>0000000000</span>
        </div>
        {file && doc && layout ? (
          <div className="wm-lines" ref={linesRef} style={{ height: (total + 6) * lineHeight }}>
            {shown.map((r) => {
              const ref = refs[r]
              const typed = doc.typed[ref]
              const indent = Math.min(file.indent[ref], typed)
              const wrap = layout.wraps[r]
              return (
                <CodeLine
                  key={ref}
                  top={tops[r] * lineHeight}
                  number={r + 1}
                  text={file.lines[ref].slice(0, typed)}
                  state={file.states[ref]}
                  grammar={file.grammar}
                  lang={file.lang}
                  current={ref === doc.caret}
                  mark={ref === doc.caret}
                  guides={file.lines[ref].trim() ? Math.floor(indent / step) : 0}
                  guideStep={step}
                  starts={wrap.starts}
                  contIndent={wrap.indent}
                />
              )
            })}
            <div ref={caretRef} className="wm-caret" aria-hidden="true" />
          </div>
        ) : (
          <div className="wm-empty">Opening…</div>
        )}
      </div>
    </section>
  )
}
