/**
 * What each chat source's records say, as plain text: user and assistant words
 * only. Pure functions over one record, one JSON document or one row — no file
 * is opened here, so `verify:chat-sources` holds every rule against synthetic
 * fixtures, and `sources.ts` is only the part that reads.
 *
 * The rule for all of them is the one `readTranscript` already applies to
 * Claude Code: index what a person reads. Tool calls and their output,
 * reasoning, images and base64, system and developer turns, and context the
 * tool injected on the user's behalf are all left out. Measured on the machine
 * this was written on, that is about 1% of the bytes (Claude 4.04 MiB of 312
 * MiB, Codex 3.64 of 661) and it is the part people remember.
 *
 * Claude's text rules are `sessionFile.ts`'s own (`textOf`, `isUsefulPrompt`,
 * `titleOf`), imported rather than copied, so a search hit and the session
 * row it lands on follow one rule.
 */
import { isUsefulPrompt, safeParse, textOf, titleOf } from '../sessionFile.ts'
import { HIT_CLOSE, HIT_OPEN, type ChatSourceId } from '../../shared/chatIndex.ts'

export interface ChatMessage {
  role: 'user' | 'assistant'
  text: string
  atMs: number | null
}

export interface ChatMeta {
  title: string | null
  firstPrompt: string | null
  cwd: string | null
  gitBranch: string | null
  model: string | null
  createdMs: number | null
  updatedMs: number | null
}

export function emptyMeta(): ChatMeta {
  return { title: null, firstPrompt: null, cwd: null, gitBranch: null, model: null, createdMs: null, updatedMs: null }
}

/** What folding a run of records produced: messages in order, and what they said about the chat. */
export interface Fold {
  messages: ChatMessage[]
  meta: ChatMeta
  /** A record said this chat is a subagent's, not the user's own thread. */
  subagent: boolean
}

export function emptyFold(): Fold {
  return { messages: [], meta: emptyMeta(), subagent: false }
}

/* -------------------------------------------------------------- the text */

/** One message's text past this is cut: a pasted log is not what anyone searches for twice. */
export const MESSAGE_MAX_BYTES = 64 * 1024

/*
 * A run of 200+ characters with no space from the base64 alphabet: an image, a
 * PDF, a key file. Only the run goes, so the sentence around a pasted blob
 * stays searchable. A `data:…;base64,` URL goes whole whatever its length.
 */
const BASE64_RUN = /[A-Za-z0-9+/=_-]{200,}/g
const DATA_URL = /data:[\w.+-]+\/[\w.+-]+;base64,[A-Za-z0-9+/=]+/g

/*
 * What looks like a credential. Replaced before the text is stored, when
 * `redact` is on (the default): the index is one plaintext file holding every
 * tool's chats, and a key pasted into a chat months ago should not be one
 * search away from anyone who can read it.
 */
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/g,
  /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g
]

export function redactSecrets(text: string): string {
  let out = text
  for (const re of SECRETS) out = out.replace(re, '[redacted]')
  return out
}

/*
 * C0 controls other than tab and newline, DEL, and the C1 range. Two of them
 * are the snippet marks (`HIT_OPEN`/`HIT_CLOSE`), which must never occur in
 * stored text or a snippet could not be told from a hit.
 */
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g

/**
 * Text as it is stored: controls gone, blobs gone, credentials gone (when
 * asked), blank-line runs squeezed, cut at `maxBytes` on a character boundary.
 * Empty when nothing searchable is left.
 */
export function cleanText(raw: string, opts: { redact: boolean; maxBytes?: number }): string {
  let t = raw.replace(CONTROLS, '')
  if (t.includes(HIT_OPEN) || t.includes(HIT_CLOSE)) t = t.split(HIT_OPEN).join('').split(HIT_CLOSE).join('')
  t = t.replace(DATA_URL, '[data]').replace(BASE64_RUN, (run) => (looksLikeBlob(run) ? '[data]' : run))
  if (opts.redact) t = redactSecrets(t)
  t = t.replace(/\n{3,}/g, '\n\n').trim()
  const max = opts.maxBytes ?? MESSAGE_MAX_BYTES
  if (Buffer.byteLength(t, 'utf8') > max) t = cutBytes(t, max) + ' …'
  return t
}

