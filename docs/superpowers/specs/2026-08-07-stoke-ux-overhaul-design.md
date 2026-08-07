# Stoke UX overhaul — design

**Date:** 2026-08-07
**Status:** approved, ready for implementation planning
**Scope:** nine reported problems across the title bar, sidebar, profiles, worklog, project
discovery, usage meter and context meter.

---

## 1. How this was diagnosed

Twelve agents swept the codebase: six investigators (one per problem area) and six adversarial
verifiers whose job was to *refute* the first pass. The verification round mattered — it
overturned several confident-sounding claims and found the single largest blocker. Where a
finding below is stated as fact it survived that round or was measured directly; where it is
inference it says so.

Three things were measured against the live machine rather than read:

- The real `claude` 2.1.221 startup banner, captured through `@lydell/node-pty` exactly as
  `pty.ts` spawns it.
- The real `statusLine` JSON payload, captured through a `--settings` override — first on a
  cold session, then after one real request.
- CSS geometry, by reproducing the shipped rules in Chromium and changing one property at a
  time to prove causation.

## 2. The problems, and what actually causes them

### 2.1 The context meter reports 200k for a 1M session

`windowFromBanner` (`sessionFile.ts:284-296`) looks for `(1M context)` in the CLI's startup
output. **The CLI no longer prints it.** The captured banner for 2.1.221 is:

```
Claude Code v2.1.221    Opus 5 with low effort · Claude Max
```

The word "context" does not appear anywhere in the startup output. So `windowFromBanner`
returns `null` and `contextLimitFor` (`sessionFile.ts:302-310`) falls through to
`observedTokens > WINDOW_STANDARD ? WINDOW_EXTENDED : WINDOW_STANDARD` — meaning a 1M session
reads 200k until it crosses 200k, which is precisely the failure the function's own doc comment
was written to prevent. `CLAUDE.md` gotcha 2 documents the `(1M context)` banner; that was true
when written and is now stale.

### 2.2 The usage chip renders nothing on macOS

Not platform-gated anywhere. `readOauthToken` (`usage.ts:60-67`) reads exactly one location on
every platform:

```js
const raw = await readFile(join(homedir(), '.claude', '.credentials.json'), 'utf8')
```

That file does not exist on macOS — the token is in the login Keychain. So the read returns
`null`, `fetchUsage` bails at `usage.ts:170` with `empty('Not signed in to Claude Code.')`, and
`UsageMeter.tsx:106` renders `null`. Everything downstream works. It is only the token.

(Naming correction for the spec's readers: the chip is `<UsageChip />` in the **title bar**,
`TitleBar.tsx:168`. `StatusBar.tsx` contains no usage code at all.)

### 2.3 The in-terminal usage line

Not Stoke chrome. It is the user's own global `statusLine`
(`~/.claude/settings.json` → `bash ~/.claude/statusline-command.sh`). Stoke has no code touching
it. There is no CLI flag to disable it; `--safe-mode` and `--bare` have unacceptable collateral.

Measured against 2.1.221 in a real PTY:

- `--settings '{"statusLine":{"type":"command","command":""}}'` → clean startup, no line.
- `--settings '{"statusLine":null}'` → blocking `SettingsError` dialog. Must be a valid object.
- **A second `--settings` silently discards the first.** `cli.ts:228-233` already emits one for
  ultracode, so the statusLine key must be folded into that same file, never appended.

### 2.4 The worklog never does anything

Four independent causes, in order of severity.

1. **Recall cannot succeed.** `recall.ts:248` sets `maxBudgetUsd: 0.15`, and recall deliberately
   runs *without* `--safe-mode` and *with* MCP (it must — `CLAUDE.md` gotcha 15). It exhausts
   that budget before it can answer. This defeats the feature regardless of configuration.
2. **The write path has no budget at all.** `applyProposal` is called from the `worklogAccept`
   handler with neither `maxBudgetUsd` nor `claudePath`, sitting on the same silent cliff.
