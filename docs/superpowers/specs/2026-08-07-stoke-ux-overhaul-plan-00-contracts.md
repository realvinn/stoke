# Stoke UX overhaul — plan section 0: shared contracts

**This file's path, cited by every other part:**
`docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-plan-00-contracts.md`.

**Reads with:** `docs/superpowers/specs/2026-08-07-stoke-ux-overhaul-design.md` (authoritative),
`CLAUDE.md`, `ARCHITECTURE.md`.

**Who this is for.** Six workstreams (A–F) are drafted in parallel. Everything named in this
section is shared by two or more of them. **Copy these names, paths and types verbatim.** Do not
rename, do not "improve", do not add a second spelling. If a workstream needs something this
section does not define, that is a gap to raise, not a licence to invent.

Tasks 1–5 below **must land before any workstream task runs**. They create the files A–F import.
Their order is **1, 2, 3, then 4a, then 5** — Task 4a's own verification step uses
`scripts/cdp-eval.mjs`, which Task 5 creates, so if 4a is executed first that one step waits for 5.

**Task numbering across the whole plan.** Contracts own 1–5. Workstream C owns 20–33, D 40–47,
B 61–66, E 68–79, A 81–94, F 109 and 112–122. No number is used twice; a part's own
cross-references ("see Task NN") mean the number in that range.

> **Line numbers in this part are hints, not addresses.** Four workstreams insert
> into `src/renderer/src/App.tsx`, `src/renderer/src/styles/app.css`,
> `src/main/index.ts`, `src/renderer/src/components/TitleBar.tsx`,
> `src/renderer/src/components/Sidebar.tsx` and four verify suites, so any figure
> written as "currently line N" is correct only for the first task that runs.
> **Locate every edit by the quoted text**, not by the number: for CSS, by the
> selector (`grep -n "^\.project-meta {" src/renderer/src/styles/app.css`); for
> TS/TSX, by a unique quoted line from the block being replaced; for the verify
> suites, by the file's closing two lines (`` console.log(`\n${failures ? …}`) `` and
> the `process.exitCode` assignment), inserting immediately above them. If the
> quoted text is not found, stop — a prerequisite task has not landed or has
> landed differently, and guessing at the location is how two parts silently
> overwrite each other.

---

## 0.1 Decisions, stated once

| # | Question | Decision |
|---|---|---|
| 1 | How does the statusLine wrapper hand data to main? | **One JSON file per session** in `<tmpdir>/stoke/statusline/<sessionId>.json`, written temp+rename by a wrapper run through **`process.execPath` with `ELECTRON_RUN_AS_NODE=1`** via a 3-line platform shim. Read on the `ContextWatcher` tick that already runs. |
| 2 | How does the renderer learn a session is worklog-watched? | New channel `worklog:watchChanged` pushing the **whole list** `WorklogWatchState[]`, plus a pull `worklog:watch`. |
| 3 | Where does per-project metadata live? | `Settings.projectMeta: Record<string, ProjectMeta>` keyed by `Project.path`. `pinnedProjects` / `hiddenProjects` are **not** merged into it and do not change. |
| 4 | How are worklog boards configured? | `Settings.worklogBoards: WorklogBoards`, default `targets: ['notion']`. |
| 5 | What is the spacing scale? | `--space-4/8/12/16/24/32/48`. The whole `--sp-*` block is **deleted**, not renumbered. |
| 6 | Renderer access to cwd→group→profile? | **Move the pure rule to `src/shared/paths.ts`.** Not IPC. `gate.ts` becomes the main-process face of it. |

---

## 0.2 Contract A — statusLine payload and channel

### Why a file, and why that runner

Four mechanisms were considered against the two hard constraints — it must work on macOS and
Windows, and the CLI runs the command **through a shell** on every status-line render (roughly
every 300 ms):

- **A unix socket** — no Windows equivalent that a shell one-liner can write to.
- **`curl` POST to the existing loopback MCP server** — `curl.exe` only ships on Windows 10 1803+,
  and pass-through would have to tee stdin, which no portable one-liner does.
- **A pure shell wrapper** (`cat > file` / `more > file`) — `more` paginates and re-wraps, and
  `findstr` truncates lines past ~8 KB. Both mangle the payload silently, which is the exact
  failure class this repo is full of.
- **A Node wrapper run by Stoke's own Electron binary** — chosen. `ELECTRON_RUN_AS_NODE=1` turns
  `process.execPath` into a plain node, so there is no dependency on a system `node`, `python`,
  `curl` or PowerShell. It is real JavaScript, so it can do temp+rename and pass-through properly,
  **and `scripts/verify-statusline.mts` can execute the very same file under plain `node`.**

Three further points that pin the design:

1. **The session id is passed on argv, not parsed out of the payload.** `pty.ts` already mints
   the id before spawning (`pty.ts:137`), so the wrapper never has to read the JSON it is copying.
   That is what keeps the wrapper trivial and the routing exact.
2. **The command string in the settings JSON contains a quoted path and a quoted uuid and nothing
   else.** Every shell metacharacter lives inside the shim file. This is what makes gotcha 13
   inapplicable: `spawnSpec` never sees the command, because it travels inside a `--settings`
   **file**, and the shell that does see it finds no `&`, `|`, `<` or `>` to eat.
3. **One `--settings` file per session, carrying both keys.** Spec §2.3: a second `--settings`
   silently discards the first. `ultracodeSettingsFile()` is therefore replaced, not joined.

### Types — add to `src/shared/types.ts`

Add a new section after the `ContextSnapshot` block. Snake_case is kept for the wire shape on
purpose: it is the CLI's format, and renaming it would hide the day the CLI changes it.

```ts
/* -------------------------------------------------------------- statusline */

/**
 * The JSON Claude Code pipes to a `statusLine` command on stdin, as captured
 * from 2.1.221. Every field is optional because this is somebody else's wire
 * format: a CLI that drops one must degrade to the older inference, never throw.
 */
export interface StatusLinePayload {
  session_id?: string
  transcript_path?: string
  cwd?: string
  version?: string
  model?: StatusLineModel
  context_window?: StatusLineContextWindow
  /** True once the session is past the 200k tier boundary. Billing-adjacent. */
  exceeds_200k_tokens?: boolean
  rate_limits?: StatusLineRateLimits
}

export interface StatusLineModel {
  id?: string
  display_name?: string
}

export interface StatusLineContextWindow {
  /**
   * The window this session actually has, stated by the CLI rather than
   * inferred. 1000000 for Opus 5, 200000 for Haiku — per model, and correct
   * from token zero, which is the whole reason this channel exists.
   */
  context_window_size?: number
  used_percentage?: number
  current_usage?: StatusLineUsage
}

export interface StatusLineUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** `resets_at` is epoch **seconds**, not ms. Convert once, at the edge. */
export interface StatusLineRateLimit {
  used_percentage?: number
  resets_at?: number
}

export interface StatusLineRateLimits {
  five_hour?: StatusLineRateLimit
  seven_day?: StatusLineRateLimit
}

/** One rate-limit window, in Stoke's own units. */
export interface StatusLineWindowReading {
  /** 0-100. */
  percent: number
  /** Epoch **ms**, converted from the payload's seconds. Null when absent. */
  resetsAt: number | null
}

/**
 * What the main process hands the renderer, once. Flat, camelCase, and in ms —
 * so no component ever has to know the wire shape or the seconds/ms boundary.
 */
export interface StatusLineSnapshot {
  sessionId: string
  /** context_window_size, or null when this CLI did not state one. */
  contextWindowSize: number | null
  /** 0-100, as the CLI computed it. Null when absent. */
  usedPercentage: number | null
  modelId: string | null
  modelName: string | null
  exceeds200k: boolean
  fiveHour: StatusLineWindowReading | null
  sevenDay: StatusLineWindowReading | null
  /** Epoch ms the payload file was written. Drives the "as of HH:MM" tooltip. */
  receivedAt: number
}
```

### Module — `src/main/statusLine.ts` (new)

**Owner: workstream E, Tasks 69–74.** Nothing outside E creates this file or
`scripts/verify-statusline.mts`. This section is the contract those tasks satisfy; it is not a
task, and there is no contracts task that lands it.

Main-process module. Relative imports carry `.ts`; no TypeScript parameter properties. **Exactly
twelve exports**, and this list is the whole surface:

```ts
/** Where the wrapper, the shim and every session's payload live. */
export function statusLineDir(): string

/** `<statusLineDir()>/<sessionId>.json`. */
export function statusLinePayloadFile(sessionId: string): string

/**
 * Rewrite `wrapper.mjs` and the platform shim, and return the shim's path.
 *
 * Both files are rewritten UNCONDITIONALLY on every call — never "if they are
 * missing". `process.execPath` moves when the app updates, so a cached shim
 * survives an update pointing at a deleted Electron, and that fails as an empty
 * status line: it looks exactly like it working. A temp sweeper deleting them is
 * the second reason.
 *
 * On POSIX it calls `chmodSync(shim, 0o755)` explicitly AFTER the write.
 * writeFileSync's `mode` only applies when the file is created, so a rewrite
 * would otherwise be left unexecutable.
 *
 * It never throws. See writeSessionSettingsFile for where the loud failure lives.
 */
export function writeStatusLineWrapper(): string

/**
 * The `statusLine.command` string for one session. A quoted absolute path and a
 * quoted session id, and nothing else — no `sh`, no `call`, no shell
 * metacharacter of any kind:
 *
 *   darwin/linux:  "<dir>/run.sh" "<sessionId>"      (chmod 0755 by writeStatusLineWrapper)
 *   win32:         "<dir>\run.cmd" "<sessionId>"     (the CLI runs it through cmd.exe /c, so a bare .cmd needs no `call`)
 *
 * The body is exactly:
 *
 *   return `"${join(statusLineDir(), shimName())}" "${key(sessionId)}"`
 */
export function statusLineCommand(sessionId: string): string

export interface SessionSettingsInput {
  sessionId: string
  ultracode: boolean
  /** Settings.hideStatusLine. When false the user's own line is passed through. */
  hideStatusLine: boolean
  /**
   * The user's own `statusLine.command` from ~/.claude/settings.json, for
   * pass-through. Empty means they have none and there is nothing to pass.
   */
  passthroughCommand: string
}

/** The object written to the per-session --settings file. Pure; testable. */
export function sessionSettingsJson(input: SessionSettingsInput): Record<string, unknown>

/**
 * Write `<statusLineDir()>/<sessionId>.settings.json` — or
 * `<statusLineDir()>/default.settings.json` when there is no id — and return its
 * path, or null when neither key is needed, in which case no `--settings` is
 * emitted at all.
 *
 * One directory for all three of a session's files, because the generated
 * wrapper resolves both the payload file and the platform shim from its own
 * `dirname(fileURLToPath(import.meta.url))`, and clearSessionFiles deletes all
 * three siblings out of statusLineDir().
 */
export function writeSessionSettingsFile(input: SessionSettingsInput): string | null

/** Delete a session's settings, pass-through and payload files. Called on pty exit. */
export function clearSessionFiles(sessionId: string): void

/** Parse a payload file into a snapshot. Null when missing or unreadable. */
export function readStatusLine(sessionId: string): StatusLineSnapshot | null

/** Pure, so the verify suite covers the seconds→ms and missing-field paths. */
export function toSnapshot(
  sessionId: string,
  payload: StatusLinePayload,
  receivedAt: number
): StatusLineSnapshot

/**
 * The user's own `statusLine.command` from their settings.json, read never
 * written, so it can be passed through when the line is not suppressed.
 * Consumed by `launchSession` in index.ts (E Task 73).
 */
export function userStatusLineCommand(settingsFile?: string): string

/**
 * The context window for a session: the payload first, the banner second, null
 * third. Consumed by index.ts and by scripts/verify-context.mts. Named rather
 * than inlined because a lambda inside a constructor call is the one shape no
 * suite in this repo can reach.
 */
export function windowFor(sessionId: string, bannerWindow: number | null): number | null
```

