# Tab Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stoke remembers the tabs that were open when it quit and brings them back paused, so a quit or an update no longer loses the set of sessions you had going.

**Architecture:** The renderer owns the snapshot (tab list is React state, screen text comes from each xterm's buffer) and pushes it to main over IPC on a debounce; main persists it to `tabs.json` in userData through a pure, electron-free store module and flushes on `before-quit`. At boot the renderer reads the file back and builds `status: 'paused'` tabs with no PTY — clicking Resume runs the existing `startSession(..., resume: true, replaceTabId)` path, which replaces the paused tab in place.

**Tech Stack:** Electron main + preload + React renderer, TypeScript, xterm.js 6.0.0. No test framework — verify suites are plain `node --experimental-strip-types` scripts under `scripts/`, run by `npm run check`.

## Global Constraints

Copied from the spec (`docs/superpowers/specs/2026-08-19-tab-restore-design.md`) and `CLAUDE.md`. Every task's requirements implicitly include these.

- Relative imports inside `src/main` carry explicit `.ts` extensions, so the module runs under `node --experimental-strip-types`.
- No TypeScript parameter properties in main-process classes.
- `src/main/tabStore.ts` must import **no** `electron`, so the verify suite can run it with no window.
- Types shared between main and renderer go in `src/shared/types.ts`, which must import **nothing** from `node:` — it is compiled by `tsconfig.web.json`, which has no node types (gotcha 27).
- All colour goes through CSS custom properties. No hardcoded hex in components. No Tailwind, no component library.
- IPC channel names are added to `src/shared/ipc.ts` first.
- A new full-width strip goes **inside `.main-col`**, never as a fourth row of `.app` (gotcha 14).
- Caps, exact values: `MAX_STORED_TABS = 20`, `MAX_SCREEN_BYTES = 8192`, `STORED_TAB_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000`.
- Store filename: `tabs.json`.
- Commit messages explain *why*, and record any bug the change fixes.
- `npm run check` must pass before any task is called done.

---

### Task 1: The store — types, `tabStore.ts`, and its suite

**Files:**
- Modify: `src/shared/types.ts` (append the stored-tab types)
- Create: `src/main/tabStore.ts`
- Create: `scripts/verify-restore.mts`
- Modify: `package.json` (add `verify:restore`, add it to `check`)

**Interfaces:**
- Consumes: `PermissionMode` and `EffortLevel`, already exported from `src/shared/types.ts`.
- Produces:
  - `StoredTabContext { tokens: number; limit: number }`
  - `StoredTab` (see Step 3 for every field)
  - `StoredTabs { version: 1; savedAt: number; activeIndex: number; tabs: StoredTab[] }`
  - `TAB_STATE_FILENAME: string`, `MAX_STORED_TABS: number`, `MAX_SCREEN_BYTES: number`, `STORED_TAB_MAX_AGE_MS: number`
  - `tabStateFile(userDataDir: string): string`
  - `trimScreen(text: string): string`
  - `normaliseTabs(raw: unknown, now?: number): StoredTabs`
  - `readTabState(file: string, now?: number): StoredTabs`
  - `writeTabState(file: string, state: StoredTabs): void`

- [ ] **Step 1: Write the failing suite**

Create `scripts/verify-restore.mts`:

```ts
/*
 * The tab-restore store: what survives a quit, what is trimmed, and what a
 * corrupt file does. Pure — no electron, no window — so it runs anywhere.
 *
 *   node scripts/verify-restore.mts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_SCREEN_BYTES,
  MAX_STORED_TABS,
  STORED_TAB_MAX_AGE_MS,
  normaliseTabs,
  readTabState,
  tabStateFile,
  trimScreen,
  writeTabState
} from '../src/main/tabStore.ts'
import type { StoredTab, StoredTabs } from '../src/shared/types.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  )
}

const NOW = 1_760_000_000_000

function tab(over: Partial<StoredTab> = {}): StoredTab {
  return {
    kind: 'session',
    sessionId: 'sess-1',
    cwd: '/w/stoke',
    projectName: 'stoke',
    title: 'a title',
    permissionMode: 'default',
    model: '',
    effort: 'default',
    hostId: null,
    selectedPath: null,
    expandedPath: null,
    lastActiveAt: NOW,
    context: null,
    screen: '',
    ...over
  }
}

function state(over: Partial<StoredTabs> = {}): StoredTabs {
  return { version: 1, savedAt: NOW, activeIndex: 0, tabs: [tab()], ...over }
}

console.log('\nround trip')
{
  const dir = mkdtempSync(join(tmpdir(), 'stoke-restore-'))
  const file = tabStateFile(dir)
  const s = state({
    activeIndex: 1,
    tabs: [
      tab({ sessionId: 'a', context: { tokens: 62104, limit: 200000 }, screen: 'one\ntwo' }),
      tab({ sessionId: 'b', kind: 'new', cwd: '', selectedPath: '/w/x' })
    ]
  })
  writeTabState(file, s)
  check('a saved list comes back unchanged, context included', readTabState(file, NOW), s)
  rmSync(dir, { recursive: true, force: true })
}

console.log('\ncaps')
{
  const many = Array.from({ length: MAX_STORED_TABS + 5 }, (_, i) =>
    tab({ sessionId: `s${i}`, lastActiveAt: NOW - i * 1000 })
  )
  const out = normaliseTabs(state({ tabs: many }), NOW)
  check('over-cap lists are cut to the cap', out.tabs.length, MAX_STORED_TABS)
  check('and it is the oldest that go', out.tabs.at(-1)?.sessionId, `s${MAX_STORED_TABS - 1}`)
}
{
  const long = `${'x'.repeat(200)}\n`.repeat(200)
  const trimmed = trimScreen(long)
  check('a huge screen is trimmed under the byte cap', trimmed.length <= MAX_SCREEN_BYTES, true)
  check('it is trimmed on a line boundary', trimmed.startsWith('x'), true)
  check('and it keeps the tail, not the head', long.endsWith(trimmed), true)
}

console.log('\nexpiry')
{
  const out = normaliseTabs(
    state({
      tabs: [
        tab({ sessionId: 'fresh', lastActiveAt: NOW - 13 * 24 * 60 * 60 * 1000 }),
        tab({ sessionId: 'stale', lastActiveAt: NOW - STORED_TAB_MAX_AGE_MS - 1 })
      ]
    }),
    NOW
  )
  check('a tab inside the age window is kept', out.tabs.map((t) => t.sessionId), ['fresh'])
}

console.log('\ncorruption is never fatal')
{
  const dir = mkdtempSync(join(tmpdir(), 'stoke-restore-'))
  const file = tabStateFile(dir)
  const empty: StoredTabs = { version: 1, savedAt: 0, activeIndex: 0, tabs: [] }
  check('a missing file reads as empty', readTabState(file, NOW), empty)
  for (const [name, body] of [
    ['truncated json', '{"version":1,"tabs":[{'],
    ['a BOM', '﻿{"version":1,"savedAt":0,"activeIndex":0,"tabs":[]}'],
    ['null', 'null'],
    ['an array at the root', '[]'],
    ['a future version', '{"version":99,"savedAt":0,"activeIndex":0,"tabs":[]}']
  ] as const) {
    writeFileSync(file, body, 'utf8')
    check(`${name} reads as empty`, readTabState(file, NOW), empty)
  }
  rmSync(dir, { recursive: true, force: true })
}

console.log('\nwhat it drops')
{
  const out = normaliseTabs(
    { version: 1, savedAt: NOW, activeIndex: 0, tabs: [{ ...tab(), ptyId: 'p1', status: 'running', id: 'x', bogus: 1 }] },
    NOW
  )
  check('runtime-only and unknown keys are not carried forward', Object.keys(out.tabs[0]).sort(), Object.keys(tab()).sort())
}
{
  const out = normaliseTabs(state({ activeIndex: 99 }), NOW)
  check('an out-of-range activeIndex is clamped', out.activeIndex, 0)
}
{
  const out = normaliseTabs(state({ tabs: [tab({ kind: 'session', cwd: '' })] }), NOW)
  check('a session tab with no folder is dropped, it can never be resumed', out.tabs, [])
}

console.log(failures ? `\n${failures} failed` : '\nall pass')
process.exit(failures ? 1 : 0)
```

- [ ] **Step 2: Run it and watch it fail**

Run: `node scripts/verify-restore.mts`
Expected: FAIL — `Cannot find module '../src/main/tabStore.ts'`.

- [ ] **Step 3: Add the shared types**

Append to `src/shared/types.ts`. No `node:` import — this file is compiled by the web project too (gotcha 27).

```ts
/* ------------------------------------------------------------ tab restore */

/** The last context reading a paused tab had, so its ring is not blank. */
export interface StoredTabContext {
  tokens: number
  limit: number
}

/**
 * One tab as it survives a quit.
 *
 * `id`, `ptyId`, `status` and `exitCode` are deliberately absent: the first two
 * are regenerated on restore and the last two are always "paused" by definition.
 */
export interface StoredTab {
  kind: 'session' | 'new'
  /** '' for a --continue session, which never learns its own id (gotcha 26). */
  sessionId: string
  cwd: string
  projectName: string
  title: string
  permissionMode: PermissionMode
  model: string
  effort: EffortLevel
  /** `SshHost.id` when the session ran on another machine. */
  hostId: string | null
  selectedPath: string | null
  expandedPath: string | null
  lastActiveAt: number
  context: StoredTabContext | null
  /** The visible viewport as plain text. See MAX_SCREEN_BYTES. */
  screen: string
}

export interface StoredTabs {
  version: 1
  savedAt: number
  /** Index into `tabs` of the tab that was selected. Clamped on read. */
  activeIndex: number
  tabs: StoredTab[]
}
```

- [ ] **Step 4: Write `src/main/tabStore.ts`**

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { EffortLevel, PermissionMode, StoredTab, StoredTabs } from '../shared/types.ts'

/**
 * The tabs that were open when Stoke last quit.
 *
 * Quitting runs `ptys.killAll()` and a restarted app cannot reattach to a CLI
 * child that outlived it, so this file is the only record of what was open.
 * Restoring from it is a relaunch (`claude --resume`), not a reattach.
 *
 * A sibling of worklog/sessionStore.ts and deliberately not part of it: that one
 * is an address book the worklog reads, this one is a UI snapshot, and a corrupt
 * snapshot must not cost the worklog its placements.
 *
 * Imports no electron, so scripts/verify-restore.mts exercises it directly.
 */

export const TAB_STATE_FILENAME = 'tabs.json'

/** More tabs than the strip stays legible at, and more than anyone opens. */
export const MAX_STORED_TABS = 20

/** Roughly one 120x50 screen of text. The tail is kept, trimmed on whole lines. */
export const MAX_SCREEN_BYTES = 8192

/**
 * Past two weeks the folder is likely a different piece of work wearing the same
 * path — the same reasoning STORED_SESSION_MAX_AGE_MS already uses.
 */
export const STORED_TAB_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000

const EMPTY: StoredTabs = { version: 1, savedAt: 0, activeIndex: 0, tabs: [] }

export function tabStateFile(userDataDir: string): string {
  return join(userDataDir, TAB_STATE_FILENAME)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function nullableStr(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/**
 * Keep the END of the text, not the start.
 *
 * The last thing on screen is the thing you were looking at, and a screen cut
 * from the top would show a paused tab its own scrollback header. Cut on a line
 * boundary so the first surviving line is never half a line.
 */
export function trimScreen(text: string): string {
  if (text.length <= MAX_SCREEN_BYTES) return text
  const tail = text.slice(text.length - MAX_SCREEN_BYTES)
  const nl = tail.indexOf('\n')
  return nl < 0 ? tail : tail.slice(nl + 1)
}

function tabOf(v: unknown): StoredTab | null {
  if (!isRecord(v)) return null
  const kind = v.kind === 'new' ? 'new' : 'session'
  const cwd = str(v.cwd)
  /*
   * A session tab with no folder can never be resumed — `--resume` needs a cwd —
   * so it would restore as a card whose only working button is Close. A New tab
   * legitimately has none.
   */
  if (kind === 'session' && !cwd) return null
  const ctx = isRecord(v.context) ? v.context : null
  return {
    kind,
    sessionId: str(v.sessionId),
    cwd,
    projectName: str(v.projectName),
    title: str(v.title),
    permissionMode: str(v.permissionMode, 'default') as PermissionMode,
    model: str(v.model),
    effort: str(v.effort, 'default') as EffortLevel,
    hostId: nullableStr(v.hostId),
    selectedPath: nullableStr(v.selectedPath),
    expandedPath: nullableStr(v.expandedPath),
    lastActiveAt: typeof v.lastActiveAt === 'number' && Number.isFinite(v.lastActiveAt) ? v.lastActiveAt : 0,
    context:
      ctx && typeof ctx.tokens === 'number' && typeof ctx.limit === 'number'
        ? { tokens: ctx.tokens, limit: ctx.limit }
        : null,
    screen: trimScreen(str(v.screen))
  }
}

/**
 * The pure core, so the suite can drive it without touching a disk.
 *
 * Anything unrecognisable becomes EMPTY rather than throwing: losing the tab
 * list is a nuisance, failing to start is not.
 */
export function normaliseTabs(raw: unknown, now = Date.now()): StoredTabs {
  if (!isRecord(raw)) return EMPTY
  // A future version was written by a newer Stoke and may mean anything.
  if (raw.version !== 1) return EMPTY
  if (!Array.isArray(raw.tabs)) return EMPTY

  const tabs = raw.tabs
    .map(tabOf)
    .filter((t): t is StoredTab => t !== null && now - t.lastActiveAt < STORED_TAB_MAX_AGE_MS)
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt)
    .slice(0, MAX_STORED_TABS)

  const wanted = typeof raw.activeIndex === 'number' ? raw.activeIndex : 0
  return {
    version: 1,
    savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    activeIndex: Number.isInteger(wanted) && wanted >= 0 && wanted < tabs.length ? wanted : 0,
    tabs
  }
}

/** Never throws. A file that cannot be read is an empty snapshot. */
export function readTabState(file: string, now = Date.now()): StoredTabs {
  try {
    return normaliseTabs(JSON.parse(readFileSync(file, 'utf8')), now)
  } catch {
    // Missing (the normal first run) or corrupt. Both mean nothing to restore.
    return EMPTY
  }
}

/** Temp file + rename, matching store.ts, so a crash mid-write cannot truncate it. */
export function writeTabState(file: string, state: StoredTabs): void {
  try {
    mkdirSync(dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (err) {
    console.error('[stoke] failed to persist the open tabs', err)
  }
}
```

- [ ] **Step 5: Run the suite until it passes**

Run: `node scripts/verify-restore.mts`
Expected: `all pass`.

Two failures are likely on the first run and both are real. The round-trip check compares against the object you wrote — `normaliseTabs` **sorts by `lastActiveAt` descending**, so give the two fixture tabs distinct `lastActiveAt` values in the round-trip case and expect them in that order. And `readTabState` returns `savedAt` from the file, so the fixture's `savedAt` must be a number.

- [ ] **Step 6: Wire it into `npm run check`**

In `package.json`, add the script and insert it into `check` immediately after `verify:tabs`:

```json
"verify:restore": "node scripts/verify-restore.mts",
```

- [ ] **Step 7: Run the full check**

Run: `npm run check`
Expected: exit 0, `verify:restore` printing `all pass` among the others.

- [ ] **Step 8: Commit**

```bash
git add src/shared/types.ts src/main/tabStore.ts scripts/verify-restore.mts package.json
git commit -m "Remember the open tabs on disk, so a quit stops losing them

Quitting runs ptys.killAll() and a restarted app cannot reattach to the CLI
children that outlived it, so the tab list was gone with no record of it. This
is the store only: a pure, electron-free module so verify:restore can drive it
with no window, with the caps and the corrupt-file behaviour pinned."
```

---

### Task 2: IPC — save and restore across the process boundary

**Files:**
- Modify: `src/shared/ipc.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `StoredTabs`, `readTabState`, `writeTabState`, `tabStateFile` from Task 1.
- Produces: `window.stoke.tabs.save(state: StoredTabs): void` and `window.stoke.tabs.restore(): Promise<StoredTabs>`.

- [ ] **Step 1: Add the channels**

In `src/shared/ipc.ts`, after the `// ssh` block:

```ts
  // tab restore
  tabsSave: 'tabs:save',
  tabsRestore: 'tabs:restore',
```

- [ ] **Step 2: Declare the renderer API**

In `src/shared/api.ts`, add a namespace beside `worklog`:

```ts
  /**
   * The tabs that were open when Stoke last quit.
   *
   * `save` is fire-and-forget on purpose: it runs on a debounce while the user
   * works, and a snapshot that is one write behind is worth far more than one
   * that blocks the UI thread to be exact.
   */
  tabs: {
    save(state: StoredTabs): void
    restore(): Promise<StoredTabs>
  }
```

Add `StoredTabs` to the existing `import type { … } from './types'` line at the top of the file.

- [ ] **Step 3: Bridge it in preload**

In `src/preload/index.ts`, beside the `worklog` object:

```ts
  tabs: {
    save: (state: StoredTabs) => ipcRenderer.send(CH.tabsSave, state),
    restore: () => ipcRenderer.invoke(CH.tabsRestore)
  },
```

Import `StoredTabs` from `@shared/types` at the top.

- [ ] **Step 4: Handle both in main, and flush on quit**

In `src/main/index.ts`, import the store near the other main-process imports:

```ts
import { readTabState, tabStateFile, writeTabState } from './tabStore.ts'
```

Add module state and handlers alongside the other `ipcMain` registrations:

```ts
/*
 * The newest snapshot the renderer has sent.
 *
 * Held in memory and written on every push AND again on before-quit. Writing on
 * push is what makes this survive a crash or a force-kill, which are exactly the
 * cases where nothing gets a chance to ask the renderer for anything; the quit
 * flush is belt and braces for the last few hundred ms of edits.
 */
let lastTabState: StoredTabs | null = null

ipcMain.on(CH.tabsSave, (_e, state: StoredTabs) => {
  lastTabState = state
  writeTabState(tabStateFile(app.getPath('userData')), state)
})

ipcMain.handle(CH.tabsRestore, () => readTabState(tabStateFile(app.getPath('userData'))))
```

In the existing `app.on('before-quit', …)` block (`src/main/index.ts:1419`), add the flush as the **first** statement, before `ptys?.killAll()`:

```ts
    if (lastTabState) writeTabState(tabStateFile(app.getPath('userData')), lastTabState)
```

Import `StoredTabs` as a type from `../shared/types.ts`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: exit 0. If the web half complains about `StoredTabs`, the import in `api.ts` is missing — that file is compiled by both projects.

- [ ] **Step 6: Prove the round trip in the running app**

```bash
npm run build
STOKE_USER_DATA=/tmp/stoke-restore-probe npx electron . --remote-debugging-port=9222 &
node scripts/cdp-eval.mjs 'window.stoke.tabs.save({version:1,savedAt:Date.now(),activeIndex:0,tabs:[{kind:"session",sessionId:"probe",cwd:"/tmp",projectName:"probe",title:"probe",permissionMode:"default",model:"",effort:"default",hostId:null,selectedPath:null,expandedPath:null,lastActiveAt:Date.now(),context:null,screen:"hello"}]}) || "sent"'
node scripts/cdp-eval.mjs 'window.stoke.tabs.restore().then(s => JSON.stringify(s))'
cat /tmp/stoke-restore-probe/tabs.json
```

Expected: the restore call returns the one `probe` tab, and `tabs.json` on disk contains it. This is the step that proves the preload bridge and both handlers, which no pure suite can reach.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc.ts src/shared/api.ts src/preload/index.ts src/main/index.ts
git commit -m "Carry the tab snapshot across the process boundary

Fire-and-forget save so the debounce never blocks the UI thread, plus a flush
on before-quit for the last few hundred ms. Writing on every push rather than
only at quit is what makes this survive a crash or a force-kill."
```

---

### Task 3: `Tab.status: 'paused'` and the pure conversion

**Files:**
- Modify: `src/renderer/src/types.ts`
- Create: `src/renderer/src/lib/restore.ts`
- Modify: `scripts/verify-restore.mts` (append a conversion section)
- Modify: `scripts/verify-tabs.mts` (one paused case)

**Interfaces:**
- Consumes: `StoredTab`, `StoredTabs` (Task 1); `Tab` from `src/renderer/src/types.ts`; `ContextSnapshot` from `@shared/types`.
- Produces:
  - `toStored(tabs: Tab[], activeTabId: string | null, contexts: Record<string, ContextSnapshot>, screenOf: (tab: Tab) => string, now?: number): StoredTabs`
  - `fromStored(state: StoredTabs): { tabs: Tab[]; activeId: string | null }`

- [ ] **Step 1: Widen the status**

In `src/renderer/src/types.ts`, change the `status` field on `Tab` and document the new value:

```ts
  /**
   * `paused` is a tab restored from the last run: it has a session to resume but
   * no process yet, so `ptyId` is ''. It is not `exited` — that means the
   * process ended, this means it has not started.
   */
  status: 'running' | 'exited' | 'paused'
```

- [ ] **Step 2: Write the failing conversion checks**

Append to `scripts/verify-restore.mts`, above the final `console.log(failures …)`:

```ts
console.log('\nconverting between the tab list and the snapshot')
{
  const live: Tab[] = [
    {
      id: 'p1', kind: 'session', ptyId: 'p1', sessionId: 'sess-a', cwd: '/w/stoke',
      projectName: 'stoke', title: 'live one', permissionMode: 'default', model: '',
      effort: 'default', status: 'running', exitCode: null, hostId: null,
      selectedPath: null, expandedPath: null
    },
    {
      id: 'new-1', kind: 'new', ptyId: '', sessionId: '', cwd: '', projectName: '',
      title: 'New session', permissionMode: 'default', model: '', effort: 'default',
      status: 'running', exitCode: null, hostId: null,
      selectedPath: '/w/other', expandedPath: null
    }
  ]
  const snap = toStored(live, 'new-1', { 'sess-a': { sessionId: 'sess-a', contextTokens: 10, contextLimit: 200, ready: true, permissionMode: 'default' } as never }, () => 'SCREEN', NOW)
  check('the active tab is recorded by index', snap.activeIndex, 1)
  check('a live tab keeps its screen', snap.tabs.find((t) => t.sessionId === 'sess-a')?.screen, 'SCREEN')
  check('and its context reading', snap.tabs.find((t) => t.sessionId === 'sess-a')?.context, { tokens: 10, limit: 200 })
  check('a New tab keeps its selection', snap.tabs.find((t) => t.kind === 'new')?.selectedPath, '/w/other')

  const back = fromStored(snap)
  check('every restored session tab is paused', back.tabs.filter((t) => t.kind === 'session').every((t) => t.status === 'paused'), true)
  check('and carries no pty', back.tabs.every((t) => t.ptyId === ''), true)
  check('a restored New tab is not paused, it has nothing to resume', back.tabs.find((t) => t.kind === 'new')?.status, 'running')
  check('the active id points at a tab that exists', back.tabs.some((t) => t.id === back.activeId), true)
  check('restored ids are unique', new Set(back.tabs.map((t) => t.id)).size, back.tabs.length)
}
{
  const back = fromStored({ version: 1, savedAt: NOW, activeIndex: 0, tabs: [] })
  check('an empty snapshot restores nothing and selects nothing', [back.tabs.length, back.activeId], [0, null])
}
```

Add to the imports at the top of the file:

```ts
import { fromStored, toStored } from '../src/renderer/src/lib/restore.ts'
import type { Tab } from '../src/renderer/src/types.ts'
```

- [ ] **Step 3: Run it and watch it fail**

Run: `node scripts/verify-restore.mts`
Expected: FAIL — `Cannot find module '../src/renderer/src/lib/restore.ts'`.

- [ ] **Step 4: Write `src/renderer/src/lib/restore.ts`**

```ts
import type { ContextSnapshot, StoredTab, StoredTabs } from '@shared/types'
import type { Tab } from '../types'

/**
 * Between the live tab list and the snapshot that outlives the process.
 *
 * Pure, and in its own module rather than inline in App.tsx, because it is the
 * one part of this feature a suite can check — everything else is a side effect
 * inside a closure or a paint (CLAUDE.md gotcha 31).
 */

/** Ids are regenerated on restore, so they only have to be unique in this run. */
function restoredId(i: number): string {
  return `restored-${Date.now().toString(36)}-${i}`
}

export function toStored(
  tabs: Tab[],
  activeTabId: string | null,
  contexts: Record<string, ContextSnapshot>,
  screenOf: (tab: Tab) => string,
  now = Date.now()
): StoredTabs {
  const stored: StoredTab[] = tabs.map((t) => {
    const snap = t.sessionId ? contexts[t.sessionId] : undefined
    return {
      kind: t.kind,
      sessionId: t.sessionId,
      cwd: t.cwd,
      projectName: t.projectName,
      title: t.title,
      permissionMode: t.permissionMode,
      model: t.model,
      effort: t.effort,
      hostId: t.hostId,
      selectedPath: t.selectedPath,
      expandedPath: t.expandedPath,
      lastActiveAt: now,
      context:
        snap && snap.ready && snap.contextLimit > 0
          ? { tokens: snap.contextTokens, limit: snap.contextLimit }
          : null,
      /*
       * The whole tab, not its ptyId: a paused tab has no process and therefore
       * no buffer, and must keep the screen it was restored with. Only the
       * caller knows that, so only the caller can resolve it.
       */
      screen: screenOf(t)
    }
  })
  const at = tabs.findIndex((t) => t.id === activeTabId)
  return { version: 1, savedAt: now, activeIndex: at < 0 ? 0 : at, tabs: stored }
}

export function fromStored(state: StoredTabs): { tabs: Tab[]; activeId: string | null } {
  const tabs: Tab[] = state.tabs.map((s, i) => ({
    id: restoredId(i),
    kind: s.kind,
    ptyId: '',
    sessionId: s.sessionId,
    cwd: s.cwd,
    projectName: s.projectName,
    title: s.title,
    permissionMode: s.permissionMode,
    model: s.model,
    effort: s.effort,
    /*
     * Only a session tab is paused. A New tab has no session to resume, so
     * marking it paused would put a Resume card over a launcher.
     */
    status: s.kind === 'session' ? 'paused' : 'running',
    exitCode: null,
    hostId: s.hostId,
    selectedPath: s.selectedPath,
    expandedPath: s.expandedPath
  }))
  return { tabs, activeId: tabs[state.activeIndex]?.id ?? tabs[0]?.id ?? null }
}

/** The screen a paused tab was restored with, keyed by tab id. */
export function screensFrom(state: StoredTabs, tabs: Tab[]): Record<string, string> {
  const out: Record<string, string> = {}
  state.tabs.forEach((s, i) => {
    const id = tabs[i]?.id
    if (id) out[id] = s.screen
  })
  return out
}
```

- [ ] **Step 5: Run the suite until it passes**

Run: `node scripts/verify-restore.mts`
Expected: `all pass`.

- [ ] **Step 6: Add the paused case to `verify:tabs`**

Append to `scripts/verify-tabs.mts`, in the closing section:

```ts
console.log('\na paused tab is an ordinary member of the list')
check(
  'closing a paused tab selects its neighbour like any other',
  neighbourOf(['live', 'paused', 'other'], 'paused'),
  'other'
)
check(
  'resuming replaces the paused tab at its own index, so nothing reorders',
  replaceOrAppend([{ id: 'a' }, { id: 'paused' }, { id: 'c' }], { id: 'live' }, 'paused'),
  [{ id: 'a' }, { id: 'live' }, { id: 'c' }]
)
```

- [ ] **Step 7: Full check**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/types.ts src/renderer/src/lib/restore.ts scripts/verify-restore.mts scripts/verify-tabs.mts
git commit -m "Give a tab a paused state, and pin the conversion both ways

A paused tab has a session to resume but no process, which is not the same as
exited. The conversion is its own pure module because it is the only part of
this feature a suite can reach — the rest is a side effect in a closure."
```

---

### Task 4: The terminal registry and the debounced snapshot

**Files:**
- Create: `src/renderer/src/lib/termRegistry.ts`
- Modify: `src/renderer/src/components/TerminalView.tsx`
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `toStored` (Task 3), `window.stoke.tabs.save` (Task 2).
- Produces: `registerTerm(ptyId, term)`, `unregisterTerm(ptyId)`, `screenOf(ptyId): string` from `lib/termRegistry.ts`.

- [ ] **Step 1: Write the registry**

Create `src/renderer/src/lib/termRegistry.ts`:

```ts
import type { Terminal } from '@xterm/xterm'

/**
 * The live terminals, so anything outside a TerminalView can read one.
 *
 * xterm draws through WebGL, so `.xterm-rows` is empty and the screen is
 * readable only from the Terminal object (CLAUDE.md gotcha 5). The tab snapshot
 * needs exactly that, for every tab at once, which is why this is a registry
 * rather than a prop.
 */
const terms = new Map<string, Terminal>()

export function registerTerm(ptyId: string, term: Terminal): void {
  terms.set(ptyId, term)
}

export function unregisterTerm(ptyId: string): void {
  terms.delete(ptyId)
}

/**
 * The visible viewport as plain text, trailing blank lines dropped.
 *
 * The viewport rather than the buffer: it is what the user was looking at, and
 * on a byobu tab running Claude Code it is all there is anyway — that pane is on
 * the alternate screen, so no scrollback exists on either side (gotcha 29).
 *
 * `translateToString(true)` trims each line's trailing blanks, which is the
 * difference between a screen and a screen padded to 200 columns.
 */
export function screenOf(ptyId: string): string {
  const term = terms.get(ptyId)
  if (!term) return ''
  const buf = term.buffer.active
  const lines: string[] = []
  for (let row = 0; row < term.rows; row++) {
    lines.push(buf.getLine(buf.viewportY + row)?.translateToString(true) ?? '')
  }
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop()
  return lines.join('\n')
}
```

- [ ] **Step 2: Register from `TerminalView`**

In `src/renderer/src/components/TerminalView.tsx`, beside the existing `window.stokeTerminals` block (which stays — it is the CDP probe hook), add the registry calls. After `live.stokeTerminals.set(tab.ptyId, term)`:

```ts
    registerTerm(tab.ptyId, term)
```

and in the effect's cleanup, beside `live.stokeTerminals?.delete(tab.ptyId)`:

```ts
      unregisterTerm(tab.ptyId)
```

Import at the top: `import { registerTerm, unregisterTerm } from '../lib/termRegistry'`.

Also rewrite `copyScreen` to call the shared helper rather than repeating the walk:

```ts
  const copyScreen = (): void => {
    const text = screenOf(tab.ptyId)
    if (text) window.stoke.clipboard.writeText(text)
    termRef.current?.focus()
  }
```

Add `screenOf` to the same import.

- [ ] **Step 3: Add the debounced snapshot to `App.tsx`**

Beside the other effects in `src/renderer/src/App.tsx`:

```ts
  /*
   * Persist the open tabs, debounced.
   *
   * Debounced rather than written on quit, and that is the load-bearing choice:
   * `before-quit` cannot ask the renderer for state and wait for the answer, and
   * a snapshot taken only at quit is worthless in exactly the cases that hurt
   * most — a crash, an OOM kill, or the force-kill CLAUDE.md warns against.
   *
   * A paused tab keeps the screen it was restored with: it has no process, so
   * `screenOf` finds no terminal and returns '' for it.
   */
  useEffect(() => {
    const id = window.setTimeout(() => {
      window.stoke.tabs.save(
        toStored(tabs, activeTabId, contexts, (t) => screenOf(t.ptyId), Date.now())
      )
    }, 500)
    return () => window.clearTimeout(id)
  }, [tabs, activeTabId, contexts])
```

The resolver takes the whole tab rather than a pty id because Task 5 needs to
answer differently for a paused one. No paused tab can exist yet, so
`screenOf(t.ptyId)` is complete and correct here.

Import at the top: `import { toStored } from './lib/restore'` and `import { screenOf } from './lib/termRegistry'`.

- [ ] **Step 4: Prove it writes while you work**

```bash
npm run build
STOKE_USER_DATA=/tmp/stoke-restore-probe npx electron . --remote-debugging-port=9222 &
```

Start a session in the window, wait two seconds, then:

```bash
cat /tmp/stoke-restore-probe/tabs.json
```

Expected: a `tabs` array containing the session, with a non-empty `screen` and a `context` once the meter has read. This proves the registry, the debounce and the IPC together.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/lib/termRegistry.ts src/renderer/src/components/TerminalView.tsx src/renderer/src/App.tsx
git commit -m "Snapshot the open tabs while the app runs, not when it quits

before-quit cannot ask the renderer for state and wait, so a quit-only snapshot
misses every crash and force-kill. A 500ms debounce covers all of them. The
terminal registry replaces the walk Copy screen was doing inline, since the
snapshot needs the same screen for every tab at once."
```

---

### Task 5: Restoring at boot, and the paused tab

**Files:**
- Create: `src/renderer/src/components/PausedSession.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: `fromStored`, `screensFrom` (Task 3), `window.stoke.tabs.restore` (Task 2).
- Produces: `<PausedSession tab active screen onResume onClose />`.

- [ ] **Step 1: Write the component**

Create `src/renderer/src/components/PausedSession.tsx`:

```tsx
import type { Tab } from '../types'

interface Props {
  tab: Tab
  active: boolean
  /** The screen this tab had when Stoke last quit. May be ''. */
  screen: string
  /** Null when this tab cannot be resumed — see the card's copy. */
  onResume: (() => void) | null
  onClose: (tabId: string) => void
}

/**
 * A tab restored from the last run, waiting to be resumed.
 *
 * The stored screen is drawn behind the card rather than an empty pane, because
 * three paused tabs are otherwise indistinguishable apart from their titles —
 * and the screen is the thing that tells you which one you wanted.
 *
 * Plain text in a <pre>, not a terminal: the snapshot is text (the raw PTY
 * replay buffer cannot be safely resumed mid-repaint), and mounting a second
 * xterm per paused tab to render it would cost a WebGL context each.
 */
export function PausedSession({ tab, active, screen, onResume, onClose }: Props): React.JSX.Element {
  return (
    <div className="term-pane" hidden={!active}>
      <pre className="paused-screen" aria-hidden="true">
        {screen}
      </pre>
      <div className="paused-card" role="status">
        <span className="paused-title">{tab.title || tab.projectName}</span>
        <span className="paused-note">
          {onResume
            ? tab.hostId
              ? 'Paused when Stoke quit. Resuming reconnects to this host.'
              : tab.sessionId
                ? 'Paused when Stoke quit.'
                : 'Paused when Stoke quit. Resuming opens the most recent session in this folder.'
            : 'This host is no longer in Settings, so there is nothing to reconnect to.'}
        </span>
        <div className="paused-actions">
          {onResume && (
            <button className="btn" data-variant="primary" onClick={onResume}>
              Resume session
            </button>
          )}
          <button className="btn" data-variant="ghost" onClick={() => onClose(tab.id)}>
            Close tab
          </button>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Style it**

Append to `src/renderer/src/styles/app.css`, after the `.term-exit` rules:

```css
/*
 * A tab restored from the last run. The stored screen sits behind the card,
 * dimmed enough to read as context rather than as live output — three paused
 * tabs are otherwise the same empty pane with different titles.
 */
.paused-screen {
  position: absolute;
  inset: 0;
  margin: 0;
  padding: var(--space-8) var(--space-8) var(--space-8) var(--space-12);
  overflow: hidden;
  opacity: 0.28;
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--fs-sm);
  line-height: var(--lh-tight);
  white-space: pre;
  pointer-events: none;
  user-select: none;
}

.paused-card {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-8);
  text-align: center;
}

.paused-title {
  font-size: var(--fs-lg);
}

.paused-note {
  max-width: 22rem;
  color: var(--text-muted);
  font-size: var(--fs-sm);
}

.paused-actions {
  display: flex;
  gap: var(--space-8);
  margin-top: var(--space-8);
}
```

Check the token names against `:root` before committing — use whatever this stylesheet already defines for the mono family and the small font size, rather than inventing names.

- [ ] **Step 3: Restore at boot**

In `src/renderer/src/App.tsx`, add beside the other state:

```ts
  /** Screens for tabs restored from the last run, keyed by tab id. */
  const [restoredScreens, setRestoredScreens] = useState<Record<string, string>>({})
  /** True until the boot restore has been attempted, so nothing saves over it. */
  const restored = useRef(false)
```

And the boot effect, placed before the `startOnLaunch` effect:

```ts
  /*
   * Bring back the tabs from the last run, paused.
   *
   * Runs once. The guard is a ref rather than a dep list because a second pass
   * would overwrite whatever the user has already done in this run — including
   * under StrictMode's double-invoked effects, the same reason `autoStarted`
   * next door is a ref.
   */
  useEffect(() => {
    if (restored.current) return
    restored.current = true
    void window.stoke.tabs.restore().then((state) => {
      if (!state.tabs.length) return
      const { tabs: back, activeId } = fromStored(state)
      setRestoredScreens(screensFrom(state, back))
      setTabs(back)
      setActiveTabId(activeId)
      setRestoreCount(back.length)
    })
  }, [])
```

Add `const [restoreCount, setRestoreCount] = useState(0)` beside the other state — Task 6 renders the bar from it.

Imports: `import { fromStored, screensFrom, toStored } from './lib/restore'`.

- [ ] **Step 4: Render paused tabs**

In the render, the session tabs currently all map to `TerminalView` (`App.tsx:1126-1140`). Split on status:

```tsx
            {tabs
              .filter((tab) => tab.kind === 'session')
              .map((tab) =>
                tab.status === 'paused' ? (
                  <PausedSession
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTabId}
                    screen={restoredScreens[tab.id] ?? ''}
                    onResume={resumeTabFor(tab)}
                    onClose={closeTab}
                  />
                ) : (
                  <TerminalView
                    key={tab.id}
                    tab={tab}
                    active={tab.id === activeTabId}
                    theme={theme}
                    fontFamily={settings?.fontFamily ?? 'monospace'}
                    fontSize={settings?.fontSize ?? 13}
                    onOpenUrl={openUrl}
                    onRestart={restartTab}
                    onClose={closeTab}
                  />
                )
              )}
```

- [ ] **Step 5: The resume handler**

```ts
  /*
   * Resuming a paused tab replaces it at its own index — `replaceOrAppend` does
   * that already (lib/tabs.ts:31-41) — so the tab does not jump to the end of
   * the strip the moment you start it.
   *
   * Returns null when there is nothing to resume, which the card turns into a
   * Close-only state rather than a button that fails.
   */
  const resumeTabFor = useCallback(
    (tab: Tab): (() => void) | null => {
      if (tab.hostId) {
        const host = settings?.hosts.find((h) => h.id === tab.hostId)
        if (!host) return null
        return () => void startHostSession(host, tab.id)
      }
      return () =>
        void startSession({
          cwd: tab.cwd,
          name: tab.projectName,
          title: tab.title,
          sessionId: tab.sessionId || undefined,
          // No id means a --continue session, which never learned its own
          // (gotcha 26). Continue in the same folder instead.
          resume: Boolean(tab.sessionId),
          continueLast: !tab.sessionId,
          replaceTabId: tab.id
        })
    },
    [settings, startSession, startHostSession]
  )
```

Give `startHostSession` the second parameter it needs (`App.tsx:664`):

```ts
  const startHostSession = useCallback(
    async (host: SshHost, replaceTabId?: string): Promise<void> => {
```

and at its `setTabs` call (`App.tsx:696`) use `replaceTabId ?? activeNewTabId` instead of `activeNewTabId`.

Finally, extend the snapshot resolver from Task 4 Step 3 so a paused tab keeps
the screen it was restored with. A paused tab carries `ptyId: ''`, so the plain
call returns `''` and would quietly save an empty screen over a good one on the
first debounce after launch:

```ts
      window.stoke.tabs.save(
        toStored(
          tabs,
          activeTabId,
          contexts,
          (t) => (t.status === 'paused' ? (restoredScreens[t.id] ?? '') : screenOf(t.ptyId)),
          Date.now()
        )
      )
```

Add `restoredScreens` to that effect's dep list. `toStored`'s signature does not
change — it has taken the whole tab since Task 3 for exactly this reason.

- [ ] **Step 6: Run the check**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 7: Prove it in the running app**

```bash
npm run build
STOKE_USER_DATA=/tmp/stoke-restore-probe npx electron . --remote-debugging-port=9222 &
```

Open two sessions, quit the app properly from its menu (never force-kill — that orphans the CLI children), relaunch with the same command, and confirm both tabs come back with their screens behind Resume cards. Then click Resume on one and confirm the CLI comes up in the right folder with the prior conversation, and that the tab stays at its own index.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/src/components/PausedSession.tsx src/renderer/src/App.tsx src/renderer/src/lib/restore.ts src/renderer/src/styles/app.css
git commit -m "Bring the tabs back paused, and resume one in place

A restored tab has a session but no process until you ask for it, so launch
stays fast and an SSH tab does not reconnect to a host behind your back. Resume
goes through the existing startSession path with replaceTabId, so the tab does
not jump to the end of the strip when it starts."
```

---

### Task 6: The restore bar, and the paused-tab audit

**Files:**
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: `restoreCount` state (Task 5).
- Produces: nothing new; this task closes the loops the previous ones opened.

- [ ] **Step 1: Render the bar inside `.main-col`**

In `src/renderer/src/App.tsx`, immediately after the error banner inside `.main-col` (`App.tsx:1087-1095`):

```tsx
          {restoreCount > 0 && (
            <div className="restore-bar" role="status">
              <span className="restore-text">
                Restored {restoreCount} paused {restoreCount === 1 ? 'tab' : 'tabs'} from last time.
              </span>
              <button
                className="btn"
                data-variant="ghost"
                onClick={() => {
                  setTabs([newTab()])
                  setActiveTabId(null)
                  setRestoredScreens({})
                  setRestoreCount(0)
                }}
              >
                Start fresh
              </button>
              <button className="icon-btn" onClick={() => setRestoreCount(0)} title="Dismiss">
                <IconClose />
              </button>
            </div>
          )}
```

`Start fresh` does not need to clear `tabs.json` itself — the debounced save fires within 500 ms with the new single New tab and overwrites it.

**This strip must be inside `.main-col`.** Per gotcha 14, `.app` is a fixed three-row grid and a fourth row silently pushes the status bar into the body's track.

- [ ] **Step 2: Style it**

```css
/*
 * Says what happened at launch, with a way out. In the flow above the terminal,
 * exactly like the error banner and the worklog prompt, and for the same
 * reason: the docked browser is a native WebContentsView that paints over every
 * renderer pixel, and only `.main-col`'s own children survive it (gotcha 14).
 */
.restore-bar {
  display: flex;
  align-items: center;
  gap: var(--space-8);
  padding: var(--space-8) var(--space-12);
  border-bottom: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: var(--fs-sm);
}

/* Both needed, and neither is enough alone: the flex item must be allowed to
   shrink AND the text must be allowed to overflow, or a long line widens the
   whole shell instead of ellipsising (gotcha 14). */
.restore-text {
  flex: 1 1 0%;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

- [ ] **Step 3: Skip `startOnLaunch` when tabs were restored**

In the `autoStarted` effect (`App.tsx:731-739`), add the condition:

```ts
    // Restored tabs are what the user had; opening a session on top of them is
    // an extra nobody asked for.
    if (restoreCount > 0) return
```

placed after the existing `if (autoStarted.current) return` and **before** `autoStarted.current = true`, so a later restore result cannot be raced past.

- [ ] **Step 4: Audit every consumer of `status` and `ptyId`**

Work through these and fix each:

- `closeTab` (`App.tsx:762-782`) calls `window.stoke.pty.kill(tab.ptyId)` for any `kind === 'session'`. A paused tab has `ptyId: ''`. Guard it:

```ts
      if (tab.kind === 'session' && tab.status !== 'paused') {
        window.stoke.pty.kill(tab.ptyId)
        forgetPty(tab.ptyId)
      }
```

- The context-watch effect (`App.tsx` around `:505`) must not watch a paused session. A paused tab usually carries a **real** session id, so `ContextWatcher`'s falsy-id early return (`context.ts:102-103`) is not the guard here — it would poll the transcript of a session that is not running. Filter on `t.status === 'running'` before calling `watch()`.
- `watchedSessions` / the worklog: a paused session is not running, so exclude paused tabs from whatever feeds `window.stoke.worklog.watch()`.
- `restartTab` closes and re-starts; it is only reachable from `TerminalView`, which a paused tab never mounts. No change, but confirm.

- [ ] **Step 5: Run the check**

Run: `npm run check`
Expected: exit 0.

- [ ] **Step 6: Prove the bar and the guards**

Relaunch the probe profile with restored tabs and confirm: the bar appears with the right count, **Start fresh** leaves exactly one New tab, ✕ leaves the tabs and removes the bar, closing a paused tab does not throw, and `startOnLaunch` does not add a session on top of a restore.

Measure the layout rather than trusting the CSS (gotcha 14 was found this way and no reading of the stylesheet would have shown it):

```bash
node scripts/cdp-eval.mjs '(() => { const a=document.querySelector(".app").getBoundingClientRect(); return JSON.stringify({appW:a.width, winW:window.innerWidth, rows:getComputedStyle(document.querySelector(".app")).gridTemplateRows}) })()'
```

Expected: `appW` equals `winW` (the shell has not grown wider than the window) and `rows` still names three tracks.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/src/App.tsx src/renderer/src/styles/app.css
git commit -m "Say what was restored, and offer a way out of it

Also closes the loops a paused tab opens: closeTab no longer kills a pty that
does not exist, the context watcher no longer polls a transcript for a session
that is not running, and startOnLaunch no longer adds a session on top of a
restore. The bar sits inside .main-col, because a fourth row on .app shifts the
status bar into the body's track (gotcha 14)."
```

---

### Task 7: The paused tab in the strip

**Files:**
- Modify: `src/renderer/src/components/ContextMeter.tsx`
- Modify: `src/renderer/src/components/TabIndicator.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles/app.css`

**Interfaces:**
- Consumes: `RING_R`, `ContextRing` (existing).
- Produces: `ContextRing` gains `paused?: boolean`.

- [ ] **Step 1: Draw the pause glyph in the ring**

In `src/renderer/src/components/ContextMeter.tsx`, add the prop and the glyph. Follow the rule the watch dot already establishes: **anything that must line up with the ring is drawn inside the ring's own `<svg>`**, because a DOM box laid over vector art agrees in layout and disagrees by half a pixel once painted (gotcha 33).

```tsx
export function ContextRing({
  used,
  limit,
  ready = true,
  watched = false,
  paused = false
}: {
  used: number
  limit: number
  ready?: boolean
  watched?: boolean
  /** Restored from the last run: draw the reading, but say it is not live. */
  paused?: boolean
}): React.JSX.Element {
```

and inside the `<svg>`, in place of the fill arc when paused:

```tsx
      {paused ? (
        <path className="ring-pause" d="M5.6 6.6h4.8M5.6 9.4h4.8" />
      ) : (
        ready && (
          <circle
            className="ring-fill"
            cx="8"
            cy="8"
            r={RING_R}
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC * (1 - ratio)}
            strokeLinecap="round"
          />
        )
      )}
```

The `d` is in the same 16-unit viewBox as everything else in this SVG, so it scales with Interface scale for free. (Corrected here after implementation: an earlier draft of this step gave `d="M6.6 5.6v4.8M9.4 5.6v4.8"`, two *vertical* bars pre-rotation. `.ring` carries `transform: rotate(-90deg)` unconditionally, and that transform applies to every child including this path, so vertical bars pre-rotation come out *horizontal* on screen — an equals sign, not a pause icon. `ring-plus`'s cross is exempt from this because a plus is unchanged by a 90° turn; two parallel bars are not. The horizontal-bars-pre-rotation form above is what actually shipped, confirmed against a real screenshot.)

- [ ] **Step 2: Style the glyph**

```css
/* Paused: the ring keeps the reading it was saved with, and the arc is replaced
   by a pause glyph so a stale number cannot be mistaken for a live one. */
.ring .ring-pause {
  fill: none;
  stroke: var(--text-muted);
  stroke-width: 1.5;
  stroke-linecap: round;
}
```

Also fix `.paused-screen`, carried into this task from Task 5's review as: "re-applies padding
that `.term-pane` already applies to its padding box, so the dimmed text is double-indented
relative to where live terminal text actually sits." **That diagnosis is wrong, and was measured
to be wrong rather than assumed** — do not re-apply it as written. `.paused-screen` is
`position: absolute; inset: 0` inside `.term-pane`; `inset: 0` fills the nearest positioned
ancestor's own padding box, and padding lives *inside* that box rather than around it (border-width
is 0, so `.term-pane`'s padding box and border box share one top-left corner). So an `inset: 0`
child does not land inside `.term-pane`'s padding and get it applied twice — it coincides with
`.term-pane`'s own edges and needs padding of its own just to sit anywhere else. The two padding
values (`.paused-screen`'s own and `.term-pane`'s) are not compounding; they are doing the same
job twice, by coincidence landing on the identical value. Measured directly: with
`.paused-screen`'s padding forced to `0`, the text jumped 12px left and 8px up, flush with
`.term-pane`'s outer edge — a single indent's worth of movement, not the extra step "double"
would predict. The real defect is that nothing ties the two declarations together: change either
one alone and the paused `<pre>` drifts from the live terminal's text, silently. Fix it by dropping
`position: absolute; inset: 0` and the duplicate padding from `.paused-screen`, replacing them with
`width: 100%; height: 100%;` (keep `margin: 0`), which makes `.paused-screen` a normal-flow child of
`.term-pane` — exactly like `.term-host` is for the live pane — so it inherits `.term-pane`'s padding
structurally instead of re-declaring a copy of it. `.paused-card` stays `position: absolute; inset:
0` and keeps painting on top regardless: a positioned sibling paints after a static one in the same
stacking context whatever their DOM order.

- [ ] **Step 3: Pass it through `TabIndicator`**

In `src/renderer/src/components/TabIndicator.tsx`, `status` already arrives as a prop and now has a third value. Pass it down:

```tsx
      <ContextRing
        used={context?.contextTokens ?? 0}
        limit={context?.contextLimit ?? 0}
        ready={ready}
        watched={watched}
        paused={status === 'paused'}
      />
```

and widen the prop's type to `'running' | 'exited' | 'paused'`, adding to the `.sr-only` text:

```tsx
        {status === 'paused' ? 'Paused, restored from the last run. ' : ''}
```

- [ ] **Step 4: Feed the stored reading**

A paused tab has no live context snapshot, so `contexts[sessionId]` is undefined and the ring would draw empty. In `App.tsx`, seed `contexts` from the restore in the boot effect (Task 5 Step 3), after `setTabs(back)`:

```ts
      setContexts((prev) => {
        const next = { ...prev }
        state.tabs.forEach((s) => {
          if (s.sessionId && s.context) {
            next[s.sessionId] = {
              sessionId: s.sessionId,
              contextTokens: s.context.tokens,
              contextLimit: s.context.limit,
              ready: true,
              permissionMode: 'default'
            } as ContextSnapshot
          }
        })
        return next
      })
```

Check `ContextSnapshot`'s real field list in `src/shared/types.ts` before writing this and fill every required field rather than casting past them.

- [ ] **Step 5: Confirm the strip visually**

```bash
npm run build
STOKE_USER_DATA=/tmp/stoke-restore-probe npx electron . --remote-debugging-port=9222 &
node scripts/cdp-eval.mjs --shot /tmp/paused-strip.png
```

Open the PNG. A paused tab must be legible as paused at a glance — full opacity, its saved reading, a pause glyph where the arc would be — and distinct from an exited tab, which stays dimmed to 0.45.

- [ ] **Step 6: Full check and commit**

Run: `npm run check`
Expected: exit 0.

```bash
git add src/renderer/src/components/ContextMeter.tsx src/renderer/src/components/TabIndicator.tsx src/renderer/src/App.tsx src/renderer/src/styles/app.css
git commit -m "Make a paused tab legible in the strip

It keeps the reading it was saved with and swaps the arc for a pause glyph, so a
stale number cannot read as a live one. The glyph is drawn inside the ring's own
svg, because a DOM box over vector art agrees in layout and paints half a pixel
out (gotcha 33)."
```

---

### Task 8: The cases no suite can reach

Nothing here is coverable by `npm run check`, and every one of them is the feature the user actually asked for. This is the same method that established the three selection defects: drive the built app and measure.

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Clean quit**

Build, launch on a real profile, open three tabs — one local session, one SSH tab, one New tab. Quit from the app menu. Relaunch. Confirm all three come back, the two session tabs paused, the New tab a launcher with its selection intact, and the previously-active tab selected.

- [ ] **Step 2: Force-kill**

Repeat Step 1 but `kill -9` the main process instead of quitting. Confirm the tabs still come back — this is what the debounce buys, and it is the only proof of it.

Note the standing trap: force-killing orphans the CLI children. Clean those up afterwards with `pkill -f 'claude --'` before continuing, or the next launch shares the machine with them.

- [ ] **Step 3: Resume each kind**

- Local session with an id → comes up with the prior conversation, in the right folder, at the same tab index.
- SSH tab → reconnects, and nothing touched the host until the click.
- A `--continue` tab (`sessionId: ''`) → the card says "the most recent session in this folder" and resuming lands on a session there.
- A tab whose transcript has been deleted → resume fails into the existing error banner and the tab stays paused rather than vanishing.

- [ ] **Step 4: An actual update**

The case that prompted this. With a downloaded update pending, install it and confirm the tabs survive. `installSelfUpdate()` calls `autoUpdater.quitAndInstall(false, true)` (`selfUpdate.ts:249`), which quits through `before-quit` — verify that, do not assume it.

If it turns out `quitAndInstall` bypasses `before-quit` on this platform, the debounced write from Task 4 already covers it and the flush is redundant rather than load-bearing. Record which it was.

- [ ] **Step 5: Write down what was proven**

Add a gotcha to `CLAUDE.md` recording:
- that `before-quit` cannot ask the renderer for state, which is why the snapshot is debounced rather than taken at quit;
- whether `quitAndInstall` fires `before-quit` on macOS, measured rather than assumed;
- that a paused tab carries a real session id, so `ContextWatcher`'s falsy-id early return is **not** the guard that stops it polling — the renderer's `status === 'running'` filter is;
- and that none of this is reachable by `npm run check`.

Update the spec's `**Status:**` line to `implemented`.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-08-19-tab-restore-design.md
git commit -m "Record what the tab restore work proved, and what it cannot test

The debounce is what covers a crash and a force-kill; before-quit cannot ask the
renderer for state and wait. None of it is reachable by npm run check, so the
proof is the CDP pass, written down here so the next person does not redo it."
```

---

## Self-review

**Spec coverage.** §1 store → Task 1. §2 capture and debounce → Tasks 2 and 4. §3 paused tab → Tasks 3, 5, 7, plus the audit in Task 6 Step 4. §4 launch flow, bar, `startOnLaunch` → Tasks 5 and 6. §5 resume → Task 5 Step 5. §6 edge cases → Task 5 Step 1 (card copy), Task 5 Step 5 (`--continue`, missing host), Task 8 Step 3 (missing transcript). §7 verification → Tasks 1, 3 and 8. No section is unclaimed.

**Three corrections made while reviewing.**

1. `toStored`'s screen resolver was declared `(ptyId: string) => string` in Task 3 and silently redefined as `(tab: Tab) => string` in Task 5 — the exact drift this review exists to catch, and it would have saved `''` over every paused tab's screen on the first debounce after launch. It now takes the whole tab from Task 3 onward, and Task 5 only extends the callback.
2. `restoredScreens` was declared twice — a `useRef` in Task 4 and a `useState` in Task 5. Task 4 no longer declares it at all; it belongs to Task 5, which is the first task where a paused tab can exist.
3. Task 7 Step 4 originally said "the ring shows the stored reading", which is unachievable without seeding `contexts` from the restore. That step now does the seeding.

**No rough edges left between tasks.** Every task compiles and passes `npm run check` on its own, and no task rewrites a line an earlier task wrote.
