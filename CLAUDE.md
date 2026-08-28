# Stoke — working notes for Claude Code

Stoke is a desktop shell for Claude Code: one window for every project, session, and the
browser, instead of a pile of terminals. It wraps the **real `claude` CLI in a PTY** rather
than reimplementing it against the SDK, so skills, MCP, plugins, hooks and the whole TUI keep
working untouched.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for how it all fits together. This file is the short
version plus the things that will waste your time if you rediscover them the hard way.

## Commands

```bash
npm run dev             # electron-vite dev, live reload. Uses its own "(dev)" userData,
                        # so it never fights an installed copy for the single-instance lock.
npm run check           # typecheck + every verify suite + full build. Run before claiming done.
npm run build           # electron-vite build + the separate remote/mobile bundle
npm run icon            # rasterise build/icon.svg -> build/icon.png
npm run dist:win        # installer -> release/Stoke-<version>-x64-setup.exe
npm run dist:mac        # dmg (arm64). MUST run on a Mac.
```

The verify suites, all runnable alone. `check` runs everything except `verify:extract` and
`verify:security`, which need a live instance:

```bash
npm run verify:context        # context meter against the real transcripts on this machine
npm run verify:statusline     # the statusLine wrapper: payload, suppression, pass-through
npm run verify:unicode        # xterm's cell widths for emoji and box drawing
npm run verify:profiles       # profile resolution + every accent clears 4.5:1
npm run verify:settings       # settings hydration: repair, clamps, and what it drops
npm run verify:claude-config  # writing Claude Code's OWN config: the allowlist, the refusals,
                              # and the ~/.claude.json lock. Runs against real files in a temp
                              # CLAUDE_CONFIG_DIR, never the user's (gotchas 38, 39)
npm run verify:folders        # folder metadata: trimming, caps, added folders, hide/pin
npm run verify:tabs           # which tab is selected after one is closed
npm run verify:shortcuts      # app chords vs the keys the terminal owns, and the zoom maths
npm run verify:color          # colour maths: contrast, APCA, oklch
npm run verify:updates        # the updater: a failure and a success must not read the same,
                              # and macOS must still build the zip it updates from (gotchas 24, 25)
npm run verify:worklog-gate     # which sessions the worklog agent would watch
npm run verify:worklog-runner   # prompt building, JSON parsing, titles, create-vs-update
npm run verify:worklog-retry    # writes happen once, and a retry never duplicates a record
npm run verify:worklog-recall   # the read-only board read, its parse and its cache
npm run verify:worklog-autoscan # when a session is scanned without being asked
npm run verify:ssh            # ssh argv, ~/.ssh/config parsing, the remote transcript fetch
npm run verify:selection      # Option-drag selection survives letting go of the mouse.
                              # Opens a real Electron window, so it needs a display
                              # and is the one `check` suite CI does not run
npm run verify:extract        # page extractor regression set
npm run verify:usage          # plan limits from the statusLine payload; STOKE_LIVE_USAGE=1 adds the account call
npm run verify:security <url> <token> --access   # remote server, against a running instance
```

## Layout

```
src/main/         Electron main process
  index.ts          lifecycle, window, every IPC handler
  pty.ts            PTY sessions, env sanitising, scrollback, fan-out
  cli.ts            locating claude, building its argv
  projects.ts       project + session discovery from Claude's own files
  projectMeta.ts    per-folder emoji/label/added-by-hand, and the one pair of caps
  context.ts        live context-window watcher (polls transcripts)
  sessionFile.ts    transcript parsing and the context maths
  statusLine.ts     Stoke's statusLine wrapper: context window + plan limits
  usage.ts          plan limits from the undocumented OAuth endpoint the CLI itself calls.
                    Reads the token from ~/.claude/.credentials.json OR, on macOS, the login
                    Keychain - which is why the chip works with no session running (gotcha 36)
  claudePaths.ts    where Claude Code's own two config files are. Pure; env and home are
                    arguments, so a suite can ask about another machine's layout
  claudeSettings.ts ~/.claude/settings.json: read, and patch one allowlisted key, preserving
                    every key Stoke does not draw
  claudeGlobalConfig.ts  ~/.claude.json: the lock protocol, the refusals, and the
                    verify-after-write. See gotcha 38 before touching it
  browser.ts        docked Chromium: tabs, find, console/network capture
  workspace.ts      default folder + scratch folders
  workspaceRoots.ts where a session with no project starts, per platform. Takes the
                    platform and home as arguments so a suite can ask for another machine's
  store.ts          settings persistence
  settingsSchema.ts defaults + hydrate, with no electron import so a suite can run it
  updates.ts        claude CLI version/health, and the gate that decides whether to
                    install an update unasked. The gate is pure and separate from the
                    six-hour timer that calls it, for gotcha 31's reason
  selfUpdate.ts     Stoke's own updates (electron-updater)
  codesign.ts       whether this copy's signature could ever accept a downloaded update.
                    No electron import, so verify:updates can run the rule. Gotcha 24
  profiles.ts       plans and creates a profile's folder + scan root
  ssh.ts            ~/.ssh/config parsing, the ssh argv, the transcript command
  sshTranscript.ts  pulls a remote session's JSONL back, so SSH sessions can be read
  agent.ts          headless `claude -p` runner (prompt on stdin, json out)
  stt.ts            the one place Stoke talks to the speech sidecar. Both the desktop and
                    the phone route through it, because "only main may reach it" is the
                    sidecar's whole authentication story
  audio/            reads the default capture device, to warn about virtual cables
  worklog/          the Notion/ClickUp review queue
    gate.ts           which project groups are watched
    watch.ts          the one predicate: is this session watched, and why not
    sessionStore.ts   session -> folder/host, on disk, so a restart keeps placing them
    autoscan.ts       when a quiet session is scanned without being asked
    autoscanStore.ts  its baselines on disk, split out so autoscan.ts imports nothing
    recall.ts         reads the boards (read-only, cached) so updates beat duplicates
    runner.ts         scan (read-only) and apply (writes, on accept only)
    queue.ts          the persisted proposal list
    json.ts           the shared "read JSON out of a model's reply" rescue
  mcp/              MCP server exposing the browser to Claude
    server.ts         HTTP transport + the 17 tool definitions
    page.ts           drives the page through the injected extractor
    cdp.ts            short-lived CDP sessions over the docked page. browser.ts long
                      claimed the debugger slot had to stay free because only one client
                      may attach; probing Electron 43 disproved that, which is what makes
                      audit.ts, design.ts and perf.ts possible at all
    audit.ts          passive security/hygiene audit: reads only what Chromium already
                      received or rendered. Nothing probes, so "not observed" is reported
                      as exactly that
    design.ts         what a page looks like, as text: a DOMSnapshot compressed hard
    perf.ts           why a page is slow, as a checklist. Reloads by default, because
                      unused bytes only mean anything if tracking started first
    stack.ts          what a page is built with, from live evidence rather than a
                      signature database that would already be stale
    inject/extract.js runs IN the page; markdown + refs + find. No deps.
  remote/           phone access
    server.ts         loopback HTTP + WebSocket, token auth, tailnet listener
    tunnel.ts         supervises cloudflared
src/preload/      contextBridge -> window.stoke
src/renderer/     desktop React UI (all colour via CSS custom properties)
src/remote/       mobile web UI, built separately to out/remote
src/shared/       types, IPC channel names, themes, profiles, colour maths
  paths.ts          cwd -> project group. Pure, platform passed in, no node imports,
                    so the renderer runs the identical rule for the profile chip
  ladder.ts         the 12-step ladder every built-in theme is generated from. Fixed
                    rungs in OKLCH L, solved onto rather than picked. Gotcha 43
  accent.ts         one accent in, five tokens out, per appearance. The reason
                    --accent (a fill) and --accent-ink (a foreground) are two
                    things and not one. Gotcha 44
  worklog.ts        the board targets the worklog can write to, and their defaults
  claudeConfig.ts   which of Claude Code's settings Stoke will draw, their vocabularies, and
                    the never-offer list. Hand-transcribed from the CLI binary's zod schema
  ui.ts             the uiScale / fontSize bounds, and the clamps both processes use
  statusLine.ts     the two plan-limit windows the usage chip draws, from the payload
scripts/          the verify-*.mts suites, make-icon.cjs
  mac-signing-secrets.sh  puts the release signing certificate into GitHub secrets.
                    Exists because macOS 26 removed Keychain Access, so every
                    "export it from the GUI" recipe is now dead. Gotcha 24
  cdp-eval.mjs      evaluates one expression in the renderer, or screenshots it.
                    Picks the target by its window.stoke object, never by URL
```

