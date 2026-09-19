# Stoke — working notes for Claude Code

Stoke is a desktop shell for Claude Code: one window for every project, session, and the
browser, instead of a pile of terminals. It wraps the **real `claude` CLI in a PTY** rather
than reimplementing it against the SDK, so skills, MCP, plugins, hooks and the whole TUI keep
working untouched. [ARCHITECTURE.md](ARCHITECTURE.md) is how it all fits together, with the
full file map and what every verify suite covers.

This file is injected into every session and every subagent, so it holds only what applies
everywhere. Each gotcha below is one line; its full entry is in `.claude/rules/<area>.md`, which
Claude Code loads automatically when you read a file that rule is scoped to. Read the entry
before changing the code it names — that is where the measurements and the dead ends are.
A rule loads on Read only — not on Write, Grep or Glob, and after /compact not until a matching
file is read again — so Read a sibling before creating a file in an area. Entries are dated
records: line numbers drift, and a "Checked against the code" note under an entry supersedes it.
Search for the names and trust the code. `/context` lists what loaded.

## Commands

```bash
npm run dev        # electron-vite dev, live reload. Own "(dev)" userData, so it never fights
                   # an installed copy for the single-instance lock.
npm run check      # typecheck + every verify suite + full build. Run before claiming done.
npm run build      # electron-vite build + the separate remote/mobile bundle
npm run icon       # rasterise build/icon.svg -> build/icon.png
npm run art        # rasterise build/'s four installer SVGs -> the three NSIS .bmp files and
                   # the dmg background pair. Committed artefacts; regenerate deliberately
npm run dist:win   # installer -> release/Stoke-<version>-x64-setup.exe
npm run dist:mac   # dmg + zip, arm64 (the zip is what auto-update installs). MUST run on a Mac.
npm run targets    # every platform a release builds, its runner and its flags (targets.mjs)
npm run deploy:install   # the stoke.vinn.dev Worker, by hand after `npx wrangler login`.
                   # A release needs no deploy: the scripts resolve the version at run time
```

A `dist:*` exists per target and each MUST run on that target's own platform and arch
(gotcha 67): `dist:win`, `dist:win:arm64`, `dist:mac`, `dist:mac:intel`, `dist:linux`.

Every suite runs alone as `npm run verify:<name>`: context, statusline, unicode, usage,
profiles, settings, providers, claude-config, folders, search, color, theme-gen, activity,
worklog-gate, tabs, launcher, registry,
restore, shortcuts, drop, browser-url, voice, agents, campfire, cli, stoke-args, updates, targets, manifests, worklog-runner,
worklog-retry, worklog-recall, worklog-autoscan, ssh, remote, phone-ui, installer-art, install, welcome,
selection — the `check` chain — plus extract and security, which
need a live instance (`verify:security <url> <token> --access`). `verify:selection` opens a real
Electron window and needs a display; `verify:context` reads this machine's real transcripts on
purpose; CI skips both (`npm run verify:ci -- --list`). `STOKE_LIVE_USAGE=1` adds the account
call to `verify:usage`.

## Layout

```
src/main/            Electron main process
  index.ts             lifecycle, window, every IPC handler
  pty.ts, cli.ts       PTY sessions + env sanitising; locating `claude` + building its argv
  agent.ts             headless `claude -p` runner (prompt on stdin, JSON out)
  statusLine.ts        the statusLine wrapper, also run as the Stop/Notification/UserPromptSubmit
                       hook shim. The hook branch prints NOTHING: Stop output shows in the TUI and
                       UserPromptSubmit output is fed to the model
  context.ts           live context watcher; sessionFile.ts parses transcripts + the maths
  usage.ts             plan limits from the undocumented OAuth endpoint the CLI calls
  claudePaths.ts, claudeSettings.ts, claudeGlobalConfig.ts   Claude Code's own config files
  updates.ts           CLI version, channel, and the unasked-update gate
  selfUpdate.ts, codesign.ts   Stoke's own updates; whether a signature can ever take one
  browser.ts           docked Chromium: tabs, find, console/network capture
  projects.ts, projectMeta.ts, profiles.ts, workspace.ts, workspaceRoots.ts   folders, sessions
  store.ts, settingsSchema.ts   settings persistence; defaults + hydrate (no electron import)
  tabStore.ts          the tabs open at quit; restore is `--resume`, never a reattach
  activity.ts, activityGit.ts   the activity report, from transcripts + commit subjects
  ssh.ts, sshTranscript.ts      ~/.ssh/config + ssh argv; pulling a remote transcript back
  wallpaper.ts         `stoke-asset://` scheme — refuses anything but a bare name in its folder
  stt.ts               the only route to the speech sidecar ("only main may reach it" is its auth)
  audio/               reads the default capture device, to warn about virtual cables
  worklog/             Notion/ClickUp review queue: gate, watch, runner, recall, queue, autoscan
  mcp/                 browser MCP server: server.ts (tools), cdp.ts, audit/design/perf/stack,
                       inject/extract.js (runs IN the page, no deps)
  remote/              phone access: server.ts, link.ts, tunnel.ts, cloudflare.ts
