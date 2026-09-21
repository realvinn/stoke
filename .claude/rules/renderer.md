---
paths:
  - "scripts/verify-restore.mts"
  - "scripts/verify-shortcuts.mts"
  - "scripts/verify-tabs.mts"
  - "src/main/tabStore.ts"
  - "src/renderer/src/App.tsx"
  - "src/renderer/src/components/Launcher.tsx"
  - "src/renderer/src/components/PausedSession.tsx"
  - "src/renderer/src/components/SettingsSheet.tsx"
  - "src/renderer/src/components/StatusBar.tsx"
  - "src/renderer/src/lib/restore.ts"
  - "src/renderer/src/lib/shortcuts.ts"
  - "src/renderer/src/lib/tabs.ts"
  - "src/renderer/src/lib/ptyBus.ts"
  - "src/renderer/src/components/BusyDialog.tsx"
  - "src/renderer/src/components/AgentPicker.tsx"
  - "src/renderer/src/components/Campfire.tsx"
  - "src/renderer/src/components/FolderSwitcher.tsx"
  - "src/shared/launcher.ts"
  - "scripts/verify-launcher.mts"
  - "src/shared/activityView.ts"
  - "src/renderer/src/components/TitleBar.tsx"
---

# React state traps

Closures, double presses, values with two writers, the relaunch pill, and tab restore. Loaded when
a file in `paths` is read; CLAUDE.md keeps a one-line index of each. Numbers are permanent — code
comments cite them as "CLAUDE.md gotcha N".

## 31. A window-level listener registered in an effect keeps whatever its deps captured, and a suite cannot see it

**A window-level listener registered in an effect keeps whatever its deps captured, and a
suite cannot see it.** `App.tsx`'s keydown effect had deps
`[isMac, tabs, activeTabId, closeTab, openNewTab]` — no `settings`. Settings load
asynchronously, so the handler was first built while `settings` was still `null`, and the
zoom case's `if (!settings) break` therefore bailed **forever**. `verify:shortcuts` passed
every assertion, typecheck passed, the build passed, and pressing the key did nothing at
all. Only driving it over CDP found it, which is the entire argument for doing that.

Adding `settings` to the deps is the obvious fix and is wrong here in a second way: zooming
*is* a settings write, so the listener would be torn down and rebuilt on every keypress. A
ref updated on render (`settingsRef.current = settings`) is neither — the same idiom
`TerminalView` already uses for `openUrlRef`, and for the same reason.

The general form: **anything whose only observable effect is a side effect inside a
closure is invisible to a pure suite.** `matchShortcut` is pure and fully covered; the wire
from it to `patchSettings` is not, and that is where this lived.

## 35. Tab restore is carried by the debounced write, not by `before-quit` — and that is measured, not argued

**Tab restore is carried by the debounced write, not by `before-quit` — and that is
measured, not argued.** `tabs.json` is written synchronously on every `tabs:save` push, and
the `before-quit` write is only a retry for a push whose write failed (`writeTabState`
swallows its errors). Proven by the harshest available test: with two tabs open and a third
just closed, `kill -9` on the app — no clean quit, no `before-quit` at all — still restored
both tabs with their screens intact and kept the closed tab closed.

That test also settles the update case, which could not be exercised directly (the installed
app and the repo are both 0.5.2, so no update was pending, and an unpackaged probe run never
takes the `selfUpdate` path at all). A `kill -9` is strictly harsher than any quit
`quitAndInstall` can perform, so if the snapshot survives that, it survives an update
regardless of whether `before-quit` fires. **On macOS, closing the last window does not fire
`before-quit`** — `window-all-closed` skips `app.quit()` on the Mac branch — which is another
reason the per-push write has to be the load-bearing half.

What resume actually restores was verified against a real transcript, not a fabricated one:
the restored tab's title changed from its stored placeholder to the conversation's own
ai-title the moment `--resume` connected, the tab stayed at its own strip index, and the
other paused tabs were untouched.