## Conventions

- **Relative imports in `src/main` carry explicit `.ts` extensions.** That is deliberate:
  it lets the main-process modules run directly under `node --experimental-strip-types`,
  which is how `scripts/verify-context.mts` tests them with no build step.
- **No TypeScript parameter properties** in main-process classes, for the same reason —
  node's strip-only mode rejects them. Assign fields explicitly in the constructor.
- **All colour goes through CSS custom properties.** Never hardcode a hex in a component;
  themes are swapped by writing variables onto `:root` (`src/renderer/src/lib/theme.ts`).
  No Tailwind, no component library — that is a standing preference, not an accident.
- IPC channel names live in `src/shared/ipc.ts`. Add there first.
- Commit messages: explain *why*, and record any bug the change fixes.

## Gotchas that cost real time

1. **Inherited Claude env vars silently break transcripts.** If Stoke is launched from
   inside a Claude Code session it inherits `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`,
   `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_PID`. The spawned session is
   then a "nested child" and **transcript saving is disabled**, which kills session resume
   *and* the context meter. `pty.ts` strips them. Auth/config vars are preserved.

2. **The context window's primary source is the statusLine payload, not the model id.** It
   cannot be derived from the model id: a 1M-tier session records its model as plain
   `claude-opus-5`, no `[1m]` suffix survives into the transcript, and there is no
   `context_window` field. Verified again on a session at 713,617 tokens; the only tier-ish
   field anywhere is `usage.service_tier`, which is billing. The CLI *used* to state it in its
   startup banner and **2.1.221 does not** — the banner is now `Claude Code v2.1.221    Opus 5
   with low effort · Claude Max`, and the word "context" appears nowhere in the startup output.

   So Stoke installs its own `statusLine` command (`src/main/statusLine.ts`), folded into the
   single `--settings` file at launch. The CLI pipes it a JSON payload on stdin whose
   `context_window.context_window_size` is the window — per model, and correct from token zero.
   The wrapper writes it to `<tmpdir>/stoke/statusline/<statusKey>.json` and prints nothing by
   default, which is why suppressing the in-terminal line and reading the data are the same act.
   `windowFromBanner` and `contextLimitFor`'s observed-usage inference are kept as **fallbacks**
   for CLI versions that emit no payload — and for a remote SSH session, which gets no wrapper
   and no payload at all: its `claude` runs on the far machine, so `statusKey` is `''`
   (`pty.ts:185,190`; `statusLine.ts:557-563`) and the banner is its only channel, exactly as
   before the payload existed. A banner that does say `(1M context)` still works, and escape
   codes must still be stripped before matching, because the banner is styled.

   Two things that cost time if you forget them. First, **a second `--settings` silently
   discards the first**, so the statusLine key and the `ultracode` key have to arrive in one
   file. Second, **the payload file is named after the launch key, not necessarily the CLI's own
   session id** — `pty.ts` computes `statusKey = opts.host ? '' : sessionId || randomUUID()`.
   For every session Stoke mints an id for, the two are the same string; a `--continue` session's
   id is chosen by the CLI *after* launch, so it gets a fresh random key instead, and still gets
   a wrapper and a payload — verified against a real session whose payload file was named
   `78fe5553-…` while the payload's own `session_id` field read `840cbab5-…`. The payload states
   its own id precisely so a reader keyed on the launch key can still recover the real one; code
   that assumes the file name *is* the session id will not find a `--continue` session's data.

3. **A `WebContentsView` outside the window's view tree gets a 0×0 viewport and never lays
   out.** `getBoundingClientRect`, `innerText` and every visibility check return empty, so
   the agent silently reads a blank page. Views are mounted immediately and merely hidden.

4. **Reset per-page logs on a main-frame, cross-document `did-start-navigation`.** Both of the
   obvious events are wrong, in opposite directions. `did-navigate` fires *after* the main
   document response, so resetting there wipes the very request you need when a page fails to
   load. `did-start-loading` was the second attempt and is wrong in a subtler, more damaging
   way: it fires again every time a client-side router starts fetching, so on any framework
   that prefetches — which is to say most of them — the whole log is cleared moments after the
   page finished loading. Measured on tailwindcss.com: the second `did-start-loading` arrived
   with 53 completed requests already recorded and took all of them, which is why the security
   audit found no headers to read. A real main-frame, cross-document navigation is the only
   event that should discard anything, and it fires before the document request goes out
   rather than after it comes back (`browser.ts:126-153`).

5. **xterm's WebGL renderer draws into a canvas**, so `.xterm-rows` is empty in the DOM.
   Verify terminal output from a screenshot, never `textContent`.

6. **The docked browser is its own CDP target.** Test scripts that attach by
   `type === 'page'` must filter on the URL or they drive the wrong page.

7. **electron-builder: an explicit `arch:` list in the config overrides the CLI flag.** With
   it, `dist:win --x64` still built all three architectures.

8. **PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM.** Use
   `[System.IO.File]::WriteAllText` with `UTF8Encoding($false)` when rewriting source files.
   Write `settings.json` with node for the same reason — a BOM breaks the parse silently.

9. **`window.stoke` cannot be monkey-patched from the page.** contextBridge freezes it, so
   assigning over a method to stub IPC in a test silently does nothing and the real value
   comes back. A test that appears to pass this way is testing production behaviour.

10. **Claude Code turns mouse reporting on, so a plain drag does not select.** xterm forwards
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

    There is no longer one clone shape, so do not look for one. The shim now emits
    `{ altKey: reporting && isMac, shiftKey: reporting && !isMac }` — three shapes, one per
    cell of the matrix — because Copy mode retells drags that carry no modifier at all, and
    off macOS the modifier xterm wants is the Shift the user is not holding. `verify:selection`
    asserts the *rule* (`reporting ? (isMac ? altKey : shiftKey) : !shiftKey`) against all three
    shapes rather than memorising outcomes. Its old pair of assertions could only ever have
    passed on a Mac: "a clone that keeps Shift selects nothing" is false off macOS with
    reporting on, which is exactly the clone that now ships there.

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
    because right-clicking means moving to the menu. Shift-drag, Option-drag and Copy mode were all
    affected identically; none of them is the cause and none of them is the fix.

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

11. **`align-self: center` centres the *margin* box.** Cancelling a container's padding for
    one child needs the full padding negated, not half — half lands it a pixel off. Measured,
    not reasoned.

12. **An explicit `--user-data-dir` must win over dev isolation.** An unpackaged run picks its
    own `(dev)` userData so it never fights the installed app, but that override has to be
    skipped when the flag is present, or a test profile boots the wrong settings and looks
    fine doing it.

