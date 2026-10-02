/**
 * Find in a conversation: the transcript half.
 *
 * A Claude Code tab on its fullscreen renderer draws the whole conversation on
 * the terminal's ALTERNATE screen, which keeps no scrollback — so the xterm
 * search in the find bar sees only the rows on screen, and "the code a bit back
 * up" is not in the terminal at all. It is in the session's JSONL transcript,
 * which this module searches: newest message first, the user's own text,
 * Claude's replies, and (by default) every tool call's input and every tool's
 * output — a code a command printed lives only there. Thinking and subagent
 * sidechains are left out, as the transcript viewer leaves them out.
 *
 * Everything here is pure (no `node:` import, gotcha 27): the worker in main
 * reads the file and calls these, the renderer shares the types, and
 * `verify:find` holds the rules.
 */

/* ------------------------------------------------------------------- wire */

export interface FindOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

/**
 * An SSH tab's answer for this find. `once` copies the host's newest
 * conversation for this bar only and keeps nothing on disk; `always` records
 * the host's consent (`SshHost.transcriptFind`) and then searches.
 */
export type FindConsent = 'once' | 'always'

export interface TranscriptFindRequest extends FindOptions {
  /** The tab's session id, read at the moment of the search (gotchas 26, 80). */
  sessionId: string
  /** `SshHost.id` for an SSH tab, else null. Main re-reads the host from settings. */
  hostId: string | null
  query: string
  /** Tool calls' input and tools' output; off searches only what was said. */
  includeTools: boolean
  consent?: FindConsent
  /** Copy an SSH host's conversation again even if a recent copy is held. */
  refresh?: boolean
}

/** Who wrote the text a hit was found in. */
export type FindRole = 'user' | 'assistant' | 'tool-call' | 'tool-output'

export interface TranscriptFindHit {
  /** Index into the result's `messages`, for Copy message. */
  message: number
  role: FindRole
  /** The tool's name for a call or its output; null for conversation. */
  tool: string | null
  /** A tool's output that came back marked as an error. */
  isError: boolean
  atMs: number | null
  /** The text around the match, a few lines at most. */
  window: string
  /** Every match inside `window`, in UTF-16 units of `window`. */
  ranges: [number, number][]
  cutBefore: boolean
  cutAfter: boolean
  /** Exactly what the pattern matched. */
  matchText: string
  /** The whitespace-delimited word the match sits in, punctuation trimmed. */
  token: string
  /** Matches in this message past the ones listed, on its last listed hit. */
  more: number
}

export interface TranscriptFindMessage {
  text: string
  /** The message was longer than `FIND_LIMITS.message` and was cut there. */
  cut: boolean
}

export type TranscriptFindSource =
  | { kind: 'local'; file: string; partial: boolean }
  | {
      kind: 'ssh'
      host: string
      /** The file's path on the far machine, as `ls` printed it. */
      remotePath: string
      /** The most a fetch reads from the end of the file. */
      tailBytes: number
      fetchedAt: number
      /** False for "Just this once": the copy is in memory only. */
      kept: boolean
    }

export type TranscriptFindRefusal =
  | 'no-session'
  | 'no-file'
  | 'consent'
  | 'fetch-failed'
  | 'no-remote'
  | 'bad-query'
  | 'timeout'
  | 'failed'

export type TranscriptFindResult =
  | {
      ok: true
      hits: TranscriptFindHit[]
      messages: TranscriptFindMessage[]
      /** Every match found, listed or not. */
      total: number
      /** More matched than are listed. */
      truncated: boolean
      source: TranscriptFindSource
    }
  | {
      ok: false
      reason: TranscriptFindRefusal
      /** One sentence the bar shows as it is. */
      message: string
      /** The host's name, on an SSH refusal. */
      host?: string
    }

/* ------------------------------------------------------------------ limits */

export const FIND_LIMITS = {
  /** Hits listed. Newest first, so the cut drops the oldest. */
  hits: 200,
  /** Hits listed from one message; the rest are counted in `more`. */
  perMessage: 5,
  /** Matches counted in one message before the count stops. */
  perMessageScan: 1000,
  /** Characters either side of a match in a hit's window. */
  window: 160,
  /** Lines either side of a match in a hit's window. */
  windowLines: 1,
  /** Characters of a message Copy message can take. */
  message: 50_000,
  /** The longest query main will compile. */
  query: 500
} as const

/* ------------------------------------------------------------- the pattern */

const SYNTAX = /[.*+?^${}()|[\]\\/]/g

/** A literal, escaped for a RegExp — only the syntax characters, so the `u` flag accepts it. */
export function escapeRegExp(text: string): string {
  return text.replace(SYNTAX, '\\$&')
}

export type CompiledFind = { ok: true; re: RegExp } | { ok: false; error: string }

