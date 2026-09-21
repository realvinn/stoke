import { open, readFile, stat, type FileHandle } from 'node:fs/promises'
import type { PermissionMode } from '@shared/types'
import { interruptionNote, toolOutcome, type ToolOutcome } from '../shared/phoneUi.ts'

/**
 * Helpers for reading Claude Code's session transcripts
 * (`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`).
 *
 * Each line is a standalone JSON object with a `type` discriminator. Observed
 * types: mode, permission-mode, file-history-snapshot, user, assistant,
 * attachment, last-prompt, ai-title, system.
 */

/**
 * Above this size `parseSession` stops reading whole files and samples head +
 * tail instead. It is a guard against pathological files only, and it costs an
 * accurate message count when it kicks in.
 *
 * Parsing measures 2.2-3.2 ms/MB on an Apple M1, which is NOT imperceptible
 * when it is one synchronous block: a 22 MB transcript held the main process
 * for 40-70 ms, and no pty byte reached a terminal meanwhile (gotcha 103). So
 * the whole-file read is streamed now (`foldFrom`), and the live context watcher
 * does not use this limit at all — it reads every byte once and then only what
 * is appended (`advanceCursor`), so a big transcript's message count stays exact.
 */
const FULL_READ_LIMIT = 32 * 1024 * 1024
/**
 * Bytes per read of a streamed pass. Each chunk is one read completion, so the
 * event loop runs between chunks, and its complete lines cost ~3 ms to fold.
 */
export const STREAM_CHUNK = 1024 * 1024
/**
 * How much of a transcript either end of `readLines` takes.
 *
 * Exported because `projects.ts` needs exactly this read — the first record of
 * a transcript, to recover a project's real cwd — and used to do it with
 * `readFile`, which reads all of a file that can be hundreds of megabytes. One
 * bounded reader, used by both callers, rather than two notions of "the head".
 */
export const CHUNK = 256 * 1024

export interface ParsedSession {
  /** Claude Code's own generated title, if it has produced one yet. */
  title: string | null
  firstPrompt: string | null
  gitBranch: string | null
  cwd: string | null
  model: string | null
  /** Newest `permission-mode` record in the transcript, or null when none. */
  permissionMode: PermissionMode | null
  messageCount: number
  /** False when the file was sampled rather than read in full. */
  exactCount: boolean
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
}

export function safeParse(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t || t[0] !== '{') return null
  try {
    return JSON.parse(t) as Record<string, unknown>
  } catch {
    return null
  }
}

export async function readRange(file: string, start: number, length: number): Promise<string> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(length)
    const { bytesRead } = await fh.read(buf, 0, length, start)
    return buf.subarray(0, bytesRead).toString('utf8')
  } finally {
    await fh.close()
  }
}

/** Read the file whole when it is small enough, otherwise head + tail. */
async function readLines(file: string): Promise<{ lines: string[]; exact: boolean }> {
  const st = await stat(file)
  if (st.size <= FULL_READ_LIMIT) {
    const text = await readFile(file, 'utf8')
    return { lines: text.split('\n'), exact: true }
  }
  const head = await readRange(file, 0, CHUNK)
  const tail = await readRange(file, Math.max(0, st.size - CHUNK), CHUNK)
  // Drop the first/last fragments — they are almost certainly partial lines.
  const headLines = head.split('\n').slice(0, -1)
  const tailLines = tail.split('\n').slice(1)
  return { lines: [...headLines, ...tailLines], exact: false }
}

export function textOf(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts: string[] = []
    for (const block of content) {
      if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
        const t = (block as { text?: unknown }).text
        if (typeof t === 'string') parts.push(t)
      }
    }
    return parts.join('\n') || null
  }
  return null
}

/** Local-command noise and system reminders make useless session titles. */
export function isUsefulPrompt(s: string): boolean {
  const t = s.trim()
  if (!t) return false
  if (t.startsWith('<command-name>')) return false
  // A slash command can lead with either tag depending on how it was invoked,
  // and the message form was leaking through as a session title.
  if (t.startsWith('<command-message>')) return false
  if (t.startsWith('<command-args>')) return false
  if (t.startsWith('<local-command')) return false
  if (t.startsWith('<system-reminder>')) return false
  if (t.startsWith("Caveat: The messages below")) return false
  return true
}