13. **`execFile` defaults to a 1 MB `maxBuffer`, and `spawnSpec` routes `.cmd` installs
    through `cmd.exe /c`**, which eats `&`, `|`, `^`, `<` and `>`. Feed a prompt on **stdin**,
    never as an argv element, and raise `maxBuffer` well past the default.

14. **A native `WebContentsView` paints above all renderer DOM.** Any panel that must remain
    visible while the browser is open has to be a sibling column in `.body-row`, never an
    overlay. `.app` is a fixed three-row grid (`titlebar / body / status`), so a new full-width
    strip goes *inside* `.main-col` — adding a fourth row silently shifts the status bar into
    the body's track.

    Related, and it bit hard: **`.app` needs an explicit `grid-template-columns: minmax(0, 1fr)`.**
    Left implicit the column is an `auto` track whose minimum is its content's min-content
    width, so any row that resists shrinking makes the whole shell wider than the window rather
    than clipping itself. That was already true at the 940px minimum with both side panels open;
    a one-line prompt strip made the app grow 600px and clip the launcher. A nowrap flex row
    needs `flex: 1 1 0%` **and** `min-width: 0` on the text for it to ellipsis rather than
    push — and neither helps until the grid column can shrink. Found by measuring over CDP; no
    amount of reading the CSS would have shown it.

15. **`--safe-mode` and MCP are mutually exclusive.** Safe mode switches every MCP server off,
    so a run cannot both be hermetic and read a connector. That is why the worklog reads the
    boards in a *separate* run (`recall.ts`) and keeps the scan itself hermetic.

16. **A board's closed statuses are on none of its open tasks.** Reading the tasks tells you
    "open" and "in progress" and never "complete", so a status vocabulary inferred from them
    can describe every state except the one a finished job needs. `clickup_get_list` is asked
    for the list's own states separately, and only a status that came back from somewhere is
    ever written.

17. **The queue's dedupe key is load-bearing beyond dedupe.** Proposal ids are its sha1 and
    rejections are tombstones keyed on it, so changing the key format for a `create` silently
    resurrects every proposal the user has ever rejected. Updates got their own key shape
    (`sessionId|update|board:id`) precisely so the create key could stay byte-for-byte.

18. **An SSH session's `cwd` is the *local* folder, not the remote one.** `ssh -t <alias>` runs
    `claude` on the far machine, so the transcript, the real working directory and the project
    all live over there — but `SessionInfo.cwd` records wherever Stoke happened to be pointed
    locally. Resolving a project group from it names the wrong project, or none. Anything that
    gates on a folder needs a separate rule for SSH; the worklog uses a per-host switch
    (`SshHost.worklog`) and reads the true cwd out of the fetched transcript.

19. **Do not add flags to a user's remote connect command.** Passing `--session-id` to the
    remote `claude` would correlate a session exactly, but a remote CLI that does not know the
    flag exits with an unknown-option error — and the *terminal itself* then breaks on every
    connection to that host. `sshTranscript.ts` asks for the newest transcript instead. The
    cost is real: two Claude sessions on one host at once cannot be told apart.

20. **An `await` inside a polling pass is a window two passes can both walk through.**
    `AutoScanner.evaluate()` awaits the gate (a disk read), so a pass can outlive its own 15s
    interval; without a reentrancy guard *and* claiming the session before the await, two
    overlapping passes each started a paid scan for the same session. Setting the claim after
    the await is not enough — that is the window.

21. **A statusLine payload's `rate_limits` has real gaps a naive reader gets wrong.** It is
    absent at session mount and only starts appearing from the first render *after* an API
    response completes — a brand-new session legitimately has none, and that absence must never
    be drawn as "0% used." `used_percentage` is 0–100 but unrounded and carries float noise —
    `7.000000000000001` is a real value the CLI sent, not a bug in Stoke — so round it before
    display. `resets_at` is Unix epoch **seconds**, unlike every other timestamp in Stoke;
    `statusLine.ts`'s `reading()` is the one place that converts it to ms. `five_hour` and
    `seven_day` are independently optional, and the whole `rate_limits` key is omitted when
    neither is present — check each window separately, not as a pair. It also appears to
    populate only under Claude.ai subscription (OAuth) auth; under an API key it appears never
    to arrive (inferred from the CLI's own bundle, not observed — API-key auth was not tested).
    One more field worth knowing while you're in this payload: `model.id` carries the tier
    suffix in full (`"claude-opus-5[1m]"`), unlike the transcript's bare `model` field (gotcha
    2) — though nothing in Stoke actually reads it for window resolution; `windowFor` takes the
    number straight from `context_window.context_window_size` instead
    (`statusLine.ts:296,568-569`). `modelId`'s only two readers today are the type declaration
    and a test assertion (`src/shared/types.ts:236`, `scripts/verify-statusline.mts:93`).

22. **A CSS token rename only fails loudly if the old name is gone.** The spacing migration renamed
    `--sp-*` to `--space-*` on purpose: a missed `var(--sp-2)` names nothing, the declaration is
    invalid at computed-value time, and the padding visibly collapses to 0. Renumbering in place
    would have made `--sp-4` silently mean 4px where it used to mean 12px. Two consequences: the
    migration is verified by `grep -rn -- '--sp-' src/` returning **zero**, and a sweep over the
    stylesheet is not the whole job — 26 uses were inside `style={{ }}` objects in eight `.tsx`
    files and rendered at 0 until they were found.

23. **macOS traffic lights are device pixels; anything clearing them must be too.** `padding-left`
    in rem was only correct at Interface scale exactly 1.0 — at 0.8 the first tab sat under the
    close button. Same class of bug as sizing an icon with a px attribute inside a rem-scaled
    button: two units that do not move together, so it looks right at exactly one setting.

