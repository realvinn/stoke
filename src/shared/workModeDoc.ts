/**
 * Work mode's typing model, pure so `verify:work-mode` can drive whole
 * sessions without React.
 *
 * A document is a reference file with some lines not yet written. A key types
 * the next characters at the caret, keeping the file's own indentation (it
 * arrives with the newline) and its newlines. A few structure-neutral lines
 * are passed over as holes, and pointer movement fills them, or the frontier,
 * one whole line at a time. What is on screen is therefore always a
 * subsequence of the real file's lines, each a prefix of its line — it only
 * ever looks like the code being written, in order or going back over it.
 *
 * Compiled by both tsconfigs (gotcha 27); relative `.ts` imports (gotcha 78).
 */
import {
  WM_CHARS_MAX,
  WM_CHARS_MIN,
  WM_SKIP_EVERY,
  WM_SKIP_RUN_MAX,
  WM_TABS_MAX,
  WORK_MODE_LANGUAGES,
  detectIndent,
  hash32,
  isWorkModeExt,
  languageOf,
  windowQueues,
  type Grammar,
  type WorkModeFile
} from './workMode.ts'
import { isPlainState, lineStates, sameState, tokenizeLine, type LexState, type Token } from './workModeHighlight.ts'

/* ---------------------------------------------------- a prepared file */

export interface PreparedFile {
  path: string
  ext: string
  language: string
  grammar: Grammar
  lang?: string
  /** The file's lines, tabs expanded so monospace columns hold. A trailing newline adds no empty line. */
  lines: string[]
  /** Each line's leading whitespace. */
  indent: number[]
  /** The lexer state each line starts in. */
  states: LexState[]
  /** Lines left as holes for the pointer to fill. */
  skip: boolean[]
  indentInfo: { tabs: boolean; size: 2 | 4 | 8 }
  eol: 'LF' | 'CRLF'
}

