# Activity Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only Activity panel that answers "what did I work on today / this week" from data already on disk — hours, lines and session titles — with no model call, no network and no third-party account.

**Architecture:** A pure main-process module parses Claude Code's own transcripts into per-day, per-project slices; a second module adds git commit subjects where a repository exists; one IPC channel serves them; a renderer panel replaces `WorklogPanel` in the same column. Discovery of *which* sessions to read stays in `index.ts` using the existing `listProjects` / `listSessions` / worklog-gate helpers, so `activity.ts` stays pure and testable.

**Tech Stack:** TypeScript, Electron main + preload + React renderer, `node:readline` streaming, plain CSS custom properties, `node --experimental-strip-types` verify suites.

**Spec:** `docs/superpowers/specs/2026-08-25-activity-report-design.md`

## Global Constraints

- **`src/main/activity.ts` and `src/main/activityGit.ts` MUST NOT import `electron`.** `scripts/verify-activity.mts` runs them directly under `node --experimental-strip-types`.
- **Relative imports inside `src/main` carry explicit `.ts` extensions.** Required by node's strip-only mode.
- **No TypeScript parameter properties** anywhere in `src/main`. Assign fields explicitly.
- **No `node:` imports in `src/shared/**`.** Both tsconfigs compile it and `tsconfig.web.json` sets `"types": ["vite/client"]` with no `node` — a `node:` import fails the *web* half of typecheck while the main half stays green.
- **IPC channel names go in `src/shared/ipc.ts` first.**
- **All colour through CSS custom properties.** No hardcoded hex in components. No Tailwind, no component library.
- **Panels are sibling columns inside `.body-row`, never overlays.** The docked browser is a native `WebContentsView` that paints above all renderer DOM.
- `IDLE_GAP_MS = 15 * 60 * 1000` — one fixed value, exported, stated in the UI.
- **"Lines" means churn, not net.** Every user-facing label reads "lines written/edited".
- Commit messages explain *why*, and record any bug the change fixes.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `src/main/activity.ts` (create) | Pure transcript → `ActivitySlice[]`. Time bucketing, churn counting, streaming parse, per-file cache. No electron, no discovery. |
| `src/main/activityGit.ts` (create) | Commit subjects per repo per day. Async with a deadline; a missing repo is normal. |
| `scripts/verify-activity.mts` (create) | The suite. Loads the real modules. |
| `src/shared/types.ts` (modify) | `ActivitySlice`, `ActivityReport`. |
| `src/shared/ipc.ts` (modify) | `activityRead: 'activity:read'`. |
| `src/main/index.ts` (modify) | Handler: resolve watched sessions via the existing gate, call both modules, return a report. |
| `src/preload/index.ts` (modify) | `activity.read(from, to)`. |
| `src/renderer/src/components/ActivityPanel.tsx` (create) | The panel. |
| `src/renderer/src/styles/app.css` (modify) | `.activity-*` rules. |
| `src/renderer/src/App.tsx` (modify) | Render `ActivityPanel` where `WorklogPanel` was. |
| `package.json` (modify) | `verify:activity`, added to `check`. |

---

### Task 1: Time bucketing

**Files:**
- Create: `src/main/activity.ts`
- Create: `scripts/verify-activity.mts`
- Modify: `package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `IDLE_GAP_MS: number`, `dayKey(ms: number): string`, `bucketActiveMs(stampsMs: number[], idleGapMs?: number): Map<string, number>`.

- [ ] **Step 1: Write the failing test**

Create `scripts/verify-activity.mts`:

```ts
/**
 * The activity report is the only answer to "what did I work on this week", so
 * the two numbers it states have to be defensible: active time, and lines
 * written. Both are easy to get subtly wrong in ways that still render.
 *
 *   node scripts/verify-activity.mts
 */
import { bucketActiveMs, dayKey, IDLE_GAP_MS } from '../src/main/activity.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const MIN = 60_000
/** 2026-08-25 09:00 local, so day boundaries are exercised in the local zone. */
const at = (h: number, m = 0): number => new Date(2026, 7, 25, h, m, 0, 0).getTime()

console.log('\nactive time')

const short = bucketActiveMs([at(9), at(9, 5), at(9, 9)])
check(
  'gaps under the cap accumulate in full',
  short.get(dayKey(at(9))) === 9 * MIN,
  String(short.get(dayKey(at(9))))
)

const long = bucketActiveMs([at(9), at(14)])
check(
  'a gap over the cap contributes exactly the cap, not zero and not its full length',
  long.get(dayKey(at(9))) === IDLE_GAP_MS,
  String(long.get(dayKey(at(9))))
)

