# Stoke — a bespoke desktop shell for Claude Code

## Goal (user's words)

> Create a wrapper / skin for Claude Code. Make it look nice. Easy to navigate through
> projects. An app I just open and I'm immediately into Claude Code. Easily access bypass
> permissions. Easily see all the context windows and manage through all of it. Maybe a
> built-in browser for Claude to use, so it's all neat and easy in one app — sick of having
> to open this terminal, open that terminal. Make it work on Mac and Windows (Windows at
> home, Mac at work). Simplistic but with detail — bespoke, not plain black shadcn boxes.
> Accents of light orange, or a theme I can change whenever. Basic CSS theming, kinda like
> Discord.

## Decisions

| Decision | Choice | Why |
| --- | --- | --- |
| Shell | Electron 43 | `WebContentsView` gives a real embedded browser; mature Win+Mac packaging |
| Build | electron-vite 5 + Vite 7 | electron-vite peers cap at vite ^7, so vite 8 is deliberately NOT used |
| UI | React 19 + TypeScript | — |
| Styling | Hand-written CSS custom properties | No shadcn/Tailwind — user explicitly wants bespoke |
| PTY | `@lydell/node-pty` 1.2.0-beta.14 | N-API prebuilds for all 6 win/mac/linux x64+arm64 targets; **no native rebuild step** |
| Terminal | `@xterm/xterm` 6 + fit/webgl/search/weblinks | — |
| Approach | Wrap the *real* `claude` CLI in a PTY | Keeps 100% of Claude Code's features; a custom SDK chat UI would lose them |

## Verified facts about Claude Code's on-disk state (checked 2026-08-02, CLI v2.1.220)

- `~/.claude.json` → `projects` map. Keys are absolute project paths (forward-slash form).
  Per-project values include `lastSessionId`, `lastSessionFirstPrompt`, `lastSessionModified`,
  `lastCost`, `lastDuration`, `lastLinesAdded/Removed`, `lastTotalInputTokens`, ...
  **Gotcha:** this file can contain keys differing only in case (`.../refinity` and `.../Refinity`).
  `JSON.parse` handles it; PowerShell's `ConvertFrom-Json` throws. Never treat paths case-sensitively.
- `~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl` — one JSON object per line.
- Record `type` values seen: `mode`, `permission-mode`, `file-history-snapshot`, `user`,
  `assistant`, `attachment`, `last-prompt`, `ai-title`, `system`.
- `ai-title` → `{ type, aiTitle, sessionId }` — free human-readable session titles for the sidebar.
- `user` records carry `cwd`, `gitBranch`, `version`, `timestamp`, `sessionId`.
- `assistant` records carry `message.model` and `message.usage`:
  `input_tokens + cache_creation_input_tokens + cache_read_input_tokens` = **context in use**
  at that turn. `output_tokens` is separate. This is the context meter's data source.
- **No `summary` records** in current-version files — do not depend on them.

### Context window sizes — the model id is NOT enough

First implementation resolved the window from the model id and was **wrong**:
`npm run verify:context` reported 140%–320% occupancy across six large transcripts.

Investigated and ruled out: multi-iteration `usage.iterations` summing (all records had
exactly one iteration) and subagent `isSidechain` records (there were none).

The actual cause: a session on the 1M-context tier records its model as plain
`claude-opus-5`. Verified against a live session whose TUI banner read
"Opus 5 (1M context)", sitting at 269,349 tokens, where every assistant record said
`claude-opus-5` — no `[1m]` suffix, and no `context_window` field anywhere in the file.

So `contextLimitFor(model, observedTokens)` treats **observed usage as the authority**:
over 200k proves the extended tier. The id is still checked first for when a suffix is
present. Known imprecision: an extended-tier session below 200k reads against the 200k
window until it crosses over — conservative (over-states pressure, never under-states)
and can never exceed 100%.

## CLI flags the launcher drives (from `claude --help`, v2.1.220)

- `--permission-mode <acceptEdits|auto|bypassPermissions|manual|dontAsk|plan>`
- `--dangerously-skip-permissions` ← what the "Bypass" toggle actually sends
- `--model <alias|full-name>`, `--effort <low|medium|high|xhigh|max>`
- `--session-id <uuid>` ← **key trick**: we generate the UUID, so we know the JSONL path
  before the process even starts, which is what makes the live context meter possible
- `-r/--resume <id>`, `-c/--continue`, `--fork-session`, `-n/--name`, `--add-dir`, `-w/--worktree`

## Layout