3. **The gate misses unregistered folders.** `groupForCwd` (`gate.ts:66-98`) does a
   longest-prefix match against known projects. `/Users/thevinh/dev/work` is *itself* a
   registered Claude project, so it swallows every sibling that has no history of its own, and
   `basename(dirname("/Users/thevinh/dev/work"))` yields group `dev` — not `work`. Verified by
   running the shipped `listProjects` + `shouldWatch` against the live config: 5 of 12 work
   subfolders are watched (`buyback`, `postable`, `Protech-IT-Site`, `shonenfresh`, `Shopify`),
   the rest are not.
4. **Nothing is observable.** `src/shared/ipc.ts:98-104` defines only
   `worklog:queue|scan|accept|reject|changed|proposed`, and `index.ts:257` emits
   `worklogProposed` only `if (auto && added.length)`. A zero-result scan emits nothing; errors
   are caught and dropped. "Working but nothing to report" and "never ran" are indistinguishable.
   The queue file is written on first mutation and does not exist on this machine, confirming no
   proposal has ever been produced here.

Also: the Notion and ClickUp targets are compiled in (`runner.ts:37-38`,
`NOTION_DATA_SOURCE` / `CLICKUP_LIST_ID`) with no way to narrow to one board, and all autoscan
state is in-memory (`autoscan.ts:148`, `index.ts:69`) so a restart resets every baseline.

**Refuted during verification** (recorded so nobody re-derives them): the 20-minute
`mutedUntil` cooldown cannot bite when enabling the feature from off, because `enabled()` gates
the write (`autoscan.ts:239`); and an SSH-only worklog *is* possible via the manual path, which
never reads `worklogGroups`.

### 2.5 Adding a new folder does nothing

`index.ts:498-505` opens the folder picker and returns the path **without persisting it** — no
`setSettings`, no write. `listProjects` has no source that can represent a single explicitly
added folder: its no-history source is scan roots, which enumerate a folder's *children*, so the
root itself never becomes a project (`projects.ts:209-213`). There is no per-project metadata
store anywhere (`types.ts:77-93`), so an emoji or a display name has nowhere to live.

`planProfile` (`profiles.ts:144`) compares folder names case-sensitively off Windows
(`profiles.ts:31`). On case-insensitive APFS that is wrong: `planProfile('/Users/thevinh/dev',
'Work')` returns `action: 'reuse', root: '/Users/thevinh/dev/Work'` — a casing that does not
exist on disk, and it is persisted. None of this folder logic is covered by any verify suite.

`resolveDefaultCwd` (`workspace.ts:19-32`) lists no candidate that exists on this machine.

### 2.6 The tab indicator and close button are misaligned

Three separate offsets, each confirmed by changing one property and re-measuring.

- **Horizontal, 2.5px.** The reset at `app.css:26-32` resets only `font` and `color`. Chromium's
  UA `button { padding: 1px 6px }` survives, leaving `.tab-close` a 6px content box for an 11px
  glyph, so inline-axis centring never applies. Setting `padding: 0` restores 3.5/3.5. **This
  affects every `.icon-btn` in the app**, and worsens as Interface scale drops, because the rem
  box scales while the UA padding and the `width={11}` attribute do not.
- **Vertical, 2px.** `.tabs` has `padding-top: var(--sp-1)` with `align-items: stretch`
  (`app.css:264-275`), so tab contents centre at y=24.0 while every other title-bar icon centres
  at y=21.5. The author already fixed exactly this for the `+` button alone (`app.css:294-297`,
  *"Measured, not reasoned — both icons now centre at 22"*). Verified: `padding-top: 0` moves the
  dot from 24.0 to 22.0. The separate 0.5px `border-bottom: none` effect is **contained within**
  this 2px, not additive.

### 2.7 The tab dot is wrong in four ways

- It is **red on every tab** on this machine, because `defaults.permissionMode` is
  `bypassPermissions` and `.tab-dot[data-state='bypass']` is `var(--danger)` (`app.css:387`).
  It reads as an alert; it is a mode.