/**
 * The session's "first prompt", if this record is one: a user record whose text
 * is something a person typed, collapsed to one line and cut at 300 characters.
 *
 * Its own function, and exported, because two readers need the identical rule:
 * `parseSession`, which the sidebar's expanded list shows, and the session
 * index (`sessionIndex.ts`) that search matches against. Were they two copies,
 * a search could match a prompt the row it lands on then displays differently,
 * or skip a session whose row shows a prompt containing the very words typed.
 */
export function promptOf(rec: Record<string, unknown>): string | null {
  if (rec.type !== 'user') return null
  const msg = rec.message as { content?: unknown } | undefined
  const text = textOf(msg?.content)
  if (!text || !isUsefulPrompt(text)) return null
  return text.replace(/\s+/g, ' ').trim().slice(0, 300)
}

/** Claude Code's own generated title, if this record carries one. Later records win. */
export function titleOf(rec: Record<string, unknown>): string | null {
  if (rec.type !== 'ai-title') return null
  const t = rec.aiTitle
  return typeof t === 'string' && t.trim() ? t.trim() : null
}

/*
 * Only these five. A transcript is somebody else's file and a mode this app
 * does not understand must not reach the UI as a state nobody can style.
 */
const PERMISSION_MODES = new Set<string>([
  'default',
  'plan',
  'acceptEdits',
  'auto',
  'bypassPermissions'
])

/**
 * What `parseSession` knows part-way through a transcript. The same shape as its
 * result, and every field a primitive, so `finishFold`'s shallow copy is a
 * snapshot later lines cannot change.
 */
export type SessionFold = ParsedSession

/*
 * The one rule for what a transcript says about its session, in three parts:
 * `createFold`, `foldLine`/`foldLines`, `finishFold`. Exported as an accumulator
 * rather than kept inside `parseSession` because two readers need it and they
 * read differently: `parseSession` streams a file start to finish, and the
 * context watcher folds only the bytes appended since its last tick
 * (`advanceCursor`). Two copies of the loop would be two rules, and the meter
 * and the session list would drift apart on the first edit to one of them.
 */

/** An empty accumulator: what a transcript with no records says. */
export function createFold(): SessionFold {
  return {
    title: null,
    firstPrompt: null,
    gitBranch: null,
    cwd: null,
    model: null,
    permissionMode: null,
    messageCount: 0,
    exactCount: true,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0
  }
}

/** Fold one transcript line. Anything that is not a JSON object is skipped. */
export function foldLine(out: SessionFold, line: string): void {
  const rec = safeParse(line)
  if (!rec) return
  const type = rec.type

  if (type === 'ai-title') {
    // Later records win — Claude retitles a session as it evolves.
    const t = titleOf(rec)
    if (t) out.title = t
    return
  }

  if (type === 'permission-mode') {
    // Later records win: the mode is toggled with Shift+Tab mid-session and
    // every toggle appends another record.
    const m = rec.permissionMode
    if (typeof m === 'string' && PERMISSION_MODES.has(m)) {
      out.permissionMode = m as PermissionMode
    }
    return
  }

  if (type === 'user') {
    out.messageCount++
    if (typeof rec.cwd === 'string') out.cwd = rec.cwd
    if (typeof rec.gitBranch === 'string') out.gitBranch = rec.gitBranch
    if (!out.firstPrompt) out.firstPrompt = promptOf(rec)
    return
  }

  if (type === 'assistant') {
    out.messageCount++
    const msg = rec.message as
      | { model?: unknown; usage?: Record<string, unknown> }
      | undefined
    if (typeof msg?.model === 'string') out.model = msg.model
    const u = msg?.usage
    if (u) {
      // Overwrite rather than accumulate: each turn's usage already reports the
      // full context being resent, so the last turn is the current occupancy.
      out.inputTokens = num(u.input_tokens)
      out.cacheReadTokens = num(u.cache_read_input_tokens)
      out.cacheCreationTokens = num(u.cache_creation_input_tokens)
      out.outputTokens = num(u.output_tokens)
    }
  }
}

/**
 * Fold every `\n`-separated line of `text`. Which text is complete is the
 * caller's decision: a streamed reader hands over only whole lines, and holds a
 * partial last line back until its newline arrives.
 */
export function foldLines(out: SessionFold, text: string): void {
  for (const line of text.split('\n')) foldLine(out, line)
}

/** The fold's answer so far, as a value later folding cannot change. */
export function finishFold(fold: SessionFold): ParsedSession {
  return { ...fold }
}