`sessionSettingsJson` produces, for `{ sessionId: 'sid', ultracode: true, hideStatusLine: true }`:

```json
{ "ultracode": true, "statusLine": { "type": "command", "command": "\"…/run.sh\" \"sid\"" } }
```

Never `"statusLine": null` — spec §2.3 measured that as a blocking `SettingsError` dialog.

**The empty-object rule, stated once.** The body is exactly:

```ts
export function sessionSettingsJson(input: SessionSettingsInput): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (input.ultracode) out.ultracode = true
  if (input.sessionId) {
    out.statusLine = { type: 'command', command: statusLineCommand(input.sessionId) }
  }
  return out
}
```

So `sessionSettingsJson({ sessionId: '', ultracode: false, hideStatusLine: false,
passthroughCommand: '' })` deep-equals `{}` — nothing to say means no `--settings` at all — and a
session **with** an id always gets the `statusLine` key. `hideStatusLine` is deliberately **not**
read here: it selects what goes in the pass-through file, not whether the statusLine key exists,
because the payload is how Stoke reads the context window at all.

**Where the loud failure lives.** `writeSessionSettingsFile` catches and returns null; `buildArgs`
then falls back to `ultracodeSettingsFile()`, which *does* throw — so the one case that must stay
loud, a session that promised ultracode and did not get it, still is.

### `buildArgs` change — `src/main/cli.ts`

```ts
export function buildArgs(opts: LaunchOptions, settingsFile: string | null = null): string[]
```

- When `settingsFile` is non-null, emit `--settings <settingsFile>` **exactly once** and do not
  call `ultracodeSettingsFile()`.
- When it is null, behave exactly as today.
- `ultracodeSettingsFile()` stays exported and unchanged, so nothing that imports it breaks; the
  live path stops calling it.

`pty.ts` computes the file and passes it. Nothing else changes in `buildArgs`.

### Feeding the context meter

`ContextWatcher`'s second constructor argument in `src/main/index.ts` (currently
`(sessionId) => ptys?.bannerWindowFor(sessionId) ?? null`) becomes exactly:

```ts
(sessionId) => windowFor(sessionId, ptys?.bannerWindowFor(sessionId) ?? null)
```

**Not an inline `readStatusLine(...) ?? ...` lambda.** A lambda inside a constructor call is
unreachable from `scripts/verify-context.mts`, and this three-way precedence is the whole point of
the channel. `windowFor` is that same rule as a named, tested export (§0.2).

`contextLimitFor(model, observedTokens, statedLimit)` in `sessionFile.ts` is **unchanged**. Its
third parameter simply gets a better source. Both fallbacks are retained (spec §3).

### `src/shared/statusLine.ts` (new shared module, no Node imports)

Created by **E Task 76**. Both `UsageMeter.tsx` (renderer) and `scripts/verify-usage.mts` (plain
node) read it, so it cannot live in `src/main` and must not import Node. Extensionless relative
type import: `import type { StatusLineSnapshot, UsageWindow } from './types'`.

```ts
export const FIVE_HOUR_MS: number
export const SEVEN_DAY_MS: number
export function elapsedFraction(resetsAt: number | null, windowMs: number, now: number): number | null
export function statusLineWindows(snap: StatusLineSnapshot, now: number): UsageWindow[]
```

### Channels

| Constant | Channel | Direction | Payload |
|---|---|---|---|
| `CH.statusLineUpdate` | `statusline:update` | main → renderer | `StatusLineSnapshot` |
| `CH.statusLineLast` | `statusline:last` | invoke | `Promise<StatusLineSnapshot \| null>` |

`statusline:update` fires from the same `ContextWatcher` tick, and **only when the payload file's
mtime changed** — otherwise it would push an identical object every 1.5 s per session.
`statusline:last` returns the most recent snapshot from **any** session, so the usage chip has
something to show with no session open (spec §3, accepted trade-off).

### Setting

`Settings.hideStatusLine: boolean`, default **`true`** — "Hide Claude's status line in Stoke".

---

## 0.3 Contract B — the worklog watch signal

Workstream A draws a red dot inside the context ring; workstream C produces the signal. This is
the seam.

### Types — `src/shared/types.ts`, in the worklog section

```ts
/** Why a session is, or is not, the worklog agent's business. */
export type WorklogWatchReason =
  /** Its folder's group is in Settings.worklogGroups. */
  | 'watched-group'
  /** It runs over SSH on a host with `worklog: true`. */
  | 'watched-host'
  /** worklogGroups is empty and no host is ticked — the feature is off entirely. */
  | 'off'
  /** A group resolved, but the user does not watch it. */
  | 'unwatched-group'
  /** No project and no scan root contains the cwd, so there is no group to check. */
  | 'unknown-folder'
  /** An SSH session on a host the user has not ticked. */
  | 'unwatched-host'

/**
 * Whether the worklog may look at one session, and why.
 *
 * The `reason` is not decoration: spec §2.4.4 records that "working but nothing
 * to report" and "never ran" were indistinguishable, and this is the field that
 * separates them. Every surface that says anything about watching reads it.
 */
export interface WorklogWatchState {
  sessionId: string
  watched: boolean
  reason: WorklogWatchReason
  /** The resolved project group, or the SSH host's label. Null when neither. */
  group: string | null
  /** True when the session runs on another machine, where the switch is per host. */
  remote: boolean
  /** Epoch ms this was decided. */
  decidedAt: number
}

/** How a scan ended. `budget` is separate from `error` on purpose (spec §4 C.3). */
export type WorklogScanOutcome = 'proposed' | 'nothing' | 'budget' | 'error'

/**
 * The last thing a scan did, so an empty panel can say which of the four it was.
 */
export interface WorklogScanReport {
  sessionId: string
  at: number
  /** True when nobody pressed anything. */
  auto: boolean
  outcome: WorklogScanOutcome
  /** Proposals added. Always 0 unless outcome is 'proposed'. */
  added: number
  /** Non-null for 'budget' and 'error'. Shown to the user verbatim. */
  message: string | null
}
```

### Channels

| Constant | Channel | Direction | Payload |
|---|---|---|---|
| `CH.worklogWatch` | `worklog:watch` | invoke | `Promise<WorklogWatchState[]>` |
| `CH.worklogWatchChanged` | `worklog:watchChanged` | main → renderer | `WorklogWatchState[]` |
| `CH.worklogScanned` | `worklog:scanned` | main → renderer | `WorklogScanReport` |
| `CH.worklogLastScan` | `worklog:lastScan` | invoke | `Promise<WorklogScanReport \| null>` |

**The whole list, every time.** `worklog:watchChanged` carries every state, never a delta — the
same rule `worklogChanged` already follows and for the same stated reason: two copies of the same
records drift (`types.ts`, `WorklogProposedEvent`).

**Domain.** One entry per session id in the `sessionCwds` map (`index.ts:69`) — that is every
session started this run, live or exited, which is exactly the set the gate has to answer for
(closing a tab does not stop tracking; `autoscan.ts` header).

**When it fires.** Four triggers, all in `index.ts`:

1. Immediately after a successful `CH.ptyStart`, once `sessionCwds` has the new id.
2. From the existing `onSettingsChanged` listener — unconditionally, on any settings write. The
   computation is one project-list read and settings changes are user-paced.
3. After `CH.projectsAdd`, `CH.projectsAddRoot` and `CH.projectsHide` persist, because each can
   change which group a cwd resolves to.
4. Once on `win.webContents` `did-finish-load`, so a cold renderer is not blank until something
   else happens.

**One rule, at two layers.** The dot in the tab strip and the run that costs money must never be
able to disagree, so there is exactly one decision function — but it is pure, and a thin gatherer
feeds it live state:

- **`src/main/worklog/watch.ts`** (new module, C Task 27) —
  `export function watchStateFrom(input: WatchInput): WorklogWatchState`. Pure, no I/O, the sole
  rule, exercised by `scripts/verify-worklog-gate.mts`. Also exports `WatchInput` and `WatchHost`.
- **`src/main/index.ts`** (C Task 28) — `async function watchStateFor(sessionId: string):
  Promise<WorklogWatchState>`, `async function watchStates(): Promise<WorklogWatchState[]>`, and
  `function sendWatchStates(): void`. Thin gatherers: they read live settings, projects and hosts
  and call `watchStateFrom`.

`AutoScanner`'s `watched` callback (`index.ts:353-368` today) becomes:

```ts
  watched: async (sessionId) => {
    if (!getSettings().worklogAuto) return false
    return (await watchStateFor(sessionId)).watched
  },
```

**`WatchHost`**, in `src/main/worklog/watch.ts`, is a `Pick` and not a restatement:

```ts
import type { SshHost } from '@shared/types'

/**
 * The part of an SSH host the gate reads.
 *
 * Declared as a Pick of SshHost rather than restated, because index.ts passes
 * hostForSession() straight in: if SshHost ever drops or renames one of these,
 * the typecheck fails here instead of the host gate silently widening.
 */
export type WatchHost = Pick<SshHost, 'label' | 'alias' | 'worklog'>
```

which resolves to `{ label: string; alias: string; worklog?: boolean }`.

### API surface — `src/shared/api.ts`, inside `worklog`

```ts
    /** Which sessions the agent may look at, and why. */
    watch(): Promise<WorklogWatchState[]>
    onWatchChanged(cb: (states: WorklogWatchState[]) => void): () => void
    /** The last scan of any session, for the panel's empty state. */
    lastScan(): Promise<WorklogScanReport | null>
    onScanned(cb: (report: WorklogScanReport) => void): () => void
```

**Derived title-bar state (A owns the pixels, this owns the rule).** Badged wins, ahead of
everything, including the feature being switched off — turning the agent off must not hide
proposals the user has not ruled on, because the button is the only route back to them. The
worklog button is:

- `badged` when the queue holds one or more `status: 'pending'` proposals;
- `watching` when any state has `watched === true`;
- `disarmed` in every remaining case, including when there are no states at all.

which is exactly this body, in `src/renderer/src/components/TitleBar.tsx` (C Task 30):

```ts
export function worklogButtonState(
  states: WorklogWatchState[],
  pending: number
): WorklogButtonState {
  if (pending > 0) return 'badged'
  return states.some((s) => s.watched) ? 'watching' : 'disarmed'
}
```

The per-tab ring dot is drawn when, and only when, that tab's `sessionId` has a
`WorklogWatchState` with `watched === true`.

**One App-level copy of the list, and one subscription.** `src/renderer/src/App.tsx` holds

```ts
const [worklogWatch, setWorklogWatch] = useState<WorklogWatchState[]>([])
const [worklogLastScan, setWorklogLastScan] = useState<WorklogScanReport | null>(null)
```

written by **C Task 29 Step 7**, which is the sole writer of the bootstrap effect's worklog
subscriptions (`const offWatch = window.stoke.worklog.onWatchChanged(setWorklogWatch)` and
`void window.stoke.worklog.watch().then(setWorklogWatch)`). Anything else that needs the list
derives from `worklogWatch` — A Task 85 adds only a `useMemo` over it. Two App-level copies is
precisely the drift the "whole list, never a delta" rule exists to prevent.

