# Stoke — working notes for Claude Code

Stoke is a desktop shell for Claude Code: one window for every project, session, and the
browser, instead of a pile of terminals. It wraps the **real `claude` CLI in a PTY** rather
than reimplementing it against the SDK, so skills, MCP, plugins, hooks and the whole TUI keep
working untouched.

Read [ARCHITECTURE.md](ARCHITECTURE.md) for how it all fits together. This file is the short
version plus the things that will waste your time if you rediscover them the hard way.

## Commands

```bash
npm run dev             # electron-vite dev, live reload
npm run check           # typecheck + context tests + full build. Run before claiming done.
npm run build           # electron-vite build + the separate remote/mobile bundle
npm run verify:context  # runs the context meter against real transcripts on this machine
npm run icon            # rasterise build/icon.svg -> build/icon.png
npm run dist:win        # installer -> release/Stoke-0.1.0-x64-setup.exe
npm run dist:mac        # dmg (arm64). MUST run on a Mac.
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
  updates.ts        claude CLI version/health
  selfUpdate.ts     Stoke's own updates (electron-updater)
  mcp/              MCP server exposing the browser to Claude
    server.ts         HTTP transport + the 13 tool definitions
    page.ts           drives the page through the injected extractor
    inject/extract.js runs IN the page; markdown + refs + find. No deps.
  remote/           phone access
    server.ts         loopback HTTP + WebSocket, token auth
    tunnel.ts         supervises cloudflared
src/preload/      contextBridge -> window.stoke
src/renderer/     desktop React UI (all colour via CSS custom properties)
src/remote/       mobile web UI, built separately to out/remote
src/shared/       types, IPC channel names, themes
scripts/          verify-context.mts, make-icon.cjs
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
   is no `context_window` field. `contextLimitFor(model, observedTokens)` treats observed
   usage as the authority: over 200k proves the extended tier.

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

## Verification expectations

`npm run check` must pass. For anything touching the context meter, `npm run verify:context`
runs against the real transcripts on this machine — it has caught two genuine bugs.

For UI work, launch with `--remote-debugging-port` and drive it over CDP; screenshots are the
only reliable way to confirm the terminal and the panels actually render.

**macOS is unverified.** No Mac was available while building. The mac-specific paths are the
`hiddenInset` title bar and traffic-light padding, the login-shell PATH probe in `cli.ts`,
and the Cmd-based shortcuts. See `.claude/commands/mac-release.md`.
