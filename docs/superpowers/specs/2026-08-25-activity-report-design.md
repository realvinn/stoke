# Answering "what have you been working on"

**Status:** designed, not implemented
**Date:** 2026-08-25

## The problem

The worklog already exists to answer this question and answers it in the wrong
place at the wrong price.

Today the path is: scan a session with a model (~$0.13), draft proposals into a
queue, wait for the user to accept one, then spawn a second model run to write
it to Notion. Measured on `claude` 2.1.237 on this machine, that write run
connects **30 MCP servers**, loads **397 tool definitions** and pays **26,023
cache-creation tokens** — $0.16 and ~15 seconds — to perform one API call whose
payload (title, body, status, destination) was already fully decided at scan
time. The model at write time decides nothing. It is a very expensive HTTP
client.

Meanwhile the actual need is smaller and more immediate: when a manager asks,
show what was worked on today, or this week, with enough substance — hours,
volume, and the names of the things — to be credible.

The current design cannot answer that question at all. It produces a review
queue of individual proposals, not a period summary, and it has no notion of
time spent or work volume.

## What we are building

A read-only **Activity** view over data that is already on this machine. No
model call, no network request, no third-party account, no token.

Measured against the real transcripts here: **19 work sessions parsed in 0.6
seconds**, producing per-day and per-project hours, lines and session titles.

Sample output from the real data:

```
╭─ TODAY
│  2.4h · 1,284 lines · 2 projects
│  Tue 25 Aug — 2.4h
│    Laro       1.3h  1284 lines  9 files   Vic Aluminium CRM job tracking system
│      · feat(auth): SEC-02 — magic-link sign-in
│      · feat(vic-aluminium): A6 — row-level job ownership, cover, and "my jobs"
│    Shopify    1.1h     0 lines  0 files   n8n workflow unsubscribe link
```

### Decisions taken

| Question | Decision |
| --- | --- |
| Where the numbers come from | Claude Code's own transcripts, as the spine. |
| Why not git as the spine | Coverage is partial. `ItemProcessor`, `oseo` and `ops` have no repository at all, and `ItemProcessor` alone is 18.4h and 5,642 lines of the sample. Git corroborates where it exists; it cannot lead. |
| Idle gap | **15 minutes**, fixed, and stated in the UI. |
| What "lines" means | **Lines written/edited** — churn, labelled as such. Net additions from git shown alongside where a repository exists. |
| Does it call a model | **No.** Session titles come from `aiTitle`, already written into every transcript by Claude Code. |
| Notion | Not written to. The existing code is left in place and unused; removing it is a separate decision. |
| Relationship to the worklog panel | **Replaces it.** Assumed from a "yes" to a recommendation rather than stated outright — if the intent was to keep both, this is the line to revisit. |
| Which projects are counted | The existing worklog gate (`Settings.worklogGroups`), so personal work stays off a manager-facing screen. |

## The evidence behind those decisions

Every figure below was measured on this machine on 2026-08-25, not estimated.

| Measurement | Result | What it decided |
| --- | --- | --- |
| Parse a 23 MB transcript | 0.5s with a regex/selective-parse strategy; **>2 min timeout** with `json.loads` per line | The parse strategy, below |
| All 19 work sessions | 0.6s total | That this can run on panel open with no cache, and instantly with one |
| One session's wall-clock span | 127.7h | That last-minus-first is not a usable definition of time worked |
| Same session, 5-min idle gap | 12.5h | |
| Same session, 15-min idle gap | 18.4h | That the gap must be one fixed, stated number |
| Transcript line count, same session | +5,642 / −186 | That transcript counts are churn, not net |
| Git commits in the same window | **none — no repository** | That git cannot be the spine |
| Git coverage across 10 work repos | 2 with real history (94, 54 commits), 4 with 1–2, **3 with no repo** | Same |

## Architecture

### `src/main/activity.ts` — new, pure

No `electron` import, so `scripts/verify-activity.mts` can run it directly under
`node --experimental-strip-types` the way the other main-process modules are
tested. Relative imports carry explicit `.ts` extensions and the module uses no
TypeScript parameter properties, per this repo's conventions.

```ts
export const IDLE_GAP_MS = 15 * 60 * 1000

export interface ActivitySlice {
  day: string            // local YYYY-MM-DD
  project: string        // folder name, or the group for a remote host
  sessionId: string
  title: string | null   // Claude Code's own aiTitle
  activeMs: number
  linesWritten: number   // churn, not net
  files: string[]
}

export async function readActivity(
  opts: { projects: string[]; from: number; to: number; idleGapMs?: number }
): Promise<ActivitySlice[]>
```

**The parse strategy is load-bearing and is the reason this is fast.** A
transcript here reaches 23 MB and is mostly large tool *results*, which this
feature never reads. So:

- timestamps are pulled with a regex over the raw bytes, never a JSON parse;
- `JSON.parse` runs only on lines that contain `"tool_use"`.