---

## 0.4 Contract C — per-project metadata

### Types — `src/shared/types.ts`

```ts
/**
 * What the user has said about one folder, over and above what Claude's own
 * files record. Keyed by `Project.path`.
 *
 * Deliberately **not** the home of `pinned` or `hidden`. Those are already
 * persisted as path arrays on real machines, and folding them in here would make
 * "hidden" and "has an emoji" the same record — so clearing an emoji could
 * resurrect a project the user hid. `addedManually` is the only key that affects
 * membership, and it only ever adds.
 */
export interface ProjectMeta {
  /** One emoji shown before the name. Absent means none. */
  emoji?: string
  /** Replaces the folder's basename in the sidebar. Absent means use the basename. */
  label?: string
  /**
   * The user picked this folder themselves, so `listProjects` must emit it even
   * with no Claude history and no scan root covering it. Spec §2.5: there was no
   * source that could represent a single explicitly added folder.
   */
  addedManually?: boolean
}
```

`Project` gains three fields, so no component ever joins two structures:

```ts
  /** ProjectMeta.emoji for this path, or null. */
  emoji: string | null
  /** ProjectMeta.label, or null when the basename is in use. */
  label: string | null
  /** True when this project exists only because the user added the folder. */
  addedManually: boolean
```

> Note for drafters: `scripts/verify-worklog-gate.mts` builds a `Project` literal. `scripts/` is
> in neither tsconfig `include`, and types are erased under strip-types, so this is not a
> compile break — but the three fields go onto that fixture anyway so the file stays honest.
> **Task 1 Step 1 does it**, and `scripts/verify-profiles.mts` gets the same treatment in B Task 61
> Step 1. Do not add them a second time.

### Setting

```ts
  /** Per-folder metadata, keyed by `Project.path`. See ProjectMeta. */
  projectMeta: Record<string, ProjectMeta>
```

Default: `{}`.

### Exactly how `hydrate` validates and repairs it

Lives in `src/main/settingsSchema.ts` (Task 3 extracts it out of `store.ts`, so it can be tested
without Electron). Copy verbatim:

**The caps and the trimming live in exactly one file.** `src/main/projectMeta.ts` (D Task 40)
exports

```ts
export const MAX_EMOJI_CHARS = 16
export const MAX_LABEL_CHARS = 64
/** Null — not `{}` — for a record that says nothing, so the caller's drop test
 *  is `if (entry)` and cannot be written as `Object.keys(entry).length`. */
export function tidy(meta: ProjectMeta): ProjectMeta | null
```

and `settingsSchema.ts` imports it: `import { tidy } from './projectMeta.ts'`. Do **not** restate
the two numbers here, and do not re-derive the trimming — two copies of the same magic numbers in
two files, with a comment in one asserting they agree, is how they stop agreeing.
`scripts/verify-settings.mts` and `scripts/verify-folders.mts` then test one implementation.

```ts
import { tidy } from './projectMeta.ts'

function hydrateProjectMeta(raw: unknown): Record<string, ProjectMeta> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, ProjectMeta> = {}
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    // Same normalisation as Project.path: trimmed, no trailing separator. A key
    // written by hand with one would never match a lookup.
    const key = path.trim().replace(/[\\/]+$/, '')
    if (!key || !value || typeof value !== 'object') continue
    // One implementation of the caps, the trim and the literal-true rule for
    // addedManually, shared with the IPC write path. See projectMeta.ts.
    const entry = tidy(value as Partial<ProjectMeta>)
    // An entry that says nothing is dropped — tidy returns null for it — so the
    // file cannot accumulate an empty object for every folder that was ever
    // right-clicked.
    if (entry) out[key] = entry
  }
  return out
}
```

Wired into `hydrateSettings` as `projectMeta: hydrateProjectMeta(r.projectMeta)`.

**Interaction with `pinnedProjects` / `hiddenProjects`:** none. Both keep their current shape,
their current hydration (`Array.isArray(...) ? ... : []`) and their current IPC handlers
byte-for-byte. `projectMeta` is read *alongside* them in `listProjects`, in this order:

1. build the project list as today (Claude history, then scan roots);
2. append one synthetic `Project` for every `projectMeta` key with `addedManually === true` that
   the list does not already contain (compared with `pathKey`, §0.7);
3. stamp `emoji`, `label`, `addedManually` onto every project from its metadata record;
4. apply `hiddenProjects` and `pinnedProjects` exactly as today, **after** step 2 — so a manually
   added folder can still be hidden.

### Channel

| Constant | Channel | Direction | Payload |
|---|---|---|---|
| `CH.projectsMeta` | `projects:meta` | invoke | `(path: string, meta: ProjectMeta \| null) => Promise<Settings>` |

`null` deletes the whole record — which, for a folder that only existed because
`addedManually` was set, is also how it leaves the sidebar. One channel, one meaning.

API: `projects.setMeta(path: string, meta: ProjectMeta | null): Promise<Settings>`.

---

## 0.5 Contract D — the worklog target setting

### Types — `src/shared/types.ts`

```ts
/**
 * Where the worklog files things, and which board in each.
 *
 * Replaces the compiled-in ids at runner.ts:37-38. An id belongs in settings
 * because it is one person's board: shipping it in the binary meant nobody else
 * could use the feature and this machine could not narrow to one destination.
 */
export interface WorklogBoards {
  /** Destinations, in canonical order. Empty means the worklog writes nowhere. */
  targets: WorklogTarget[]
  /** Notion data source URI, e.g. `collection://<uuid>`. */
  notionDataSource: string
  /** ClickUp list id, as digits. */
  clickupListId: string
}
```

### Defaults — `src/shared/worklog.ts` (new shared module, no Node imports)

Both `settingsSchema.ts` and `worklog/runner.ts` need these, and `runner.ts` runs under
strip-types, so this cannot live in a module that imports Electron.

```ts
import type { WorklogBoards, WorklogTarget } from './types'

/** Canonical order. Persisted lists are filtered through it, so what is stored
 *  cannot change the order anything is written in. */
export const WORKLOG_TARGETS: readonly WorklogTarget[] = ['notion', 'clickup']

/**
 * Notion only, by default.
 *
 * The ClickUp id is kept rather than blanked even though it is unused: it is a
 * real, working list, so ticking ClickUp later is one checkbox instead of a hunt
 * through a URL bar. A default that is present-but-unused costs nothing.
 */
export const DEFAULT_WORKLOG_BOARDS: WorklogBoards = {
  targets: ['notion'],
  notionDataSource: 'collection://368d3f2d-1f02-817c-b193-000b208e36bd',
  clickupListId: '901615258684'
}
```

`runner.ts` keeps its exports so no importer breaks, but they become re-exports:

```ts
export const NOTION_DATA_SOURCE = DEFAULT_WORKLOG_BOARDS.notionDataSource
export const CLICKUP_LIST_ID = DEFAULT_WORKLOG_BOARDS.clickupListId
```

imported as `import { DEFAULT_WORKLOG_BOARDS } from '../../shared/worklog.ts'` — relative, with
the explicit `.ts`, following the precedent recorded at `src/main/mcp/design.ts:11-16`.

### Setting and hydration

```ts
  /** Which boards the worklog writes to, and their ids. See WorklogBoards. */
  worklogBoards: WorklogBoards
```

Default `DEFAULT_WORKLOG_BOARDS`. In `settingsSchema.ts`:

```ts
function hydrateWorklogBoards(raw: unknown): WorklogBoards {
  const d = DEFAULT_WORKLOG_BOARDS
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...d, targets: [...d.targets] }
  }
  const r = raw as Partial<WorklogBoards>
  const notionDataSource =
    typeof r.notionDataSource === 'string' ? r.notionDataSource.trim() : d.notionDataSource
  const clickupListId =
    typeof r.clickupListId === 'string' ? r.clickupListId.trim() : d.clickupListId
  const asked = Array.isArray(r.targets) ? (r.targets as unknown[]) : [...d.targets]
  return {
    // Filtered through WORKLOG_TARGETS rather than trusted, so the write order
    // is canonical whatever order the file happened to hold — and so a typo
    // cannot name a destination no write tool exists for.
    //
    // A destination with no id is not a destination. Dropping it here means the
    // runner never has to check, and the settings sheet shows the truth.
    targets: WORKLOG_TARGETS.filter(
      (t) => asked.includes(t) && (t === 'notion' ? notionDataSource : clickupListId).length > 0
    ),
    notionDataSource,
    clickupListId
  }
}
```

**Every read site takes the settings value.** `runWorklogScan` (`index.ts:228-235`) passes
`settings.worklogBoards.clickupListId` / `.notionDataSource` into `recall`, and
`WRITE_ORDER` in `runner.ts` is intersected with `settings.worklogBoards.targets` before any
write. `WRITE_ORDER` itself stays `['clickup', 'notion']` — that ordering is a separate,
documented decision about which half of a half-failure is worth keeping.

---

## 0.6 Contract E — the spacing, line-height and icon tokens

### The scale

The `--sp-1 … --sp-8` block at `src/renderer/src/styles/app.css:54-61` is **deleted**, and this
replaces it:

```css
  /* Strict 4px scale. Named for the pixel value at scale 1, so a rule states
     its own geometry and a wrong one is obvious on sight. */
  --space-4: 0.25rem;
  --space-8: 0.5rem;
  --space-12: 0.75rem;
  --space-16: 1rem;
  --space-24: 1.5rem;
  --space-32: 2rem;
  --space-48: 3rem;
```

**Why new names rather than renumbering.** `--sp-4` currently means 12px; on a value-named scale
it would mean 4px. A rule missed during migration would silently shrink by 8px and nothing would
error. With `--space-*`, a missed `var(--sp-2)` resolves to nothing, the declaration is invalid at
computed-value time, and the padding visibly collapses to 0 — loud, and greppable. `--sp-` must
return zero hits in `src/renderer/` when the migration is done.

### Old → new, every current value

| Old | Old px | New | New px | Uses today | Note |
|---|---|---|---|---|---|
| `--sp-1` | 4 | `--space-4` | 4 | 16 | unchanged |
| `--sp-2` | 6 | `--space-8` | 8 | 51 | **+2px** |
| `--sp-3` | 8 | `--space-8` | 8 | 41 | unchanged |
| `--sp-4` | 12 | `--space-12` | 12 | 17 | unchanged |
| `--sp-5` | 16 | `--space-16` | 16 | 6 | unchanged |
| `--sp-6` | 20 | `--space-24` | 24 | 1 | **+4px** |
| `--sp-7` | 28 | `--space-24` | 24 | 2 | **−4px** |
| `--sp-8` | 40 | `--space-48` | 48 | 0 | defined for completeness |

`--sp-2` rounds **up**, not down. It is the most-used token in the file and it is overwhelmingly
the inner padding of controls; rounding to 4px collapses control heights below the 28px the tab
strip and title bar are built on, which is the opposite of the uniform control height spec §2.11
asks for. `--sp-7` rounds **down**: both uses are settings-sheet section gaps, where 32px reads as
a break rather than a gap.

Consequence to expect, and the reason spec §4 F.6 says every screen is reviewed afterwards:
**92 declarations become 8px** and three become 24px. That is the visible density change.

`src/remote/style.css:526` has one `var(--sp-2, 8px)` whose token is not defined in that file, so
it already renders at 8px. Change it to a literal `8px`. The phone bundle is a separate build and
does not import the desktop tokens; nothing there needs migrating.

### Line height

There is no token today and `body` sets none; five ad-hoc values are in use.

```css
  --lh-tight: 1.25;   /* single-line controls: tab labels, chips, buttons */
  --lh-snug: 1.4;     /* headings, and two-line list rows */
  --lh-normal: 1.55;  /* body copy: prompts, proposal text, settings help */
