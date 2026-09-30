/**
 * Chat history: every AI chat on this machine made searchable, with caps.
 *
 * The pure half of the chat index. The sources' readers, the store and the
 * pass live in `src/main/chatIndex/` and run in a worker thread; this file is
 * what BOTH processes need — the source registry's names, the settings shape
 * and its clamp, the caps and what they are called when they bind, the search
 * hit's shape, and the rule for what opening a hit does. No `node:` import
 * (gotcha 27), so the renderer, main and `verify:chat-sources` read one copy.
 *
 * The owner asked for "any AI chats we can detect", capped "just in case anyone
 * is a massive AI user". So the three rules here are: Stoke looks only in named
 * places (`CHAT_SOURCES`), it reads newest first under caps that are always
 * said out loud (`sourceDisclosure`), and nothing is read before the user says
 * yes (`chatIndex: 'unasked'` means detection only: names, sizes, counts).
 */
import type { CodingCliId } from './codingClis.ts'

/* ------------------------------------------------------------------ sources */

/**
 * Every source this build can read. Ordered as a pass reads them: Cline last,
 * because a Cline session is usually an imported COPY of one of the others
 * (164 of 172 on the machine this was written on) and is folded into its
 * origin only once the origin is in the store.
 *
 * Export files (a claude.ai or ChatGPT zip) are the next wave; their ids will
 * join this list, and the store already keys every chat by `(source, native)`.
 */
export const CHAT_SOURCE_IDS = ['claude', 'codex', 'opencode', 'claude-cowork', 'zed', 'cline'] as const
export type ChatSourceId = (typeof CHAT_SOURCE_IDS)[number]

export interface ChatSourceInfo {
  id: ChatSourceId
  /** What Settings and the offer call it. */
  label: string
  /** The badge on a search hit. */
  badge: string
  /**
   * Which agent can take a chat of this source back up, or null for none.
   * Whether it CAN by id is `resumeArgs` in codingClis.ts, not this.
   */
  cli: CodingCliId | null
  /** Where it lives, for Settings — the macOS form; main resolves the real root. */
  where: string
  /**
   * Whether detection can count its chats from names alone. The SQLite
   * sources cannot without opening the database, which is reading, so before
   * consent they report a size and no count.
   */
  countable: boolean
}

export const CHAT_SOURCES: readonly ChatSourceInfo[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    badge: 'Claude Code',
    cli: 'claude',
    where: '~/.claude/projects (or CLAUDE_CONFIG_DIR)',
    countable: true
  },
  {
    id: 'codex',
    label: 'Codex',
    badge: 'Codex',
    cli: 'codex',
    where: '~/.codex/sessions (or CODEX_HOME)',
    countable: true
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    badge: 'OpenCode',
    cli: 'opencode',
    where: '~/.local/share/opencode/opencode.db',
    countable: false
  },
  {
    id: 'claude-cowork',
    label: 'Claude desktop (Cowork)',
    badge: 'Cowork',
    cli: null,
    where: 'Claude’s app data, local-agent-mode-sessions',
    countable: true
  },
  {
    id: 'zed',
    label: 'Zed agent threads',
    badge: 'Zed',
    cli: null,
    where: 'Zed’s app data, threads/threads.db',
    countable: false
  },
  {
    id: 'cline',
    label: 'Cline',
    badge: 'Cline',
    cli: 'cline',
    where: '~/.cline/data/sessions',
    countable: true
  }
]

export function isChatSourceId(v: unknown): v is ChatSourceId {
  return typeof v === 'string' && (CHAT_SOURCE_IDS as readonly string[]).includes(v)
}

export function chatSourceInfo(id: ChatSourceId): ChatSourceInfo {
  return CHAT_SOURCES.find((s) => s.id === id) ?? CHAT_SOURCES[0]
}

/* ------------------------------------------------------------------ settings */

/**
 * `unasked` until the offer is answered — every settings file written before
 * this key existed reads as that, which is what shows existing users the offer
 * once. `off` is both "Not now" and a later switch-off; the offer never comes
 * back on its own after either, and Settings › Chat history turns it on.
 */
export type ChatIndexMode = 'unasked' | 'on' | 'off'

export function clampChatIndex(v: unknown): ChatIndexMode {
  return v === 'on' || v === 'off' ? v : 'unasked'
}

