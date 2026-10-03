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
 * Export files (a claude.ai or ChatGPT zip) are NOT in this list: a pass never
 * lists or prunes them. They are `CHAT_IMPORT_KINDS`, keyed in the same store
 * by `(source, native)`.
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

/* ------------------------------------------------------------------ imports */

/**
 * Chats that exist on no disk Stoke can read — claude.ai's and ChatGPT's live
 * on their servers — and reach the index only as an account export the user
 * hands over. Not in `CHAT_SOURCE_IDS`, on purpose: a pass lists, admits and
 * prunes only those, and an imported chat has no file for a pass to find, so a
 * pass must never prune one. It stays until the user removes the import,
 * deletes the index, or a cap below lets it go.
 *
 * Gemini's Takeout ("My Activity › Gemini Apps") and Grok's account export are
 * not here: neither format is documented by its vendor (the Takeout file is an
 * activity log with the reply as HTML, and third-party descriptions of both
 * disagree), so a parser would be a guess that breaks silently.
 */
export const CHAT_IMPORT_KINDS = ['export-claude', 'export-chatgpt'] as const
export type ChatImportKind = (typeof CHAT_IMPORT_KINDS)[number]
/** What a stored chat is: one of the tools a pass reads, or an import. */
export type ChatOrigin = ChatSourceId | ChatImportKind

export const CHAT_IMPORTS: Record<ChatImportKind, { label: string; badge: string; assistant: string; how: string }> = {
  'export-claude': {
    label: 'claude.ai export',
    badge: 'claude.ai',
    assistant: 'Claude',
    how: 'claude.ai › Settings › Privacy › Export data'
  },
  'export-chatgpt': {
    label: 'ChatGPT export',
    badge: 'ChatGPT',
    assistant: 'ChatGPT',
    how: 'ChatGPT › Settings › Data controls › Export data'
  }
}

export function isChatImportKind(v: unknown): v is ChatImportKind {
  return typeof v === 'string' && (CHAT_IMPORT_KINDS as readonly string[]).includes(v)
}

export function isChatOrigin(v: unknown): v is ChatOrigin {
  return isChatSourceId(v) || isChatImportKind(v)
}

/** The name on a hit's badge and the viewer's header. */
export function chatOriginBadge(o: ChatOrigin): string {
  return isChatImportKind(o) ? CHAT_IMPORTS[o].badge : chatSourceInfo(o).badge
}

export function chatOriginLabel(o: ChatOrigin): string {
  return isChatImportKind(o) ? CHAT_IMPORTS[o].label : chatSourceInfo(o).label
}

/** Who the other side of the conversation is, as the viewer labels its turns. */
export function chatAssistantName(o: ChatOrigin): string {
  if (isChatImportKind(o)) return CHAT_IMPORTS[o].assistant
  switch (o) {
    case 'claude':
    case 'claude-cowork':
      return 'Claude'
    case 'zed':
      return 'Zed agent'
    default:
      return chatSourceInfo(o).label
  }
}

/**
 * What an export file may be before Stoke reads a byte of what it holds. Not
 * settings: they guard the reader itself — a zip bomb, a lying header, an
 * archive whose names point outside it — and are the same for everyone.
 *
 * A ChatGPT export can pass 100 MB (research, 2026-09-30) and carries every
 * generated image beside the one file read, so the archive may be large; only
 * `conversations.json` is ever inflated, and it is inflated whole into memory
 * (the worker's heap is bounded; the bytes are a Buffer outside it, and a
 * string past V8's ~512 MB cap could not be parsed at all — the reader splits
 * the array element by element instead of one `JSON.parse`). Deflate tops out
 * near 1032:1; chat JSON measures 5–25:1, so 200:1 on anything past a
 * megabyte is a bomb, not a conversation.
 */
export const CHAT_EXPORT_LIMITS = {
  /** The archive itself. Past this it is not opened. */
  zipBytes: 4 * 1024 * 1024 * 1024,
  /** One member, or a bare `conversations.json`, inflated: and all the members read, together. */
  memberBytes: 1024 * 1024 * 1024,
  /** Entries in the central directory. */
  entries: 100_000,
  /** The central directory's own size. */
  directoryBytes: 64 * 1024 * 1024,
  /** Inflated over compressed, for a member past `ratioFloorBytes`. */
  ratio: 200,
  ratioFloorBytes: 1024 * 1024
} as const