const none = bucketActiveMs([at(9)])
check('a single stamp is no elapsed time', none.size === 0)

check('an empty session buckets nothing', bucketActiveMs([]).size === 0)

const unsorted = bucketActiveMs([at(9, 9), at(9), at(9, 5)])
check(
  'stamps out of order are sorted, not treated as negative gaps',
  unsorted.get(dayKey(at(9))) === 9 * MIN,
  String(unsorted.get(dayKey(at(9))))
)

console.log(failed === 0 ? '\nall pass' : `\n${failed} failure(s)`)
process.exitCode = failed === 0 ? 0 : 1
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node scripts/verify-activity.mts`
Expected: FAIL — `Cannot find module '../src/main/activity.ts'`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/main/activity.ts`:

```ts
/**
 * What was worked on, from Claude Code's own transcripts.
 *
 * Pure and electron-free on purpose: `scripts/verify-activity.mts` runs this
 * module directly under `node --experimental-strip-types`, which is also why
 * the relative imports below carry explicit `.ts` extensions.
 *
 * Discovery — which sessions belong to which project, and which projects are
 * watched — deliberately does NOT live here. `index.ts` resolves that through
 * the existing `listProjects` / `listSessions` / worklog-gate helpers and hands
 * this module a flat list, so the maths can be tested without a filesystem.
 */

/**
 * A gap longer than this is not work.
 *
 * One fixed number, stated in the UI, rather than a knob. Measured on a real
 * session: 127.7h of wall-clock, 12.5h at a 5-minute cap and 18.4h at 15. A
 * number that moves with a setting is a number nobody can defend when asked.
 */
export const IDLE_GAP_MS = 15 * 60 * 1000

/** Local calendar day, because "what did I do today" is a local question. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

/**
 * Elapsed active time per local day.
 *
 * Each gap is attributed to the day it STARTS in, and capped. Attributing to
 * the start is what keeps a session that runs past midnight from booking the
 * whole stretch to the following day.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node scripts/verify-activity.mts`
Expected: PASS on all five, ending `all pass`.

- [ ] **Step 5: Wire the suite into the check chain**

In `package.json`, add to `scripts`:

```json
"verify:activity": "node scripts/verify-activity.mts",
```

and insert `npm run verify:activity && ` into `check` immediately before `npm run verify:worklog-gate`.

- [ ] **Step 6: Run it through npm**

Run: `npm run verify:activity`
Expected: `all pass`.

- [ ] **Step 7: Commit**

```bash
git add src/main/activity.ts scripts/verify-activity.mts package.json
git commit -m "Bucket active time per local day, capped at a 15-minute idle gap"
```

---

### Task 2: Churn counting

**Files:**
- Modify: `src/main/activity.ts`
- Modify: `scripts/verify-activity.mts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `editLineCount(toolName: string, input: Record<string, unknown>): number`, `editFilePath(input: Record<string, unknown>): string | null`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/verify-activity.mts`, above the final `console.log`:

```ts
console.log('\nlines written')

check(
  'Write counts every line of its content',
  editLineCount('Write', { file_path: '/a.ts', content: 'one\ntwo\nthree' }) === 3
)
check(
  'Edit counts the lines it puts in, not the ones it took out',
  editLineCount('Edit', { file_path: '/a.ts', old_string: 'a\nb\nc\nd', new_string: 'x\ny' }) === 2
)
check(
  'a tool with no file_path counts nothing, however much text it carries',
  editLineCount('Bash', { command: 'echo one\necho two' }) === 0
)
check(
  'an empty write is one line, not zero — the file still changed',
  editLineCount('Write', { file_path: '/a.ts', content: '' }) === 1
)
check(
  'a read is not an edit',
  editLineCount('Read', { file_path: '/a.ts' }) === 0
)
check('the file path comes back for an edit', editFilePath({ file_path: '/a.ts' }) === '/a.ts')
check('and is null when absent', editFilePath({ command: 'ls' }) === null)
```

Add `editFilePath, editLineCount` to the import from `../src/main/activity.ts`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run verify:activity`
Expected: FAIL — `editLineCount is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/main/activity.ts`:

```ts
/** The tools that change a file. Anything else contributes no lines. */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

export function editFilePath(input: Record<string, unknown>): string | null {
  const p = input.file_path
  return typeof p === 'string' && p ? p : null
}