```
src/main/      index.ts  pty.ts  projects.ts  context.ts  browser.ts  store.ts  cli.ts  ipc.ts
src/preload/   index.ts        (contextBridge -> window.stoke)
src/renderer/  index.html + src/{App.tsx, components/, styles/, state/}
```

## Progress

- [x] Recon: CLI flags, session JSONL schema, dependency versions
- [x] Scaffold + deps
- [x] Main: PTY manager + claude launcher
- [x] Main: project/session discovery + context meter
- [x] Renderer: titlebar, sidebar, tabs, terminal
- [x] Embedded browser
- [x] Theming
- [x] Verify: typecheck, build, run

## Verification performed (2026-08-02, on Windows 11)

| Check | Result |
| --- | --- |
| `npm run typecheck` (both projects) | clean |
| `electron-vite build` | clean, 3 bundles |
| `@lydell/node-pty` -> real `claude.exe` through ConPTY | exit 0, correct output |
| App launches, discovers projects | 32 real projects from `~/.claude.json` + history dirs |
| Start a session from the launcher | real Claude Code TUI renders in the tab |
| `npm run verify:context` | all checks pass over 6 transcripts up to 14.7MB |
| Live watcher (id -> file -> snapshot) | 516,788 / 1,000,000, 700 messages |
| Docked browser | loaded `code.claude.com/docs`, followed a 301, correct bounds |
| Theme switch to Daylight | every surface + the xterm palette swapped live |
| Renderer console | clean throughout |

### Browser integration (added later)

| Check | Result |
| --- | --- |
| MCP server over loopback HTTP, token-gated | initialize + tools/list return 13 tools |
| Real `claude` CLI against the injected config | called the tools, returned correct page content |
| Sessions launched from the app | carry `--mcp-config` on their command line |
| Packaged app, real session, Bypass mode | `Called stoke` -> "Example Domain"; meter live at 54k/200k |
| Tabs, find, bookmarks, zoom, devtools | two tabs, bookmark toggles, find drives Chromium's own search |

Three bugs found by verification, all of which produced empty output rather than errors:

1. A `WebContentsView` outside the window's view tree gets a 0x0 viewport and never lays
   out — `getBoundingClientRect`, `innerText` and every visibility check came back empty,
   so the agent silently read a blank page. Views are now mounted immediately and merely
   hidden.
2. Console/network logs were reset on `did-navigate`, which fires *after* the main document
   response — wiping the exact request the agent asks about when a page fails. Now reset on
   `did-start-loading`.
3. `waitForStable` required non-zero text to settle, so an empty page burned the full
   timeout on every call.

**Not verified: macOS.** No Mac available in this environment. The mac-specific code paths
are `frame: true` + `titleBarStyle: 'hiddenInset'` + traffic-light padding, the login-shell
PATH probe in `cli.ts`, and Cmd-based shortcuts. They are written but unexercised.

### How the UI was verified
Electron was launched with `--remote-debugging-port`, then driven over CDP to click through
real flows and capture screenshots. Note that `Page.captureScreenshot` does **not** capture
the `WebContentsView` (separate compositor surface), and one capture returned a stale frame
after a theme switch — computed styles were read directly to confirm. Also note the docked
browser appears as its own CDP page target, so scripts must match the app renderer by URL.

## Gotchas hit

- electron-vite 5 does **not** peer-accept vite 8 (`^5||^6||^7`). Pinned vite ^7.
- `@lydell/node-pty` must stay external in the main bundle and be `asarUnpack`ed by electron-builder.
- **Inherited Claude env vars silently break transcripts.** If Stoke is launched from
  inside a Claude Code session it inherits `CLAUDE_CODE_CHILD_SESSION`, `CLAUDECODE`,
  `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_PID`. The spawned session
  is then treated as a nested child and **transcript saving is disabled** — which kills both
  session resume and the context meter, since both read the transcript. `pty.ts` strips
  these. Caught by reading the CLI's own warning line in the terminal during verification.
  Auth/config vars (`ANTHROPIC_*`, `CLAUDE_CONFIG_DIR`) are deliberately preserved.
- The context window cannot be derived from the model id (see above).
- Parsing costs ~3ms/MB, so transcripts are read whole up to 32MB; head+tail sampling
  below that threshold produced badly wrong message counts (20 instead of 700).
- xterm's WebGL renderer draws into a canvas, so `.xterm-rows` is empty in the DOM.
  Verify terminal output from a screenshot, not from `textContent`.
- The `WebContentsView` paints **above** the renderer's DOM, so it must be detached while
  the command palette or settings sheet is open or it covers them.