/*
 * A long run is a blob only if it mixes cases and digits the way base64 does.
 * A 200-character identifier of one case (a hash, a long snake_case name) is
 * something a person might search for and is kept.
 */
function looksLikeBlob(run: string): boolean {
  const upper = /[A-Z]/.test(run)
  const lower = /[a-z]/.test(run)
  const digit = /[0-9]/.test(run)
  return (upper && lower && digit) || run.length >= 1000
}

/** The longest prefix of `s` that fits in `max` UTF-8 bytes, never splitting a character. */
export function cutBytes(s: string, max: number): string {
  const buf = Buffer.from(s, 'utf8')
  if (buf.length <= max) return s
  let end = max
  // Back off continuation bytes (10xxxxxx) so the cut lands on a lead byte.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--
  return buf.subarray(0, end).toString('utf8')
}

/** An epoch (seconds or ms) or an ISO string, as ms; null when it is neither. */
export function stamp(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000
  if (typeof v === 'string') {
    const n = Date.parse(v)
    return Number.isNaN(n) ? null : n
  }
  return null
}

/** Widen a chat's first and last stamps to take in `at`. */
export function note(meta: ChatMeta, at: number | null): void {
  if (at === null) return
  if (meta.createdMs === null || at < meta.createdMs) meta.createdMs = at
  if (meta.updatedMs === null || at > meta.updatedMs) meta.updatedMs = at
}