/**
 * Lines this tool call put into a file.
 *
 * Churn, not net: a `Write` re-counts the whole file every time it rewrites it,
 * and an `Edit` counts what it inserted while ignoring what it removed. That is
 * a fair measure of work done and a wrong measure of repository growth, which
 * is why every label that renders this says "written/edited" and why git's own
 * net figure is shown beside it wherever a repository exists.
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run verify:activity`
Expected: `all pass`.

- [ ] **Step 5: Commit**

```bash
git add src/main/activity.ts scripts/verify-activity.mts
git commit -m "Count lines written per edit tool call, as churn rather than net"
```

---

### Task 3: The streaming transcript read

**Files:**
- Modify: `src/main/activity.ts`
- Modify: `scripts/verify-activity.mts`

**Interfaces:**
- Consumes: `IDLE_GAP_MS`, `dayKey`, `bucketActiveMs`, `editFilePath`, `editLineCount`.
- Produces: `ActivitySlice` (interface), `ActivitySessionInput` (interface), `readSessionActivity(input: ActivitySessionInput, idleGapMs?: number): Promise<ActivitySlice[]>`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/verify-activity.mts`, above the final `console.log`:

```ts
console.log('\nreading a transcript')

const dir = mkdtempSync(join(tmpdir(), 'stoke-activity-'))
const write = (name: string, lines: unknown[]): string => {
  const file = join(dir, name)
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  return file
}
const iso = (h: number, m = 0): string => new Date(2026, 7, 25, h, m, 0, 0).toISOString()

const entry = (timestamp: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant',
  timestamp,
  ...extra
})
const toolUse = (timestamp: string, name: string, input: Record<string, unknown>) =>
  entry(timestamp, { message: { content: [{ type: 'tool_use', name, input }] } })

const oneDay = write('one.jsonl', [
  { type: 'summary', aiTitle: 'Vic Aluminium CRM job tracking' },
  entry(iso(9)),
  toolUse(iso(9, 4), 'Write', { file_path: '/x/a.ts', content: 'a\nb\nc' }),
  toolUse(iso(9, 8), 'Edit', { file_path: '/x/b.ts', old_string: 'q', new_string: 'r\ns' })
])

const slices = await readSessionActivity({
  sessionId: 's1',
  file: oneDay,
  project: 'Laro',
  title: null
})
check('one day yields one slice', slices.length === 1, String(slices.length))
check('the title is read out of the transcript', slices[0]?.title === 'Vic Aluminium CRM job tracking')
check('active time is the summed gaps', slices[0]?.activeMs === 8 * MIN, String(slices[0]?.activeMs))
check('lines are the edit tools summed', slices[0]?.linesWritten === 5, String(slices[0]?.linesWritten))
check('files are de-duplicated', slices[0]?.files.length === 2, JSON.stringify(slices[0]?.files))
check('the project comes through', slices[0]?.project === 'Laro')

// A session that runs past midnight. The real ItemProcessor session spans six
// days; booking that to one day is the failure this pins.
const overnight = write('overnight.jsonl', [
  entry(new Date(2026, 7, 25, 23, 55).toISOString()),
  entry(new Date(2026, 7, 26, 0, 3).toISOString())
])
const spanning = await readSessionActivity({
  sessionId: 's2',
  file: overnight,
  project: 'Laro',
  title: null
})
check('a session crossing midnight is split across two days', spanning.length === 2, String(spanning.length))
check(
  'and the gap is booked to the day it started in',
  spanning.find((s) => s.day === '2026-08-25')?.activeMs === 8 * MIN,
  JSON.stringify(spanning.map((s) => [s.day, s.activeMs]))
)

const empty = write('empty.jsonl', [])
check(
  'an empty transcript yields nothing and does not throw',
  (await readSessionActivity({ sessionId: 's3', file: empty, project: 'Laro', title: null })).length === 0
)

const junk = join(dir, 'junk.jsonl')
writeFileSync(junk, 'not json at all\n' + JSON.stringify(entry(iso(10))) + '\n', 'utf8')
check(
  'an unparseable line is skipped rather than failing the whole read',
  Array.isArray(await readSessionActivity({ sessionId: 's4', file: junk, project: 'Laro', title: null }))
)

rmSync(dir, { recursive: true, force: true })
```

Add to the imports at the top of the suite:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
```

and add `readSessionActivity` to the `../src/main/activity.ts` import.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run verify:activity`
Expected: FAIL — `readSessionActivity is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/main/activity.ts`, with these imports at the top of the file:

```ts
import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
```

```ts
export interface ActivitySlice {
  /** Local YYYY-MM-DD. */
  day: string
  project: string
  sessionId: string
  /** Claude Code's own `aiTitle`, when it has written one. */
  title: string | null
  activeMs: number
  /** Churn. See editLineCount. */
  linesWritten: number
  files: string[]
}

export interface ActivitySessionInput {
  sessionId: string
  /** Path to the session's own JSONL transcript. */
  file: string
  /** Display name for the folder this session ran in. */
  project: string
  title: string | null
}

