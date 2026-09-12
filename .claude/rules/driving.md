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