- It **disappears** the moment the context watcher is ready — `TitleBar.tsx:103-112` swaps in
  `ContextRing`, taking permission and exit status with it.
- The swap **moves the whole tab**: `.tab-dot` is 7px, `.ring` is 14px, so the label and ✕ jump
  7px with no transition.
- It **can lie**: `tab.permissionMode` is captured at launch and no `setTabs` writer in
  `App.tsx` ever updates it, so toggling with Shift+Tab leaves it stale.

Red currently means three different things in the strip: bypass mode, a ≥90%-full context ring
(`app.css:899`), and the close button's hover fill (`app.css:370`).

### 2.8 `+` does not create a tab

`App.tsx:675`: `onNewTab={() => setActiveTabId(null)}`. It clears the selection; nothing is
appended to `tabs`. The "new session" state has no representation in the strip. The Launcher is
already effectively the New Project tab's content — it just is not a tab.

### 2.9 Profiles do not follow tabs

`App.tsx:719` is the only writer of `activeProfile`, and it is the sidebar chip. Tabs carry no
profile identity (`types.ts:4-18`); it is derivable only from `cwd`, and the helper that does so
(`gate.ts:66-98`) lives in the main process.

**Verified safe to change:** `grep -rn activeProfile src/main/` returns exactly one hit — the
`store.ts:61` default. Nothing in the worklog path reads it, so auto-switching the chip cannot
disturb the gate's documented invariant. SSH tabs are the exception: `App.tsx:427` sets
`cwd: host.alias`, not a path, so they cannot be mapped.

Two adjacent defects: `deriveProfiles` (`shared/profiles.ts:263-267`) early-returns a hardcoded
Windows-era list and suppresses the folder-derived fallback; and `PROFILES[0].accent` is
`#ff9552`, identical to EMBER's accent, so a profile switch can be visually invisible on the
default theme. `hydrate` (`store.ts:82-127`) repairs every other structured field but passes
`activeProfile` through unvalidated.

### 2.10 The sidebar

- **Hover out-shouts selection** in all three dark themes (`app.css:730-737`). The selected
  project reads as less prominent than whatever the mouse is over. The command palette is the
  inverse (`app.css:1662` uses `--accent-soft` for its active row), which is why the sidebar
  reads as broken rather than merely subtle.
- **The nested session list is outdented 4px** from its parent project title
  (`app.css:787-794`).
- **Project metadata hangs 24px left of its own title**, so a row reads as two fragments
  (`app.css:714-719`, `760-766`).
- **Session rows have no active state at all** — the session backing the open terminal is styled
  identically to every other one.
- **Clicking a project hides the running terminal** (`App.tsx:698-701` sets `activeTabId` to
  null, and `App.tsx:769` hides `.term-stack` on that condition).
- **Enter/Space are inverted** from list convention: Enter starts a session, Space selects.

### 2.11 Spacing, scale and platform

- The scale is 4/6/8/12/16/20/28/40 — not a strict 4px scale — and inner control paddings bypass
  it entirely, producing nine near-but-unequal control heights.
- There is no line-height token: five distinct ad-hoc values, `body` sets none.
- Every SVG is a fixed-px attribute (`Icons.tsx:7-9`), so Interface scale resizes every button
  and leaves every icon behind — a 37.5% linear (61% areal) change between scale 1.0 and 1.6.
- `uiScale` is never clamped on the write path (`SettingsSheet.tsx:128`); a number input's
  `min`/`max` are advisory in React's `onChange`.
- **macOS-specific:** `app.css:216` clears the traffic lights with `padding-left: 4.875rem`, a
  *rem*, while the traffic lights are fixed device px. Stoke is only correctly laid out on macOS
  at Interface scale exactly 1.0.
- Untokenised colours remain at `app.css:1565` (`.backdrop`), `1795` (`.theme-chip`) and `2004`
  (`.usage-panel`), plus four `#fff`.
- `role="tablist"` (`TitleBar.tsx:80`, `BrowserPanel.tsx:106`) contains non-tab children.

---

## 3. Architecture decision: the statusLine data channel

