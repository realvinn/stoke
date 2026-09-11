---
paths:
  - "src/main/browser.ts"
  - "src/main/mcp/*.ts"
  - "src/main/mcp/inject/extract.js"
  - "scripts/cdp-eval.mjs"
  - "scripts/verify-extract.mjs"
  - "src/renderer/src/components/BrowserPanel.tsx"
---

# Docked browser and CDP

The docked `WebContentsView` browser, its per-page logs, the browser MCP server, and telling Stoke
apart from it over CDP. Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of
each. Numbers are permanent — code comments cite them as "CLAUDE.md gotcha N".

## 3. A `WebContentsView` outside the window's view tree gets a 0×0 viewport and never lays out

**A `WebContentsView` outside the window's view tree gets a 0×0 viewport and never lays
out.** `getBoundingClientRect`, `innerText` and every visibility check return empty, so
the agent silently reads a blank page. Views are mounted immediately and merely hidden.

## 4. Reset per-page logs on a main-frame, cross-document `did-start-navigation`

**Reset per-page logs on a main-frame, cross-document `did-start-navigation`.** Both of the
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

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - The explanatory comment and the handler have both moved. The comment is now src/main/browser.ts:135-151 and the `did-start-navigation` handler is :152-162. Lines 121-129 are now the `Tab` object literal.
> - It is no longer the only place the logs get cleared. The `render-process-gone` handler (src/main/browser.ts:189-208) also sets `tab.consoleLog = []` and `tab.netLog = []` (:199-200) for any reason except `clean-exit`, then reloads the crashed tab once.

## 6. The docked browser is its own CDP target

**The docked browser is its own CDP target.** Test scripts that attach by
`type === 'page'` must filter on the URL or they drive the wrong page.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - The repo's own CDP tool now says filtering on URL is not enough. scripts/cdp-eval.mjs:14-19 reads 'Matching on URL is NOT enough', because the docked browser can legitimately show `localhost:<port>`, `/index.html` and `file://`. At :153-204 it takes every `type === 'page'` target that has a `webSocketDebuggerUrl` and keeps the one where `typeof window.stoke === "object" && typeof window.stoke.platform === "string"` is true, since contextBridge is injected into the renderer only. CLAUDE.md's own Layout entry for cdp-eval.mjs agrees: 'never by URL'.
