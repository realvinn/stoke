# PLAN — Browser harness v2

The goal in the user's own words:

> we also need to figure out how to make that Chrome harness better and any other harness things
> we need to do to make Chrome more efficient and actually effective for Claude Code [...] we just
> need to make sure this Chromium that we're building is specifically for Claude Code and especially
> something really good for understanding design elements. Also [...] we need to figure out and find
> out a way how we can make websites better, faster, and make sure the tech stack and also have,
> like, a tool or something to check all for security or, like, anything, really.

Ordering constraint from the same message: **macOS is last** — the user will run it after moving
the repo to an external drive.

## Where this started

13 MCP tools, all built on one dependency-free in-page script (`src/main/mcp/inject/extract.js`)
executed with `webContents.executeJavaScript`. **No CDP anywhere in the codebase.** `browser.ts`
avoids it deliberately: a comment there states only one debugger client may attach at a time and the
slot must stay free for DevTools.

That comment is the single most important thing to verify, because almost every capability below
wants CDP.

## Phases

- [x] **0. CDP feasibility. SETTLED — the comment in `browser.ts` was wrong.** Chromium supports
      multiple CDP clients per target, so `webContents.debugger` and DevTools coexist. Probed against
      a real page (Wikipedia, CSS article) with Electron 43:

      | Test | Result |
      |---|---|
      | `debugger.attach('1.3')`, no DevTools | OK |
      | `DOMSnapshot.captureSnapshot`, 20-property whitelist | 2281 KB, 12949 nodes, 204 ms |
      | `Accessibility.getFullAXTree` | 13374 nodes, 4809 KB |
      | `CSS.getMediaQueries` | 107 media rules |
      | `Network.getAllCookies` | 7 cookies |
      | Any command **with DevTools open** | OK |
      | Fresh `attach()` **while DevTools open** | OK |

      Consequences: CDP is available unconditionally, no mutex against DevTools is needed, and the
      payloads confirm the architecture — analysis runs in the main process and only the digest
      reaches Claude. A 2.3 MB snapshot must never be serialised toward the model.
- [ ] **1. Extractor quality.** The known-broken thing from HANDOFF.md. Nav chrome leaks on docs
      sites; layout tables render as crammed markdown rows. Add shadow-DOM piercing and iframe
      handling while in there.
- [ ] **2. `browser_design`.** Type scale, colour palette with usage frequency, spacing scale and its
      drift, radii, shadows, z-layers, grid/layout, breakpoints actually hit. Contrast under both
      WCAG 2 and APCA.
- [ ] **3. `browser_responsive`.** Resize through breakpoints; report horizontal overflow, clipped
      text, overlapping boxes, touch targets under 24x24.
- [ ] **4. `browser_perf`.** Trace-derived insights, coverage (unused CSS/JS bytes), image sizing,
      font-display, DOM size, long tasks, third-party cost.
- [ ] **5. `browser_stack`.** Framework/library detection from runtime globals plus header, meta and
      script-URL signatures.
- [ ] **6. `browser_security`.** Passive only: headers, CSP grading, cookies, mixed content, cert,
      SRI, third-party inventory, exposed source maps, known-vulnerable libraries.
- [ ] **7. Harness gaps.** `browser_wait_for`, `browser_tabs`, `browser_dialog`, batch
      `browser_fill_form`, schema-based `browser_extract`, incremental snapshots.

## Research conclusions worth keeping

Five subagents surveyed the field. What actually changes the design:

- **`DOMSnapshot.captureSnapshot` is the workhorse for design work.** One round trip returns computed
  styles for every node (against a whitelist you must supply), plus layout rects, paint order and
  blended background colours. Everything else — `CSS.getMatchedStylesForNode`, `DOM.getBoxModel`,
  `CSS.getBackgroundColors` — is per-node and must be reserved for elements the bulk pass already
  flagged. Requesting all properties instead of a whitelist balloons the payload.
- **Text beats screenshots for grounding, with a caveat.** SeeAct found textual-choice grounding beat
  Set-of-Mark image annotation; WebVoyager found the opposite against a weaker text baseline. The
  honest reading: a good text representation wins, and screenshots earn their place only where the
  DOM has nothing to offer (canvas, WebGL, maps).
- **Compress before the model sees it.** chrome-devtools-mcp turns a 29.8 MB trace into under 4 KB of
  checklist text. That ratio, not the raw data, is the product.
- **Report design as flat annotated lines, not nested JSON.** `token: value (n uses, x%)` reads like
  a design-system README and costs a fraction of the tokens.
- **WCAG 2 contrast ratio and APCA Lc disagree, sometimes sharply.** Report both rather than picking.
- **Breakpoints defined in CSS diverge from breakpoints that change anything.** Verify by diffing
  computed styles across real viewport resizes, not by parsing `@media` text.
- **Wappalyzer went closed-source in Aug 2023.** The community forks (`enthec/webappanalyzer`) are
  frozen at that ruleset baseline. Runtime global checks are cheaper and more current for the
  frameworks the user actually cares about.
- **Lighthouse dropped its known-vulnerabilities audit in v10.** RetireJS's feed is the maintained
  open option.
- **Mozilla's Python http-observatory was archived Nov 2024.** The successor is
  `@mdn/mdn-http-observatory` (MPL-2.0). Google's `csp_evaluator` (Apache-2.0) grades CSP properly.
- **Do not emit deprecated security advice**: `X-XSS-Protection`, `Expect-CT`, `Feature-Policy` are
  dead; `X-Frame-Options` is a legacy fallback to CSP `frame-ancestors`, not a positive on its own.
- **Passive vs active is a hard line.** Reading headers, cookies, certs, console, DOM and bodies the
  page already fetched is in scope. Probing `/.env`, fuzzing, or requesting anything the page did not
  itself request is not, and must stay out unless the user explicitly targets their own host.

## Gotchas discovered this phase

- `cloudflared tunnel route dns` refuses to replace an existing record; `--overwrite-dns` is needed.
  `code.vinn.dev` already held an orphaned proxied A record serving HTTP 530 (Cloudflare "tunnel not
  found"), so nothing live was displaced.
- PowerShell reports a `NativeCommandError` for `git push` even on success, because git writes its
  progress to stderr. Read the actual output, not the exit status.

## Done this phase

- GitHub repo created and pushed: `github.com/realvinn/stoke` (public, so `electron-updater` can
  fetch `latest.yml` and the installer without a token).
- Cloudflare tunnel `stoke` created, id `3795de1d-087b-48e1-a7dc-d1259b3711a5`.