**A restored tab can hold a session id that resumes to nothing**, and the failure surfaces
inside the terminal rather than in Stoke. `startSession`'s catch only covers `pty.start`
throwing; when the PTY starts and `claude` cannot find the conversation, the paused card is
replaced by a live session printing `No conversation found with session ID: …`. Reachable
without deleting a thing: start a session in a folder Claude Code has not seen, leave it at
the trust prompt, quit. No transcript is ever written, so the id Stoke persisted addresses
nothing. The design spec claimed the tab would stay paused; it does not, and that claim is
corrected in place.

> **Checked against the code on 2026-09-19.** Such a tab now comes back as a live, empty
> session under the same id: main decides `--resume` or `--session-id` against the disk right
> before the spawn (`resumeOrMint`, gotcha 81). And a quit that was Stoke installing its OWN
> update ("Restart and install") now brings the tabs back RESUMED — main writes
> `update-restart.json` beside `tabs.json` just before `quitAndInstall`, the next boot's
> `tabs:restore` consumes it (once, and only within ten minutes) and returns `afterUpdate`, and
> the renderer resumes each paused tab in turn through `resumeTabFor`. Every other quit — the
> silent install-on-quit included — restores paused, as before. Driven: with the marker, three
> restored tabs came back as three `claude` processes (`--resume` for the two with transcripts,
> `--session-id` for the one without); without it, two stayed paused and none started.

## 48. A session is stuck on the `claude` it spawned with, and nothing on screen used to say so

**A session is stuck on the `claude` it spawned with, and nothing on screen used to say
so.** Updating the CLI — by hand or by the six-hour auto-checker — changes the binary on
disk and changes nothing about any open session. The chat keeps working, on the old version,
indefinitely. There is no in-place swap: the only route is to stop the process and start
another, which is what the status-bar `relaunch on <version>` pill does, via the same
`startSession({ resume: true, sessionId })` a paused tab's Resume already used. The
conversation is not in the process — it is in the transcript, and `--resume` replays it.

**The version a session is running comes from its own statusLine payload, not from a stamp.**
`payload.version` was already typed in `StatusLinePayload` and simply never read; it is
`StatusLineSnapshot.cliVersion` now. Stamping the tab at launch instead would record what
Stoke *believed* was installed, which is a cache that goes stale in precisely the situation
the feature exists for.

**The two version sources do not agree on format, and this shipped broken until the built app
was driven.** `CliInfo.version` is `stdout.trim()` of `claude --version` — the whole line,
`"2.1.237 (Claude Code)"` — while the payload states a bare `"2.1.237"`. Compared raw they are
never equal, so the pill lit on every session on every machine, permanently, offering a
relaunch onto the binary already running. Every unit test written before it passed, because
both sides of those fixtures were bare numbers. It was found by launching against a shim that
reports `9.9.9 (Claude Code)` for `--version` and execs the real binary for everything else —
which is also the only way to produce the mismatch on demand — and reading the value back out
of `window.stoke.cli.info()`. `relaunchPlan` normalises both sides now, and
`verify:tabs` pins that raw-vs-bare pair first. Gotcha 31, one more time.

A `--continue` tab is refused rather than relaunched: its id is chosen by the CLI after launch
so `--resume` has nothing to name (gotcha 26), and resuming *the most recent session in the
folder* is usually this one and occasionally is not. Silently continuing the wrong conversation
is a far worse failure than no button. An SSH tab is refused too — its `claude` is on the far
machine, so the local version is not its version.

> **Checked against the code on 2026-09-19.** The running version now comes from the CLI's own
> session registry first (`LiveSessionState.version`, gotcha 80) and the payload's `cliVersion`
> second: the registry states it from the process's first second, the payload only once the TUI
> renders. Still normalised through `versionNumber`. And a `--continue` tab is offered once the
> registry names its id — the refusal above now covers only the first second or two, or a
> machine where the registry cannot be read.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - The pair is not literally first. In the relaunch section of scripts/verify-tabs.mts it sits at :202-211, after two bare-number relaunchPlan checks at :178-187, and it was in the same order at 6fce051, when this text was written. 'First' is only true as priority: the suite's own comment at :189-191 calls it 'the assertion that matters most in this file'.

