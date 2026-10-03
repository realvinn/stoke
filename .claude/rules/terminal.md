---
paths:
  - "src/renderer/src/components/TerminalView.tsx"
  - "src/renderer/src/components/RemoteTerminal.tsx"
  - "src/shared/sizeClaim.ts"
  - "src/renderer/src/lib/lastInput.ts"
  - "src/renderer/src/lib/mouseReport.ts"
  - "src/renderer/src/lib/termRegistry.ts"
  - "scripts/verify-selection.mts"
  - "src/shared/voiceRoute.ts"
  - "scripts/verify-voice.mts"
  - "src/renderer/src/components/VoiceSettings.tsx"
  - "src/renderer/src/components/MicPicker.tsx"
  - "src/shared/voice.ts"
  - "src/shared/voiceLevel.ts"
  - "src/shared/micDevice.ts"
---

# Terminal: xterm selection, links, OSC

TerminalView and what xterm decides for it: mouse reporting and selection, links, and OSC 11 theme
following. Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of each.
Numbers are permanent — code comments cite them as "CLAUDE.md gotcha N".

## 5. xterm's WebGL renderer draws into a canvas

**xterm's WebGL renderer draws into a canvas**, so `.xterm-rows` is empty in the DOM.
Verify terminal output from a screenshot, never `textContent`.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - This entry is older than `window.stokeTerminals` (added in 256de60). termRegistry.ts:13-22 publishes every live Terminal for CDP probes, in release builds too, so text, cursor and cell widths can be read from `term.buffer.active` (`screenOf`, :42-52). A screenshot is still the only proof of what painted. Also, termRegistry.ts:18-19 says the suites read this map, but grep finds no suite that does.

## 10. Claude Code turns mouse reporting on, so a plain drag does not select

**Claude Code turns mouse reporting on, so a plain drag does not select.** xterm forwards
the drag to the application instead, and the bypass modifier is per-platform in xterm's own
`shouldForceSelection` (`SelectionService.ts:437`, xterm 6.0.0):

    isMac ? event.altKey && rawOptions.macOptionClickForcesSelection
          : event.shiftKey

**Shift**-drag has therefore always worked on Windows and Linux, because that branch
consults no option at all. The Mac branch does, and `macOptionClickForcesSelection` defaults
to `false` and was set nowhere — so it could only ever return `false`, and selection on
macOS was not awkward but impossible: Option-drag did nothing, Cmd+C had no selection to
take, and the right-click menu's Copy sat permanently disabled. The asymmetry is why it read
as "copy is broken" rather than "one option is missing". `TerminalView` now sets
`macOptionClickForcesSelection: true` (d34cf8e), which makes Option-drag work — the same
modifier Terminal.app and iTerm2 use, and no collision with `macOptionIsMeta` two lines
above it, which governs the keyboard while this governs the mouse.

**The documented gesture is now Shift-drag on every platform**, because one gesture beats
three. xterm offers no option for that — the Mac branch above reads `altKey` and nothing
else — so `TerminalView` retells the event: a Shift-drag is caught in the capture phase and
re-dispatched with `altKey` set. Two things make that safe rather than clever. Synthetic
MouseEvents drive xterm's selection exactly as real ones do, which `verify:selection`
relies on for every case it runs; and the synthetic Alt cannot become a *block* selection,
because `shouldColumnSelect` is `altKey && !(isMac && macOptionClickForcesSelection)`
(`:591-593`) — xterm gates the two meanings of Alt against each other precisely so they
cannot both fire. Asserted directly: an alt drag from one row to the next comes back
wrapping the first line's tail, which a column selection never would. Option-drag still
works, since the option it needs is still on.

**The clone must DROP Shift, not merely add Alt, and getting that wrong is what made a VPS
session impossible to copy out of.** xterm branches on whether selection is *enabled*
before it ever consults the force-selection modifier:

    if (this._enabled && event.shiftKey) { this._handleIncrementalClick(event) }
    else                                 { … _handleSingleClick(event) … }