export function firstPromptOf(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** One message, cleaned (`cleanText`); nothing when no text is left. The first user message is the first prompt. */
export function push(fold: Fold, role: 'user' | 'assistant', raw: string, at: number | null, redact: boolean): void {
  const text = cleanText(raw, { redact })
  if (!text) return
  fold.messages.push({ role, text, atMs: at })
  if (role === 'user' && fold.meta.firstPrompt === null) fold.meta.firstPrompt = firstPromptOf(text)
}

/* ---------------------------------------------------------- Claude Code */

/*
 * The cheap test in front of JSON.parse, the same trick `scanText` uses: a
 * record worth parsing must contain one of these. Measured: 33,750 of 69,896
 * Claude lines parsed.
 */
export function claudeLineWorthParsing(line: string): boolean {
  return line.includes('"type":"user"') || line.includes('"type":"assistant"') || line.includes('ai-title')
}

/**
 * Fold one Claude Code transcript line (Cowork's are the same format).
 *
 * Skipped, as `readTranscript` skips them: sidechain records (a subagent's,
 * not the user's thread), meta records (Stoke and the CLI talking), a user
 * record carrying a tool_result (a tool's output fed back), local-command
 * noise, and the CLI's "[Request interrupted" notes. From an assistant record
 * only its `text` blocks: thinking and tool_use are not conversation.
 *
 * `subagentFile` is for a transcript under `<session>/subagents/`, listed
 * only while "Include subagent chats" is on. EVERY record in one of those is
 * `isSidechain: true` — measured on the machine this was fixed on, 7,378 of
 * 7,378 user and assistant records across 52 files — because the whole file
 * is the subagent's thread. Skipping sidechains there indexed nothing at all:
 * every subagent transcript became an empty chat row that still took a slot
 * under the caps. In a subagent's own file the sidechain IS the conversation.
 *
 * The folder is the FIRST cwd a user record carries — where the session was
 * started, the folder its transcript is filed under, and what `projects.ts`'s
 * `cwdFromTranscript` and the session list use. A `cd` during the session
 * moves later records' cwd; resuming from there is not the same session's
 * folder (the CLI refuses a conversation "from a different directory").
 */
export function foldClaudeLine(fold: Fold, line: string, redact: boolean, subagentFile = false): void {
  if (!claudeLineWorthParsing(line)) return
  const rec = safeParse(line)
  if (!rec) return
  if (rec.type === 'ai-title') {
    const t = titleOf(rec)
    if (t) fold.meta.title = cleanText(t, { redact, maxBytes: 1024 })
    return
  }
  if (rec.type !== 'user' && rec.type !== 'assistant') return
  if ((rec.isSidechain === true && !subagentFile) || rec.isMeta === true) return
  const at = stamp(rec.timestamp)
  note(fold.meta, at)
  const msg = rec.message as { content?: unknown; model?: unknown } | undefined
  const content = msg?.content
  if (rec.type === 'user') {
    if (typeof rec.cwd === 'string' && rec.cwd && fold.meta.cwd === null) fold.meta.cwd = rec.cwd
    if (typeof rec.gitBranch === 'string' && rec.gitBranch) fold.meta.gitBranch = rec.gitBranch
    if (Array.isArray(content) && content.some((b) => b && typeof b === 'object' && (b as { type?: unknown }).type === 'tool_result')) return
    const text = textOf(content)?.trim() ?? ''
    if (!text || !isUsefulPrompt(text) || text.startsWith('[Request interrupted')) return
    push(fold, 'user', text, at, redact)
    return
  }
  if (typeof msg?.model === 'string' && msg.model && msg.model !== '<synthetic>') fold.meta.model = msg.model
  const text = textOf(content)?.trim() ?? ''
  if (text) push(fold, 'assistant', text, at, redact)
}

/* ------------------------------------------------------------------ Codex */

export function codexLineWorthParsing(line: string): boolean {
  return line.includes('"type":"message"') || line.includes('"session_meta"') || line.includes('"turn_context"')
}

/*
 * A block Codex put in the user's turn on their behalf: `<environment_context>`,
 * `<user_instructions>`, `<recommended_plugins>` and the like — one element
 * from start to end — or the AGENTS.md preamble. Measured on this machine's
 * rollouts, every non-plain user block had that shape.
 */
const WRAPPED_BLOCK = /^<([A-Za-z_][\w-]*)(?:\s[^>]*)?>[\s\S]*<\/\1>$/

export function isInjectedBlock(text: string): boolean {
  const t = text.trim()
  return WRAPPED_BLOCK.test(t) || t.startsWith('# AGENTS.md') || t.startsWith('<environment_context>')
}

/**
 * Fold one Codex rollout line. User and assistant `message` items only — the
 * `event_msg` copies of the same turns are skipped so nothing is indexed
 * twice — and `developer` turns never. `session_meta` gives the folder, the
 * start time, and whether the thread is a subagent's (`source.subagent`).
 * The folder is the first one seen, as for Claude: a later `turn_context`
 * that moved does not move where the thread started.
 */
export function foldCodexLine(fold: Fold, line: string, redact: boolean): void {
  if (!codexLineWorthParsing(line)) return
  const rec = safeParse(line)
  if (!rec) return
  const p = (rec.payload ?? {}) as Record<string, unknown>
  const at = stamp(rec.timestamp)
  if (rec.type === 'session_meta') {
    if (typeof p.cwd === 'string' && p.cwd && fold.meta.cwd === null) fold.meta.cwd = p.cwd
    const started = stamp(p.timestamp)
    if (started !== null) note(fold.meta, started)
    const src = p.source
    if (src && typeof src === 'object' && 'subagent' in (src as object)) fold.subagent = true
    return
  }
  if (rec.type === 'turn_context') {
    if (typeof p.model === 'string' && p.model) fold.meta.model = p.model
    if (typeof p.cwd === 'string' && p.cwd && fold.meta.cwd === null) fold.meta.cwd = p.cwd
    return
  }
  if (rec.type !== 'response_item' || p.type !== 'message') return
  if (p.role !== 'user' && p.role !== 'assistant') return
  const blocks = Array.isArray(p.content) ? (p.content as Record<string, unknown>[]) : []
  const parts: string[] = []
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue
    if (b.type !== 'input_text' && b.type !== 'output_text' && b.type !== 'text') continue
    const t = typeof b.text === 'string' ? b.text : ''
    if (!t.trim()) continue
    if (p.role === 'user' && isInjectedBlock(t)) continue
    parts.push(t)
  }
  if (parts.length === 0) return
  note(fold.meta, at)
  push(fold, p.role, parts.join('\n'), at, redact)
}

/* --------------------------------------------------------------- OpenCode */

/**
 * One OpenCode `part.data` document: its text when it is a `text` part the
 * user or the model wrote. `synthetic` parts are OpenCode's own injections.
 */
