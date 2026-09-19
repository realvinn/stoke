/*
 * The phone UI's decisions, as pure functions — everything `src/remote` decides
 * that can be tested without a DOM, a socket or a real `claude`.
 *
 * `src/remote` is a browser bundle and `scripts/verify-phone-ui.mts` runs this
 * file under node's type-stripping, so: relative imports with `.ts` (gotcha
 * 78), no `node:` import and no DOM type (gotcha 27 — this file is compiled by
 * both tsconfigs, and the node project has no DOM lib).
 */

import { sortSessionRows, type PhoneSessionStatus } from './remotePhone.ts'

/* ------------------------------------------------------------ the list */

export type SectionId = 'needs' | 'working' | 'idle' | 'ended'

export interface Section<T> {
  id: SectionId
  label: string
  rows: T[]
}

const SECTION_OF: Record<PhoneSessionStatus, SectionId> = {
  waiting: 'needs',
  busy: 'working',
  idle: 'idle',
  // Another agent writes no registry, so Stoke cannot say more than "running".
  // It sits with the idle ones: nothing about it is known to need you.
  unknown: 'idle',
  ended: 'ended'
}

const SECTION_LABEL: Record<SectionId, string> = {
  needs: 'Needs you',
  working: 'Working',
  idle: 'Idle',
  ended: 'Ended'
}

/**
 * The list's sections, in attention order, empty ones dropped. Within a
 * section the order is `sortSessionRows`' (most recently active first), so the
 * server's own sort and this grouping cannot disagree about who comes first.
 */
export function groupSessionRows<T extends { status: PhoneSessionStatus; lastActivityAt: number | null }>(
  rows: readonly T[]
): Section<T>[] {
  const sorted = sortSessionRows(rows)
  const order: SectionId[] = ['needs', 'working', 'idle', 'ended']
  return order
    .map((id) => ({ id, label: SECTION_LABEL[id], rows: sorted.filter((r) => SECTION_OF[r.status] === id) }))
    .filter((s) => s.rows.length > 0)
}

export type PillTone = 'waiting' | 'busy' | 'idle' | 'ended' | 'unknown'

/**
 * What a status pill says. `waitingFor` is Claude Code's own free text (the
 * registry reads "permission prompt" for a tool approval); it is mapped to one
 * word when it is recognisable and otherwise the pill says "Needs you", never
 * the raw string, which can be up to 200 characters.
 */
export function statusPill(status: PhoneSessionStatus, waitingFor: string | null): { label: string; tone: PillTone } {
  switch (status) {
    case 'waiting': {
      const w = (waitingFor ?? '').toLowerCase()
      if (w.includes('permission')) return { label: 'Permission', tone: 'waiting' }
      if (w.includes('plan')) return { label: 'Plan review', tone: 'waiting' }
      if (w.includes('question') || w.includes('input')) return { label: 'Question', tone: 'waiting' }
      return { label: 'Needs you', tone: 'waiting' }
    }
    case 'busy':
      return { label: 'Working', tone: 'busy' }
    case 'idle':
      return { label: 'Idle', tone: 'idle' }
    case 'ended':
      return { label: 'Ended', tone: 'ended' }
    default:
      return { label: 'Running', tone: 'unknown' }
  }
}

/* --------------------------------------------------- answering a prompt */

export interface AnswerOption {
  /** The digit that selects it. */
  key: string
  label: string
  /** The CLI's cursor (❯) is on it: what Enter would pick. */
  selected: boolean
}

export interface ParsedPrompt {
  question: string | null
  options: AnswerOption[]
}

/** A leading box-drawing edge, as a boxed dialog draws one. */
const EDGE = /^[\s│┃║|]*/
const OPTION = /^([❯›>▶→]\s*)?(\d{1,2})[.)]\s+(.*\S)\s*$/

/**
 * The numbered choices on the terminal's screen, read bottom-most first.
 *
 * `lines` are screen rows, top to bottom (the caller hands over the last
 * dozen or so from xterm's buffer). A Claude Code permission prompt looks
 * like
 *
 *     Do you want to create hello.txt?
 *     ❯ 1. Yes
 *       2. Yes, and switch to accept edits (auto-approve file
 *          edits and common file commands) for this session
 *       3. No
 *
 * so an option is `[cursor] N. text`, a wrapped label continues on following
 * rows indented past the number (only when the row above was full, given
 * `cols`), and the question is the paragraph right above option 1. The LAST run of 1, 2, 3… wins: an earlier answered
 * prompt can still be on screen above the live one. Fewer than two options is
 * not a choice, so null — the tray then offers generic keys instead of
 * inventing labels.
 */
