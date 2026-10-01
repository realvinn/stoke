# Stoke Hub, self-hosted first: design and protocol contract

*Written 2026-10-01 on branch `windows-install` @ `a14031c` (v0.9.98). It supersedes the
deployment half of [2026-09-30-auth-hub-design.md](2026-09-30-auth-hub-design.md) (the public,
multi-tenant Cloudflare service) and keeps its threat model, prior art and non-goals, which are
not repeated here. Nothing was deployed and no agent CLI was run. **Measured** means run on this
Mac today; **UNVERIFIED** means read from documentation or inferred, and says what would prove it.*

The executable half of this document is the contract in `src/shared/hub/` (pure, both tsconfigs),
the node:crypto reference in `src/main/hub/crypto.ts`, and `npm run verify:hub`, which runs both
against each other and pins test vectors. Where the prose and the code disagree, the code is the
contract and the prose is a bug.

---

## 0. What happened to it, and what this changes

The owner asked (2026-10-01): *"what happened to turning stoke.vinn.dev into an authenticator to
store and transfer ssh and api keys and the remote thing between other logged into ones (that can
be hosted by my nuc for now)"*.

**What happened:** only Phase 1 of the 2026-09-30 plan shipped — keys sealed at rest in
`secrets.json` via `safeStorage` (`src/main/secrets.ts`, `SECRET_PATHS` in
`src/shared/secrets.ts`) and the passphrase-sealed `.stoke-setup` export/import
(`src/shared/setupFile.ts`). Phases 2–6 needed a public Cloudflare service (Durable Objects, D1,
GitHub OAuth, email codes, a legal page set), and none of it was started.

**What changes:**

| | 2026-09-30 design | This design |
|---|---|---|
| Where the server runs | A new Worker + Durable Objects + D1 + R2 in a second Cloudflare account | **One small Node 24 service on the owner's NUC**, SQLite (`node:sqlite`) on its disk |
| Public URL | `api.stoke.vinn.dev` | **`https://stoke.vinn.dev/hub`**, via a tiny separate edge Worker on the route `stoke.vinn.dev/hub/*` that forwards to a Cloudflare Tunnel on the NUC. The installer Worker is untouched |
| Before any routing exists | — | The hub URL is a Stoke setting; a LAN or Tailscale address works on day one |
| Sign-in | GitHub OAuth, passkeys, emailed codes | **Email + password**, first account from a **one-time invite the server prints**; scrypt server-side; lockout |
| Encryption | Device keys, signed device list, vault key, Recovery Kit, PAKE pairing | Same keys and list. Pairing is **numeric comparison with a commitment** (no PAKE: node:crypto has none). Items get **opaque ids**, so the server sees no paths |
| SSH | Per-device keys; private-key sync opt-in, discouraged | **Per-key opt-in private-key transfer is a first-class feature** (the owner asked for it), with the revocation cost stated in the UI |
| Remote run | Relay Durable Object | **The hub relays** WebSockets between two of the owner's devices, end-to-end encrypted between device keys; the host decides |
| Multi-user | Public sign-up | **Data model is multi-user** (accounts, invites, per-account rows); sign-up is by invite only |

Non-goals carried over unchanged (§2 of the old design): **no agent OAuth credential ever syncs**
(Claude, Codex, …: Anthropic's policy forbids it and refresh rotation makes it self-defeating),
no server-side recovery of content, no web vault, no session sharing between people, no waking a
machine.

---

## 1. Decisions in one screen

- **(a) Reaching the NUC.** `stoke.vinn.dev` keeps serving the installer from its Custom Domain
  Worker. A second Worker, `stoke-hub-edge`, is attached to the **route** `stoke.vinn.dev/hub/*`
  — a route on a hostname runs *before* that hostname's Custom Domain Worker (Cloudflare docs,
  §2.2) — and forwards HTTP and WebSocket upgrades to `https://hub-origin.vinn.dev`, a Cloudflare
  Tunnel hostname served by `cloudflared` on the NUC, adding a shared secret header the hub
  requires. The hub URL is a setting (`hub.url`), so `http://nuc.local:8788/hub` (the LAN
  listener, §2.3) or a Tailscale address works before any of that exists.
- **(b) Accounts.** Email + password, scrypt `N=2^17, r=8, p=1` on the hub; the first account
  comes from a one-time invite the hub prints on first start; further accounts from invites the
  owner mints. Sessions are opaque bearer tokens bound to one device key, and every
  authenticated request is also signed by that device (Ed25519). The password **opens nothing**:
  no key is ever derived from it.
- **(c) Crypto.** node:crypto only, measured identical under Node 26/OpenSSL and Electron 43's
  Node 24.18/BoringSSL. Per-device Ed25519 (sign) + X25519 (box) keys held via `safeStorage`; a
  random 256-bit vault key per epoch; items AES-256-GCM with an HKDF-derived key, their path bound
  through an HMAC id the AAD carries; a hash-chained, signed device list the hub cannot extend;
  pairing by approval on an existing device with a 6-digit code both screens show; a 128-bit
  Recovery Kit; revocation rotates the vault key and re-seals everything.
- **(d) Sync.** T1 portable settings (reusing `PORTABLE_KEYS`/`PARTIAL_KEYS`), T2 portable API
  keys (`SECRET_PATHS` with `portable: true`, behind an account-level switch the owner ticks once,
  then on for every signed-in device unless that device opts out), T3 SSH host definitions, T4
  SSH private keys opt-in per key. One item per key/host/secret; per-item versions with
  compare-and-swap on the hub; conflicts resolved last-writer-wins by edit time, with a visible
  note naming what lost.
- **(e) Remote.** Every signed-in desktop keeps a presence WebSocket to the hub. Another device
  asks the hub for a relay to it; both ends open relay sockets; a SIGMA-style handshake between
  device keys the chain vouches for derives per-direction AES-GCM keys; inside run the existing
  phone API requests and pty frames. The host holds grants (`view` or `full`) per device; the
  first attach from a device asks on the host.
- **(f) Threat model and runbook** in §7: what the NUC, Cloudflare and a stolen password can and
  cannot do; SQLite backups with `VACUUM INTO`; what the owner runs.

---

## 2. Topology: how `stoke.vinn.dev` reaches the NUC

```
 Stoke (Mac)  ─┐                                   Cloudflare edge                         NUC (home)
 Stoke (Win)  ─┼─ https://stoke.vinn.dev/hub/v1/… ─► route stoke.vinn.dev/hub/*               ┌──────────────┐
 Stoke (Linux)─┘   (HTTP + WebSocket upgrades)        Worker "stoke-hub-edge"                   │ cloudflared  │
                                                        - strips client x-stoke-hub-edge        │  tunnel      │
                                                        - adds x-stoke-hub-edge: <secret>  ───► │  ──► 127.0.0.1:8787
                                                        - adds x-stoke-client-ip                │  stoke-hub   │
                                                      fetch https://hub-origin.vinn.dev/hub/…   │  (Node 24,   │
                                                                                                 │  node:sqlite)│
   everything else on stoke.vinn.dev ─► Custom Domain Worker "stoke-install" (unchanged)        └──────────────┘
                                                                                                   ▲
 Stoke on the LAN / tailnet ── http://nuc.local:8788/hub  or  https://nuc.<tailnet>.ts.net/hub ───┘ (LAN listener,
                                                                                                     no edge secret)
```

### 2.1 Why a separate edge Worker, not a branch in the installer Worker

- **The installer's blast radius stays where it is.** The old design's N7 and gotchas 70/71 hold
  that "whoever can deploy this Worker can run code as the user on every machine that runs the
  one-liner". Folding a proxy into `worker/index.ts` would put a secret in that Worker and a code
  path unrelated to installing into the one artefact that must stay auditable byte for byte. A
  separate Worker holds the secret; deploying it cannot change what `curl | sh` runs.
