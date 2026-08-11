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
npm run verify:folders        # folder metadata: trimming, caps, added folders, hide/pin
npm run verify:tabs           # which tab is selected after one is closed
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
  usage.ts          plan limits from the undocumented OAuth endpoint the CLI itself calls
  browser.ts        docked Chromium: tabs, find, console/network capture
  workspace.ts      default folder + scratch folders
  workspaceRoots.ts where a session with no project starts, per platform. Takes the
                    platform and home as arguments so a suite can ask for another machine's
  store.ts          settings persistence
  settingsSchema.ts defaults + hydrate, with no electron import so a suite can run it
  updates.ts        claude CLI version/health
  selfUpdate.ts     Stoke's own updates (electron-updater)
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
  worklog.ts        the board targets the worklog can write to, and their defaults
  ui.ts             the uiScale / fontSize bounds, and the clamps both processes use
  statusLine.ts     the two plan-limit windows the usage chip draws, from the payload
scripts/          the verify-*.mts suites, make-icon.cjs
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
    `macOptionClickForcesSelection: true` (d34cf8e), so the bypass is **Option**-drag on macOS —
    the same modifier Terminal.app and iTerm2 use, and no collision with `macOptionIsMeta` two
    lines above it, which governs the keyboard while this governs the mouse. The context menu
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
    construction. CI builds are ad-hoc (`CSC_IDENTITY_AUTO_DISCOVERY: false` with no Developer ID),
    so `selfUpdate.ts` probes for it: `codesign -dv` prints `Signature=adhoc` **on stderr**, and an
    `Authority=` line for anything signed with a real certificate — including a self-signed one,
    whose requirement pins a certificate rather than a hash and therefore *can* be satisfied by the
    next build. Second, **Windows needs none of this**: `NsisUpdater` only verifies a signature when
    `publisherName` is set in the builder config, and it is not, so that check is skipped
    (`NsisUpdater.js:84-99`). Windows self-update has always worked; only macOS was broken.

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
turned up a genuine macOS bug: `usage.ts` reads the OAuth token only from
`~/.claude/.credentials.json`, but on macOS the token lives in the login Keychain instead
(`statusLine.ts:27-29`), so `window.stoke.usage.read()` fails here with "Not signed in to Claude
Code" — the statusLine payload's own `rate_limits` is the one plan-limit source that still works
on this platform, which is why the usage chip prefers it.

What that work did **not** exercise, and is still genuinely unverified: the `hiddenInset` title
bar and traffic-light padding (every screenshot taken here came from CDP's
`Page.captureScreenshot`, which paints page content, not Electron's native window chrome, and
this sandbox has neither Accessibility nor Screen Recording permission for an OS-level capture
to fall back on); the login-shell PATH probe in `cli.ts` (every launch here already inherited a
working PATH from the shell that started Electron — never the Finder/Dock case with no inherited
PATH the probe exists for); and the Cmd-based shortcuts (buttons were driven by dispatching
`.click()` on the DOM, never a real `metaKey`-modified keystroke, so `shortcuts.ts`'s Mac branch
has not actually fired). See `.claude/commands/mac-release.md` for the checklist.

**Windows carries the opposite risk now: nothing in this round of work ran there.** One change
in it is actively suspect on that platform: `statusLineCommand()` emits `"<path>" "<id>"` — two
quoted arguments on one command line — and `cmd.exe`'s own quote-stripping rule only behaves
like a POSIX shell for a single quoted pair; more than two quote characters on the line and its
rules diverge, potentially stripping the outer quotes that keep the two arguments apart. That
shim path has not been exercised since it was written. Treat it as unverified, not merely
untested, until someone runs a statusLine-driven session through `cmd.exe` and checks the
payload actually arrives.