/**
 * The query as a global RegExp, or why it cannot be one. Null for an empty
 * query: nothing to find is not an error.
 *
 * Whole word means what xterm's search means by it — the match is not flanked
 * by a letter, a digit or `_` — so the screen and the conversation agree on
 * what "INV" whole-word finds in `INV-8F3K`. A user's regex is tried with the
 * `u` flag first (so `\p{L}` and astral characters work) and without it when
 * it is only valid that way (`[a-z\-]` is a syntax error under `u`).
 */
export function compileFind(query: string, opts: FindOptions): CompiledFind | null {
  if (!query) return null
  if (query.length > FIND_LIMITS.query) return { ok: false, error: 'That is too long to search for.' }
  const body = opts.regex ? query : escapeRegExp(query)
  const flags = `g${opts.caseSensitive ? '' : 'i'}`
  const attempt = (unicode: boolean): RegExp | null => {
    const word = unicode ? '[\\p{L}\\p{N}_]' : '[A-Za-z0-9_]'
    const src = opts.wholeWord ? `(?<!${word})(?:${body})(?!${word})` : body
    try {
      return new RegExp(src, flags + (unicode ? 'u' : ''))
    } catch {
      return null
    }
  }
  const re = attempt(true) ?? (opts.regex ? attempt(false) : null)
  if (!re) return { ok: false, error: 'That is not a pattern JavaScript can read.' }
  return { ok: true, re }
}

/**
 * Every non-empty match of `re` in `text`, as [start, end) in UTF-16 units,
 * at most `max`. A pattern that can match nothing (`a*`) moves on one
 * character rather than looping on the same empty match.
 */
export function rangesIn(text: string, re: RegExp, max: number = FIND_LIMITS.perMessageScan): [number, number][] {
  const out: [number, number][] = []
  const g = re.global ? re : new RegExp(re.source, re.flags + 'g')
  g.lastIndex = 0
  while (out.length < max) {
    const m = g.exec(text)
    if (!m) break
    if (m[0].length === 0) {
      g.lastIndex = m.index + (codePointWidth(text, m.index) || 1)
      if (g.lastIndex > text.length) break
      continue
    }
    out.push([m.index, m.index + m[0].length])
  }
  g.lastIndex = 0
  return out
}

/** 2 when a surrogate pair starts at `i`, 1 for any other character, 0 past the end. */
function codePointWidth(text: string, i: number): number {
  if (i >= text.length) return 0
  const c = text.charCodeAt(i)
  return c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1
}

/** Never start or end a slice between the halves of a surrogate pair. */
function safeStart(text: string, i: number): number {
  const c = text.charCodeAt(i)
  return i > 0 && c >= 0xdc00 && c <= 0xdfff ? i - 1 : i
}
function safeEnd(text: string, i: number): number {
  const c = text.charCodeAt(i - 1)
  return i < text.length && c >= 0xd800 && c <= 0xdbff ? i + 1 : i
}

export interface FindWindow {
  text: string
  /** Where `text` starts in the message. */
  offset: number
  cutBefore: boolean
  cutAfter: boolean
}

/**
 * The text around one match: the match's own lines plus `lines` either side,
 * and never more than `radius` characters either side of the match. CRLF is
 * read as one break and the window keeps the message's own characters, so the
 * ranges into it are plain offsets.
 */
export function windowAround(
  text: string,
  start: number,
  end: number,
  radius: number = FIND_LIMITS.window,
  lines: number = FIND_LIMITS.windowLines
): FindWindow {
  let from = start
  for (let seen = 0; from > 0; from--) {
    if (text[from - 1] === '\n' && ++seen > lines) break
  }
  let to = end
  for (let seen = 0; to < text.length; to++) {
    if (text[to] === '\n' && ++seen > lines) break
    if (text[to] === '\r' && text[to + 1] === '\n' && seen + 1 > lines) break
  }
  from = safeStart(text, Math.max(from, start - radius))
  to = safeEnd(text, Math.min(to, end + radius))
  return { text: text.slice(from, to), offset: from, cutBefore: from > 0, cutAfter: to < text.length }
}

