import { open, readFile, stat } from 'node:fs/promises'

/**
 * Helpers for reading Claude Code's session transcripts
 * (`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`).
 *
 * Each line is a standalone JSON object with a `type` discriminator. Observed
 * types: mode, permission-mode, file-history-snapshot, user, assistant,
 * attachment, last-prompt, ai-title, system.
 */

/**
 * Above this size we stop reading whole files and sample head + tail instead.
 * Parsing measures at roughly 3ms/MB, so a full read stays imperceptible well
 * past any realistic transcript; sampling is a guard against pathological files
 * only, and it costs an accurate message count when it kicks in.
 */
const FULL_READ_LIMIT = 32 * 1024 * 1024
const CHUNK = 256 * 1024

export interface ParsedSession {
  /** Claude Code's own generated title, if it has produced one yet. */
  title: string | null
  firstPrompt: string | null
  gitBranch: string | null
  cwd: string | null
  model: string | null
  messageCount: number
  /** -1 when the file was sampled rather than read in full. */
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

async function readRange(file: string, start: number, length: number): Promise<string> {
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

function textOf(content: unknown): string | null {
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
function isUsefulPrompt(s: string): boolean {
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

export async function parseSession(file: string): Promise<ParsedSession> {
  const out: ParsedSession = {
    title: null,
    firstPrompt: null,
    gitBranch: null,
    cwd: null,
    model: null,
    messageCount: 0,
    exactCount: true,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0
  }

  const { lines, exact } = await readLines(file)
  out.exactCount = exact

  for (const line of lines) {
    const rec = safeParse(line)
    if (!rec) continue
    const type = rec.type

    if (type === 'ai-title') {
      // Later records win — Claude retitles a session as it evolves.
      const t = rec.aiTitle
      if (typeof t === 'string' && t.trim()) out.title = t.trim()
      continue
    }

    if (type === 'user') {
      out.messageCount++
      if (typeof rec.cwd === 'string') out.cwd = rec.cwd
      if (typeof rec.gitBranch === 'string') out.gitBranch = rec.gitBranch
      if (!out.firstPrompt) {
        const msg = rec.message as { content?: unknown } | undefined
        const text = textOf(msg?.content)
        if (text && isUsefulPrompt(text)) {
          out.firstPrompt = text.replace(/\s+/g, ' ').trim().slice(0, 300)
        }
      }
      continue
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

  for (const line of lines) {
    const rec = safeParse(line)
    if (!rec) continue
    if (rec.type !== 'user' && rec.type !== 'assistant') continue
    if (rec.isSidechain === true || rec.isMeta === true) continue

    const content = (rec.message as { content?: unknown } | undefined)?.content
    const blocks = Array.isArray(content) ? content : []
    const isToolResult = blocks.some(
      (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result'
    )
    if (isToolResult) continue

    const tools: string[] = []
    for (const b of blocks) {
      if (b && typeof b === 'object' && (b as { type?: string }).type === 'tool_use') {
        const name = (b as { name?: unknown }).name
        if (typeof name === 'string') tools.push(name)
      }
    }

    const raw = textOf(content)
    const text = raw ? raw.trim() : ''
    if (!text && !tools.length) continue
    if (rec.type === 'user' && text && !isUsefulPrompt(text)) continue

    const stamp = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN
    turns.push({
      role: rec.type,
      text,
      tools,
      at: Number.isNaN(stamp) ? null : stamp
    })
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
 * @param bannerLimit window read from the CLI banner, when one has been seen.
 *   It wins over both the id and observed usage, being a direct statement.
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

export function contextUsed(p: {
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
}): number {
  return p.inputTokens + p.cacheReadTokens + p.cacheCreationTokens
}
