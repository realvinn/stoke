---
paths:
  - "src/main/remote/*.ts"
  - "src/remote/*.ts"
  - "src/renderer/src/components/CloudflareSetup.tsx"
  - "src/renderer/src/components/PhonePopover.tsx"
  - "src/renderer/src/components/RemoteSettings.tsx"
  - "scripts/verify-remote.mts"
  - "scripts/verify-remote-security.mjs"
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
