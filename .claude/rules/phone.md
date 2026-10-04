---
paths:
  - "src/main/remote/*.ts"
  - "src/remote/*.ts"
  - "src/remote/public/sw.js"
  - "vite.remote.config.ts"
  - "src/renderer/src/components/CloudflareSetup.tsx"
  - "src/renderer/src/components/PhonePopover.tsx"
  - "src/renderer/src/components/RemoteSettings.tsx"
  - "scripts/verify-remote.mts"
  - "scripts/verify-remote-security.mjs"
  - "scripts/verify-phone-ui.mts"
  - "src/shared/remotePhone.ts"
  - "src/shared/phoneUi.ts"
  - "src/shared/cfAccess.ts"
  - "src/shared/replayModes.ts"
  - "src/main/screenMirror.ts"
  - "src/renderer/src/lib/ptyBus.ts"
  - "src/renderer/src/components/RemoteTerminal.tsx"
---

# Phone access and cloudflared

Phone access: where the link points, tokens, the server restart rule, and reading cloudflared.
Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of each. Numbers are
permanent — code comments cite them as "CLAUDE.md gotcha N".

## 53. Phone access read as broken on every fresh install, and the panel was drawing the proof

**Phone access read as broken on every fresh install, and the panel was drawing the proof.**
Every transport is off by default, `connectUrl` fell through to `http://127.0.0.1:<port>`,
and `RemoteSettings` rendered that as a QR code under the heading "Open on your phone". The
working path was: Turn on, scroll past the code, tick "Also listen on the local network",
Turn off, Turn on, scan — six presses and one undocumented restart, because the server read
its config once at start and the `settings:set` handler never restarted it. Two more things
compounded it. `remoteConfig()` minted the bearer key as a side effect of being *read*, and
the 4s status poll was a reader, so on a fresh install the panel's first poll wrote a token
the renderer did not have; the next control the user touched spread its stale `remote` back
over it, and the QR code carried a key the server was not holding. And a running quick
tunnel's URL was printed bare while the QR kept encoding the LAN link — the key was in the
other string, so a phone opening the tunnel got 401.

The fixes are structural rather than copy. `link.ts`'s `connectTarget` returns a `reach`
(`tunnel | tailnet | lan | loopback`) beside the URL, and the panel and the title-bar phone
button refuse to draw a QR code for `loopback`. `remote:openOnPhone` is one press: mint a
key if none, pick the tailnet when Tailscale is up and the LAN otherwise (a transport the
user already chose is kept), start, push `settingsChanged`. Every remote write in main pushes
`settingsChanged` now, minting is `ensureRemoteToken` and only the start paths call it, and
the `settings:set` handler restarts a running server when a bound field changes. The LAN
address is ranked (`lanAddresses`): Docker's bridge100, a VM's vEthernet and any utun sit
ahead of Wi-Fi in `networkInterfaces()` order often enough that "first non-internal IPv4"
handed the code an address nothing could dial. `verify:remote` holds all of it.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - scripts/verify-remote.mts imports only `connectTarget` and `lanAddresses` (src/main/remote/link.ts), plus remote/tunnel.ts, remote/cloudflare.ts and shared/ui.ts. No suite runs this entry's fixes in src/main/index.ts: `ensureRemoteToken` (index.ts:492-498), the `remote:openOnPhone` handler (1691-1726), and the `settings:set` restart when a `bindKeys` field changes (1920-1923). The renderer's refusal to draw a loopback QR (RemoteSettings.tsx:189, PhonePopover.tsx:74) is also untested. Of this entry, the suite covers only the `reach` fallback order and the LAN ranking.

## 58. Reading `cloudflared` is four traps deep, and every one of them makes a plain implementation report the OPPOSITE of the truth

**Reading `cloudflared` is four traps deep, and every one of them makes a plain
implementation report the OPPOSITE of the truth.** Measured against cloudflared 2026.6.1 on a
real account while building the setup steps in `src/main/remote/cloudflare.ts`.

- **`tunnel list --name X` exits 0 when nothing matches.** The exit code is not the detector;
  the payload is.
- **With `--output json` and no match it prints the literal string `null`.** `JSON.parse`
  accepts it and yields `null`, so `.some(...)` throws on what looks like a successful parse —
  and if you defend by returning "unreadable" for a non-array you have made the ordinary case
  of *not having created the tunnel yet* report as a parser failure. That is not hypothetical:
  the first build of this panel said "Cloudflare answered with something this version could not
  read" against a healthy account, and only running it for real showed it. `null` is the CLI's
  way of writing "none", so it normalises to `[]`; only genuinely unreadable output is null.
- **A version warning goes to stderr on every single invocation** (`Your version … is outdated`),
  and neither `--no-autoupdate` nor `NO_AUTOUPDATE=true` suppresses it. "stderr is non-empty
  therefore it failed" is wrong on any machine that is one release behind. Never `2>&1` a
  machine-readable call either: `--output json` reformats the *logs* as JSON too, so merging the
  streams makes stdout unparseable.
- **`tunnel create` on a name that is taken exits non-zero**, with `already exists`. That is the
  state you wanted, not a failure to paint red.

**`tunnel list` is a live API call, not a local cache**, so there is a third state and it is the
important one. With no network you cannot tell "this tunnel does not exist" from "I could not
ask", and collapsing those into "does not exist" sends the user to create a duplicate that then
fails on the name. Check the login certificate FIRST as well: without it every `list`/`info`
call fails with a message about the tunnel ID (`error parsing tunnel ID: Error locating origin
cert…`), so the panel confidently tells you your tunnel is missing when the truth is that you
are not logged in.