export function opencodePartText(data: string): string | null {
  let p: unknown
  try {
    p = JSON.parse(data)
  } catch {
    return null
  }
  if (!p || typeof p !== 'object') return null
  const r = p as { type?: unknown; text?: unknown; synthetic?: unknown }
  if (r.type !== 'text' || r.synthetic === true || typeof r.text !== 'string') return null
  return r.text
}

/** OpenCode rows (one per text part, in order) folded into messages, one per message id. */
export function foldOpencodeRows(
  rows: readonly { messageId: string; role: unknown; timeCreated: unknown; data: string }[],
  redact: boolean
): Fold {
  const fold = emptyFold()
  let current: { id: string; role: 'user' | 'assistant'; at: number | null; parts: string[] } | null = null
  const flush = (): void => {
    if (current && current.parts.length) push(fold, current.role, current.parts.join('\n'), current.at, redact)
  }
  for (const r of rows) {
    if (r.role !== 'user' && r.role !== 'assistant') continue
    const text = opencodePartText(r.data)
    if (!text || !text.trim()) continue
    if (!current || current.id !== r.messageId) {
      flush()
      current = { id: r.messageId, role: r.role, at: stamp(r.timeCreated), parts: [] }
      note(fold.meta, current.at)
    }
    current.parts.push(text)
  }
  flush()
  return fold
}

/* ------------------------------------------------------------------ Cline */

/** Cline's names for the tools it imports from, as this index names them. */
const CLINE_ORIGINS: Record<string, ChatSourceId> = {
  codex: 'codex',
  'claude-code': 'claude',
  claude: 'claude',
  opencode: 'opencode'
}

export interface ClineMeta {
  title: string | null
  cwd: string | null
  createdMs: number | null
  updatedMs: number | null
  gitBranch: string | null
  model: string | null
  /** `codex:<id>` when this session is Cline's imported copy of another tool's chat. */
  dedupeKey: string | null
}

/**
 * A Cline session's `<id>.json`. Only named fields are read. `importedFrom`
 * says which tool's chat this is a copy of (`tool`, `sourceSessionId`), which
 * is how the copy is folded into its original rather than listed twice.
 */
export function clineMeta(doc: unknown): ClineMeta {
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
  const md = d.metadata && typeof d.metadata === 'object' ? (d.metadata as Record<string, unknown>) : {}
  const imp = md.importedFrom && typeof md.importedFrom === 'object' ? (md.importedFrom as Record<string, unknown>) : null
  const git = md.git && typeof md.git === 'object' ? (md.git as Record<string, unknown>) : {}
  const origin = imp && typeof imp.tool === 'string' ? CLINE_ORIGINS[imp.tool] : undefined
  const originId = imp && typeof imp.sourceSessionId === 'string' ? imp.sourceSessionId : ''
  const title = typeof md.title === 'string' && md.title.trim() ? md.title.trim() : typeof d.prompt === 'string' && d.prompt.trim() ? firstPromptOf(d.prompt) : null
  return {
    title,
    cwd: typeof d.cwd === 'string' && d.cwd ? d.cwd : typeof d.workspace_root === 'string' && d.workspace_root ? d.workspace_root : null,
    createdMs: stamp(d.started_at),
    updatedMs: stamp(d.ended_at) ?? stamp(d.started_at),
    gitBranch: typeof git.branch === 'string' ? git.branch : null,
    model: typeof d.model === 'string' ? d.model : null,
    dedupeKey: origin && originId ? `${origin}:${originId}` : null
  }
}

/** Cline wraps what it tells the model about the workspace in these; they are not the user's words. */
const CLINE_INJECTED = /<environment_details>[\s\S]*?<\/environment_details>/g

/** A Cline `<id>.messages.json`: `{ messages: [{ role, content: [blocks], ts }] }`. Text blocks only. */
export function foldClineMessages(doc: unknown, redact: boolean): Fold {
  const fold = emptyFold()
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
  const list = Array.isArray(doc) ? doc : Array.isArray(d.messages) ? d.messages : []
  for (const m of list as Record<string, unknown>[]) {
    if (!m || typeof m !== 'object') continue
    if (m.role !== 'user' && m.role !== 'assistant') continue
    const content = m.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    const parts: string[] = []
    for (const b of blocks as Record<string, unknown>[]) {
      if (!b || typeof b !== 'object' || b.type !== 'text' || typeof b.text !== 'string') continue
      const t = b.text.replace(CLINE_INJECTED, '').trim()
      if (!t || (m.role === 'user' && isInjectedBlock(t))) continue
      parts.push(t)
    }
    if (!parts.length) continue
    const at = stamp(m.ts)
    note(fold.meta, at)
    push(fold, m.role, parts.join('\n'), at, redact)
  }
  return fold
}

