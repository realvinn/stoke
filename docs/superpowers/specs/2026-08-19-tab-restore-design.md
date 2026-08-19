# Restoring open tabs across a quit or an update

**Status:** approved, not yet implemented
**Date:** 2026-08-19

## The problem

Quitting Stoke — or installing an update, which quits it — loses every open tab.
`before-quit` runs `ptys.killAll()` (`src/main/index.ts:1419-1420`), and per this
repo's own standing traps a restarted app cannot reattach to a CLI child that
outlived it. So the tabs are gone and the only record of what was open is the
user's memory. `installSelfUpdate()` even carries the comment "Callers should
warn that running sessions will end" (`src/main/selfUpdate.ts:244`), which is
the pain stated from the other side.

## What we are building

Stoke remembers the set of open tabs and brings them back **paused**: each tab
reappears with its project, title and the last screenful of its output, but no
CLI is running until the user clicks Resume.

Resuming is a relaunch, not a reattach — `claude --resume <sessionId>` in the
same folder, which is exactly what the sidebar's existing resume button already
does (`App.tsx:987-999`). Reattaching to the original process is not possible
without a detachable multiplexer between Stoke and the CLI, and that is out of
scope.

### Decisions taken

| Question | Decision |
| --- | --- |
| What comes back | Every tab, paused. Nothing is launched at boot. |
| How much screen state | The visible viewport as plain text, dimmed behind the Resume card. |
| Does it ask first | No. It restores, then shows a dismissible bar with a "Start fresh" escape. |

The third decision is a deliberate departure from Chrome. Chrome asks because
reloading pages costs network and CPU; here a restored tab costs nothing until
it is clicked, so a blocking question would be friction with no benefit. The bar
gives the same control without stopping the launch.

## 1. Where the state lives

New module `src/main/tabStore.ts`, writing `tabs.json` into userData. Modelled
on `src/main/worklog/sessionStore.ts`: atomic write through `renameSync`,
explicit caps, an age cut-off, and **no `electron` import**, so a verify suite
can exercise it under `node --experimental-strip-types` with no window. Relative
imports carry explicit `.ts` extensions, per the repo convention.

Rejected alternatives:

- **`settings.json`** — that file is user configuration and passes through
  `hydrate()`'s repair-and-clamp machinery (`settingsSchema.ts`). A snapshot
  rewritten on every tab change would churn it, and anything the schema did not
  recognise would be silently dropped. A volatile cache does not belong in a
  config file.
- **`localStorage` in the renderer** — no IPC needed, but main is where quit
  happens, and an unpackaged dev run resolves userData differently
  (`index.ts:1387-1389`), so the two would disagree about which profile they
  belong to.

### Shape

```jsonc
{
  "version": 1,
  "savedAt": 1755500000000,
  "activeIndex": 1,
  "tabs": [
    {
      "kind": "session",              // 'session' | 'new'
      "sessionId": "0f6f6b08-…",      // '' for a --continue session, see §6
      "cwd": "/Users/thevinh/dev/personal/stoke",
      "projectName": "stoke",
      "title": "Fix the watcher dot",
      "permissionMode": "bypassPermissions",
      "model": "opus",
      "effort": "xhigh",
      "hostId": null,                 // SshHost.id for a remote tab
      "selectedPath": null,           // 'new' tabs only
      "expandedPath": null,
      "lastActiveAt": 1755499000000,
      "context": { "tokens": 62104, "limit": 200000 },
      "screen": "› npm run check\n  all pass\n"
    }
  ]
}
```

`id`, `ptyId`, `status` and `exitCode` are deliberately absent: the first two are
regenerated on restore and the last two are always "paused" by definition.

### Caps

Mirroring `sessionStore.ts`'s reasoning, and each one is a cap on a different
axis so one runaway cannot be hidden by another:

- `MAX_STORED_TABS = 20` — more tabs than the strip stays legible at, and enough
  that nobody hits it in normal use.
- `MAX_SCREEN_BYTES = 8_192` per tab — roughly one 120×50 screen of text. The
  tail is kept, not the head, and it is trimmed on whole lines.
- `STORED_TAB_MAX_AGE_MS = 14 days` — past that the folder is likely a different
  piece of work, the same reasoning `STORED_SESSION_MAX_AGE_MS` already uses.

