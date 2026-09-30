---
paths:
  - "scripts/cdp-eval.mjs"
  - "scripts/verify-selection.mts"
  - "scripts/make-icon.cjs"
  - ".claude/commands/mac-release.md"
---

# Driving and verifying the app

The full text of two sections CLAUDE.md now carries in condensed form: the traps met when a
script drives the running app, and what has and has not been proven on each platform. This is the
archive: CLAUDE.md's condensed list is canonical, so a new trap goes there, as one bullet.

## Standing traps when driving the app

Not about any one module, and each cost real time at least once. Carried over from the 0.3.0
handoff notes, which no longer have a file of their own.

- **Never force-kill Stoke.** It orphans the CLI children — the PTYs die, the `claude` processes
  do not — and the restarted app cannot reattach to them. A tunnel outage and a long "nothing is
  active" confusion both came from exactly that. Quit it properly and `before-quit` runs
  `ptys.killAll()` for you (`index.ts:1397-1398`).
- **Electron under ESM starts from `app.whenReady().then(main)`, never a top-level `await`.**
  `scripts/make-icon.cjs` is the shape to copy.
- **A script that destroys windows in a loop quits the app out from under itself.** Electron's
  default `window-all-closed` behaviour is to quit, so the run ends the moment the last window
  goes — and because that is an ordinary quit, the process exits 0 and the script looks like it
  finished its work. Register `app.on('window-all-closed', () => {})` in any script that means to
  keep going.
- **`app.exit()` does not flush a piped stdout**, so a result printed just before it can simply
  not arrive. Write it to a file and read the file back.
- **Nested backticks inside a template literal terminate it early.** It is a SyntaxError, which
  means it fails before a single line runs and points at the wrong place while doing it. Build
  anything you inject into a page from an array of lines rather than one long template.
- **Unexplained, and worth knowing before you chase it: `.settings.json` files have gone
  missing from `$TMPDIR/stoke/statusline/`.** Observed once for the installed app's sessions
  and once for a resumed session — the payload `.json` beside them survived, only the settings
  file went. Ruled out by testing: the boot sweep (run against a copy, which it left alone) and
  the CLI itself (a headless probe kept its file for the whole run), and a fresh session's files
  persisted five minutes later. Not reproduced. It is harmless as far as anything Stoke does —
  the CLI reads `--settings` once at startup, so a file that vanishes afterwards costs nothing,
  and the hooks and statusLine keep working — but do not spend an afternoon assuming a
  disappearance means a bug in the writer.
- **The usage endpoint is undocumented** (`usage.ts`): there is no supported programmatic source
  for plan limits, so its shape can change without warning. Tolerate missing fields and report
  unavailable — a wrong number in a status bar is worse than a blank one.

## Verification expectations

`npm run check` must pass, and it does here, build included. Until 849485d it could not:
`verify:ssh` asserted six of one desk's own `~/.ssh` aliases by name, so it passed on exactly that
machine and failed on every other, and `ssh -G` on OpenSSH 9+ rejects the suite's own two-word host
fixture before it resolves anything. It sits second-to-last in the chain, so it took `npm run build`
down with it and the build step never ran at all. `verify:context` is the one suite that is
machine-dependent on purpose — it runs against the real transcripts on this machine, which is why
CI skips it and why it has caught two genuine bugs. Anything else that only passes on one machine
is a defect in the suite, not a fact about the machine.

For UI work, launch with `--remote-debugging-port` and drive it over CDP; screenshots are the
only reliable way to confirm the terminal and the panels actually render.