/** A previous line ending like this is waiting for this one: an operator, an open bracket, a block's colon. */
const CONTINUES = /(?:=>|&&|\|\||\?\?|[=+\-*/%?:\\{([])$/

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const TAG = /<(\/?)([A-Za-z][\w:.-]*)[^<>]*?(\/?)>/g

/** Elements a line opens minus those it closes, void and self-closing ones counted as closed; null when it goes negative. */
export function tagBalance(line: string): number | null {
  let bal = 0
  for (const m of line.matchAll(TAG)) {
    if (m[1]) bal--
    else if (!m[3] && !VOID_TAGS.has(m[2].toLowerCase())) bal++
    if (bal < 0) return null
  }
  return bal
}

/** A line's bracket balance over its punctuation, or null when it ever goes negative (it closes something it did not open). */
export function bracketBalance(punct: readonly string[]): number | null {
  let bal = 0
  for (const t of punct) {
    for (const ch of t) {
      if (ch === '(' || ch === '[' || ch === '{') bal++
      else if (ch === ')' || ch === ']' || ch === '}') bal--
      if (bal < 0) return null
    }
  }
  return bal
}

function nonBlank(lines: readonly string[], from: number, step: 1 | -1): number {
  for (let i = from; i >= 0 && i < lines.length; i += step) if (lines[i].trim()) return i
  return -1
}

/**
 * Whether line `i` could be left out without breaking the file's shape: not
 * the first or last line, three characters or more, no comment or string
 * spanning it, its brackets (and for markup its tags) balanced and never
 * closing something it did not open, opening no block, and not the line a
 * previous one is waiting for.
 */
export function skippable(f: Pick<PreparedFile, 'lines' | 'indent' | 'states' | 'grammar' | 'lang'>, i: number): boolean {
  const n = f.lines.length
  if (i <= 0 || i >= n - 1) return false
  const line = f.lines[i]
  if (line.trim().length < 3) return false
  const start = f.states[i]
  if (!isPlainState(f.grammar, start)) return false
  const r = tokenizeLine(f.grammar, line, start, f.lang)
  if (!sameState(r.end, start)) return false
  if (bracketBalance(r.tokens.filter((t) => t.kind === 'punct').map((t) => t.text)) !== 0) return false
  if ((f.grammar === 'html' || f.grammar === 'jsx') && tagBalance(line) !== 0) return false
  const next = nonBlank(f.lines, i + 1, 1)
  if (next >= 0 && f.indent[next] > f.indent[i]) return false
  const prev = nonBlank(f.lines, i - 1, -1)
  if (prev >= 0 && CONTINUES.test(f.lines[prev].trimEnd())) return false
  return true
}

function expandTabs(line: string, size: number): string {
  if (!line.includes('\t')) return line
  let out = ''
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(size - (out.length % size))
    else out += ch
  }
  return out
}

/** A file ready to type: lines, indents, lexer states and its holes for this `seed`. */
export function prepareFile(file: WorkModeFile, seed: number): PreparedFile {
  const ext = isWorkModeExt(file.ext) ? file.ext : 'js'
  const info = WORK_MODE_LANGUAGES[ext]
  const indentInfo = detectIndent(file.text)
  const tab = indentInfo.tabs ? indentInfo.size : 4
  const raw = file.text.replace(/\r\n?/g, '\n').split('\n')
  if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop()
  const lines = raw.map((l) => expandTabs(l, tab))
  const indent = lines.map((l) => l.length - l.trimStart().length)
  const states = lineStates(info.grammar, lines, info.lang)
  const base = { lines, indent, states, grammar: info.grammar, lang: info.lang }
  const skip = lines.map(() => false)
  let run = 0
  for (let i = 0; i < lines.length; i++) {
    const pick = run < WM_SKIP_RUN_MAX && hash32(seed, file.path, i) % WM_SKIP_EVERY === 0 && skippable(base, i)
    skip[i] = pick
    run = pick ? run + 1 : 0
  }
  return { path: file.path, ext, language: languageOf(ext), grammar: info.grammar, lang: info.lang, lines, indent, states, skip, indentInfo, eol: file.eol }
}

/* -------------------------------------------------------- the document */

export interface DocState {
  /** Characters on screen per line, -1 for a line not there yet. */
  typed: Int32Array
  /** The line the caret is on (a reference index). */
  caret: number
  /** The furthest line started. */
  frontier: number
  done: boolean
  /** Unsaved: set by typing, cleared by a save. */
  dirty: boolean
  /** Anything ever typed (the explorer's M). */
  touched: boolean
}

type Doc = Pick<PreparedFile, 'lines' | 'indent' | 'skip'>

const present = (d: DocState, i: number): boolean => d.typed[i] >= 0
const complete = (f: Doc, d: DocState, i: number): boolean => d.typed[i] === f.lines[i].length

/** A line the caret may go to: a partial line, a hole behind the frontier, or the next non-skip line past it. */
export function isSlot(f: Doc, d: DocState, i: number): boolean {
  return !complete(f, d, i) && (i <= d.frontier || !f.skip[i])
}

/** The next slot after `after`, wrapping to the first from the top (going back over the holes); null when none is left. */
export function nextSlot(f: Doc, d: DocState, after: number): number | null {
  for (let i = after + 1; i < f.lines.length; i++) if (isSlot(f, d, i)) return i
  for (let i = 0; i < f.lines.length; i++) if (isSlot(f, d, i)) return i
  return null
}

/** Put the caret on line `i`, its indentation already there. Mutates the copy it is handed. */
function start(f: Doc, d: DocState, i: number): void {
  if (d.typed[i] < 0) d.typed[i] = Math.min(f.indent[i], f.lines[i].length)
  d.frontier = Math.max(d.frontier, i)
  d.caret = i
}

function copy(d: DocState): DocState {
  return { ...d, typed: d.typed.slice() }
}

/** A fresh document: the first line started, the caret at 1:1. */
export function newDoc(f: Doc): DocState {
  const d: DocState = { typed: new Int32Array(f.lines.length).fill(-1), caret: 0, frontier: -1, done: false, dirty: false, touched: false }
  const first = nextSlot(f, d, -1)
  if (first === null) return { ...d, frontier: 0, done: true }
  start(f, d, first)
  return d
}

/** `n` characters at the caret. A newline costs one, a blank line costs one; no slot left is `done`. */
export function typeChars(f: Doc, doc: DocState, n: number): DocState {
  if (doc.done || n <= 0) return doc
  const d = copy(doc)
  let left = Math.floor(n)
  while (left > 0) {
    const c = d.caret
    const len = f.lines[c].length
    if (d.typed[c] < len) {
      const take = Math.min(left, len - d.typed[c])
      d.typed[c] += take
      left -= take
      continue
    }
    const s = nextSlot(f, d, c)
    if (s === null) {
      d.done = true
      break
    }
    left--
    start(f, d, s)
  }
  d.dirty = true
  d.touched = true
  return d
}

export interface View {
  first: number
  last: number
}

/** How many lines before reference index `ref` are on screen: its row if it is there, the row it would take if not. */
export function rowOfRef(doc: DocState, ref: number): number {
  let row = 0
  for (let i = 0; i < ref && i < doc.typed.length; i++) if (doc.typed[i] >= 0) row++
  return row
}

export function caretRow(doc: DocState): number {
  return rowOfRef(doc, doc.caret)
}

/** The slot the frontier offers: its own line while unfinished, else the next slot. */
function frontierSlot(f: Doc, d: DocState): number | null {
  if (d.frontier >= 0 && isSlot(f, d, d.frontier)) return d.frontier
  return nextSlot(f, d, Math.max(-1, d.frontier))
}

/**
 * Where an aim at `pointerRow` puts the caret: the slot anchored nearest it
 * within the view (two rows either side), the current one kept while it is
 * within a row of the best, and the frontier's when none is in view (the
 * editor then scrolls to it). Null when nothing is left to write.
 *
 * With soft wrap the pointer, the view and the anchors are VISUAL rows: `tops`
 * is `WrapLayout.tops` (present line k fills rows `tops[k]` to `tops[k + 1] - 1`,
 * and a line not there yet is inserted at `tops[k]`). Without it a line is one
 * row, as before. A `tops` a frame stale (a key landed between) is read
 * safely: past its end, one row per line.
 */
export function aimTarget(f: Doc, doc: DocState, pointerRow: number, view: View, tops?: ArrayLike<number>): number | null {
  if (doc.done) return null
  let best: number | null = null
  let bestDist = Infinity
  let caretDist = Infinity
  let row = 0
  const lo = view.first - 2
  const hi = view.last + 2
  const count = f.lines.length
  const last = tops && tops.length > 0 ? tops.length - 1 : -1
  const top = (k: number): number => (last < 0 || !tops ? k : k <= last ? tops[k] : tops[last] + (k - last))
  // One pass: `row` is how many present lines came before index i.
  for (let i = 0; i < count; i++) {
    const here = present(doc, i)
    if (isSlot(f, doc, i)) {
      // A present line fills its rows; a hole or the next start would be inserted where `row` begins.
      const from = top(row)
      const to = here ? Math.max(from, top(row + 1) - 1) : from
      if (to >= lo && from <= hi) {
        const dist = pointerRow < from ? from - pointerRow : pointerRow > to ? pointerRow - to : 0
        if (dist < bestDist) {
          best = i
          bestDist = dist
        }
        if (i === doc.caret) caretDist = dist
      }
      if (i > doc.frontier && !here) {
        // Every slot past the frontier anchors at the end; the first one is the one that matters.
        break
      }
    }
    if (here) row++
  }
  if (best === null) return frontierSlot(f, doc)
  if (caretDist !== Infinity && caretDist <= bestDist + 1) return doc.caret
  return best
}

/** The caret to slot `s`: a partial line it leaves stays partial, as in a real editor. */
export function aimAt(f: Doc, doc: DocState, s: number): DocState {
  if (doc.done || s < 0 || s >= f.lines.length || s === doc.caret) return doc
  if (!isSlot(f, doc, s)) return doc
  const d = copy(doc)
  start(f, d, s)
  return d
}

/** One whole line at the caret: the caret's line finished, or, if it already is, the next slot's. */
export function fillLine(f: Doc, doc: DocState): DocState {
  if (doc.done) return doc
  const d = copy(doc)
  if (complete(f, d, d.caret)) {
    const s = nextSlot(f, d, d.caret)
    if (s === null) return { ...d, done: true }
    start(f, d, s)
  }
  d.typed[d.caret] = f.lines[d.caret].length
  d.dirty = true
  d.touched = true
  return d
}

export interface DocRow {
  ref: number
  text: string
}

/** What is on screen: the present lines in order, each as far as it is typed. */
export function docRows(f: Doc, doc: DocState): DocRow[] {
  const out: DocRow[] = []
  for (let i = 0; i < f.lines.length; i++) if (doc.typed[i] >= 0) out.push({ ref: i, text: f.lines[i].slice(0, doc.typed[i]) })
  return out
}

/** The reference indexes on screen, in order (the editor renders from these). */
export function presentRefs(doc: DocState): number[] {
  const out: number[] = []
  for (let i = 0; i < doc.typed.length; i++) if (doc.typed[i] >= 0) out.push(i)
  return out
}

/* ------------------------------------------------------ soft wrap: visual rows */

/*
 * Soft wrap, as VS Code's word wrap draws it: a line wider than the editor
 * goes on over more visual rows, with no line number and indented like the
 * line itself (`wrappingIndent: "same"`), broken after a space or one of
 * `})]?|/&.,;` or before `([{+` where it can, and inside a word only when the
 * word is wider than a row. Nothing ever scrolls sideways. Prove Finding 1:
 * each editor is about 67 columns at 1440 px, so typing any longer line
 * scrolled the whole editor and cut every other line mid-word, and a caret
 * coming back to an indented line stopped a few pixels short of 0, so the
 * sticky gutter hid column 0 (`nterface`, `xport`, a lone `}` gone).
 */

/** Columns kept free at a row's right edge: one for the caret after the last character, one a hanging space may take. */
export const WRAP_RESERVE = 2
/** The fewest columns a continuation row keeps for text: a deeper indentation starts continuation rows at column 0. */
export const WRAP_MIN_TEXT = 20
/** The narrowest wrap, whatever the window. */
export const WRAP_MIN_COLS = 8

const BREAK_AFTER: ReadonlySet<string> = new Set([' ', '\t', '}', ')', ']', '?', '|', '/', '&', '.', ',', ';'])
const BREAK_BEFORE: ReadonlySet<string> = new Set(['(', '[', '{', '+'])

/** Columns one UTF-16 unit takes: two in the East Asian wide and fullwidth ranges, else one (a surrogate pair is counted by `unitAt`). */
export function charColumns(code: number): 1 | 2 {
  if (code < 0x1100) return 1
  if (
    code <= 0x115f ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) {
    return 2
  }
  return 1
}

/** The character at `i`: its length in UTF-16 units (a surrogate pair is one character, an emoji or the like, two columns) and its columns. */
function unitAt(text: string, i: number): { size: 1 | 2; cols: 1 | 2 } {
  const c = text.charCodeAt(i)
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
    const d = text.charCodeAt(i + 1)
    if (d >= 0xdc00 && d <= 0xdfff) return { size: 2, cols: 2 }
  }
  return { size: 1, cols: charColumns(c) }
}

/** The columns a text takes on screen. */
export function textColumns(text: string): number {
  let cols = 0
  for (let i = 0; i < text.length; ) {
    const u = unitAt(text, i)
    cols += u.cols
    i += u.size
  }
  return cols
}

/** Text columns per row for a code area `widthPx` wide: whole characters, less the gutter and `WRAP_RESERVE`, never under `WRAP_MIN_COLS`. */
export function wrapColumns(widthPx: number, chPx: number, gutterCh: number): number {
  if (!(widthPx > 0) || !(chPx > 0)) return 80
  return Math.max(WRAP_MIN_COLS, Math.floor(widthPx / chPx) - Math.max(0, gutterCh) - WRAP_RESERVE)
}

/** The indentation continuation rows keep: the line's own, unless that leaves under `WRAP_MIN_TEXT` columns (or half the row). */
export function wrapIndent(indent: number, cols: number): number {
  const keep = Math.min(WRAP_MIN_TEXT, Math.floor(cols / 2))
  return indent > 0 && cols - indent >= keep ? indent : 0
}

/**
 * Where each visual row of `text` starts; the first is 0. A row holds at most
 * `cols` columns (continuation rows `cols - contIndent`), and a space may hang
 * one column past it, as in VS Code. Every row holds at least one character,
 * and a surrogate pair is never split.
 */
export function wrapStarts(text: string, cols: number, contIndent = 0): number[] {
  const starts = [0]
  const n = text.length
  let start = 0
  let capacity = Math.max(1, cols)
  while (start < n) {
    let width = 0
    let opp = -1
    let cut = -1
    for (let i = start; i < n; ) {
      // A break may come before i: after a breaking character, or before one that breaks before itself.
      if (i > start && (BREAK_AFTER.has(text[i - 1]) || BREAK_BEFORE.has(text[i]))) opp = i
      const u = unitAt(text, i)
      if (width + u.cols > capacity) {
        cut = text[i] === ' ' && width + u.cols <= capacity + 1 ? i + 1 : opp > start ? opp : i
        break
      }
      width += u.cols
      i += u.size
    }
    if (cut < 0 || cut >= n) break
    if (cut <= start) cut = start + unitAt(text, start).size
    starts.push(cut)
    start = cut
    capacity = Math.max(1, cols - contIndent)
  }
  return starts
}

/** One present line's wrap: where its rows start, and how far continuation rows are indented. */
export interface LineWrap {
  typed: number
  cols: number
  starts: number[]
  indent: number
}

/** The visual rows of everything on screen. */
export interface WrapLayout {
  /** The present lines' reference indexes, in order (`presentRefs`). */
  refs: number[]
  /** Each present line's wrap, in the same order. */
  wraps: LineWrap[]
  /** `tops[k]` is present line k's first visual row; `tops[refs.length]` is every visual row. */
  tops: Int32Array
}

/**
 * The visual rows for a document `cols` columns wide: each present line's
 * typed text wrapped (`wrapStarts`, continuation rows indented by
 * `wrapIndent`). `cache` (by reference index) keeps a line's wrap while its
 * typed length and the width stay, so a key re-wraps one line; it changes
 * nothing but the time taken.
 */
export function wrapLayout(f: Pick<PreparedFile, 'lines' | 'indent'>, doc: DocState, cols: number, cache?: Map<number, LineWrap>): WrapLayout {
  const refs = presentRefs(doc)
  const wraps: LineWrap[] = []
  const tops = new Int32Array(refs.length + 1)
  let row = 0
  for (let k = 0; k < refs.length; k++) {
    const ref = refs[k]
    const typed = doc.typed[ref]
    let w = cache?.get(ref)
    if (!w || w.typed !== typed || w.cols !== cols) {
      const indent = wrapIndent(Math.min(f.indent[ref], typed), cols)
      w = { typed, cols, starts: wrapStarts(f.lines[ref].slice(0, typed), cols, indent), indent }
      cache?.set(ref, w)
    }
    wraps.push(w)
    tops[k] = row
    row += w.starts.length
  }
  tops[refs.length] = row
  return { refs, wraps, tops }
}

/** The present line a visual row belongs to (binary search); a row past the last counts one line per row, where new lines would go. */
export function lineOfVisual(tops: ArrayLike<number>, visual: number): number {
  const lines = tops.length - 1
  if (lines <= 0) return Math.max(0, visual)
  if (visual < 0) return 0
  if (visual >= tops[lines]) return lines + (visual - tops[lines])
  let lo = 0
  let hi = lines - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (tops[mid] <= visual) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Where the caret is drawn: the end of its line's typed text, on that line's last visual row, `col` columns from the text's left edge. */
export function caretVisual(f: Pick<PreparedFile, 'lines'>, doc: DocState, layout: WrapLayout): { row: number; col: number } | null {
  const k = layout.refs.indexOf(doc.caret)
  if (k < 0) return null
  const w = layout.wraps[k]
  const lastStart = w.starts[w.starts.length - 1]
  const tail = f.lines[doc.caret].slice(lastStart, doc.typed[doc.caret])
  return { row: layout.tops[k] + w.starts.length - 1, col: (w.starts.length > 1 ? w.indent : 0) + textColumns(tail) }
}

/** A line's tokens cut into its visual rows (`starts`); joined back, each row is that slice of the line. */
export function splitTokens(tokens: readonly Token[], starts: readonly number[]): Token[][] {
  const rows: Token[][] = starts.map(() => [])
  let row = 0
  let pos = 0
  for (const t of tokens) {
    let from = 0
    while (from < t.text.length) {
      const end = row + 1 < starts.length ? starts[row + 1] : Infinity
      const take = Math.min(t.text.length - from, end - (pos + from))
      if (take <= 0) {
        row++
        continue
      }
      rows[row].push({ kind: t.kind, text: t.text.slice(from, from + take) })
      from += take
    }
    pos += t.text.length
  }
  return rows
}

/* ----------------------------------------------------------- a session */

export interface DocTab {
  /** An index into `Session.files`. */
  file: number
  doc: DocState
}

export interface Group {
  tabs: DocTab[]
  active: number
  /** The files this group types, in order, cycling. */
  queue: number[]
  cursor: number
}

export interface Session {
  files: WorkModeFile[]
  prepared: (PreparedFile | null)[]
  picks: string[]
  groups: [Group, Group]
  active: 0 | 1
  charsPerKey: number
  seed: number
}

export type WorkModeAction =
  | { kind: 'type' }
  | { kind: 'aim'; group: 0 | 1; row: number; view: View; tops?: ArrayLike<number> }
  | { kind: 'fill'; group: 0 | 1 }
  | { kind: 'focus'; group: 0 | 1 }
  | { kind: 'tab'; group: 0 | 1; index: number }
  | { kind: 'close'; group: 0 | 1; index: number }
  | { kind: 'save' }
  | { kind: 'chars'; n: number }
  | { kind: 'open'; group: 0 | 1; file: number }
  | { kind: 'requeue'; files: WorkModeFile[]; picks: string[] }

export function clampChars(n: number): number {
  return Number.isFinite(n) ? Math.min(WM_CHARS_MAX, Math.max(WM_CHARS_MIN, Math.round(n))) : WM_CHARS_MIN
}

/** The prepared file `i`, prepared now if it was not (the session copies its cache, so this stays pure). */
export function preparedOf(s: Session, i: number): PreparedFile {
  return s.prepared[i] ?? prepareFile(s.files[i], s.seed)
}

function withPrepared(s: Session, i: number): Session {
  if (s.prepared[i]) return s
  const prepared = s.prepared.slice()
  prepared[i] = prepareFile(s.files[i], s.seed)
  return { ...s, prepared }
}

function setGroup(s: Session, g: 0 | 1, group: Group): Session {
  const groups: [Group, Group] = [s.groups[0], s.groups[1]]
  groups[g] = group
  return { ...s, groups }
}

/** File `file` in group `g`: its tab if open (a finished one starts over), else a new tab; the oldest inactive tab goes past `WM_TABS_MAX`. */
function openFile(s0: Session, g: 0 | 1, file: number): Session {
  if (file < 0 || file >= s0.files.length) return s0
  const s = withPrepared(s0, file)
  const f = preparedOf(s, file)
  const group = s.groups[g]
  const at = group.tabs.findIndex((t) => t.file === file)
  if (at >= 0) {
    const tabs = group.tabs.slice()
    if (tabs[at].doc.done) tabs[at] = { file, doc: newDoc(f) }
    return setGroup(s, g, { ...group, tabs, active: at })
  }
  let tabs = [...group.tabs, { file, doc: newDoc(f) }]
  let active = tabs.length - 1
  while (tabs.length > WM_TABS_MAX) {
    const drop = tabs.findIndex((_, i) => i !== active)
    tabs = tabs.filter((_, i) => i !== drop)
    if (drop < active) active--
  }
  return setGroup(s, g, { ...group, tabs, active })
}

/** The group's next queued file, cycling. */
function openNext(s: Session, g: 0 | 1): Session {
  const group = s.groups[g]
  if (group.queue.length === 0) return s
  const file = group.queue[group.cursor % group.queue.length]
  const moved = setGroup(s, g, { ...group, cursor: group.cursor + 1 })
  return openFile(moved, g, file)
}

function updateDoc(s: Session, g: 0 | 1, edit: (f: PreparedFile, d: DocState) => DocState): Session {
  const group = s.groups[g]
  const tab = group.tabs[group.active]
  if (!tab) return openNext(s, g)
  const ready = withPrepared(s, tab.file)
  const f = preparedOf(ready, tab.file)
  const doc = edit(f, tab.doc)
  if (doc === tab.doc) return ready
  const tabs = group.tabs.slice()
  tabs[group.active] = { file: tab.file, doc }
  const next = setGroup(ready, g, { ...group, tabs })
  // At a file's end, the group's next file opens in a new tab.
  return doc.done ? openNext(next, g) : next
}

/** A session: the left group types the first pick's files, the right the rest (`windowQueues`). */
export function newSession(files: WorkModeFile[], picks: string[], charsPerKey: number, seed: number): Session {
  const q = windowQueues(files, picks)
  let s: Session = {
    files,
    prepared: files.map(() => null),
    picks,
    groups: [
      { tabs: [], active: 0, queue: q.left, cursor: 0 },
      { tabs: [], active: 0, queue: q.right, cursor: 0 }
    ],
    active: 0,
    charsPerKey: clampChars(charsPerKey),
    seed
  }
  s = openNext(s, 0)
  s = openNext(s, 1)
  return s
}

export function reduceWorkMode(s: Session, a: WorkModeAction): Session {
  switch (a.kind) {
    case 'type':
      return updateDoc(s, s.active, (f, d) => typeChars(f, d, s.charsPerKey))
    case 'aim': {
      const focused = s.active === a.group ? s : { ...s, active: a.group }
      return updateDoc(focused, a.group, (f, d) => {
        const target = aimTarget(f, d, a.row, a.view, a.tops)
        return target === null ? d : aimAt(f, d, target)
      })
    }
    case 'fill': {
      const focused = s.active === a.group ? s : { ...s, active: a.group }
      return updateDoc(focused, a.group, (f, d) => fillLine(f, d))
    }
    case 'focus':
      return s.active === a.group ? s : { ...s, active: a.group }
    case 'tab': {
      const group = s.groups[a.group]
      if (a.index < 0 || a.index >= group.tabs.length) return s
      return { ...setGroup(s, a.group, { ...group, active: a.index }), active: a.group }
    }
    case 'close': {
      const group = s.groups[a.group]
      if (a.index < 0 || a.index >= group.tabs.length) return s
      const tabs = group.tabs.filter((_, i) => i !== a.index)
      // Closing the tab in front shows the one that took its place (or the last); one before it shifts it left.
      let active = group.active
      if (a.index < active) active--
      else if (a.index === active) active = Math.min(a.index, tabs.length - 1)
      const next = setGroup(s, a.group, { ...group, tabs, active: Math.max(0, active) })
      return tabs.length ? next : openNext(next, a.group)
    }
    case 'save': {
      const group = s.groups[s.active]
      const tab = group.tabs[group.active]
      if (!tab || !tab.doc.dirty) return s
      const tabs = group.tabs.slice()
      tabs[group.active] = { file: tab.file, doc: { ...tab.doc, dirty: false } }
      return setGroup(s, s.active, { ...group, tabs })
    }
    case 'chars':
      return { ...s, charsPerKey: clampChars(a.n) }
    case 'open':
      return { ...openFile(s, a.group, a.file), active: a.group }
    case 'requeue':
      return newSession(a.files, a.picks, s.charsPerKey, s.seed)
  }
}

/** The active tab of a group, with its prepared file, or null. */
export function activeTab(s: Session, g: 0 | 1): { tab: DocTab; file: PreparedFile } | null {
  const group = s.groups[g]
  const tab = group.tabs[group.active]
  return tab ? { tab, file: preparedOf(s, tab.file) } : null
}