/**
 * One export file handed to the index, and what became of it — every number
 * the disclosure needs. `indexed` is counted from the store at read time, so a
 * later import of the same conversations, a cap or the store's ceiling show up
 * as a shortfall rather than a stale count.
 */
export interface ChatImportRecord {
  id: number
  kind: ChatImportKind
  fileName: string
  bytes: number
  importedMs: number
  /** Distinct conversations the file held. */
  found: number
  /**
   * The newest of those that the caps let in. Every one is written unless the
   * import was stopped part-way: then `added + updated + empty` falls short of it.
   */
  admitted: number
  /** New to the index. */
  added: number
  /** Already in it from an earlier import, brought up to date in place (keyed by the conversation's own id). */
  updated: number
  /** Taken, but holding no text to search, so not stored. */
  empty: number
  /** Stored in part: over the per-chat text cap. */
  truncated: number
  /** The cap that left conversations out, if one did. */
  cappedBy: 'perSource' | 'total' | null
  /** In the index now, from this file. */
  indexed: number
}

/** `warning`: it worked, with something worth saying (a file that ends early). */
export type ChatImportResult = { ok: true; record: ChatImportRecord; warning: string | null } | { ok: false; error: string }

/**
 * The sentence Settings shows under an import — the per-import twin of
 * `sourceDisclosure`, with the same rule: a cap that bound is said, with its
 * number.
 */