Over-cap tabs are dropped oldest-first by `lastActiveAt`. A corrupt or
unparseable file is treated as empty, never as a fatal error: losing the tab
list is a nuisance, failing to start is not.

## 2. What is captured, and when

The renderer owns both halves of the snapshot — the tab list is React state and
the screen text comes from each terminal's own buffer — so the renderer builds
it and hands it to main.

The screen is captured with the same walk `Copy screen` uses:
`term.buffer.active`, `getLine(viewportY + row)`, `translateToString(true)`,
trailing blank lines dropped.

**Plain text, not raw PTY bytes.** Main already retains a replay buffer
(`pty.ts:34,404`) and takes care to drop whole chunks so a replay never starts
mid-escape-sequence (`:270`). That is sound for replaying into a *live* terminal,
but a tail of it fed to a dead one is a coin toss: `claude`'s TUI paints with
absolute cursor positioning, so an arbitrary tail may or may not contain a full
repaint. Text always renders, is small, and needs no terminal to display.

**Written continuously, debounced, not only on quit.** A ~500 ms debounce on any
change to the tab list, plus a flush when a tab's title or context changes. Main
writes synchronously on every push, which is what makes the snapshot survive a
crash.

The `before-quit` write is a **retry, not a catch-up**, and calling it a flush
oversells it: because every push has already written synchronously, it can never
persist anything newer, and anything the renderer has not sent yet is still in
its debounce and unreachable from main. What it does cover is a push whose write
failed — `writeTabState` swallows its errors — which gets one more attempt on the
way out.

This is the load-bearing choice for reliability: `before-quit` cannot ask the
renderer for state and wait for the answer, and a snapshot taken only at quit is
worthless in precisely the cases that hurt most — a crash, an OOM kill, or the
force-kill this repo already warns against. A continuously-fresh snapshot costs
one small write per few seconds of activity and covers all of them.

New IPC channel in `src/shared/ipc.ts` (add there first, per convention):

```ts
// tab restore
tabsSave: 'tabs:save',      // renderer -> main, fire and forget
tabsRestore: 'tabs:restore' // renderer -> main, read once at boot
```

## 3. What a paused tab is

`Tab.status` gains a third value: `'running' | 'exited' | 'paused'`. A paused tab
carries `ptyId: ''`.

`TerminalView` is keyed on `tab.ptyId` and is simply not mounted for a paused
tab. A new `PausedSession` component renders in its place: the stored screen in
the terminal font at reduced opacity, with the Resume card centred over it.

Every consumer of `status` and `ptyId` must be audited, because both now have a
value they have never seen:

- `ptyBus` — no subscription for a paused tab; nothing to attach to.
- `ContextWatcher` — **must not be started for a paused tab.** The early-return
  on a falsy session id (`context.ts:102-103`) is not the guard here: a paused
  tab usually *does* carry a real session id, so `watch()` would happily poll a
  transcript for a session that is not running. The renderer calls `watch()` only
  when a tab goes to `running`. The paused ring is drawn from the persisted
  `context` reading instead, which is why that field is stored.
- `TabIndicator` — `[data-status='exited']` currently dims to 0.45. Paused gets
  its own treatment, distinct from exited: exited means the process ended, paused
  means it is waiting to start. Paused keeps full opacity, draws the ring from
  the stored reading, and replaces the fill arc with a pause glyph.
- The worklog gate and `sessionCwds` — a paused session is not running, so it
  should not be watched until resumed.

## 4. Launch flow

At boot the renderer reads the store over `tabs:restore`. If it returns tabs,
they become the initial tab list instead of the single New tab
(`App.tsx:110`), in their stored order, with the stored tab active.

A `.restore-bar` appears above the terminal area:

```
Restored 3 paused tabs from last time.        Start fresh   ✕
```

**Start fresh** closes every restored tab, clears the store, and leaves a single
New tab. **✕** dismisses the bar and keeps the tabs.

The store is **not** cleared by a successful restore — the next debounced save
overwrites it. That is deliberate: if Stoke crashes before the first save of the
new run, the same tabs come back again, which is the behaviour anyone would want.
Only "Start fresh" empties it.