**The DNS route cannot be read back at all, so do not build a detector for it.** `tunnel route`
has no `list` subcommand, and the record is a *proxied* CNAME to `<uuid>.cfargotunnel.com` —
public DNS therefore answers with flattened Cloudflare anycast A records and no CNAME, so a
lookup can tell you something answers and never which tunnel. Authoritative reads need the
Cloudflare DNS API and an API token, which `cert.pem` is not. An HTTP probe is worse than
useless: a routed hostname whose tunnel is down returns Cloudflare's own **1033** page, and one
behind Access returns a 302 to a login screen, so neither a 200 nor a failure means anything.
Make the step idempotent-by-retry and offer `--overwrite-dns` for the clash.

**`tunnel login` is not an `execFile`.** It prints its URL on **stderr**, opens a browser, and
then BLOCKS — it stays alive precisely to write `~/.cloudflared/cert.pem` when the callback
completes. So completion is that file appearing, not the process exiting. It also refuses when a
certificate is already present (`You have an existing certificate at … which login would
overwrite`) and exits 0 doing so, which is a success code for having done nothing. Honour
`$TUNNEL_ORIGIN_CERT`; the CLI prints the resolved default in every help screen.

One thing NOT to reach for: `cloudflared tunnel token <name>` prints a credential to stdout. If
it is ever needed, write it with `--cred-file` — never capture it into a log buffer that a
status object ships to the renderer.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - The code now probes the hostname over HTTP and sets the route step from the answer. `checkHostname` (src/main/remote/cloudflare.ts:213-228) fetches `https://<host>/` with `redirect: 'manual'`. `classifyHostname` (:176-189) maps HTTP 530 or an 'error 1033' body to `tunnel-not-found`, meaning the record points at a different tunnel. It maps a redirect to cloudflareaccess.com to `access`, and a 401 or any 2xx/3xx to `ok`. `routeStep` (:348-360) turns those into failed, unknown (access/other), done and todo (dns). scripts/verify-remote.mts:266-286 asserts the mapping. Only the DNS record itself is still unreadable (`routeIsUndetectable`, :150). The file's own comment at :142-144 still calls an HTTP probe useless, which contradicts `checkHostname` in the same file.

## 85. A phone's text and its Enter key were one pty write, and Claude Code read the whole thing as a paste

**The composer sent a prompt and the trailing `\r` as a single WebSocket frame, and `PtyManager.write`
forwarded that as one write to the pty.** Claude Code's own input box treats a fast multi-byte chunk
as a paste — that is a property of the TUI, not of Stoke's socket — so the `\r` *inside* the chunk
becomes a literal newline in the box instead of submitting, and the NEXT lone `\r` (a real Enter
key, or a second tap of Send) is what actually starts the turn. Audit finding PX-1: short prompts
(a bare digit, 29 characters) submitted fine, because they fit under whatever threshold Claude's
paste detector uses; 80, 83 and 97-character prompts landed in the box and sat there. A raw
WebSocket client confirmed it on the wire: one frame `{type:'input', data:'…\r'}`, and the first
lone `\r` sent afterward changed nothing — only the second one submitted.