src/preload/         contextBridge -> window.stoke
src/renderer/        desktop React UI (all colour via CSS custom properties)
src/remote/          mobile web UI, built separately to out/remote
src/shared/          compiled by BOTH tsconfigs, so no `node:` imports (browser-only voice.ts is
                     excluded from the node project by name). types, ipc.ts, themes,
                     ladder/themeGen/accent/notation/color, paths, drop, claudeConfig, worklog,
                     statusLine, usageView, providers, codingClis, agents, updateCheck, sshAuth, ui.ts. A new terminal or wallpaper field needs its default
                     in TERMINAL_DEFAULTS/WALLPAPER_DEFAULTS AND a line in clampTerminal/
                     clampWallpaper (all in ui.ts) in the same change: the clamps rebuild the
                     object from named keys, so a field they miss hydrates as undefined
scripts/             verify-*.mts suites, ci-verify.mjs, gen-themes.mts, cdp-eval.mjs (picks the
                     target by its window.stoke object, never by URL), mac-signing-secrets.sh
install/             the one-line installer: install.sh (macOS/Linux), install.ps1 (Windows,
                     never run on one) and index.html. Each script's whole body is inside a
                     function called on the LAST line, because a piped `sh` executes as it reads
build/bin/           the `stoke` command shipped inside the app: `stoke` (macOS sh, linked as
                     ~/.local/bin/stoke) and `stoke.cmd` (Windows). src/shared/stokeArgs.ts reads
                     what they send; only an argv carrying `--stoke-cli` is ever a request
worker/              the Cloudflare Worker at stoke.vinn.dev: route.ts decides which of the
                     three bodies a request gets (pure, so verify:install holds the matrix) and
                     index.ts serves it from install/, embedded at deploy time
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
- **Commit and push every finished feature; do not leave it in the working tree or on one
  machine.** Once a piece of work is done and `npm run check` passes, commit it and push, without
  being asked. Prefer several focused commits over one omnibus. Uncommitted work is invisible and
  losable; unpushed work is neither backed up nor reviewable, and both make "is this in the build
  I am running?" unanswerable — which has already happened here, with a released dmg and the fix
  for the bug under discussion sitting unstaged at the same time. Cutting a release (version bump,
  tag, `gh release`) stays a separate, deliberate act.
- Commit messages: explain *why*, and record any bug the change fixes.
- Never print a diagnosis the tool can disprove; quote the tool's own output instead (gotchas 46,
  52).

## Gotchas that cost real time

One line per gotcha, grouped by where you would be working. The full entry is `## N.` in the
rule file named on the group line.

**Anywhere in the main process** — `.claude/rules/main.md`
- **12.** Keep the unpackaged `(dev)` userData override skipped when `--user-data-dir` is passed —
  otherwise a test profile silently boots the wrong settings and looks fine doing it.
- **13.** Give `execFile` a `maxBuffer` well past 1 MB and pass prompts on stdin, never argv:
  `spawnSpec` runs `.cmd` installs through `cmd.exe /c`, which eats `& | ^ < >`.
- **20.** Claim the item or set the guard BEFORE the first `await` in a poll, IPC handler or
  button, and refuse re-entry — a claim after the await is the race (`AutoScanner.evaluate`,
  `refreshCliUpdate`, `relaunchTab`).
- **25.** Check an `execFile` error's `killed` before a numeric `code` (`describeExecError`): a
  timeout is `killed: true, code: null`, and `code` also holds errno and `ERR_*` strings.
- **40.** In main, test folder paths with async `access` under a deadline (as `projects.ts`'s
  `pathExists` does), never `existsSync`, and load heavy dependencies lazily, never by static
  `import` — both stall boot.
- **55.** Set `nativeTheme.themeSource` to `'system'` while following the OS — a pin makes
  `shouldUseDarkColors` and `prefers-color-scheme` echo Stoke's own theme; resolve the old theme
  before `applyNativeTheme`, and guard `nativeTheme.on('updated')` on the value moving, since
  Stoke's own writes fire it.