(`SelectionService.ts:478`). `_enabled` is true exactly when mouse reporting is **off**
(`CoreBrowserTerminal.ts:547-552`, `:731-739`), and `_handleIncrementalClick` (`:523-527`)
only moves the *end* of an existing selection — so with nothing selected yet it is a no-op
and the drag selects nothing at all. A clone carrying both modifiers therefore worked under
`claude` and dead-ended at every plain shell prompt. A local tab always spawns `claude` and
reports the mouse for its whole life, so it never showed; **an SSH tab is the only tab that
can sit at a shell** — `hosts[].command` of `byobu` here, and byobu enables no reporting
*of its own* — which is why this read as "copying is broken on the VPS" and nowhere else,
and why it came and went *within* one tab as `claude` started and exited.

Do not read that as "a byobu tab never reports the mouse", which is the tempting and wrong
conclusion. **tmux forwards the focused pane's own mouse mode to the outer terminal even
with its own `mouse` option off** — measured against the real VPS (tmux 3.4, `mouse off`)
by capturing what tmux wrote to an ssh pty: an inner app asking for 1000/1002/1006 produced
exactly those at the outer end. So a byobu pane running `claude` puts Stoke's xterm in
`mouseTrackingMode: 'drag'`, and it drops back to `'none'` at the shell prompt — per pane,
so it also changes as you move around byobu. `1002` is what actually arrives, which is why
`verify:selection`'s default `modes` string is `1000h 1002h 1006h` rather than the set
`claude` asks for locally.

That is also why the shim is no longer macOS-only. Off macOS `shouldForceSelection` is
`event.shiftKey` (`:442`) and needs no help *while the mouse is reported*, but it walks into
the same dead branch at a shell prompt, natively. So the retelling is keyed on
`term.modes.mouseTrackingMode` rather than on the platform, and Alt is added only where
xterm demands it: macOS with reporting on. A real Shift-drag is left alone when reporting is
off **and** something is already selected, because there the extend branch is the feature
rather than the dead end.

The clone is `{ altKey: reporting && isMac, shiftKey: false }`, and off macOS with
reporting on there is no clone at all — xterm reads the real Shift there itself.
`verify:selection` asserts the *rule* (`reporting ? (isMac ? altKey : shiftKey) : !shiftKey`)
against every shape rather than memorising outcomes. Its old pair of assertions could only
ever have passed on a Mac: "a clone that keeps Shift selects nothing" is false off macOS
with reporting on. **Copy mode was removed in 0.9.** It was a mode that made every
unmodified drag select while it was on, added because Shift-drag was undiscoverable; it
took Escape away from the pane, needed a third clone shape (Shift, off macOS), and once the
right-click hint, OSC 52 and `Copy screen` existed it covered nothing they did not. If a
mode like it comes back, the third shape comes back with it.

Two more things about that mode nobody had measured: with reporting off a **plain
unmodified drag selects normally on every platform**, so the VPS tab was never short of a
way to select — it was short of the one the context-menu hint named. And `verify:selection`
could not have caught any of this, because all five of its cases enabled reporting and
`:293` asserted that as a hard control. It now runs a `modes: ''` case, and asserts both
clone shapes side by side in every case.

**Claude Code 2.1.237 turned motion reporting on, and that broke selection a second, entirely
separate way.** The CLI now asks for mode **1003** — any-event tracking — where it previously
asked for 1000/1004/1006/1007. xterm hands every mouse report to
`CoreService.triggerDataEvent(report, true)` (`CoreMouseService.ts:331`), and that `true` means
"user input", which `SelectionService` clears the selection on (`SelectionService.ts:139`).
Under 1003 the pointer *moving* is a report. So a selection died the instant the mouse moved,
by one pixel, on **every local tab** — which made right-click → Copy unreachable in practice,
because right-clicking means moving to the menu. Shift-drag, Option-drag and the then-extant Copy
mode were all affected identically; none of them is the cause and none of them is the fix.

It is fixable without forking xterm, which the suite's own comment claimed it was not:
`src/renderer/src/lib/mouseReport.ts` decides whether a payload is bare pointer motion, and
`TerminalView` wraps `term._core.coreService.triggerDataEvent` to withdraw only the
*wasUserInput* claim, only for movement with nothing pressed. The report still reaches the
application byte-for-byte, so hover handling and click-to-focus are untouched.