**macOS has now been built, launched and driven through its real UI on this machine several
times** — sessions started, prompts sent, the context ring and usage chip read out of the
running DOM, screenshots taken over CDP. The statusLine channel is proven end to end here: live
payloads were captured from `claude` 2.1.221 on darwin-arm64 through a real pty, and the POSIX
shim branch (`statusLine.ts`'s `shimName`/`writeStatusLineWrapper`, `:159-161,220-226`) is the
one that actually ran — every live session left `run.sh` behind, never `run.cmd`. That work also
turned up a genuine macOS bug, **since fixed**: `usage.ts` read the OAuth token only from
`~/.claude/.credentials.json`, which does not exist on macOS — the token is in the login
Keychain — so `window.stoke.usage.read()` failed here with "Not signed in to Claude Code" and
the statusLine payload's `rate_limits` was the only plan-limit source on the platform. See
gotcha 36.

What that work did **not** exercise, and is still genuinely unverified: the `hiddenInset` title
bar and traffic-light padding (every screenshot taken here came from CDP's
`Page.captureScreenshot`, which paints page content, not Electron's native window chrome, and
this sandbox has neither Accessibility nor Screen Recording permission for an OS-level capture
to fall back on); the login-shell PATH probe in `cli.ts` (every launch here already inherited a
working PATH from the shell that started Electron — never the Finder/Dock case with no inherited
PATH the probe exists for). See `.claude/commands/mac-release.md` for the checklist.

**`shortcuts.ts`'s Mac branch has now fired.** Cmd+`=`, Cmd+`-` and Cmd+`0` were dispatched as
real `metaKey`-modified `KeyboardEvent`s at the running app over CDP and measured through to the
persisted settings — `--ui-scale` walked 1 → 1.1 → 1.2 → 1.1 → 1, and one press moved
`uiScale` to 1.1 and `fontSize` to 14 together. Cmd+Shift+`-` was driven in the same pass and
correctly changed nothing, so `^_` still reaches the terminal (gotcha 32). These are synthetic
events on a window listener, which for this path is not a weaker test — there is no trusted-event
gate on `window.addEventListener('keydown')` — but they are still not OS-delivered keystrokes,
so a real Mac keyboard remains the thing nobody has tried.

**The traffic-light padding is half verified, and the halves are worth separating.** The CSS
rule was measured in the running app: `.titlebar` computed `padding-left` is `88px` windowed and
`8px` with `data-fullscreen` set, and back to `88px` when it is removed. What was NOT exercised
is the main→renderer half — `win.on('enter-full-screen')` → `winFullScreenChanged` → the
attribute — because macOS full screen cannot be entered from CDP (it is AppKit, not the page)
and an OS-level keystroke needs the Accessibility permission this sandbox lacks. So: the
stylesheet is proven, the signal that sets the attribute is only read. Enter full screen by hand
once before believing it.

**Windows carries the opposite risk: no round of work here has run there.** The statusLine and
hook commands are still the suspect part, and the reason has moved. `cmd.exe`'s quote-stripping
was the original worry and is not on this path at all — the CLI runs the command through Git Bash
or PowerShell, never cmd (gotcha 61). What replaced it is that Stoke must now DETECT which of
those two it will be, because they need opposite syntax and the previous code assumed one of them
unconditionally and got it backwards. `gitBashPath` mirrors the CLI's own locator and
`verify:statusline` asserts both branches plus ten cases over the locator itself — but every one
of those assertions runs against a synthetic filesystem on a Mac. **Nobody has watched a payload
file appear on real Windows.** Treat it as unverified, not merely untested, until someone runs a
statusLine-driven session there — once with Git for Windows installed and once without, which are
genuinely different code paths.

> **Checked on 2026-09-30:** ci.yml's windows-latest leg now runs every `check` suite, and
> `verify:statusline` there runs the real shim through Git Bash, pwsh 7 and Windows PowerShell 5.1
> the way Claude Code 2.1.285's executor does — the payload file DOES appear, and the hooks append,
> under all three (gotchas 61, 123). What is still unproven is the other half: a real `claude` on
> Windows choosing its shell and running the command, and the installed app around it.

## 110. `require` from a main-process inspector exists only during the evaluation, and the error it throws later is a modal nobody can click

**Driving the main process through its Node inspector (`--inspect=<port>`, `Runtime.evaluate`
with `includeCommandLineAPI`) gives you a `require` that is part of the console's command-line
API, not of the module scope** — so it is there for the synchronous body of the evaluation and
gone by the time a callback it scheduled runs. Measured 2026-09-30 against the built app:
`typeof require` read `"function"` inside the evaluation, and a `setTimeout(() => require(…), 10)`
from the same evaluation caught `ReferenceError: require is not defined`.

Uncaught, that error is fatal in a way that does not look like one. It was
`setTimeout(() => require("electron").app.quit(), 100)`, written so the reply could arrive before
the process went. The app did not quit, and `sample <pid>` put the whole main thread in
`-[NSAlert runModal]` under a `uv__run_timers` frame — Electron's uncaught-exception dialog, raised
from that timer. From then on nothing answers: the renderer's CDP port accepts a connection and
never replies to `/json/list`, and the inspector takes `Runtime.evaluate` and never returns. The
alert needs a click, which this sandbox cannot post (`osascript is not allowed assistive access`),
and it sits on the user's screen meanwhile. A first `SIGTERM` did nothing in 20 seconds (queued
behind the modal); a second ended the process with status 143 — Chromium puts `SIG_DFL` back after
the first signal — ungracefully, with no `before-quit`. That was tolerable only because the
instance had no pty children (`pgrep -P <pid>`: Electron helpers only); with a session open it is
the standing "never force-kill" case, orphans and all.

So: **call `require("electron")` synchronously inside the evaluation**, or keep what it returns in
a variable before scheduling anything, and wrap anything deferred in `try/catch`. Quitting a
sandbox instance with a synchronous `(() => { require("electron").app.quit(); return 1 })()` was
measured clean (the reply still arrived, the process exited 0).

## 119. A synthetic `blur()` commits nothing while the window lacks OS focus, so a blur-committed field looks broken under CDP