export function importDisclosure(r: ChatImportRecord, caps: ChatIndexCaps): string {
  const parts: string[] = []
  if (r.found === 0) return 'The file held no conversations.'
  /*
   * The record is written before the first conversation and finished after the
   * last (`finishImport`), and the caps are never below 1, so a file with
   * conversations and none admitted is an import still running — or one whose
   * worker was killed before it could finish. Either way, not "all of them".
   */
  if (r.admitted === 0) {
    return `This import has not finished: ${formatCount(r.indexed)} of the file’s ${formatCount(r.found)} conversations are in the index.`
  }
  const done = r.added + r.updated + r.empty
  if (done < r.admitted) {
    // Stopped part-way — Delete index, switching chat history off, or quitting while it ran.
    const range = r.admitted < r.found ? `the newest ${formatCount(r.admitted)} of ${formatCount(r.found)}` : formatCount(r.admitted)
    const limit =
      r.admitted < r.found && r.cappedBy === 'perSource'
        ? ` (the limit is ${formatCount(caps.perSource)} per tool)`
        : r.admitted < r.found && r.cappedBy === 'total'
          ? ` (the index holds at most ${formatCount(caps.total)} chats)`
          : ''
    parts.push(
      `The import was stopped after ${formatCount(done)} of ${range} conversations${limit}. Import the file again to finish: the ones already here are updated in place, not copied.`
    )
  } else if (r.admitted < r.found && r.cappedBy === 'perSource') {
    parts.push(`Imported the newest ${formatCount(r.admitted)} of ${formatCount(r.found)} conversations (the limit is ${formatCount(caps.perSource)} per tool).`)
  } else if (r.admitted < r.found && r.cappedBy === 'total') {
    parts.push(`Imported the newest ${formatCount(r.admitted)} of ${formatCount(r.found)} conversations: the index holds at most ${formatCount(caps.total)} chats.`)
  } else {
    parts.push(`Imported ${r.found === 1 ? 'the one conversation' : `all ${formatCount(r.found)} conversations`}.`)
  }
  if (r.updated > 0) {
    parts.push(`${formatCount(r.updated)} ${r.updated === 1 ? 'was' : 'were'} already here from an earlier import and ${r.updated === 1 ? 'was' : 'were'} updated in place.`)
  }
  if (r.empty > 0) parts.push(`${formatCount(r.empty)} held no text and ${r.empty === 1 ? 'was' : 'were'} left out.`)
  if (r.truncated > 0) parts.push(`${formatCount(r.truncated)} ${r.truncated === 1 ? 'is' : 'are'} kept in part (over ${formatCount(caps.chatKb)} KB of text).`)
  const stored = r.added + r.updated
  if (r.indexed < stored) {
    const gone = stored - r.indexed
    parts.push(
      `${formatCount(gone)} ${gone === 1 ? 'has' : 'have'} since left the index — a newer import of the same conversations, the per-tool or total limit, or the index’s size ceiling.`
    )
  }
  return parts.join(' ')
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

/**
 * The store's own ceiling past every cap above, as chat TEXT — the eviction
 * measure (`evictToText` and `STORE_MAX_TEXT_BYTES` in main say why text, and
 * how it maps to about 1 GB on disk). Here so the disclosure names the same
 * number the pass enforces.
 */
export const CHAT_STORE_MAX_TEXT_MB = 512

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
  /**
   * Replace what looks like a credential (parse.ts `SECRET_RULES`: keys, tokens, keyed passwords,
   * credential URLs, private keys) with `[redacted]` before storing. Turned back on, a pass cleans
   * what was stored without it first. What leaves this computer is cleaned whatever this says.
   */
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
  /** Export files imported, newest first — each with what it left in the index. */
  imports: ChatImportRecord[]
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
    imports: [],
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
        : `Indexed ${formatCount(s.indexed)} of ${found} chats: the index reached its size ceiling (${formatCount(CHAT_STORE_MAX_TEXT_MB)} MB of chat text, about 1 GB on disk), so the oldest were dropped.`
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
  /** A tool a pass reads, or an import (`export-claude`, `export-chatgpt`). */
  source: ChatOrigin
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

/*
 * Invisible format characters a copy from a web page, a PDF or a chat app
 * leaves inside a word: a zero-width space, a soft hyphen, a word joiner, a
 * byte order mark. Drawn as nothing, they still make two words of one for
 * every secret pattern, so a key with one in it reached another computer
 * whole on its screen (review of 166e84f). Text is judged and stored without
 * them (`cleanText`) and shaped without them for another computer
 * (`chatText`).
 *
 * The set is Unicode's whole Default_Ignorable_Code_Point property (review of
 * 10b0840: listing nine of them by hand left a Hangul filler, a Mongolian
 * selector, a tag character and the rest splitting a key). Those that join
 * nothing in any script go wherever they are (`INVISIBLE`). The rest go only
 * BETWEEN two printable ASCII characters, where they join nothing either: the
 * joiners (ZWNJ, ZWJ), the direction marks and isolates, the combining
 * grapheme joiner, the variation selectors, the Hangul fillers and the tag
 * characters — so an emoji sequence (woman, ZWJ, laptop), a flag's tags,
 * Persian's ZWNJ, an Indic conjunct, an ideographic variation and
 * right-to-left text keep theirs.
 */
const INVISIBLE = /[\u00ad\u180e\u200b\u2060-\u2064\u206a-\u206f\ufeff\ufff0-\ufff8]/g
const INVISIBLE_IN_ASCII = /(?<=[!-~])\p{Default_Ignorable_Code_Point}+(?=[!-~])/gu

/** `s` without the invisible characters that split a word for a pattern but not for a reader. */
export function dropInvisible(s: string): string {
  return s.replace(INVISIBLE, '').replace(INVISIBLE_IN_ASCII, '')
}

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

/*
 * One "word" as FTS5's unicode61 tokenizer sees it: a run of letters, marks and
 * digits. `_` is a separator there, so it is one here — a highlight that
 * disagreed with the match would mark words the search never found.
 */
const WORD = /[\p{L}\p{M}\p{N}]+/gu

function foldWord(w: string): string {
  return w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

/**
 * Where a typed query's words occur in `text`, for the viewer's highlight: every
 * word of the text that STARTS with one of the query's words, compared without
 * case or accents — the rule `ftsQuery` gives the search (`"word"*`, unicode61
 * with `remove_diacritics 2`), so what is marked is what matched. Ranges are
 * UTF-16 offsets into `text` itself, sorted and apart, ready for `Highlight`.
 */
export function highlightRanges(text: string, query: string): [number, number][] {
  const words = [...new Set((query.normalize('NFC').match(WORD) ?? []).map(foldWord).filter((w) => w.length > 0))].slice(0, 12)
  if (words.length === 0 || !text) return []
  const out: [number, number][] = []
  for (const m of text.matchAll(WORD)) {
    const at = m.index ?? 0
    const folded = foldWord(m[0])
    if (words.some((w) => folded.startsWith(w))) out.push([at, at + m[0].length])
  }
  return out
}

/* ------------------------------------------------------------------- opening */

export type ChatOpenAction =
  | { kind: 'claude'; sessionId: string; cwd: string }
  | { kind: 'agent'; cli: CodingCliId; sessionId: string; cwd: string }
  /** The read-only viewer, with the reason it is not a live session (null for an import, which never is). */
  | { kind: 'view'; chatId: number; note: string | null }

/**
 * What pressing a hit does. A Claude Code chat resumes through the path every
 * other resume takes (main's `resumeOrMint`, gotcha 81). Another agent's chat
 * reopens in that agent only when it is installed AND can be handed a session
 * id (`resumable`, from codingClis.ts `resumeArgs`). Everything else opens in
 * the read-only viewer, which says why it is not a live session rather than
 * opening something the user did not pick. A Cowork chat is Claude Code's
 * format but lives in Claude desktop's own config folder, which `claude
 * --resume` does not read, so it is viewed too — as is every import, which
 * has no session anywhere to resume.
 */
export function chatOpenAction(
  hit: Pick<ChatSearchHit, 'chatId' | 'source' | 'nativeId' | 'cwd' | 'subagent'>,
  ctx: { installed: ReadonlySet<CodingCliId>; resumable: ReadonlySet<CodingCliId> }
): ChatOpenAction {
  const view = (note: string | null): ChatOpenAction => ({ kind: 'view', chatId: hit.chatId, note })
  if (isChatImportKind(hit.source)) return view(null)
  const info = chatSourceInfo(hit.source)
  if (hit.subagent) return view('A subagent’s transcript, which cannot be reopened on its own. This is its text, read from the file now.')
  if (!hit.cwd) return view(`This ${info.label} chat has no folder recorded, so it cannot be reopened. This is its text, read from ${info.label}’s own copy now.`)
  if (hit.source === 'claude') return { kind: 'claude', sessionId: hit.nativeId, cwd: hit.cwd }
  const cli = info.cli
  if (cli && ctx.resumable.has(cli)) {
    if (ctx.installed.has(cli)) return { kind: 'agent', cli, sessionId: hit.nativeId, cwd: hit.cwd }
    return view(`${info.label} isn’t installed, so this chat cannot be reopened in it. This is its text, read from ${info.label}’s own copy now.`)
  }
  return view(`${info.label} chats cannot be reopened from Stoke. This is its text, read from ${info.label}’s own copy now.`)
}

/* -------------------------------------------------------------------- viewer */

export interface ChatTranscriptMessage {
  role: 'user' | 'assistant'
  text: string
  atMs: number | null
}

/** One chat as the viewer shows it: in order, who said it, when. */
export interface ChatTranscript {
  chatId: number
  source: ChatOrigin
  title: string | null
  cwd: string | null
  createdMs: number | null
  updatedMs: number | null
  messages: ChatTranscriptMessage[]
  /**
   * `source`: re-read from the tool's own file or database just now, read-only.
   * `store`: the index's copy — always for an import, and for a local chat
   * whose original is gone or could not be read (`fallback` says which).
   */
  from: 'source' | 'store'
  fallback: string | null
  /** Some of it is not shown: the middle of a very long chat, or a file past the read cap. */
  partial: boolean
}

/**
 * What the viewer shows of one chat at most: its opening and its newest
 * messages, the middle left out and said so (`planTrim`'s split). Well past the
 * index's per-chat cap — the viewer reads the source afresh and can show more —
 * but bounded, because every message is a DOM node.
 */
export const CHAT_VIEW_MAX_BYTES = 4 * 1024 * 1024