Stoke installs its own `statusLine` command for the sessions it spawns, folded into the single
existing `--settings` argument at `cli.ts:228-233`.

The CLI pipes a JSON payload to that command on stdin and prints its stdout as the terminal's
status line. Captured from 2.1.221 after one real request:

```json
{
  "model": { "id": "claude-opus-5", "display_name": "Opus 5" },
  "context_window": {
    "context_window_size": 1000000,
    "used_percentage": 28,
    "current_usage": { "input_tokens": 10, "cache_read_input_tokens": 15645, ... }
  },
  "exceeds_200k_tokens": false,
  "rate_limits": {
    "five_hour":  { "used_percentage": 15, "resets_at": 1786078200 },
    "seven_day":  { "used_percentage": 3,  "resets_at": 1786647600 }
  }
}
```

(`context_window_size` was `1000000` for Opus 5 and `200000` for Haiku — it is per-model and
correct.)

One channel therefore replaces three mechanisms:

| Replaced | By |
|---|---|
| `windowFromBanner` regex on a string the CLI no longer prints | `context_window.context_window_size` |
| `contextLimitFor` inferring tier from observed usage | direct, correct from token zero |
| Keychain / OAuth token read + account API call | `rate_limits.five_hour` / `seven_day` |

And because the wrapper owns stdout, suppressing the in-terminal line is the same act as reading
the data.

**Wrapper contract.** Read stdin; write the payload where the main process can pick it up, keyed
by `session_id`; then print either nothing (suppressed) or the user's original statusLine
command's output (pass-through). The user's `~/.claude/settings.json` is never modified.

**Accepted trade-off.** The payload only arrives while a session is open and rendering. With no
session open the usage chip shows its last known figures with an "as of HH:MM" tooltip. The
Keychain path is **not** implemented.

**Fallbacks retained.** `windowFromBanner` and the observed-usage inference stay as fallbacks for
CLI versions that do not emit the payload, but are no longer the primary source.

---

## 4. Workstreams

### A · Title bar and Chrome-style tabs

1. Reset the UA button padding in the global reset (`app.css:26-32`). Fixes `.tab-close` and
   every `.icon-btn` in one change.
2. Centre tab contents on the title bar's centreline (y=21.5) — cancel `.tabs`' top padding for
   tab *content* while the tab's painted box still meets the pane below.
3. Give the indicator a fixed 14px slot so the dot→ring swap moves nothing.
4. **New indicator semantics.** The context ring is always present; an empty circle when there
   is no data yet. A **red dot inside the ring** means *the worklog is watching this session* —
   that is the indicator's only meaning. Bypass mode no longer owns red and gets its own
   treatment, and the ≥90% ring no longer uses `--danger`, so red means exactly one thing in the
   strip.
5. Keep `permissionMode` live — update it on change instead of freezing it at launch.
6. `+` appends a real New Project tab. Several are allowed, which requires lifting
   `selectedPath` / `sessions` out of App-level state (`App.tsx:60-63`) into per-tab state.
7. Drag-to-reorder tabs.
8. Closing a tab selects its neighbour, not the last tab (`App.tsx:481`).
9. Fix the `role="tablist"` children in both strips.

### B · Profiles follow tabs

1. Activating a tab sets `activeProfile` from its cwd — colour and filter both follow.
2. Make cwd→group→profile resolution available to the renderer (share `groupForCwd` or expose it
   over IPC) rather than duplicating the longest-prefix rule.
3. SSH tabs never change the profile. Tabs that resolve to no profile leave the chip unchanged.
4. Fix `deriveProfiles`' early return so the folder-derived fallback is reachable.
5. Ensure a profile switch is always visible on the default theme.
6. Repair `activeProfile` in `hydrate` like every other structured field.

### C · Worklog

1. Measure a Notion-only recall's real cost; raise `maxBudgetUsd` above it with headroom.
2. Give `applyProposal` its own explicit budget and `claudePath`.
3. Surface budget exhaustion as a stated reason, never as an empty result.
4. Make the gate root-aware: when no registered project matches, fall back to the watched scan
   root that contains the cwd.
