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

## 83. A veto that counts what is still pending lapses the moment something else clears it

**`startOnLaunch` was vetoed by `restoreCount > 0` — the number of tabs STILL paused.** That was
right while only the user resumed tabs. The update-restart resume (gotcha 35's note) resumes them
itself within a second of boot, before `cli.info()` has answered, so by the time the auto-start
effect was allowed to run the count had fallen to 0 and it opened a session in the default folder
beside the ones it had just restored. Measured on the first drive: two restored tabs, three `claude`
processes. The veto is `restoredSessions` now — whether the restore HAD any session tab — read from a
ref set before `restoreSettled` flips. The general form: a guard on a count that another path is
busy decrementing is a race with that path; guard on the event, not the residue.

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