/** Where a streamed pass has got to: every byte before `offset` is in `fold`. */
export interface FoldTarget {
  fold: SessionFold
  offset: number
}

export interface FoldOptions {
  /** Bytes per read. `STREAM_CHUNK` by default; a suite passes tiny ones. */
  chunk?: number
  /** Checked after every read; true stops the pass where it is, consistently. */
  cancelled?: () => boolean
}

const NEWLINE = 0x0a
const NO_BYTES = Buffer.alloc(0)

/*
 * One chunk folded per event-loop turn, across every pass in the process.
 *
 * Yielding between one pass's chunks is not enough on its own: `listSessions`
 * runs eight passes at once, and when several reads complete in the same poll
 * phase their folds run back to back — measured at 21-31 ms of blocked loop
 * for a cold list of the stoke project, eight 3 ms folds end to end. Each fold
 * waits for the previous one's turn plus a `setImmediate`, and an immediate
 * queued from inside the check phase runs on the NEXT iteration, so pty output,
 * IPC and timers get a turn between any two folds. Idle, a turn costs
 * microseconds.
 */
let foldQueue: Promise<void> = Promise.resolve()
/** Below this many bytes a fold is ~0.2 ms, and waits for no turn. */
const FOLD_NOW_BYTES = 64 * 1024
function foldTurn(): Promise<void> {
  const turn = foldQueue.then(() => new Promise<void>((resolve) => setImmediate(resolve)))
  foldQueue = turn
  return turn
}

/**
 * Fold bytes `[target.offset, to)` of an open transcript into `target.fold`,
 * a chunk at a time, and return the bytes after the last newline — a partial
 * line, which is NOT folded. `to` may be `Infinity`, meaning end of file.
 *
 * Why this and not `readFile` + `split`: the fold is ~3 ms per MB of CPU, and
 * done in one go it is one block of the main process's event loop, 40-70 ms for
 * a 22 MB transcript, during which no pty byte reaches a terminal and no
 * keystroke reaches a pty (gotcha 103). Every chunk here is its own read
 * completion, so the loop runs between chunks.
 *
 * `FileHandle.read` rather than `createReadStream`: a Readable's async iterator
 * can hand over a chunk it already buffered in a microtask, without the loop
 * running at all, whereas a read here always completes through libuv. It also
 * gives exact byte positions, one reused buffer, and a bounded end.
 *
 * Bytes are cut at a newline BEFORE they are decoded. A read can end inside a
 * multi-byte UTF-8 character; 0x0A never occurs inside one, so a cut there
 * never splits a character, while decoding first and cutting after would turn
 * the split character into two U+FFFDs and corrupt the line.
 *
 * `target.offset` moves after each chunk's lines are folded, so a pass that is
 * cancelled or throws part-way leaves the fold and the offset agreeing.
 */
export async function foldFrom(
  fh: FileHandle,
  target: FoldTarget,
  to: number,
  opts: FoldOptions = {}
): Promise<Buffer> {
  const chunk = Math.max(1, opts.chunk ?? STREAM_CHUNK)
  const span = to - target.offset
  if (!(span > 0)) return NO_BYTES
  const buf = Buffer.allocUnsafe(Math.min(chunk, span))
  // Bytes after the last newline so far. Kept as pieces and joined once, so a
  // line many chunks long is copied once rather than once per chunk.
  let carry: Buffer[] = []
  let carryLen = 0
  let pos = target.offset
  while (pos < to) {
    const want = Math.min(buf.length, to - pos)
    const { bytesRead } = await fh.read(buf, 0, want, pos)
    if (bytesRead === 0) break
    pos += bytesRead
    const nl = buf.lastIndexOf(NEWLINE, bytesRead - 1)
    if (nl < 0) {
      carry.push(Buffer.from(buf.subarray(0, bytesRead))) // `buf` is reused
      carryLen += bytesRead
    } else {
      // A watcher tick's few-KB append folds at once; only real chunks queue,
      // and they queue before decoding, which is part of the cost.
      if (carryLen + nl > FOLD_NOW_BYTES) await foldTurn()
      const text = carryLen
        ? Buffer.concat([...carry, buf.subarray(0, nl)], carryLen + nl).toString('utf8')
        : buf.toString('utf8', 0, nl)
      foldLines(target.fold, text)
      target.offset = pos - bytesRead + nl + 1
      carryLen = bytesRead - nl - 1
      carry = carryLen ? [Buffer.from(buf.subarray(nl + 1, bytesRead))] : []
    }
    if (opts.cancelled?.()) break
  }
  return carryLen ? Buffer.concat(carry, carryLen) : NO_BYTES
}