24. **A macOS auto-update is installed from a `.zip`, never the `.dmg`.** Squirrel.Mac swaps an
    `.app` out of an archive, so electron-updater's `MacUpdater` searches the feed for a zip and
    **rejects `dmg` and `pkg` by name** (`node_modules/electron-updater/out/MacUpdater.js:81-83`,
    6.8.9), throwing `ERR_UPDATER_ZIP_FILE_NOT_FOUND` before downloading a byte. Every release up
    to and including v0.4.0-beta.3 built `mac.target: [dmg]` only, so `latest-mac.yml` listed one
    file and no Mac could ever update itself — while `npm run check` passed, the dmg built, CI was
    green and the panel cheerfully said an update was available. Nothing fails when that target is
    removed, which is why `verify:updates` asserts it is present.

    Two things compound it, and both are worth knowing before declaring Mac updates fixed. First,
    the zip only gets the download working; **Squirrel then verifies the downloaded app against the
    running one's designated requirement**, and an ad-hoc signature's requirement is
    `cdhash H"…"` — the hash of that exact binary — which no other build can satisfy by
    construction. Second, **Windows needs none of this**: `NsisUpdater` only verifies a signature when
    `publisherName` is set in the builder config, and it is not, so that check is skipped
    (`NsisUpdater.js:84-99`). Windows self-update has always worked; only macOS was broken.

    **Two claims this entry used to make were wrong, and both were load-bearing.** Corrected in
    place, because each was believed for several releases.

    *"A self-signed certificate can be satisfied by the next build, so it is left alone."* True in
    theory and false in practice, and it is the case that actually ships. A locally built copy is
    signed with whatever code-signing identity is in the login keychain — here `MyTouchBar Local`,
    a certificate from an unrelated project — and the published release is not signed with it, so
    the requirement `identifier "dev.vinn.stoke" and certificate leaf = H"9af1c10c…"` cannot be
    met. `detectBlocker` returned null for exactly this case, so the panel offered the update, and
    Squirrel refused the swap only after 123 MB had been downloaded. The rule now lives in
    `src/main/codesign.ts` (no electron import, so `verify:updates` can test it) and blocks
    anything that is not Apple-issued, naming the certificate.

    *"`codesign -dv` prints an `Authority=` line for anything signed with a real certificate."*
    It does not. **At one `v` there is no `Authority=` line at all** — measured against this very
    binary, which `-dv` describes without naming its signer and `-dvv` reports as
    `Authority=MyTouchBar Local`. So the old probe could only ever detect the ad-hoc case, not
    because that was the intended rule but because it was the only fact in the output.

    **Both of those are now fixed rather than merely documented, and the fix is that CI signs
    with the same certificate.** `RELEASE_IDENTITY` in `src/main/codesign.ts` names it (`Stoke`),
    `signatureBlocker` stops blocking a copy that carries it, and the release workflow imports and
    *trusts* the `.p12` behind `MAC_CSC_LINK` before building. The installed copy on this machine
    reports `designated => identifier "dev.vinn.stoke" and certificate leaf =
    H"2bef4d37864a07cdffa024549f346178d9bf265c"` — the `Stoke` certificate — so a release signed
    with it satisfies that requirement and the swap goes through.

    Three things about that arrangement that will cost time if forgotten. **Setting
    `CSC_LINK`/`CSC_KEY_PASSWORD` and stopping there does not work, and fails silently**:
    electron-builder imports a `.p12` and sets its partition list but never trusts it
    (`grep -rn add-trusted-cert node_modules/app-builder-lib/` finds nothing), then searches with
    `security find-identity -v` — *valid* identities only — and an untrusted self-signed
    certificate is not valid, so the build falls through to a warning and ships an unsigned
    bundle. Hence the explicit `security add-trusted-cert` step, and hence `CSC_LINK` is
    deliberately NOT left set on the build step (with it set, electron-builder builds its own
    untrusted keychain and searches that one instead). **The identity name is a shared constant
    across three files** — `electron-builder.yml`, `codesign.ts`, and the `.p12` itself — and
    naming one the pipeline does not use converts a cheap up-front refusal into a 120 MB download
    that fails at the end. And **changing the certificate breaks the update chain exactly once**:
    the installed copy pins the old leaf, so the first build under a new one must be installed by
    hand, and macOS re-asks for the microphone grant because privacy permissions are tied to the
    signature.

    **macOS 26 removed Keychain Access, which kills every "export it from the GUI" recipe.**
    Verified on 26.5.2: no `/System/Applications/Utilities/Keychain Access.app`, and `mdfind`
    finds no copy anywhere. Searching for "keychain" opens the Passwords app, which has no
    certificates section at all — so the honest report from following the old instructions is
    "there is nothing in my certificates". `npm run mac:signing-secrets` does the whole job from
    the CLI instead, and two things it guards against are worth knowing on their own.
    **`security export` cannot select an identity by name** — it exports the entire keychain's
    worth, four identities here, so the naive one-liner would ship three unrelated private keys
    to GitHub; the bundle is split with openssl and the result is asserted to hold exactly one
    identity and one key, matching the fingerprint `security find-identity` reported. And
    **`gh secret set NAME < <(base64 -i missing.p12)` sets an empty secret and prints a tick**:
    the process substitution opens an fd whether or not the command inside it succeeded, so `gh`
    reads zero bytes and reports success. The workflow's gate is `[ -n "$MAC_CSC_LINK" ]` for
    exactly that reason, and says "unset or empty" rather than "not set".

    Third, and separate: **`CSC_IDENTITY_AUTO_DISCOVERY: false` does not produce an ad-hoc
    signature, it produces no signing pass at all.** With no identity to find, electron-builder
    skips the step and ships whatever the prebuilt Electron binary carried. Measured on the
    published `Stoke-0.5.2-arm64.zip`: `Identifier=Electron` rather than `dev.vinn.stoke`,
    `codesign --verify --strict` exiting 1 with "code has no resources but signature indicates they
    must be present", and **none** of the six entitlements `electron-builder.yml` specifies — no
    microphone, no JIT, no `disable-library-validation`. The release job passes
    `-c.mac.identity=-` now, which takes the real ad-hoc path (`MacTargetHelper.findSigningIdentity`
    has an explicit `qualifier === "-"` branch); verified locally to give the right identifier, a
    `--verify --strict --deep` exit 0, and all six entitlements. It still cannot auto-update, for
    the `cdhash` reason above, but it is a valid app rather than a broken one.

25. **`execFile`'s error packs three unrelated things into `code`.** A POSIX errno string when the
    spawn failed, one of Node's own `ERR_*` identifiers, and a plain **number** when the child ran
    and exited non-zero. A timeout is none of them: Node kills the child, so the error arrives with
    `killed: true`, `signal: 'SIGTERM'` and `code: null`. Test `killed` *before* the numeric code or
    every timeout reports as "exited with code null" — and note the real-process test does not catch
    that reordering, because a genuine timeout has no numeric code to be confused by; only a process
    carrying both (`killed: true, code: 143`) distinguishes the two orderings, which is why
    `verify:updates` asserts that case explicitly. Related: returning `stdout + stderr` from both the
    success path and the catch, as `updates.ts` used to, makes a failure and a success literally the
    same value.

26. **A `--continue` session has no context ring, and it is the missing *id* that causes it.** This
    is a real limitation of 0.4.0, not a bug waiting somewhere. `pty.ts:165-166` reads
    `opts.resume || opts.continueLast ? (opts.sessionId ?? '') : (opts.sessionId ?? randomUUID())`,
    and a `--continue` has nothing to pass, because the CLI picks the id itself after launch — so
    the id is `''`. `index.ts` hands that straight to `watcher?.watch(result.sessionId)`, and
    `ContextWatcher.watch` early-returns on a falsy id (`context.ts:102-103`), so no transcript is
    ever polled and the tab's ring stays blank for the whole life of the session. Closing the gap is
    not a one-liner: the real id does exist, but only inside the payload the wrapper writes under
    the *launch* key (gotcha 2), and `src/shared/ipc.ts` has no channel for a session id that
    arrives late — `pty:start`'s return value is the only place the renderer is ever told one, and
    it has already returned. The plan-limit chip is unaffected, because `refreshLastStatusLine()`
    reads every live `statusKey` directly and a payload's rate limits are account-wide anyway.

27. **`src/shared/**` is compiled by both tsconfigs, and only one of them has Node's types.** Both
    `tsconfig.node.json` and `tsconfig.web.json` include `src/shared/**/*.ts`, but the web project
    sets `"types": ["vite/client"]` with no `node` — so a `node:` import added to a shared module
    fails the *web* half of `npm run typecheck` while the main half stays green, and the error names
    a file you were not editing. (`voice.ts` is the mirror image of the same split: browser-only,
    and excluded from the node project by name rather than moved.) Related, and easy to trust
    wrongly: **`scripts/` is in neither include**, so the verify suites are never typechecked. They
    are run, which is most of the point — but node's strip-only mode checks nothing, so a suite can
    be type-wrong and still exit 0 with every assertion passing, and `typecheck` will never say so.

28. **A terminal link has no modifier gate and fires on mouseup.** `Linkifier._handleMouseDown`
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