**`verify:selection` was asserting the bug as correct behaviour**, under an assertion literally
named "known limit — motion reports still eat the selection", on two premises that were both
false: that Stoke could not fix it, and that Claude Code never asks for motion. A test that
pins a bug as expected turns a regression into a green run. That case now has to survive like
every other, and the counterfactual was measured both ways: with the guard the selection comes
back intact, without it the reading is `""`. The page also builds the guard from the *shipped*
function via `Function.prototype.toString()` rather than hand-copying it — which is why
`isButtonlessMotionReport` is written with no imports and no module-scope helpers, and is a
partial answer to the standing complaint that this suite never loads any Stoke source at all.

Two features fighting over one key is also how the selection used to vanish the moment you
let go: `altClickMovesCursor` defaults **on**, reads the same still-held Option on mouseup,
and for a selection of one character or less sends a cursor-move with `wasUserInput: true`
— which `SelectionService`'s own `onUserInput` handler clears the selection on
(`:139-143`, `:708`). It is set `false` now. Anything that turns a modifier into a
selection gesture has to check what else in xterm already reads that modifier.

The context menu
names the right modifier per platform, but only when nothing is selected, which is exactly
the moment someone has discovered that dragging does nothing. Nothing about this is
SSH-specific: a remote tab is the same xterm with `ssh` as its argv, so it got the fix for
free. A right-click is also forwarded, which is why the CLI used to paste on right-click —
`TerminalView` takes that event in the capture phase before xterm sees it.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - Since 4fb8314 the footer names Shift on every platform. Option is left out on purpose (TerminalView.tsx:1176-1189), and d34cf8e's macOS text 'Hold ⌥ Option while dragging' is gone. The Shift hint still appears only when nothing is selected. A blank-cell selection gets a separate footer that names no modifier ('only blank space', `menu.blank`, :1183-1184), and an SSH tab adds a far-side copy sentence (:1188).
> - This is correct as history, but the `:293` pointer is dead: that line is now a case label. The control is at verify-selection.mts:357-382 and inverts for the `modes: ''` case (:330), which is one of six cases.
> - The assertion was fixed, but the premise is still in the suite. verify-selection.mts:283-289 labels the 1000/1004/1006/1007 runs "Claude Code's real modes" and says the CLI "never asks for motion reports". That contradicts the suite's own 1003 case at :306-312, which says 2.1.237 asks for exactly that.

## 28. A terminal link has no modifier gate and fires on mouseup

**A terminal link has no modifier gate and fires on mouseup.** `Linkifier._handleMouseDown`
takes no event argument at all (`Linkifier.ts:216-218`), and `_handleMouseUp` (`:220-233`)
checks only that the link is still current, that the press was on the same link, and that
the release is inside its range — no modifier, no button, no distance. So a plain click, a
Cmd-click, a middle-click and a *drag from a URL's first character to its last* all did the
same thing: open it. Dragging across a URL to copy it therefore yanked the browser panel
open, which compounds the selection trouble above rather than being separate from it.
`TerminalView` now records the press point and treats anything past `DRAG_SLOP_PX` as a
drag, and reads the modifiers the callback was always handed: Shift or Cmd/Ctrl sends the
URL to the real browser through the `openExternal` channel that already existed, plain click
keeps the docked one.

Two related things in the same area. **OSC 8 hyperlinks bypassed all of it and went
nowhere**: `OscLinkProvider` is registered in xterm's constructor, before any addon, and
wins on any cell carrying a urlId — with no `linkHandler` option set it fell to
`defaultActivate` (`OscLinkProvider.ts:114-129`), which is a blocking `confirm()` calling the
link "potentially dangerous" followed by `window.open()` with **no argument**, arriving at
the main window handler as `about:blank`, failing its `/^https?:/i` test and being denied.
A scary dialog and then nothing, on every link npm, vite, gh, cargo and docker emit. And
**a macOS Ctrl+click is `button 0` with `ctrlKey`**, not button 2 — Blink dispatches the
context menu off the left button carrying Control (Firefox is the engine that remaps), so a
guard keyed on the button number let one gesture report a click to the CLI, open Stoke's
menu *and* activate a link, all three at once. xterm knows this and binds its own right-click
through `contextmenu` instead (`CoreBrowserTerminal.ts:346-358`).

