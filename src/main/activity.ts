import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'

/**
 * What was worked on, from Claude Code's own transcripts.
 *
 * Pure and electron-free on purpose: `scripts/verify-activity.mts` runs this
 * module directly under `node --experimental-strip-types`, which is also why
 * the relative imports here carry explicit `.ts` extensions and why nothing in
 * this file uses a TypeScript parameter property.
 *
 * Discovery — which sessions belong to which project, and which of those
 * projects the user asked to watch — deliberately does NOT live here. `index.ts`
 * resolves that through the existing `listProjects` / `listSessions` /
 * worklog-gate helpers and hands this module a flat list, so every number below
 * can be tested without a filesystem and without a settings object.
 */

/**
 * A gap longer than this is not work.
 *
 * One fixed number, stated in the UI, rather than a setting. Measured on a real
 * session here: 127.7h of wall-clock, 12.5h of activity at a 5-minute cap and
 * 18.4h at 15. Those are three defensible-sounding answers to one question, so
 * the value has to be pinned and disclosed — a number that moves with a knob is
 * a number nobody can defend when a manager asks how it was measured.
 */
export const IDLE_GAP_MS = 15 * 60 * 1000

/**
 * Local calendar day, because "what did I do today" is a local question.
 *
 * Deliberately not `toISOString().slice(0, 10)`, which is UTC: east of
 * Greenwich that reports the morning's work as yesterday.
 */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * Elapsed active time per local day.
 *
 * Each gap is attributed to the day it *starts* in, and capped at `idleGapMs`.
 * Attributing to the start is what stops a session running past midnight from
 * booking the whole overnight stretch to the following day.
 *
 * The input is sorted rather than assumed sorted. A transcript interleaves
 * sidechain entries from sub-agents, which do not arrive in wall-clock order,
 * and an unsorted pass would read those as negative gaps and silently drop
 * real time.
 */
export function bucketActiveMs(stampsMs: number[], idleGapMs = IDLE_GAP_MS): Map<string, number> {
  const out = new Map<string, number>()
  const sorted = [...stampsMs].sort((a, b) => a - b)
  for (let i = 1; i < sorted.length; i++) {
    const from = sorted[i - 1]
    const delta = sorted[i] - from
    if (delta <= 0) continue
    const key = dayKey(from)
    out.set(key, (out.get(key) ?? 0) + Math.min(delta, idleGapMs))
  }
  return out
}

/**
 * The tools that put text into a file. Anything else contributes no lines.
 *
 * A set rather than a regex or a prefix test, because the cost of being loose
 * here is a number nobody can explain: counting `Bash` would fold every
 * heredoc and every `cat` into "lines written", and the total would drift
 * upwards for reasons invisible from the panel.
 */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

/** The file an edit touched, or null when the call names none. */
export function editFilePath(input: Record<string, unknown>): string | null {
  const p = input.file_path
  return typeof p === 'string' && p ? p : null
}

/**
 * Lines this tool call put into a file.
 *
 * **Churn, not net**, and the distinction is the whole reason this is not
 * called `linesAdded`. A `Write` re-counts the entire file every time it
 * rewrites it, and an `Edit` counts what it inserted while ignoring what it
 * removed. Measured against one real session: this reports +5,642 where the
 * repository grew by far less.
 *
 * That is a fair measure of work done and a wrong measure of repository
 * growth, so every label that renders it says "written/edited", and git's own
 * net figure is shown beside it wherever a repository exists. Presenting this
 * as "lines added" to someone who can run `git diff` is the one way this
 * feature loses its credibility.
 *
 * A call with no `file_path` counts nothing even when its tool is an edit
 * tool: a malformed call should not be able to inflate a day.
 */
export function editLineCount(toolName: string, input: Record<string, unknown>): number {
  if (!EDIT_TOOLS.has(toolName)) return 0
  if (!editFilePath(input)) return 0
  const text =
    toolName === 'Write'
      ? input.content
      : toolName === 'NotebookEdit'
        ? input.new_source
        : input.new_string
  if (typeof text !== 'string') return 0
  return text.split('\n').length
}