/** What ends a token: whitespace, and the brackets and quotes a token sits inside. */
const TOKEN_STOP = /[\s"'`()<>[\]{}]/
/** Punctuation a sentence or markdown hangs on a token's ends. */
const TOKEN_TRIM_END = /[.,;:!?*]+$/
const TOKEN_TRIM_START = /^[*]+/

/**
 * The word a match sits in: for "INV" in `the code is INV-8F3K-29.` it is
 * `INV-8F3K-29`. Grown out from the match to whitespace, a bracket or a quote,
 * then a sentence's trailing punctuation and markdown's `**` are trimmed — but
 * never into the match itself, so a query that ends in punctuation keeps it.
 */
export function tokenAround(text: string, start: number, end: number): string {
  let from = start
  while (from > 0 && !TOKEN_STOP.test(text[from - 1])) from--
  let to = end
  while (to < text.length && !TOKEN_STOP.test(text[to])) to++
  let head = text.slice(from, start)
  let tail = text.slice(end, to)
  tail = tail.replace(TOKEN_TRIM_END, '')
  head = head.replace(TOKEN_TRIM_START, '')
  return head + text.slice(start, end) + tail
}

/* ------------------------------------------------- reading the transcript */

export interface FindBlock {
  role: FindRole
  tool: string | null
  isError: boolean
  atMs: number | null
  text: string
}

/**
 * State carried from one record to the next: a tool's output names the call it
 * answers only by id, so the call's name is remembered from the record before.
 */
export interface BlockContext {
  toolNames: Map<string, string>
}

export function newBlockContext(): BlockContext {
  return { toolNames: new Map() }
}

/** Worth a `JSON.parse` at all: Claude writes compact JSON, so the type is a plain substring. */
export function lineMayHoldBlocks(line: string): boolean {
  return line.includes('"type":"user"') || line.includes('"type":"assistant"')
}

/**
 * A tool call's input as text a person would search: one `key: value` line per
 * field, strings as they are rather than JSON-escaped, so a newline or a quote
 * in a command is the character the user remembers, not `\n` or `\"`.
 */
export function describeToolInput(input: unknown): string {
  if (input === null || input === undefined) return ''
  if (typeof input !== 'object') return String(input)
  const lines: string[] = []
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (value === null || value === undefined) continue
    if (typeof value === 'string') lines.push(`${key}: ${value}`)
    else if (typeof value === 'number' || typeof value === 'boolean') lines.push(`${key}: ${String(value)}`)
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) lines.push(`${key}: ${value.join(', ')}`)
    else lines.push(`${key}: ${JSON.stringify(value)}`)
  }
  return lines.join('\n')
}

/** A tool_result's content: a string, or text blocks (images and anything else skipped). */
export function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const b of content) {
    if (b && typeof b === 'object' && (b as { type?: unknown }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') parts.push(t)
    }
  }
  return parts.join('\n')
}

function stampOf(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? null : ms
}

/**
 * The searchable blocks of one transcript record, in the order they were
 * written. Only the user's and Claude's own thread: a sidechain record is a
 * subagent's, a meta record is the CLI talking to itself, thinking is not
 * conversation. Tool calls and outputs only when `includeTools`.
 */
export function blocksOfRecord(rec: unknown, includeTools: boolean, ctx: BlockContext): FindBlock[] {
  if (!rec || typeof rec !== 'object') return []
  const r = rec as Record<string, unknown>
  if (r.type !== 'user' && r.type !== 'assistant') return []
  if (r.isSidechain === true || r.isMeta === true) return []
  const role: FindRole = r.type === 'user' ? 'user' : 'assistant'
  const atMs = stampOf(r.timestamp)
  const content = (r.message as { content?: unknown } | undefined)?.content
  const block = (b: Omit<FindBlock, 'atMs'>): FindBlock => ({ ...b, atMs })
  if (typeof content === 'string') {
    return content ? [block({ role, tool: null, isError: false, text: content })] : []
  }
  if (!Array.isArray(content)) return []
  const out: FindBlock[] = []
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string' && b.text) {
      out.push(block({ role, tool: null, isError: false, text: b.text }))
    } else if (b.type === 'tool_use') {
      const name = typeof b.name === 'string' ? b.name : 'tool'
      if (typeof b.id === 'string') ctx.toolNames.set(b.id, name)
      if (!includeTools) continue
      const text = describeToolInput(b.input)
      if (text) out.push(block({ role: 'tool-call', tool: name, isError: false, text }))
    } else if (b.type === 'tool_result') {
      if (!includeTools) continue
      const text = toolResultText(b.content)
      const tool = typeof b.tool_use_id === 'string' ? (ctx.toolNames.get(b.tool_use_id) ?? null) : null
      if (text) out.push(block({ role: 'tool-output', tool, isError: b.is_error === true, text }))
    }
    // thinking, redacted_thinking, image: not searched.
  }
  return out
}

/** One JSONL line's blocks; a line that is not a record yields none. */
export function blocksOfLine(line: string, includeTools: boolean, ctx: BlockContext): FindBlock[] {
  if (!lineMayHoldBlocks(line)) return []
  let rec: unknown
  try {
    rec = JSON.parse(line)
  } catch {
    return []
  }
  return blocksOfRecord(rec, includeTools, ctx)
}