```

`body` gains `line-height: var(--lh-normal)`.

Mapping for the seven existing declarations (line numbers are the current file and will shift —
migrate by **value**):

| Current value | Lines today | New |
|---|---|---|
| 1.4 | 1284 | `var(--lh-snug)` |
| 1.45 | 2011 | `var(--lh-normal)` |
| 1.5 | 1731 | `var(--lh-normal)` |
| 1.55 | 1060, 1302 | `var(--lh-normal)` |
| 1.6 | 1373, 1907 | `var(--lh-normal)` |

`--lh-tight` is new capacity, applied by workstream A to `.tab-label` and by F to `.pill` and
`.btn`; nothing currently maps onto it.

### Icon size

```css
  /* rem, so an icon grows with Interface scale. Today every icon is a px
     attribute, which is why scale 1.0 → 1.6 moved every button 37.5% and left
     every glyph exactly where it was. */
  --icon-xs: 0.625rem;  /* 10px at scale 1 */
  --icon-sm: 0.75rem;   /* 12px */
  --icon-md: 0.875rem;  /* 14px */
  --icon-lg: 1rem;      /* 16px */
```

**The mechanism, so six drafters do not each invent one.** `Base` in
`src/renderer/src/components/Icons.tsx` stops emitting `width` and `height` attributes and gains
a class:

```tsx
function Base(props: SVGProps<SVGSVGElement>): React.JSX.Element {
  const { children, className, ...rest } = props
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}
```

and app.css gains:

```css
/* One rule sizes every icon. A container states its size by setting
   --icon-size; nothing passes a pixel count through a React prop. */
.icon {
  width: var(--icon-size, var(--icon-lg));
  height: var(--icon-size, var(--icon-lg));
  flex: none;
}
```

Call sites drop `width={n} height={n}` entirely and the **container's** rule sets `--icon-size`,
e.g. `.tab-close { --icon-size: var(--icon-sm); }`. `{...rest}` stays last so the one genuine
non-icon case (`width={180}`, a QR code, not an `Icons.tsx` glyph) can still override.

Attribute → token mapping for the sites that exist today:

| Attribute | Sites | Token |
|---|---|---|
| 10 | 1 | `--icon-xs` |
| 11 | 1 (`.tab-close`) | `--icon-sm` (12px) |
| 12 | 5 | `--icon-sm` |
| 13 | 8 | `--icon-md` (14px) |
| 16 (`Base` default) | the rest | `--icon-lg` |

### The remaining untokenised colours

Spec §2.11 lists three literals and four `#fff`. Add to `:root`, with light-appearance overrides
in the existing `:root[data-appearance='light']` block:

```css
  /* dark */
  --scrim: rgb(0 0 0 / 0.42);
  --swatch-ring: rgb(0 0 0 / 0.25);
  --shadow-panel: 0 12px 32px rgb(0 0 0 / 0.45);
  /* Text on a --danger fill. NOT white: recomputed from src/shared/themes.ts,
     #ffffff on --danger measures 2.89 (Ember), 2.84 (Nocturne), 2.70 (Moss) and
     6.01 (Daylight) — three of four fail 4.5:1, and two of those three sites are
     button text. var(--bg) measures 6.50, 6.66, 6.85 and 5.46: all four clear it.
     Mirrored by an assertion in scripts/verify-color.mts. */
  --on-danger: var(--bg);
```

```css
  /* light */
  --scrim: rgb(0 0 0 / 0.28);
  --swatch-ring: rgb(0 0 0 / 0.16);
  --shadow-panel: 0 12px 32px rgb(0 0 0 / 0.16);
```

There is **no `--on-danger` line in the `:root[data-appearance='light']` block.** Daylight's own
`--bg` (`#f4f4f5`) already clears 4.5:1 on its `--danger`, so the one declaration covers both
appearances, and a second spelling is a second thing to keep in sync.

`scripts/verify-color.mts` asserts, for every theme in `THEMES`:

```ts
/** --on-danger: var(--bg) in app.css. If you change one, change the other. */
contrastRatio(parseColor(theme.tokens.bg)!, parseColor(theme.tokens.danger)!) >= 4.5
```

Sites, by what they are today:

| Today | Becomes |
|---|---|
| `.backdrop { background: rgb(0 0 0 / 0.42) }` | `var(--scrim)` |
| `.theme-chip { border: 1px solid rgb(0 0 0 / 0.25) }` | `var(--swatch-ring)` |
| `.usage-panel { box-shadow: 0 12px 32px rgb(0 0 0 / 0.45) }` | `var(--shadow-panel)` |
| `.win-btn[data-variant='close']:hover { color: #fff }` | `var(--on-danger)` |
| `.btn[data-variant='danger']:hover { color: #fff }` | `var(--on-danger)` |
| `.segmented button[data-danger='true'][aria-pressed='true'] { color: #fff }` | `var(--on-danger)` |
| `.usage-pace { background: #fff }` | `var(--text)` — **no new token**; a white pace marker is invisible on a light theme, and `--text` already flips |

### Tokens two or more workstreams share

```css
  /* A fixed slot for the tab indicator, so the empty circle, the filled ring
     and the ring-plus-dot are all the same width and the label never moves. */
  --tab-indicator: 0.875rem;   /* 14px */
  /* The only red in the tab strip: "the worklog is watching this session". */
  --tab-dot-worklog: var(--danger);
  /* A nearly-full context ring. No longer --danger: red means one thing now. */
  --ring-full: var(--warning);
  /* macOS traffic lights are fixed device px, so their clearance must be too.
     A rem here is why Stoke only laid out correctly at Interface scale 1.0. */
  --traffic-lights-w: 78px;
  /* A selected row must out-rank a hovered one in every theme. The mix is
     mirrored as SELECTED_ACCENT_MIX in scripts/verify-color.mts; change one and
     you must change the other, which is what that assertion is for. */
  --surface-selected: color-mix(in srgb, var(--accent) 18%, var(--surface-hover));
  /* The disclosure chevron's box, and the metadata picker's. Four rules have to
     agree with it — the two buttons, the project metadata's indent and where the
     session list's guide rule falls. It was an inline style in Sidebar.tsx,
     which is exactly how they drifted apart. */
  --chevron: 1.125rem;
  /* One height for every single-line control: .btn, .input, .select, .segmented. */
  --control-h: 1.75rem;
```

These last three are declared **here**, by contracts Task 4a, and not by the workstream task that
first uses them. Declaring a token in the middle of a workstream is how a later part invents
`--row-selected` or hardcodes `28px`. Declaring them in Task 4a moves no pixel, because nothing
references them until the task that lands the rules using them.

`app.css:216`'s `padding-left: 4.875rem` becomes `padding-left: var(--traffic-lights-w)`.
78px is 4.875rem × 16, so the appearance at scale 1.0 is unchanged and every other scale is fixed.

### `uiScale` clamp — `src/shared/ui.ts` (new)

Both the settings write path (`store.ts`) and `SettingsSheet.tsx` need the same bounds, and a
number input's `min`/`max` are advisory inside React's `onChange` (spec §2.11).

```ts
/** Interface scale bounds. Below 0.8 the title bar clips; above 1.6 the
 *  940px minimum window can no longer hold the launcher. */
export const UI_SCALE_MIN = 0.8
export const UI_SCALE_MAX = 1.6
export const FONT_SIZE_MIN = 9
export const FONT_SIZE_MAX = 24

/** Clamp anything to a usable interface scale. NaN and junk become 1. */
export function clampUiScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, n))
}

/** Same, for the terminal font size. */
export function clampFontSize(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 13
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)))
}
```

Applied in `hydrateSettings`: `uiScale: clampUiScale(r.uiScale)`, `fontSize: clampFontSize(r.fontSize)`.
Because `setSettings` re-hydrates its own patch (`store.ts:152`), that one line clamps every
write path in the app, including the one in `SettingsSheet.tsx:128`.

---

## 0.7 Contract F — cwd → group → profile, shared not IPC

### The decision, and why

Move the pure rule into **`src/shared/paths.ts`**. Not IPC:

- The renderer already holds `Project[]` and `Settings`, so an IPC round trip adds a channel, a
  cache and a staleness bug in exchange for a string comparison.
- Duplicating the longest-prefix rule in the renderer is exactly what spec §4 B.2 forbids.
- `src/shared/**` is compiled by **both** tsconfigs. `tsconfig.web.json` gives it `lib: ES2023,
  DOM` and `types: ["vite/client"]` — **no Node types.** So the shared module must not
  `import 'node:path'` and must not touch `process`. It takes the platform's rules as an argument
  instead, which is also what lets the renderer pass `window.stoke.platform`.
- Shared modules use **extensionless** relative imports (`from './types'`), matching
  `src/shared/profiles.ts`. `src/main` imports shared **values** with a relative path and an
  explicit `.ts` (`from '../../shared/paths.ts'`), per the precedent at `src/main/mcp/design.ts:11-16`
  — the `@shared/*` alias is fine for type-only imports, which strip-types erases, but a value
  import of it would break `node scripts/verify-worklog-gate.mts`.

### `src/shared/paths.ts` (new)

Written by contracts Task 1 Step 3, whose copy is the one to execute. Every executable line below
is byte-identical to it; the two differ only in the wording of some doc comments, and in that this
block also shows `GroupOwner` and `profileIdForCwd`, which **B Task 42 appends** and contracts
Task 1 deliberately does not create.

