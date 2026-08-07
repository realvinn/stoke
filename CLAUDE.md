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

The verify suites, all runnable alone. `check` runs everything except the last two, which
need a live instance or cost money:

```bash
npm run verify:context        # context meter against the real transcripts on this machine
npm run verify:profiles       # profile resolution + every accent clears 4.5:1
npm run verify:settings       # settings hydration: repair, clamps, and what it drops
npm run verify:color          # colour maths: contrast, APCA, oklch
npm run verify:worklog-gate     # which sessions the worklog agent would watch
npm run verify:worklog-runner   # prompt building, JSON parsing, titles, create-vs-update
npm run verify:worklog-retry    # writes happen once, and a retry never duplicates a record
npm run verify:worklog-recall   # the read-only board read, its parse and its cache
npm run verify:worklog-autoscan # when a session is scanned without being asked
npm run verify:ssh            # ssh argv, ~/.ssh/config parsing, the remote transcript fetch
npm run verify:extract        # page extractor regression set
npm run verify:usage          # plan limits, incl. a live account call
npm run verify:security <url> <token> --access   # remote server, against a running instance
```

## Layout

```
src/main/         Electron main process
  index.ts          lifecycle, window, every IPC handler
  pty.ts            PTY sessions, env sanitising, scrollback, fan-out
  cli.ts            locating claude, building its argv
  projects.ts       project + session discovery from Claude's own files
  context.ts        live context-window watcher (polls transcripts)
  sessionFile.ts    transcript parsing and the context maths
  browser.ts        docked Chromium: tabs, find, console/network capture
  workspace.ts      default folder + scratch folders
  store.ts          settings persistence
  settingsSchema.ts defaults + hydrate, with no electron import so a suite can run it
  updates.ts        claude CLI version/health
  selfUpdate.ts     Stoke's own updates (electron-updater)
  profiles.ts       plans and creates a profile's folder + scan root
  ssh.ts            ~/.ssh/config parsing, the ssh argv, the transcript command
  sshTranscript.ts  pulls a remote session's JSONL back, so SSH sessions can be read
  agent.ts          headless `claude -p` runner (prompt on stdin, json out)
  audio/            reads the default capture device, to warn about virtual cables
  worklog/          the Notion/ClickUp review queue
    gate.ts           which project groups are watched
    autoscan.ts       when a quiet session is scanned without being asked
    recall.ts         reads the boards (read-only, cached) so updates beat duplicates
    runner.ts         scan (read-only) and apply (writes, on accept only)
    queue.ts          the persisted proposal list
    json.ts           the shared "read JSON out of a model's reply" rescue
  mcp/              MCP server exposing the browser to Claude
    server.ts         HTTP transport + the 17 tool definitions
    page.ts           drives the page through the injected extractor
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
  worklog.ts        the board targets the worklog can write to, and their defaults
  ui.ts             the uiScale / fontSize bounds, and the clamps both processes use
scripts/          the verify-*.mts suites, make-icon.cjs
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

2. **The context window cannot be derived from the model id.** A 1M-tier session records its
   model as plain `claude-opus-5` — no `[1m]` suffix survives into the transcript and there
   is no `context_window` field. Verified again on a session at 713,617 tokens; the only
   tier-ish field anywhere is `usage.service_tier`, which is billing. The CLI *does* state it
   in its startup banner, so `pty.ts` reads `(1M context)` out of the first frames and hands
   it to the watcher; `contextLimitFor` falls back to observed usage, where over 200k proves
   the extended tier. Strip escape codes before matching — the banner is styled, so the digits
   routinely arrive separated from the word.

3. **A `WebContentsView` outside the window's view tree gets a 0×0 viewport and never lays
   out.** `getBoundingClientRect`, `innerText` and every visibility check return empty, so
   the agent silently reads a blank page. Views are mounted immediately and merely hidden.

4. **Reset per-page logs on `did-start-loading`, not `did-navigate`.** `did-navigate` fires
   *after* the main document response, so resetting there wipes the very request you need
   when a page fails to load.

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
    the drag to the application instead; **Shift**-drag is the bypass. A right-click is also
    forwarded, which is why the CLI used to paste on right-click — `TerminalView` now takes
    that event in the capture phase before xterm sees it.

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

## Verification expectations

`npm run check` must pass. For anything touching the context meter, `npm run verify:context`
runs against the real transcripts on this machine — it has caught two genuine bugs.

For UI work, launch with `--remote-debugging-port` and drive it over CDP; screenshots are the
only reliable way to confirm the terminal and the panels actually render.

**macOS is unverified.** No Mac was available while building. The mac-specific paths are the
`hiddenInset` title bar and traffic-light padding, the login-shell PATH probe in `cli.ts`,
and the Cmd-based shortcuts. See `.claude/commands/mac-release.md`.
