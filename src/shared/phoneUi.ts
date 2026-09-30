/*
 * The phone UI's decisions, as pure functions — everything `src/remote` decides
 * that can be tested without a DOM, a socket or a real `claude`.
 *
 * `src/remote` is a browser bundle and `scripts/verify-phone-ui.mts` runs this
 * file under node's type-stripping, so: relative imports with `.ts` (gotcha
 * 78), no `node:` import and no DOM type (gotcha 27 — this file is compiled by
 * both tsconfigs, and the node project has no DOM lib).
 */

import { folderChoices, type FolderChoice, type FolderGroup, type HostLike, type ProjectLike } from './launcher.ts'
import { basenameOf, pathKey, pathRulesFor } from './paths.ts'
import {
  agentChoicesFor,
  hostChoices,
  MAX_FOLDER_NAME,
  newFolderNameProblem,
  sortSessionRows,
  type PhoneAgentChoices,
  type PhoneSessionStatus
} from './remotePhone.ts'
import { isCodingCliId } from './codingClis.ts'

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
  // It sits with the idle ones: nothing about it is known to need you. Its row
  // says Running itself (`rowPillShown`), since no heading does.
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

/* ------------------------------------------------------- home and rows */

/**
 * Home's two segments: what runs now, and what ran before.
 *
 * History used to be a screen of its own behind a second topbar button, beside
 * New — two actions competing for the one bar a phone has. It is home's Recent
 * segment now, and a project or a conversation opened from it keeps Recent
 * lit, so Back, the segment and the laptop rail all agree on where you are.
 */
export type HomeSegment = 'running' | 'recent'

export function homeSegmentFor(route: string): HomeSegment {
  return route === 'history' || route === 'project' || route === 'transcript' ? 'recent' : 'running'
}

/**
 * What the Running segment's label carries: how many sessions are live, and
 * how many of those wait on you — shown while Recent is open, so a prompt
 * arriving then is not invisible. Ended rows are listed but not counted.
 */
export function runningBadge(rows: readonly { status: PhoneSessionStatus }[] | null): { live: number; needsYou: number } {
  const list = rows ?? []
  return {
    live: list.filter((r) => r.status !== 'ended').length,
    needsYou: list.filter((r) => r.status === 'waiting').length
  }
}

/**
 * Whether a list row wears a status pill. Every row used to, and the section
 * heading above it already said Working or Idle: the pill was the same word
 * twice. A prompt's kind (Permission, Plan review, Question) and an ended
 * session's are news a heading cannot carry — and so is `unknown`: another
 * agent writes no registry, and `SECTION_OF` files it under Idle, so without
 * its Running pill a Codex session hard at work sat under IDLE with nothing
 * saying otherwise. There is no Running heading for the pill to repeat.
 */
export function rowPillShown(status: PhoneSessionStatus): boolean {
  return status === 'waiting' || status === 'ended' || status === 'unknown'
}

/**
 * How recently a row did something, in the list's second line. Its section
 * heading already says Working or Idle, so this is only the time: "working"
 * and "active" in front of it were the heading said again. An ended row says
 * so, with a non-zero exit, because that is news no heading carries.
 */
export function rowActivity(
  r: {
    status: PhoneSessionStatus
    lastActivityAt: number | null
    startedAt: number
    endedAt: number | null
    exitCode: number | null
  },
  now: number
): string {
  if (r.status === 'ended') {
    const code = r.exitCode !== null && r.exitCode !== 0 ? ` · exit ${r.exitCode}` : ''
    return `ended ${relativeTime(r.endedAt, now) || 'just now'}${code}`
  }
  return relativeTime(r.lastActivityAt ?? r.startedAt, now)
}

/**
 * A list row's second line: where the session runs, then when it last did
 * anything. The first line is the session's own title — two sessions in one
 * project are told apart by what they are doing, not by the folder they share.
 * An SSH row's project is already its host (gotcha 18), so it adds "ssh";
 * another agent adds its name.
 */