- **Precedence is documented.** Cloudflare, *Custom Domains › Request matching*: when both a
  Custom Domain and a route exist for the same hostname, the route runs first, and "Any Workers
  running on routes before your Custom Domain can optionally call the Worker registered on your
  Custom Domain by issuing `fetch(request)`." So `stoke.vinn.dev/hub/*` reaches the edge Worker and
  every other path reaches the installer, with no change to `worker/route.ts` or
  `worker/index.ts`. `verify:install` holds the split: the two wrangler configs (names, the one
  route, never a custom domain), who answers which URL, and the edge Worker's forwarding.
- **No new certificate or DNS record for the public name.** A route rides on the existing proxied
  `stoke.vinn.dev` record, so gotcha 77's ~30-minute NXDOMAIN gap does not apply to it. It DOES
  apply to `hub-origin.vinn.dev`, the tunnel hostname `cloudflared tunnel route dns` creates: if it
  NXDOMAINs after creation, prove the gap with 77's `curl --resolve` before touching anything, and
  remember gotcha 58 — the route cannot be read back, only probed.
- The route pattern is `stoke.vinn.dev/hub/*`, not `/hub*`, so `/hubba` and bare `/hub` stay the
  installer's (the landing page). Clients only ever call `/hub/v1/…`.

### 2.2 Can a Worker carry the WebSocket? Yes — with two cautions

Cited, not measured (nothing was deployed):

- Workers open an outbound WebSocket with `fetch()` and an `Upgrade: websocket` header, and get
  the socket back as `resp.webSocket` (Workers *Compatibility flags* page, and the *WebSockets*
  runtime API page: "use `fetch()` with the `Upgrade: websocket` header instead, then call
  `resp.webSocket.accept(…)`").
- A Worker answers a client's upgrade with `new Response(null, { status: 101, webSocket: client })`
  from a `WebSocketPair`, and the Sandbox *Previews* page shows the complete relay of an upstream
  socket obtained that way (`bridge(upstream)`), noting that "a connection that only passes
  through" is also possible. **The edge Worker uses the bridge** (accept both ends, forward each
  message, map close codes 1005/1006 to 1000): it is the pattern the docs show end to end, and it
  lets the Worker count bytes. Returning the origin's upgrade response directly is **UNVERIFIED**
  and not relied on.
- **Caution 1 — eviction.** Workers *Best practices*: "Plain Workers can upgrade HTTP connections
  to WebSockets, but they lack persistent state and hibernation. If the isolate is evicted, the
  connection is lost." So every long-lived socket in this protocol (presence, relay) is designed to
  be dropped: presence reconnects with backoff and re-reads state; a relay that drops is
  re-requested and re-handshaken (§6.6). Nothing is lost when a socket dies.
- **Caution 2 — sizes and idle.** A message received by a Worker is capped at 32 MiB (*WebSockets*
  runtime API). The protocol caps a relay frame at 1 MiB and a presence frame at 64 KiB. Presence
  and relay ping every 25 s so no proxy along the path sees an idle connection (a precaution; the
  exact idle limit on this path is UNVERIFIED).
- Cloudflare proxies WebSockets on the tunnel hostname "without additional configuration"
  (*Network › WebSockets*); `cloudflared` carries them to the origin.

### 2.3 Worker → origin authentication

- **Two listeners, two ports.** The edge listener is `127.0.0.1:8787` and the optional LAN
  listener defaults to port **8788**. An earlier draft of this document gave the LAN URL as
  `:8787`, which works only if the LAN listener binds the NUC's own LAN address, not
  `0.0.0.0`: beside a listening `127.0.0.1:8787`, a wildcard bind on the same port is accepted
  on macOS (measured with node: it binds) but, as far as Linux's `SO_REUSEADDR` rules go,
  refused there with `EADDRINUSE` (UNVERIFIED: no Linux machine here). Either way it is a trap
  for the first person to follow §7.4, so the ports are simply different. The LAN listener
  also refuses any request carrying Cloudflare's headers (`cf-ray`, `cf-connecting-ip`,
  `cf-worker`) or Tailscale Funnel's, and either edge header: those mean a tunnel was pointed at
  the port that asks for no secret, i.e. the public internet reaching it.
- **The hub requires `x-stoke-hub-edge: <secret>` on its edge listener** (loopback, which
  `cloudflared` targets), compared in constant time. The edge Worker deletes any client-supplied
  copy of that header, and of `x-stoke-client-ip`, before adding its own; the secret is a Worker
  secret (`wrangler secret put HUB_EDGE_SECRET`) and an environment variable on the NUC.
- **Why a header and not only Cloudflare Access.** Whether Access applies to a Worker's
  subrequest to another hostname in the same zone is **UNVERIFIED**; if it does not, a
  `cloudflared` configured with `access.required: true` (Tunnel *origin parameters*) would refuse
  every forwarded request. So the header is the authority, checked by the hub itself, and an Access
  application with a Service Token policy on `hub-origin.vinn.dev` is optional hardening against
  direct internet requests (the Worker then also sends `CF-Access-Client-Id`/`-Secret`). Do not set
  `access.required` in `cloudflared` until a forwarded request has been measured passing it.
- **What a leaked edge secret buys:** direct requests to the tunnel hostname that the hub treats as
  forwarded — i.e. a forged `x-stoke-client-ip`, which weakens per-IP throttling. It opens no
  account and no content (§7).
- **Later, no public origin at all:** Workers VPC can bind a Worker to a tunnel with no public
  hostname (`vpc_services` / `vpc_networks`, beta, free while in beta). Adopt it only after a
  WebSocket upgrade through a VPC binding has been measured; the docs show HTTP `fetch()` and raw
  `connect()`, not upgrades.

### 2.4 The hub URL in Stoke (before, and instead of, all of the above)

`hub.url` is a setting; `hubUrlVerdict` (src/shared/hub/edge.ts) decides it:

- `https://` anywhere. A bare origin gets `/hub` appended (`https://stoke.vinn.dev` →
  `https://stoke.vinn.dev/hub`); any other path is kept, so a reverse proxy may mount the hub
  anywhere. No credentials, query or fragment.
- `http://` only to a loopback, RFC 1918, Tailscale CGNAT (100.64/10), `*.local` or `*.ts.net`
  host, and the verdict carries a warning the panel shows: on plain http a LAN observer can read
  the session token. That token cannot WRITE anything (every request is device-signed, §3.4) and
  cannot read content (E2E), which is why LAN http is tolerable at all.
- Every request path is `<base>/v1/…`, and signatures cover the path from `/v1/` on, so the mount
  point never enters a signature.

**A 200 is not a success (gotcha 71).** Bot Fight Mode, Browser Integrity Check and managed
challenges answer with an HTML page and status 200. Every hub response is JSON with a known shape;
`readHubResponse(status, contentType, text)` refuses anything else before a byte is parsed, and the
owner's runbook (§7.4) adds a WAF skip rule for `/hub/` or confirms Bot Fight Mode is off.

---

## 3. Accounts and sign-in (kept separate from encryption)

### 3.1 First run: the bootstrap invite

On start with **no accounts**, the hub mints a one-time invite, prints it on stdout (the systemd
journal) and keeps only its SHA-256:

```
stoke-hub: no accounts yet. Sign up from Stoke with this invite (valid 24 h, one use):
  INV-7K3M-QX9D-2HPA-V8RT-C4WE-JN6B
```

A restart with still no accounts revokes the old one and prints a new one. The account created
with it has `role: 'owner'`, and an owner can mint more invites (`POST /v1/auth/invites`, or
`stoke-hub invite` on the NUC), each one use, 7 days. There is no open sign-up. Invite format:
`INV-` + 24 Crockford base32 characters (120 bits) in groups of four; `parseInvite` accepts any
case, spaces, and the usual O/0, I/L/1 confusions.

### 3.2 Accounts, passwords, sessions

- **Email** is an identifier, never mailed: trimmed, lowercased, ≤ 254 characters, one `@` and a
  dot after it (`normalizeEmail`).
- **Password** 12–1024 characters, not all whitespace (`passwordProblem`), NFC-normalised before
  hashing (so an é typed on two keyboards is one password); hashed with scrypt
  `N=2^17, r=8, p=1`, 16-byte salt, 32-byte output, stored as
  `scrypt$17$8$1$<salt b64url>$<hash b64url>` (`formatPasswordHash`/`parsePasswordHash`).
  Measured on this Mac: 263 ms under Node 26, 501 ms under Electron 43's Node — the NUC's cost
  will be in that range, which is the point. A login for an unknown email still runs one scrypt
  against a dummy hash, so timing does not enumerate accounts; both failures read "That email and
  password do not match an account on this hub."