**Most settings fields commit on blur** (`useDraft`, the Agents page's endpoint and Default model
fields, the tab tag — gotcha 63). Driving one from CDP the obvious way — set the value through the
prototype setter, dispatch `input`, then `input.blur()` — works while the Stoke window is the
frontmost app, and silently stops working the moment it is not. Measured 2026-09-30 on the Agents
page of a sandbox instance behind the terminal that drove it: `document.hasFocus()` read `false`
and `document.activeElement` was `<body>`, and four focus-set-blur passes on the Gemini and Grok
Default model fields left `settings.get()` unchanged while the field showed the new text (React's
`onChange` had run: a junk id drew its warning). The same drive had committed the Codex field in the
first minutes after launch — which is what makes it read as a bug in the page. A
`keydown` of `Enter` dispatched on the input (the fields commit on Enter too) committed at once, in
the same backgrounded window, every time.

So: **commit a driven field with its Enter path, or check `document.hasFocus()` first** — never
read "the value did not save" off a synthetic blur. (`Emulation.setFocusEmulationEnabled` is the
CDP switch meant for this; not tried here.)

Related, and also only a driving artefact: **`scrollIntoView` on anything inside the settings
sheet scrolls the `.settings-modal` itself**, which is `overflow: hidden` — the header and the
close button slide out of the dialog and stay out, in every later screenshot. A user cannot
reach that state. Scroll `.settings-pane`'s own `scrollTop` instead.

## 128. A sandbox that dictates in a Claude tab inherits the owner's `/voice`, and a worktree agent may not move `HOME` to escape it

**Stoke's dictation in a local Claude tab is decided by the owner's real `~/.claude/settings.json`.**
`spaceOwner` (voiceRoute.ts, gotcha 79) gives Space to Claude Code's `/voice` whenever
`voiceEnabled`/`voice.enabled` is on there, and ⇧⌘D then shows `CLI_OWNS_SPACE` instead of arming.
Read on 2026-09-30 while proving the speech providers: this Mac's file has `"voiceEnabled": true`,
so a sandbox Claude tab would have refused Stoke's dictation — inferred from the code and that read;
the refusal itself was not reproduced, the isolation below was used instead. Gotcha 112's answer, a
scratch `HOME`, is not available to an agent in an isolated git worktree: the harness refuses any
command that sets `HOME` ("injecting git configuration whose effect on where git writes can't be
verified"), and a wrapper script to get round it would be dodging a guard, not isolating.

What worked, measured: launch with **`CLAUDE_CONFIG_DIR=<scratch dir>`** in front of the Electron
binary (the harness allows it), plus `claudePath` pointed at a stub and `--use-mock-keychain`.
`claudeConfigDir`/`claudeSettingsPath` (claudePaths.ts) honour it, so Settings → Voice read Claude
Code's `/voice` as **off**, ⇧⌘D armed the strip ("Hold Space to speak…"), and a held Space went
Listening → Transcribing → text. It also points `~/.claude.json` and the stub's own config at the
scratch dir, so nothing of the owner's Claude config is read for ownership or written. It does NOT
move `~/.local/bin` or the login shell's PATH, so it is enough only for a Claude tab (whose
`claudePath` override wins before any search) — any other agent still needs gotcha 112's `SHELL` +
`HOME`, from outside a worktree.

## 133. A sandbox with chat history on reads the owner's real chats unless the caps are aimed at synthetic ones

**`CLAUDE_CONFIG_DIR` does not isolate the chat index.** `claudeRoots` (chatIndex/sources.ts) reads
`$CLAUDE_CONFIG_DIR/projects` AND `~/.claude/projects` — on purpose, since sessions started without
the override are filed in the default folder — and Zed, Claude Cowork and Cline have no override (their
roots are under the real `HOME`, which a worktree agent may not move, gotcha 128). So a driven
sandbox with `chatIndex: 'on'` and the default sources copies the owner's real conversation text
into the sandbox store, and every screenshot of a search is one query away from showing it.
Measured on 2026-09-30 driving the export import and the chat viewer: with the Claude source on and
`CLAUDE_CONFIG_DIR` pointed at scratch, the pass LISTED 116 real Claude transcripts beside the
synthetic ones.

What kept every real chat out, measured in the same run (`filesRead: 2`, `bytesRead: 1364`, both
synthetic files): seed `settings.chatIndexOptions` so that only `claude` is on (`codex` could be moved
with `CODEX_HOME`, OpenCode with `XDG_DATA_HOME`, but the others cannot, so they are off), set
`caps.perSource` to the number of synthetic transcripts (2), and date the synthetic transcripts a
week AHEAD (`utimes`) so they are the newest the listing sees — admission is newest-first by mtime,
and the owner's live sessions are being written to right now, so a synthetic file dated "now" can
lose its slot to one. Listing still stats the real files (names and sizes only); only admitted chats
are read. Anything that appends to a synthetic transcript resets its mtime, so date
it ahead again afterwards. Imports are safe by construction: use generated exports only (a zip
writer is ~60 lines, `makeZip` in `verify:chat-sources`), and drop them with CDP's
`Input.dispatchDragEvent` carrying `data.files` — a trusted drag that reaches `pathForFile` as a
real path (gotcha 59), where the "Import an export…" button's native dialog cannot be driven. Two
side effects remain: the viewer's copy buttons write the real system clipboard, and Settings writes
the sandbox's `settings.json` back in full on first change.