**Placement is a known trap.** Per gotcha 14, `.app` is a fixed three-row grid
(`titlebar / body / status`); a new full-width strip must go **inside
`.main-col`** (`App.tsx:1086`). Adding a fourth row to `.app` silently shifts the
status bar into the body's track. The strip also needs `min-width: 0` on its
text and `flex: 1 1 0%` so a long project list ellipsises rather than widening
the whole shell.

**`startOnLaunch` is skipped when tabs were restored.** That setting opens a
session in the default folder at boot (`App.tsx:731-739`); firing it on top of a
restored set gives an extra session nobody asked for. The `autoStarted` ref
already guards a single attempt, so this is one added condition.

## 5. Resuming one tab

Clicking Resume calls the existing launcher with the tab as its own replacement:

```ts
startSession({
  cwd: tab.cwd,
  name: tab.projectName,
  title: tab.title,
  sessionId: tab.sessionId,
  resume: true,
  replaceTabId: tab.id
})
```

`replaceOrAppend` already replaces in place at the same index
(`lib/tabs.ts:31-41`), so the paused tab becomes the live one with no reordering
and no flash of a new tab appearing elsewhere.

`startHostSession` needs a `replaceTabId` parameter added — today it always
consumes `activeNewTabId` (`App.tsx:696`), which is wrong when the tab being
replaced is a paused remote tab rather than a launcher.

## 6. Edge cases

- **SSH tabs.** Restored paused; clicking Resume reconnects. Nothing touches the
  remote machine at launch, which matters when the host command is `byobu` —
  attaching creates a grouped session. If `hostId` no longer matches a host in
  settings, the card says the host is gone and offers only Close.
- **`--continue` sessions have no id.** Per gotcha 26, `pty.ts:165-166` leaves
  `sessionId` as `''` for a `--continue` launch, because the CLI picks the id
  itself after launch. Such a tab cannot be resumed by id. It resumes with
  `continueLast: true` in the same cwd, and the card says "the most recent
  session in this folder" rather than implying it is the same one — which it may
  not be, if another session ran there since.
- **Transcript gone.** `--resume` against a deleted session fails; `startSession`
  already catches and surfaces it through `setError` (`App.tsx:582-584`). The tab
  stays paused rather than vanishing, so the user can read the error and then
  close it deliberately.
- **A `new` tab** restores its `selectedPath` and `expandedPath` and is otherwise
  free — it has no session and nothing to resume.
- **An exited tab** restores as paused like any other. In the paused model the
  two are indistinguishable to restore, and pretending otherwise would add a
  state that buys nothing.

## 7. Verification

New `scripts/verify-restore.mts`, added to `npm run check`. Pure, no electron,
following `verify-settings.mts`'s shape:

- round-trip: a tab list survives save → load unchanged, `context` included
- caps: over-20 tab lists drop oldest-first; an 80 KB screen is trimmed to 8 KB
  on a line boundary, keeping the tail
- expiry: a tab older than 14 days is dropped, one at 13 days is kept
- corruption: truncated JSON, a BOM, `null`, an array at the root, and a future
  `version` all load as empty rather than throwing
- what it drops: unknown keys are not carried forward; `ptyId` and `status` are
  never persisted even if present in the input

Plus a case in `verify-tabs.mts` for selection after closing a paused tab, since
`neighbourOf` now runs over a list that can contain them.

**What no pure suite can cover**, and must therefore be driven against the built
app over CDP before this is called done — gotcha 31's lesson, and the method
that established all three selection defects in the previous piece of work:

1. Quit with three tabs open and confirm all three come back paused.
2. Resume one and confirm the CLI comes up in the right folder with the right
   conversation, and that the tab is replaced in place.
3. Force-kill the app and confirm the debounced snapshot still restores.
4. Install an update and confirm the tabs survive it, which is the case the user
   actually asked for.

## Out of scope

- Reattaching to a still-running CLI process. Would need a detachable
  multiplexer between Stoke and the CLI; a separate piece of work.
- Restoring the full scrollback. Considered and rejected: megabytes per tab, and
  `--resume` redraws the conversation anyway once the session is live.
- Restoring browser panel tabs or worklog panel state.