/**
 * The caps. Each is a number a person can read in Settings and the one the
 * disclosure names when it binds. Defaults are the research's (2026-09-30, on
 * a heavy user's Mac: 312 MiB of Claude transcripts across 62 chats, 661 MiB of
 * Codex rollouts across 95 threads, text about 1% of the bytes, extraction at
 * 330-530 MiB/s per core, 25 KB of text per chat at p50 and 339 KB at most).
 */
export interface ChatIndexCaps {
  /** Newest chats kept per source. 2,000 is twenty times the biggest source measured. */
  perSource: number
  /** Chats kept in all. At the measured 49 KB mean, ~245 MB of text and a ~560 MB index. */
  total: number
  /** Raw megabytes a pass may read. About 6 s of CPU at the measured rate. */
  passMb: number
  /** Wall time a pass may take; the next pass carries on newest first. */
  passSeconds: number
  /** Text kept per chat, in KB: the first 3/4 and the newest 1/4. Above the measured p99. */
  chatKb: number
  /** Bytes read from one file, in MB: past it, a head and a tail window. The largest file measured was 94 MB. */
  fileMb: number
}

export const CHAT_CAP_DEFAULTS: ChatIndexCaps = {
  perSource: 2000,
  total: 5000,
  passMb: 2048,
  passSeconds: 60,
  chatKb: 512,
  fileMb: 256
}

/** What each cap may be set to. Everything outside is pulled back in, never refused. */
export const CHAT_CAP_LIMITS: Record<keyof ChatIndexCaps, { min: number; max: number }> = {
  perSource: { min: 1, max: 100_000 },
  total: { min: 1, max: 200_000 },
  passMb: { min: 16, max: 64 * 1024 },
  passSeconds: { min: 5, max: 600 },
  chatKb: { min: 16, max: 8 * 1024 },
  fileMb: { min: 1, max: 4 * 1024 }
}

export type ChatPreset = 'light' | 'standard' | 'everything'

/**
 * Three presets. Everything lifts the COUNT caps and keeps the per-pass time
 * and byte caps, so a huge history is read across several passes rather than
 * stalling one.
 */
export const CHAT_PRESETS: Record<ChatPreset, ChatIndexCaps> = {
  light: { ...CHAT_CAP_DEFAULTS, perSource: 500, total: 1500, passMb: 512 },
  standard: { ...CHAT_CAP_DEFAULTS },
  everything: { ...CHAT_CAP_DEFAULTS, perSource: 100_000, total: 200_000 }
}

export function presetOf(caps: ChatIndexCaps): ChatPreset | 'custom' {
  for (const id of ['light', 'standard', 'everything'] as const) {
    const p = CHAT_PRESETS[id]
    if ((Object.keys(p) as (keyof ChatIndexCaps)[]).every((k) => p[k] === caps[k])) return id
  }
  return 'custom'
}

export interface ChatIndexOptions {
  /** Which sources are read. A source switched off is also dropped from the store. */
  sources: Record<ChatSourceId, boolean>
  /**
   * Claude subagent transcripts and Codex's guardian/spawned threads. Off: on
   * the machine measured they were 2,127 files and 2.6 GiB, 89% of Claude's
   * bytes, and nobody goes looking for them.
   */
  subagents: boolean
  /** Replace what looks like an API key or a private key with `[redacted]` before storing. */
  redact: boolean
  caps: ChatIndexCaps
}

export const CHAT_INDEX_DEFAULTS: ChatIndexOptions = {
  sources: { claude: true, codex: true, opencode: true, 'claude-cowork': true, zed: true, cline: true },
  subagents: false,
  redact: true,
  caps: { ...CHAT_CAP_DEFAULTS }
}

function clampInt(v: unknown, fallback: number, lim: { min: number; max: number }): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(lim.max, Math.max(lim.min, Math.round(n)))
}

export function clampChatCaps(v: unknown): ChatIndexCaps {
  const r = v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<Record<keyof ChatIndexCaps, unknown>>) : {}
  const out = {} as ChatIndexCaps
  for (const k of Object.keys(CHAT_CAP_DEFAULTS) as (keyof ChatIndexCaps)[]) {
    out[k] = clampInt(r[k], CHAT_CAP_DEFAULTS[k], CHAT_CAP_LIMITS[k])
  }
  return out
}