## 51. A slow action with no feedback gets clicked again, and `replaceOrAppend` turns the second click into a second tab

**A slow action with no feedback gets clicked again, and `replaceOrAppend` turns the second
click into a second tab.** The relaunch pill kills its session and starts a replacement, which
takes a couple of seconds during which nothing on screen moves. A second click lands before
React has re-rendered, so `activeTab` still names the OLD tab — `replaceOrAppend` finds nothing
with that id the second time and **appends** instead of replacing.

Measured both ways against the built app, five clicks dispatched in one tick on a real resumed
conversation: without the guard, **5 tabs and five `claude` processes all resuming the same
transcript**; with it, 1. Not hypothetical, and not rare — two seconds of dead time on a
status-bar pill is exactly what invites the second press.

The fix is two mechanisms, and folding them into one does not work. A **ref** claimed before
the kill is the correctness half (gotcha 20's shape: the claim has to precede the irreversible
act, not the await after it), because state has not re-rendered the disabled button yet. A
**state** flag is the honest half, so the pill says `relaunching…` rather than sitting there
looking ignored. Released in `.finally`, because `startSession` catches its own errors and
resolves `false` — releasing only on success would strand the pill on a session already killed.

> **Checked against the code on 2026-09-19.** The guard is per TAB now (`relaunchingRef` is a
> Set): the automatic relaunch (`cliRelaunch: 'auto'`) can move a background tab while the pill in
> front is pressed. Same two halves, same reason.

One placement detail that is easy to get backwards: the busy check has to come **before** the
plan, not be folded into it as a `disabled` prop. Mid-relaunch the old process is dead and the
replacement has not landed, so `relaunchPlan` legitimately reads `none` for a frame or two —
gating on the plan alone made the pill vanish at the exact moment it was doing something, which
reads as the click having dismissed it.

## 57. Two writers on one value, one of them invisible to the other

**Two writers on one value, one of them invisible to the other.** App kept `mode`, `model`,
`effort` and `ultracode` as `useState`, seeded once on boot from `settings.defaults` and
written by the launcher. The Sessions pane writes `settings.defaults` directly through
`onPatch` and never touched that copy — so changing a default in Settings updated the file
and left the launcher both SHOWING and LAUNCHING with the old value, until a restart re-seeded
it and the evidence vanished. They are derived from `settings` now, and the four change
handlers do nothing but patch.

The general form, which has now cost time three times in this file (gotchas 31, 45, and here):
**a value that exists in two places has to have exactly one writer, or the second one is a
cache with no invalidation.** The tell is a bug that "fixes itself" on restart.

## 82. The relaunch pill killed turns mid-reply, and "idle" does not mean nothing would be lost

**A relaunch is SIGHUP and a fresh `claude --resume`, and SIGHUP in the middle of a turn loses the
turn.** No `Stop` fires, the reply being streamed is never persisted, and the resumed session opens
on `Interrupted · What should Claude do instead?`. The pill had no busy check at all. The CLI's own
registry now says whether a turn is running (gotcha 80): `busy`, `shell` and `waiting` (a permission
dialog is the middle of a turn) count as busy, a missing status is "cannot say", and only a stated
`idle` is idle. `requestRelaunch` asks when busy — **Force restart** (the turn is lost, and the
dialog says so), **Wait** (relaunch the moment it goes idle), Cancel — and relaunches unasked only on
idle or unknown, as it always did. Driven against the built app: a 300-line reply in flight, the
pill pressed, the dialog up (screenshot), Wait chosen, the pill read `relaunch when idle… ×`, and the
relaunch fired when the turn ended — the transcript holds the complete reply and no "Interrupted".

Three things carry beyond the dialog:

- **`idle` does not prove the prompt box is empty.** Typing a draft leaves the registry `idle`
  (measured), so the automatic relaunch (`cliRelaunch: 'auto'`) would throw away unsent text in a
  background tab. `noteInput`/`typedSinceSubmit` (ptyBus.ts) track "typed since the last submit" —
  set by anything `looksTyped` (escape sequences stripped: focus reports, mouse reports and colour
  answers are xterm talking, not the user), cleared when the registry goes busy or a prompt hook
  fires. An automatic relaunch refuses such a tab and never takes the tab in front; Wait, which the
  user chose looking at the tab, does not. Whether this catches every draft — a draft restored by
  the CLI's own history, say — is unverified; it errs towards leaving the pill.
- **Level-triggered automation needs a one-shot key.** The automatic relaunch acts on "this tab's
  plan is an offer", not on "the version just changed", so a CLI updated by hand, by the checker, or
  before the setting was switched on are all one case. But a relaunch that comes back on the OLD
  version (a `claude` on PATH that is not the one `claude --version` answered for — exactly what the
  test shim is) would then be relaunched again every second. `autoRelaunchKey` (session@version) is
  tried once. Driven: a background tab relaunched once and was left alone for the next 18 seconds
  while the pill stayed lit.
- **The pending relaunch is a ref claimed before anything async, dropped when the tab exits or
  closes** (`pendingRelaunchStep` → `drop` on a plan that is no longer an offer). A relaunch that
  outlives its reason would later kill a session nobody asked to have killed.

> **Checked against the code on 2026-09-21.** "Cleared when the registry goes busy or a prompt hook
> fires" was too broad in both halves: a `<task-notification>` prompt is the CLI's, not a submit, and
> most pushes that read busy (`busy -> shell`, `waiting -> busy`, a workflow) submit nothing. Now only
> a typed prompt (`promptClearsDraft`) and the registry's edge into `busy` from `idle` or no reading
> (`registryClearsDraft`) clear it — gotcha 104.

## 83. A veto that counts what is still pending lapses the moment something else clears it

**`startOnLaunch` was vetoed by `restoreCount > 0` — the number of tabs STILL paused.** That was
right while only the user resumed tabs. The update-restart resume (gotcha 35's note) resumes them
itself within a second of boot, before `cli.info()` has answered, so by the time the auto-start
effect was allowed to run the count had fallen to 0 and it opened a session in the default folder
beside the ones it had just restored. Measured on the first drive: two restored tabs, three `claude`
processes. The veto is `restoredSessions` now — whether the restore HAD any session tab — read from a
ref set before `restoreSettled` flips. The general form: a guard on a count that another path is
busy decrementing is a race with that path; guard on the event, not the residue.

## 88. An overlay that does not make the page behind it inert is a keyboard shortcut to whatever has focus there

**The first-run splash said "Click anywhere, or press Escape" over a launcher whose Start button
already had focus, and handled only Escape.** An Enter pressed to get past it — the reflex, and
what the QA did — went to that button and started `claude` in the default folder (`~/dev` on the
machine it was found on), under the splash and then the agent picker, where nobody saw it
happen. Found twice, once from a stray keystroke three seconds after boot. Tab from the agent
picker's Continue likewise walked out of its `aria-modal` dialog onto "Toggle sidebar" behind it.

Three locks now, because each covers a hole the others leave:

- **`inert` on the shell's three rows** (`.titlebar`, `.body-row`, `.statusbar` — the overlays are
  their siblings) whenever `overlayOpen || welcome`. Set in a **`useLayoutEffect`**, and that is
  load-bearing: React runs a child's passive effects BEFORE its parent's, so with a plain
  `useEffect` the launcher's "overlay gone, focus Start" ran while the button was still inert, the
  `focus()` silently did nothing, and focus sat on `<body>` — measured, it is the bug the first
  version of this fix shipped with.
- **The splash swallows every key** (capture on `window`, `preventDefault` + `stopPropagation`) and
  any plain key dismisses it. A held key's repeats are swallowed by `launcherKey`'s `swallow` rule
  once the splash is gone, and by the picker's own capture listener, so they cannot press the
  button that takes focus next.