export function rowMeta(
  r: {
    project: string
    host: string | null
    cli: string
    agentName: string
    status: PhoneSessionStatus
    lastActivityAt: number | null
    startedAt: number
    endedAt: number | null
    exitCode: number | null
  },
  now: number
): string {
  const where = r.host ? 'ssh' : r.cli !== 'claude' && r.agentName ? r.agentName : null
  return [r.project, where, rowActivity(r, now)].filter(Boolean).join(' · ')
}

/**
 * Recent: the projects with a past conversation, newest first, narrowed by a
 * search over the name the user sees, its folder name and its path.
 */
export function recentProjects<T extends { name: string; label?: string | null; path: string; sessionCount: number; lastActivityAt: number | null }>(
  projects: readonly T[],
  query: string
): T[] {
  const q = query.trim().toLowerCase()
  return projects
    .filter((p) => p.sessionCount > 0)
    .filter(
      (p) =>
        !q ||
        p.name.toLowerCase().includes(q) ||
        (p.label ?? '').toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q)
    )
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
}

/* ------------------------------------------------------------ the dock */

/**
 * Whether the session's key row (esc, arrows, enter, shift-tab) is out.
 *
 * It used to be out always, a full band of keys above the composer on every
 * session, most of the time for nothing. Now it is behind one toggle, and comes
 * out on its own only while the composer has focus: the soft keyboard has none
 * of those keys. While a prompt waits the answer tray is the vocabulary (it
 * replaced the key row in the PX redesign, 0d17f6b), so the row stays in unless
 * asked for — a prompt the tray cannot read, a multi-question form, is one tap
 * on the toggle away, where before it had no keys at all. An ended session has
 * no input. The toggle's own choice wins in both directions, so a person who
 * closed it while typing is not overruled on the next keystroke; the session
 * screen forgets that choice when a prompt arrives or goes, a new moment with
 * its own answer.
 */
export function keyRowShown(s: {
  /** The toggle's state: null while untouched, else what it was set to. */
  toggled: boolean | null
  composerFocused: boolean
  waiting: boolean
  ended: boolean
}): boolean {
  if (s.ended) return false
  if (s.toggled !== null) return s.toggled
  return !s.waiting && s.composerFocused
}

export type PillTone = 'waiting' | 'busy' | 'idle' | 'ended' | 'unknown'

/**
 * What a status pill says. `waitingFor` is Claude Code's own free text (the
 * registry reads "permission prompt" for a tool approval); it is mapped to one
 * word when it is recognisable and otherwise the pill says "Needs you", never
 * the raw string, which can be up to 200 characters.
 */