```ts
/**
 * The cwd → project group rule, in the one place both processes can run it.
 *
 * The switch this answers is per project *group* — the parent folder name that
 * already separates `personal` from `gitea-company` on this machine — and it is
 * read off the session's own working directory, **never** off the profile chip
 * in the sidebar. That distinction is the whole point of this module. The chip
 * is a view filter: a Work session can be running in a background tab while the
 * user browses Personal, so keying off the chip would either skip that session
 * or, worse, hand a personal session to an agent that files it into a work
 * tracker. Both failures are silent — the wrong sessions get logged, or none do
 * — which is why the rule lives in one small, tested module rather than inline
 * at each call site.
 *
 * It sits in `src/shared` rather than in `src/main/worklog/gate.ts` because the
 * renderer needs the same answer for the profile chip, and a second
 * implementation over there is exactly how the longest-prefix bug below got in.
 *
 * Everything here is pure and touches neither disk, Electron nor `process`, so
 * `scripts/verify-worklog-gate.mts` and `scripts/verify-profiles.mts` exercise
 * it under `node --experimental-strip-types` with no app running — and so
 * `tsconfig.web.json`, which gives `src/shared` no Node types, still compiles
 * it. The platform is passed in; it is never read.
 */
import type { Project } from './types'

/**
 * How this OS compares paths.
 *
 * Passed in rather than read off `process`, because this module is compiled for
 * the renderer too, where there is no `process` — and because case-folding on
 * macOS is a real fix, not a detail: APFS is case-insensitive by default, and
 * gate.ts folded only on Windows.
 */
export interface PathRules {
  sep: '/' | '\\'
  caseInsensitive: boolean
}

/** `process.platform` in main, `window.stoke.platform` in the renderer. */
export function pathRulesFor(platform: string): PathRules {
  return {
    sep: platform === 'win32' ? '\\' : '/',
    caseInsensitive: platform === 'win32' || platform === 'darwin'
  }
}

/**
 * Native separators, trailing ones removed. Same rule as normalize() in
 * projects.ts, because the paths compared here were written by it.
 *
 * The empty string stays empty, and that is contractual: a `new` tab's cwd is
 * `''`, an empty prefix matches every path, and a value that survived as `'/'`
 * would hand every New tab the first project in the list.
 */
export function normalizePath(p: string, rules: PathRules): string {
  const trimmed = p.trim()
  if (!trimmed) return ''
  const native =
    rules.sep === '\\' ? trimmed.replace(/\//g, '\\') : trimmed.replace(/\\/g, '/')
  // A path that is nothing but separators — `/`, or `\\` — keeps them rather
  // than normalising to the empty string, which every prefix test matches.
  // `G:\\` becomes `G:`, and still compares correctly: everything under it
  // starts `G:\\`.
  return native.replace(/[\\/]+$/, '') || native
}

/** Comparison key: normalised, and case-folded where the OS is. */
export function pathKey(p: string, rules: PathRules): string {
  const n = normalizePath(p, rules)
  return rules.caseInsensitive ? n.toLowerCase() : n
}

/**
 * Is `child` the same folder as `parent`, or inside it? Separator-guarded, so
 * `…/Stoke` never claims `…/Stoke-old`. An empty parent or child is inside
 * nothing — that is the empty-cwd guard, stated once and reused below.
 */
export function isInside(parent: string, child: string, rules: PathRules): boolean {
  const parentKey = pathKey(parent, rules)
  const childKey = pathKey(child, rules)
  if (!parentKey || !childKey) return false
  if (childKey === parentKey) return true
  const prefix = parentKey.endsWith(rules.sep) ? parentKey : parentKey + rules.sep
  return childKey.startsWith(prefix)
}

/**
 * Last path segment, either separator, ignoring trailing ones. Rules-free on
 * purpose: it is also handed paths that crossed the remote bridge from a machine
 * whose separator is not this one.
 */
export function basenameOf(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * The segment before the last — which is what `Project.group` is. Empty for a
 * path whose parent is the filesystem root, because `/` has no name and
 * inventing one would put every top-level folder in a group.
 */
export function parentName(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut <= 0) return ''
  return basenameOf(trimmed.slice(0, cut))
}

/**
 * Group names are folded on every platform. They are display strings the user
 * can retype, so `Personal` and `personal` are one switch even on a
 * case-sensitive filesystem. Canonical home; profiles.ts re-exports it.
 */
export function foldGroup(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Resolve a working directory to the `Project.group` that owns it.
 *
 * Three steps, in this order:
 *
 *  1. Longest-prefix match over `projects`, **skipping any project whose own
 *     path is one of `roots`**. A scan root is a container of projects, not a
 *     project; Claude registered it only because a session was once started
 *     there. Without that skip, `/Users/thevinh/dev/work` — itself a registered
 *     project — swallows every sibling under it and answers with group `dev`,
 *     which is spec §2.4.3 exactly.
 *  2. The longest `root` that contains the cwd. The group is `basenameOf(root)`,
 *     because a project directly inside that root would have had
 *     `parentName(path)` — the root's own name.
 *  3. Null. The group is never invented from the shape of the path: any folder
 *     under a directory called `personal` would otherwise be treated as that
 *     profile's work.
 */
export function groupForCwd(
  cwd: string,
  projects: Project[],
  rules: PathRules,
  roots: string[] = []
): string | null {
  if (!pathKey(cwd, rules)) return null

  const rootKeys = new Set(
    roots.map((r) => pathKey(r, rules)).filter((k) => k !== '')
  )

  let best: Project | null = null
  let bestLength = -1
  for (const project of projects) {
    const projectKey = pathKey(project.path, rules)
    if (!projectKey) continue
    // Step 1's skip. A root that is also a registered project is still a root.
    if (rootKeys.has(projectKey)) continue
    if (!isInside(project.path, cwd, rules)) continue
    // Longest match wins, so a project nested inside another beats its parent.
    if (projectKey.length > bestLength) {
      best = project
      bestLength = projectKey.length
    }
  }

  if (best) {
    // `group` is normally already `parentName(path)` (projects.ts:163).
    // Recompute when it is absent rather than reporting "no group": a Project can
    // be rebuilt by hand — a test fixture, or a record that crossed the remote
    // bridge — and losing the group there would silently switch the agent off.
    return best.group || parentName(normalizePath(best.path, rules)) || null
  }

  let bestRoot = ''
  let bestRootLength = -1
  for (const root of roots) {
    const rootKey = pathKey(root, rules)
    if (!rootKey) continue
    if (!isInside(root, cwd, rules)) continue
    if (rootKey.length > bestRootLength) {
      bestRoot = root
      bestRootLength = rootKey.length
    }
  }
  if (bestRoot) return basenameOf(normalizePath(bestRoot, rules)) || null

  return null
}

/**
 * The two fields of a profile the cwd→profile rule needs.
 *
 * Structural rather than an import of `ResolvedProfile`, so paths.ts stays a
 * leaf — profiles.ts already imports this module. `ResolvedProfile` and
 * `ProfileConfig` are both structurally assignable to it, so the renderer can
 * pass `availableProfiles` straight in.
 *
 * Appended by B Task 42, not by contracts Task 1.
 */
export interface GroupOwner {
  id: string
  groups: string[]
}

/**
 * Which profile owns the work in `cwd`, or null. Null means LEAVE THE CHIP
 * ALONE (spec §4 B.3), not "select nothing". Appended by B Task 42.
 */
export function profileIdForCwd(
  cwd: string,
  projects: Project[],
  roots: string[],
  profiles: GroupOwner[],
  platform: string
): string | null {
  const group = groupForCwd(cwd, projects, pathRulesFor(platform), roots)
  if (!group) return null
  const key = foldGroup(group)
  const owner = profiles.find((p) => p.groups.some((g) => foldGroup(g) === key))
  return owner ? owner.id : null
}
```

**Two guarantees the empty string needs**, because after A Task 57 every window has at least one
`kind: 'new'` tab whose `cwd` is `''`, and both B Task 46's profile-follows-tab effect and C Task
28's `watchStates` call the rule with it. An empty prefix matches every path, so without these the
first project in the list wins and the chip and the watch dot both lie:

- `normalizePath('', rules) === ''`
- `groupForCwd('', projects, rules, roots) === null`

`src/shared/profiles.ts` deletes its own `foldGroup` body and re-exports:
`export { foldGroup } from './paths.ts'` — **with the extension**; see Task 1 Steps 5–5c.
Every existing importer is unaffected.

### `src/main/worklog/gate.ts` after the move

The file keeps its header comment — with one sentence added recording that the path arithmetic now
lives in `src/shared/paths.ts` so the renderer can apply the identical rule without a second
implementation — and it keeps its exported names and their arities. It becomes the main-process
face of the shared rule:

```ts
import {
  foldGroup,
  groupForCwd as groupForCwdShared,
  pathRulesFor,
  type PathRules
} from '../../shared/paths.ts'
import type { Project } from '@shared/types'

/** This machine's comparison rules, resolved once. */
export const GATE_RULES: PathRules = pathRulesFor(process.platform)

export { foldGroup }

export function groupForCwd(cwd: string, projects: Project[], roots: string[] = []): string | null {
  return groupForCwdShared(cwd, projects, GATE_RULES, roots)
}

/** Whether a group is one the user asked the worklog agent to watch. */
export function isWatchedGroup(group: string | null, worklogGroups: string[]): boolean {
  if (!group) return false
  const wanted = foldGroup(group)
  if (!wanted) return false
  return worklogGroups.some((g) => foldGroup(g) === wanted)
}

/**
 * The gate itself: should the worklog agent review a session running in `cwd`?
 *
 * Note what this signature does *not* take: the active profile. There is
 * nowhere to pass the sidebar selection in, by design.
 *
 * An empty `worklogGroups` — the shipped default — watches nothing at all. Off
 * has to be genuinely off, or the first launch after an update would start
 * spending tokens on every session without anyone asking for it.
 */
export function shouldWatch(
  cwd: string,
  projects: Project[],
  worklogGroups: string[],
  roots: string[] = []
): boolean {
  if (worklogGroups.length === 0) return false
  return isWatchedGroup(groupForCwd(cwd, projects, roots), worklogGroups)
}
```

**`shouldWatch.length` stays 3.** A default-valued parameter does not count toward
`Function.length`, so `verify-worklog-gate.mts:166` — the assertion that the sidebar chip cannot
be passed in — keeps passing unchanged and keeps meaning what it says. Do not turn `roots` into a
required fourth argument.

`index.ts` passes `getSettings().projectRoots` at both call sites (`index.ts:223` and `:367`).

### Renderer side — `src/renderer/src/lib/projectProfile.ts` (new)

**The whole file is exactly these two lines** (plus its doc comment), created by B Task 42 Step 5:

```ts
export { profileIdForCwd, type GroupOwner } from '@shared/paths'
export { profileFor, type ResolvedProfile } from '@shared/profiles'
```

The body lives in `src/shared/paths.ts` and nowhere else. A renderer-local implementation would
resolve the `@shared/*` alias, which `node scripts/verify-profiles.mts` cannot — and an untested
path rule is exactly how the gate got its longest-prefix bug. One import site for the renderer, no
second implementation.

The renderer's `@shared/*` alias is configured in `tsconfig.web.json` and resolved by Vite, so
extensionless alias imports are correct here — this is the renderer, not a strip-types module.

### `Tab` — `src/renderer/src/types.ts`

Three workstreams read this record and **contracts Task 2 Step 6a is the one step that writes it**
— it is `src/renderer/src/types.ts`, not `src/shared/types.ts`, and no other task in the plan
touches that file. Pinned here so A Tasks 50/53/57/58/60 and F Task 67 all read one shape:

```ts
// No `SessionMeta` in this import: tsconfig.web.json sets noUnusedLocals, and
// the sessions list deliberately does not live on Tab — see below.
import type { EffortLevel, PermissionMode } from '@shared/types'

/** A New Project tab has no PTY yet; every session tab does. */
export type TabKind = 'session' | 'new'

/** A live terminal tab. Distinct from Claude's own session record. */
export interface Tab {
  id: string
  kind: TabKind
  /** Empty string on a `new` tab, which has no process. */
  ptyId: string
  /** Claude Code session id — the key the context meter watches. Empty on `new`. */
  sessionId: string
  /** For an SSH tab this is the host alias, not a path. See hostId. */
  cwd: string
  projectName: string
  /** Falls back to the project name until Claude generates an ai-title. */
  title: string
  /** Kept live: updated from ContextSnapshot.permissionMode, not frozen at launch. */
  permissionMode: PermissionMode
  model: string
  effort: EffortLevel
  status: 'running' | 'exited'
  exitCode: number | null
  /**
   * `SshHost.id` when this session runs on another machine, else null.
   *
   * The only reliable signal that `cwd` is an alias rather than a folder, which
   * is what stops profile-follows-tab from mapping an SSH session to whatever
   * project happens to share its alias's name.
   */
  hostId: string | null
  /** Per-tab launcher selection, so several New Project tabs can be open at once. */
  selectedPath: string | null
  expandedPath: string | null
}
```

`sessions: SessionMeta[]` does **not** move onto `Tab`. It is fetched list data, and two tabs
showing the same project would hold two copies that drift. It becomes one App-level cache keyed
by path:

```ts
const [sessionsByPath, setSessionsByPath] = useState<Record<string, SessionMeta[]>>({})
```