29. **ssh's `~` escape is live on every SSH tab, and it corrupts pastes.** `buildSshArgs` sent no
    `-e none`, and ssh runs on a pty here, so client-side escape processing is on regardless of
    `-t`. `~` is read as an escape only directly after a newline — which is exactly where a
    multi-line paste puts it, because xterm rewrites every newline to a bare `\r` and brackets
    the blob as a whole rather than line by line (`Clipboard.ts:14,21-26`). Line 1 is safe and
    lines 2..n are not: `~~` collapses to `~`, `~?` and `~#` print ssh's own help over the
    session, and `~.` kills the connection while the user watches their paste do it. It reads as
    "paste is flaky" because it is content-dependent, and `~/some/path` survives untouched.

    Related and still open: **Stoke registers no OSC 52 handler** by default in xterm — 52 is
    listed unimplemented in `InputHandler.ts` — so nothing on the far side of an ssh connection
    could put text on the local clipboard. `pbcopy` writes to the *remote* clipboard; tmux
    copy-mode and `vim "+y` had no channel at all. `TerminalView` now handles the write
    direction and **refuses the read direction**, because `OSC 52 ; c ; ?` asks the terminal to
    report the clipboard and everything a terminal renders is untrusted — a hostile file printed
    with `cat` would otherwise read whatever was last copied.

    "tmux wants `set -g set-clipboard on`" is too blunt, and the difference decides what to tell
    a user. `set-clipboard` is a **server** option with three values, tmux 3.4 defaults to
    `external`, and `external` is **asymmetric** — measured on the real VPS with an isolated
    `tmux -L … -f /dev/null` server while watching the ssh pty:

    | value      | tmux's own copy-mode → outer terminal | an app inside a pane emitting OSC 52 |
    |------------|---------------------------------------|--------------------------------------|
    | `off`      | no                                    | no                                   |
    | `external` | **yes**                               | **no** — parsed and dropped          |
    | `on`       | yes                                   | yes                                  |

    So **byobu's own F7 copy-mode already reaches the local clipboard with no remote
    configuration at all**, which is the honest answer to "how do I copy off the VPS": it is
    keyboard-only and it covers the pane's scrollback. `on` buys exactly one more thing —
    `vim "+y`, nvim's osc52 module, anything *inside* a pane. Two further traps: tmux emits at
    all only if the outer `TERM` carries the `clipboard` feature, which `xterm*` has by tmux's
    own built-in default and `pty.ts:231` sets, so the widely copy-pasted `Ms` override is
    redundant here; and byobu already occupies `terminal-overrides` with `xterm*:smcup@:rmcup@`,
    so "adding" an `Ms` entry with `set -g` **replaces** byobu's line rather than extending it.
    `set -ga` is the only safe form.

    One ceiling worth knowing before promising anything: **a pane running `claude` has no
    scrollback anywhere.** It is on the alternate screen, so tmux keeps no history for it, and
    byobu's `smcup@:rmcup@` stops tmux scrolling into Stoke's own scrollback either. Only the
    visible screen is ever copyable out of such a pane, by any route — which is why the context
    menu's `Copy screen` takes the viewport rather than the buffer.

30. **Three separate things stopped the worklog ever marking anything done, and only one of them
    was in the write path.** In likelihood order:

    - **`formatRecall` blind-sliced the listing.** `clip(blocks.join('\n'), 2400)` against
      `MAX_RECALL_ITEMS = 30` at ~130 characters a line left roughly half the records standing,
      with the boundary line severed mid-id. That string is the *only* channel by which a board
      id reaches a scan — the scan is `--safe-mode` (gotcha 15) with no MCP server to look one
      up, and is told an id it cannot see does not exist — so a finished task below the cut came
      back as a duplicate **create** and the original stayed open. Nothing counted it: `demoted`
      only counts ids the model *did* name. The two caps must be reconciled or the smaller one
      silently decides how many records the scan can see; the budget is now per board, trims
      whole lines, and never trims the header, which carries the closed statuses.
    - **The queue's update key ignored the status.** `sessionId|update|<record>` meant a
      session's first update took the record's key and every later one collapsed onto it — and
      the prompt asks for an update whenever an item was finished, started *or blocked*, so
      "started X" reliably consumed the key that "X is done" needed. Silently: `add` just
      `continue`s. Accepting the first does not release it either, since `accept` only patches
      `status` and `ProposalPatch` excludes `newStatus`. The status is in the key now; gotcha 17
      still holds, because the *create* key is untouched and rejections also contribute a
      title-based key (`queue.ts:368-372`).
    - **Notion had no way to learn its own closed statuses.** `TOOLS_FOR.notion` held only
      `query-data-sources` and `search`, neither of which returns a schema, so "report every
      value its status property allows" was unanswerable and the vocabulary degraded to whatever
      appeared on the pages recalled. That is gotcha 16's ClickUp problem exactly, unfixed on
      the destination that ships as the default. `notion-fetch` is in both the recall allowlist
      and the update write list now — the write needs it too, because a page's status property
      can be called anything and `notion-update-page` has to name it.

    Two smaller ones worth carrying: an out-of-vocabulary status was dropped with **no counter,
    no log and no field**, so the note was written, the write returned ok, and the panel drew
    "Written" over a task nobody had closed — from outside, "nothing needed closing" and "the
    closing word was refused" were the same event. And the gate compared lowercased but stored
    the model's spelling, so the live queue holds `{"notion":"COMPLETE"}` against a board that
    spells it otherwise; `canonicalStatus` returns the board's own spelling now.

31. **A window-level listener registered in an effect keeps whatever its deps captured, and a
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

32. **Zoom is the second exception to the Shift rule, and the only one where Shift is actively
    harmful.** Off macOS every letter chord demands Shift because bare Ctrl+K/W/T are readline
    bindings Claude Code's prompt uses. Zoom inverts it: xterm turns Ctrl+`_` — which *is*
    Ctrl+Shift+`-` on a US layout — into `C0.US` (`Keyboard.ts:361-364`,
    `if (ev.key === '_') result.key = C0.US`), and that is readline's undo. Binding the Shift
    variant would have eaten it silently. Bare Ctrl+`-` and Ctrl+`=` match neither of xterm's
    two Ctrl branches, so the terminal does nothing with them at all — which is what makes them
    free to take, and why every other app already uses exactly those.

    Zoom-in accepts Shift and zoom-out refuses it. That asymmetry is not sloppiness: `+` IS
    Shift+`=` on most layouts, so someone pressing "Cmd and plus" is holding Shift whether they
    think so or not, while `-` needs no Shift to type. `verify:shortcuts` pins the refusal
    first, because it is the assertion that protects something rather than adding something.

33. **A DOM box and an SVG do not paint on the same grid, so two things that `getBoundingClientRect`
    agrees are concentric can be visibly apart.** The worklog watch dot was a 5px `<span>` centred
    over the 14px context ring in one grid cell. Both centres read *identical* off
    `getBoundingClientRect` — and the dot painted **0.707px up and to the right**, which on a 14px
    indicator whose inner clear diameter is 7.6px is the whole tolerance.

    `place-items: center` puts a 5px child in a 14px box at 4.5px — a half-pixel — and Blink
    **snaps a painted background box to whole CSS pixels while leaving SVG geometry exactly where
    the arithmetic put it**. So the dot rounds and the ring does not. Measured, not reasoned: the
    painted centroids of both shapes were extracted from `Page.captureScreenshot` at scales 1, 2,
    8 and 16 with the two shapes forced to pure green and pure magenta so the masks could not
    bleed. The offset is **scale-invariant** — it is not antialiasing and Retina does not hide it,
    it doubles it in device pixels — and its **direction flips with the container's own fractional
    position**, which is why it read as "the dot is off centre" rather than as anything
    reproducible.

    Ruled out by the same measurement, so nobody re-derives them: grid auto-placement (`.sr-only`
    is `position: absolute`, so no implicit second row exists), the ring's `rotate(-90deg)`
    (rotating a circle about its own centre is identity — the offset is identical with the
    transform removed), the stroke geometry, and the cascade.

    An even-sized dot fixes it at Interface scale 1.0 and **only** there: at 1.1 the rem sizes stop
    landing on integers and the two boxes round apart again. The durable fix is to stop having two
    boxes — the dot is a `<circle cx="8" cy="8">` inside the ring's own `<svg>` (`ContextMeter.tsx`,
    `WATCH_R`), which is concentric *by construction* at every scale, dpr and sub-pixel offset.
    Verified: 0.0000px at every offset tried, against 0.707px for the span at all of them.

    The general rule: **anything that must line up with SVG must be drawn in that SVG.** Overlaying
    a DOM box on vector art in a shared grid cell is correct in layout and wrong on screen.