- **Sessions:** `sht_` + 32 random bytes (b64url). The hub stores its SHA-256, the account, the
  device id and that device's signing key; 30-day sliding expiry, touched at most once a day.
  Logout deletes the row; revoking a device (§4.6) deletes every session bound to it.
- **Password reset** is an owner action on the NUC (`stoke-hub reset-password <email>`), and it is
  safe precisely because the password opens nothing: a reset changes who can SIGN IN, never what
  anyone can DECRYPT.

### 3.3 Throttling and lockout (`src/shared/hub/auth.ts`, pure)

Two counters, both kept by the hub, both judged by `throttleVerdict`/`recordLoginFailure`:

| Key | Rule | Then |
|---|---|---|
| Normalised email (known or not) | 5 failures inside 15 min | locked 15 min, doubling per repeat lockout, capped at 24 h; a success clears it |
| An active device's PROVEN sign-in (below), instead of the email | the same | the same, on `device:<account>:<id>`; a proven success clears only this |
| Client IP (`x-stoke-client-ip` from the edge, else the socket's), IPv6 as its /64 | 30 failures inside 15 min | refused 15 min |

Refusals are HTTP 429 `{error: 'locked' | 'rate-limited', retryAfterMs}`. Invite redemption and
signup share the IP counter.

> **2026-10-02 (review of the server).** Every per-client limit — the request bucket, the IP
> counter, sign-ins in flight per IP, the refusal log — is keyed by `clientKey` (hub/limits.ts):
> an IPv6 address counts as its /64, an IPv4-mapped one as its IPv4. Keyed by the full /128, one
> subscriber rotating the low 64 bits had unlimited buckets, filled the shared scrypt queue with
> unknown-email sign-ins, and every proven sign-in of the owner's device came back "busy" — the
> promise below did not hold. So a proven sign-in also has a scrypt slot and queue of its own, a
> "busy" refusal counts against the sender's IP counter, the refusal log has a cap across all
> senders, and an `ip:` row is swept once its window has passed and it is unlocked (an IP lock
> never escalates, so a day of memory bought nothing but rows).

**The owner's own devices are not locked out by a stranger (found in review, 2026-10-01).** The
email lock is judged before the password and refuses the right one too, so anyone who knows the
address could send five guesses every quarter-hour and keep every device from signing in again,
the lock doubling to a day; per-IP counters do not stop a distributed sender. So a device the
account's chain already lists signs its sign-in like any request (§3.4's four headers, no bearer,
by the key the chain holds for its id): verified, within the skew and with a fresh nonce, the
attempt is judged by that device's own counter, which only its key can trip, and a success there
leaves the email locked for everyone else. Anything short of a proof is simply the email's case.
What remains: a NEW device cannot sign in while the email is locked (`stoke-hub reset-password`
clears it; an attacker can lock it again).

### 3.4 Every request after login is device-signed

A device creates its keys (§4.2) BEFORE it signs in, and `POST /v1/auth/login` carries its public
keys, so the session is bound to them. Every later request carries:

```
authorization:   Bearer sht_…
x-stoke-device:  d…            (the device id)
x-stoke-ts:      <ms since epoch>
x-stoke-nonce:   <16 random bytes, b64url>
x-stoke-sig:     Ed25519 over requestSigningText(method, pathFromV1, ts, nonce, device, sha256(body))
```

The hub refuses a skew beyond ±5 min (`clock-skew`), a nonce seen from that device in the last 10
min (`replayed`), and a signature that does not verify under the session's bound key
(`bad-signature`). Consequences: a stolen token alone cannot make any request at all — read,
write or pair — and on plain-http LAN use an observer sees the token and the ciphertext passing,
never anything they can act on. A device the chain does not (yet) list is **pending**: it may
only use the pairing and recovery routes (§4.4, §4.5).

### 3.5 Multi-user data model (SQLite on the NUC)

Tables the server agent creates (names are a suggestion; the rows are the contract):
`accounts(id, email, pw_hash, role, created_at, status)`, `invites(hash, created_by, expires_at,
used_by)`, `sessions(token_hash, account_id, device_id, sign_pub, created_at, seen_at, expires_at)`,
`chain(account_id, seq, entry_json, link_hash)`, `wraps(account_id, epoch, device_id, wrap_json)`,
`recovery(account_id, epoch, wrap_json)`, `items(account_id, id, version, epoch, envelope_json,
seq)`, `pairs(id, account_id, state, …, expires_at)`, `login_failures(key, count, first_at,
locked_until, lockouts)`, `nonces(device_id, nonce, seen_at)`. Every content row is keyed by
`account_id`; nothing is shared between accounts, so a public multi-tenant service later is a
deployment change, not a data-model change. **Relays are not a table** (an earlier draft listed
`relays(id, account_id, guest, host, created_at)`): a relay is two live sockets, meaningless
after a restart, so the server (`hub/sockets.ts`) holds them in memory and a guest simply asks
for a new one. Login-failure keys are `email:<sha256 of the normalised email>` and
`ip:<address>`, so the table never lists what strangers typed.

---

## 4. End-to-end crypto (node:crypto only)

### 4.1 Primitives, and what was measured

Ed25519 (`crypto.sign(null, …)`), X25519 (`crypto.diffieHellman`), HKDF-SHA-256
(`crypto.hkdfSync`), AES-256-GCM (12-byte random nonces for stored data, counter nonces for relay
channels), HMAC-SHA-256, SHA-256, scrypt. **Measured today** with the same script under Node
26.7/OpenSSL 3.5.7 and under Electron 43's Node 24.18/BoringSSL (`ELECTRON_RUN_AS_NODE=1`):
identical public keys from identical seeds, working X25519 agreement, HKDF, Ed25519
sign/verify; an all-zero (low-order) X25519 peer key is refused by both (different error codes:
`ERR_OSSL_FAILED_DURING_DERIVATION` vs `ERR_OSSL_EVP_INVALID_PEER_KEY`, so code must catch, never
match the code). A raw private key must be imported as PKCS8 DER with the fixed 16-byte prefix —
a JWK carrying only `d` is refused ("Invalid JWK OKP key") by both.