- **63.** Keep `store.ts`'s write coalescing (`persist` is a sync whole-file write; sliders fire
  per tick) and `flushSettings()` on quit and window `closed`; flush sheet drafts on unmount.
  Never patch on empty Interface-scale blur: `clampUiScale('')` returns 0.8, not the current
  value, so skip the patch and just clear the draft to revert the display.
- **91.** Realpath a folder (`realpathFolder`/`realpathOf`, under the 40 deadline) before it is ever
  remembered — `acceptLaunch`, both Open-folder dialogs, and `listProjects`'s scan roots and
  `projectMeta` keys — or a symlinked path (macOS's `/tmp`) and `claude`'s own resolved cwd become
  two sidebar rows for one folder.

**Terminal** — `.claude/rules/terminal.md`
- **5.** Never read the terminal from the DOM: WebGL paints a canvas, so `.xterm-rows` is empty.
  Read text from the buffer via `window.stokeTerminals`; only a screenshot proves what painted.
- **10.** Retell Shift-drags as `{ altKey: reporting && isMac, shiftKey: false }`, never off macOS
  while reporting: a kept Shift is a no-op at a shell prompt. Keep the `isButtonlessMotionReport`
  guard, or 1003 motion clears selections.
- **28.** Route every terminal link, OSC 8 too (`linkHandler`), through `openLink`'s
  `DRAG_SLOP_PX` test, as xterm fires links on mouseup with no distance or modifier check; treat a
  macOS `button 0` + `ctrlKey` as a right-click.
- **34.** Never judge `onShiftDrag`'s clone (`retold`) or the press it claimed
  (`e.defaultPrevented`) as a secondary click, and stop a mouseup only if its own press was
  stopped, or `SelectionService`'s drag listeners leak.
- **42.** Never pin Claude Code's `theme` in `--settings` (outranks `/theme`, misses SSH); on
  `auto` the CLI follows OSC 11, so set `term.options.theme` first, then send `CSI ?997;{1,2}n`
  only while mode 2031 is on.
- **79.** Give a held Space one owner per tab (`spaceOwner`): Claude Code's `/voice` on a local
  Claude tab, else Stoke's dictation, which must swallow the repeats too (`dictationKeyAction`).

**Keyboard chords** — `.claude/rules/keys.md`
- **32.** Zoom-out must stay bare Cmd/Ctrl+`-` and refuse Shift: Ctrl+Shift+`-` is Ctrl+`_`, which
  xterm sends as `C0.US` (readline's undo); zoom-in accepts Shift because `+` is Shift+`=`.
- **56.** Bind only chords xterm ignores — Meta on macOS; off it, Ctrl+Shift for letters and
  brackets (bare Ctrl+`-`/`=`/`0` are zoom's exception, 32): `matchShortcut` withholds every match
  from the pty, and the bare Ctrl+1..9 tab chords already steal Ctrl+3..8. Stepping chords read
  pending state; `zoom` still steps from `settingsRef`.

**File drop** — `.claude/rules/drop.md`
- **59.** On a file drop, take only drags carrying `Files` and `preventDefault` on `dragover`
  (else Chromium navigates to the file; `createWindow`'s `will-navigate` refusal is the backstop);
  read paths with `window.stoke.pathForFile` (`File.path` is gone) and type them via `dropText`.

**The one-line installer** — `.claude/rules/installer.md`
- **70.** Keep the installer art inside `campfire.ts`'s `ALPHABET` and generated by
  `gen-installer-art.mts` — an `'` ends a POSIX string, `@` a PowerShell here-string, and bash
  3.2 cannot parse a heredoc of unbalanced parens inside `$()`. Never the alternate screen;
  `NO_COLOR` takes the colour, not the motion.
- **76.** Electron `LOG(FATAL)`s as root on Linux before any JS runs, and `AppRun` misses it (its
  `unshare -Ur true` probe succeeds as root), so `~/.local/bin/stoke` is a wrapper that adds
  `--no-sandbox` for uid 0; the AppImage is `stoke.AppImage` beside it, version-free so
  `AppImageUpdater` — which reads only `$APPIMAGE` — still replaces it in place. Keep `--preflight`
  and `--print-wrapper`: they are how `verify:install` covers branches this machine cannot reach.
- **71.** Assert every input the installer trusts: a manifest's `sha512` is BASE64 (hex never
  matches), a bot challenge is HTML with status **200** that `curl -f` passes, PowerShell's UA
  starts `Mozilla/5.0` so `routeFor` tests it first and falls back to HTML, and an x64 AppImage
  carries no arch in its name. Never gate on `spctl`, never kill Stoke, and keep
  `--fire-frames`/`--print-plan`/`--sha512` — they are how `verify:install` runs the shipped
  script rather than a copy, under every shell: keep `setopt sh_word_split` for zsh, which
  parses the script perfectly and could not run a line of it. Put the renamed-aside
  `/Applications/Stoke.app` back whenever the new copy does not land.
- **77.** After `deploy:install`, expect the custom domain to be `enabled` with a `cert_id` while
  DNS still says NXDOMAIN — the binding and the record are written separately, and the record took
  ~30 min. Prove the gap with `curl --resolve <host>:443:<zone proxy IP>` (200 + `ssl=0` means only
  DNS is missing), then wait: delete-and-redeploy does not hurry it, and the wrangler token has no
  `dns_records` scope to fix it by hand.

**Docked browser** — `.claude/rules/browser.md`
- **3.** Mount every `WebContentsView` in the window's view tree at once and merely hide it —
  outside the tree it is 0×0 and every DOM read comes back empty.
- **4.** Clear a browser tab's `consoleLog`/`netLog` on a main-frame, cross-document
  `did-start-navigation`: `did-navigate` wipes a failed load's own request, `did-start-loading`
  refires on router prefetches.
- **6.** Pick Stoke's renderer from the CDP `page` targets by evaluating `typeof window.stoke`, as
  `scripts/cdp-eval.mjs` does, never by URL: the docked browser is a page target too and can show
  localhost or `file://`.

**statusLine and context meter** — `.claude/rules/statusline.md`
- **2.** Take the context window from the statusLine payload, not the model id (transcripts drop
  `[1m]`); put all keys in one `--settings` file, as a second discards the first; payloads are
  filed by launch `statusKey`, not session id. Keep `windowFromBanner`/`contextLimitFor` as the
  fallback — an SSH tab gets no payload.
- **26.** A `--continue` tab starts with id `''` (`ContextWatcher.watch` no-ops on it) and gets
  its real id from the registry rebind (gotcha 80) — never guess it from the folder's newest session.
- **49.** Republish from `ContextWatcher` when the stated window changes, not just the transcript
  mtime: a resumed session's payload lands seconds late and the meter would stick at 200k.
- **61.** On win32 add the leading `&` to the statusLine/hook command only when `gitBashPath()`, a
  mirror of the CLI's own locator, finds no Git Bash: PowerShell needs it, and Git Bash, which the
  CLI prefers, rejects it.
- **64.** Count `output_tokens` in `contextUsed` with input and both cache fields: the last reply
  is already in context, and understating context pressure is the dangerous direction.
- **73.** Release a session's statusLine files BY OWNER (`claimSessionFiles`/`releaseSessionFiles`,
  claimed before the write): a relaunch reuses the status key, so the outgoing PTY's late
  `proc.onExit` would delete the incoming session's `--settings` file and `claude` refuses to start.
- **80.** Follow the session a pty is on NOW via the CLI's registry (`RegistryPoller`,
  `rebindSession`): `/clear` and `/resume` move it; its files stay on the launch key (`payloadKeyFor`).
- **92.** Never registry-fall-back for a pty once matched by pid (`everMatched`); the folder fallback
  needs descent (`descendsFrom`); a phone Resume of an id with no transcript is refused (`resumeVerdict`).

**Usage chip** — `.claude/rules/usage.md`
- **21.** Treat a missing `rate_limits` or either missing window as unknown, never 0% (none arrive
  before the first API response); round `used_percentage`; convert the payload's `resets_at`
  (epoch seconds) only in `statusLine.ts`'s `reading()` — the account endpoint's is ISO
  (`usage.ts` `stamp`).
- **36.** Pick the usage token by expiry across file and Keychain, `sk-ant-oat` first, skipping
  `mcpOAuth`; only the CLI may refresh it. Keep good figures through a failure or limit-less
  payload (`keepLastGood`, `keepUsage`).
- **45.** Let `mergeUsageWindows` take figures from the newer of payload and account (ties to
  payload), as an ended session's payload goes stale; mark a message by per-session `prompt_id`,
  not mtime, and never let it skip the backoff.

**Finding and running `claude`** — `.claude/rules/cli.md`
- **1.** Keep `STRIP_ENV`'s two copies (`pty.ts`, `agent.ts`) identical: they strip Claude's
  session markers plus Electron/Node runtime vars, never auth/config — an inherited `CLAUDECODE`
  etc. makes `claude` a nested child with no transcript, so no resume or meter.
- **41.** Parse `claude -p` JSON as an object or a message array, taking the element whose `type`
  is `"result"` (`parseEnvelope`): the CLI prints the array despite its help text, and a bad parse
  hides the real error.
- **46.** Fetch the dist-tag of the CLI's own `autoUpdatesChannel` (`channelFrom`), not a
  hardcoded `latest`: `claude update` follows it. A lagging pin goes in `behindLatest`, never
  `info.latest`, and is never switched unasked.
- **52.** Keep `shimDirs()` (mise/asdf/fnm) ahead of the system dirs in `extraSearchDirs()`, keep
  `-i` in the probe's `-ilc`, and let a failed probe stand only `PROBE_RETRY_MS`: a Finder
  launch's PATH has no version-manager dir.
- **81.** Let main pick `--resume` vs `--session-id` against the disk (`resumeOrMint`) right before
  the spawn: `--resume` on an id with no transcript exits 1, `--session-id` on one with a transcript is refused.
- **84.** Keep an exited pty in `PtyManager`'s map for `ENDED_RETENTION_MS` (the phone lists it as
  ended); only an explicit close (`kill`/`stop`) deletes at once.