## 34. Two capture-phase listeners on the same node can cancel each other, and a synthetic event must never be judged by the guard that created it

**Two capture-phase listeners on the same node can cancel each other, and a synthetic event must
never be judged by the guard that created it.** `TerminalView` binds `onShiftDrag` and
`onMouseDown` to `host` in the capture phase, in that order. `onShiftDrag` re-dispatches the
press as a clone; the clone travels the whole capture path and therefore arrives back at
`onMouseDown`, which classified `button === 0 && ctrlKey` on macOS as a secondary click and
`stopPropagation()`d it. So **a Shift+Ctrl-drag selected nothing at all** — no selection and no
mouse report either. A/B'd against the real app over CDP on a live SSH session with reporting
on: `""` before, the full line after. The fix is a `retold` WeakSet check in `onMouseDown`, and
the rule it encodes is general — our own clone is not user input and must skip our own guards.

The same handler was bound to `mouseup`, and **swallowing a release that nobody swallowed the
press of is a listener leak, not a smaller version of the same idea.** `SelectionService` adds
its drag `mousemove`/`mouseup` listeners to the **document**; `host` is an ancestor and this
runs in capture, so a stopped mouseup never reaches document, `_removeMouseDownListeners`
never runs, and both the document mousemove handler and a 50ms drag-scroll interval outlive
the drag. The terminal is then left extending the selection at whatever the pointer passes
over **with no button held**, and each later drag orphans another interval. Reachable by
pressing the right button — or Control on a Mac — part-way through an ordinary left drag.
Also A/B'd: before, a bare pointer move after release grew the selection from `"STOKE_SELE"`
to `"STOKE_SELECT_ME_ABCDEFGHI"`; after, it does not move. A release is now swallowed only
when its own press was.

A probe for this must dispatch on `.xterm-screen`, not on `document`. Dispatching straight at
`document` skips the capture listener on `host` entirely and the leak silently does not
reproduce — the first version of this test reported a clean bill for code that was broken.

**None of the three is visible to `npm run check`.** `verify:selection` builds its own page and
hand-writes clone shapes; it never registers `TerminalView`'s listeners, so nothing in this
entry lives anywhere the suite can reach. Gotcha 31's lesson again, and the reason all three
were established by driving the built app over CDP against a real SSH session, stashing the
change, rebuilding, and measuring both ways.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - That is only half the fix. Commit 62a2638, made after this entry was written in 00c0fa9, added `swallowed = secondary && !e.defaultPrevented ? e.button : null` (TerminalView.tsx:533-556). The reason: `stopPropagation()` does not stop a sibling listener on the same node. So the ORIGINAL Shift+Ctrl press still reached `onMouseDown`, was swallowed as a secondary click, and its mouseup leaked the drag listeners anyway. The entry never mentions this half.

## 42. Claude Code's own theme lives in `settings.json`, and the way to follow it is OSC 11, not a flag

**Claude Code's own theme lives in `settings.json`, and the way to follow it is OSC 11,
not a flag.** `theme` is a real zod key in `~/.claude/settings.json` — NOT `~/.claude.json`,
which still has a read path for it (`legacyGlobalConfig`) but is dead-ended by its own
default of `"dark"` and is written by nothing any more. The vocabulary is
`auto | dark | light | {dark,light}-daltonized | {dark,light}-ansi`, plus `custom:<slug>`
naming a file in `<config-dir>/themes/`. It carries `.catch(void 0)`, so an
out-of-vocabulary value is **silently dropped**, exactly like `effortLevel` in gotcha 39.

Stoke could pin it through its own `--settings` file — measured working, both directions —
and deliberately does not. That file is `flagSettings`, which outranks the user's own
`/theme` **forever**; several CLI render helpers call `resolveSetting("theme")` directly in
their render body rather than reading the React theme context, so a mid-session `/theme`
would leave those painting the pinned value; and it does nothing at all for an SSH tab,
whose argv comes from `buildSshArgs` and never reaches the `--settings` push in
`cli.ts:273`.