34. **Two capture-phase listeners on the same node can cancel each other, and a synthetic event must
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

35. **Tab restore is carried by the debounced write, not by `before-quit` — and that is
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

36. **The plan-limit chip needed a running session only because of where macOS keeps the token,
    and the Keychain blob has a trap in it.** `readOauthToken` read `~/.claude/.credentials.json`
    and nothing else. That file does not exist on macOS — the credential is a login-Keychain
    generic password under the service name `Claude Code-credentials` — so `fetchUsage` reported
    "Not signed in to Claude Code" on every call, the account route contributed nothing, and the
    statusLine payload was the chip's only source. The payload exists only while `claude` is
    running, so closing the last tab took the numbers with it, exactly as the panel's own note
    admitted. `readCredentials` (`usage.ts`) now falls back to
    `security find-generic-password -s "Claude Code-credentials" -w` on darwin, and
    `STOKE_LIVE_USAGE=1 npm run verify:usage` passes here against the real account with nothing
    else running.

    **The blob is not just the account, and first-match-wins picks the wrong token.** It is
    `{ mcpOAuth, claudeAiOauth }`, where `mcpOAuth` holds one record per connected MCP server —
    around fifty here — each with its own `accessToken`, several non-empty (a Figma `figu_…`).
    `mcpOAuth` is enumerated **before** `claudeAiOauth`, and the old scan returned the first key
    matching `/access.?token/i`, so it handed back a *connector's* token. `api.anthropic.com`
    answers that with 401, which renders identically to being signed out — on the one platform
    where signed-out was already the expected outcome, so it would never have looked like a bug.
    The search is two passes now: an `sk-ant-oat`-prefixed value anywhere wins, and only if
    nothing carries the prefix does the lenient key-name match run, with `mcpOAuth` skipped.
    Pinned by `verify:usage` against the real blob's shape.

    Two smaller things. `security` **blocks on a GUI Keychain prompt** when the item's ACL does
    not already trust it — it did not prompt here, but a fresh machine will — so the call carries
    a 5s timeout rather than being allowed to hang a main-process handler. And the account token
    **expires** (`claudeAiOauth.expiresAt`, epoch ms, refreshed whenever Claude Code runs); Stoke
    reads it and never refreshes it, because rotating the token would invalidate the copy the CLI
    is holding. An expired one is reported as expired before the request rather than discovered
    as a 401.

37. **Claude Code's Remote Control turns itself on from a server-side flag, and `/remote-control`
    cannot turn it off for good.** The resolver runs once at REPL bootstrap and, with no local
    setting, falls through to the GrowthBook feature `tengu_cobalt_harbor` — `true` for this
    account. `/remote-control` -> "Disconnect this session" is a **pure in-memory state reducer
    with no settings write**, so it resets every launch. The one-time disclosure banner has a
    three-impression cap (`cSr="remote-control-auto-on", qWh=3`), so once you have seen it three
    times the feature starts silently. And the `d` key in the RC dialog, which *does* persist an
    off, is gated on `replBridgeExplicit` — `false` for exactly the auto-on sessions that need it.

    The flag's value cannot be overridden locally: the env-override path is dead code
    (`getEnvironmentOverrides()` returns before it reads `CLAUDE_INTERNAL_FC_OVERRIDES`), the
    config-override reader/writer are empty stubs, and there is no
    `CLAUDE_CODE_DISABLE_REMOTE_CONTROL`. But the flag is never *consulted* when a local setting
    exists. **`"remoteControlAtStartup": false` in `~/.claude/settings.json`** is the fix;
    `disableRemoteControl: true` is the bigger hammer. Only policy/flag/user scope may *enable*
    it — a repo-scoped `true` is ignored — but a repo-scoped `false` works, and so does a
    checked-in `disableRemoteControl: true`, which silently kills RC for anyone who opens
    that repo.