export function parseAnswerOptions(lines: readonly string[], cols?: number): ParsedPrompt | null {
  type Block = { start: number; options: (AnswerOption & { indent: number })[] }
  let best: Block | null = null
  let block: Block | null = null
  let continuing = false

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/[\s│┃║|]+$/, '')
    const edge = EDGE.exec(raw)?.[0].length ?? 0
    const body = raw.slice(edge)
    const m = OPTION.exec(body)
    if (m) {
      const n = Number(m[2])
      const indent = edge + (m[1]?.length ?? 0)
      const option = { key: String(n), label: m[3], selected: Boolean(m[1]), indent }
      if (n === 1) {
        block = { start: i, options: [option] }
      } else if (block && n === block.options.length + 1) {
        block.options.push(option)
      } else {
        block = null
      }
      if (block && block.options.length >= 2) best = block
      continuing = Boolean(block)
      continue
    }
    if (!body.trim()) {
      continuing = false
      continue
    }
    // A wrapped label: indented past the number, and only when the row above
    // was full — the next word would not have fitted on it. A short option
    // followed by an indented row is a hint under it ("shift+tab to approve
    // with this feedback"), not more of its label.
    const last = block?.options[block.options.length - 1]
    const above = lines[i - 1]?.replace(/\s+$/, '') ?? ''
    const firstWord = body.trim().split(/\s+/)[0] ?? ''
    const wrapped = cols === undefined || above.length + 1 + firstWord.length > cols
    if (continuing && last && edge > last.indent && wrapped) {
      last.label = `${last.label} ${body.trim()}`
      continue
    }
    continuing = false
  }

  if (!best) return null
  // The question: the paragraph right above option 1, which may itself wrap.
  const question: string[] = []
  for (let i = best.start - 1; i >= 0 && i >= best.start - 5; i--) {
    const text = lines[i].replace(EDGE, '').replace(/[\s│┃║|]+$/, '').trim()
    if (!text) {
      if (question.length) break
      continue
    }
    if (/^[─━╌┄┈═\-–—_\s]+$/.test(text)) break
    question.unshift(text)
    if (question.length === 3) break
  }
  return {
    question: question.length ? question.join(' ') : null,
    options: best.options.map(({ key, label, selected }) => ({
      key,
      label: label.replace(/\s+/g, ' ').trim(),
      selected
    }))
  }
}

/**
 * Labels for a waiting row the list has not read the screen of. Deliberately
 * only the two meanings that hold across every Claude Code permission dialog
 * measured (1 accepts, the last choice declines); option 2's meaning varies
 * ("don't ask again", "switch to accept edits", "manually approve"), so it is
 * offered by number alone rather than guessed at.
 */
export const GENERIC_ANSWERS: AnswerOption[] = [
  { key: '1', label: 'Yes', selected: false },
  { key: '2', label: '2', selected: false },
  { key: '3', label: 'No', selected: false }
]

/**
 * The permission mode Claude Code's footer says is on ("⏵⏵ auto mode on",
 * "⏸ plan mode on", "accept edits on", "manual mode on"), as the key row's
 * shift-tab label. The transcript's own `permission-mode` record lags a
 * shift-tab by a whole turn, so the screen is the truth. Null when the footer
 * says nothing recognisable.
 */
export function modeFromScreen(lines: readonly string[]): string | null {
  const MODES: [RegExp, string][] = [
    [/\bauto mode on\b/i, 'Auto'],
    [/\bmanual mode on\b/i, 'Ask'],
    [/\bplan mode on\b/i, 'Plan'],
    [/\baccept edits on\b/i, 'Edits'],
    [/\bbypass permissions on\b/i, 'Bypass']
  ]
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 6; i--) {
    for (const [re, label] of MODES) if (re.test(lines[i])) return label
  }
  return null
}

/**
 * Is this xterm `onData` an automatic REPLY the phone's terminal generated,
 * rather than a key somebody pressed?
 *
 * Every attach replays the pty's history into the phone's xterm, and xterm
 * answers every query in it as if it were live: device attributes
 * (`ESC[?1;2c`), the background colour (`ESC]11;rgb:…`), cursor position,
 * mode reports, focus in/out. The old client forwarded all of `onData` to the
 * pty, so opening a session on a phone typed stale answers into Claude — one
 * of them telling it the page's background colour, which Claude Code uses to
 * pick its palette. The desktop's own terminal already answers the live
 * queries; the phone must never answer any.
 */