Domain separation: every KDF info string, signed text and AAD starts with a label from
`HUB_LABELS` (`src/shared/hub/labels.ts`), `stoke-hub/v1/…`, followed by `\n` and the
`canonicalJson` of its fields (keys sorted at every depth, no whitespace, NaN/Infinity/non-plain
objects refused; every field a signature covers is a string or an integer, so another language
never has to reproduce JavaScript's float formatting). `verify:hub` pins test
vectors over all of them: **changing a label makes every item and wrap already on a hub
unreadable**, so a label change fails the suite until it is a deliberate v2.

### 4.2 Keys

```
Device d:  sign_d   Ed25519 keypair   (private: the raw 32-byte seed, sealed with safeStorage)
           box_d    X25519 keypair    (same)
Account:   VK_e     32 random bytes, epoch e = 1, 2, …   (never on the hub unwrapped)
           RS       Recovery Secret, 16 random bytes      (the Recovery Kit only)
Derived:   itemKey_e = HKDF(VK_e, info = item-key {account, epoch})       AES-256-GCM key
           idKey_e   = HKDF(VK_e, info = item-id  {account, epoch})       HMAC key for item ids
           vk_e      = HKDF(VK_e, info = vk-commit {account, epoch})      public: signed into the chain
           RK        = HKDF(RS, salt = account, info = recovery-wrap)     wraps VK_e
           rsign     = Ed25519 from seed HKDF(RS, salt = account, info = recovery-sign)
```

**Why `vk_e` exists (found in review, 2026-10-01, before any hub held data).** A wrap of `VK_e` to a
device is an ephemeral X25519 box: it proves only that *somebody* sealed a key to that device's
PUBLIC box key — which the hub, the Cloudflare edge or anyone on a plain-http LAN path can do, with
a key of their own choosing. Without something to compare against, a device joining (§4.4 step 5)
or fetching a new epoch after a revoke (§4.6) would take a planted key and seal its API and SSH keys
under it, and the planter could forge items it would apply. So the entry that OPENS each epoch
(genesis, revoke, rotate) carries `vk_e`, covered by its signature, and `unwrapVaultKey` /
`openRecoveryWrap` take the verified chain's `vkCommits[e]` and refuse any other key. The hub cannot
sign a chain entry, and `vk_e` reveals nothing of `VK_e` or of the keys derived from it under other
labels.

**Where the private keys live:** `<userData>/hub-device.json`, mode 0600, each private key sealed
by `safeStorage` with the path-bound prefix `sealedText` already uses. A run whose key store
`judgeProtection` calls unprotected (Linux `basic_text`, none) may sign in but **must not join the
vault**, and the panel says why — the same honesty rule as secrets.json. The vault keys the device
holds (`VK_e` per epoch) live beside it, sealed the same way, in `<userData>/hub-state.json`
together with the pinned chain head, the item cursor and pinned versions, and the conflict notes.
Both files are T0 and never enter settings.json (a sync must not churn the settings writer,
gotcha 63). Sandboxes use `--use-mock-keychain`.

### 4.3 The signed device list (the hub cannot extend it)

An append-only chain, one row per entry, verified in full by every client (`verifyChain`,
src/shared/hub/chain.ts, with the signature and digest functions injected):

```
ChainEntry = { v: 1, account, seq, prev, kind, epoch, ts, signer, device?, target?, recovery?, vk?, sig }
  kind      'genesis' | 'add' | 'revoke' | 'rotate'
  prev      '' for genesis, else chainLinkHash(entry[seq-1])   (b64url SHA-256, sig included)
  signer    a device id active at that point, or 'recovery'
  device    { id, label, platform, sign, box, caps, addedAt }   (genesis, add)
  target    the revoked device id                               (revoke)
  recovery  b64url Ed25519 public key of rsign                  (genesis; rotate may replace it)
  vk        b64url vk_e, the commitment to the new epoch's key  (genesis, revoke, rotate; never add)
  sig       Ed25519 over chainSigningText(entry without sig)
```

Rules: genesis is seq 0, self-signed by its own device, epoch 1, and names the recovery key; each
later entry's `seq`, `prev` and `account` chain exactly; `add` introduces an id never seen before
and keeps the epoch; `revoke` removes an active device and **increments** the epoch; `rotate`
increments the epoch (and may replace the recovery key: a regenerated Kit). The signer must be
active at that point, or `recovery` verified against the recovery key in force. Clients **pin**
`{seq, head}` and judge every served chain with `compareToPinned`: `same`, `extends`, `rollback`
(shorter) or `fork` (a different entry at a pinned seq). Rollback and fork are shown as an alarm
and nothing is written until the owner acts (§7.3 covers a legitimate restore).

Device labels and platforms are plaintext to the hub (a self-hosted simplification the old design
encrypted); everything else about a device the hub holds is its public keys.

### 4.4 Pairing a new device: approval with a 6-digit code (commit, then reveal)

A new device N signs in (pending) and asks to join; an existing active device E approves.
node:crypto has no PAKE, so this is **numeric comparison with a commitment** — the shape of
Bluetooth Secure Simple Pairing and ZRTP's short authentication string — and it gives a malicious
hub exactly one guess at a 1-in-a-million code:

1. N makes a random 32-byte `nN` and posts `commit = sha256(pairCommitText(account, N's device
   record incl. keys, nN))` → the hub creates pair `p…`, state `waiting`, expiring in 10 min, and
   pushes it to E over presence.
2. E's panel shows the request (label, platform). E posts its own random `nE` and its device id →
   state `nonce`. The hub serves E's public keys from the chain.
3. N posts its full device record and `nN` (the reveal) → state `revealed`. E checks the
   commitment; a mismatch refuses the pair.
4. Both compute `sas = sasDigits(sha256(pairSasText(account, pairId, N's keys, E's keys, nN,
   nE)))` — six digits shown as `482 915` — and the owner confirms they match. E then appends an
   `add` entry for N and uploads `wrap(VK_e → box_N)` in one `POST /v1/chain`; the hub marks the
   pair `approved`.
5. N fetches the chain, verifies it, checks the `add` names exactly its own keys and is signed by
   the E whose keys entered the code, pins the head, unwraps VK_e — refusing it unless it matches
   the chain's `vkCommits[e]` (§4.2) — and syncs.

Why it holds: N commits to its keys and nonce before anyone learns `nE`, and `nE` arrives before N
reveals, so a hub that substitutes keys toward either side must fix its own values before the last
random value is known — its forgery matches the code the owner sees with probability 10⁻⁶, once.
A hub that impersonates E to N fails the same way: E's keys are inside the code. Refusing, an
expired request, or three mismatched attempts in an hour end the pair; every request shows on
every active device, so an unexpected one is visible.

> **Built 2026-10-01, after review of the hub client.** Step 4's "the owner confirms they match"
> must happen on N as well as on E. The first client let N finish on its own once the hub said
> `approved`; then a hub that plays E — a fake E in a list it built, or any list N had no anchor in —
> needs no collision at all: the owner's real devices never show the request, and N joins the hub's
> vault. N now shows "The codes match" / "They don't" and takes nothing, approved or not, until the
> owner presses the first (`joinConfirm`); the second refuses the pair. The approver the hub names
> is checked against the verified list in every state that computes the code, `revealed` included.
> And a device counts itself in a vault only where the served chain holds its own **anchor**: the
> link of the entry it entered through (its genesis, the `add` it accepted after confirming the
> code, or its Kit `add`), kept in hub-state.json and dropped only by signing out. `verifyChain`
> accepts any self-signed genesis, so without the anchor a hub could answer a device's FIRST
> sign-in with a list of its own — its genesis, then an `add` of the keys the device had just
> posted — and a vault key of its choosing; the device would upload every portable key under it. A
> list that names the device without its anchor is the `chain` alarm.

### 4.5 The Recovery Kit

Generated with the account's genesis. 16 random bytes shown as `RK1-` + 26 Crockford base32
characters + one mod-37 check symbol, in groups of four (`formatRecoverySecret`); the owner must
type back one group before continuing. The hub stores `recoveryWrap = AES-GCM(RK, VK_e)` per epoch
and the chain holds `rsign`'s public key. **Recovery path** (no device left): sign in as a pending
device, type the Kit (`parseRecoverySecret` tolerates case, spaces and look-alikes, and the check
symbol catches a typo before any crypto runs), verify the chain, fetch the recovery wrap, unwrap
`VK_e` against the chain's `vkCommits[e]`, sign an `add` for yourself with `signer: 'recovery'`,
and then **rotate** (a Kit that has been typed may have been seen). Lose every device and the Kit and the data is gone; the panel says so in those
words, as the old design's §6.6 did.

> **Built 2026-10-01, after review of the hub client.** The rotate is not advice: `recover` checks
> the typed Kit, opens its wrap against the commitment, then makes a NEW Kit and shows it, and only
> when that is confirmed posts the `add` (signed by the typed Kit) and a `rotate` naming the new Kit
> in one append (`postRecovery`), with wraps for the new epoch only — so the typed Kit never opens an
> epoch the device is in, and nothing is posted if the owner walks away.

### 4.6 Revocation rotates the vault key

From any active device (or the recovery key): make `VK_{e+1}`, commit to it in the entry (`vk`),
wrap it to every remaining active device and re-wrap the recovery copy, then post the `revoke`
entry **with** those wraps in one request — the hub applies both or neither and deletes the revoked device's sessions at once. The
revoker then re-seals every item under epoch e+1 (kilobytes: settings, keys, hosts) and prunes the
old epoch. The hub refuses any put whose epoch is not the account's current one (`stale-epoch`), so
a device that was offline fetches its new wrap and retries. The panel lists **what the revoked
device held** — which T2 keys and which T4 SSH keys — with a sentence per key: rotation stops
future reads, it cannot un-read the past, so rotate those at their provider and take a transferred
SSH key off its hosts. Claim-before-await (gotcha 20): the hub serialises chain appends per account
(the loser gets `chain-conflict` and rebases).

> **Built 2026-10-01 (the desktop client, gotcha 141):** "re-wrap the recovery copy" needs the Kit's
> wrap key RK, and no device keeps it. RK never changes for a Kit's life and the recovery wrap is
> readable from a pending session, so a removed device that kept RK could open every later epoch
> with the password. The client asks for the Kit at revoke (typed, used once), or makes a new Kit
> and posts `revoke` + `rotate` in one append (wraps for the final epoch only), shown and confirmed
> before anything is posted.
>
> **And a typed Kit is useless against a device that has had it** (review of the hub client,
> 2026-10-01): the device that made the current Kit (it was shown there; "Save as file…" wrote it
> there), any device added with it, and any device that had it typed to remove another can open the
> new epoch's recovery wrap as a pending session with the password. `kitHandlers` reads them off
> the verified chain; removing one of them requires a new Kit, and the panel says why.
>
> **Only the current epoch is applied.** Every epoch after 1 was opened by a revoke or a rotate, to
> shut someone out, and whoever was shut out keeps the older keys: an item sealed under an older
> epoch may be a rollback the hub kept or a forgery by a removed device, and rollback detection is
> per item id, which changes with the epoch. So `pull` never applies one, or even opens it. A
> re-seal the revoker could not finish is owed and retried on its next pass (`resealOrOwe`), and
> every other device, once per epoch, carries forward under the new key each older item it had
> agreed on value for value (`carryForward`) — without that, an interrupted re-seal leaves the vault
> empty to anyone who joins after. Older vault keys are dropped once every record is under the
> current epoch and no re-seal is owed.

### 4.7 Item sealing, and why the path is bound through an id

```
id         = 'i' + b64url(HMAC-SHA256(idKey_e, utf8(path)))[first 24 bytes]
AAD        = itemAadText({account, id, version, epoch, author})
plaintext  = canonicalJson({path, editedAt, deleted, value})
envelope   = { v: 1, id, version, epoch, author, nonce, ct }      ← all the hub stores
```

The brief for this design said "the item path as AAD". Taken literally that puts every path in
front of the hub — `t2/secret/providers.anthropicApiKey` announces the owner has an Anthropic
key, and `t4/ssh-key/…` names their SSH keys. So the hub sees an opaque id, the AAD binds that id (plus version, epoch and
author), and the reader re-derives the id from the decrypted path and refuses any mismatch
(`openItem` does both). A ciphertext moved to another slot, replayed at another version or epoch,
or relabelled with another author fails the GCM tag; a slot whose plaintext names a different path
fails the id check. Same guarantee, no paths on the NUC.

---

## 5. What syncs, and how conflicts resolve

### 5.1 Tiers and item paths (`parseItemPath`, src/shared/hub/items.ts)

| Tier | Path | Value | Default |
|---|---|---|---|
| T0 | — | never leaves the device: `LOCAL_KEYS` (setupFile.ts), `hub.*` itself, `remote.token`, `remote.push.vapidPrivate`, `accounts.*.apiKey`, browser partitions, agent OAuth credentials, anything under `~/.ssh` not explicitly chosen | — |
| T1 | `t1/settings/<key>` | `portableSettings(s)[key]`, secrets emptied. `<key>` ∈ `T1_KEYS` = `PORTABLE_KEYS` minus `hosts`, plus the `PARTIAL_KEYS` blocks `wallpaper`, `browser` | on (`hub.sync.settings`) |
| T2 | `t2/secret/<secret path>` | the key string; a tombstone clears it | the account switch `acct/pref/sync-keys` (owner ticks once) AND `hub.sync.keys` (per device, default true) |
| T3 | `t3/host/<syncId>` | `SshHost` minus its settings `id`, `keyEnrolled` and `syncId`, plus `reach` (HostName/User/Port/ProxyJump from `ssh -G`) and `keyRefs` (T4 ids). Keyed by a SYNC id (`h…`), never `SshHost.id` — see below | on (`hub.sync.hosts`) |
| T4 | `t4/ssh-key/<keyId>` | `{name, privateKey, publicKey, comment, fingerprint, passphrase: bool}` | **off; per key**, uploaded only when the owner picks that key |
| — | `acct/pref/sync-keys` | `{on: boolean}` | off |

`verify:hub` holds `T1_KEYS` to the portable half of the settings partition, so a new portable
setting fails the suite until it is placed.

**Why hosts need a sync id (gotcha 139).** `SshHost.id` is a per-machine counter — HostsSettings'
`newHostId` hands out the first free `host-N` — so two machines' `host-1` are usually two different
servers. Measured today against the shipped Phase 1 import: a Windows profile with `host-1` = NUC,
importing a Mac setup with `host-1` = VPS, ends with only VPS, and the preview says "SSH hosts:
updates VPS". So T3 keys a host by `syncId` (`h` + 16 base32, minted the first time a host is
uploaded and stored on the host; `hydrateSettings` keeps it because it spreads `...h`), and
`parseItemPath` refuses `t3/host/host-1`. The import's own merge is **not** fixed by this change;
gotcha 139 records the fix (the same matching rule as §5.3).