- **The launcher focuses its primary only while nothing is over it**, and again when the last
  overlay closes (`overlayOpen` is in the effect's deps), rather than once on mount.

And two races that only showed while driving it:

- The agent picker waited for `welcome` to be null — which it is both BEFORE the async splash
  decision and after it declines. On a fast machine detection landed first, the picker opened,
  the splash then drew over it, and the Enter meant for the splash also answered a picker nobody
  had seen. It waits on `welcomeSettled` now.
- Between the splash going and the picker opening there was a gap: measured, the splash went at
  1161ms and the picker came at 1419ms, and for those 258ms Start had focus and the shell was
  live, so the dismissing Enter tapped twice started `claude` under the picker. `firstRunPending`
  keeps the shell inert from boot until the splash decision is made and, on a launch that will
  ask, until the picker has opened — released early if detection throws or takes longer than
  `FIRST_RUN_WAIT_MS`, since an inert shell with no picker coming is a window nothing can be
  typed into.

Measured on a fresh profile against a `claude` shim that logs every launch (2026-09-19): splash
at 654ms with focus on `<body>` and the shell inert; Enter held (one press, three repeats) plus
two fresh Enters 150ms apart. The shell stayed inert through the gap, the picker opened with
Continue focused and the second fresh Enter pressed it (which installs nothing: only installed
agents are ticked), focus landed on Start Claude Code, and the shim's log held only `--version`
probes.

> **Checked against the code on 2026-09-19 (review round).** The three locks above did not cover
> the picker itself: a fresh Enter every 40ms from boot answered it before it painted (it opens
> with Continue focused), and the next Enter started `claude` in the user's most recent REAL
> project, since the fallback aim is that project. A fourth lock now: `pressAllowed`
> (shared/launcher.ts) over the window's one burst record (`lib/pressBurst.ts`, registered first
> from main.tsx so every other capture listener sees the press already folded in). Presses under
> `PRESS_QUIET_MS` apart are one burst, repeats always continue one, and a surface ARMED at time T
> takes an Enter/Space only from a burst that began at least `PRESS_ARM_MS` after T. The picker
> arms when it mounts; the launcher is armed (`armedAt`) when the splash is dismissed or the
> picker closes, and never by the palette or Settings, whose Enter-then-Enter is a real flow.
> Measured with the launch-logging shim on a fresh profile: 66 fresh Enters at 40ms from boot left
> the picker up and the shim with only `--version` probes; after a 1.2s pause one Enter answered
> it; 34 more Enters at 40ms straight after did not press Start; after another pause one Enter
> started it. The splash also stopped cancelling chords: `preventDefault` on Cmd+Q/W/R kept the
> default menu's accelerators from ever seeing them (not drivable over CDP: synthetic key events
> carry no native event for the menu).

## 90. Closing a tab had none of the relaunch pill's busy check, and killed the same way

`closeTab` calls `pty.kill`, the same SIGHUP gotcha 82 documents for the relaunch pill: mid-turn it
fires no `Stop` hook, the reply being streamed is never persisted, and a later Resume opens on
"Interrupted". Cmd+W, every tab's × button and TitleBar's own close button all called `closeTab`
directly, so none of them had the check `requestRelaunch` already does — measured live, a prompt
that was still visibly generating was gone from `ps` immediately after Cmd+W, with no dialog at
all.