38. **Writing Claude Code's own config: two files, two completely different risk profiles.**
    `~/.claude/settings.json` is small and hand-owned — temp+rename is enough.
    `~/.claude.json` is the global config, 155 KB here, rewritten constantly by every live
    session, and **a parse failure makes the CLI back it up and reset to defaults** — measured at
    16 keys down to 5, destroying `oauthAccount`, `userID` and every project entry, with no
    automatic restore. `src/main/claudeGlobalConfig.ts` therefore refuses to write over a file it
    could not parse, refuses one with no sign-in recorded (dropping the auth keys freezes the
    CLI's own persistence via `GDe()`), and never creates the file.

    **The lock is a directory, and taking it is necessary but not sufficient.** The CLI bundles
    proper-lockfile v4: `mkdir <config>.lock`, stale at 10s by the directory's own mtime,
    refreshed every 5s. A live session does *not* clobber an external edit with a cached object —
    every writer re-reads from disk inside its critical section, verified by a sentinel surviving
    a session's full exit payload. The loss window is narrower: `[the CLI's read completes -> its
    rename completes]`, which sits inside its lock hold. But the CLI acquires with **`retries: 0`**
    and falls straight through to an unlocked, un-backed-up write — so Stoke holding the lock is
    what *forces* it onto the unguarded path — and its exit handlers take no lock at all. Hence
    lock, hold briefly, **and verify the write survived, then retry**. All three.

    Three smaller traps, each measured. A stale lock **file** is worse than a stale directory:
    the CLI breaks stale locks with `rmdir`, which can never remove a file, so one left there
    degrades every CLI config write permanently — Stoke unlinks it, which repairs the CLI rather
    than just itself. The CLI's own rename retry predicate is **stubbed to `false`**, so it never
    retries; on Windows an `EPERM`/`EBUSY` there sends it down a non-atomic in-place write.
    And `<CLAUDE_CONFIG_DIR||~/.claude>/.config.json` **wins outright** over `~/.claude.json` when
    it exists, so a writer that hardcodes the latter edits a file nothing reads.

39. **`workflowSizeGuideline` is dual-homed and the two homes are not equivalent.** It is a valid
    `settings.json` key *and* a `~/.claude.json` key. `/config`'s "Dynamic workflow size" row
    writes the global config — and `aur()` hides that row entirely whenever settings.json defines
    the key (`iz()?.settings.workflowSizeGuideline !== void 0`). So putting it in the settings
    file takes the control away from the CLI. Stoke writes the global config for that reason, and
    pays for it with gotcha 38's whole protocol. Absent means `medium` (`LRf`), so unset and an
    explicit medium behave identically.

    While you are in that schema: **`effortLevel` accepts only `low|medium|high|xhigh`, not
    `max`** — and it carries `.catch(void 0)`, like most of these enums, so writing `"max"` is
    *silently dropped* and the session ends up with no effort level at all. `claude config` no
    longer exists in 2.1.237 either; `claude config list` is parsed as a prompt and starts a
    session. Editing the JSON is the only route.

    One Stoke-specific rule that is easy to get backwards: **Stoke's own `--settings` file is
    `flagSettings`**, and precedence is `userSettings < projectSettings < localSettings <
    flagSettings < policySettings`. Anything Stoke folds into that file *outranks* what the
    settings panel writes to `~/.claude/settings.json` — which is why `statusLine` and `ultracode`
    are on `NEVER_OFFERED` in `src/shared/claudeConfig.ts`. Adding a key to
    `writeSessionSettingsFile` means adding it there in the same change, or drawing a control
    that visibly moves and changes nothing.

40. **A synchronous `fs` call in the main process is a bet that every path in the list is on the
    internal disk — and the project list is exactly where that bet loses.** This was the cause of
    "Stoke sometimes takes ages to start", and the "sometimes" is the whole tell: a constant cost
    would have been found years ago.

    `listProjects` ran `existsSync` once per project (`projects.ts:174`) plus once per manually
    added folder (`:229`), and `findSessionFile` ran one per history directory in a `for` loop.
    Instrumenting the built main process — a prologue that wraps every sync `fs` method, spliced
    into a copy of `out/main/index.js`, run under a copy of the real settings — counted **392
    synchronous `existsSync` calls in the first six seconds of one boot, 40 of them against paths
    on an external USB SSD**. That machine had eight projects under `/Volumes/NVME (1TB)`, and
    `pmset -g` reports `disksleep 10`: after ten idle minutes the disk is asleep and its first
    access has to wake it.

    The cost is not the wait, it is *where* the wait happens. A sync call blocks the Node event
    loop, so it stops every IPC reply and every frame with it. Measured by injecting a delay into
    `/Volumes` stats only: at 200ms per stat, `ready-to-show` moved **733ms → 2012ms** and the main
    thread was blocked **6.4s of the first 6s** — the window appears and then sits frozen. It is a
    race, too, which is the other half of "sometimes": with a fast disk `listProjects` has not
    started by the time the window paints, and with a slow one it gets there first and holds the
    paint. After the fix (async `access` + a shared deadline + one parallel resolve for the whole
    set): **52 sync calls, none on `/Volumes`**, and the same 200ms injection changes nothing at
    all — 414ms to `ready-to-show`.

    Two things worth carrying beyond this one bug. **`existsSync` is never the cheap option it
    looks like** in a process that also draws a UI; the deadline in `folderExists` matters as much
    as the `await`, because it decides that a list may be briefly *wrong* rather than late. And
    **`String.prototype.split`'s limit caps the array, not the read that produced it** —
    `cwdFromTranscript` did `readFile(file, 'utf8')` then `split('\n', 200)` and read 14.76 MB per
    `listProjects()` on this machine, unbounded in principle, while `sessionFile.ts`'s `readLines`
    had had the bounded head+tail reader all along. `listProjects()` went from ~30ms to ~6ms warm
    on that change alone.

    None of this is visible to `npm run check`, and that is gotcha 31's lesson again: every one of
    these calls is a side effect inside a function whose return value is correct. It took wrapping
    `fs` in a real launch to see any of it.

    **The other half of the boot cost was a static import list, and `externalizeDepsPlugin` is why
    it is invisible.** electron-vite does not bundle dependencies, it re-emits them as bare
    `require()` calls at the top of `out/main/index.js` — so a static import in any main-process
    module is resolved and *evaluated* before `app.whenReady()` fires, whether or not the feature
    is ever used. Seven externals were required at module scope. `@modelcontextprotocol/sdk`
    dominated: 230 module files across 11 packages (hono, ajv, zod-to-json-schema and friends) for
    53-91ms, all so that `handle()` could answer an HTTP request that most launches never receive
    — `BrowserMcpServer.start()` itself needs only `node:http` and one 221-byte `writeFileSync`.
    `electron-updater` cost 23-51ms for a check deliberately deferred to +8s, and `qrcode` 5-16ms
    for one panel.

    Deferring those three (memoised `loadSdk()` in `mcp/server.ts`, a memoised `updater()` in
    `selfUpdate.ts`, one `await import('qrcode')`) took **`whenReady` from 336ms to ~50ms and
    `ready-to-show` from 733ms to ~260ms**, and dropped module resolution from 649 `realpathSync`
    and 470 `readFileSync` calls to 27 and 23. Check it stayed fixed by grepping the built bundle,
    not the source — `grep -nE '^const [A-Za-z_$]+ = require\("' out/main/index.js` should list
    node builtins, `electron`, `@lydell/node-pty` and `ws`, and nothing else. A dynamic `import()`
    of an externalised dependency survives the build as a lazy require; a static one does not.

    Unlike the `/Volumes` stalls this is a *constant* cost with no variance, so it was never the
    "sometimes" — it is simply floor. Both were worth fixing and only the first one explains the
    complaint.

41. **`--output-format json` stopped being one object, and it took every headless run with it.**
    The help text still reads `"json" (single result)`, and up to `claude` 2.1.221 it was one.
    **2.1.237 prints the whole message array** — `system/init`, `rate_limit_event`, the assistant
    turns, then the `type: "result"` object last. Measured here on 2026-08-25: a successful run
    returned an 8-element array and exited 0, a budget-exhausted one a 4-element array and
    exited 1.

    `agent.ts`'s `parseEnvelope` rejected that **twice**, and the second rejection is why the
    failure was unreadable rather than merely wrong. `JSON.parse` succeeded and the
    `!Array.isArray(v)` guard threw the value away; the brace-scan fallback then sliced from the
    first `{` to the last `}` and produced `{…},{…},{…}`, which is not JSON. So every worklog
    scan, recall and apply failed: a clean run raised `The headless run returned no JSON result`,
    and a non-zero exit raised `The headless run failed (exit 1): [{"type":"system"…` — 400
    characters of raw stdout in place of the reason the CLI had just stated in the envelope it
    printed. The reported error is therefore never the real one; fix the parse before diagnosing
    anything else.

    **`npm run check` could not see it, and the reason generalises.** Every budget assertion in
    `verify-worklog-runner.mts` is handed a `HeadlessResult` that has *already* been parsed, so
    all of them stayed green while no headless run on this machine could complete. Gotcha 31 one
    layer down: the wire from stdout to that object was the only untested part of the path, and
    it was the part that broke. `parseEnvelope` is exported now and both shapes are asserted,
    array first — an object's own `permission_denials: [...]` is the first `[` in its text, so
    the array scan has to fall through rather than win, and the result is found by `type` rather
    than by being last.

    While measuring this, two costs worth carrying. A **trivial** sonnet run under `--safe-mode
    --strict-mcp-config` cost **$0.1224**, of which $0.1215 was 20,239 cache-*creation* tokens
    for the system prompt and 26 tool definitions — $6.00/Mtok, the **1-hour** cache-write tier.
    That is the fixed floor of any sonnet headless run before the prompt is considered, and
    `--max-budget-usd` cannot prevent it: the cap is checked *after* the turn, so a $0.05 ceiling
    still billed $0.12. `SCAN_MAX_BUDGET_USD` ($0.30) clears it with a 6000-char digest
    (~$0.13 total) but not by much. Second, `--allowedTools` prunes the tool schemas actually
    sent, so the apply and recall runs do **not** pay for all 427 tools of 30 MCP servers —
    measured at 15,610 cache-creation tokens with the allowlist down to one name.

42. **Claude Code's own theme lives in `settings.json`, and the way to follow it is OSC 11,
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

43. **The palette is generated now, so do not hand-edit a hex in `themes.ts`.** Every value comes
    from `src/shared/ladder.ts` — Radix's twelve steps, steps 1-8 an even ramp in OKLCH L and
    steps 10-12 bisected against a contrast target. Editing a hex reintroduces exactly the class
    of defect the ladder exists to prevent, and it will not be visible: the hand-picked palette
    passed every suite in the repo while its borders measured **APCA Lc 0.00** against their own
    page and its ramps were uneven by 3.5x to 6.3x.

    Three things about it that are counter-intuitive enough to be worth stating.

    **The light and dark step maps disagree on purpose.** In dark mode raised means lighter. In
    light mode there is no headroom above white, so **interaction darkens** and elevation is
    carried by border and shadow — the surface step alone measures Lc 0.00 there and cannot do
    the job. That is Material 3's own conclusion (light containers run 98 -> 90, dark ones
    6 -> 22) and it is what removes the inversion where Daylight's `surfaceHover` sat below `bg`
    while `surface` sat above it.

    **The text rungs are solved against step 4, not against the page.** Step 4 is the hardest
    ground text lands on in either appearance — `surfaceHover` in dark, `bgSunken` in light.
    Solving against the page is exactly how `--text-faint` came to promise 4.5:1 "on bg",
    deliver 5.10 there, and measure 3.99 on a hovered row. And the targets are WCAG ratios, not
    APCA: solving for Lc 60 alone lands light-mode muted text at 3.59:1, because APCA is content
    and WCAG is not.

    **A light terminal's bright slots must be DARKER.** `bright` is what SGR bold selects, so it
    has to gain contrast, which on a light ground means moving away from white. Daylight had all
    eight brights lighter than their normals, so bold text was the least legible text on screen.
    The four greys are one monotonic ramp with `black` always darkest; inverting the pair as
    Catppuccin Latte does was measured and rejected, because it moves the problem to `black` at
    1.52:1 rather than fixing it.

    `src/remote/style.css` carries a HAND COPY of Ember's fourteen tokens and no suite can see
    it — the mobile bundle is built separately and shares no module with the renderer. It had
    drifted to the pre-ladder values. Regenerate it whenever the themes move.

44. **`--accent` is a fill and `--accent-ink` is a foreground, and they cannot be one token.**
    A profile auto-activates from the active tab's cwd and `applyAppearance` used to write its
    four hand-authored hexes onto `:root` with no appearance check. Every profile accent is
    tuned for a dark ground, so on the light theme they measured **1.43:1 to 2.52:1** against
    the page — while driving `:focus-visible`'s outline, the context ring's stroke, the tab
    indicator and `.input:focus`. The keyboard focus indicator was effectively invisible in
    light mode, on the default path, and `verify:profiles` asserted only `accentContrast`
    against `accent` so `npm run check` passed throughout. Gotcha 31 again.

    Deriving the FILL instead would have been the obvious fix and is wrong: it silently
    restyles three of the eight shipped swatches in dark mode, which is a product decision
    rather than a repair. So `--accent` keeps the brand colour and `--accent-ink` is solved for
    both 4.5:1 and APCA Lc 60 against the page. `src/shared/accent.ts` does it; the 23
    foreground, stroke, outline and 1px-border sites in `app.css` use the ink.

    Two traps inside that derivation. **Thresholds must be tested on the ROUNDED colour** —
    `fitToSrgb` returns fractional components but an 8-bit hex is what ships, and testing the
    unrounded value converged every light-theme ink to 4.49:1 against a 4.5 requirement. And
    there is a **~7 L\* dead band** (roughly L\* 66-78 by hue) where neither near-white nor
    near-ink reaches Lc 60 on a fill, so a filled button has no legible label at any ink; three
    shipped swatches sit in it. The fill is nudged out rather than the label accepted, by less
    than the 0.04 perceptual distance this repo already calls "the same colour".

45. **"The payload is fresher than the account" is true during a session and false after it, and
    believing it unconditionally is what froze the usage chip.** `mergeUsageWindows` took the
    statusLine payload's `percent`/`resetsAt` over the account endpoint's whenever both existed,
    on the reasoning that a payload is seconds old where the account is a poll. That reasoning
    has an unstated precondition: something has to still be *writing* the payload. Nothing
    rewrites it once its session ends, and `lastStatusLine` in `index.ts` is deliberately kept
    for the whole run so the chip does not blank when the last tab closes — so an hours-old
    reading went on outranking a thirty-second-old account poll for as long as the app stayed
    open. From outside, that is a chip whose numbers never move again however much of the plan
    gets spent, with an "as of HH:MM" beside them that was also quoting the payload.

    The merge compares the two timestamps now, ties going to the payload, and the panel's "read
    from…" sentence follows the same comparison rather than assuming an answer. Neither half was
    visible to a suite: `verify:statusline` and `verify:usage` both called the merge with two
    arguments and asserted the payload won, which is exactly half the rule. Both suites now run
    the same fixtures in both directions.

    **The message boundary is `prompt_id`, not the file's mtime.** The chip refreshes the account
    reading every 30s *or* whenever a new message starts, whichever is first, and the second half
    needs a way to tell "a new message" from "the CLI redrew". The payload file is rewritten about
    three times a second for the whole of a turn, so `receivedAt` moving means nothing;
    `prompt_id` changes exactly once per user message. It is keyed per session in the renderer,
    because two open sessions have unrelated prompt ids and alternating pushes would otherwise
    read as a message every time. Main applies a 5s floor to a message-triggered read and 30s to
    a polled one, and `retryAfter` outranks both — a 429 is not something a message boundary gets
    to ignore. Verified against the running app: three reads inside the floor returned one
    `fetchedAt`, and the 15-minute 429 backoff held for `message` reads too.

46. **`claude update` follows its own stable channel; `checkForUpdate` reads the npm `latest`
    tag; they disagree, and the disagreement is stable.** Measured 2026-08-28: the registry said
    2.1.250, the installed CLI was 2.1.237, and `claude update` answered *"You're running 2.1.237,
    which is newer than the stable channel's 2.1.236. Skipping update."* — exit 0, nothing
    changed, `updateAvailable` still true afterwards.

    That makes a purely time-based retry floor wrong rather than merely inefficient: it is a
    three-minute subprocess every six hours, forever, to be told the same thing. So
    `shouldAutoUpdate` records *what* was attempted (`AutoUpdateAttempt`: target, from, failed)
    and treats the two outcomes differently — a **failure** can be transient and is retried on a
    timer, a **clean run that changed nothing** is not retried until one of the two versions
    actually moves. Related, and the reason `runUpdate` reads the version either side at all:
    exit status cannot answer "did it update", because 0-with-no-change is what both "already
    current" and "cannot write to this install" look like. The panel quotes the CLI's own last
    output line for that case rather than paraphrasing it — the CLI already gives the real reason
    and Stoke cannot infer it.

47. **A button with no declared box keeps Chromium's `buttonface` fill.** The global reset in
    `app.css` sets only `font` and `color` on `button`, so the settings menu's ten nav rows
    rendered as chunky grey UA buttons until they declared `border: none; background: transparent`
    — the same three properties `.segmented button` declares a thousand lines above, for the same
    reason. Only a screenshot showed it; every measurement of the modal was already correct.

    Two more from the same session, both found by driving the built app rather than reading the
    CSS. **`@keyframes pop` carries `translate: -50%`**, which is right for the context menu it
    was written for and wrong for anything centred by `margin: auto`: measured two frames after
    the click, the dialog was at `x: -220` for a box that settles at `x: 260`, so it flew in from
    480px off the left. Centred dialogs use `modal-in`. And **a fixed-position dialog with a
    specified width needs `min-height: 0` on its scrolling grid track**, or a tall section makes
    the dialog taller than the viewport and the pane never scrolls — gotcha 14's `.app` column
    problem, one axis over.

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

**Windows carries the opposite risk now: nothing in this round of work ran there.** One change
in it is actively suspect on that platform: `statusLineCommand()` emits `"<path>" "<id>"` — two
quoted arguments on one command line — and `cmd.exe`'s own quote-stripping rule only behaves
like a POSIX shell for a single quoted pair; more than two quote characters on the line and its
rules diverge, potentially stripping the outer quotes that keep the two arguments apart. That
shim path has not been exercised since it was written. Treat it as unverified, not merely
untested, until someone runs a statusLine-driven session through `cmd.exe` and checks the
payload actually arrives.