/**
 * What a transcript says about its session: title, first prompt, branch, cwd,
 * model, permission mode, message count and the newest turn's usage.
 *
 * Streamed (`foldFrom`) up to `FULL_READ_LIMIT`, head + tail beyond it. Callers
 * that ask again and again cache it (`listSessions`) or do not call it at all
 * (`ContextWatcher`, which keeps a `TranscriptCursor` instead).
 */
export async function parseSession(file: string): Promise<ParsedSession> {
  const fold = createFold()
  const fh = await open(file, 'r')
  try {
    const { size } = await fh.stat()
    if (size > FULL_READ_LIMIT) {
      fold.exactCount = false
      const head = await readAt(fh, 0, CHUNK)
      const tail = await readAt(fh, Math.max(0, size - CHUNK), CHUNK)
      // Drop the first/last fragments — they are almost certainly partial lines.
      for (const line of head.split('\n').slice(0, -1)) foldLine(fold, line)
      for (const line of tail.split('\n').slice(1)) foldLine(fold, line)
    } else {
      // To end of file, not to `size`, exactly as the `readFile` this replaced
      // read: a transcript written to meanwhile is read as it now stands. The
      // buffer is sized to the file, so a small one does not allocate a whole
      // `STREAM_CHUNK`.
      const chunk = Math.min(STREAM_CHUNK, Math.max(64 * 1024, size + 1))
      const rest = await foldFrom(fh, { fold, offset: 0 }, Infinity, { chunk })
      // A final line with no newline yet is folded here, as `split` would have
      // folded it: a record that parses counts, a half-written one does not.
      if (rest.length) foldLine(fold, rest.toString('utf8'))
    }
  } finally {
    await fh.close()
  }
  return finishFold(fold)
}

/**
 * The live context watcher's position in one transcript: everything before
 * `offset` is folded into `fold`, and nothing after it.
 *
 * Owned by the caller (`ContextWatcher`'s per-session `Watch`), never cached
 * here: a module-level cache keyed by path would outlive the watch that knows
 * whether the file it describes is still the same one.
 */
export interface TranscriptCursor extends FoldTarget {
  file: string
  dev: number
  ino: number
}

export interface AdvanceResult {
  cursor: TranscriptCursor
  /** True when the cursor was (re)started from byte 0. */
  reset: boolean
  /** Bytes read this call, for a suite to prove only the appended ones were. */
  bytesRead: number
}

/**
 * Bring a cursor up to date with its transcript, reading only the bytes
 * appended since it last moved, and folding only lines whose newline has
 * arrived.
 *
 * Starts over from byte 0 — a new cursor, the same streamed pass — when the file
 * is not provably the one the cursor read: a different path, a different
 * device/inode (replaced by a rename), a size below the offset (truncated), or a
 * byte before the offset that is no longer the newline that was there (rewritten
 * in place). Claude Code only ever appends to a transcript; each of those is
 * something else having written it, and a fold cannot be un-folded.
 *
 * Takes no stat from the caller: the file is opened first and stat'd through
 * the handle, so the identity and size checked are those of the bytes read.
 * A cursor still valid is advanced IN PLACE and returned; hold only the one
 * returned, and never advance one cursor from two passes at once.
 */
export async function advanceCursor(
  prev: TranscriptCursor | null,
  file: string,
  opts: FoldOptions = {}
): Promise<AdvanceResult> {
  const fh = await open(file, 'r')
  try {
    const st = await fh.stat()
    let cursor =
      prev &&
      prev.file === file &&
      prev.dev === st.dev &&
      prev.ino === st.ino &&
      st.size >= prev.offset
        ? prev
        : null
    let bytesRead = 0
    if (cursor && cursor.offset > 0) {
      const one = Buffer.alloc(1)
      const got = await fh.read(one, 0, 1, cursor.offset - 1)
      bytesRead += got.bytesRead
      if (got.bytesRead !== 1 || one[0] !== NEWLINE) cursor = null
    }
    const reset = cursor === null
    if (!cursor) cursor = { file, dev: st.dev, ino: st.ino, offset: 0, fold: createFold() }
    const from = cursor.offset
    if (st.size > from) {
      const rest = await foldFrom(fh, cursor, st.size, opts)
      bytesRead += cursor.offset - from + rest.length
    }
    return { cursor, reset, bytesRead }
  } finally {
    await fh.close()
  }
}