`requestCloseTab` is now the one guarded door: it reads the same registry status (gotcha 80,
`live[tab.ptyId].busy`) `relaunchPlan` reads, and only a STATED busy/shell/waiting asks first,
reusing `BusyDialog` with a new `kind: 'close'` prompt — "Close anyway" or Cancel. Idle, exited,
paused (no process to kill) and — deliberately — a tab with **no registry reading at all** close at
once, unchanged: the registry is Claude Code's own file (gotcha 80), so a non-Claude CLI's pty is
never listed in it, and asking about every non-Claude tab forever (or the half-second before
Claude's first write) would be a worse cost than the rare miss, matching what the relaunch pill
already accepts for an unknown reading.

`BusyDialog` gained an optional `onWait`/`waitLabel`/`waitHint`: a close has nowhere to come back
to the way a relaunch or a restart does, so there is nothing to wait FOR, and the dialog falls back
to focusing Cancel instead of a Wait button that would not exist.

**Not covered, on purpose:** closing the whole window (the titlebar's red/× button, Cmd+Q, the Dock
menu) still kills every tab's session unconditionally, via `win.on('closed')` → `ptys.killAll()`.
That handler fires only after the window is already destroyed — an Electron `'closed'` cannot be
cancelled, so gating it would mean adding a NEW, cancelable `'close'` listener plus an async
main→renderer→main round trip before the app is allowed to quit, on top of the flush ordering
gotcha 35 already documents as fragile at exactly this moment. CLAUDE.md's own standing convention
("Quit properly so before-quit runs `ptys.killAll()`") already treats quitting the whole app as a
deliberate, coarser action than closing one tab. Left as a risk for whoever owns app-quit
lifecycle, not silently — this note is that flag.

> **Checked against the code on 2026-09-19.** Adding `onWait` introduced a focus regression:
> the relaunch and restart callers both pass an inline `onWait={() => answerBusy('wait')}`, and
> `BusyDialog`'s focus effect depended on `[onWait]`, so a fresh callback identity on every App
> re-render re-ran it and pulled focus back to Wait even after the user had tabbed to Cancel —
> measured live, focus Cancel, cause any unrelated re-render, and Enter fired Wait instead. The
> close dialog was never affected (`onWait` is always undefined there). Fixed by depending on
> `!!onWait` with an empty effect-deps array, so the effect can only ever run once, on mount.

## 93. No cadence separates "tapping Enter through the intro" from a deliberate Enter, so the launcher waits for a different kind of input

**Gotcha 88's burst rule stopped a held or mashed Enter, and a person tapping Enter every 500ms
still started `claude`.** Measured by the QA against c67897c (2026-09-19): trusted Enter pairs
500ms apart from launch — one answered the agent picker at 564ms, focus moved to Start, and the
next tap started a real `claude` at 1103ms, in whatever folder the fallback aim had picked (on a
real machine, the user's most recent real repo). `pressAllowed` treats any press more than
`PRESS_QUIET_MS` after the previous one as a fresh burst, so each tap was "deliberate" by that
rule. Any quiet period short enough not to annoy is one a slow tapper clears.

So after the first run (the launcher's `armedAt`, set when the splash or picker goes away) the
launcher asks for a different KIND of input before an Enter/Space can press anything:
`isDeliberateInput` — a pointer press, or any key that is not an activation key or a lone modifier
(Tab, an arrow, Escape) — recorded window-wide in `lib/pressBurst.ts` (`deliberateAt`, trusted
events only). `launcherPressAllowed` needs the burst rule AND a deliberate input since arming, and
`launcherHoldsFocus` keeps focus on the card (tabIndex -1) instead of Start until then, with a
visible "Click Start, or Tab to it, to begin". Tapping Enter never produces a deliberate input, at
any speed. Launches with no first run (`armedAt` null) are unchanged: Start is focused and Enter
starts. The picker keeps only the burst rule — its Continue installs nothing unticked, and Enter
answering it is the flow.

Proven in a fresh sandbox profile with the QA's own script (8 Enters, 500ms apart, from launch):
the picker was answered, focus rested on the card with the hint, and the claude shim's launch log
held only `--version` probes.

## 104. A Stop is the end of a TURN, not of the work, and a permission prompt is answered with no hook

**The activity dot and the "Finished" notification were driven by hooks alone, and two things the
hooks cannot say were read as things they did.** Measured against claude 2.1.278 (2026-09-21):

- **A Stop fires at the end of every turn, including one that ends while a workflow or a background
  subagent it started is still running.** Its input carries `background_tasks` (the CLI's own
  friendly `type` — `workflow`, `subagent`, `shell`, `monitor`, `MCP task`, `teammate`, … — plus
  `status`, `description`, and `name`/`agent_type`/`command` per kind). A real one from a Stoke events
  file: `[{type:"workflow",status:"running",name:"stoke-indicators-and-freeze"},{type:"shell",…}]`.
  `parseHookEvent` dropped it. Meanwhile the registry (gotcha 80) stays `busy` for the whole
  workflow — the binary's rule is busy = loading OR any live `local_agent`/`local_workflow`/
  non-idle `in_process_teammate`/non-long-running `remote_agent` — while a background Bash alone
  reads `shell` (a dev server: forever) and a Monitor alone reads `idle`. So the dot went `done`
  (or vanished, in front) and the OS said "Finished" with the workflow still running.
- **Each finished background task starts a turn** with a `UserPromptSubmit` whose prompt opens
  `<task-notification>` (a teammate's message opens `<agent-message `). The schema has a `source`
  field for this (`user`, `system`, `schedule_wakeup`, …) and 2.1.278 sends it on no prompt captured
  here. App called `clearTyped` on every prompt hook, so gotcha 82's typed-draft guard was dropped
  for a tab nobody had submitted anything in — and on every registry push reading busy, which
  includes `busy -> shell`, `waiting -> busy` and a workflow holding `busy` for an hour.
- **`waiting` is level-triggered and the hook is not.** The registry says `waiting` with a
  `waitingFor` (`permission prompt`; `input needed` for AskUserQuestion and MCP elicitation;
  `dialog open` for a panel; `sandbox request`, `worker request`, `goal proposal`) until it is
  answered. The `permission_prompt` Notification fires once and nothing says it was answered. The
  hook's `attention` entry was deleted the moment the tab was in front and focused, so the one tab
  whose prompt you were looking at had no dot, and after answering (`waiting -> busy`, no hook)
  there was no dot for the rest of the turn.
- **A pty that died mid-turn kept pulsing**: no Stop ever came, the registry keeps its last reading
  (the file goes before the pty does), and TitleBar never read `tab.status`.

**One pure function decides now: `activityView` (src/shared/activityView.ts)**, fed the hook entry for
the tab's CURRENT session id and the registry reading for its ptyId (gotcha 80), and derived at render
(gotcha 57 — `activity` already had five writers; the Stop's `background` is one more field on the
existing writer, not a sixth). The table, all of it asserted in `verify:registry`:

| running | registry | hook | dot |
| --- | --- | --- | --- |
| no | any | done / anything else | `done` / none — never a pulse |
| yes | `waiting`, not `dialog open` | any | `waiting` (not cleared by looking) |
| yes | none, or `waiting` + `dialog open` | any | the hooks alone, exactly as before |
| yes | `busy` | Stop listing a running workflow/subagent | `background`, labelled with it |
| yes | `busy` | Stop, nothing agent-like | `done`, or `working` if busy was stated after it |
| yes | `busy` | prompt / attention / none | `working` |
| yes | `idle` | prompt | `working`, or `done` if idle was stated after it |
| yes | `shell` | prompt | none, or `done` if shell was stated after it |
| yes | `idle`/`shell` | Stop / attention / none | `done` / none / none |

A Stop notifies only when it lists no running workflow or subagent (`stopNotifies`); looking clears
an entry only when its view is not `working`/`background` (`clearedByLooking`, re-run when `live`
moves); a prompt clears the draft guard only when typed (`promptClearsDraft` over
`SessionEvent.promptOrigin`), and the registry only on the edge into `busy` from `idle` or no reading
(`registryClearsDraft`). BusyDialog says "Background work is running" for a `background` tab — no
reply is in flight, the workflow is what a kill loses.

Trade-offs that are deliberate, so nobody "fixes" them back:

- **Not "registry busy always wins".** Both polls run once a second on their own phase, so a Stop is
  routinely read before the registry says idle. `statusUpdatedAt` (the CLI's clock) against the
  hook's read time breaks the tie; unknown trusts the hook.
- **`shell` never pulses**, at the cost of a blank dot for up to a second after a prompt typed while
  a dev server runs, until the registry says `busy`.
- **Only workflows and subagents hold back "Finished".** A teammate is busy only while not idle and
  a cloud session not at all when long-running; the hook cannot tell, and a notification that never
  comes is worse than an early one.
- **`dialog open` is never an alert**, per the design — though the binary's table also uses it for
  dialogs the CLI raises itself (plugin hints, a managed-settings review).
- **No registry reading means the hooks alone, exactly**: a workflow Stop still draws `done` there,
  since nothing could say when the workflow ends (the notification is still held back).
- **A `/clear` typed while the registry says `shell` leaves the draft guard set** (no prompt hook, and
  not an edge from idle). That errs the way gotcha 82 already chose: the automatic relaunch leaves
  such a tab alone.

Not proven by any suite (gotcha 31): the wire from a real `session:event`/`session:state` to the
painted dot, `seenActive` re-running on `live`, the notification being withheld, and what reduced
motion paints. Drive the built app over CDP to prove them.

> **Checked against the code on 2026-09-21** — review of the change above; four rules moved.
> - **Looking marks, it does not delete** (`afterLooking`). A Stop is usually read before the
>   registry's idle push, so deleting the `done` entry of the tab in front left a lagging `busy` with
>   nothing to weigh it against: "Claude is working…" and a pulse for up to a second after almost
>   every turn. A `done`/`attention` is now kept with `seen: true` — no dot of its own, but still the
>   Stop that outweighs a busy stated before it, and still the list of what a `background` turn runs.
>   A `working` entry is dropped as before. The table's rows hold for an unseen entry; a seen one
>   draws nothing wherever the row says `done` or the hooks-alone attention dot.
> - **The idle -> busy clear is provisional** (`draftOnRegistry`/`draftOnPrompt`, per-pty
>   `DraftTrack` in App, flag written back with ptyBus's `setTyped`). The CLI starts turns of its own
>   on an idle session — a task's notification, a teammate's message, a wake-up — and those go idle
>   -> busy too. A machine-injected prompt hook read within `DRAFT_EDGE_WINDOW_MS` (2 s) after the
>   edge restores what it cleared (OR keys typed since); read before it, the edge clears nothing. A
>   typed prompt, or no prompt hook in the window (a slash command fires none), lets it stand.
> - **Keys typed at a dialog answer the dialog.** The flag is snapshotted on the edge INTO `waiting`
>   and put back on the edge out (to anything), so answering a permission prompt no longer made the
>   automatic relaunch skip the tab until the next prompt. Accepted: a slash command that opens a
>   panel (`idle -> waiting`, `dialog open`) was typed, so the guard stays up after it closes.
> - **2.1.278 never sends `source`**: its UserPromptSubmit input spreads `...!1` where the field
>   would go (read out of the bundle; it computes `loop_wakeup`/`schedule_wakeup` and drops them).
>   An autonomous `/loop` tick is recognisable by the CLI's own opening (`# Autonomous loop check`,
>   `# Autonomous loop tick`, `# /loop tick —`, `WAKEUP_OPENINGS` in statusLine.ts) and is `system`.
>   A `/loop 5m <prompt>` or CronCreate task fires the user's own text and still reads as typed —
>   it clears the guard, the unavoidable error while nearly every prompt is typed.
>
> Also: `sameState` (sessionRegistry.ts) compares `statusUpdatedAt`, so a busy blip inside one pass
> (a prompt, then Esc) reaches the renderer as a newer idle stamp and settles the dot; the CLI moves
> that stamp only when it writes a status or `waitingFor`. The status bar dot's reduced-motion rule
> lost on specificity to the rules it stilled and has its own block after them now. All asserted in
> `verify:registry` and `verify:statusline`; the painted result is still gotcha 31's to prove.