/**
 * Rebuilt from named keys, like `clampTerminal`: a field this misses would
 * hydrate as undefined, so the settings change and the clamp land together.
 * A source missing from a stored record takes its default, which is on — a
 * source added by a later build is read by users who already said yes.
 */
export function clampChatIndexOptions(v: unknown): ChatIndexOptions {
  const r = v && typeof v === 'object' && !Array.isArray(v) ? (v as Partial<ChatIndexOptions>) : {}
  const rawSources = r.sources && typeof r.sources === 'object' ? (r.sources as Partial<Record<string, unknown>>) : {}
  const sources = {} as Record<ChatSourceId, boolean>
  for (const id of CHAT_SOURCE_IDS) {
    const s = rawSources[id]
    sources[id] = typeof s === 'boolean' ? s : CHAT_INDEX_DEFAULTS.sources[id]
  }
  return {
    sources,
    // Only the literal turns a privacy-widening switch on.
    subagents: r.subagents === true,
    // Only the literal turns redaction off.
    redact: r.redact !== false,
    caps: clampChatCaps(r.caps)
  }
}

/* -------------------------------------------------------------------- status */

/** Which cap stopped something, so the sentence can say which. */
export type ChatCap = 'perSource' | 'total' | 'bytes' | 'time' | 'discovery' | 'store'

/** What detection says, before anything is read: names, sizes and counts only. */
export interface ChatSourceEstimate {
  id: ChatSourceId
  present: boolean
  /** Chats found by name, or null where only a database size is known. */
  chats: number | null
  /** The count stopped at the discovery cap; the real number is higher. */
  atLeast: boolean
  /** Bytes a first pass would read, as far as names and sizes say. */
  bytes: number
}

export interface ChatDetection {
  sources: ChatSourceEstimate[]
  /** When it was taken, epoch ms. */
  at: number
}

export interface ChatSourceStatus {
  id: ChatSourceId
  /** Chats found at the source by the last pass that listed it, or null before one did. */
  found: number | null
  foundAtLeast: boolean
  /** How many of `found` the index is meant to hold: the newest, under the caps. */
  target: number | null
  /** Chats of this source in the store now. */
  indexed: number
  /** Copies left out because the original is indexed (Cline's imports). */
  duplicates: number
  /** Chats whose text was cut to `chatKb` or read as a head and a tail (`fileMb`). */
  truncated: number
  /** Raw bytes read by the last pass. */
  bytesRead: number
  /** The cap that stopped the last pass for this source, if one did. */
  cappedBy: ChatCap | null
  /** When a pass last finished this source, epoch ms. */
  lastPassMs: number | null
  /** Why the source could not be read, in a sentence; null when it could. */
  error: string | null
}

export interface ChatPassSummary {
  startedMs: number
  ms: number
  bytesRead: number
  filesRead: number
  /** Chats written or brought up to date. */
  chatsUpdated: number
  /** The pass-wide cap that stopped it, or null when it read everything in range. */
  stoppedBy: ChatCap | null
}

export interface ChatIndexStatus {
  /** `off` when the setting is off; `running` while a pass is; `idle` otherwise. */
  state: 'idle' | 'running' | 'off' | 'error'
  /** While running: which source and how far through its range. */
  progress: { source: ChatSourceId; done: number; total: number } | null
  sources: ChatSourceStatus[]
  chats: number
  messages: number
  /** The store's size on disk, database plus its WAL. */
  storeBytes: number
  /** Where the store is, for Settings. */
  storePath: string
  lastPass: ChatPassSummary | null
  /** A store that could not be opened, in a sentence. */
  error: string | null
}

export function emptyChatStatus(storePath: string, state: ChatIndexStatus['state'] = 'idle'): ChatIndexStatus {
  return {
    state,
    progress: null,
    sources: CHAT_SOURCE_IDS.map((id) => ({
      id,
      found: null,
      foundAtLeast: false,
      target: null,
      indexed: 0,
      duplicates: 0,
      truncated: 0,
      bytesRead: 0,
      cappedBy: null,
      lastPassMs: null,
      error: null
    })),
    chats: 0,
    messages: 0,
    storeBytes: 0,
    storePath,
    lastPass: null,
    error: null
  }
}

/* ---------------------------------------------------------------- wording */

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US')
}

/**
 * The one sentence per source Settings shows, and the one that must say a cap
 * out loud whenever one bound: "Indexed the newest 20 of 62 chats", never just
 * "20 chats". A cap nobody is told about is a search that silently misses.
 */