The fix is two separate pty writes, timed apart, for a NEW `{type:'submit', text}` message (`{type:
'input', data}` is unchanged and still raw keystrokes). `submitFrames` (`src/shared/remotePhone.ts`)
decides the text: wrapped in `ESC[200~ … ESC[201~` when the pty currently has DECSET 2004 (bracketed
paste) on — tracked from the pty's own output stream by `trackBracketedPaste`, never assumed — so a
multi-line prompt's embedded newlines stay newlines rather than each submitting early. `submit()` in
`pty.ts` writes that body, then writes a bare `\r` on its own after a short delay (started ~80ms;
adjust from what a real `claude` measures — Ink's paste-vs-keystroke window is not documented). A
session with bracketed paste off (a raw shell, `shell` status) gets the plain text with no brackets.

**Do not fold the two writes back into one "for efficiency"**: that is the exact bug. And do not
key the bracket only on `isClaudeCode(cli)` — an `agentPlan`-launched CLI can turn bracketed paste on
or off itself mid-session (a mode switch, a sub-shell), which is why this reads the live stream
rather than the launch-time agent id.

> Recorded 2026-09-19. `scripts/verify-remote.mts` covers `submitFrames` and `trackBracketedPaste` in
> isolation; proving the fix against a REAL `claude` (a 200-char prompt starting a turn on the first
> submit, per the phone contract) is a manual/CDP check, not a suite — Ink's own paste threshold is
> not something this repo can assert without spawning the binary.

> **Corrected on 2026-09-19 by gotcha 86** — the bracketed-paste half of this entry was wrong for
> Claude Code. Two writes (text, then `\r` on its own) is right and stays; wrapping the text in
> `ESC[200~ … ESC[201~` is not: Claude Code records every bracketed paste as `<pasted_content>`
> and the model declines to act on it. `submitFrames` now brackets only another agent's
> multi-line text. Read 86 before touching `submitFrames` or `PtyManager.submit`.

## 86. Bracketed paste made every phone message a `<pasted_content>` block that Claude would not act on

**Measured 2026-09-19 against Claude Code 2.1.278, from the phone UI in a throwaway folder.** With
gotcha 85's first fix live, a 125-character "create a file named hello.txt …" sent from the
composer started a turn on the first tap — and Claude answered "Your message is entirely pasted
text with nothing you typed around it, so I haven't acted on it yet." The transcript shows why:
the user record's content was `\n\n<pasted_content id="0bbb">\n…\n</pasted_content id="0bbb">\n`.
Claude Code files a bracketed paste as pasted content, and the model treats pasted content with
nothing typed around it as material, not instructions. Every phone message was a paste, so the
phone could start turns that did nothing.

What was measured, each through the phone socket's raw `{type:'input'}` into the same session:

- one unbracketed write of 68 characters, then `\r` 150ms later: recorded as typed, acted on;
- one unbracketed write of 203 characters, then `\r`: typed, acted on — so PX-1 was only ever the
  `\r` sharing a chunk with the text, never the text's length;
- one unbracketed write of 1287 characters, then `\r`: `<pasted_content>` again (a length
  heuristic, no brackets needed), and refused;
- the same 1287 characters as 64-character writes 10ms apart, then `\r`: typed, acted on;
- `line one ESC CR line two ESC CR line three` in one write, then `\r`: one turn, recorded with
  real `\n`s — `ESC CR` (meta-Enter) is Claude Code's in-box line break.

So `submitFrames` (`src/shared/remotePhone.ts`) TYPES a phone message to Claude Code: newlines as
`ESC CR`, `typingChunks` of at most `SUBMIT_CHUNK` (64) never splitting an `ESC CR` pair (half of
it is a bare Escape, which cancels) or a surrogate pair, written `SUBMIT_CHUNK_GAP_MS` apart by
`PtyManager.submit`, then the bare `\r` after `SUBMIT_ENTER_DELAY_MS`. Only another agent's
multi-line text still goes inside bracketed paste (when DECSET 2004 is on), because a shell has no
meta-Enter and needs the bracket to keep its newlines. `verify:remote` holds the framing; only a
real `claude` can hold the paste heuristics, so re-measure them when Claude Code's input box
changes.

> **Checked against the code on 2026-09-19** (review of qa/phone). Typing takes real time — 10ms a
> chunk plus 80ms before the Enter — and `submit()` started one timer chain per call with nothing
> between calls, so two submits sent together were written interleaved: a 228-character "apple"
> prompt and a 32-character "banana" one landed as ONE user turn, spliced. The phone's queued-send
> flush (PX-3) always sends several back to back. Each session now has a `SubmitQueue`
> (`remotePhone.ts`): a submit starts typing only after the previous one's Enter, plus
> `SUBMIT_AFTER_ENTER_MS`. `verify:remote` asserts the order with real short timers and fails
> when the chain is removed. Raw `{type:'input'}` keys are NOT queued, on purpose: Esc and ctrl-c
> must interrupt.

> **Checked against the code on 2026-10-04** — the submit frame has a second sender. Another
> machine's remote tab sends `{type:'submit', text, enter: false}` through the hub relay for its
> DICTATION (`HubRemote.type`): the host's phone server types it exactly as above and presses no
> Enter (`manager.submit(ptyId, msg.text, { enter: msg.enter !== false })`), so the words land in
> the box for the owner to read and send. A guest sends it only to a host whose `ready` said
> `typeOnly: true` — an older host ignores `enter` and would submit the words — and never under a
> view grant (`relayFrameVerdict` refuses it at the host as well). The phone itself never sends
> `enter: false`. `verify:hub-relay` holds the frame, the refusals and the wire.

## 87. The phone's terminal: pad the box, not xterm's parent, and resize the pty only on a width change

Two audit findings with one cause each. **PX-7**: `.term-wrap` carried `padding: 6px 4px` under
`box-sizing: border-box` and was xterm's own parent, and `FitAddon.proposeDimensions` reads the
parent's computed height, padding included — so it always fitted one row too many and Claude's
mode line was half hidden (clientHeight 673 vs scrollHeight 687 at 390×844). Now the padding is on
`.term-wrap` and xterm opens on the unpadded `.term-inner`; `session.ts` sizes from the wrap's
content box and xterm's cell size, and at rest `scrollHeight === clientHeight` (measured 679 = 679
at 390×844, 288 = 288 at 844×390).

**PX-5**: a ResizeObserver refitted and sent `{type:'resize', force:true}` on EVERY size change of
the terminal's box — the composer growing a line, the send clearing it, the soft keyboard — each a
SIGWINCH to Claude and a reflow of the desktop's terminal. `decideResize`
(`src/shared/phoneUi.ts`, `verify:phone-ui`) is now the only thing that decides: nothing resizes
unless the user chose **Fit to phone**; then only a width change of at least one cell does
(rotation), never while the composer has focus (deferred to its blur), with rows measured at that
moment and left alone; leaving fit sends the desktop's own size back (`attached.desktopCols/Rows`,
F2) once. A laptop browser (`native`, ≥1024px) never resizes the pty at all. Measured over CDP:
growing the composer to four lines and shrinking the viewport to 500px while focused sent nothing;
one rotation sent exactly one resize. Do not reintroduce a resize on height — the keyboard IS a
height change.

> **Checked against the code on 2026-09-19** (second review of qa/phone). A view learned the pty's
> size only from `attached`, so a laptop kept the old grid after the desktop or another phone
> resized it. The server now sends `{type:'size', cols, rows, desktopCols, desktopRows}` once a
> registry pass to each attached socket not yet told the current size (`pushSizes`); the client
> re-runs `relayout('observe')`, which still never sends a resize on its own. Measured: an open
> 1440 view went from 30 to 25 rows when a second socket fitted the pty to 90x25.