### 5.2 Versions and conflicts (`putVerdict`, `decideConflict`, `nextEditedAt`)

- **The hub's rule** (pure, `putVerdict`): an envelope must be well formed, its epoch must be the
  account's current one, the put's `baseVersion` must equal the slot's current version (0 when
  new), and `envelope.version` must be `baseVersion + 1`. Else 409 with the current envelope. Each
  accepted put also takes the account's next `seq`, which is the change feed's cursor
  (`GET /v1/items?since=<seq>`).
- **Deletion** is a put of a tombstone (`deleted: true`, `value: null`), so deletes are edits and
  resolve like one. Tombstones are kept 90 days; a device away longer does a full resync in which
  the hub's copy wins and local-only values are OFFERED, not pushed.
- **Edit time** is a hybrid clock: `editedAt = max(now, last + 1)` in ms, per device.
- **A conflict** (409) is decided by `decideConflict(mine, theirs)`: the later `(editedAt,
  author)` wins, deterministically on every device. If mine wins, re-put on top of theirs; if
  theirs, drop mine. Either way a **conflict note** records the path, a human label, which side
  was kept and the other device and time, and the panel lists notes until dismissed: "Theme: your
  change on this Mac (10:02) replaced the one from Windows PC (10:01)."
- **Rollback detection:** clients pin the highest version seen per id; a served version below the
  pin is `versionRegression` → the same alarm as a chain rollback.
- **No phantom writes (gotcha 116).** A device uploads a T1 key only when
  `stableJson(hydrated local slice) !== stableJson(last synced slice)`, both hydrated the same
  number of times; `hydrateSettings` is not idempotent, and a phantom diff here would be a phantom
  WRITE on every device on every sync.

### 5.3 Applying what arrives (`applySyncedSettings`)

A synced T1 key **replaces** the local value (it is the whole truth for that key; the one-shot
import's union-by-id would make a deletion never propagate), with two guards shared with
`mergeSetup`: a synced `defaults.permissionMode: 'bypassPermissions'` is never applied unasked
(kept local, and reported as skipped), and every local secret is overlaid back afterwards so a
scrubbed incoming `providers`/`agents`/`voice` block never erases a key. A PARTIAL block
(`wallpaper`, `browser`) replaces only its portable sub-keys. T3 hosts match by **sync id**; a local
host with no sync id whose alias AND command equal an incoming host's adopts that sync id (the same
server, known on both machines before either synced — reported as `adopted`); anything else is
appended under a free local `host-N` (`freeHostId`); `keyEnrolled` stays the device's own; a
tombstone removes. T2 values overlay last, only for portable secret paths, and a tombstone empties
the key. The result is raw; the client runs `hydrateSettings` and writes through `setSettings` like
any other change, so gotcha 63's coalescing and the secret vault apply unchanged.