**Worklog** — `.claude/rules/worklog.md`
- **15.** Keep the worklog scan `--safe-mode` and read boards in `recall.ts`'s own run: safe mode
  turns every MCP server off, so no single run can be hermetic and read a connector.
- **16.** Ask each board for its own statuses (`clickup_get_list`, `notion-fetch`), not just its
  tasks: no open task carries a closed status. Write only a status recall returned
  (`canonicalStatus`).
- **17.** Keep the worklog `create` dedupe key a pure function of `(sessionId, title)`: `add()`
  recomputes every stored proposal's keys (`seen`, `refused`), so rejections come back if the key
  gains a field a stored proposal and a new draft can differ on. Update keys also carry the target
  status (30).
- **30.** Keep `formatRecall` cutting whole lines per board and never the status header,
  `newStatus` in the update dedupe key, and `notion-fetch` in both recall and Notion-update
  allowlists — or no task ever gets closed.

**SSH tabs** — `.claude/rules/ssh.md`
- **18.** Never resolve a project or folder from an SSH session's cwd: `SessionInfo.cwd` is the
  local folder, a tab's `cwd` the host alias. Gate by host (`SshHost.worklog`, `hostId`); read the
  real cwd from the fetched transcript.
- **19.** Never add flags like `--session-id` to an SSH host's remote command: an older remote
  `claude` exits on it and breaks every connection. Fetch the newest transcript instead.