**The free route is OSC 11.** On `auto` the CLI sends `ESC]11;?BEL` with `ESC[c` as a flush
sentinel and classifies the reply by `0.2126r + 0.7152g + 0.0722b > 0.5` — and xterm.js
6.0.0 already answers that truthfully from the `theme.background` Stoke gives it. So the CLI
follows this window with no plumbing, on local **and** SSH tabs, because OSC 11 is terminal
I/O rather than a launch flag. All four of Stoke's backgrounds classify correctly under that
rule (Y = 0.065–0.077 dark, 0.957 light).

Two things it needs. The CLI re-queries on `CSI ?997;{1,2}n` — the colour-scheme-change
report — and **xterm.js knows nothing about DEC mode 2031 or that report**; neither string
appears in its bundle. So `TerminalView` synthesises it on a theme change, gated on having
seen `ESC[?2031h` and not since `ESC[?2031l`, or a byobu tab sitting at a shell prompt gets
the bytes typed at it. Order matters: set `term.options.theme` FIRST, because the CLI's
handler ignores the report's own dark/light bit and simply re-runs the OSC 11 query, so what
decides the outcome is xterm's answer.

One honest limit, and it is the answer to "the terminal colours clash with the app chrome":
**only `dark-ansi` and `light-ansi` consume Stoke's sixteen ANSI slots.** The other four CLI
themes hardcode truecolor for all 72 palette keys and cannot be influenced by anything Stoke
does — including background fills like `composerSidebarBackground rgb(38,38,38)` drawn as a
neutral grey over Stoke's tinted page. Ember and Daylight are close enough not to show it;
Moss and Nocturne will.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - The push is now src/main/cli.ts:386 (`if (file) args.push('--settings', file)` inside `buildArgs`). cli.ts:273 is now the ultracode doc comment. The SSH branch that skips the push is src/main/pty.ts:218-221: `settingsFile` is null for a host, and `args` is `buildSshArgs(opts.host)`.
> - It now fires only when the light/dark class of `theme.terminal.background` flips, not on every theme change. src/renderer/src/components/TerminalView.tsx:1023-1027 keys the effect on `isLightBackground(...)` (:49-54, the CLI's own 0.2126/0.7152/0.0722 > 0.5 rule). The reason is that keying it on the theme object let the theme editor write tens of CSI 997 reports a second. The repaint (`term.options.theme = ...`, :1005-1009) is a separate effect declared earlier, and that is what keeps the 'theme first, then report' order. The report is written to the pty (`window.stoke.pty.write`), not to `term.write`.
> - src/shared/themes.ts now ships twelve built-ins: nine dark and three light (daylight, paper, mist). Running the CLI's formula on each `terminal.background` gives 0.0510-0.0919 for the dark ones (graphite 0.0510, lantern 0.0512) and 0.9552-0.9586 for the light ones. They all still classify correctly, but the count and the figures are out of date.

## 79. Two dictation features wanted one key, and the loser looked like a broken microphone

**Reported as "Claude Code can't access my microphone in Stoke". It could, the whole time.**
Every layer was measured on 2026-09-19 before anything was changed, and each one was fine:

- **macOS permission.** A Swift probe run as a child of the installed Stoke's pty reported
  `responsibility_get_pid_responsible_for_pid` → Stoke's own pid, and
  `AVCaptureDevice.authorizationStatus(.audio) = 3 authorized`. TCC attributes a pty child to its
  RESPONSIBLE process, so `claude` records as Stoke — there is no "claude" row in Privacy &
  Security to find, and the Stoke row is the switch for every CLI in every tab.
- **Audio.** The same probe recorded 91,200 frames from the MacBook Pro Microphone, peak 0.033.
- **The CLI.** `claude` 2.1.278 spawned in a node-pty with `pty.ts`'s exact env (`TERM_PROGRAM=Stoke`
  and all) and fed a held Space logged `[voice] handleKeyEvent: idle, starting recording session`,
  `audio-capture-napi loaded`, `[voice_stream] WebSocket connected` and 46 KB of audio, then
  answered "No speech detected." Its only environment gate is `CLAUDE_CODE_REMOTE`, which Stoke
  never sets.
- **A real Stoke tab**, driven over CDP with `Input.dispatchKeyEvent` (a keyDown, 75 autoRepeat
  keyDowns 33ms apart, a keyUp) against the installed 0.9.5: "Voice: processing…", then "No speech
  detected." Working.