`TabDescriptor` in `src/shared/types.ts` gains the matching field, since the remote surface reads it:

```ts
  /** SshHost.id when this session runs on another machine. */
  hostId?: string
```

### `ContextSnapshot` gains the live permission mode

Spec §2.7: `tab.permissionMode` is captured at launch and no writer ever updates it, so toggling
with Shift+Tab leaves it stale. The transcript already carries `permission-mode` records and the
watcher already parses the transcript, so this costs nothing new:

```ts
  /** Newest `permission-mode` record in the transcript, or null when none. */
  permissionMode: PermissionMode | null
```

`ContextSnapshot` is in `src/shared/types.ts`; `PermissionMode` is already declared above it in
the same file.

---

## 0.8 Every new IPC channel, in one place

Added to `src/shared/ipc.ts` in the sections shown. **Add here first** (CLAUDE.md).

```ts
  // projects & sessions
  projectsMeta: 'projects:meta',

  // statusline channel (see docs/.../design.md §3)
  statusLineUpdate: 'statusline:update',
  statusLineLast: 'statusline:last',

  // worklog
  worklogWatch: 'worklog:watch',
  worklogWatchChanged: 'worklog:watchChanged',
  worklogScanned: 'worklog:scanned',
  worklogLastScan: 'worklog:lastScan',
```

## 0.9 Every new Settings key, in one place

```ts
  /** Per-folder metadata, keyed by `Project.path`. See ProjectMeta. */
  projectMeta: Record<string, ProjectMeta>
  /** Which boards the worklog writes to, and their ids. See WorklogBoards. */
  worklogBoards: WorklogBoards
  /**
   * Replace Claude's own status line with Stoke's silent wrapper.
   *
   * On by default: the wrapper is how the context window and the plan limits
   * reach the app at all, and the line it suppresses is a duplicate of chrome
   * Stoke already draws. Off passes the user's own command through unchanged.
   */
  hideStatusLine: boolean
```

Defaults: `{}`, `DEFAULT_WORKLOG_BOARDS`, `true`.

## 0.10 Every new module and cross-part name, and who creates it

Nothing below is created by a contracts task except where it says so. The point of the table is
that no two parts invent two spellings for the same thing.

| Module | Created by | Exports two or more parts read |
|---|---|---|
| `src/shared/paths.ts` | **contracts Task 1** | `PathRules`, `pathRulesFor`, `normalizePath`, `pathKey`, `isInside`, `basenameOf`, `parentName`, `foldGroup`, `groupForCwd` — then `GroupOwner` and `profileIdForCwd`, appended by **B Task 42** |
| `src/shared/worklog.ts` | **contracts Task 2** | `WORKLOG_TARGETS`, `DEFAULT_WORKLOG_BOARDS`; appended by C Tasks 29 and 30 |
| `src/shared/ui.ts` | **contracts Task 2** | `UI_SCALE_MIN/MAX`, `FONT_SIZE_MIN/MAX`, `clampUiScale`, `clampFontSize` |
| `src/main/settingsSchema.ts` | **contracts Task 3** | `DEFAULT_SETTINGS`, `hydrateSettings` |
| `scripts/cdp-eval.mjs` | **contracts Task 5** | the probe every measurement step in A, C, D, E and F runs |
| `src/main/statusLine.ts` | **E Task 7**, extended by E Tasks 8 and 9 | the twelve exports in §0.2, incl. `userStatusLineCommand` and `windowFor` |
| `src/shared/statusLine.ts` | **E Task 14** | `FIVE_HOUR_MS`, `SEVEN_DAY_MS`, `elapsedFraction`, `statusLineWindows` |
| `src/main/worklog/watch.ts` | **C Task 27** | `WatchInput`, `WatchHost`, `watchStateFrom` |
| `src/main/worklog/sessionStore.ts` | **C Task 33** | `StoredSession`, `sessionStateFile`, `readSessionState`, `writeSessionState`, `MAX_STORED_SESSIONS`, `STORED_SESSION_MAX_AGE_MS` |
| `src/main/projectMeta.ts` | **D Task 34** | `MAX_EMOJI_CHARS`, `MAX_LABEL_CHARS`, `tidy` |
| `src/renderer/src/lib/projectProfile.ts` | **B Task 42** | two re-export lines and nothing else (§0.7) |

Names declared in `src/main/index.ts` that another part reads: `watchStateFor`, `watchStates`,
`sendWatchStates` (all C Task 28). Name declared in `TitleBar.tsx` that another part reads:
`worklogButtonState` (C Task 30).

---

> **Everything below this line is superseded. Do not execute it.**
> `docs/superpowers/plans/2026-08-07-stoke-ux-overhaul.md` carries the live copy of contracts
> Tasks 1–5, and its Task 1 Step 3 holds the complete `src/shared/paths.ts` — body and all — that
> §0.7 above specifies. Where the two differ, the plan wins. This copy is kept only because §0.1–
> §0.10 above cite it by step number; read it as history.

## Task 1: Move the path rule into `src/shared/paths.ts`

