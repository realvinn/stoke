# HANDOFF — Stoke

Repo: `G:\Code\personal\Stoke` · `github.com/realvinn/stoke` (public) · branch `main` · v0.2.0 shipped

## Task

Original request (voice, verbatim):

> Can you help me create somewhat of a, like, terminal, but, like, a a wrapper or a skin for
> Claude code? [...] I wanted to make it look nice [...] be easy for me to navigate through
> projects [...] immediately into Claude code, and I can easily access bypass permissions. I can
> easily see all the context windows [...] Maybe even have, like, a built in browser for Claude to
> use [...] also if possible, make it also on Mac. [...] I kind of like it simplistic. Something
> like... it's like simplistic, but also with detail [...] I don't want it to just be just simple
> black boxes from ShadCN or some random library. I want it to be a bit bespoke [...] accents of
> light orange [...] I just use a basucx CSS for theming, kinda Discord.

Later, verbatim: *"we also need to figure out how to make that Chrome harness better [...] make
Chrome more efficient and actually effective for Claude Code [...] especially something really good
for understanding design elements. Also [...] how we can make websites better, faster, and make
sure the tech stack and also have, like, a tool or something to check all for security."*

Standing constraint: **macOS is last** — the user runs it after moving the repo to an external drive.

## State

**SHIPPED — v0.2.0**, released at `github.com/realvinn/stoke/releases/tag/v0.2.0` with the
installer, blockmap and `latest.yml`. Feed verified fetchable anonymously, so self-update works.

- Core app: Electron 43, electron-vite, React 19, `@lydell/node-pty`, xterm 6, hand-written CSS.
- 17 browser MCP tools. The four new ones (`browser_design`, `browser_stack`, `browser_security`,
  `browser_perf`) are all CDP-based. `143b519`, `f29f37a`.
- Extractor rewritten for pages that are not articles. `dbb3754`.
- Remote access serves **past** conversations, not just live ones. `d28bc00`.
- Cloudflare: tunnel `stoke` (`3795de1d-087b-48e1-a7dc-d1259b3711a5`), `code.vinn.dev` CNAMEd to it,
  and the user's installed app already has `hostname: code.vinn.dev`, `requireAccessHeader: true`.

**NOT DONE**

1. **macOS entirely unverified.** No Mac in this environment; zero Mac code paths have ever run.
   `/mac-release` walks through it.
2. **`browser_responsive`** — sweep viewports, report horizontal overflow, clipped text, overlapping
   boxes, touch targets under 24x24. Designed, not written.
3. **Harness gaps** — `browser_wait_for` is the highest value (without it the agent polls with
   repeated reads). Then `browser_tabs`, `browser_dialog`, batch `browser_fill_form`, schema-based
   `browser_extract`, incremental snapshots.
4. **Paint metrics need a visible page.** LCP, FCP and CLS do not exist for the agent's hidden view.
   Currently reported as unavailable, which is honest but not useful; briefly showing the view
   during a measurement would fix it.

## Files

- `src/main/mcp/cdp.ts` — attach/detach CDP sessions, queued per WebContents; `DESIGN_PROPS`
  whitelist; `captureSnapshot`.
- `src/main/mcp/color.ts` — WCAG 2, APCA, OKLab. Pinned to reference values by `verify-color.mts`.
- `src/main/mcp/design.ts` — the design report.
- `src/main/mcp/stack.ts`, `audit.ts`, `perf.ts` — the other three analyses.
- `src/main/mcp/inject/extract.js` — in-page extractor. `page.ts` reads its version out of its own
  source rather than restating it.
- `src/main/browser.ts` — tabs, console/network capture with document headers.
- `src/main/remote/server.ts` — 5 routes now: sessions (GET/POST), projects, **history**,
  **transcript**.
- `src/main/sessionFile.ts` — `parseSession` (metadata), `readTranscript` (the conversation),
  `contextLimitFor`.
- `src/remote/` — phone UI, built separately to `out/remote`.
- `PLAN-HARNESS.md` — full gotcha list and phase status.

## Decisions & gotchas

Every bug this project has produced **plausible wrong output rather than an error**. A passing
typecheck has never once caught one. Run the thing and disbelieve the output.

- **CDP is available alongside DevTools.** `browser.ts` long claimed otherwise and it cost the
  entire analysis surface. Chromium allows several protocol clients per target; verified on 43.
- **`did-start-loading` fires again after load** when a client-side router prefetches, wiping the
  console and network logs. Clear on `did-start-navigation`, main-frame, cross-document only.
- **Computed colours are not `rgb()`** — Tailwind v4 reports `oklab()`/`lab()`. Resolve them by
  painting to a 1x1 canvas and reading it back rather than hand-rolling conversions.
- **`DOMSnapshot`'s `includeBlendedBackgroundColors` returns empty strings** at the right length.
- **`Profiler.startPreciseCoverage({detailed: true})` crashes the app** on a large bundle.
- **V8 coverage ranges nest**; merge the `count === 0` ones or every script reads 0% unused.
- **`CSS.stopRuleUsageTracking` reports exercised rules, not all rules.** The denominator must come
  from `CSS.getStyleSheetText`.
- **A hidden `WebContentsView` never paints**, so paint timing does not exist for it.
- **Inherited `CLAUDE_*` env vars disable transcript saving.** Stripped in `pty.ts`. Never re-add.
- **Context window is not derivable from the model id.** Observed usage is the authority.
- **PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM**, `JSON.parse` throws, and
  `getSettings()` silently falls back to defaults. Use `[System.IO.File]::WriteAllText` with
  `UTF8Encoding($false)`. This is written down and was still walked into.
- **Rejected, do not re-propose:** Claude Code's native Remote Control. The user rejected it — auth
  kept failing for them and they want a customised surface.

## Next actions

1. `browser_wait_for` in `src/main/mcp/server.ts` + `page.ts` — wait for text to appear or vanish,
   or for the network to go quiet. Highest value of anything left.
2. `browser_responsive` — resize via `Emulation.setDeviceMetricsOverride`, diff computed styles and
   box rects at each width, report overflow and clipping.
3. Make the browser view briefly visible during `browser_perf` so LCP/FCP/CLS become real.
4. On the M1: run `/mac-release`.

## How to verify

```bash
cd G:\Code\personal\Stoke
npm run check            # typecheck + context tests + build. Must pass.
npm run verify:color     # APCA/OKLab against reference values, no app needed
npm run verify:context   # context meter against real transcripts
```

The browser tools need a running app. Launch a dev instance against a **separate** user-data dir so
it does not collide with the installed app's single-instance lock:

```
node_modules\electron\dist\electron.exe . --user-data-dir=<scratch>\stoke-dev
npm run verify:extract -- <scratch>\stoke-dev\mcp-browser.json
```

That reads the MCP endpoint and bearer token the app writes on start, then drives the tools over
HTTP exactly as Claude Code does.