export function statusPill(
  status: PhoneSessionStatus,
  waitingFor: string | null,
  /**
   * The session's socket is down and reconnecting. The last status is then a
   * reading from before the drop — an "Idle" pill sat under "Reconnecting…"
   * with two messages queued (phone QA) — so it says Offline until the next
   * `attached` frame brings a current one. An ended session stays Ended.
   */
  linkDown = false
): { label: string; tone: PillTone } {
  if (linkDown && status !== 'ended') return { label: 'Offline', tone: 'unknown' }
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
 * Labels for a waiting row whose screen has not been read (yet, or ever: the
 * peek can fail). Numbers only, with no meaning attached. The first version
 * said "1 Yes / 2 / 3 No", and "3 declines" is false: in the plan-approval
 * dialog 3 is "Tell Claude what to change", and a two-option dialog has no 3
 * at all. A label that guesses wrong is worse than a bare number beside the
 * question (review of PX-12).
 */
export const GENERIC_ANSWERS: AnswerOption[] = [
  { key: '1', label: '1', selected: false },
  { key: '2', label: '2', selected: false },
  { key: '3', label: '3', selected: false }
]

/** Where the list's read of a waiting row's screen stands (`peekPrompt`). */
export type PeekState = 'reading' | 'read' | 'failed'

export interface AnswerChoices {
  /** The taps to draw: one-tap answers only go up to 3 (the answer route's keys). */
  options: AnswerOption[]
  /** False while the question is still being read: a tap would be blind. */
  enabled: boolean
  /** What to say in place of the question, or null when the question itself shows. */
  note: string | null
}

/**
 * What a waiting row in the list offers, from its read of the screen.
 *
 * Review of PX-12: the list drew tappable generic numbers the moment a row
 * appeared, before the peek had read the question, and kept them for good when
 * the 6s peek failed. A tap there answers a question nobody on the phone has
 * seen. Now the numbers are drawn but held while the read is in flight (it
 * takes one replay, well under a second on a healthy link); once it has
 * settled without options, they are offered with a note that says so, because
 * a session nobody can read must still be answerable from the list.
 */
export function answerChoices(prompt: ParsedPrompt | null, state: PeekState): AnswerChoices {
  const upTo3 = (list: readonly AnswerOption[]): AnswerOption[] => list.filter((o) => Number(o.key) <= 3)
  if (state === 'reading') return { options: upTo3(GENERIC_ANSWERS), enabled: false, note: 'Reading the question…' }
  if (prompt && prompt.options.length > 0) return { options: upTo3(prompt.options), enabled: true, note: null }
  return {
    options: upTo3(GENERIC_ANSWERS),
    enabled: true,
    note: 'Could not read the options. Open the session to see the question.'
  }
}

/* ---------------------------------------------------- terminal colours */

/**
 * The floor under the phone terminal's `minimumContrastRatio` (xterm), audit
 * PX-21.
 *
 * Claude Code picks its colours for the background it was told about (gotcha
 * 42), and the phone replays the pty's raw history: after the desktop switched
 * theme, the replay mixes lines coloured for the OLD background with the new
 * one, and on a light theme the old white glyphs (diff text, bullets) vanished.
 * The desktop leaves the CLI's palette alone unless the user asks
 * (`contrastBoost`, 1 by default), because it is a choice there; on the phone
 * the mismatch is structural, so the phone never goes under 3:1 — enough to
 * bring back a white glyph on a light page, while leaving colours that already
 * read alone. A higher desktop choice is kept.
 */
export const PHONE_MIN_CONTRAST = 3

export function phoneTermContrast(deskBoost: unknown): number {
  const desk = typeof deskBoost === 'number' && Number.isFinite(deskBoost) ? Math.min(21, deskBoost) : 1
  return Math.max(PHONE_MIN_CONTRAST, desk)
}

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

// `isTerminalReport` lives in remotePhone.ts now: `PtyManager` needs the same
// test, to keep automatic replies from counting as someone answering a prompt.
export { isTerminalReport } from './remotePhone.ts'

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
  /*
   * The width test comes first, and holds for the blur too. It used to apply to
   * `observe` alone, after the focus test: so any box change while typing — the
   * composer growing a line, the key row coming out — deferred, and the blur
   * then fitted rows to the smaller box and sent them. Measured on the phone
   * screen (390x844, Fit): focus, four lines, blur sent 50x43 → 50x39, a
   * SIGWINCH for a height change, the one thing this function exists to refuse.
   */
  if (
    (input.reason === 'observe' || input.reason === 'blur') &&
    input.fitWidth !== null &&
    Math.abs(input.width - input.fitWidth) < Math.max(1, input.cellWidth)
  ) {
    return keep
  }
  if (input.composerFocused && input.reason !== 'toggle') return { ...keep, deferred: true }
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

/**
 * The font "Desktop size" shows the desktop's grid at on a phone.
 *
 * It used to shrink to fit the whole width, down to a 7px floor: at 390x844 a
 * 100-column grid drew at ~4.2px per column, unreadable, and used 285 of 679px
 * of height. The floor is 10px now (or the user's own Text size, if they chose
 * smaller) and the wrap scrolls sideways past it, opened at the cursor
 * (`scrollToColumn`). A laptop-width phone in landscape still fits whole.
 */
export const DESKTOP_MIN_FONT = 10

export function desktopFont(width: number, cols: number, ratio: number, userFont: number): number {
  return fontToFit(width, cols, ratio, Math.min(DESKTOP_MIN_FONT, userFont), userFont)
}

/**
 * The `scrollLeft` that brings a column into a sideways-scrolling view, or the
 * current one when it is already in it. `columnPx` is where the column starts,
 * `cellPx` its width; a margin of a few cells is kept so the cursor is not on
 * the edge.
 */
export function scrollToColumn(columnPx: number, cellPx: number, viewPx: number, current: number): number {
  const margin = cellPx * 4
  if (columnPx - margin >= current && columnPx + cellPx + margin <= current + viewPx) return current
  return Math.max(0, Math.round(columnPx + cellPx / 2 - viewPx / 2))
}

/**
 * The Connect page's heading and sentence.
 *
 * Only a browser that had connected before used to hear that its key was
 * replaced; a fresh one opening `/?k=<stale key>` (a link from an old message,
 * a QR scanned before the key was renewed) got the generic "Connect to your
 * computer" with nothing saying the link's key was refused (phone QA). The
 * URL is scrubbed at boot, so `linkKey` is whether it HAD a `?k=`.
 */
export function connectCopy(opts: { linkKey: boolean; connectedBefore: boolean }): { title: string; text: string } {
  if (opts.linkKey) {
    return {
      title: 'This link’s key isn’t current',
      text: 'The key may have been replaced in Stoke. Scan the new code, or paste the new link here.'
    }
  }
  if (opts.connectedBefore) {
    return {
      title: 'Your key was replaced',
      text: 'The link this phone had no longer works — a new key was made on your computer. Scan the new code, or paste the new link here.'
    }
  }
  return {
    title: 'Connect to your computer',
    text: 'This page drives Claude Code on your computer, so it needs the key Stoke made for it.'
  }
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

/**
 * How a tool call ended, from its `tool_result`: `declined` when the user
 * rejected it at the permission prompt, `failed` for any other error, `ran`
 * otherwise. The Apple transcript's rejected Write read "Ran 1 tool · Write",
 * the same chip as the ones that ran (phone QA).
 */
export type ToolOutcome = 'ran' | 'declined' | 'failed'

/** The text the CLI writes into a rejected tool's result (measured on 2.1.x transcripts). */
const DECLINED = /^The user doesn['’]t want to proceed with this tool use|^User rejected/i

export function toolOutcome(isError: unknown, content: unknown): ToolOutcome {
  if (isError !== true) return 'ran'
  const text =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((b) => (b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string' ? (b as { text: string }).text : ''))
            .join('')
        : ''
  return DECLINED.test(text.trim()) ? 'declined' : 'failed'
}

/**
 * The CLI's interruption markers, which it files as USER messages: they are
 * not something the user said, and the transcript view drew them as a "You"
 * bubble. A short system note instead, or null for real text.
 */
export function interruptionNote(text: string): string | null {
  const t = text.trim()
  if (t === '[Request interrupted by user for tool use]') return 'Stopped — tool declined'
  if (t === '[Request interrupted by user]') return 'Stopped by you'
  return null
}

export interface TurnLike {
  role: 'user' | 'assistant'
  text: string
  tools: string[]
  at: number | null
  /** Per tool, in `tools` order, when the results were read. */
  toolStates?: ToolOutcome[]
  /** A system note (an interruption), drawn instead of a speaker's bubble. */
  note?: string
}

export type TranscriptItem<T extends TurnLike> =
  | { kind: 'turn'; turn: T }
  | { kind: 'tools'; count: number; summary: string; at: number | null; declined: number; failed: number }

/** A collapsed tool run's words: "Ran 2 tools · 1 declined", "Declined 1 tool". */
export function toolsLabel(count: number, declined: number, failed: number): string {
  const ran = count - declined - failed
  const tool = (n: number): string => `${n} tool${n === 1 ? '' : 's'}`
  const parts: string[] = []
  if (ran > 0) parts.push(`Ran ${tool(ran)}`)
  if (declined > 0) parts.push(ran > 0 ? `${declined} declined` : `Declined ${tool(declined)}`)
  if (failed > 0) parts.push(ran > 0 || declined > 0 ? `${failed} failed` : `${tool(failed)} failed`)
  return parts.join(' · ') || `Ran ${tool(count)}`
}

/**
 * Collapse runs of tool-only assistant turns into one line — audit PX-15.
 * Every tool call used to be its own "CLAUDE ⚙ Bash" block with a timestamp,
 * so a read-back was mostly scaffolding. A turn that also says something keeps
 * its own block (with its tools under it).
 */
export function collapseTurns<T extends TurnLike>(turns: readonly T[]): TranscriptItem<T>[] {
  const out: TranscriptItem<T>[] = []
  let run: { counts: Map<string, number>; total: number; at: number | null; declined: number; failed: number } | null = null
  const close = (): void => {
    if (!run) return
    const summary = [...run.counts]
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => (n > 1 ? `${name} ×${n}` : name))
      .join(', ')
    out.push({ kind: 'tools', count: run.total, summary, at: run.at, declined: run.declined, failed: run.failed })
    run = null
  }
  for (const turn of turns) {
    const toolOnly = turn.role === 'assistant' && !turn.text.trim() && turn.tools.length > 0
    if (!toolOnly) {
      close()
      if (turn.text.trim() || turn.tools.length || turn.note) out.push({ kind: 'turn', turn })
      continue
    }
    run ??= { counts: new Map(), total: 0, at: turn.at, declined: 0, failed: 0 }
    turn.tools.forEach((t, i) => {
      if (!run) return
      run.counts.set(t, (run.counts.get(t) ?? 0) + 1)
      run.total++
      const state = turn.toolStates?.[i]
      if (state === 'declined') run.declined++
      else if (state === 'failed') run.failed++
    })
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

/* ------------------------------------------------------ where to start */

/** One `/api/projects` row, as far as the picker needs it (phone contract point 11). */
export interface PickerProject {
  path: string
  name: string
  /** The name the user gave it; absent from a desktop older than point 11. */
  label?: string | null
  pinned: boolean
  exists: boolean
  sessionCount: number
  lastActivityAt: number | null
}

/** What the phone labels the desktop's "Open folder…": it browses instead of opening a dialog. */
export const BROWSE_LABEL = 'Browse folders…'

/**
 * The New session sheet's first step: the desktop switcher's own list
 * (`folderChoices` — Recent projects, Elsewhere: Default folder and Scratch
 * session, Remote machines, then Browse), so a phone and the desktop offer
 * the same places in the same order. The old picker (PX-11) grouped only the
 * projects the server sent, and it sent sixty.
 *
 * A project that IS the default folder is listed once, as the default folder
 * — macOS lists `/tmp/x` as `/private/tmp/x`, so either spelling counts.
 */
export function phonePickerGroups(input: {
  projects: readonly PickerProject[]
  defaultCwd: string
  hosts: readonly HostLike[]
  query: string
  platform: string
}): FolderGroup[] {
  const rules = pathRulesFor(input.platform)
  const def = pathKey(input.defaultCwd, rules)
  const isDefault = (p: string): boolean => {
    const k = pathKey(p, rules)
    return !!def && (k === def || k === `/private${def}` || `/private${k}` === def)
  }
  const projects: ProjectLike[] = input.projects
    .filter((p) => !isDefault(p.path))
    .map((p) => ({
      path: p.path,
      name: p.name,
      label: p.label ?? null,
      exists: p.exists,
      pinned: p.pinned,
      sessionCount: p.sessionCount,
      lastModified: p.lastActivityAt
    }))
  return folderChoices({ projects, defaultCwd: input.defaultCwd, hosts: input.hosts, query: input.query }).map((g) => ({
    ...g,
    items: g.items.map((c): FolderChoice => (c.kind === 'open' ? { ...c, label: BROWSE_LABEL } : c))
  }))
}

/** One step of the Browse breadcrumb. */
export interface Crumb {
  label: string
  path: string
}

/**
 * The Browse step's breadcrumb: the place (`/api/folders`' `base`) and then
 * each folder below it down to `path` — never above the place, where the phone
 * may not go. Separator-agnostic: the desktop may be Windows.
 */
export function breadcrumb(path: string, base: string): Crumb[] {
  const strip = (p: string): string => p.replace(/[\\/]+$/, '') || p
  const p = strip(path.trim())
  const b = strip(base.trim())
  const sep = b.includes('\\') && !b.includes('/') ? '\\' : '/'
  const head: Crumb = { label: basenameOf(b) || b, path: b }
  if (!p || p === b) return [head]
  const prefix = b.endsWith(sep) ? b : b + sep
  if (!p.startsWith(prefix)) return [{ label: basenameOf(p) || p, path: p }]
  let at = b
  return [
    head,
    ...p
      .slice(prefix.length)
      .split(/[\\/]+/)
      .filter(Boolean)
      .map((seg) => {
        at = at.endsWith(sep) ? at + seg : at + sep + seg
        return { label: seg, path: at }
      })
  ]
}

/**
 * The New folder field's hint: nothing while it is empty (the button is
 * simply off), else why the server would refuse the name, else null.
 */
export function newFolderHint(name: string): string | null {
  return name.trim() ? newFolderNameProblem(name) : null
}

export { MAX_FOLDER_NAME, newFolderNameProblem }

/**
 * The agent the New session sheet opens on: the desktop's default agent
 * (`/api/host`'s `defaults.cli`) when the sheet offers it, else the first agent
 * offered — Claude Code, whenever it is, since the server lists in table order.
 * An older desktop sends no `cli`, and gets that same first-agent answer.
 */
export function initialAgent(agents: readonly { id: string }[], defaultCli: string | undefined): string {
  if (defaultCli && agents.some((a) => a.id === defaultCli)) return defaultCli
  return agents[0]?.id ?? 'claude'
}

/* ------------------------------------------- the confirm step, per agent */

/**
 * The confirm step's choices for one agent: what `/api/host` served for it,
 * or — from a desktop too old to serve `choices` — the table's own answer with
 * no endpoint and no account (Claude's lists; another agent's model is its
 * own). A remote machine always gets `hostChoices`: its `claude` takes nothing
 * the phone could pick (gotcha 19).
 */
export function phoneChoicesFor(
  served: Readonly<Record<string, PhoneAgentChoices>> | undefined,
  cli: string,
  opts: { host?: boolean; defaultModel?: string } = {}
): PhoneAgentChoices {
  if (opts.host) return hostChoices()
  const hit = served?.[cli]
  if (hit) return hit
  const id = isCodingCliId(cli) ? cli : 'claude'
  return agentChoicesFor(id, { endpoints: {}, accounts: {}, defaultAccount: {}, defaultModel: opts.defaultModel ?? '' })
}

/** What the confirm step has picked. */
export interface PhonePicks {
  mode: string
  model: string
  effort: string
  account: string
}

/**
 * The picks a sheet opens on: the desktop's defaults where this agent offers
 * them (`/api/host`'s `defaults` are Claude's), else the agent's first — and
 * the account a start naming none would run on.
 */
export function initialPicks(
  c: PhoneAgentChoices,
  defaults: { permissionMode?: string; model?: string; effort?: string } | undefined
): PhonePicks {
  const has = (list: readonly { id: string }[], v: string | undefined): v is string => v !== undefined && list.some((x) => x.id === v)
  return {
    mode: has(c.modes, defaults?.permissionMode) ? defaults.permissionMode : (c.modes[0]?.id ?? 'default'),
    model: !c.modelFixed && has(c.models, defaults?.model) ? defaults.model : (c.models[0]?.id ?? ''),
    effort: has(c.efforts, defaults?.effort) ? defaults.effort : (c.efforts[0]?.id ?? 'default'),
    account: c.account
  }
}

/** Whether the account picker shows: Default and at least one account of the agent's own. */
export function showsAccountPicker(c: PhoneAgentChoices): boolean {
  return c.accounts.length > 1
}

/** Why Start is off with these picks (the picked account cannot start), or null. */
export function startProblem(c: PhoneAgentChoices, picks: PhonePicks): string | null {
  return c.accounts.find((a) => a.id === picks.account)?.problem ?? null
}

/**
 * What `POST /api/sessions` is sent beyond where it runs: only what this agent
 * takes. No mode, effort or model for an agent that takes none (the server
 * refuses one), and an account only when there was a choice to make — absent,
 * main starts the agent's own default account, which is the same one.
 */
export function startFields(cli: string, c: PhoneAgentChoices, picks: PhonePicks, host = false): Record<string, string> {
  const out: Record<string, string> = {}
  if (!host && cli !== 'claude') out.cli = cli
  if (c.modes.length) out.permissionMode = picks.mode
  if (!c.modelFixed) out.model = picks.model
  if (c.efforts.length) out.effort = picks.effort
  if (showsAccountPicker(c)) out.accountId = picks.account
  return out
}