> **Built 2026-10-01, after review of the hub client: what runs code is held.** An incoming item
> that would change what runs on the device — a new or changed MCP stdio program, its arguments or
> a new variable name, a new value for a stdio server's variable, a new or changed MCP URL, a host
> told to run a command — is not applied (`heldChangesFor`); the local value stays, and Settings ›
> Account & sync lists it with the command spelled out (a variable named, never shown) and "Apply on
> this computer" / "Keep this computer's". Anyone who can seal an item — a device before it is
> removed, which removing undoes nothing of — could otherwise run a command at every device's next
> session. The revoke report names what synced runs something, for the owner to check.

### 5.4 SSH private keys (T4): transfer by explicit choice

- **Upload:** Settings lists the `~/.ssh` key pairs by name (a file with a `.pub` beside it — the
  `.pub` is what is read to list it); a private key's bytes are read only when the owner picks
  that key. They travel as-is — a passphrase-protected key stays passphrase-protected — plus its
  `.pub`. The item is immutable: a changed key is a new id.
- **Receive:** `sshKeyTarget(wanted, probe)` picks the file name: the wanted name if free; the
  same name if an identical key is already there (reused, nothing written); else `<name>-stoke-2`,
  `-3`, … Never overwrite, never write `config`, `known_hosts`, `authorized_keys` or a dotfile.
  Written with mode 0600 (the `.pub` 0644) into `~/.ssh` (0700 if created), each created with the
  exclusive flag (`wx`), never renamed over a name — a file that appeared since the probe makes the
  write fail rather than replace it.
- **Use:** for every synced T3 host whose `keyRefs` name that key, append a `Host`/`IdentityFile`
  block exactly as `saveKeyLocally` does (`buildIdentityBlock` + `appendToSshConfig`: append-only,
  `config.stoke.bak`, re-checked with `ssh -G`). The receive is a visible action with a result
  line, never silent.
- **The cost, said in the UI:** a transferred private key defeats per-device revocation — revoking
  a device that held it means taking that key off every host. Per-device keys and public-key
  distribution (old design §9) remain the better default; T4 exists because the owner asked for it.

---

## 6. Remote between signed-in devices

### 6.1 Presence

Every active desktop keeps one WebSocket, `GET <base>/v1/ws/presence` (signed like any request).
Server → device frames (`PresenceServerFrame`): `welcome` (online device ids), `presence`,
`items` (new seq: pull), `chain` (new head: pull and verify), `pair` (a pair changed), `relay`
(a guest wants you: open the relay), `bye` (session revoked), `pong`. Device → server: `hello`
(protocol, app version), `ping`. Reconnect with backoff 1 s → 60 s, jittered; on every (re)connect
pull the chain and items, since frames are only hints.

> **Built 2026-10-01 (H3, `src/main/hub/remote.ts`).** Presence also carries each device's
> **status** — `{t:'status', status: SealedStatus | null}` up, `{t:'status', device, status}` down —
> for the "Other machines" list: its name, platform and, only while its owner ticked "Let my other
> devices see and open my sessions" on THAT device (`hub.shareSessions`, default **off**; it replaced
> the never-read `remoteHost`, default on, under a new name so no stored default can read as on), a
> summary of its running sessions: `ptyId`, the project's folder NAME (never a path), title, status,
> agent, context. It is sealed under `presenceKey(VK_e)` (HKDF, label `presence-key`) with AAD
> `presence-status {account, epoch, device}`, so the hub forwards it blind, cannot hand one device's
> status to another as its own, and a device removed by a revoke cannot read the next epoch's. The hub
> holds the last one per connected device in memory only (never logged or stored), hands the others'
> to a device that comes online, and forwards a withdrawal as `null`. A reader opens only the current
> epoch's, only for a device its verified chain holds as active and the hub says is online, and keeps
> the later of two by `at`, which the sender moves forward itself (`max(now, lastAt + 1)`, gotcha 142).

### 6.2 Opening a relay

The guest G posts `POST /v1/relays {host}`; the hub checks both are active in the same account and
the host is online, mints `r…` (expires in 60 s if unopened) and sends the host a `relay` frame.
Both open `GET <base>/v1/ws/relay/<relay>`; the hub pairs exactly one guest and one host socket and
forwards frames verbatim — binary, ≤ 1 MiB, idle-closed after 10 min, at most 8 per account.
It is **flow-controlled** (found in review, 2026-10-01): past 4 MiB queued toward one end the hub
pauses reading the other until that end drains below 1 MiB, and closes the relay (1013) past
16 MiB, so an end that never reads cannot make the hub buffer without limit. Liveness counts only
a pong echoing the ping's random payload: an unsolicited pong (RFC 6455 allows one) cannot keep a
socket that reads nothing alive.

### 6.3 The handshake (inside the relay, before any payload)

```
G → H  hs1 { t, v, relay, account, guest, host, eph: X25519 pub, nonce }
H → G  hs2 { t, v, eph, nonce, sig = sign_H(relayHs2Text(th)) }
G → H  hs3 { t, sig = sign_G(relayHs3Text(th, hs2.sig)) }
th     = sha256(relayTranscriptText(hs1, hs2 without sig))
keys   = HKDF(X25519(ephG, ephH), salt = th, info = relay-keys, 64) → g2h[0..32) ‖ h2g[32..64)
```

Each side verifies the other's signing key **from its own pinned, verified chain** — never from
anything the relay says — so a hub that substitutes ephemeral keys cannot produce either
signature. Ephemeral keys give each relay forward secrecy.

### 6.4 Frames

After `hs3` every frame is binary: AES-256-GCM under the direction's key, nonce
`dir(1) ‖ 000000 ‖ counter(8, big-endian)` (`relayNonce`), AAD `relayFrameAad(relay, dir)`,
counters from 0, strictly sequential (a WebSocket is ordered; a gap or repeat is a closed relay).
The plaintext is JSON (`RelayInnerFrame`):

- guest first: `attach {ptyId}` — the session this relay is for, which the host's question names
  (built 2026-10-01);
- `part {data, more?}`: a piece of the next frame's JSON text; the receiver joins them before parsing
  (`relayFrameParts`). A pty's replay is 1.23 MB as JSON inside JSON for 512 K characters of Ink
  redraws, past the 1 MiB cap (gotcha 142);

- host first: `ready {mode, host: {label, platform}}` or `refused {reason}` and close;
- `req {id, method, path, body?}` → `res {id, status, body}` — the phone API, unchanged;
- `ws-open {id, path}`, `ws-msg {id, data}`, `ws-close {id, code?, reason?}` — `/ws/events` and
  the pty socket `/ws?ptyId=…` with their existing frames (`attached`, `data`, `exit`, `input`,
  `submit`, `resize`, `status`, `size`); `ping`/`pong`.

The host serves these through the same handlers and verdicts the phone server uses (gotchas 84–87
and 121 apply exactly), as virtual requests — never by opening its loopback port — so remote via
the hub works with Phone access off and binds nothing new. The relay can carry only
`RELAY_ROUTES`; `/api/transcribe` and `/api/push/*` are phone-only and refused.

### 6.5 Authorisation lives on the host

- `hub.remoteHost` (default on once signed in): whether this machine takes attach requests at
  all. Off answers every relay `refused`.
- `hub.grants[deviceId] = {mode: 'view' | 'full', label, at}`: T0, never synced, so neither the hub
  nor a synced item can grant anything. The first attach from a device with no grant raises a
  dialog on the host naming the device (label, platform, a key fingerprint) — Allow to watch /
  Allow control / Refuse — and waits 60 s before refusing. `relayFrameVerdict(mode, frame)`
  refuses in `view` every non-GET request and every `input`, `submit` and `resize` pty frame.
- Every attach shows in the title bar while it lasts and in a log; one click drops all remote
  guests. A revoked device is refused because it is no longer in the chain the host verifies.