5. Case-fold `pathKey` on macOS (`gate.ts:36-38` currently folds only on Windows).
6. Replace the compiled-in board IDs with settings: target (Notion / ClickUp / both, defaulting
   to **Notion only**) and editable IDs.
7. Observability, three layers: the panel's empty state states whether *this* session is watched,
   which groups are armed, and the last scan and its result; the title-bar button shows
   disarmed / watching / badged; the per-tab ring dot marks watched sessions.
8. Persist autoscan state so a restart does not reset every baseline.

### D · Folders

1. Persist the path chosen by `projectsAdd` (`index.ts:498`).
2. Add a per-project metadata store keyed by path: `{ emoji?, label?, addedManually? }`.
3. Give `listProjects` a source for explicitly added folders.
4. Fix `planProfile`'s case-sensitivity on macOS and cover it with a verify case.
5. Give `resolveDefaultCwd` candidates that exist on macOS.

### E · Statusline channel

1. Fold the statusLine key into the existing `--settings` file. Never emit a second `--settings`.
2. Ship the wrapper; route `context_window` and `rate_limits` into the main process.
3. Setting: "Hide Claude's status line in Stoke", default **on**, with pass-through when off.
4. Point the context meter at `context_window_size`; keep the banner and observed-usage paths as
   fallbacks.
5. Point the usage chip at `rate_limits`; show last-known with an "as of" tooltip when no session
   is open.

### F · Sidebar and spacing

1. Clicking a project no longer clears `activeTabId` — the terminal stays visible.
2. Correct the Enter/Space inversion.
3. Selection out-ranks hover in every theme.
4. Session rows gain an active state for the one backing the open tab.
5. Fix the 4px outdent and the 24px metadata offset.
6. Migrate to a strict 4px scale (4/8/12/16/24/32/48). This is a visible density change; every
   screen is reviewed afterwards.
7. Add line-height and icon-size tokens; make icons scale with Interface scale.
8. Clamp `uiScale` on the write path.
9. Make the macOS traffic-light clearance px, not rem.
10. Tokenise the three remaining literal colours and the four `#fff`.

---

## 5. Verification

`npm run check` must pass. New or extended suites:

- `verify:context` — extend with the statusLine payload path and a 1M-tier case that does not
  depend on the banner.
- `verify:profiles` — add `planProfile` coverage, including the macOS case-insensitive path
  (currently uncovered; the one existing test locks in the wrong behaviour).
- `verify:worklog-gate` — add the root-aware fallback and a macOS case-folding case.
- `verify:usage` — repoint at the statusLine payload.
- New: a statusLine wrapper suite covering payload parsing, suppression, and pass-through.

Per `CLAUDE.md`, UI work is verified by launching with `--remote-debugging-port` and driving over
CDP; screenshots are the only reliable way to confirm the terminal and panels render. The tab
geometry fixes specifically need before/after measurement of the centre lines, since that is how
the defects were established.

## 6. Config repair on this machine

Separate from the code, and to be done explicitly:

- Repoint `projectRoots` from `/Users/thevinh/dev/work/Work` to `/Users/thevinh/dev/work`.
- Delete the empty `/Users/thevinh/dev/work/Work` directory after confirming it is empty.
- Set the worklog target to Notion only.

Note: the case-sensitivity bug is confirmed, but that it *created* this particular folder is not
proven — re-running `planProfile('/Users/thevinh/dev/work','Work')` today returns
`action: 'reuse'`. The repair is correct either way.

## 7. Out of scope

- Reimplementing anything against the SDK. Stoke wraps the real CLI in a PTY; that is unchanged.
- Any change to the worklog gate's core rule that watching is keyed on the session's own cwd and
  never on the sidebar chip. `gate.ts`'s header documents why, and workstream B is safe precisely
  because it does not touch it.
- Bundling a native Keychain binding.
- Restructuring the docked browser beyond the shared alignment fixes it inherits.