const TIMESTAMP_RE = /"timestamp":"([^"]+)"/
const AI_TITLE_RE = /"aiTitle":"((?:[^"\\]|\\.)*)"/

/**
 * One session's activity, per local day.
 *
 * **The parse strategy here is load-bearing and looks like premature
 * optimisation.** A transcript on this machine reaches 23 MB and is mostly
 * large tool *results*, which this module never reads. Running `JSON.parse` on
 * every line was measured and did not finish inside two minutes on a single
 * file; pulling timestamps with a regex and parsing only the lines that
 * actually contain `"tool_use"` does the same file in 0.5s. Anyone
 * "simplifying" this into a parse-per-line reintroduces a two-minute panel.
 *
 * The file is streamed rather than read head-and-tail like `sessionFile.ts`'s
 * `readLines`, because every timestamp matters and not just the ends. Memory
 * stays bounded regardless of file size: only timestamps and edit sizes are
 * retained, never the text.
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
        stamp = Date.parse(t[1])
        if (Number.isFinite(stamp)) stamps.push(stamp)
      }

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

      let doc: Record<string, unknown>
      try {
        doc = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      const message = doc.message
      const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : null
      if (!Array.isArray(content)) continue

      const day = Number.isFinite(stamp) ? dayKey(stamp) : null
      if (!day) continue

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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run verify:activity`
Expected: `all pass`.

- [ ] **Step 5: Verify the performance claim against a real transcript**

Run:

```bash
node --experimental-strip-types -e "
import('./src/main/activity.ts').then(async (m) => {
  const f = process.env.HOME + '/.claude/projects/-Users-thevinh-dev-work-ItemProcessor/85ec7542-d2e4-4add-80f8-a76a1caaedca.jsonl'
  const t = Date.now()
  const s = await m.readSessionActivity({ sessionId: 'x', file: f, project: 'ItemProcessor', title: null })
  console.log(s.length, 'days', Date.now() - t, 'ms')
})"
```

Expected: completes in **well under 5 seconds** (the python equivalent took 0.5s). If it takes minutes, the selective-parse guard has been lost.

- [ ] **Step 6: Commit**

```bash
git add src/main/activity.ts scripts/verify-activity.mts
git commit -m "Read one session's activity by streaming its transcript"
```

---

### Task 4: Many sessions, with a cache

**Files:**
- Modify: `src/main/activity.ts`
- Modify: `scripts/verify-activity.mts`

**Interfaces:**
- Consumes: `readSessionActivity`, `ActivitySlice`, `ActivitySessionInput`.
- Produces: `readActivity(inputs: ActivitySessionInput[], opts?: { from?: number; to?: number; idleGapMs?: number }): Promise<{ slices: ActivitySlice[]; skipped: number }>`, `clearActivityCache(): void`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/verify-activity.mts`, before `rmSync(dir, …)`:

```ts
console.log('\nmany sessions')

const many = await readActivity([
  { sessionId: 's1', file: oneDay, project: 'Laro', title: null },
  { sessionId: 's3', file: empty, project: 'oseo', title: null },
  { sessionId: 'gone', file: join(dir, 'does-not-exist.jsonl'), project: 'ghost', title: null }
])
check('a missing transcript is counted, not thrown', many.skipped === 1, String(many.skipped))
check('and the readable ones still come back', many.slices.length === 1, String(many.slices.length))

const windowed = await readActivity([{ sessionId: 's1', file: oneDay, project: 'Laro', title: null }], {
  from: new Date(2026, 7, 26).getTime(),
  to: new Date(2026, 7, 27).getTime()
})
check('a period that excludes the work returns nothing', windowed.slices.length === 0)

clearActivityCache()
```

Add `clearActivityCache, readActivity` to the `../src/main/activity.ts` import.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run verify:activity`
Expected: FAIL — `readActivity is not a function`.

- [ ] **Step 3: Write the minimal implementation**

Add `import { stat } from 'node:fs/promises'` at the top, then append:

```ts
/**
 * Cache key is path + mtime + size, so a finished session is parsed once for
 * the life of the process and only the live one is re-read. Reopening the panel
 * is then free rather than costing another pass over every transcript on disk.
 */
interface CacheEntry {
  key: string
  slices: ActivitySlice[]
}
const cache = new Map<string, CacheEntry>()

/** Exported so a suite can prove the cache is keyed rather than permanent. */
export function clearActivityCache(): void {
  cache.clear()
}