> **Built 2026-10-01 (H3).** The switch is `hub.shareSessions`, default OFF (above), and it is the
> master switch: off refuses every relay whatever `grants` says. The question is a strip in the
> host's main column (never an overlay, gotcha 14) naming the device, its platform, its key
> fingerprint and the SESSION: "Let <device> open <session> on this computer?" — **Allow once**,
> **Always**, **Deny** — refused after `RELAY_ASK_MS`. Always stores `{mode: 'full'}` in `hub.grants`;
> Allow once stores nothing and is scoped (`relayScopeVerdict`): that session's pty socket and prompt
> answer, the host's name and theme — not other ptys, not `/api/sessions` (its rows carry folder
> paths), no transcripts, history, folders or new sessions — and it outlives a dropped relay by
> `ONCE_GRACE_MS` (2 min) so a reattach does not ask again. Every frame is judged by the grant's mode
> AND the answer's reach before the phone server's own handlers run it, in a `RemoteServer` instance
> that is never started. The `view` mode exists in the contract; the question offers only full
> control. The indicator is a strip on the host ("<device> is attached to <session> here", with
> Disconnect, which also drops every Allow once), a banner and tab mark on the guest, and Settings ›
> Account & sync lists Always grants with Take back. A remote tab never resizes the host's pty (the
> phone's `decideResize` in `native` layout) and never types xterm's own reports.
>
> **Reviewed 2026-10-01.** Four gaps closed, each held by `verify:hub-relay`. (1) "A revoked device
> is refused because it is no longer in the chain the host verifies" was true only at the
> handshake: a relay already open outlived the revoke on both ends. The host now re-checks the
> guest against its chain, by the key the handshake pinned, on every frame and answer, and
> `HubService` calls `HubRemote.chainChanged` whenever its verdict moves, ending every relay,
> question and remote tab to a device the chain no longer holds and deleting its grants. (2) Always
> was every relayed route (new sessions, folders, every project path and past conversation) while
> the question was about one session: it now reaches only the session the relay attached to, like
> Allow once, and only stops the question. (3) Nothing sent the inner `ping`, so the hub closed a
> quiet remote tab as idle every 10 min: the guest pings every 4 min (`RELAY_PING_MS`) and closes a
> channel with no pong inside 60 s. (4) The status replay guard was the status on show, which a
> presence reconnect clears: it is now a per-(device, epoch) mark kept for the process; and a
> status is cut to the sessions that fit `HUB_LIMITS.statusBytes` before it is sent, where the hub
> used to drop an oversize one without a word.

### 6.6 What the relay (and the hub) sees, and failure

Device ids, start and end times, frame sizes and timing. Keystroke timing is a known leak (the
old design's §12.2 offers padding to a fixed cadence; not in v1). A dropped relay (Worker eviction,
network change) is a closed channel: the guest shows "reconnecting", asks for a new relay, and
re-attaches; the pty's scrollback replay (`MAX_HISTORY`) makes that seamless, exactly as a phone
reattach is today.

---

## 7. Threat model (self-hosted), backups, and what the owner runs

### 7.1 Who can do what