- **29.** Keep `-e none` before the destination in `buildSshArgs` or a `~` after a pasted newline
  is an ssh escape (`~.` hangs up); honour OSC 52 writes but refuse the `?` read, or any printed
  text can read the clipboard.
- **75.** Detect an ssh password prompt by the TAIL — a prompt has no trailing newline, so a server
  banner can never be one — plus `opts.host`, an escape byte closing the window, and fire-once
  (`sshAuthStep`). The parsed `user@host` is display-only; enroll against `SshHost.alias`, and only
  a `BatchMode` probe may set `keyEnrolled`.

**Phone access** — `.claude/rules/phone.md`
- **53.** Draw no QR for `connectTarget`'s `loopback` reach, mint the key only in start paths
  (`ensureRemoteToken`, never on a read), push `settingsChanged` after every remote write, and
  restart a running server when a bound field moves.
- **58.** Judge `cloudflared` by payload, not exit code or stderr: `tunnel list` exits 0 printing
  `null` for none, stderr warns every run, `create`'s `already exists` is success. Check
  `cert.pem` first; a failed lookup is `unknown`.
- **85.** Send a phone's text and its `\r` as separate pty writes (`PtyManager.submit`): in one
  chunk the `\r` lands as a newline in Claude Code's box. Its bracketed-paste half is wrong (86).
- **86.** Type a phone message to Claude Code, never bracket it (`submitFrames`): a paste — or one
  write past ~1 KB — is filed as `<pasted_content>` the model will not act on. Newlines are `ESC CR`.
- **87.** Pad the phone terminal's box, not xterm's parent, and let only `decideResize` resize the
  pty: Fit to phone only, on a width change only, never while the composer has focus.

**Claude Code's own config** — `.claude/rules/claude-config.md`
- **37.** Turn Claude Code's Remote Control off with `remoteControlAtStartup: false` in
  `~/.claude/settings.json`: `/remote-control` disconnect is in-memory only, and unset defers to a
  server flag.
- **38.** Write `~/.claude.json` only via `claudeGlobalConfig.ts` at `claudeGlobalConfigPath`:
  refuse an unparseable or signed-out file, never create it, take the `.lock` dir, verify, retry —
  a bad parse makes the CLI reset it.