export async function readActivity(
  inputs: ActivitySessionInput[],
  opts: { from?: number; to?: number; idleGapMs?: number } = {}
): Promise<{ slices: ActivitySlice[]; skipped: number }> {
  const from = opts.from ?? Number.NEGATIVE_INFINITY
  const to = opts.to ?? Number.POSITIVE_INFINITY
  const out: ActivitySlice[] = []
  let skipped = 0

  const results = await Promise.all(
    inputs.map(async (input) => {
      try {
        const info = await stat(input.file)
        const key = `${info.mtimeMs}:${info.size}:${opts.idleGapMs ?? IDLE_GAP_MS}`
        const hit = cache.get(input.file)
        if (hit && hit.key === key) return hit.slices
        const slices = await readSessionActivity(input, opts.idleGapMs)
        cache.set(input.file, { key, slices })
        return slices
      } catch {
        // A transcript that has been deleted, or a permission error. Counted so
        // the panel can say the total is partial - a silently short week reads
        // as a quiet week, which is the one wrong answer that matters here.
        return null
      }
    })
  )

  for (const slices of results) {
    if (slices === null) {
      skipped++
      continue
    }
    for (const slice of slices) {
      const dayStart = new Date(`${slice.day}T00:00:00`).getTime()
      if (dayStart < from || dayStart > to) continue
      out.push(slice)
    }
  }

  out.sort((a, b) => (a.day === b.day ? b.activeMs - a.activeMs : b.day.localeCompare(a.day)))
  return { slices: out, skipped }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run verify:activity`
Expected: `all pass`.

- [ ] **Step 5: Commit**

```bash
git add src/main/activity.ts scripts/verify-activity.mts
git commit -m "Read many sessions at once, cached on mtime, counting what was skipped"
```

---

### Task 5: Git commit subjects

**Files:**
- Create: `src/main/activityGit.ts`
- Modify: `scripts/verify-activity.mts`

**Interfaces:**
- Consumes: nothing.
- Produces: `commitSubjects(repoDir: string, day: string, opts?: { timeoutMs?: number }): Promise<string[]>`.

- [ ] **Step 1: Write the failing test**

Append to `scripts/verify-activity.mts`, before `rmSync(dir, …)`:

```ts
console.log('\ngit corroboration')

check(
  'a folder with no repository yields no subjects and does not throw',
  (await commitSubjects(dir, '2026-08-25')).length === 0
)
check(
  'a path that does not exist at all is handled the same way',
  (await commitSubjects(join(dir, 'nope'), '2026-08-25')).length === 0
)
```

Add `import { commitSubjects } from '../src/main/activityGit.ts'`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run verify:activity`
Expected: FAIL — cannot find `../src/main/activityGit.ts`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/main/activityGit.ts`:

```ts
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Commit subjects for one repository on one local day.
 *
 * Corroboration, never a dependency. Three of the ten work folders on this
 * machine have no repository at all — and one of them is the largest session
 * on it — so a missing repo is the ordinary case and is reported as no
 * subjects rather than as an error.
 *
 * `execFile` with an explicit timeout, never a synchronous call: a project can
 * sit on an external disk that has spun down, and a sync call there blocks the
 * main process's event loop, which stops every IPC reply and every frame with
 * it (CLAUDE.md gotcha 40).
 */
export async function commitSubjects(
  repoDir: string,
  day: string,
  opts: { timeoutMs?: number } = {}
): Promise<string[]> {
  if (!repoDir || !existsSync(join(repoDir, '.git'))) return []
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', repoDir, 'log', '--since', `${day} 00:00`, '--until', `${day} 23:59`, '--pretty=format:%s'],
      { timeout: opts.timeoutMs ?? 3000, maxBuffer: 1024 * 1024, encoding: 'utf8', windowsHide: true },
      (err, stdout) => {
        // A timeout, a corrupt repository, a git that is not installed. None of
        // them is worth failing the report for; the numbers stand without the
        // subjects.
        if (err) return resolve([])
        resolve(
          stdout
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean)
        )
      }
    )
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run verify:activity`
Expected: `all pass`.

- [ ] **Step 5: Verify it against a real repository**

Run:

```bash
node --experimental-strip-types -e "
import('./src/main/activityGit.ts').then(async (m) => {
  console.log(await m.commitSubjects('/Users/thevinh/dev/work/Laro', '2026-08-25'))
})"
```

Expected: a non-empty array of commit subjects.

- [ ] **Step 6: Commit**

```bash
git add src/main/activityGit.ts scripts/verify-activity.mts
git commit -m "Read commit subjects per repo per day, tolerating a folder with no repository"
```

---

### Task 6: Types, channel, handler, bridge

**Files:**
- Modify: `src/shared/types.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `readActivity`, `ActivitySlice`, `commitSubjects`.
- Produces: `window.stoke.activity.read(from: number, to: number): Promise<ActivityReport>` where `ActivityReport = { slices: ActivitySlice[]; commits: Record<string, string[]>; skipped: number; idleGapMs: number }`. The `commits` key is `` `${project}|${day}` ``.