export function sourceDisclosure(s: ChatSourceStatus, caps: ChatIndexCaps): string {
  if (s.error) return s.error
  if (s.found === null) return s.indexed > 0 ? `${formatCount(s.indexed)} chats indexed.` : 'Not read yet.'
  // Copies of other tools' chats are said once, at the end, not counted as missing.
  const own = Math.max(0, s.found - s.duplicates)
  const found = `${formatCount(own)}${s.foundAtLeast ? '+' : ''}`
  if (s.found === 0 && s.indexed === 0) return 'No chats found.'
  const parts: string[] = []
  const shortOfFound = s.indexed < own || s.foundAtLeast
  if (s.cappedBy === 'time' || s.cappedBy === 'bytes') {
    // The range is not read yet: say how far, against what it is aiming for.
    const target = s.target ?? own
    parts.push(
      `Still indexing: ${formatCount(s.indexed)} of ${formatCount(target)} so far${target < own ? ` (the newest ${formatCount(target)} of ${found})` : ''}. Each pass reads up to ${formatCount(caps.passMb)} MB in ${caps.passSeconds} s, newest first; the next carries on.`
    )
  } else if (own === 0 && s.duplicates > 0) {
    parts.push('Nothing of its own to index.')
  } else if (shortOfFound && (s.cappedBy === 'total' || s.cappedBy === 'store')) {
    parts.push(
      s.cappedBy === 'total'
        ? `Indexed ${formatCount(s.indexed)} of ${found} chats: the index is at its ${formatCount(caps.total)}-chat limit, so older ones are left out.`
        : `Indexed ${formatCount(s.indexed)} of ${found} chats: the index reached its 1 GB ceiling, so the oldest were dropped.`
    )
  } else if (shortOfFound && (s.cappedBy === 'perSource' || own > caps.perSource)) {
    parts.push(`Indexed the newest ${formatCount(s.indexed)} of ${found} chats (the limit is ${formatCount(caps.perSource)} per tool).`)
  } else if (s.cappedBy === 'discovery') {
    parts.push(`Indexed ${formatCount(s.indexed)} chats. Stopped counting at ${found} files.`)
  } else if (shortOfFound) {
    parts.push(`Indexed ${formatCount(s.indexed)} of ${found} chats.`)
  } else {
    parts.push(`Indexed all ${formatCount(s.indexed)} chats.`)
  }
  if (s.duplicates > 0) {
    parts.push(
      `${formatCount(s.duplicates)} more ${s.duplicates === 1 ? 'is a copy' : 'are copies'} of chats their own tool still has, so ${s.duplicates === 1 ? 'it is' : 'they are'} searched there, not twice.`
    )
  }
  if (s.truncated > 0) {
    parts.push(`${formatCount(s.truncated)} ${s.truncated === 1 ? 'is' : 'are'} kept in part (over ${formatCount(caps.chatKb)} KB of text, or a file over ${formatCount(caps.fileMb)} MB).`)
  }
  return parts.join(' ')
}

/** The caps in one line, for the offer card and the top of Settings. */
export function capsSentence(caps: ChatIndexCaps): string {
  return `Newest ${formatCount(caps.perSource)} per tool, ${formatCount(caps.total)} in all; each pass reads up to ${formatBytes(caps.passMb * 1024 * 1024)} in ${caps.passSeconds} s, in the background.`
}

/**
 * "Found Claude Code (62), Codex (95) and OpenCode (23 MB)". Sources with
 * nothing found are left out; a database source says its size, since its
 * count cannot be known without opening it.
 */
export function offerFound(d: ChatDetection, enabled?: Record<ChatSourceId, boolean>): { text: string; bytes: number; any: boolean } {
  const items: string[] = []
  let bytes = 0
  for (const e of d.sources) {
    if (!e.present || (enabled && !enabled[e.id])) continue
    if (e.chats === 0 && e.bytes === 0) continue
    const label = chatSourceInfo(e.id).label
    items.push(e.chats === null ? `${label} (${formatBytes(e.bytes)})` : `${label} (${formatCount(e.chats)}${e.atLeast ? '+' : ''})`)
    bytes += e.bytes
  }
  const text = items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
  return { text, bytes, any: items.length > 0 }
}