- [ ] **Step 1: Extend the gate suite with the cases the shared rule must satisfy.**
  Open `/Users/thevinh/dev/personal/stoke/scripts/verify-worklog-gate.mts`. Add `GATE_RULES` to the
  existing `import { … } from '../src/main/worklog/gate.ts'` line (locate it by that quoted
  specifier, not by a line number).

  First, **stop the `project()` fixture going stale.** Contracts Task 2 adds three required fields
  to `Project`. Find the fixture by its `function project(` line and give every literal it builds
  the three new keys, so the file stays honest even though `scripts/` is typechecked by neither
  project:

  ```ts
    emoji: null,
    label: null,
    addedManually: false
  ```

  Then append these blocks immediately before the file's final two lines — the
  `` console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`) `` and the
  `process.exitCode` assignment. Anchor on those two lines, never on a line number:

  ```ts
  console.log('\na scan root is not a project')
  /*
   * `/Users/thevinh/dev/work` is itself a registered Claude project on the real
   * machine, so the longest-prefix rule matched it and answered `dev` for every
   * sibling under it — 7 of 12 work folders were unwatched. A root is a
   * container of projects, not a project.
   */
  const withRoot: Project[] = [...projects, project(root, isWin ? 'G:' : 'vinn')]
  check(
    'a folder under a scan root resolves to the root name, not the root parent',
    groupForCwd(p('unregistered-repo'), withRoot, [root]),
    'Code'
  )
  check(
    'and a real project inside the root still wins over the root fallback',
    groupForCwd(p('gitea-company', 'refinity'), withRoot, [root]),
    'gitea-company'
  )
  check(
    'with no roots passed, an unregistered folder still resolves to nothing',
    groupForCwd(p('unregistered-repo'), projects),
    null
  )
  /*
   * After A Task 90a every window holds at least one `kind: 'new'` tab whose cwd
   * is the empty string, and both B Task 65's profile effect and C Task 28's
   * watchStates call this rule with it. An empty prefix matches every path, so
   * without the guard the first project in the list wins — and the profile chip
   * and the watch dot both lie about a tab that has no folder at all.
   */
  check('an empty cwd resolves to no group rather than the first project', groupForCwd('', projects, []), null)

  console.log('\nthe signature the sidebar chip cannot reach through')
  check('shouldWatch still reports three required parameters', shouldWatch.length, 3)
  check(
    'a folder under a watched root is watched even with no history of its own',
    shouldWatch(p('unregistered-repo'), withRoot, ['Code'], [root]),
    true
  )

  console.log('\nmacOS folds case like Windows does')
  check(
    'the rules for this platform',
    GATE_RULES.caseInsensitive,
    process.platform === 'win32' || process.platform === 'darwin'
  )
  if (process.platform === 'darwin') {
    check(
      'a differently-cased path matches on APFS',
      shouldWatch(p('GITEA-COMPANY', 'Refinity'), projects, WATCHED),
      true
    )
  }
  ```

  Also change the existing `else` branch at lines 152-158 so it only runs on Linux:
  replace `} else {` with `} else if (process.platform !== 'darwin') {`.

- [ ] **Step 2: Run it and watch it fail.**
  `cd /Users/thevinh/dev/personal/stoke && node scripts/verify-worklog-gate.mts`
  Expected: `SyntaxError: The requested module '../src/main/worklog/gate.ts' does not provide an
  export named 'GATE_RULES'`.

- [ ] **Step 3: Create `src/shared/paths.ts`** with the **full body** of `normalizePath`,
  `pathKey`, `isInside`, `basenameOf`, `parentName`, `foldGroup` and `groupForCwd` — every
  signature in §0.7 except `GroupOwner` and `profileIdForCwd`, which B Task 61 appends. Declarations
  alone are not acceptable: four workstreams import this module. No Node imports, no `process`,
  extensionless `import type { Project } from './types'`.

  Two behaviours the body must guarantee, and §0.7 states as contract:
  `normalizePath('', rules) === ''`, and `groupForCwd('', projects, rules, roots) === null` — the
  empty-cwd case Step 1 now asserts.

- [ ] **Step 4: Rewrite `src/main/worklog/gate.ts`** to the body given in §0.7, deleting its local
  `normalizePath`, `pathKey`, `foldGroup` and the longest-prefix loop. Keep the file's header
  comment; add a sentence recording that the rule now lives in `src/shared/paths.ts` so the
  renderer can apply it without a duplicate.

- [ ] **Step 5: Re-export `foldGroup` from `src/shared/profiles.ts`.** Locate its body by the
  `export function foldGroup` line, delete it, and put this in its place, keeping the doc comment
  above it:

  ```ts
  /*
   * Relative with an explicit `.ts`, even though this is a shared module and the
   * rest of them import extensionlessly. Extensionless works only for type-only
   * imports, which are erased — this is a value re-export, and
   * `node scripts/verify-profiles.mts` loads this file directly under
   * --experimental-strip-types, where './paths' resolves to nothing. Both
   * tsconfigs allow the extension after Steps 5a and 5b.
   */
  export { foldGroup } from './paths.ts'
  ```

  This is the **first value import between two shared modules** in the tree. Extensionless it dies
  at import time with `ERR_MODULE_NOT_FOUND`; with the extension, `tsc -p tsconfig.web.json`
  rejects it with `TS5097` until the next two steps. Both were measured, not reasoned.

- [ ] **Step 5a: Turn the flag on in the web project.** In
  `/Users/thevinh/dev/personal/stoke/tsconfig.web.json`, replace

  ```json
    "isolatedModules": true,
  ```

  with

  ```json
    "isolatedModules": true,
    // A shared module that value-imports another shared module has to carry the
    // .ts extension: those files are also executed directly by node's
    // strip-types mode from the verify suites, where an extensionless relative
    // specifier resolves to nothing. Vite resolves the extension the same way.
    // Legal because this project is noEmit. tsconfig.node.json already sets it —
    // that is the precedent recorded at src/main/mcp/design.ts:11-16.
    "allowImportingTsExtensions": true,
  ```

- [ ] **Step 5b: Do the same in the root config, so the editor agrees.** In
  `/Users/thevinh/dev/personal/stoke/tsconfig.json`, replace

  ```json
    "isolatedModules": true,
  ```

  with

  ```json
    "isolatedModules": true,
    // Matches tsconfig.web.json — this file is what an editor loads, and without
    // it every shared .ts import is underlined in red while both real projects
    // compile cleanly.
    "allowImportingTsExtensions": true,
  ```

- [ ] **Step 5c: Typecheck.** `npm run typecheck` exits 0 with no output. Without 5a it fails with
  a line naming `src/shared/profiles.ts` and ending
  `error TS5097: An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled.`

- [ ] **Step 6: Run it and watch it pass.**
  `node scripts/verify-worklog-gate.mts` → `all pass`, then
  `node scripts/verify-profiles.mts` → `all pass`.

- [ ] **Step 7: Prove the bundlers still resolve it.** `npm run build` exits 0. A resolution
  failure here would be a Vite error naming `src/shared/profiles.ts`, not a silent one.

- [ ] **Step 8: Commit.**
  `git commit -m "Share the cwd→group rule with the renderer, and stop a scan root eating its siblings"`
  Body records: a registered project that is also a scan root claimed every sibling under it and
  answered with its parent's name, so 7 of 12 work folders were never watched; macOS now folds
  path case, which APFS has always done; and the first value import between two shared modules had
  no working spelling until both tsconfigs set `allowImportingTsExtensions`, which is what
  `src/main` has always relied on.

## Task 2: Land the shared types and channels

- [ ] **Step 1: Add every type in §0.2–§0.7 to `src/shared/types.ts`.** The statusline block goes
  after `ContextSnapshot`; `ProjectMeta` goes with `Project`; `WorklogWatchState`,
  `WorklogWatchReason`, `WorklogScanOutcome` and `WorklogScanReport` go in the worklog section;
  the three new `Settings` keys go in `Settings`; `Project` gains `emoji`, `label`,
  `addedManually`; `TabDescriptor` gains `hostId?`; `ContextSnapshot` gains `permissionMode`.

- [ ] **Step 2: Create `src/shared/worklog.ts`** with `WORKLOG_TARGETS` and
  `DEFAULT_WORKLOG_BOARDS` exactly as in §0.5.

- [ ] **Step 3: Create `src/shared/ui.ts`** with the four constants and two functions from §0.6.

- [ ] **Step 4: Add the seven channels to `src/shared/ipc.ts`** exactly as in §0.8.

- [ ] **Step 5: Run the typecheck and watch it fail.**
  `npm run typecheck`
  Expected, from `tsconfig.node.json`: `src/main/projects.ts(…): error TS2739: Type '{ path: string; … }' is missing the following properties from type 'Project': emoji, label, addedManually`.

- [ ] **Step 6: Satisfy the new `Project` fields at their one construction site.** In
  `src/main/projects.ts`, every place a `Project` object is built gains
  `emoji: null, label: null, addedManually: false`. **D Task 41** replaces these with real
  `projectMeta` lookups; this
  step only makes the shape valid.

- [ ] **Step 7: Add the new fields to `ContextSnapshot` construction** in `src/main/context.ts`
  and `src/main/sessionFile.ts` as `permissionMode: null`, and to the `Tab` literals in
  `src/renderer/src/App.tsx` as `kind: 'session'`, `hostId: null`, `selectedPath: null`,
  `expandedPath: null` — using `hostId: host.id` at the SSH construction site (`App.tsx:427`).

- [ ] **Step 8: Run the typecheck and watch it pass.** `npm run typecheck` exits 0.

- [ ] **Step 9: Commit.**
  `git commit -m "Declare the shared types the UX overhaul's six workstreams all read"`

## Task 3: Extract a testable settings schema

- [ ] **Step 1: Write the failing suite.** Create
  `/Users/thevinh/dev/personal/stoke/scripts/verify-settings.mts`, copying the assertion helper
  and output format from `verify-worklog-gate.mts`:

  ```ts
  /*
   * hydrate() is the only thing standing between a hand-edited settings.json and
   * the app. It used to live behind an `import { app } from 'electron'`, so none
   * of it was ever run outside a window — and it repaired every structured field
   * except the ones that had just been added.
   *
   *   node scripts/verify-settings.mts
   */
  import { DEFAULT_SETTINGS, hydrateSettings } from '../src/main/settingsSchema.ts'

  let failures = 0
  function check(name: string, got: unknown, want: unknown): void {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) failures++
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
        (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    )
  }

  console.log('\nproject metadata')
  check('junk is dropped rather than kept', hydrateSettings({ projectMeta: 7 }).projectMeta, {})
  check(
    'an array is not an object of records',
    hydrateSettings({ projectMeta: ['/a'] }).projectMeta,
    {}
  )
  check(
    'a trailing separator is normalised off the key',
    Object.keys(hydrateSettings({ projectMeta: { '/a/b/': { emoji: '🔥' } } }).projectMeta),
    ['/a/b']
  )
  check(
    'an entry that says nothing is dropped',
    hydrateSettings({ projectMeta: { '/a': { emoji: '  ', label: '' } } }).projectMeta,
    {}
  )
  check(
    'addedManually needs a literal true',
    hydrateSettings({ projectMeta: { '/a': { addedManually: 1 } } }).projectMeta,
    {}
  )
  check(
    'a label is trimmed and capped',
    hydrateSettings({ projectMeta: { '/a': { label: `  ${'x'.repeat(200)}  ` } } }).projectMeta[
      '/a'
    ].label?.length,
    64
  )

  console.log('\nworklog boards')
  check(
    'an untouched machine gets Notion only',
    hydrateSettings({}).worklogBoards.targets,
    ['notion']
  )
  check(
    'a target with no id is not a destination',
    hydrateSettings({
      worklogBoards: { targets: ['notion', 'clickup'], notionDataSource: 'x', clickupListId: '' }
    }).worklogBoards.targets,
    ['notion']
  )
  check(
    'the stored order cannot change the write order',
    hydrateSettings({
      worklogBoards: { targets: ['clickup', 'notion'], notionDataSource: 'x', clickupListId: '1' }
    }).worklogBoards.targets,
    ['notion', 'clickup']
  )
  check(
    'a target nobody can write to is dropped',
    hydrateSettings({
      worklogBoards: { targets: ['jira'], notionDataSource: 'x', clickupListId: '1' }
    }).worklogBoards.targets,
    []
  )

  console.log('\ninterface scale, which a number input will not clamp for you')
  check('a hand-typed 40 is clamped', hydrateSettings({ uiScale: 40 }).uiScale, 1.6)
  check('so is 0', hydrateSettings({ uiScale: 0 }).uiScale, 0.8)
  check('and junk falls back to 1', hydrateSettings({ uiScale: 'big' }).uiScale, 1)
  check('a legitimate value is untouched', hydrateSettings({ uiScale: 1.25 }).uiScale, 1.25)

  console.log('\nthe status line')
  check('suppression is on for a machine that has never said', hydrateSettings({}).hideStatusLine, true)
  check('and off stays off', hydrateSettings({ hideStatusLine: false }).hideStatusLine, false)

  console.log('\nnothing already persisted is disturbed')
  check(
    'pinned and hidden keep their own shape',
    hydrateSettings({ pinnedProjects: ['/a'], hiddenProjects: ['/b'] }),
    { ...DEFAULT_SETTINGS, pinnedProjects: ['/a'], hiddenProjects: ['/b'] }
  )

  console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
  process.exitCode = failures ? 1 : 0
  ```

- [ ] **Step 2: Run it and watch it fail.**
  `node scripts/verify-settings.mts`
  Expected: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../src/main/settingsSchema.ts'`.

- [ ] **Step 3: Create `src/main/settingsSchema.ts`** holding the current `DEFAULTS` object
  (renamed `DEFAULT_SETTINGS` and exported), the current `isProfileConfig`, the current `hydrate`
  body (renamed `hydrateSettings` and exported), plus `hydrateProjectMeta` (§0.4),
  `hydrateWorklogBoards` (§0.5), the `clampUiScale` / `clampFontSize` wiring (§0.6) and
  `hideStatusLine: r.hideStatusLine !== false`. Import `validateTheme` and `DEFAULT_THEME_ID` as
  `from '../shared/themes.ts'`, `DEFAULT_WORKLOG_BOARDS` and `WORKLOG_TARGETS` as
  `from '../shared/worklog.ts'`, and the clamps as `from '../shared/ui.ts'` — relative with the
  explicit `.ts`, because this file is now run under strip-types. **No `electron` import.**

  `hydrateProjectMeta` calls `tidy()` from `./projectMeta.ts`, which **D Task 40 creates**. Until D
  runs, inline the two caps and the trimming exactly as §0.4's `tidy` describes them and leave a
  one-line `// D Task 40 replaces this with `import { tidy } from './projectMeta.ts'`.` comment
  above it. Do **not** export a second `MAX_EMOJI_CHARS` / `MAX_LABEL_CHARS` from this file — D
  Task 40 Step 3 deletes the inline copy, and two exported copies is what the ruling forbids.

- [ ] **Step 4: Reduce `src/main/store.ts` to persistence.** Delete `DEFAULTS`, `isProfileConfig`
  and `hydrate`; add `import { DEFAULT_SETTINGS, hydrateSettings } from './settingsSchema.ts'`
  and replace the two `hydrate(...)` calls and the two `{ ...DEFAULTS }` expressions accordingly.
  Nothing else in the file changes.

- [ ] **Step 5: Run it and watch it pass.** `node scripts/verify-settings.mts` → `all pass`.

- [ ] **Step 6: Register the suite.** In `package.json`, add
  `"verify:settings": "node scripts/verify-settings.mts"` after `verify:profiles`, and **insert**
  `&& npm run verify:settings` immediately after `npm run verify:profiles` in the `check` value.

  **Insert. Never quote or replace the whole `check` line** — six tasks across four parts add to
  it, and any step that pastes a full replacement silently deletes whatever the others added.
  Then run this guard, which must print nothing and exit 0:

  ```bash
  node -e "const s=require('./package.json').scripts.check; for (const n of ['context','statusline','unicode','usage','profiles','settings','folders','color','worklog-gate','tabs','worklog-runner','worklog-retry','worklog-recall','worklog-autoscan','ssh']) if (!s.includes('verify:'+n)) throw new Error('check is missing verify:'+n)"
  ```

  It will fail here naming the suites later tasks add (`verify:statusline`, `verify:unicode`,
  `verify:usage`, `verify:folders`, `verify:tabs`). That is expected while the plan is part-way
  through; what it catches is a **regression** — a suite that was in `check` and is no longer.
  Record the failing name here and re-run the guard after each of the five later registrations.

- [ ] **Step 7: Run the whole check.** `npm run check` exits 0.

- [ ] **Step 8: Commit.**
  `git commit -m "Make settings repair testable, and clamp the values a number input will not"`
  Body records: `hydrate` sat behind an electron import so none of it had ever been run outside a
  window, and `uiScale` was writable to any number because a React `onChange` ignores `min`/`max`.

## Task 4a: Declare the token block, alongside the one it will replace

This task **declares** and changes nothing else. The `--sp-1 … --sp-8` block stays exactly where it
is and keeps every one of its 141 uses; the new tokens sit beside it, referenced by nothing. The
whole 4px migration — the perl sweep over app.css and the eight `.tsx` files, deleting the `--sp-*`
block, `body`'s line-height, the seven literal line-height values and `src/remote/style.css:526` —
is **F Task 109**, one commit at the head of workstream F. That is deliberate: every measurement A,
B, C, D and E take is then taken against an intact layout, and every commit up to F Task 109 is
visually correct.