- [ ] **Step 1: Add the shared types**

In `src/shared/types.ts` (no `node:` imports — both tsconfigs compile this file):

```ts
export interface ActivitySlice {
  day: string
  project: string
  sessionId: string
  title: string | null
  activeMs: number
  linesWritten: number
  files: string[]
}

export interface ActivityReport {
  slices: ActivitySlice[]
  /** Commit subjects, keyed `project|day`. Absent for a folder with no repo. */
  commits: Record<string, string[]>
  /** Transcripts that could not be read. A partial total must say it is partial. */
  skipped: number
  /** Stated in the UI, so the number can be defended rather than merely quoted. */
  idleGapMs: number
}
```

- [ ] **Step 2: Add the channel**

In `src/shared/ipc.ts`, after the `// worklog` block:

```ts
  // activity
  activityRead: 'activity:read',
```

- [ ] **Step 3: Add the handler**

In `src/main/index.ts`, import at the top:

```ts
import { IDLE_GAP_MS, readActivity, type ActivitySessionInput } from './activity.ts'
import { commitSubjects } from './activityGit.ts'
```

and register beside the other worklog handlers:

```ts
  ipcMain.handle(CH.activityRead, async (_e, from: number, to: number) => {
    const settings = getSettings()
    const projects = await listProjects(settings)
    const inputs: ActivitySessionInput[] = []
    const dirs = new Map<string, string>()

    for (const project of projects) {
      const group = groupForCwd(project.path, projects, settings.projectRoots)
      // The same gate the worklog uses, so the existing setting keeps meaning
      // what it meant - and so personal work cannot reach a manager-facing
      // screen by accident.
      if (!isWatchedGroup(group, settings.worklogGroups)) continue
      const name = basename(project.path) || project.path
      dirs.set(name, project.path)
      for (const session of await listSessions(project.path)) {
        inputs.push({
          sessionId: session.id,
          file: session.file,
          project: name,
          title: session.title
        })
      }
    }

    const { slices, skipped } = await readActivity(inputs, { from, to })

    // Git is additive and must never hold the report up: resolved in parallel,
    // each with its own timeout inside commitSubjects.
    const wanted = [...new Set(slices.map((s) => `${s.project}|${s.day}`))]
    const subjects = await Promise.all(
      wanted.map(async (key) => {
        const [project, day] = key.split('|')
        const dir = dirs.get(project)
        return [key, dir ? await commitSubjects(dir, day) : []] as const
      })
    )
    const commits: Record<string, string[]> = {}
    for (const [key, list] of subjects) if (list.length) commits[key] = list

    return { slices, commits, skipped, idleGapMs: IDLE_GAP_MS }
  })
```

Ensure `basename` is imported from `node:path` and that `groupForCwd` / `isWatchedGroup` are imported from `./worklog/gate.ts` (both are already used in this file for the worklog gate — reuse the existing imports rather than adding duplicates).

- [ ] **Step 4: Add the preload bridge**

In `src/preload/index.ts`, after the `worklog` block:

```ts
  activity: {
    read: (from: number, to: number) => ipcRenderer.invoke(CH.activityRead, from, to)
  },
```

Add `ActivityReport` to the `window.stoke` type declaration alongside the worklog one.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: clean. If the *web* half fails on a `node:` import, a `node:` module has leaked into `src/shared/**` — move it to `src/main`.

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/shared/ipc.ts src/main/index.ts src/preload/index.ts
git commit -m "Serve the activity report over one IPC channel, gated like the worklog"
```

---

### Task 7: The panel

**Files:**
- Create: `src/renderer/src/components/ActivityPanel.tsx`
- Modify: `src/renderer/src/styles/app.css`
- Modify: `src/renderer/src/App.tsx:1669-1683`

**Interfaces:**
- Consumes: `window.stoke.activity.read`, `ActivityReport`, `ActivitySlice`.
- Produces: `<ActivityPanel onClose={() => void} />`.

- [ ] **Step 1: Write the component**

Create `src/renderer/src/components/ActivityPanel.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { ActivityReport, ActivitySlice } from '@shared/types'
import { IconClose, IconRefresh } from './Icons'

type Period = 'today' | 'week' | 'lastWeek'

const PERIOD_LABEL: Record<Period, string> = {
  today: 'Today',
  week: 'This week',
  lastWeek: 'Last week'
}

/** Local midnight `days` ago, so a period is whole days rather than a rolling clock. */
function midnight(daysAgo: number): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d.getTime()
}

