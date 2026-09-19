---
paths:
  - "src/main/remote/*.ts"
  - "src/remote/*.ts"
  - "src/renderer/src/components/CloudflareSetup.tsx"
  - "src/renderer/src/components/PhonePopover.tsx"
  - "src/renderer/src/components/RemoteSettings.tsx"
  - "scripts/verify-remote.mts"
  - "scripts/verify-remote-security.mjs"
  - "scripts/verify-phone-ui.mts"
  - "src/shared/remotePhone.ts"
  - "src/shared/phoneUi.ts"
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