- **39.** Write `workflowSizeGuideline` only to `~/.claude.json` (in `settings.json` it hides
  `/config`'s row); never offer `effortLevel: max` (silently dropped); every key Stoke's
  `--settings` file overrides goes on `NEVER_OFFERED`.
- **89.** Resolve a launch label through `modelSettings.<id>.effortLevel` before the top-level
  `effortLevel`, and user < project < local (`resolveLaunch`): the chip said High, the CLI ran medium.
- **66.** Serialise an awaiting read-modify-write (`patchClaudeSetting`'s promise chain) and claim
  a guard before the first `await` (`claimStart`, `cliRefreshing`): a second press drops a key,
  appends a tab or reruns `claude update`.

**Palette and accents** — `.claude/rules/theme.md`
- **43.** Never hand-edit a hex in `themes.ts`: edit the `seed` and paste the FIRST literal `node
  scripts/gen-themes.mts <id>` prints (lantern/graphite/lagoon/rose/ink/mist also print a stale
  one from `NEW_SEEDS`). A new `Theme`/seed field goes into `validateTheme`/`validateSeed` in the
  same change — they drop keys they do not name.
- **44.** Paint accent text, strokes, outlines and 1px borders with `--accent-ink`, keeping
  `--accent` for fills — profile accents fall as low as 1.43:1 on a light page; `deriveAccent`
  solves the ink to 4.5:1 and Lc 60 there.
- **65.** Hold `--accent-contrast` to Lc 60 on `--accent-hover` too — the primary button keeps one
  label over both fills; fix a failing hover in `hoverFor`, never by shrinking `HOVER_STEP`, and
  keep it visibly different from the fill.

**CSS and layout** — `.claude/rules/css.md`
- **11.** Cancel a container's padding for one `align-self: center` child by negating the full
  padding, not half — `align-self` centres the margin box, so half lands a pixel off.
- **14.** Never overlay the docked browser (its `WebContentsView` paints over all DOM): a panel
  that must stay visible is a `.body-row` column; a full-width strip goes inside `.main-col`,
  never a fourth `.app` row. Keep `.app`'s `grid-template-columns: minmax(0, 1fr)`, or nowrap flex
  text widens the whole shell.
- **22.** Rename a CSS token rather than renumber it in place, then grep the old name to zero
  across `src/`, `.tsx` `style={{ }}` objects included — a missed use then collapses visibly
  instead of silently changing size.
- **23.** Size anything that clears the macOS traffic lights in px, never rem
  (`--traffic-lights-w`) — the lights ignore Interface scale, so a rem clearance is right only at
  scale 1.0.
- **33.** Draw anything that must line up with SVG art inside that same `<svg>` (see
  `ContextMeter`'s `WATCH_R`), never as an overlaid DOM box — Blink snaps DOM boxes to whole
  pixels but not SVG geometry.
- **47.** Declare `border` and `background` on every styled `<button>`, or Chromium's grey
  `buttonface` shows; never share a `translate` keyframe between self-centred and other elements;
  a scrolling dialog track needs `min-height: 0`.
- **54.** Under a wallpaper, make containers fully transparent and give one surface per spot
  `--panel-alpha` (stacked alphas compound to opaque). In index.ts keep
  `registerSchemesAsPrivileged` at module scope and `protocol.handle` inside `whenReady`. Probe
  `stoke-asset://` with `new Image()` — CSP blocks `fetch`.
- **60.** Centre inside a scroll container with `margin: auto` on the child, not `justify-content:
  center` — once content outgrows the box, centring pushes its top above `scrollTop: 0`,
  unreachable.
- **72.** Give every new animation a deliberate reduced-motion answer: the global block forces
  `1ms`/one iteration, so the resting style is what paints, and anything resting at `opacity: 0`
  (`.campfire-spark`) vanishes rather than stills. Prove it with
  `--force-prefers-reduced-motion` and a screenshot.

**React state** — `.claude/rules/renderer.md`
- **31.** `npm run check` cannot see a side effect inside a closure, or the wire from real input
  to a pure function (41, 46 and 48 are the same shape): prove those over CDP against the built
  app. A `useEffect` window listener reads `settings` via `settingsRef`, not its deps.
- **35.** Rely on the synchronous `writeTabState` on every `tabs:save` push for tab restore —
  `before-quit` is only a retry, and on macOS closing the last window never fires it.
- **48.** Read a session's version from the registry, else its payload `cliVersion`, never a launch
  stamp; compare to `CliInfo.version` only through `versionNumber`; never offer relaunch on SSH.
- **51.** Guard slow kill-and-restart actions with a ref claimed before the irreversible step plus
  a busy state released in `.finally` — a second click makes `replaceOrAppend` append a duplicate
  `claude`.
- **57.** Give every value exactly one writer — derive the launcher's
  `mode`/`model`/`effort`/`ultracode` from `settings.defaults`, never a `useState` copy, or the
  other writer leaves it stale until restart.
- **82.** Never kill a busy session unasked (`requestRelaunch` → BusyDialog; `busy`/`shell`/`waiting`
  are busy), and never auto-relaunch on `idle` alone: a draft leaves it idle (`typedSinceSubmit`).
- **83.** Veto `startOnLaunch` on whether the restore HAD sessions (`restoredSessions`), not on how
  many are still paused — the update-restart resume empties that count before `cli` answers.
- **93.** After the first run, let Enter press the launcher only after a click or a non-activation key
  (`launcherPressAllowed`, `isDeliberateInput`): no tapping cadence is distinguishable from intent.
- **88.** Make the shell `inert` (in a LAYOUT effect) while any overlay, the splash or a pending
  first-run picker is up (`firstRunPending`): an Enter for the splash started `claude` behind it.
- **90.** Route every tab-close path (Cmd+W, ×, TitleBar) through `requestCloseTab`, which asks via
  `BusyDialog` on the same busy/shell/waiting reading (82) `closeTab` itself never checked; a
  no-reading tab (a non-Claude CLI) still closes at once, and window-quit's own kill is unguarded.

**Packaging and signing** — `.claude/rules/release.md`
- **7.** Pick architectures with the `--x64`/`--arm64` CLI flags and never add an `arch:` list to
  `electron-builder.yml` — it overrides the flag, so `dist:win --x64` builds all three.
- **8.** Rewrite files from PowerShell 5.1 with `[System.IO.File]::WriteAllText` +
  `UTF8Encoding($false)` and `settings.json` with node, never `Set-Content -Encoding utf8` — its
  BOM silently breaks the parse.
- **24.** Keep `zip` in `mac.target` and sign with the trusted `Stoke` certificate
  (`RELEASE_IDENTITY`): `MacUpdater` rejects a dmg-only feed and Squirrel an ad-hoc or
  foreign-signed swap. CI `add-trusted-cert`s the .p12 and leaves `CSC_LINK` unset (set, it
  silently ships unsigned). Rename `Stoke` in all five places at once.
- **67.** Build one arch per job on a NATIVE runner and keep the list only in
  `scripts/targets.mjs` (the workflow and every `dist:*` read it): npm installs just the host's
  `@lydell/node-pty-<platform>-<arch>`, so a cross-arch or `--universal` build ships a terminal
  that throws MODULE_NOT_FOUND with no build error. `assert-packaged-pty.mjs` is what catches it.
- **68.** Merge the per-job `latest*.yml` with `merge-update-manifests.mjs` and never
  `merge-multiple: true`: only Linux gets an arch suffix, so two Windows or two macOS jobs both
  write one name and the flatten drops an arch silently. The publish gate
  (`check-release-assets.mjs`) derives what each feed must list from the same target list.
- **69.** Regenerate installer art with `npm run art` and commit `build/installer-art.json` with
  it — the hashes are what catch an SVG edited without regenerating, which nothing else can see.
  Never hand-write a `.bmp`: NSIS shows only the 40-byte-header BMP3 the encoder emits,
  electron-builder validates none of it, and an UNSET image key hides a missing file. Keep
  `dmg.background` without `dmg.window`, and keep the art clear of `dmg.contents`' icon boxes
  (measured: 80px, centred 130,220 and 410,220).

**Verify suites** — `.claude/rules/suites.md`
- **9.** Never stub IPC by assigning over `window.stoke` methods in a test — contextBridge freezes
  it, the assignment silently does nothing, and the test is really exercising production.
- **27.** Keep `node:` imports out of `src/shared/**` (the web project has no Node types) and
  browser-only APIs out unless the file is excluded by name from `tsconfig.node.json`, as
  `voice.ts` is. `scripts/` is in neither project, so suites are never typechecked.
- **50.** Keep a verify suite's tally and `process.exitCode` as the file's last statement —
  `exitCode` is set once, so any assertion after it can print FAIL and still exit 0.
- **62.** End every verify suite by setting `process.exitCode` from its failures, and add suites
  only to the `check` chain — `scripts/ci-verify.mjs` derives CI from it; a hand-kept second list
  drifts.
- **74.** Fake every input or none: a suite that hands a function a synthetic clock must hand it
  synthetic paths too (`sweepStaleSessionFiles(now, dir)`), and must assert a bystander survives —
  a fixed clock over the real shared directory deletes every running Stoke's live files, greenly.
- **78.** Import into a suite-loaded module only from `src/shared`, by relative path with the
  `.ts` extension — strip-types resolves no aliases, so an `@shared/...` specifier passes
  typecheck AND build and dies only when the suite runs.

## Standing traps when driving the app

- **Never force-kill Stoke.** It orphans the CLI children — the PTYs die, the `claude` processes
  do not — and the restarted app cannot reattach to them. Quit properly so `before-quit` runs
  `ptys.killAll()`.
- **Electron under ESM starts from `app.whenReady().then(main)`**, never a top-level `await`
  (`scripts/make-icon.cjs` is the shape to copy).
- **A script that destroys windows in a loop quits the app** (default `window-all-closed`), exits
  0, and looks finished. Register `app.on('window-all-closed', () => {})` to keep going.
- **`app.exit()` does not flush a piped stdout** — write the result to a file and read that back.
- **Nested backticks inside a template literal end it early**, as a SyntaxError that points at the
  wrong place. Build anything injected into a page from an array of lines.
- **A `.settings.json` missing from `$TMPDIR/stoke/statusline/` has two causes, both found and
  both fixed**: gotcha 73 (a relaunch's outgoing PTY deleting the incoming session's file) and
  gotcha 74 (`npm run check` sweeping the real shared directory with a 2033 clock, which wiped
  every running Stoke). This entry used to call it harmless and unexplained and tell you not to
  investigate. The surviving payload beside it was the clue, not the alibi: the wrapper rewrites
  that file three times a second, so only the write-once files stay missing.
- **The usage endpoint is undocumented** (`usage.ts`): tolerate missing fields and report
  unavailable — a wrong number in a status bar is worse than a blank one.
- **A `Page.captureScreenshot` with a `clip` ends any pointer drag in progress**: DevTools
  emulates the viewport for it, and Chromium delivers a trusted `lostpointercapture` plus a
  buttons-0 move, which lands the drag. Screenshot mid-drag without `clip`, and crop afterwards.
- **`Page.captureScreenshot` hangs while the window is hidden behind others** — launch with
  `--disable-backgrounding-occluded-windows` for any run that screenshots.
- **Resuming a real session to test something touches its transcript**: on exit the CLI appends
  `last-prompt`/`cost-state` records even with nothing typed, so the chat re-sorts as recent. Use
  a throwaway session, or a fake `claudePath` under a separate `--user-data-dir`.

## Verification

- `npm run check` must pass, build included. `verify:context` is machine-dependent on purpose (it
  reads real transcripts, has caught two genuine bugs, and CI skips it); anything else that only
  passes on one machine is a defect in the suite, not a fact about the machine.
- For UI work, launch with `--remote-debugging-port` and drive it over CDP
  (`scripts/cdp-eval.mjs`); screenshots are the only reliable proof that the terminal and panels
  render (gotchas 5, 6).
- A suite that asserts a known bug as expected turns the regression into a green run (gotchas
  10, 61): fix the assertion in the same change as the bug.
- Still unverified: macOS native chrome (the `hiddenInset` traffic-light padding's full-screen
  signal from main), the login-shell probe *succeeding* from a Finder/Dock launch (gotcha 52
  measured that launch's PATH and the failure path), real OS keystrokes for the shortcuts — and
  **no recent round of work has run on Windows**: treat the statusLine/hook shim there as
  unverified, with and without Git for Windows (gotcha 61). What has and has not
  been proven, per platform: `.claude/rules/driving.md`.

## Recording a new gotcha

1. **Number:** one more than the highest `## N.` in `.claude/rules/`
   (`grep -h '^## [0-9]' .claude/rules/*.md | sort -t' ' -k2 -n | tail -1`). Numbers are
   permanent; code cites them as "gotcha N", never by rule file, because entries can move.
2. **Full entry** as `## N. <title>` in the rule file whose `paths:` already matches the file
   you would be editing when it bites. If none does, add that file to `paths:` in the same
   commit — an entry no path reaches is never loaded.
3. **One index line** in the matching group above: an imperative that names the function to
   search for, at most two wrapped lines. A lesson that applies wherever you are goes under
   "Anywhere in the main process", Conventions or Verification, not in an area group.
4. **Corrections** go in the rule file — in place, or as a dated `> **Checked against the code on
   <date>**` note under the entry — never here. Touch the index line only if the rule changed.
5. **A new file** is described in ARCHITECTURE.md's File map; add a Layout line here only for a
   new directory or a file every session needs. Never paste a long-form entry into this file —
   every session and every subagent pays for it.
