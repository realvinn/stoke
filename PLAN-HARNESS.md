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
- [x] **1. Extractor quality.** Done, `dbb3754`. `STRIP` turned out to be dead code — declared and
      never referenced — which is why nav leaked. Controls are now dropped and links kept (the
      first fix treated them alike and emptied Hacker News). Layout tables are walked as records.
      Shadow roots are pierced. `scripts/verify-extract.mjs` holds the three pages as a regression
      set.
- [x] **2. `browser_design`.** Done, `143b519`.
- [x] **4. `browser_perf`.** Done.
- [x] **5. `browser_stack`.** Done.
- [x] **6. `browser_security`.** Done, passive only.
- [ ] **3. `browser_responsive`.** Resize through breakpoints; report horizontal overflow, clipped
      text, overlapping boxes, touch targets under 24x24. Not started.
- [ ] **7. Harness gaps.** `browser_wait_for` (highest value — without it the agent polls),
      `browser_tabs`, `browser_dialog`, batch `browser_fill_form`, schema-based `browser_extract`,
      incremental snapshots. Not started.
- [ ] **8. Paint metrics need a visible page.** LCP, FCP and CLS are unavailable while the agent's
      view is hidden, because Chromium does not paint a hidden view. Currently reported as
      unavailable, which is honest but not useful. Making the view briefly visible during a
      measurement would fix it.

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

Every one of these produced confident, plausible, wrong output rather than an error. None would
have been caught by a typecheck, and several survived a first round of eyeballing.

- **`did-start-loading` fires again after the page has loaded.** A client-side router starting a
  prefetch counts as "loading", so the console and network logs were wiped moments after being
  filled. Measured on tailwindcss.com: the second event arrives with 53 completed requests already
  recorded and takes all of them. This is why the security audit saw no headers. The log is now
  cleared on `did-start-navigation` filtered to main-frame, cross-document — which fires *before*
  the document request, unlike `did-navigate`, and only once, unlike `did-start-loading`.
- **Computed colours are not `rgb()` any more.** Tailwind v4 and anything authored in OKLCH report
  `oklab(...)` and `lab(...)`. Painting each distinct value to a 1x1 canvas and reading it back is
  both simpler and safer than hand-rolling the conversions.
- **`DOMSnapshot`'s `includeBlendedBackgroundColors` returns an array of empty strings.** It is the
  right length, so it looks like it worked. Contrast is now composited from the ancestor chain.
- **`Profiler.startPreciseCoverage({detailed: true})` crashes the app on a large bundle.** Function
  granularity (`detailed: false`) is enough and does not.
- **V8 coverage ranges nest.** Summing covered ranges double-counts and reports 0% unused for every
  script. Merge the `count === 0` ranges instead.
- **`CSS.stopRuleUsageTracking` reports rules that were exercised, not every rule.** Deriving
  "unused" from its `used: false` entries gave 0% unused on Wikipedia, which loads a large shared
  stylesheet. The denominator has to come from `CSS.getStyleSheetText`. Correct answer: 80%.
- **A hidden `WebContentsView` never paints**, so LCP, FCP and CLS do not exist for it. Reporting
  the zeros as "LCP 0ms, good" was the single most misleading thing the tool did.
- **"Header absent" and "headers never captured" look identical once rendered.** The audit
  confidently reported a missing CSP, HSTS and nosniff on a site that sends all three.

Earlier:

- `cloudflared tunnel route dns` refuses to replace an existing record; `--overwrite-dns` is needed.
  `code.vinn.dev` already held an orphaned proxied A record serving HTTP 530 (Cloudflare "tunnel not
  found"), so nothing live was displaced.
- PowerShell reports a `NativeCommandError` for `git push` even on success, because git writes its
  progress to stderr. Read the actual output, not the exit status.

## Done this phase

- GitHub repo created and pushed: `github.com/realvinn/stoke` (public, so `electron-updater` can
  fetch `latest.yml` and the installer without a token).
- Cloudflare tunnel `stoke` created, id `3795de1d-087b-48e1-a7dc-d1259b3711a5`.