/** Every block of a whole JSONL text, in order. */
export function blocksOfJsonl(text: string, includeTools: boolean, ctx: BlockContext = newBlockContext()): FindBlock[] {
  const out: FindBlock[] = []
  for (const line of text.split('\n')) {
    if (line) out.push(...blocksOfLine(line.endsWith('\r') ? line.slice(0, -1) : line, includeTools, ctx))
  }
  return out
}

/* --------------------------------------------------------------- the search */

export interface FindAnswer {
  hits: TranscriptFindHit[]
  messages: TranscriptFindMessage[]
  total: number
  truncated: boolean
}

/**
 * Search the blocks, newest message first and each message's matches in
 * reading order. Every match is counted; at most `FIND_LIMITS.hits` are listed,
 * at most `perMessage` from one message.
 *
 * One hit per WINDOW, not per match: matches that fall inside a hit's window
 * are highlighted there rather than listed again as a card showing the same
 * lines. A hit's own match — what Copy match and Copy token take — is the one
 * whose text is exactly `prefer` when there is one: a case-folded "INV" also
 * matches "invite" and "Invoice", and the code is the one worth copying.
 */
export function searchBlocks(
  blocks: readonly FindBlock[],
  re: RegExp,
  limits: Partial<typeof FIND_LIMITS> = {},
  prefer: string | null = null
): FindAnswer {
  const lim = { ...FIND_LIMITS, ...limits }
  const hits: TranscriptFindHit[] = []
  const messages: TranscriptFindMessage[] = []
  let total = 0
  /** Matches inside a listed hit's window. */
  let shown = 0
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i]
    const found = rangesIn(b.text, re, lim.perMessageScan)
    if (found.length === 0) continue
    total += found.length
    const room = Math.min(lim.perMessage, lim.hits - hits.length)
    if (room <= 0) continue
    const cut = b.text.length > lim.message
    const message = messages.push({ text: cut ? b.text.slice(0, safeEnd(b.text, lim.message)) : b.text, cut }) - 1
    let k = 0
    let listed = 0
    let last: TranscriptFindHit | null = null
    while (k < found.length && listed < room) {
      const [s, e] = found[k]
      const w = windowAround(b.text, s, e, lim.window, lim.windowLines)
      const wEnd = w.offset + w.text.length
      let next = k + 1
      while (next < found.length && found[next][0] >= w.offset && found[next][1] <= wEnd) next++
      const group = found.slice(k, next)
      const [ps, pe] = (prefer ? group.find(([gs, ge]) => b.text.slice(gs, ge) === prefer) : undefined) ?? group[0]
      last = {
        message,
        role: b.role,
        tool: b.tool,
        isError: b.isError,
        atMs: b.atMs,
        window: w.text,
        ranges: found
          .filter(([fs, fe]) => fs >= w.offset && fe <= wEnd)
          .map(([fs, fe]) => [fs - w.offset, fe - w.offset] as [number, number]),
        cutBefore: w.cutBefore,
        cutAfter: w.cutAfter,
        matchText: b.text.slice(ps, pe),
        token: tokenAround(b.text, ps, pe),
        more: 0
      }
      hits.push(last)
      listed++
      k = next
    }
    if (last) last.more = found.length - k
    shown += k
  }
  return { hits, messages, total, truncated: total > shown }
}

/* ------------------------------------------------------------- SSH consent */

/**
 * What main may do for an SSH tab's find. The copy puts a conversation from
 * another machine on this one, so it happens only on the host's own answer:
 * `keep` once the host is allowed (and on the press that allows it), `once`
 * for "Just this once" (nothing written to disk), and otherwise `ask` — the bar
 * shows the question and main fetches nothing.
 */
export function consentVerdict(host: { transcriptFind?: boolean }, consent: FindConsent | undefined): 'keep' | 'once' | 'ask' {
  if (host.transcriptFind === true || consent === 'always') return 'keep'
  if (consent === 'once') return 'once'
  return 'ask'
}

/**
 * The request as main will act on it, or null when it is not one. Every field
 * is checked: it crosses IPC, and `sessionId` names a file.
 */
export function parseFindRequest(raw: unknown): TranscriptFindRequest | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.sessionId !== 'string' || typeof r.query !== 'string') return null
  if (r.hostId !== null && r.hostId !== undefined && typeof r.hostId !== 'string') return null
  const consent = r.consent === 'once' || r.consent === 'always' ? r.consent : undefined
  return {
    sessionId: r.sessionId,
    hostId: typeof r.hostId === 'string' ? r.hostId : null,
    query: r.query,
    caseSensitive: r.caseSensitive === true,
    wholeWord: r.wholeWord === true,
    regex: r.regex === true,
    includeTools: r.includeTools !== false,
    ...(consent ? { consent } : {}),
    ...(r.refresh === true ? { refresh: true } : {})
  }
}