export interface ActivitySlice {
  /** Local YYYY-MM-DD. */
  day: string
  /** Display name for the folder this session ran in. */
  project: string
  sessionId: string
  /** Claude Code's own `aiTitle`, when it has written one. */
  title: string | null
  activeMs: number
  /** Churn. See editLineCount — this is not net repository growth. */
  linesWritten: number
  files: string[]
}

export interface ActivitySessionInput {
  sessionId: string
  /** Path to the session's own JSONL transcript. */
  file: string
  project: string
  /** What the caller already knows, which wins over the transcript's own. */
  title: string | null
}

const TIMESTAMP_RE = /"timestamp":"([^"]+)"/
const AI_TITLE_RE = /"aiTitle":"((?:[^"\\]|\\.)*)"/

/**
 * One session's activity, per local day.
 *
 * **The parse strategy here is load-bearing and looks like premature
 * optimisation.** A transcript on this machine reaches 23 MB and is mostly
 * large tool *results*, which this module never reads. Parsing every line as
 * JSON was measured and did not finish inside two minutes on a single file;
 * pulling timestamps with a regex and calling `JSON.parse` only on the lines
 * that actually contain `"tool_use"` does the same file in well under a second.
 * Anyone "simplifying" this into a parse-per-line reintroduces a panel that
 * takes minutes to open.
 *
 * The file is streamed rather than read head-and-tail like `sessionFile.ts`'s
 * `readLines`, because every timestamp matters here and not just the ends.
 * Memory stays bounded regardless of file size: only timestamps and edit sizes
 * are retained, never the text they came from.
 *
 * A line that will not parse is skipped rather than failing the read. A
 * transcript is an append-only log that a crash can truncate mid-line, and one
 * torn last line must not cost the whole session's numbers.
 */
export async function readSessionActivity(
  input: ActivitySessionInput,
  idleGapMs = IDLE_GAP_MS
): Promise<ActivitySlice[]> {
  const stamps: number[] = []
  const linesByDay = new Map<string, number>()
  const filesByDay = new Map<string, Set<string>>()
  let title = input.title

  const reader = createInterface({
    input: createReadStream(input.file, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })

  try {
    for await (const line of reader) {
      if (!line) continue

      let stamp = Number.NaN
      const t = TIMESTAMP_RE.exec(line)
      if (t) {
        const parsed = Date.parse(t[1])
        if (Number.isFinite(parsed)) {
          stamp = parsed
          stamps.push(parsed)
        }
      }

      // Only when the caller had none: listSessions already knows the title for
      // any session Stoke has indexed, and this scan is the fallback for one it
      // has not.
      if (title === null) {
        const a = AI_TITLE_RE.exec(line)
        if (a) {
          try {
            const decoded: unknown = JSON.parse(`"${a[1]}"`)
            if (typeof decoded === 'string' && decoded) title = decoded
          } catch {
            /* a line that merely looked like a title */
          }
        }
      }

      if (!line.includes('"tool_use"')) continue
      if (!Number.isFinite(stamp)) continue

      let doc: Record<string, unknown>
      try {
        doc = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const message = doc.message
      const content =
        message && typeof message === 'object' ? (message as Record<string, unknown>).content : null
      if (!Array.isArray(content)) continue

      const day = dayKey(stamp)
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const b = block as Record<string, unknown>
        if (b.type !== 'tool_use' || typeof b.name !== 'string') continue
        const toolInput = (b.input ?? {}) as Record<string, unknown>
        const count = editLineCount(b.name, toolInput)
        if (!count) continue
        linesByDay.set(day, (linesByDay.get(day) ?? 0) + count)
        const path = editFilePath(toolInput)
        if (path) {
          const set = filesByDay.get(day) ?? new Set<string>()
          set.add(path)
          filesByDay.set(day, set)
        }
      }
    }
  } finally {
    reader.close()
  }

  const active = bucketActiveMs(stamps, idleGapMs)
  const days = new Set<string>([...active.keys(), ...linesByDay.keys()])
  return [...days].sort().map((day) => ({
    day,
    project: input.project,
    sessionId: input.sessionId,
    title,
    activeMs: active.get(day) ?? 0,
    linesWritten: linesByDay.get(day) ?? 0,
    files: [...(filesByDay.get(day) ?? [])]
  }))
}