> **Checked against the code on 2026-09-30** (the phone clean-up). "Never while the composer has
> focus (deferred to its blur)" deferred EVERY box change while focused, not just a width change:
> `decideResize` tested focus before width, and applied the width test to `observe` only — so the
> `blur` it deferred to fitted rows to whatever the box was then and sent them. Growing the
> composer to four lines and blurring sent `{type:'resize'}` 50x43 → 50x39 at 390x844 in Fit (and
> 97x14 → 97x11 at 844x390): a SIGWINCH for a height change. The measurement above ("growing the
> composer ... while focused sent nothing") was true and stopped one event short. It bit harder
> once the key row came out on focus (`keyRowShown`), because then a focus and a blur alone
> changed the height. The width test now runs first and holds for `blur` too; measured after:
> focus, four lines, the key row toggled, blur — no resize frame at either size, and at rest
> `.term-wrap` scrollHeight === clientHeight (731 = 731, 288 = 288). `verify:phone-ui` holds it.

> **Checked against the code on 2026-10-02 (Other machines: last active wins).** "A laptop browser
> (`native`) never resizes the pty at all" was also the rule for a hub remote tab — another of the
> owner's desktops drawing a session through the relay (RemoteTerminal) — and it left that tab
> drawing the host's grid with empty space round it, or scrolling, however it was used. The owner
> asked for the opposite: "whichever is active we force it to that screen ratio". For THAT path the
> rule is now last active wins (shared/sizeClaim.ts, gotcha 151): a remote tab that is USED — a
> focus, a key, a click, or its pane changing size just after a person acted on its window — sends
> the phone's own `{type:'resize', force:true}` for its pane; the session's own tab on the host draws
> that grid (`pty:sized`) and takes it back the same way, when someone uses it there. Nothing claims
> on being shown, on a timer, or on the other side's resize, so the two never fight over it (20 idle
> seconds after each claim, both sides unchanged in the built app). The relay's scope holds a resize
> to the session its grant reaches (`relayScopeVerdict` judges a `ws-msg` by the socket it rides).
> **The phone is unchanged**: its own UI still resizes only in Fit to phone, on a width change, and
> its server still tells the desktop nothing; only the relay's instance of that server
> (`serveRelay` hooks) reports a resize to the desktop, pushes the new grid to every relayed viewer
> at once rather than a registry pass later, and puts the desktop's size back when the last remote
> tab leaves.

## 111. The phone server's config is a snapshot taken at start; a setting it does not bind must be a per-call dep

**Found 2026-09-30, moving the speech server from Phone access to Settings → Voice.** `RemoteServer`
copies `RemoteConfig` once, in `start()`, and the `settings:set` handler restarts it only when one of
`REMOTE_BIND_KEYS` moves (`shouldRestartRemote`) — port, binds, Access, hostname, token — because a
restart drops every attached phone. The speech-server address rode in that snapshot as
`config.sttUrl` without being a bind key, so the phone's `/api/transcribe` kept posting to the
address it STARTED with until Phone access was turned off and on, while the desktop's dictation
(`CH.transcribe`, which reads `getSettings()` per call) followed a change at once. The field's own
hint documented the asymmetry ("the phone picks it up the next time the remote server starts")
rather than anything fixing it, and `/api/host`'s `stt` status, read per call through
`RemoteDeps.sttStatus`, described a different address from the one the upload would use.

The rule: **anything the phone server reads that is not something it binds or checks goes through
a `RemoteDeps` function that reads settings on the call** — `transcribe`, `sttStatus`, `theme`,
`defaults`, `agents` all do now — and `RemoteConfig` holds only what a restart is worth. Putting a
new field in the config and adding it to `REMOTE_BIND_KEYS` instead would "work" and cost every
connected phone its socket on each edit. Where a per-call result also decides the HTTP status (503
"no server set" vs 502 "failed"), take it from the same read as the call (`SttResult.unset`), never
from a second read beside it, or the two can describe different addresses.

A settings key that moves between blocks keeps the old key as a WRITE-ONLY mirror for a release
(`remote.sttUrl`): `hydrateSettings` migrates from it only when the new key is absent, then
rewrites it from the new key on every read and write, so an older build reading the file keeps
the address, and `RemoteSettings`' habit of spreading its whole `remote` copy into every patch —
stale mirror included — can never move the setting back. `verify:settings` pins both directions,
and fails with the mirror line deleted.

Proving it over CDP had its own trap: **`el.blur()` is a silent no-op while the window lacks OS
focus** (`document.hasFocus()` false — any sandbox instance behind the terminal), so a `useDraft`
field never commits and the edit reads as "not saved" in working code. Dispatch
`new FocusEvent('focusout', { bubbles: true })` on the input instead; React's `onBlur` listens for
exactly that. Measured with fake sidecars on 17991/17992 and the phone server on loopback: the same
running server answered `from A`, then `from B` after the Voice edit, with no restart between.

## 121. "A known project's parent" includes `/Users` and `/` on real machines, so the phone's folder allow-list needs a floor

**Found 2026-09-30, building the phone's Browse and New folder (phone contract points 12, 13).** The
decision was that a phone may browse and create folders only under Settings' project roots, the
default folder, and the folder holding each known project — never anywhere else, because the bearer
key is the whole defence (Access headers are presence-checked, never verified). Read literally, the
third source is not narrow. Claude Code records a project wherever `claude` was ever run, and on
the owner's machine that includes the home folder itself (`paths.ts` records `/Users/thevinh` as a
registered project). Its parent is `/Users` — every account on the machine — and a project run at
`/` or a drive root has the whole disk as its parent. A leaked key would then list and create
folders anywhere the desktop user can write.

So `remoteFolderBases` drops any place shallower than `MIN_FOLDER_BASE_DEPTH` (two folders below the
root, a drive letter not counted: `/Users/v` passes, `/Users`, `/`, `C:\Users` do not), folds a
place inside another into it, and is computed from REAL paths. `remoteFolderVerdict` judges the
REQUESTED path's shape first (`isPlainFolderPath`: absolute, no `.`/`..`, no NUL — refused before
anything resolves it) and then its realpath: a symlink inside a root that points out is outside,
and an out-of-place path answers 403 whether or not it exists, so the route is no existence probe.
Case folds only where the OS does (`pathKey`) — the old `knownCwd` lower-cased unconditionally, so
on Linux a case variant of a known project passed as it. A new folder's name is one segment
(`newFolderNameProblem`), and an `EEXIST` is judged again as an existing folder, so a pre-planted
symlink of that name is refused rather than remembered.