export function isTerminalReport(data: string): boolean {
  return (
    /^\u001b\[[?>=]?[\d;]*c$/.test(data) || // primary/secondary/tertiary device attributes
    /^\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)$/.test(data) || // OSC replies (colours, clipboard)
    /^\u001b\[\??\d+;\d+R$/.test(data) || // cursor position report
    /^\u001b\[\??[\d;]*\$y$/.test(data) || // DECRPM mode report
    /^\u001b\[[IO]$/.test(data) || // focus in/out
    /^\u001b\[\d+;\d+;\d+t$/.test(data) || // window size reports
    /^\u001bP[\s\S]*\u001b\\$/.test(data) // DCS replies (XTVERSION, DECRQSS)
  )
}

/* ------------------------------------------------------ resize policy */

/**
 * How the phone's terminal relates to the pty's size.
 *
 * - `native`: a laptop browser. The terminal renders at the pty's own size and
 *   never resizes it (audit PX-16: the stretched-phone layout also reflowed
 *   the desktop to the browser's width).
 * - `desktop`: a phone or tablet showing the desktop's own grid, scaled and
 *   scrolled. Never resizes the pty, except once to put back a size this
 *   client changed.
 * - `fit`: "Fit to phone", chosen explicitly. Columns follow the screen width.
 */
export type TermLayout = 'native' | 'desktop' | 'fit'

export interface Size {
  cols: number
  rows: number
}

export interface ResizeInput {
  layout: TermLayout
  /** Why this is being asked: the first attach, an observed box change, the toggle, the composer losing focus. */
  reason: 'attach' | 'observe' | 'toggle' | 'blur'
  /** The terminal box's content width now, px. */
  width: number
  /** The width the last fit was computed at, or null if this client never fitted. */
  fitWidth: number | null
  /** One cell's width, px — the smallest width change that can change `cols`. */
  cellWidth: number
  /** What would fit the box at the current font, or null before layout. */
  proposed: Size | null
  /** The pty's size as this client last knew it. */
  pty: Size
  /** The desktop's own size (`attached.desktopCols/Rows`, F2). */
  desktop: Size
  /** The composer has focus — on a phone, the soft keyboard is up. */
  composerFocused: boolean
  /** This client has resized the pty and not yet put it back. */
  resized: boolean
}

export interface ResizeDecision {
  /** A `{type:'resize', force:true}` to send, or null. */
  send: Size | null
  /** The size the local xterm must be; always the pty's size once `send` lands. */
  local: Size
  /** The width this fit was computed at (carried into the next `fitWidth`). */
  fitWidth: number | null
  /** Nothing now, but ask again on `blur`. */
  deferred: boolean
}

/**
 * Whether to resize the pty — audit PX-5.
 *
 * The old client refitted and sent a resize on EVERY size change of the
 * terminal's box: the composer growing a line, the send button clearing it,
 * the soft keyboard, rotation. Each one was a SIGWINCH to Claude and a reflow
 * of the terminal of whoever sat at the desktop. The rules now:
 *
 * - only `fit` ever resizes, and only after the user chose it;
 * - only a WIDTH change of at least one cell does (rotation, a split view) —
 *   a height change is the keyboard or the composer, and never counts;
 * - never while the composer has focus; deferred to its blur instead;
 * - rows are measured at the moment of a width change and then left alone;
 * - leaving `fit` puts the desktop's own size back, once.
 */
export function decideResize(input: ResizeInput): ResizeDecision {
  const same = (a: Size, b: Size): boolean => a.cols === b.cols && a.rows === b.rows
  const keep: ResizeDecision = { send: null, local: input.pty, fitWidth: input.fitWidth, deferred: false }

  if (input.layout !== 'fit') {
    const target = input.layout === 'desktop' ? input.desktop : input.pty
    if (input.resized && !same(input.pty, input.desktop)) {
      return { send: input.desktop, local: input.desktop, fitWidth: null, deferred: false }
    }
    return { send: null, local: target, fitWidth: null, deferred: false }
  }

  if (!input.proposed) return keep
  if (input.composerFocused && input.reason !== 'toggle') return { ...keep, deferred: true }
  if (
    input.reason === 'observe' &&
    input.fitWidth !== null &&
    Math.abs(input.width - input.fitWidth) < Math.max(1, input.cellWidth)
  ) {
    return keep
  }
  const next = { cols: Math.max(20, input.proposed.cols), rows: Math.max(8, input.proposed.rows) }
  return {
    send: same(next, input.pty) ? null : next,
    local: next,
    fitWidth: input.width,
    deferred: false
  }
}

/**
 * The font that shows `cols` columns in `width` px, for the `desktop` layout.
 * `ratio` is one monospace cell's width per px of font size (about 0.6).
 * Clamped: under `min` the text is unreadable, so the box scrolls instead.
 */
export function fontToFit(width: number, cols: number, ratio: number, min: number, max: number): number {
  if (width <= 0 || cols <= 0 || ratio <= 0) return max
  const exact = width / (cols * ratio)
  return Math.max(min, Math.min(max, Math.floor(exact * 2) / 2))
}

/* ------------------------------------------- sending while disconnected */

export interface QueuedSend {
  id: number
  text: string
  at: number
}

export interface SendState {
  /** The socket is open AND the server has sent `attached`. */
  ready: boolean
  queue: QueuedSend[]
  nextId: number
}

export const INITIAL_SEND_STATE: SendState = { ready: false, queue: [], nextId: 1 }

/**
 * The composer's send — audit PX-3.
 *
 * `submit()` used to call `write()`, which only toasted when the socket was
 * not open, and then cleared the textarea anyway: the first thing typed after
 * an iOS background/foreground was thrown away. Now a send while not ready is
 * queued (shown above the composer, cancellable) and flushed, in order, when
 * the socket is back. A send while ready but with a queue still waiting joins
 * the queue too, so nothing overtakes a message typed earlier.
 */
export function submitText(state: SendState, text: string, now: number): { state: SendState; send: string | null } {
  if (!text.trim()) return { state, send: null }
  if (state.ready && state.queue.length === 0) return { state, send: text }
  return {
    state: { ...state, queue: [...state.queue, { id: state.nextId, text, at: now }], nextId: state.nextId + 1 },
    send: null
  }
}

/** The socket is attached again: everything queued goes, oldest first. */
export function sendReady(state: SendState): { state: SendState; flush: string[] } {
  return { state: { ...state, ready: true, queue: [] }, flush: state.queue.map((q) => q.text) }
}

export function sendLost(state: SendState): SendState {
  return { ...state, ready: false }
}

export function cancelQueued(state: SendState, id: number): SendState {
  return { ...state, queue: state.queue.filter((q) => q.id !== id) }
}

/* --------------------------------------------------------- connecting */

export type ConnectInput =
  | { kind: 'key'; key: string }
  | { kind: 'link'; key: string; url: string; sameOrigin: boolean }
  | { kind: 'invalid'; reason: string }

const KEY = /^[A-Za-z0-9_-]{16,256}$/

/**
 * What the Connect screen's one field was given — audit PX-14. Either the
 * whole link Stoke shows (`http://host:port/?k=<key>`), or the key alone.
 */
export function parseConnectInput(input: string, origin: string): ConnectInput {
  const text = input.trim()
  if (!text) return { kind: 'invalid', reason: 'Paste the link or the key from Stoke.' }
  if (KEY.test(text)) return { kind: 'key', key: text }
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return { kind: 'invalid', reason: 'That is not a Stoke link or key.' }
  }
  const key = url.searchParams.get('k') ?? ''
  if (!KEY.test(key)) return { kind: 'invalid', reason: 'That link carries no key. Copy it again from Stoke.' }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { kind: 'invalid', reason: 'That is not a Stoke link or key.' }
  }
  return { kind: 'link', key, url: url.toString(), sameOrigin: url.origin === origin }
}

/* ---------------------------------------------------------- transcript */

export interface TurnLike {
  role: 'user' | 'assistant'
  text: string
  tools: string[]
  at: number | null
}

export type TranscriptItem<T extends TurnLike> =
  | { kind: 'turn'; turn: T }
  | { kind: 'tools'; count: number; summary: string; at: number | null }

/**
 * Collapse runs of tool-only assistant turns into one line — audit PX-15.
 * Every tool call used to be its own "CLAUDE ⚙ Bash" block with a timestamp,
 * so a read-back was mostly scaffolding. A turn that also says something keeps
 * its own block (with its tools under it).
 */
export function collapseTurns<T extends TurnLike>(turns: readonly T[]): TranscriptItem<T>[] {
  const out: TranscriptItem<T>[] = []
  let run: { counts: Map<string, number>; total: number; at: number | null } | null = null
  const close = (): void => {
    if (!run) return
    const summary = [...run.counts]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
      .join(', ')
    out.push({ kind: 'tools', count: run.total, summary, at: run.at })
    run = null
  }
  for (const turn of turns) {
    const toolOnly = turn.role === 'assistant' && !turn.text.trim() && turn.tools.length > 0
    if (!toolOnly) {
      close()
      if (turn.text.trim() || turn.tools.length) out.push({ kind: 'turn', turn })
      continue
    }
    run ??= { counts: new Map(), total: 0, at: turn.at }
    for (const t of turn.tools) {
      run.counts.set(t, (run.counts.get(t) ?? 0) + 1)
      run.total++
    }
    run.at = turn.at ?? run.at
  }
  close()
  return out
}

export type TextPart = { kind: 'text'; text: string } | { kind: 'code'; text: string } | { kind: 'fence'; text: string; lang: string }

/**
 * Just enough Markdown for a read-back: ``` fences and `inline code`. Anything
 * else stays literal text — the renderer uses textContent, never innerHTML, so
 * a transcript cannot inject markup.
 */
export function splitMarkdown(text: string): TextPart[] {
  const parts: TextPart[] = []
  const fence = /```([^\n`]*)\n([\s\S]*?)(?:```|$)/g
  let at = 0
  for (let m = fence.exec(text); m; m = fence.exec(text)) {
    if (m.index > at) parts.push(...splitInline(text.slice(at, m.index)))
    parts.push({ kind: 'fence', lang: m[1].trim(), text: m[2].replace(/\n$/, '') })
    at = m.index + m[0].length
  }
  if (at < text.length) parts.push(...splitInline(text.slice(at)))
  return parts
}

function splitInline(text: string): TextPart[] {
  const parts: TextPart[] = []
  const code = /`([^`\n]+)`/g
  let at = 0
  for (let m = code.exec(text); m; m = code.exec(text)) {
    if (m.index > at) parts.push({ kind: 'text', text: text.slice(at, m.index) })
    parts.push({ kind: 'code', text: m[1] })
    at = m.index + m[0].length
  }
  if (at < text.length) parts.push({ kind: 'text', text: text.slice(at) })
  return parts
}

/* --------------------------------------------------------------- copy */

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

export function relativeTime(ms: number | null, now: number): string {
  if (!ms) return ''
  const minutes = (now - ms) / 60000
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${Math.floor(minutes)}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  return `${Math.floor(minutes / 1440)}d ago`
}

/** `/Users/me/dev/a/very/long/path` → `/Users/me/…/long/path`: both ends are the informative ones. */
export function middleTruncate(text: string, max: number): string {
  if (text.length <= max) return text
  if (max < 5) return text.slice(0, max)
  const keep = max - 1
  const head = Math.ceil(keep / 2)
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`
}

/** The project picker's groups — audit PX-11. */
export interface ProjectLike {
  path: string
  name: string
  pinned: boolean
  lastActivityAt: number | null
  sessionCount: number
}

export function groupProjects<T extends ProjectLike>(
  projects: readonly T[],
  query: string,
  now: number
): { id: 'pinned' | 'recent' | 'all'; label: string; rows: T[] }[] {
  const q = query.trim().toLowerCase()
  const match = (p: T): boolean => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q)
  const byRecent = (a: T, b: T): number => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)
  const week = 7 * 24 * 60 * 60 * 1000
  const found = projects.filter(match)
  const pinned = found.filter((p) => p.pinned).sort(byRecent)
  const recent = found.filter((p) => !p.pinned && p.lastActivityAt !== null && now - p.lastActivityAt <= week).sort(byRecent)
  const rest = found
    .filter((p) => !p.pinned && !recent.includes(p))
    .sort((a, b) => a.name.localeCompare(b.name))
  return [
    { id: 'pinned' as const, label: 'Pinned', rows: pinned },
    { id: 'recent' as const, label: 'Recent', rows: recent },
    { id: 'all' as const, label: q ? 'Other matches' : 'All projects', rows: rest }
  ].filter((g) => g.rows.length > 0)
}