/** Up to `length` bytes at `start`, through a handle that is already open. */
async function readAt(fh: FileHandle, start: number, length: number): Promise<string> {
  const buf = Buffer.alloc(length)
  const { bytesRead } = await fh.read(buf, 0, length, start)
  return buf.subarray(0, bytesRead).toString('utf8')
}

/**
 * `Promise.all` over `items` with at most `limit` of `fn` in flight, order kept.
 * Shared by `sessionIndex.ts` and `listSessions`, which both walk every
 * transcript in a directory and must not open them all at once.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return out
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

export const WINDOW_STANDARD = 200_000
export const WINDOW_EXTENDED = 1_000_000

/**
 * Context window size for a session.
 *
 * The model id alone is NOT sufficient. A session running the 1M-context tier
 * records its model as plain `claude-opus-5` — the `[1m]` suffix that appears
 * in CLI flags does not survive into the transcript, and no `context_window`
 * field is written either. Verified against a live 1M session sitting at 269k
 * tokens whose every assistant record said `claude-opus-5`.
 *
 * The window is therefore *stated* rather than derived, by the caller: the
 * statusLine payload first (`statusLine.ts`), then the startup banner for a
 * CLI old enough to print one. Both arrive here as `bannerLimit`.
 *
 * With no statement at all, observed usage is the authority: exceeding the
 * standard window is proof the session is on the extended tier. The id is
 * still checked first for the cases where a suffix is present.
 *
 * Known imprecision in that last case only: an extended-tier session below
 * 200k is reported against the 200k window until it crosses over. That reads
 * conservatively (it can over-state pressure, never under-state it) and it can
 * never exceed 100%.
 */
export interface TranscriptTurn {
  role: 'user' | 'assistant'
  text: string
  /** Names of tools called in this turn, for turns that are mostly tool work. */
  tools: string[]
  at: number | null
  /** How each of `tools` ended, from its tool_result: ran, declined or failed. */
  toolStates?: ToolOutcome[]
  /** An interruption marker the CLI filed as a user message, as a system note. */
  note?: string
}

export interface Transcript {
  turns: TranscriptTurn[]
  total: number
  truncated: boolean
  exact: boolean
}

/**
 * The conversation itself, for reading a past session back.
 *
 * parseSession answers "what is this session" from the same file; this answers
 * "what was said". Three kinds of record look like conversation and are not:
 * sidechain records belong to a subagent rather than the user's own thread,
 * meta records are Stoke and Claude Code talking to each other, and a user
 * record whose content is a tool_result is the output of a tool being fed back
 * rather than anything a person typed. Including any of them produces a
 * transcript that reads nothing like the session the user remembers.
 */
export async function readTranscript(file: string, limit = 400): Promise<Transcript> {
  const { lines, exact } = await readLines(file)
  const turns: TranscriptTurn[] = []
  // tool_use id -> the turn that called it, and which of its tools it is.
  const calls = new Map<string, { turn: TranscriptTurn; index: number }>()

  for (const line of lines) {
    const rec = safeParse(line)
    if (!rec) continue
    if (rec.type !== 'user' && rec.type !== 'assistant') continue
    if (rec.isSidechain === true || rec.isMeta === true) continue

    const content = (rec.message as { content?: unknown } | undefined)?.content
    const blocks = Array.isArray(content) ? content : []
    const results = blocks.filter(
      (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result'
    ) as { tool_use_id?: unknown; is_error?: unknown; content?: unknown }[]
    if (results.length) {
      // A result is not a turn; it says how the call it answers ended.
      for (const r of results) {
        const call = typeof r.tool_use_id === 'string' ? calls.get(r.tool_use_id) : undefined
        if (!call) continue
        call.turn.toolStates ??= call.turn.tools.map(() => 'ran')
        call.turn.toolStates[call.index] = toolOutcome(r.is_error, r.content)
      }
      continue
    }

    const tools: string[] = []
    const ids: (string | null)[] = []
    for (const b of blocks) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use') {
        const name = (b as { name?: unknown }).name
        const id = (b as { id?: unknown }).id
        if (typeof name === 'string') {
          tools.push(name)
          ids.push(typeof id === 'string' ? id : null)
        }
      }
    }

    const raw = textOf(content)
    const text = raw ? raw.trim() : ''
    if (!text && !tools.length) continue
    const stamp = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN
    const at = Number.isNaN(stamp) ? null : stamp
    // "[Request interrupted by user…]" is the CLI's, not the user's speech.
    const note = rec.type === 'user' && !tools.length ? interruptionNote(text) : null
    if (note) {
      turns.push({ role: 'user', text: '', tools: [], at, note })
      continue
    }
    if (rec.type === 'user' && text && !isUsefulPrompt(text)) continue

    const turn: TranscriptTurn = { role: rec.type, text, tools, at }
    ids.forEach((id, index) => {
      if (id) calls.set(id, { turn, index })
    })
    turns.push(turn)
  }

  // Keep the end of a long conversation: the recent part is what someone
  // returning to a session on their phone is looking for.
  const truncated = turns.length > limit
  return {
    turns: truncated ? turns.slice(-limit) : turns,
    total: turns.length,
    truncated,
    exact
  }
}