`verify:remote` holds the rules and runs `/api/folders` against a real temp tree (symlink out,
sibling prefix `…/projects-old`, a file, a dot-folder, 205 subfolders); mutating `isInside`'s
separator test turns three of them red. `verify:folders` holds the add path under a real symlinked
place. The live half — every refusal over HTTP, and that no refused request launched anything — is
`verify:security` against a running sandbox (43/43 on 2026-09-30, with a stub `claude` whose launch
log stayed empty through them).

> **Checked against the code on 2026-09-30** (review of the branch that added it). The floor was not
> enough: **the phone could widen its own allow-list, one folder per tap.** Start here on a place's
> OWN folder is allowed (`isInside` counts a place as inside itself) and adds it as a project
> (`addRemoteProject` → `manualProjectPatch`); the next `/api/folders` listing then made that
> project's parent a place and folded the old one into it. Tap again, climb again, down to the
> floor: the home folder, a whole volume (`/Volumes/X`, `/mnt/c`), and — from the scratch root, a
> place once any scratch session has history — the app's own data folder and every folder above it.
> A session in the default folder widened it once with no add at all, since Claude then records the
> folder as a project. Now `remoteFolderBases` lets a project lend its parent only when it is not
> itself a place: one inside (or equal to) a root or the default folder lends nothing, and neither
> does one that is the folder holding another project. Everything a phone may add is inside a place
> already, so an add can shrink the places but never widen them. The price is a narrowing, never a
> widening: a project that gains a project inside it stops lending (`~/dev/foo` plus `~/dev/foo/sub`
> offers `~/dev/foo`, not `~/dev`, unless a sibling lends `~/dev`), and a default folder or root
> with history no longer offers its parent. The reviewer's first wording — a project *inside* any
> place lends nothing — was not taken: two sibling projects are each inside the other's parent, so
> neither would lend and `~/dev` would vanish. Nor was "only projects with history, or not added by
> hand, lend": a session in the added place gives it history in one more request, and
> `addedManually` cannot tell a phone's add from `stoke .`'s, so every folder opened by hand would
> stop lending. A marker of the phone's own could tell them apart, but would still miss the default
> folder, which a session makes a project with no add at all. `verify:remote` checks every add in
> every configuration of an 11-folder tree (44,352 adds over 12,288 configurations) and fails with
> either half of the rule removed; `verify:folders` taps every place of a real temp tree for three
> rounds through the add route itself and asserts the places never move and the folder above them
> stays 403.

## 124. A Cloudflare Access header is evidence only once its signature checks out, against a team Stoke already knows

