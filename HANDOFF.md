# HANDOFF — Stoke

Repo: `G:\Code\personal\Stoke` · branch `main` · 9 commits · working tree clean · **no git remote**

## Task

Original request (voice, verbatim):

> Can you help me create somewhat of a, like, terminal, but, like, a a wrapper or a skin for
> Claude code? Like, I wanted to make it look nice. I wanted to, like, make... be easy for me
> to navigate through projects. Maybe it's an app I just open up, and then, essentially, I can
> just immediately be an open... immediately into Claude code, and I can easily access bypass
> permissions. I can easily see all the context windows and stuff and then manage through all
> of it. Maybe even have, like, a built in browser for Claude to use just so it's all neat and
> easy to all in one app because I'm kind of sick and tired of where I have to kinda use this
> terminal, open up this terminal, also if possible, make it also on Mac. Because right now, I
> am on Windows, but I mainly also use my Mac at work. [...] I kind of like it simplistic.
> Something like... it's like simplistic, but also with detail [...] I don't want it to just be
> just simple black boxes from ShadCN or some random library. I want it to be a bit bespoke in
> the sense that it has, like, accents of light orange or even a confusion theme whenever I
> want to. I just use a basucx CSS for theming, kinda Discord.

Follow-up asks in order: own git repo + rename (chose **Stoke**); make it a real installable app
+ how to run on M1 and Windows; "just open stoke"; no-project/scratch sessions defaulting to
`G:/Code`; browser integration + custom Chromium + read pages better (chose **everything, in
order**, **shared session**); update Claude + phone access at `code.vinn.dev` with Cloudflare
Access (user **rejected** native Remote Control — "keeps failing auth and too minor, I want more
customised access"); close Ctrl+F, self-update, Mac prompt file, project documentation.

## State

**DONE** (all verified by execution, not inspection):

- Core app — Electron 43 + electron-vite + React 19 + TS, `@lydell/node-pty`, xterm 6, hand-written
  CSS custom properties. `226a114`, renamed `b58f5a5`.
- Packaged + installed — icon from `build/icon.svg`, NSIS installer, installed to
  `%LOCALAPPDATA%\Programs\Stoke`, Start Menu + desktop shortcuts. `c971b84`.
- Quick start / scratch sessions, default folder resolves to `G:\Code`. `605ed97`.
- Browser MCP integration — 13 tools, `--mcp-config` injected at spawn. Verified: real CLI in the
  packaged app printed `Called stoke` → "Example Domain". `0139f9a`.
- Browser as a browser — tabs, find, bookmarks, zoom, devtools, Ask Claude. `883ae40`.
- Remote access — loopback HTTP+WS, mobile UI, cloudflared supervision. Verified: 401 without key,
  33 projects served, session started via API, WS attach replayed 1019 chars incl. CLI banner,
  live output flowed. `6fb0a12`.
- CLI update check on launch + status-bar pill; `claude doctor` surfaced a stale npm-global install
  which the user removed (doctor now reports "No installation issues found"). `6fb0a12`.
- Ctrl/Cmd+F, Stoke self-update, `CLAUDE.md`, `ARCHITECTURE.md`, `/mac-release`. `b24f219`.

**NOT STARTED** — the four gaps, in the order recommended:

1. Extractor quality. Tested against real pages at the very end of the session (previously only
   `example.com`). Wikipedia: excellent. **code.claude.com/docs: nav chrome leaks in** — stray
   lines "Copy page", "iOS", "Android", "Claude Code admin settings". **news.ycombinator.com:
   table-layout site renders as crammed markdown table rows**, usable but poor.
2. `code.vinn.dev` is **not live**. No `stoke` tunnel exists in the Cloudflare account (checked
   with `cloudflared tunnel list`). User is already logged in (cert.pem present, 8 other tunnels).
3. macOS **completely unverified** — no Mac in this environment. Zero Mac code paths ever executed.
4. Self-update inert — queries `github.com/realvinn/stoke`, which does not exist. No git remote.

## Files

69 files. The ones that matter:

- `src/main/pty.ts` — PTY sessions; strips inherited `CLAUDE_*` env vars; scrollback ring buffer +
  subscriber fan-out for remote clients; tracks cols/rows.
- `src/main/cli.ts` — locates `claude`, login-shell PATH probe for macOS, `buildArgs`.
- `src/main/sessionFile.ts` — transcript parsing; `contextLimitFor(model, observedTokens)`.
- `src/main/context.ts` — polling context watcher; keeps `latest` per session for remote clients.
- `src/main/projects.ts` — project/session discovery from `~/.claude.json` + `~/.claude/projects`.
- `src/main/browser.ts` — tabbed WebContentsViews, persistent partition, console/network capture,
  `before-input-event` Ctrl+F interception.
- `src/main/mcp/{server,page}.ts`, `src/main/mcp/inject/extract.js` — MCP server, page agent, and the
  dependency-free in-page extractor. **`extract.js` is where gap 1 lives.**
- `src/main/remote/{server,tunnel}.ts` — phone access and cloudflared supervision.
- `src/main/{updates,selfUpdate}.ts` — CLI updates and Stoke's own.
- `src/remote/` — mobile web UI, built separately by `vite.remote.config.ts` to `out/remote`.
- `src/renderer/src/` — desktop UI. `styles/app.css` is the whole design system.
- `CLAUDE.md`, `ARCHITECTURE.md`, `README.md`, `BUILDING.md`, `PLAN.md`,
  `.claude/commands/mac-release.md`.

## Decisions & gotchas

Full list in `CLAUDE.md` "Gotchas that cost real time". The ones that will bite hardest:

- **Inherited `CLAUDE_*` env vars disable transcript saving** in spawned sessions, silently killing
  session resume and the context meter. Stripped in `pty.ts`. Never re-add them.
- **Context window is NOT derivable from the model id.** A 1M session records `claude-opus-5` with no
  suffix and no `context_window` field. Observed usage is the authority. First implementation
  reported 140–320% occupancy; `npm run verify:context` exists because of it.
- **A `WebContentsView` outside the window's view tree gets a 0×0 viewport and never lays out** —
  every read returns empty, not an error. Views are mounted and merely hidden.
- **Reset page logs on `did-start-loading`, not `did-navigate`** (the latter fires after the main
  document response, wiping the request you need).
- xterm WebGL draws to canvas — `.xterm-rows` is empty; verify from screenshots.
- The docked browser is its own CDP target; filter test scripts by URL.
- electron-builder: an explicit `arch:` list overrides the CLI flag.
- PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM — use `[System.IO.File]::WriteAllText`
  with `UTF8Encoding($false)`.
- Git commit messages with embedded double quotes break the PowerShell here-string; write the
  message to a file and use `git commit -F`.
- **Rejected approach, do not re-propose:** Claude Code's native Remote Control. It does exactly
  what `code.vinn.dev` does with no exposed ports, but the user rejected it — auth keeps failing
  for them and they want a customised surface.

## Next actions

1. **Fix the extractor** in `src/main/mcp/inject/extract.js`. Two concrete failures:
   (a) nav chrome leaking on `https://code.claude.com/docs/en/remote-control`;
   (b) table-layout sites (`https://news.ycombinator.com`) rendering as crammed table rows.
   For (a) tighten `mainContent()`/`STRIP` and skip link-only leaf blocks. For (b) detect
   layout tables (no `<th>`, cells containing block content) and walk them as content instead
   of emitting markdown tables. Re-test with the loop in "How to verify".
2. **Push to GitHub** — `git remote add origin git@github-personal:realvinn/stoke.git` then
   `git push -u origin main`. Repo must exist first. This unblocks self-update and the Mac.
3. **Publish a release** so `electron-updater` has a feed: `npm run dist:win`, then create a GitHub
   release attaching `release/Stoke-0.1.0-x64-setup.exe` **and `latest.yml`**.
4. **Tell the user the two tunnel commands** (they must run them; it modifies their Cloudflare
   account): `cloudflared tunnel create stoke` and
   `cloudflared tunnel route dns stoke code.vinn.dev`, then Settings → Remote access → hostname →
   Turn on → Run named tunnel → add an Access policy → enable "Require Cloudflare Access".
5. **Mac**: on the M1, run `/mac-release`.
6. Optional: tests for the extractor and remote server using the real pages above as fixtures.

## How to verify

```bash
cd G:\Code\personal\Stoke
npm run check          # typecheck + context tests + full build. Must pass.
npm run verify:context # context meter against real transcripts on this machine
```

UI and integration work is verified by driving the running app over CDP — `npm run build`, launch
`node_modules\.bin\electron.cmd . --remote-debugging-port=9222`, then attach and screenshot.
Working scripts from this session are in the scratchpad at
`C:\Users\THEVIN~1\AppData\Local\Temp\claude\G--Code-personal-Claude\7073ea50-c134-478e-ad79-e2d3e20c8c78\scratchpad\`
(`realpages.mjs` reproduces the extractor failures, `remotetest.mjs` the remote server,
`mcpclient.mjs` the MCP tools, `finddiag.mjs` Ctrl+F).

Every bug found this session produced **empty or wrong output rather than an error** — a passing
typecheck proves nothing about this class. Run the app.