**What broke it was Stoke's own dictation.** ⇧⌘D arms a hold-Space recorder in `TerminalView`,
bound on the host in the capture phase — and its keydown did `if (e.code !== 'Space' || e.repeat)
return` BEFORE `preventDefault`. It took the first press and let every auto-repeat through to
xterm and the pty, and **the auto-repeat stream is exactly what Claude Code's `/voice` listens
for**. One held Space started two recorders. Stoke's then failed — its dictation posts to a speech
server the user runs, and a stopped one reads `Speech server unreachable: fetch failed` in a strip
that appears the moment you hold Space to talk — while Claude's ran underneath it. The screenshot
shows both at once: Stoke's red error pill, and Claude's "No speech detected." above it.

The fix is ownership decided before a key is pressed (`src/shared/voiceRoute.ts`):
`spaceOwner` gives a LOCAL Claude tab whose `/voice` is on (`voiceEnabled` or `voice.enabled` in
`~/.claude/settings.json` — `/voice` writes both) to the CLI, and ⇧⌘D there shows a sentence
instead of arming. Everywhere else Stoke's dictation may own Space, and `dictationKeyAction`
makes it own the whole hold — a repeat is `swallow`, never `pass`. An SSH tab stays Stoke's even
running `claude`, since that `claude` is on a machine with no microphone. The speech server's
failure now names its address and says it is not the microphone; getUserMedia's
`NotAllowedError` names the Stoke switch in Privacy & Security; Settings → Voice reads
`systemPreferences.getMediaAccessStatus('microphone')` and says the Stoke row covers every CLI;
and `NSMicrophoneUsageDescription` no longer promises "audio is sent only to the speech server
you configure", which was false for the prompt `claude`'s first `/voice` raises.

Two things worth carrying. **A capture-phase key handler that returns before `preventDefault`
has not declined the key — it has passed it on**, to xterm and so to the CLI; decide the whole
hold, repeats included. And **nothing covered voice** — no suite touched either recorder — so
`verify:voice` also reads `TerminalView.tsx` for the calls, gotcha 31's wire, and its wire checks
were run against the old file from `HEAD` to confirm they fail there.

> **Checked against the code on 2026-09-30** — `dictationKeyAction` is gone; the rule above stands
> in a reducer. Once armed, the first Space keydown used to start a recording, so an armed tab could
> not type a space: every tap opened the microphone (the OS indicator lit) and threw the clip away as
> under 1 KB. `spaceHold` (voiceRoute.ts) is now idle → pending → starting → recording: the first
> press only arms a `voice.holdMs` timer (250 ms, clamped 150–800) and the strip says "Keep
> holding…"; the timer or an auto-repeat, whichever is first, starts the recorder; a release while
> still pending types the space through `term.input(' ', true)` (onData, like typing), and any other
> key pressed while Space is pending types the space first and then goes through, so fast "a b"
> keeps its order. **Every Space repeat is still taken, in every phase** — `verify:voice` asserts it
> per phase. A release while the microphone is still opening is `cancel`, and the recorder
> (`createRecorder`) now closes a stream that finishes opening after a cancel or a second start
> instead of overwriting its one slot — read from the old code (not reproduced), a press, a release
> during the permission prompt and a second press left the first stream open with the OS indicator. The
> phone's voice-mode Space runs the same reducer (`src/remote/session.ts`, default threshold).
> Measured over CDP against the built app with Chromium's fake microphone: a 64 ms tap left `a b` in
> the buffer, never showed "Listening" and made zero getUserMedia calls; a held Space with repeats
> went Keep holding → Listening (level line `scaleX(0.367)`) → Transcribing → the fake speech
> server's text in the buffer, with one getUserMedia call. The new wire checks were run against
> HEAD's TerminalView, session.ts and VoiceSettings (`verify-voice.mts --wire <three files>`):
> 12 FAILED, the four unchanged checks passed. Device names: in a fresh Electron 43 process with
> Chromium's fake devices, `enumerateDevices()` named every input before any getUserMedia (Stoke
> registers no permission-check handler) — unmeasured with real devices under macOS TCC, which is
> why the picker keeps its "Show device names" fallback and `audio/defaultDevice.ts` still shells out.
>
> **And on 2026-09-30, in review:** Settings' Test meter (`MicPicker`) had the same one-slot bug
> as the recorder, one level up. Its claim was a shared placeholder, so Test, Stop, Test during a slow
> open kept one stream live after Stop and after closing Settings. It now claims with a fresh
> object per press. Gotcha 20's 2026-09-30 note has the measurement, and `verify:voice` holds the
> claim's shape (shown to fail against the old file).