- [ ] **Step 1: Add the new tokens.** In
  `/Users/thevinh/dev/personal/stoke/src/renderer/src/styles/app.css`, immediately **after** the
  existing `--sp-1 … --sp-8` declarations in `:root` (locate them with
  `grep -n -- '--sp-1:' src/renderer/src/styles/app.css`), add, all from §0.6:

  - the seven `--space-*` tokens;
  - the three `--lh-*` tokens;
  - the four `--icon-*` tokens;
  - `--tab-indicator`, `--tab-dot-worklog`, `--ring-full`, `--traffic-lights-w`;
  - `--surface-selected`, `--chevron`, `--control-h`;
  - and, next to the existing `--shadow-*` declarations, `--scrim`, `--swatch-ring`,
    `--shadow-panel` and `--on-danger: var(--bg)`.

  Add the light-appearance overrides for `--scrim`, `--swatch-ring` and `--shadow-panel` only, to
  the `:root[data-appearance='light']` block (locate it by that selector). **No `--on-danger` line
  goes in the light block** — §0.6 explains why one declaration covers both.

  Delete nothing. Change no existing declaration.

- [ ] **Step 2: Build, to prove the CSS still parses and bundles.** `npm run build` exits 0.

- [ ] **Step 3: Measure that nothing moved.** With the app running
  (`npx electron . --remote-debugging-port=9222`), using contracts Task 5's probe:

  ```bash
  node scripts/cdp-eval.mjs "getComputedStyle(document.querySelector('.tab')).paddingInline"
  ```

  Expected: `"8px 6px"` — **unchanged**, exactly what it printed before this task. `.tab` is
  `padding: 0 var(--sp-2) 0 var(--sp-3)`, i.e. 8px left and 6px right today; it becomes a single
  `"8px"` only at F Task 109. A declaration-only task that moves a pixel has moved it by accident.

  (If Task 4a is executed before Task 5, defer this one step until `scripts/cdp-eval.mjs` exists.)

- [ ] **Step 4: Commit.**
  `git commit -m "Declare the 4px scale, the line-height, icon and shared tokens"`
  Body records: declaration only — the `--sp-*` block and all 141 of its uses are untouched, so
  this commit changes no pixel; the migration is one later commit, deliberately, so every
  measurement taken between here and there is taken against an intact layout. Notes that
  `--on-danger` is `var(--bg)` and not `#ffffff`, because white measures 2.70–2.89:1 on `--danger`
  in three of the four themes and two of those sites are button text.

## Task 5: The one CDP probe every measurement step uses

Roughly thirty steps across A, C, D, E and F measure the running app. Without one canonical probe,
four parts each ship their own — and three of the four drafts selected the CDP target by URL
(`file://`, `localhost:<port>`, `/index.html`, `/out/renderer/index.html`), which are exactly the
URLs the **docked browser** legitimately shows. That is CLAUDE.md gotcha 6 verbatim, and
`Array.find` takes whichever target Chromium enumerates first. Only a `window.stoke` probe is safe,
because contextBridge is injected into the renderer alone.

This task is the sole creator of `scripts/cdp-eval.mjs`. A Task 80, D Task 42 Step 1, E Task 75
Step 1 and F Task 110 are deleted in favour of it, and every part's Interfaces block carries
"Consumes: `scripts/cdp-eval.mjs` from contracts Task 5."

It registers **nothing** in `package.json`: it needs a live window, so it is deliberately not part
of `npm run check`.

- [ ] **Step 1: Create `scripts/cdp-eval.mjs`** with exactly this content:

  ```js
  /*
   * Evaluate one expression inside Stoke's own renderer, or screenshot it.
   *
   *   npm run build
   *   npx electron . --remote-debugging-port=9222 &
   *   node scripts/cdp-eval.mjs "getComputedStyle(document.body).lineHeight"
   *   node scripts/cdp-eval.mjs --shot /tmp/stoke.png
   *
   * Why this exists: every alignment defect in the UX overhaul was established by
   * measuring the running app, and none of them is visible any other way — the
   * terminal is a WebGL canvas so its DOM is empty (CLAUDE.md gotcha 5) and the
   * CSS reads correct while laying out wrong (gotcha 14).
   *
   * Page targets are filtered to the one holding a `window.stoke` contextBridge
   * object. Matching on URL is NOT enough: the docked browser is its own page
   * target (gotcha 6) and it exists precisely so the user can point it at a local
   * dev server or a file:// page, so `localhost:<port>`, `/index.html` and
   * `file://` are all URLs it legitimately shows. contextBridge is injected into
   * the renderer only, which is why it is the one reliable discriminator.
   *
   * The expression may be async; its promise is awaited before the value is
   * serialised, which is what lets a measurement dispatch an event and then read
   * the DOM React rendered in response. The page does the stringifying, so output
   * is compact JSON on one line.
   *
   * Deliberately not part of `npm run check`: it needs a live window.
   * Exit codes: 0 success; 1 no endpoint, no renderer, or the expression threw;
   * 2 usage error.
   */
  import { writeFileSync } from 'node:fs'
  import WebSocket from 'ws'

  const port = process.env.CDP_PORT ?? '9222'
  const argv = process.argv.slice(2)
  const wantsShot = argv[0] === '--shot'
  const arg = wantsShot ? argv[1] : argv.join(' ')

  if (!arg) {
    console.error('usage: node scripts/cdp-eval.mjs "<javascript expression>"')
    console.error('       node scripts/cdp-eval.mjs --shot <file.png>')
    process.exit(2)
  }

  let targets
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`)
    targets = await res.json()
  } catch {
    console.error(
      `No CDP endpoint on port ${port}. Launch the app with --remote-debugging-port=${port} first.`
    )
    process.exit(1)
  }

  /** One request, matched back by id — replies and events share the socket. */
  function send(ws, id, method, params) {
    return new Promise((resolve, reject) => {
      const onMessage = (raw) => {
        const msg = JSON.parse(String(raw))
        if (msg.id !== id) return
        ws.off('message', onMessage)
        if (msg.error) reject(new Error(msg.error.message))
        else resolve(msg.result)
      }
      ws.on('message', onMessage)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  async function evaluate(ws, id, expression) {
    const result = await send(ws, id, 'Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }

  const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  let hit = null

  for (const page of pages) {
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
    try {
      await new Promise((resolve, reject) => {
        ws.once('open', resolve)
        ws.once('error', reject)
      })
      const isStoke = await evaluate(
        ws,
        1,
        'typeof window.stoke === "object" && typeof window.stoke.platform === "string"'
      )
      if (isStoke) {
        hit = ws
        break
      }
    } catch {
      /* a target that will not talk is not the renderer */
    }
    ws.close()
  }

  if (!hit) {
    console.error(
      `No Stoke renderer among ${pages.length} page target(s): ` +
        `${pages.map((p) => p.url).join(', ') || 'none'}`
    )
    process.exit(1)
  }

  try {
    if (wantsShot) {
      const result = await send(hit, 2, 'Page.captureScreenshot', { format: 'png' })
      writeFileSync(arg, Buffer.from(result.data, 'base64'))
      console.log(arg)
    } else {
      const value = await evaluate(
        hit,
        2,
        `Promise.resolve((() => (${arg}))()).then((v) => JSON.stringify(v))`
      )
      console.log(value)
    }
  } catch (e) {
    console.error(String(e instanceof Error ? e.message : e))
    hit.close()
    process.exit(1)
  }

  hit.close()
  ```

- [ ] **Step 2: Run it with nothing listening.**

  ```bash
  node scripts/cdp-eval.mjs "1 + 1"
  ```

  Expected on **stderr**, exit code 1:
  `No CDP endpoint on port 9222. Launch the app with --remote-debugging-port=9222 first.`

- [ ] **Step 3: Run it against the app.**

  ```bash
  npm run build
  npx electron . --remote-debugging-port=9222 &
  node scripts/cdp-eval.mjs "1 + 1"
  node scripts/cdp-eval.mjs "document.title"
  node scripts/cdp-eval.mjs "typeof window.stoke.platform"
  ```

  Expected, one compact line each: `2`, `"Stoke"`, `"string"`. Note the quoting — the page does the
  stringifying, so a string value comes back JSON-quoted and every expected output written anywhere
  in this plan is **compact JSON**, never pretty-printed.

- [ ] **Step 4: Prove it picks the renderer and not the docked browser.** Open the browser panel in
  the app and point it at anything, then:

  ```bash
  node scripts/cdp-eval.mjs "({ targets: 'see stderr', stoke: typeof window.stoke })"
  node scripts/cdp-eval.mjs --shot /tmp/stoke-probe.png
  ```

  Expected: `{"targets":"see stderr","stoke":"object"}`, then `/tmp/stoke-probe.png`, and the image
  shows Stoke's own window. A URL-matching probe answers from the browser view here.

- [ ] **Step 5: Commit.**
  `git commit -m "Add the one CDP probe every measurement in this overhaul uses"`
  Body records: three separate drafts selected the target by URL, which is the one thing gotcha 6
  says cannot work — the docked browser is its own page target and exists to show `localhost`,
  `file://` and `/index.html` pages. The probe discriminates on the contextBridge object instead,
  which only the renderer has. Not chained into `npm run check`: it needs a live window.

---

## Notes the six drafters must not rediscover

1. **`src/shared/**` is compiled by both tsconfigs.** `tsconfig.web.json` gives it no Node types.
   A `import { sep } from 'node:path'` or a bare `process.platform` in a shared module fails
   `npm run typecheck` on the web project only — which is easy to miss if you only run the app.
2. **Shared modules use extensionless relative imports for TYPE-only imports**, which strip-types
   erases, **and an explicit `.ts` for VALUE imports.** `export { foldGroup } from './paths.ts'` is
   the first value import between two shared modules in the tree; both tsconfigs are `noEmit`, so
   `allowImportingTsExtensions` is legal, and `tsconfig.node.json` already sets it
   (`src/main/mcp/design.ts:11-16`). Task 1 Steps 5a–5b set it on the other two. Separately: a
   value import of `@shared/*` from a strip-types module (`gate.ts`, `watch.ts`, `runner.ts`,
   `recall.ts`, `autoscan.ts`, `settingsSchema.ts`, `projectMeta.ts`, `statusLine.ts`,
   `sessionStore.ts`) breaks its verify suite at runtime with `ERR_MODULE_NOT_FOUND`, not at
   compile time.
3. **`shouldWatch.length` is asserted at `verify-worklog-gate.mts:166`.** Any new parameter must
   have a default value.
4. **The queue's dedupe key is load-bearing** (CLAUDE.md gotcha 17). Nothing in this section
   touches `WorklogProposal.id`, its inputs, or the `create` key format. Keep it that way — a
   changed key resurrects every proposal the user has ever rejected.
5. **`worklog:watchChanged` must not be computed from a project list cached at boot.** A repository
   cloned during the run is a project the gate has to be able to see (`index.ts:365-367`).
6. **Do not fire `worklog:watchChanged` from the ContextWatcher tick.** It would push identical
   arrays every 1.5 s per session. The four triggers in §0.3 are the complete list.
7. **`statusline:update` fires only when the payload file's mtime moved.** Same reason.
8. **`scripts/` is in neither tsconfig `include`.** The verify suites are not typechecked; a type
   error there only shows up as a runtime failure when the suite runs. Run the suite.
9. **A red dot means exactly one thing after this work: "the worklog is watching this session".**
   Bypass mode loses red (`app.css:387`), the ≥90% ring loses red (`app.css:899` → `--ring-full`),
   and `.tab-close:hover` keeps its own fill because it is a hover affordance rather than state.
   If a workstream needs a new red, it needs a different colour instead.
10. **`resets_at` in the statusLine payload is epoch seconds.** `UsageWindow.resetsAt` elsewhere in
    this codebase is ms. Convert exactly once, in `toSnapshot`.