/* -------------------------------------------------------------------- Zed */

/**
 * A Zed agent thread, zstd-decompressed JSON: `messages` of `{User: {content}}`
 * or `{Agent: {content}}`, whose content blocks are `{Text}`, `{Thinking}`,
 * `{ToolUse}`, `{Mention}`… — only `Text` is words.
 */
export function foldZedThread(doc: unknown, redact: boolean): Fold {
  const fold = emptyFold()
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
  if (typeof d.title === 'string' && d.title.trim()) fold.meta.title = cleanText(d.title, { redact, maxBytes: 1024 })
  const model = d.model && typeof d.model === 'object' ? (d.model as Record<string, unknown>).model : null
  if (typeof model === 'string') fold.meta.model = model
  if (d.subagent_context && typeof d.subagent_context === 'object') fold.subagent = true
  const updated = stamp(d.updated_at)
  note(fold.meta, updated)
  for (const m of Array.isArray(d.messages) ? (d.messages as Record<string, unknown>[]) : []) {
    if (!m || typeof m !== 'object') continue
    const role = 'User' in m ? 'user' : 'Agent' in m ? 'assistant' : null
    if (!role) continue
    const body = (m.User ?? m.Agent) as { content?: unknown } | undefined
    const blocks = Array.isArray(body?.content) ? (body.content as Record<string, unknown>[]) : []
    const parts: string[] = []
    for (const b of blocks) {
      if (b && typeof b === 'object' && typeof b.Text === 'string' && b.Text.trim()) parts.push(b.Text)
    }
    if (parts.length) push(fold, role, parts.join('\n'), updated, redact)
  }
  return fold
}

/** Zed's `folder_paths` column: one path per line, or a JSON array. The first. */
export function zedFolder(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const t = raw.trim()
  if (t.startsWith('[')) {
    try {
      const a = JSON.parse(t) as unknown
      return Array.isArray(a) && typeof a[0] === 'string' ? a[0] : null
    } catch {
      return null
    }
  }
  return t.split(/\r?\n/)[0] || null
}

/* ----------------------------------------------------------------- Cowork */

/**
 * A Cowork session's `local_<id>.json`, whitelisted. The same file carries the
 * account's name and email address; those are never read into the index —
 * which is why this names what it takes instead of spreading the document.
 */
export function coworkMeta(doc: unknown): { title: string | null; cwd: string | null; createdMs: number | null; updatedMs: number | null; archived: boolean } {
  const d = doc && typeof doc === 'object' ? (doc as Record<string, unknown>) : {}
  return {
    title: typeof d.title === 'string' && d.title.trim() ? d.title.trim() : null,
    cwd: typeof d.cwd === 'string' && d.cwd ? d.cwd : null,
    createdMs: stamp(d.createdAt),
    updatedMs: stamp(d.lastActivityAt),
    archived: d.isArchived === true
  }
}

/* ----------------------------------------------------------------- trims */

/**
 * Which messages to drop so a chat's text fits `capBytes`: keep the first
 * three quarters of the budget from the start of the chat and the rest from
 * its end, and drop the middle. `sizes` is each message's byte size in order;
 * the answer is indices into it. Empty when it already fits.
 */
export function planTrim(sizes: readonly number[], capBytes: number): number[] {
  const total = sizes.reduce((a, b) => a + b, 0)
  if (total <= capBytes) return []
  const headBudget = Math.floor(capBytes * 0.75)
  let head = 0
  let i = 0
  while (i < sizes.length && head + sizes[i] <= headBudget) head += sizes[i++]
  let tail = 0
  let j = sizes.length - 1
  while (j >= i && head + tail + sizes[j] <= capBytes) tail += sizes[j--]
  const drop: number[] = []
  for (let k = i; k <= j; k++) drop.push(k)
  return drop
}