/**
 * Pull the context window out of the CLI's own startup banner.
 *
 * The banner reads like `Opus 5 (1M context) with xhigh effort · Claude Max`,
 * and it is the only place the tier is stated before any tokens are spent. The
 * transcript never carries it: a session verified at 713,617 tokens still
 * recorded its model as plain `claude-opus-5`, and the only tier-ish field
 * anywhere in the file is `usage.service_tier`, which is billing, not context.
 *
 * Without this the meter reads a 1M session against 200k until it crosses over,
 * so a session at 182k showed "92% full" when 82% of the window was still free
 * — alarming, and precisely backwards.
 *
 * Returns null when the banner has not been seen, which is not the same as
 * "standard tier": the caller keeps its observed-usage fallback for that.
 */
export function windowFromBanner(text: string): number | null {
  // Strip escape sequences first: the banner is styled, so the digits and the
  // word "context" are routinely separated by colour codes in the raw stream.
  const plain = text.replace(/\[[0-9;?]*[A-Za-z]/g, '')
  const m = /\(\s*(\d+)\s*(M|K)\s*context\s*\)/i.exec(plain)
  if (!m) return null
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return null
  const tokens = m[2].toUpperCase() === 'M' ? n * 1_000_000 : n * 1_000
  // Sanity-bound it: a malformed match must never produce a window so large
  // that the meter reads 0% forever, which would hide a real overflow.
  return tokens >= WINDOW_STANDARD && tokens <= 10_000_000 ? tokens : null
}

/**
 * @param bannerLimit the stated window, when one has been seen — the
 *   statusLine payload first (`statusLine.ts`'s `windowFor`), the CLI's
 *   startup banner second for a CLI old enough to still print one. Despite
 *   the parameter's name, a caller may hand either source in here; both are a
 *   direct statement and win over both the id and observed usage.
 */
export function contextLimitFor(
  model: string | null,
  observedTokens = 0,
  bannerLimit: number | null = null
): number {
  if (bannerLimit && observedTokens <= bannerLimit) return bannerLimit
  if (model && /\[1m\]|-1m\b|_1m\b/i.test(model)) return WINDOW_EXTENDED
  return observedTokens > WINDOW_STANDARD ? WINDOW_EXTENDED : WINDOW_STANDARD
}

/**
 * How much of the window the conversation is holding right now.
 *
 * All four fields, and the fourth one was missing. `input + cache_read +
 * cache_creation` is the size of the prompt the model was GIVEN at the start of
 * the last call; `output_tokens` is what it wrote in reply, and that reply is
 * part of the conversation the moment it finishes. So between a turn ending and
 * the next prompt being sent — which is precisely when anyone looks at the
 * meter — the window holds the sum of all four, and the ring was drawing the
 * smaller three.
 *
 * Measured rather than reasoned, against the four largest real transcripts on
 * this machine (2,486 consecutive turn pairs): the next turn's prompt grew by at
 * least the previous turn's output in 2,482 of them. The remaining four grew by
 * less, at cache boundaries.
 *
 * It errs in the safe direction now. verify-context's own comment names
 * understating context pressure as "the one direction this codebase treats as
 * dangerous", because a meter reading 95% of a 200k window that is really at 99%
 * is a meter telling someone to keep going.
 */
export function contextUsed(p: {
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
}): number {
  return p.inputTokens + p.cacheReadTokens + p.cacheCreationTokens + p.outputTokens
}