Parsing every line as JSON was measured and **timed out past two minutes** on a
single file. The selective strategy does the same file in 0.5s. Anyone
"simplifying" this into a `JSON.parse` per line will reintroduce a two-minute
panel.

The whole file is streamed rather than read head-and-tail like
`sessionFile.ts`'s `readLines`, because every timestamp matters, not just the
ends. Memory stays bounded because only timestamps and edit sizes are retained,
never the file.

**Caching.** Results are cached per transcript keyed on `path + mtimeMs + size`.
A finished session's numbers never change, so reopening the panel is free and
only the live session is re-read.

### `src/main/activityGit.ts` — corroboration, never a dependency

Commit subjects per repository per day, via `execFile('git', ['log', …])`.

Three rules, each from a scar in this repo:

- **Async with a deadline, never sync.** Gotcha 40: a synchronous `fs` call
  against a path on a sleeping external disk blocks the event loop and freezes
  the window. Work folders can live anywhere.
- **A missing repository is normal, not an error.** Three of ten work folders
  have none.
- **Git never blocks the report.** Subjects are resolved in parallel with a
  deadline; if git is slow the report renders without them.

### IPC

One channel, added to `src/shared/ipc.ts` first per convention:

```ts
activityRead: 'activity:read',
```

Handler in `src/main/index.ts` resolves the watched projects through the
existing gate (`shouldWatch` / `Settings.worklogGroups`) and returns the slices
plus git subjects for the requested period.

### Renderer — `ActivityPanel.tsx`

Replaces `WorklogPanel` in the same column. It is a sibling column inside
`.body-row`, never an overlay, because the docked browser is a native
`WebContentsView` that paints over all renderer DOM (gotcha 14).

Long titles and long file paths are the hazard here, and the protection already
exists: `.app` declares `grid-template-columns: minmax(0, 1fr)`
(`src/renderer/src/styles/app.css:250-264`), which is what lets a wide row clip
itself instead of pushing the whole shell wider than the window. A row of this
panel needs `flex: 1 1 0%` plus `min-width: 0` on its text to ellipsis rather
than push — neither of which helps if that grid rule is ever removed.

All colour through CSS custom properties. No Tailwind, no component library.

Period selector: **Today · This week · Last week**. Totals line, then per-day,
then per-project with the session title and any commit subjects beneath.

The idle gap is stated in the panel — "active time, gaps over 15 min excluded" —
so the number can be defended rather than merely quoted.

## Error handling

| Case | Behaviour |
| --- | --- |
| A transcript line will not parse | Skipped. It contributes nothing; the report still renders. |
| A whole transcript is unreadable | That session contributes nothing, and the panel says how many were skipped. Silent partial totals are the failure mode to avoid. |
| A project folder has no git | No commit subjects. Not an error, not surfaced as one. |
| `git log` is slow or fails | Report renders without subjects, past the deadline. |
| The period has no activity | "Nothing recorded" — distinct from "could not be read". Two different sentences, because one is a fact about the week and the other is a bug. |

## Testing — `scripts/verify-activity.mts`

The suite loads the real module. It does not re-implement the maths, which is
the standing complaint against `verify:selection` recorded in gotcha 10.

1. **Idle gap.** Gaps below the cap accumulate in full; gaps above it contribute
   exactly the cap, not zero and not their full length.
2. **A session spanning midnight.** Time is attributed to the day the gap
   *starts* in, and the two days sum to the session total.
3. **A session spanning six days.** The real `ItemProcessor` shape: wall-span
   127.7h must not be reported as time worked.
4. **Churn counting.** `Write` counts its `content` lines; `Edit` counts
   `new_string` lines; a tool call with no `file_path` counts nothing.
5. **An empty transcript** yields no slices and is not an error.
6. **A project with no git** yields no subjects and is not an error.
7. **Cache invalidation** on a changed `mtimeMs`, so a live session's numbers
   move.
8. **The gate.** A session in an unwatched group contributes nothing, so
   personal work cannot reach a manager-facing screen.

Added to the `check` chain in `package.json`.

## What this deliberately does not do

- **It does not delete the Notion write path.** That code stays, unused.
  Deleting is cheap later; un-deleting is not.
- **It cannot see work done outside Claude Code.** A day spent in meetings, in
  the Shopify admin, or editing in another editor is invisible. The panel
  reports "active Claude time", and the label must say so — a number presented
  as "hours worked" would be wrong and would eventually be caught being wrong.
- **It does not answer "what do I have to work on".** This is a real gap
  against the original ask, and it is deferred rather than solved: planned work
  is not derivable from transcripts, which are a record of the past. Candidate
  sources for a later pass are open git branches, the existing proposal queue,
  and `TODO`/`FIXME` markers — none of them good enough to design blind. Past
  and present ship first.

## Consequences elsewhere

Dropping Notion from the answer makes `WorklogSettings.tsx` — board targets,
data-source ids, ClickUp list ids, status vocabularies — dead weight. That is
the largest single contributor to the "too many words in settings" complaint,
and removing it is the natural first move of that separate piece of work.