| Adversary | Can | Cannot |
|---|---|---|
| **The NUC or the hub process compromised** (or its disk stolen) | Read ciphertext, item counts and sizes, device labels/platforms/public keys, emails, scrypt password hashes, session-token hashes, relay timing. Delete or withhold data; roll it back. | Decrypt anything (no key material on it), plant a vault key it knows (every unwrapped key must match the commitment its epoch's signed entry carries, §4.2), add a device (signed chain + a pairing code on a device the owner holds), MITM a relay (pinned device keys), forge an item (GCM under VK, id-bound path). Rollback is detected (§4.3, §5.2). |
| **Cloudflare, or the Cloudflare account** (TLS terminates at the edge) | See what passes the edge in the clear: bearer tokens, ciphertext, metadata. Drop or delay requests. | Use a token it saw (every request is signed by a key only the device has, and a nonce is refused twice), write, pair, relay as a device, or read content. |
| **Edge secret leaked** | Talk to the tunnel hostname as if forwarded; forge `x-stoke-client-ip` (weakens per-IP throttling). | Anything an account and a device key are needed for. |
| **Password guessed or phished** | Sign in as a pending device: read the device list (labels, platforms, public keys) and the recovery wrap (useless without the Kit), ask to pair. | Read items (the items routes are active-only), decrypt, or join: a pair needs approval and the matching code on an active device, and every pending request shows on every device. |
| **Stolen unlocked device / same-user malware** | What that device holds: VK, synced keys, transferred SSH keys; relay as it until revoked. | Anything after revocation (§4.6). The panel lists what to rotate. |
| **LAN observer (plain http mode)** | The session token and ciphertext. | Writes (signed), content (E2E). Use https (`tailscale serve`) where possible. |

Trust roots, in order: the owner's devices (keys in OS key stores), the Recovery Kit, Stoke's own
signed build and update channel — then, only for availability, the NUC and Cloudflare.

### 7.2 Backups of the NUC

The database holds nothing that opens content, but it holds everything the devices have not
cached, and the password hashes. `stoke-hub backup <dir>` runs `VACUUM INTO` (a consistent copy
while serving; WAL mode) into `hub-YYYYMMDD-HHMM.db`, keeps 14, and should run nightly from a
systemd timer to a second disk. An offsite copy is safe to store because it is ciphertext, but
encrypt it anyway (restic or age) for the hashes. Keep the NUC's disk encrypted.

### 7.3 Restoring one

Stop the hub, copy the backup over the database, start. Devices then see the hub "go back in
time": a shorter chain (`rollback`) and lower item versions. The alarm offers **Republish from
this device**: the device re-posts the chain entries it holds (each still carries valid
signatures, so the hub accepts them as ordinary appends extending its head) and re-puts items
whose local version is newer. Nothing is decided silently.

An entry that opens an epoch the restored hub holds no wraps for needs them again, and the hub
takes wraps **only from a device active before or after the entries** (by id and signed-in key)
and **never replaces one** (found in review, 2026-10-01): otherwise a password holder, who may read
the chain as a pending session, could republish first with wraps of its own for every device and
a junk Kit wrap. So the republishing device re-wraps `VK_e` to each device active at that epoch
and re-posts the Kit's wrap, which it cannot make (it has no RK) — the client keeps a copy of the
Kit's wrap for every epoch it holds (ciphertext, fetched beside its own) for exactly this.

> **Built 2026-10-01 (`republish`).** The first client offered only "take the hub's copy", which
> dropped the pin and accepted whatever list came next — a way for a hub to reset a device's trust
> by serving a shorter list. Republish takes the served list only if it is an earlier copy of the
> device's own, link for link (`isPrefixOf`), posts back the entries it lacks with the wraps the
> hub lost (every device's and the Kit's copy when a lost entry opened an epoch; otherwise only the
> devices it lost), then puts this device's value over any item the hub serves older than the
> device has seen, and re-uploads what the hub lost altogether. Any other list is refused.

### 7.4 What the owner runs (none of this is automated or deployed by this change)

1. **On the NUC:** Node 24; the hub from this repo as a systemd service under its own user, data
   directory 0700 (e.g. `/var/lib/stoke-hub`), edge listener `127.0.0.1:8787`, optional LAN
   listener. Read the bootstrap invite from `journalctl -u stoke-hub`.
2. **Before any routing (LAN or tailnet):** in Stoke, Settings › Hub › URL
   `http://nuc.local:8788/hub` (the LAN listener, `STOKE_HUB_LAN=0.0.0.0:8788`) or
   `https://nuc.<tailnet>.ts.net/hub`; sign up with the invite.
3. **cloudflared on the NUC:** a named tunnel (`cloudflared tunnel create stoke-hub`), ingress
   `hub-origin.vinn.dev → http://127.0.0.1:8787`, `cloudflared tunnel route dns stoke-hub
   hub-origin.vinn.dev`, run as a service. Gotchas 58 and 77 apply.
4. **The secret:** 32 random bytes, b64url — `HUB_EDGE_SECRET` in the hub's environment and
   `npx wrangler secret put HUB_EDGE_SECRET` for the edge Worker; `HUB_ORIGIN` =
   `https://hub-origin.vinn.dev` as a var.
5. **The edge Worker:** deploy `stoke-hub-edge` by hand with the route `stoke.vinn.dev/hub/*`
   (zone `vinn.dev`). The installer Worker is not redeployed.
6. **Bot defences:** a WAF skip rule for `http.host eq "stoke.vinn.dev" and
   starts_with(http.request.uri.path, "/hub/")`, or confirm Bot Fight Mode is off (gotcha 71).
7. **Then** switch every Stoke to `https://stoke.vinn.dev/hub`. Optional: an Access application on
   `hub-origin.vinn.dev` with a Service Token policy (§2.3).

---

## 8. The contract in code

| File | What it holds |
|---|---|
| `src/shared/hub/codec.ts` | base64url, Crockford base32 (+ mod-37 check), `canonicalJson`, `stableJson`, ids |
| `src/shared/hub/labels.ts` | `HUB_LABELS` and the text builders every signature, KDF and AAD uses |
| `src/shared/hub/protocol.ts` | `HUB_PROTOCOL`, routes, request/response bodies, error codes, headers, limits, presence frames, `requestSigningText`, `matchHubRoute`, `readHubResponse`, `reconnectDelayMs` |
| `src/shared/hub/auth.ts` | email and password rules, the scrypt hash format, invites, the login throttle |
| `src/shared/hub/chain.ts` | `ChainEntry`, `verifyChain`, `compareToPinned`, the signing and link texts |
| `src/shared/hub/pairing.ts` | pair states, commit and SAS texts, `sasDigits`, the Recovery Kit format |
| `src/shared/hub/items.ts` | path grammar, `T1_KEYS`, envelope shape, AAD/plaintext, `putVerdict`, `decideConflict`, `nextEditedAt`, `versionRegression` |
| `src/shared/hub/relay.ts` | handshake frames and texts, `relayNonce`, `relayFrameAad`, inner frames (`attach`, `part`), `RELAY_ROUTES`, grants, `relayFrameVerdict` |
| `src/shared/hub/remote.ts` | the sealed status's plaintext and its parser, `attachDecision`, `relayScopeVerdict`, the Allow once grace, the "Other machines" views |
| `src/main/hub/channel.ts` | `RelayChannel`: one end of a relay, handshake to frames, transport agnostic |
| `src/main/hub/remote.ts` | `HubRemote`: status publish/open, the guest's remote tabs, the host's question and grants |
| `src/shared/hub/edge.ts` | `hubUrlVerdict`, `hubEndpoint`, the edge Worker's forwarding rules, the hub's `edgeVerdict` |
| `src/shared/hub/settings.ts` | `HubSettings`, defaults and hydrate, `t1ValuesFrom`/`t2ValuesFrom`, `hostPayloadFor`, `applySyncedSettings` (T1/T2/T3 folding, host adoption), `sshKeyTarget`, `SshKeyPayload` |
| `src/main/hub/crypto.ts` | the node:crypto reference: device keys, sign/verify, vault wraps, recovery, item seal/open, relay handshake and ciphers, scrypt |
| `scripts/verify-hub.mts` | all of the above against each other, pinned vectors, refusal cases |

Integration points the client agent owns (not in this change, each is one line where the
conventions say): `DEFAULT_SETTINGS.hub = HUB_SETTINGS_DEFAULTS` and `hydrateHubSettings` in
`settingsSchema.ts`; `'hub'` in `LOCAL_KEYS` (verify:secrets' partition fails until it is); a
`{ pattern: 'hub.token', label: 'Hub session', portable: false }` line in `SECRET_PATHS`;
`syncId?: string` on `SshHost` in `types.ts` (validated as `isId('host', …)` in hydrate); IPC
channel names in `ipc.ts` first. The server imports `src/shared/hub/*.ts` and
`src/main/hub/crypto.ts` by relative `.ts` path (gotcha 78), which is why the crypto module
imports only `node:crypto` and `src/shared`.

---

## 9. Phases, and what is not verified

| Phase | Ships | Exit |
|---|---|---|
| **H0** (this change) | This spec, the contract, the crypto reference, `verify:hub` | `npm run check` green |
| **H1** server | `stoke-hub` on Node 24 + `node:sqlite`: bootstrap, accounts, sessions, signed requests, chain, wraps, items, pairing, presence; `invite`, `backup`, `reset-password` subcommands; LAN listener | Two sandbox Stokes pair over a loopback hub and converge a setting; a DB dump holds no planted canary |
| **H2** client | Settings › Hub: URL, sign in/up, devices, pair/approve with the code, Recovery Kit, revoke, sync switches, conflict notes, T4 picker | An API key and an SSH key typed on one sandbox arrive on another; revocation rotates — **met 2026-10-01** (Settings › Account & sync, `src/main/hub/service.ts`, `verify:hub-client`; two sandbox Stokes on a loopback hub). Not built: republishing after a restore (§7.3), `SshReach` on hosts |
| **H3** relay | Presence, relays, host grants and dialog, an "Other machines" list attaching through the phone client | A second sandbox lists and types into the first's stub session through the hub — **met 2026-10-01** (sidebar › Other machines, remote tabs, the host's strip; `verify:hub-relay`; two sandbox Stokes on a loopback hub, a stub claude on A: B listed it once A ticked the box, A asked, Allow once, B typed a canary and saw the stub's echo, A showed B attached; the canary was in neither the hub's log nor its database). Not built: phone through the hub, a view-only answer in the question |
| **H4** edge | `stoke-hub-edge` Worker + owner steps (§7.4) | The owner's two machines sync through `https://stoke.vinn.dev/hub` |
| Later | Phone through the hub (WebCrypto keys, no vault), direct WebRTC, public multi-tenant | — |

**Not verified by anything in this change:** every Cloudflare behaviour in §2 (routes before a
Custom Domain, WebSocket bridging, eviction, Access on subrequests, idle limits) is cited, not
measured; nothing ran on a NUC, Linux or Windows; the numeric-comparison pairing has had no
external review (the old design's advice stands: get one before any public sign-up); the hub
server, client and relay do not exist yet — `verify:hub` proves the contract is self-consistent
and implementable with node:crypto on this Mac, not that anything built on it is correct.

---

## Sources

- The 2026-09-30 design and its sources — [2026-09-30-auth-hub-design.md](2026-09-30-auth-hub-design.md)
- Cloudflare, Custom Domains (request matching; Worker-to-Worker on the same zone) — https://developers.cloudflare.com/workers/configuration/routing/custom-domains/
- Cloudflare, Workers WebSockets runtime API (outbound `fetch` + `Upgrade`, 32 MiB messages) — https://developers.cloudflare.com/workers/runtime-apis/websockets/
- Cloudflare, Compatibility flags (`fetch()` with `Upgrade: websocket` → `resp.webSocket`) — https://developers.cloudflare.com/workers/configuration/compatibility-flags/
- Cloudflare, Sandbox previews (the `bridge(upstream)` relay; pass-through connections) — https://developers.cloudflare.com/sandbox/previews/
- Cloudflare, Workers best practices (plain-Worker WebSockets lost on eviction) — https://developers.cloudflare.com/workers/best-practices/workers-best-practices/
- Cloudflare, Network › WebSockets — https://developers.cloudflare.com/network/websockets/
- Cloudflare, Tunnel origin parameters (`access.required`, `teamName`, `audTag`) — https://developers.cloudflare.com/tunnel/reference/origin-parameters/
- Cloudflare, Access service tokens (`CF-Access-Client-Id`/`-Secret`) — https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/
- Cloudflare, Workers VPC (beta; VPC Services and Networks) — https://developers.cloudflare.com/workers-vpc/ ; API — https://developers.cloudflare.com/workers-vpc/api/
- Cloudflare, Workers known issues (fetch to IP addresses; CNAME setups) — https://developers.cloudflare.com/workers/platform/known-issues/
- Bluetooth Core Spec, Secure Simple Pairing numeric comparison (commitment before nonce); ZRTP short authentication strings — RFC 6189 §4.4 / §7 — https://www.rfc-editor.org/rfc/rfc6189
- OWASP Password Storage (scrypt parameters) — https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- Crockford base32 — https://www.crockford.com/base32.html
- SQLite `VACUUM INTO` — https://www.sqlite.org/lang_vacuum.html#vacuuminto