**Until 2026-09-30 "Require Cloudflare Access" passed any request carrying `Cf-Access-Jwt-Assertion`
or `Cf-Access-Authenticated-User-Email` with any value at all.** The email header is not signed by
anything, and `verify:security --access` forged exactly that to stand in for the edge — the proof,
recorded in e327af4, which made three messages honest instead of fixing it because Stoke held no
team domain or AUD to verify against. Measured against a sandbox instance before and after: with the
team and AUD set, the forged email header gets 401 on every data route and both sockets (14 of the
old matrix's 27 checks now fail by design); with the AUD cleared, the new `--access-configured`
matrix fails 15 checks, every forgery passing as it used to.

The rules, each a way a plausible version goes wrong:

- **Pin where keys come from and who issued them from SETTINGS, never from the token.** The JWKS URL
  is `https://<accessTeamDomain>/cdn-cgi/access/certs` and `iss` must equal `https://<team>`; `jku`,
  `x5u`, an embedded `jwk` and the token's own `iss` are never followed. Trusting the first token's
  `iss` (trust on first use) lets a forger pick the issuer and the keys.
- **Pin `alg` to RS256 before any key is looked up** (RFC 8725 §3.1): `alg: none`, HS256 keyed with
  the public PEM, and RS512 are each a refusal that never reaches `crypto.verify`. `aud` is an ARRAY
  in Access tokens; `nbf` and `email` are absent on service tokens, so `nbf` is optional.
- **Bound the refetch.** An unknown `kid` refetches at most once per `KID_COOLDOWN_MS` (30 s), one
  fetch is ever in flight (claimed before the await, gotcha 20), and the bearer key is checked FIRST
  so nothing without it reaches the verifier at all. `refresh()` itself must be single-flight, not
  just `keyFor`: the server's start-time prefetch calls it directly beside a phone's request.
- **Fail closed when verified, never silently degraded when not.** A key fetch that fails refuses
  every token (`no-keys`), keeping a last-good set only up to `MAX_STALE_MS`. A settings file with
  Access on but no team/AUD keeps the presence check so an upgrade does not lock a phone out, and
  reports `presence-only` in amber — turning the box on from off looks the pair up first.
- **Refuse Access in its own words, never with the key's 401.** `authorize` answers a
  `RemoteAuthVerdict` (`ok` / `key` / `access` + reason), and `remoteRefusal` turns an Access refusal
  into 403 `{error, refused: 'access'}` (socket: `403 Forbidden`). The phone's `api()` turns EVERY
  401 into the Connect screen ("Your key was replaced", "This link's key isn't current"), so while
  both were 401 a stale AUD, a JWKS outage or a skewed clock told the owner to re-scan a key that had
  just matched — a diagnosis the server could disprove. And `?k=` must still set the cookie when the
  key matched and only Access refused (`mayStoreKeyCookie` takes the verdict): withholding it made
  the next `/api` call keyless, so it 401'd and blamed the key anyway.
- **Discovery needs browser headers.** Access with Managed OAuth answers a non-browser request with
  `401 WWW-Authenticate … cloudflare-access-protected-resource`, not the login redirect whose `kid`
  (the AUD) and `meta` (a JWT the team signed over the hostname) `discoverAccess` reads — and
  `classifyHostname` used to call that 401 "reaches this machine". The redirect alone is never
  trusted: `meta` must verify against the redirect's own team with `hostname` equal to ours.

Stoke holds no Cloudflare API token (`cert.pem` is cloudflared's, never read, gotcha 58), which is
why Look it up reads the edge rather than the API. **Unverified**: that the login redirect's `kid`
is the application AUD tag (measured equal to `meta.aud`, undocumented — a wrong one fails closed
as `aud` and the panel says so), that WebSocket upgrades through the tunnel carry the assertion
(Cloudflare's origin-parameters page says "all L7"; the old check accepted either header, so a phone
that worked before proves nothing about this one — if they do not, the terminal 401s), and custom
team domains, which the clamp refuses until measured. None of this has met a real Access app:
`verify:remote` holds the verifier against generated keys, and `verify:security --access-configured`
the wiring against a sandbox pointed at a loopback JWKS by `STOKE_ACCESS_CERTS_URL` (unpackaged
builds only, loopback only).

> **Checked against the code on 2026-09-30, review of the above.** Every "401" this entry measures
> for a request that HELD the key is a 403 now (the refusal bullet above says why); a keyless
> request is still 401. Measured against a sandbox on a loopback JWKS: `verify:security
> --access-configured` 52/52, a token for another AUD answered 403 with the Look it up sentence,
> an expired one and a future `nbf` the clock sentence, a keyless one 401 text/plain. In Chromium at
> 390x844 with no Access header, `/?k=<key>` stored the cookie and the list read "Cloudflare Access
> check failed" (the review traced the old code to "This link's key isn't current"; the old build
> was not driven), and pasting the key into Connect landed on the same list; the handshake logged
> `Unexpected response code: 403`. A browser cannot read a refused handshake's status, which is why
> the session view's strip takes its sentence from the store's poll. Not driven: that strip over a
> live pty, and `no-keys` (a last-good set outlives a JWKS outage by design).

## 131. A service worker on the phone shell pins whatever it first caches, so the server must stop lying about missing files first

**Found 2026-09-30, making the phone shell an installable PWA.** A service worker is the one piece
of the phone UI that outlives a Stoke update: whatever it caches it serves until a NEW worker
script replaces it, and a browser installs a new one only when the bytes of `sw.js` change. Four
traps, each of which ships a phone stuck on an old or broken shell with every suite green:

- **The static handler answered every missing path with `index.html` and a 200** (the SPA
  fallback). A browser that asks for `/assets/index-<old hash>.js` after an update, or for `/sw.js`
  from a build that has none, got HTML dressed as a script: the module loader runs it and fails,
  and a worker registration or `cache.put` KEEPS it. `staticMissAnswer` (`remotePhone.ts`) now
  sends the shell only for a path that names no file; anything with an extension is a 404.
- **The bundle had fixed names** (`assets/index.js`), so an update could not be told from the
  build before it by URL, and any cache of it was a staleness bug. Names are content-hashed now
  (vite.remote.config.ts), `/assets/*` is `immutable`, and everything else is `no-cache`
  (`staticCacheControl`) — `sw.js` included, or the browser's own HTTP cache delays the update check.
- **An unchanged `sw.js` never updates.** `stampServiceWorker` (vite.remote.config.ts) writes the
  build's hash and file list into the copy in out/remote at `'__STOKE_BUILD__'` and
  `/* __STOKE_PRECACHE__ */ []`, and FAILS the build if either marker is gone; the cache is named
  after the build and activation deletes every other `stoke-shell-*` one. `verify:remote` checks
  both markers exist in the source.
- **What the worker must never touch.** `/api/*` and `/ws*` (every byte of session data, and the
  key — `route` returns null for them before anything else), a `?k=` navigation's URL, and an HTML
  answer for an asset (never kept as that asset). The URL is the subtle one: **a cached Response
  keeps its own URL list, whatever key it is filed under** (Chromium's CacheStorage stores
  `url_list`), so filing the shell under ONE fixed key, `index.html`, still kept the key — see the
  note below. `keepShell` stores a NEW Response of the shell's bytes, status and headers, whose URL
  is empty; a file asked for with a query is left to the network. The shell is network-first with
  a `SHELL_WAIT_MS` stall, so an update is on screen at the next load even under the OLD worker.

Registered only when `window.isSecureContext` — https through the tunnel, or localhost. A plain
http LAN or tailnet link cannot have one and runs exactly as before, so no phone depends on it.
Measured in Chromium against a sandbox on 127.0.0.1: registered and controlling at scope `/`,
precached the seven stamped files under `stoke-shell-98104baa3bfe`; an offline reload painted the
shell with "Can't reach your computer"; after a rebuild the FIRST load ran the new
`index-B9AqmGWx.js` through the old worker, and by the second the only cache was
`stoke-shell-f331132be8cb`. `verify:remote` runs `sw.js` itself in a `node:vm` sandbox (routes,
the fetch handler, offline, the `?k=` key, activation). **Not driven:** a real phone, iOS's
home-screen install (its own cookie jar still opens on Connect), and an https tunnel origin.

> **Checked against the code on 2026-09-30** (review of the branch that added it). The first
> version filed the shell under the fixed `index.html` key and called that "the key never lands in
> Cache Storage". It did land: Connect's `location.replace('/?k=…')` runs under the worker, the
> network's answer was `put` as it came, and a stored Response keeps its URL list. Measured in
> Chromium (Playwright) against a sandbox on 127.0.0.1: after that navigation,
> `(await (await caches.open('stoke-shell-f1a079a021a3')).match('/index.html')).url` was
> `http://127.0.0.1:17547/?k=<the key>` — readable by any script on the origin, the very thing the
> HttpOnly cookie is for. With `keepShell` the same run reads `''` (cache `stoke-shell-6770cfe65e56`,
> no entry of seven carrying the key) and the offline reload still paints "Can't reach your
> computer". The suite could not see it because its network stub was a `new Response()`, whose
> `url` is `''`, and it checked only cache KEYS: **stub a fetch with a Response whose `url` is the
> URL fetched and survives `clone()`** (`fromNetwork` in `verify:remote`), and assert on the
> stored response, not just the key it is filed under. Against the old `sw.js` that suite now fails
> three checks. A phone that stored the key under an earlier build loses it when the next build's
> worker activates (every other `stoke-shell-*` cache is deleted); that upgrade was not driven.

## 136. A push subscription's endpoint is a URL this machine will POST to, and no sandbox can make a real one

**Found 2026-09-30, building Web Push for the phone shell (phone contract point 14).** Four things,
each of which a plausible first version gets wrong with every suite green:

- **The endpoint is an SSRF handle, not an address book entry.** `POST /api/push/subscription`
  takes a URL from the phone and main POSTs to it on every edge. Taken as it came, the bearer key
  buys "make the desktop send requests anywhere", its own LAN included (measured: the sandbox
  accepted nothing but the services below; `http://192.168.1.1/admin` and a look-alike host are 400).
  `pushEndpointOk` allows https on the real push services only (FCM, Mozilla autopush, Apple,
  WNS; a leading-dot entry is a suffix), no credentials, no odd port — and hydrate re-checks a
  stored one, since settings.json can be edited by hand. Plain http on 127.0.0.1 passes only in an
  unpackaged build launched with `STOKE_PUSH_LOOPBACK=1`, the `STOKE_ACCESS_CERTS_URL` shape.
- **A new phone key must retire every subscription made under the old one.** Replacing the key is
  how the owner locks a phone out; a subscription that outlived it would keep telling that phone
  which project needs attention. Each record carries a hash of the key it was made under
  (`keyTag`), and only matching ones are sent to (`livePushSubscriptions`). And `remote.push` is
  main's alone: Phone access spreads its whole `remote` copy into every patch, so `commitSettings`
  pins `push` to main's copy — driven: a stale patch with `subscriptions: []` changed the tunnel
  name and left the subscription in place.
- **Prove the crypto against the RFC, never against yourself.** An encrypt/decrypt round trip with
  your own code passes with the wrong info strings on both sides. `encryptPush` reproduces RFC
  8291 Appendix A's message byte for byte (`verify:remote`), and the JWT is checked with
  `crypto.verify` in IEEE P1363 form, which JWS requires (RFC 7518 §3.4) — node signs DER unless
  told `dsaEncoding: 'ieee-p1363'`.
- **A sandbox cannot subscribe for real, and must not try.** Chromium's `pushManager.subscribe`
  registers with Google's FCM; the task rule is no real Apple or Google endpoint, and headless
  Chromium has no push service anyway. What was driven instead, against the built app on
  127.0.0.1 (a secure context, so the worker registers): the page's OWN notify.ts with only
  `PushManager.prototype.subscribe`/`getSubscription` stubbed to return a subscription for a
  loopback fake service that holds its private key; Turn on, Send a test, then a stub `claude`
  walking the registry busy → waiting → busy → waiting → exit. The fake service received four
  valid-JWT `aes128gcm` posts: the test, "Needs you" twice (one per prompt, none while a prompt
  sat for 8 s), "Finished" once, and nothing for waiting → busy. The real worker's half:
  CDP `ServiceWorker.deliverPushMessage` with the decrypted bytes, then
  `registration.getNotifications()` in the page listed the notification with its `#/s/<ptyId>`
  route. Opened over the LAN address instead (plain http, `isSecureContext` false, no
  `navigator.serviceWorker`), the bell's sheet says to use the tunnel's https link and offers no
  button (`pushAvailability`). **Not driven:** a real phone, a real push service, iOS's Home
  Screen app, and a notification tap (the vm sandbox in `verify:remote` covers `notificationclick`).

> **Checked against the code on 2026-09-30** (review of the branch that added it). Two of the
> claims above held only for the run that was measured.
> - **"None while a prompt sat for 8 s" was a run with no input.** `pushFor` fired on a new
>   `promptId`, and `trackPrompt` mints a new one for the SAME prompt once input reached the pty
>   and a reading `PROMPT_SETTLE_MS` later still says waiting — right for the answer route, wrong
>   for "is this a new prompt?". `PtyManager.write` counts every write but a terminal report, and
>   a mouse report is not one, so an arrow key in a permission menu, a wheel scroll or each pause
>   while typing an answer at the desk sent another high-urgency "Needs you". `PushState` now
>   carries the prompt's registry identity (`pushStateOf`; `samePrompt` compares `waitingFor` and
>   `statusUpdatedAt`, which the CLI moves only when it writes a status). Driven against the built
>   app with a stub `claude` whose prompt waited while the desk sent an arrow key, `y`, `e`, `s`
>   and an SGR wheel report: the phone row's `promptId` changed five times and the fake service
>   got nothing; then exactly "Needs you" (the second prompt) and "Finished". `verify:remote`
>   builds its states from `trackPrompt` with input between readings; keyed on the answer id,
>   three of its checks fail.
> - **The sheet's "On" was the browser's word, not the computer's.** It read On whenever the
>   browser held a subscription made with the current VAPID key, and only Turn on ever POSTed
>   one — so a replaced phone key (the owner re-scans the same phone), the ninth subscription
>   evicting the oldest, and a 404/410 drop each left it On while nothing arrived. Measured for
>   the first two against the old server state: the browser still held its subscription (the
>   old sheet's whole test for On) while the test route answered 404 "This phone is not
>   subscribed."; the old sheet itself was not driven. The
>   phone now re-sends a held subscription at every start and every sheet open (`confirm`, an
>   upsert that needs the current key, so a locked-out phone cannot enrol itself back), and main
>   remembers what a push service refused (`rememberGonePush`, by endpoint AND key, so a fresh
>   subscription at a reused endpoint passes) and answers its re-send 410, which drops the
>   browser's copy and reads Off with the reason. Driven: after a new key and a re-scan the boot
>   re-send moved the record to the new `keyTag` and a test arrived; after eight other
>   subscriptions evicted it, opening the sheet put it back and a test arrived; after the fake
>   service answered 410 the sheet read Off, the browser's copy was gone, and Turn on made a new
>   one that received.
> - **Driving it: grant notifications in a browser context of your own.** In headless Chrome for
>   Testing, `Browser.grantPermissions` on the DEFAULT context left `Notification.permission`
>   `default` (then `denied` after one `requestPermission`); `chrome-headless-shell` read `denied`
>   after the same default-context grant (a context of its own was not tried there).
>   `Target.createBrowserContext`, the grant with that `browserContextId`, then
>   `Target.createTarget` in it read `granted`. Know that the browser talks to Google's GCM by
>   itself: the run launched with `--disable-background-networking` still logged three
>   `registration_request.cc` errors (`DEPRECATED_ENDPOINT`), as the run without it had. That is
>   Chrome's own registration, not a subscription of Stoke's — `subscribe` was stubbed and every
>   endpoint Stoke POSTed to was the loopback fake — but it is a call to a real Google endpoint,
>   and no flag tried stopped it.

## 159. A replay of raw output is not a screen: a late attach gets the mirror's snapshot

**Reported 2026-10-04 as "sometimes I get back to my claude … it's mid scroll, or the chat is on the
very top", after "how do we deal with scrolling, missing status bar" about remote sessions.** A local
tab was not it: driven in the built app against real Claude Code 2.1.289 (full screen, this
machine's default), a tab switch, a pane narrowed and widened while hidden, the window down to 6 rows
and back, three blurs and refocuses, and a quit-and-Resume all left Claude's view where it was,
scrolled up or at the bottom. xterm's wheel sends at most one report per event, so it is not
oversensitive either.

The phone and the hub's remote tabs build their terminal from `historyFor` on every attach AND
every reconnect, and that was the last 512 KB of raw output (`MAX_HISTORY`). Two things go missing
once a session outgrows it, and a working session does within minutes:

- **The launch modes.** Claude's full screen sends `CSI ?1049h` once per session: recorded from a
  tab's first byte through a resize and a refocus, one, while it re-sent mouse reporting on three
  later redraws. A replay cut after it drew Claude's frames on the NORMAL screen with no mouse
  reporting, so the wheel scrolled stale frames instead of reaching Claude, taking the input box
  and the status line off the bottom. Measured on a 744 KB session: the replay (523,665 bytes)
  rebuilt a terminal reading `normal`, mouse `none`.
- **Everything drawn before the cut that has not changed since.** Claude repaints only what moves,
  so the same replay's bottom three rows were blank where the live tab showed `❯`, the rule and
  the footer. A remote tab that reconnects claims nothing (gotcha 151), so no resize made Claude
  repaint: the view stayed broken until something changed there.

**The fix is a screen, not bytes.** `ScreenMirror` (src/main/screenMirror.ts) is a headless xterm
per session fed every chunk, and `historyFor` serves its `snapshot()`: xterm's own serializer over
the normal screen (2000 lines of history, `MIRROR_SCROLLBACK`), the alternate screen when up, the
cursor and the modes. VS Code reconnects its terminals the same way. After, on a 724 KB session:
a 1,792-byte replay whose every row equals the live tab's, `alternate`, mouse `any`. Each of these
is load-bearing and `verify:remote` turns red without it:

- **A snapshot is synchronous; parsing is not.** `write` queues and the parser runs on a later
  turn, so each chunk stays in `unparsed` until its write callback (xterm runs it right after that
  chunk, before the next) and a snapshot is the serialized part plus the raw rest. An attach can
  then still send the replay and subscribe in one turn. xterm's `writeSync` would also do it, and
  is marked deprecated and unreliable: do not.
- **The serializer leaves modes out**: the mouse ENCODING (SGR 1006 is not on the public `modes`),
  cursor visibility, 2031. `ReplayModes` (src/shared/replayModes.ts), which follows xterm's own
  DECSET rules (one protocol, last set wins, any protocol reset turns tracking off, RIS resets),
  reads every chunk and its preamble closes the snapshot, without the screen.
- **Widths are xterm's defaults**, because the terminals replaying it (the phone's, RemoteTerminal)
  load no Unicode addon; a row serialized under other widths lands shifted there.
- A mirror whose write throws (xterm refuses past 50 MB queued) returns null, and `historyFor` falls
  back to the raw tail led by `ReplayModes`' preamble for the modes the dropped front set.

Two packaging traps: the add-on's typings import @xterm/xterm's, whose `/// <reference
lib="dom"/>` broke `fetch`'s types across main (remote/push.ts), so it is imported by its `.mjs`
path with the API declared in src/main/addonSerialize.d.ts; and @xterm/headless's package.json
names a `module` file it does not ship, so main's build aliases it to `lib-headless`. Cost: about
40 MB/s of parsing in main, in xterm's 12 ms slices (a Claude session prints KB a second); a
snapshot of 2000 log lines is 139 KB and 8 ms.

The renderer's own replay (`ptyBus`, 1 MB, on a TerminalView remount, which keys on `tab.id` and is
rare) gets only the `ReplayModes` preamble, so it keeps the right screen and mouse but can still
miss what was drawn before its cut. The old raw tail could carry a phone more inline history than
2000 lines. Not driven: RemoteTerminal over a real hub and a real phone (the built app was attached
through the phone socket and its replay rebuilt in a headless xterm), and Windows.
