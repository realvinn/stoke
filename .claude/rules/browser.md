---
paths:
  - "src/main/browser.ts"
  - "src/main/mcp/*.ts"
  - "src/main/mcp/inject/extract.js"
  - "scripts/cdp-eval.mjs"
  - "scripts/verify-extract.mjs"
  - "src/renderer/src/components/BrowserPanel.tsx"
  - "src/renderer/src/components/BrowserSettings.tsx"
  - "src/main/browserImport/*.ts"
  - "src/shared/browserProfiles.ts"
  - "scripts/verify-chrome-import.mts"
  - "scripts/verify-safari-import.mts"
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

## 106. `webContents.getURL()` is the last COMMITTED URL — empty for the whole of a fresh tab's first load

**Opening a terminal link on the first click of a run showed a blank page.** `openUrl` (App.tsx)
sends `browser.show(url)`, and the panel's open effect follows it with a bare `browser.show()`.
On the first link of a run there is no tab yet: `show(url)` creates one and starts loading the link,
and the bare `show()` used to seed `about:blank` whenever `getURL()` was empty — which it is, because
`getURL()` reports the last committed URL, and nothing has committed while the first load is still
in flight. So the second call navigated to `about:blank` over the link. Every later link worked,
because by then the tab had a committed page, which is why it read as "sometimes".

Measured 2026-09-26, both over the real IPC pair and with a real click: a fake CLI printed a local
URL into a terminal, CDP hovered and clicked it, and main read the view's URL 3 s later —
`about:blank` on the old code, the page on the fix. `show(url)` alone always loaded.

The fix is in `EmbeddedBrowser.show`: seed `about:blank` only in the call that CREATED the tab
(`!this.active()` before `ensure()`). A tab that already exists either has a page or has one on the
way. This is the second round of the same race: the first (the `seededBrowser` claim in `openUrl`)
stopped the effect from navigating to the homepage over the link, and left this one underneath it.
Anything else that decides "this tab has no page yet" from `getURL()` has the same hole — use
`isLoading()` or track the request, never the committed URL.

## 107. Importing another browser's logins: six ways a correct-looking cookie comes out wrong

**Where they land.** Each source profile goes into a Stoke browser profile of its own (`origin` =
the source key, so a second import refreshes it), never Default. Two accounts on one site in one jar
overwrite each other, and Claude's browser tools act in whichever profile is in use — a login is only
handed to them where the user put it. A source with no cookies makes no profile.

**Chromium's `samesite` column is -1 unspecified, 0 NO_RESTRICTION, 1 lax, 2 strict** (3, the
deprecated "extended", reads as unspecified) — `DBCookieSameSite` in
`net/extras/sqlite/sqlite_persistent_cookie_store.cc`. The research pass had 0 as "unspecified";
reading the source is what caught it, and that mapping would have turned every `SameSite=None`
cookie into Lax and broken embedded logins. SameSite=None without Secure goes in as unspecified,
since Chromium's own setter refuses it.

**A host-only cookie must be set with NO `domain`.** Electron dots any domain it is handed, which
widens `app.example.com` to every subdomain. Chrome marks host-only by a `host_key` without a leading
dot; keep the dot only when it was there.

**Times are microseconds since 1601, past 2^53.** `node:sqlite` throws on such an integer unless the
statement has `setReadBigInts(true)`; convert with bigint division (`chromeTimeToUnix`). A session
cookie (`has_expires` 0) is imported with a 30-day expiry — as a real session cookie it would be gone
the first time Stoke quit.

**Meta version 24+ prefixes the decrypted value with SHA-256(host_key)**, and Chrome drops a row whose
prefix does not match; so does `decryptChromeValue`. Partitioned (CHIPS) cookies are skipped:
`cookies.set` has no partition key, and setting one unpartitioned hands it to every embedder.

**macOS guards all of it.** Chrome's folder answers EPERM until Stoke is allowed "access data from other
apps" (the prompt is raised by the read itself, so only ever from a button); the key comes from
`/usr/bin/security find-generic-password -s "Chrome Safe Storage"`, whose prompt names `security`;
Safari's files need Full Disk Access and a relaunch. EPERM is a status, not an error
(`needsAppData`, `needsFullDiskAccess`). The live DB is copied with its `-wal` before it is opened —
Chrome may be running and holding it — and the copy is removed however the read ends.

**The cookie store is plaintext, so logins are gated on it (`cookieStoreEncrypted`).** Stoke's
builds ship with Electron's `EnableCookieEncryption` fuse OFF — measured: a cookie set in a fresh
partition and flushed lands in `<partition>/Cookies` with `value` = the plain string and a 0-byte
`encrypted_value`. Imported Chrome logins would then sit in a file any process running as the user
reads with no prompt, a Claude session's shell included, where Chrome kept them behind the Keychain.
So the import writes one marker cookie, reads the partition's SQLite back, and refuses logins unless
the value came back encrypted (failing closed); bookmarks still come. Turning the fuse on
(`electronFuses.enableCookieEncryption` in electron-builder.yml) is one-way and ties a "Stoke Safe
Storage" Keychain item to the signature (gotcha 24), which is why it is a release decision and not
part of this change.

**Two grants reach further than the import.** The Keychain prompt names `security`: Allow is the
safe answer, Always Allow puts `security` on the item's access list for good, after which any
program can read Chrome's key silently — the UI says which to press. Full Disk Access is granted to
Stoke as the responsible process, so every pty child (every Claude session, hook, terminal) inherits
it for as long as it stays on — the copy says so and suggests turning it off after a Safari import,
and a Chrome import never points at it (the narrower "data from other apps" grant is enough).

Verified 2026-09-26 against a SYNTHETIC Chrome tree (`HOME` pointed at it, the key handed in through
`STOKE_TEST_CHROME_SAFE_STORAGE`, honoured only unpackaged): two profiles imported into two new Stoke
profiles, 4 cookies each with host-only/domain/samesite/session all as above, the expired and the
partitioned one skipped, a `javascript:` bookmark refused, a re-import reusing both profiles, a double
press refused. No real browser data or Keychain item has been read by any test.