> **Checked against the code on 2026-10-04** — the owner asked for three things, and each moved a
> rule above.
> - **A longer hold, and the repeat no longer cuts it short.** `DEFAULT_HOLD_MS` is 500 and the
>   range 150–1500 (voiceSettings.ts). The 2026-09-30 note's "the timer or an auto-repeat, whichever
>   is first" would have made that do nothing: the OS key-repeat delay on the owner's Mac is 500 ms
>   (`NSEvent.keyRepeatDelay`, measured; macOS's default, the key is unset), so a 700, 1000 or 1500
>   setting started recording at 500. A repeat while pending is now taken and starts nothing until
>   the threshold has passed — the timer starts it, or a repeat past the threshold if the timer is
>   late. Every repeat is still taken in every phase. And a new default alone reaches nobody: every
>   settings file holds `holdMs: 250` explicitly (hydrate writes the whole block on the first save of
>   anything), so the block now carries `format` (`VOICE_FORMAT` 2) and `upgradeHoldMs` moves a
>   format-1 block's exact 250 to 500 once; a 250 in a format-2 block was picked and stays. A file an
>   older build rewrites loses `format`, so a 250 picked here is moved again after a downgrade.
> - **One copy of dictation for every pane.** The hold, the recorder and the strip left
>   TerminalView for `useDictation` (components/Dictation.tsx), which RemoteTerminal also runs; the
>   caller's `DictationTarget` says who may arm it, how a tap's space is typed and where a
>   transcript goes. Words a session did not take — a remote link that dropped while the speech
>   service worked, a local session that ended — stay on the strip with why (Type it now, Copy,
>   Discard), never dropped silently. The wire checks read the hook (`--wire` takes it fifth,
>   RemoteTerminal sixth); against the pre-hook TerminalView 13 fail.
> - **A remote tab is Stoke's, like an SSH tab.** A hub remote tab's `claude` runs on the other
>   machine, whose `/voice` would record that room's microphone, and this computer's `claudeVoice`
>   says nothing about that CLI: `spaceOwner` gives `kind: 'remote'` to Stoke whatever it says.
>   The transcript is typed THERE by the host (`HubRemote.type`, a phone submit frame with
>   `enter: false`: gotcha 86's typing, no Enter). Driven with two sandbox Stokes on a loopback hub:
>   the guest's speech server got the clip and the host's session showed the words; a hub stopped
>   mid-hold left them on the strip, and Type it now typed them once the tab reconnected; with this
>   computer's `/voice` on, the remote tab armed while a local Claude tab showed `CLI_OWNS_SPACE`.
> - **The strip is top-right** (it was bottom-left, over the prompt being dictated into), and the
>   find bar starts under it (`--find-ceiling`, shared/paneFloats.ts); both clear the scrollbar on
>   `--float-right`. Reduced motion is unchanged: `pop` rests fully shown.

## 151. Two machines on one pty: a size claim needs a person, and the pane is watched by its border box

**Built 2026-10-02, from the owner's "whichever is active we force it to that screen ratio".** A hub
remote tab (RemoteTerminal) and the session's own tab on the machine it runs on (TerminalView) draw
one pty, and only one grid can be its. Last active wins (`SizeClaimer`, shared/sizeClaim.ts): the
side being USED claims the grid for its pane — the guest sends the phone's own `{type:'resize',
force:true}` through the relay, the host fits as it always did — and the other side draws that grid
as it is until someone uses it there. Use is a focus, a key or a click on the terminal, or its pane
changing size. Two passive things change a pane's size, and each would have answered the other
machine's claim with one of its own:

- **Scrollbars, through the content box.** The side not in use draws a grid that can be larger than
  its pane, so `.remote-host` and `.term-host[data-sized-elsewhere]` scroll, and a scrollbar that
  takes layout space shrinks the CONTENT box. Measured in the built app on 2026-10-02 with
  layout-taking scrollbars (forced on this Mac with `* { scrollbar-width: auto; scrollbar-color:
  auto }`, so app.css's 10 px `::-webkit-scrollbar` applies, as Windows and Linux draw by default):
  a remote grid grown from 143x38 to 220x70 in a 1160x784 pane fired a content-box
  `ResizeObserver` (1150x774) and not a border-box one; shrunk back, the content box fired again
  (1160x784) and the border box did not. On this Mac's default overlay scrollbars
  (`offsetWidth - clientWidth` 0 with `scrollWidth` 1734 against 1160) neither fires — so a
  content-box trigger would have ping-ponged on Windows and Linux at the speed of the relay and
  never on a Mac. Both terminals observe `{ box: 'border-box' }`; `.term-host` has no padding or
  border, so for TerminalView's own fit nothing else changes.
- **A strip appearing above a terminal nobody is at.** On a machine the owner walked away from,
  the window keeps the OS's focus and the terminal keeps the keyboard, and a worklog proposal or
  another device's question pushes the pane down. `claimCounts` takes a pane change only while the
  terminal holds the keyboard in a focused window that someone acted on inside `PANE_INPUT_MS`
  (lib/lastInput.ts: a trusted key, press or wheel, or the window resized). Measured with the guest
  holding 143x38 and the host's terminal focused (CDP focus emulation): a script putting the
  "Remote" strip up left the host drawing 143x38; a trusted wheel over the sidebar and then the
  strip going took the grid back to the host's 106x31.

The rest of the rule, each in `verify:hub-relay` on a fake clock with two sides on one pty, and each
shown red by mutating it back: a burst of keys is ONE resize after `CLAIM_DEBOUNCE_MS`; with no use
nothing is resized for ten idle minutes; a claim inside `CLAIM_SETTLE_MS` of the other side's
resize waits for it and then wins; a side's own resize echoing back is not "the other side" (or
every claim would arm a settle against itself); and a tab merely shown, or a reconnect, claims
nothing (`claimedOpenRef`: the FIRST open of a remote tab is use; a dropped link coming back is the
network, so the focus the tab gives its terminal then is marked quiet, `quietFocusRef`). In the
built app, 20 idle seconds after each claim both sides still read the same grid, and with the host
holding 106x31 a hub restart dropped the relay and the guest reconnected without touching it, until
a real key on the guest claimed 143x38.

**When driving it, a scripted `focus()` on a terminal is a claim:** it fires `focusin`. The first
run of the passive check above focused the host's terminal from the script to set the scene, and
that alone took the grid back before the check began. Leave focus where a person left it, and use
`Emulation.setFocusEmulationEnabled` for `document.hasFocus()` instead.

The phone is unchanged: it resizes through the phone server, which tells the desktop nothing, and
only in Fit to phone (gotcha 87). The relay's own instance of that server (`serveRelay` hooks) is
what tells the desktop (`pty:sized`), pushes each grid to every relayed viewer at once, forgets the
desktop's saved size when the desktop resizes (`desktopResized`), and puts it back — with the
desktop's tab refitting — when the last remote tab leaves.

> **Checked against the code on 2026-10-02 (a review of last active wins).** A guest resized ANY
> host that takes the phone's `resize` frame, which every host built before this change does, but
> only a host carrying it has a tab that follows (`pty:sized`). Against an older host the pty took
> the guest's grid while the tab at its desk kept drawing its own over output laid out for the other,
> a wrong screen for whoever sat there, again on every use, for as long as two machines ran different
> versions (an update lands on one before the other) — read from d8afc42's `server.ts` and
> `TerminalView`, not driven against an old build. The host's `ready` now says `sizes: true` when
> its tab follows (`RemoteMachineDeps.followsResize`, set in index.ts beside the relay server's
> hook), and `HubRemote.resize` sends nothing to a host that did not say so; such a tab draws the
> host's grid as before. `verify:hub-relay` holds both sides (a host without the flag gets no resize
> while keys still reach it), and dropping the gate, the flag, or the guest's reading of it each
> turned it red.