function range(period: Period): { from: number; to: number } {
  if (period === 'today') return { from: midnight(0), to: midnight(0) }
  if (period === 'week') return { from: midnight(6), to: midnight(0) }
  return { from: midnight(13), to: midnight(7) }
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}

export function ActivityPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [period, setPeriod] = useState<Period>('today')
  const [report, setReport] = useState<ActivityReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (p: Period): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const { from, to } = range(p)
      setReport(await window.stoke.activity.read(from, to))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(period)
  }, [load, period])

  const slices = report?.slices ?? []
  const totalMs = slices.reduce((n, s) => n + s.activeMs, 0)
  const totalLines = slices.reduce((n, s) => n + s.linesWritten, 0)
  const projects = new Set(slices.map((s) => s.project)).size
  const days = [...new Set(slices.map((s) => s.day))].sort().reverse()

  return (
    <section className="activity-panel" aria-label="Activity">
      <header className="activity-head">
        <h2 className="activity-title">Activity</h2>
        <button className="icon-btn" onClick={() => void load(period)} disabled={busy} title="Refresh">
          <IconRefresh />
        </button>
        <button className="icon-btn" onClick={onClose} title="Close">
          <IconClose />
        </button>
      </header>

      <div className="activity-periods" role="tablist">
        {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
          <button
            key={p}
            role="tab"
            aria-selected={p === period}
            className="activity-period"
            data-active={p === period ? 'true' : undefined}
            onClick={() => setPeriod(p)}
          >
            {PERIOD_LABEL[p]}
          </button>
        ))}
      </div>

      <p className="activity-total">
        {hours(totalMs)} · {totalLines.toLocaleString()} lines · {projects}{' '}
        {projects === 1 ? 'project' : 'projects'}
      </p>

      {/*
        The number has to be defensible, not merely quoted. Naming the gap is
        what lets someone answer "how is that measured?" without guessing.
      */}
      <p className="activity-note">
        Active Claude time — gaps over {Math.round((report?.idleGapMs ?? 0) / 60000)} min excluded. Lines
        are written/edited, not net.
      </p>

      {error && (
        <p className="activity-error" role="alert">
          {error}
        </p>
      )}

      {!!report?.skipped && (
        <p className="activity-note" role="status">
          {report.skipped} transcript{report.skipped === 1 ? '' : 's'} could not be read, so these totals
          are incomplete.
        </p>
      )}

      {!busy && !error && days.length === 0 && <p className="activity-empty">Nothing recorded.</p>}

      <div className="activity-days">
        {days.map((day) => {
          const forDay = slices.filter((s) => s.day === day)
          return (
            <div key={day} className="activity-day">
              <h3 className="activity-day-head">
                <span>{dayLabel(day)}</span>
                <span>{hours(forDay.reduce((n, s) => n + s.activeMs, 0))}</span>
              </h3>
              {forDay.map((slice: ActivitySlice) => (
                <div key={`${slice.sessionId}-${slice.day}`} className="activity-row">
                  <div className="activity-row-head">
                    <span className="activity-project truncate">{slice.project}</span>
                    <span className="activity-metric">{hours(slice.activeMs)}</span>
                    <span className="activity-metric">{slice.linesWritten.toLocaleString()} lines</span>
                  </div>
                  {slice.title && <p className="activity-row-title truncate">{slice.title}</p>}
                  {(report?.commits[`${slice.project}|${slice.day}`] ?? []).slice(0, 4).map((subject) => (
                    <p key={subject} className="activity-commit truncate" title={subject}>
                      · {subject}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}
```

- [ ] **Step 2: Add the styles**

Append to `src/renderer/src/styles/app.css`. Every colour is a custom property — no hex literals.

```css
/* --------------------------------------------------------------- activity */

.activity-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-8);
  width: 100%;
  min-width: 0;
  padding: var(--space-12);
  overflow-y: auto;
  background: var(--surface);
  border-left: 1px solid var(--border);
}

.activity-head {
  display: flex;
  align-items: center;
  gap: var(--space-8);
}

.activity-title {
  flex: 1 1 0%;
  min-width: 0;
  margin: 0;
  font-size: var(--fs-md);
  color: var(--text);
}

.activity-periods {
  display: flex;
  gap: var(--space-4);
}

.activity-period {
  flex: 1 1 0%;
  min-width: 0;
  padding: var(--space-4) var(--space-8);
  font-size: var(--fs-sm);
  color: var(--text-muted);
  background: transparent;
  border: 1px solid var(--border);
  border-radius: var(--r-sm);
  cursor: pointer;
}

.activity-period[data-active='true'] {
  color: var(--text);
  background: var(--surface-selected);
  border-color: var(--accent);
}

.activity-total {
  margin: 0;
  font-size: var(--fs-lg);
  color: var(--text);
}

.activity-note,
.activity-empty {
  margin: 0;
  font-size: var(--fs-xs);
  color: var(--text-faint);
}

.activity-error {
  margin: 0;
  font-size: var(--fs-sm);
  color: var(--danger);
}

.activity-days {
  display: flex;
  flex-direction: column;
  gap: var(--space-16);
}

.activity-day-head {
  display: flex;
  justify-content: space-between;
  margin: 0 0 var(--space-4);
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

.activity-row {
  padding: var(--space-8) 0;
  border-top: 1px solid var(--border);
}

.activity-row-head {
  display: flex;
  gap: var(--space-8);
  align-items: baseline;
}

/* flex:1 + min-width:0 is what lets a long name ellipsis instead of widening
   the shell. It only works because `.app` declares minmax(0, 1fr). */
.activity-project {
  flex: 1 1 0%;
  min-width: 0;
  color: var(--text);
}

.activity-metric {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  font-size: var(--fs-sm);
  color: var(--text-muted);
}

.activity-row-title,
.activity-commit {
  margin: var(--space-4) 0 0;
  font-size: var(--fs-xs);
  color: var(--text-muted);
}
```

**The variable names above are the real ones and matter.** CLAUDE.md gotcha 22:
a `var(--name)` that names nothing is invalid at computed-value time and the
declaration is silently dropped, so padding collapses to 0 and nothing errors.
The scale on this project is `--space-4/8/12/16/24` (px values), `--text`,
`--text-muted`, `--text-faint`, `--surface`, `--surface-selected`, `--border`,
`--accent`, `--danger`, `--r-sm`, and `--fs-xs/sm/md/lg`. Confirm with
`grep -oE '^\s*--[a-z0-9-]+:' src/renderer/src/styles/app.css | sort -u` before

- [ ] **Step 3: Swap the panel in**

In `src/renderer/src/App.tsx`, replace the `WorklogPanel` block (currently at `1669-1683`) with:

```tsx
        {worklogOpen && (
          <div style={{ width: 340, display: 'flex', flexShrink: 0 }}>
            <ActivityPanel onClose={() => setWorklogOpen(false)} />
          </div>
        )}
```

Change the import on line 31 from `WorklogPanel` to:

```tsx
import { ActivityPanel } from './components/ActivityPanel'
```

Leave `WorklogPrompt`, the queue state and the scan wiring alone — the Notion path stays in the tree, unused, per the spec.

- [ ] **Step 4: Typecheck and build**

Run: `npm run typecheck && npm run build`
Expected: clean. Unused-import errors on `WorklogPanel` mean the old import was left behind — remove it.

- [ ] **Step 5: Drive it in the real app**

Run `npm run dev`, open the panel, and check each period renders. Then confirm over CDP that the shell did not grow:

```bash
node scripts/cdp-eval.mjs "document.querySelector('.app').getBoundingClientRect().width"
```

Expected: equal to the window's inner width. A larger number means a row is pushing the grid — add `min-width: 0` to the offending text.

This step is not optional. Gotchas 31 and 34 both record behaviour that every pure suite passed and that only driving the built app revealed.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/components/ActivityPanel.tsx src/renderer/src/styles/app.css src/renderer/src/App.tsx
git commit -m "Show activity per day and per project, replacing the proposal queue panel"
```

---

## Self-Review

**Spec coverage.** Transcript spine → Tasks 1-4. Git corroboration → Task 5. Idle gap fixed and shown → Tasks 1 and 7. Churn labelled honestly → Tasks 2 and 7. No model call → nothing in any task calls one. Gate reuse → Task 6. Panel replaces the worklog panel → Task 7. Notion left in place → Task 7 Step 3 states it explicitly. Error handling table → Task 3 (unparseable line), Task 4 (unreadable transcript, `skipped`), Task 5 (no repo, slow git), Task 7 (empty vs failed are two different sentences). Verify suite cases 1-8 → Tasks 1-5, except cache invalidation which is Task 4's `clearActivityCache` check.

**Deliberately deferred, and stated in the spec:** "what do I have to work on" has no task. It is not derivable from transcripts and needs its own design pass.

**Type consistency.** `ActivitySlice` is declared once in `src/main/activity.ts` and mirrored in `src/shared/types.ts` for the renderer; the two must stay field-for-field identical. `readSessionActivity` (single) and `readActivity` (many, returns `{ slices, skipped }`) are distinct throughout. `commitSubjects(repoDir, day)` is used with that argument order in Task 6. The commits key is `` `${project}|${day}` `` in both Task 6 and Task 7.