/* -------------------------------------------------------------------- search */

/** A body hit, one per chat: the best-ranked message's snippet. */
export interface ChatSearchHit {
  chatId: number
  source: ChatSourceId
  /** The source's own id: a Claude session id, a Codex thread id, … */
  nativeId: string
  title: string | null
  firstPrompt: string | null
  cwd: string | null
  updatedMs: number | null
  /** A subagent's transcript (only indexed when asked for): never resumable on its own. */
  subagent: boolean
  /** Who said the matching text. `title` when the title matched. */
  role: 'user' | 'assistant' | 'title'
  snippet: { text: string; ranges: [number, number][] }
}

/*
 * FTS5's `snippet()` marks each hit between two strings of our choosing. Two
 * control characters no chat text can contain once extraction has run
 * (`cleanText` strips C0 controls), so the marks are unambiguous and the
 * renderer gets plain text plus ranges, never HTML.
 */
export const HIT_OPEN = '\u0002'
export const HIT_CLOSE = '\u0003'

/** Marked snippet text -> the text without marks, and where the marks were. */
export function parseMarked(marked: string): { text: string; ranges: [number, number][] } {
  let text = ''
  const ranges: [number, number][] = []
  let open = -1
  for (const ch of marked) {
    if (ch === HIT_OPEN) {
      open = text.length
    } else if (ch === HIT_CLOSE) {
      if (open >= 0 && text.length > open) ranges.push([open, text.length])
      open = -1
    } else {
      text += ch
    }
  }
  return { text, ranges }
}

/**
 * A typed query as an FTS5 query: every word must appear, each as a prefix
 * (`"word"*`), so "stok sess" finds "Stoke sessions". Words are runs of
 * letters and digits in any script; everything else is a separator, and a
 * double quote can never reach FTS5's syntax. Null when nothing is left.
 */
export function ftsQuery(query: string): string | null {
  const words = query.normalize('NFC').match(/[\p{L}\p{N}_]+/gu) ?? []
  const kept = words.filter((w) => w.length > 0).slice(0, 12)
  if (kept.length === 0) return null
  return kept.map((w) => `"${w}"*`).join(' ')
}

/** The least a query must be before the store is asked: one short word matches half the index. */
export const CHAT_SEARCH_MIN_CHARS = 3

/* ------------------------------------------------------------------- opening */

export type ChatOpenAction =
  | { kind: 'claude'; sessionId: string; cwd: string }
  | { kind: 'agent'; cli: CodingCliId; sessionId: string; cwd: string }
  | { kind: 'notice'; message: string }

/**
 * What pressing a hit does. A Claude Code chat resumes through the path every
 * other resume takes (main's `resumeOrMint`, gotcha 81). Another agent's chat
 * reopens in that agent only when it is installed AND can be handed a session
 * id (`resumable`, from codingClis.ts `resumeArgs`); everything else says what
 * it is rather than opening something else. A Cowork chat is Claude Code's
 * format but lives in Claude desktop's own config folder, which `claude
 * --resume` does not read, so it gets the notice too.
 */
export function chatOpenAction(
  hit: Pick<ChatSearchHit, 'source' | 'nativeId' | 'cwd' | 'subagent'>,
  ctx: { installed: ReadonlySet<CodingCliId>; resumable: ReadonlySet<CodingCliId> }
): ChatOpenAction {
  const info = chatSourceInfo(hit.source)
  const viewer = 'A read-only viewer for these is coming; for now search shows where the words are.'
  if (hit.subagent) return { kind: 'notice', message: `This is a subagent’s transcript, which cannot be reopened on its own. ${viewer}` }
  if (!hit.cwd) return { kind: 'notice', message: `This ${info.label} chat has no folder recorded, so it cannot be reopened. ${viewer}` }
  if (hit.source === 'claude') return { kind: 'claude', sessionId: hit.nativeId, cwd: hit.cwd }
  const cli = info.cli
  if (cli && ctx.resumable.has(cli)) {
    if (ctx.installed.has(cli)) return { kind: 'agent', cli, sessionId: hit.nativeId, cwd: hit.cwd }
    return { kind: 'notice', message: `${info.label} isn’t installed, so this chat cannot be reopened in it. ${viewer}` }
  }
  return { kind: 'notice', message: `${info.label} chats cannot be reopened from Stoke. ${viewer}` }
}
