# Stoke Hub on the NUC

The hub is how your Stokes share settings, API keys, SSH hosts and (when you pick them) SSH
private keys, and how one Stoke reaches another's sessions — the "remote thing between the
machines you are signed in on". It is one small Node 24 service with a SQLite file, run on your
NUC and reached at `https://stoke.vinn.dev/hub` (or directly on your LAN or tailnet).

It stores **ciphertext it cannot open**. Every item is sealed on a device with a vault key the
hub never sees; the password only decides who may sign in. The design, threat model and
protocol are in
[docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md](../docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md)
(§7.1 says exactly what a stolen NUC can and cannot do). `npm run verify:hub-server` is the
proof this server does what that document says.

```
 Stoke ── https://stoke.vinn.dev/hub/v1/… ─► route stoke.vinn.dev/hub/* ─► Worker stoke-hub-edge
                                                (adds the edge secret)          │
                                                                                ▼
                                          https://hub-origin.vinn.dev ─► cloudflared on the NUC
                                                                                │
 Stoke on your LAN / tailnet ── http://nuc.local:8788/hub ───────┐              ▼
                                                                 └──► stoke-hub: 8788 (LAN)   8787 (edge, loopback)
```

Two listeners, on purpose:

| Port | Bound to | Asks for | Who uses it |
|---|---|---|---|
| 8787 (edge) | `127.0.0.1` | the edge secret, on every request | cloudflared, on the NUC itself |
| 8788 (LAN, optional) | your LAN or tailnet address | nothing | Stokes at home, `tailscale serve` |

The LAN listener refuses anything that carries Cloudflare's or Tailscale Funnel's headers, so a
tunnel pointed at the wrong port fails loudly instead of opening a door. The edge listener with
no secret configured refuses everything, which is how a missing secret gets noticed.

## As deployed on protech-nuc (2026-10-02)

The NUC this first ran on (`protech-nuc`, Debian 13 x86_64, reached over Tailscale) gives the
`vin` account no root and no Docker group, so the hub runs entirely as `vin` instead of the
systemd units below — same binary, same listeners, same secret, different supervisor:

| What | Where |
|---|---|
| Node 24 (official tarball, SHA-256 checked) | `~/stoke-hub/node/` |
| The hub bundle, data, edge secret, backups, logs | `~/stoke-hub/` (all `0700`/`0600`) |
| cloudflared 2026.10.5 (SHA-256 checked) + the tunnel's token file | `~/stoke-hub/bin/`, `~/stoke-hub/cloudflared/personal.token` (`0600`) |
| Supervisors (restart on exit) | `run-hub.sh`, `run-tunnel-token.sh`, single-instance by `flock` |
| Start at boot, re-check every 5 min, trim logs | `ensure.sh`, from `vin`'s crontab |
| Nightly `backup --keep 14` | `backup.sh`, 03:00 from the crontab |

The listeners are the edge one on `127.0.0.1:8787` and the LAN one on the **tailnet address
only** (`100.82.168.7:8788`). The tunnel is `stoke-hub` in the **personal** Cloudflare account
(the one that owns `vinn.dev` and the Worker), hostname `hub-origin.vinn.dev`. It is managed in
Cloudflare, not in a file: its one rule (`hub-origin.vinn.dev`, path `^/hub/` →
`http://127.0.0.1:8787`, everything else 404) was set through the API, and `run-tunnel-token.sh`
runs `cloudflared tunnel --no-autoupdate run --token-file ~/stoke-hub/cloudflared/personal.token`
— no `cert.pem`, no `config.yml`. The `stoke-hub-edge` Worker on `stoke.vinn.dev/hub/*` forwards
there with the edge secret.

Until 2026-10-28 the tunnel was in the **ProTech** account (`stoke-hub-origin.protechitsolutions.com.au`,
`run-tunnel.sh` + `cloudflared/config.yml` + a credentials JSON), only because cloudflared's
`cert.pem` was ProTech's. It is kept running for a week as the way back (point `HUB_ORIGIN` at it
again and redeploy), then its `ensure.sh` line, files and the tunnel itself are removed.

The NUC now has user systemd with lingering on, so user units could replace the crontab
supervisors one day; root is still not available, so the systemd units below stay unused. They add
`ProtectSystem`, `NoNewPrivileges` and `MemoryMax`, which a crontab supervisor cannot.

```sh
ssh vin@protech-nuc
tail -f ~/stoke-hub/logs/hub.log                       # JSON lines; the bootstrap invite is at the top
H=~/stoke-hub; STOKE_HUB_DATA=$H/data $H/node/bin/node $H/stoke-hub.mjs invite   # another invite
STOKE_HUB_DATA=$H/data $H/node/bin/node $H/stoke-hub.mjs storage                 # what each account keeps
STOKE_HUB_DATA=$H/data $H/node/bin/node $H/stoke-hub.mjs storage friend@example.com --cap 100M
```

Every account may keep **25 MB** of synced items unless you say otherwise (the whole hub held
4.4 MB on 2026-10-28). To change the default for everyone, export `STOKE_HUB_STORAGE_CAP`
(`STOKE_HUB_STORAGE_CAP=50M`) in `run-hub.sh` before it starts the hub, then restart the hub; to
give one account more, use `storage <email> --cap`, which counts from the next request with no
restart. Upgrading to the build that has the cap counts every existing account's items once, in
place, the first time it opens `hub.db` (`upgradeItemUsage` in `store.ts`, one transaction, safe to
interrupt); take a `backup` first anyway.

**Upgrading here** has no `systemctl`. The 2026-10-04 redeploy went like this, and the build with the
storage cap (`stoke-hub` 0.2.0) needs the same:

```sh
npm run build:hub && shasum -a 256 hub/dist/stoke-hub.mjs              # on the Mac
scp hub/dist/stoke-hub.mjs vin@protech-nuc:stoke-hub/stoke-hub.next.mjs
ssh vin@protech-nuc
H=~/stoke-hub; cd $H
./backup.sh                                                             # a backup now, not at 03:00
cp stoke-hub.mjs stoke-hub.mjs.prev-$(date +%Y%m%d)                     # the way back
sha256sum stoke-hub.next.mjs                                            # the same as on the Mac
node/bin/node stoke-hub.next.mjs version                                # 0.2.0
mv stoke-hub.next.mjs stoke-hub.mjs
ps -u "$USER" -o pid,args | grep '[s]toke-hub.mjs'                      # read the hub's own pid
kill -TERM <that pid>                                                   # run-hub.sh starts the new one (~7 s)
tail -n 5 logs/hub.log                                                  # "started", version 0.2.0, storageCap
```

Then `node hub/dist/stoke-hub.mjs health --url https://stoke.vinn.dev/hub` from the Mac (step 5)
should say 0.2.0, and `storage` should list every account. To go back, put the `.prev-` file in
place the same way. The 0.1.0 hub runs on the upgraded file, and the triggers the upgrade added
keep the count exact under it, so starting 0.2.0 again later needs no recount (measured with
beta.19's own `store.ts` writing and pruning after an upgrade).

## 0. Build the one file

On any machine with this repo (your Mac):

```sh
npm run build:hub          # -> hub/dist/stoke-hub.mjs, ws included, nothing to npm install
scp hub/dist/stoke-hub.mjs nuc:/tmp/
```

(Docker builds it for you instead — step 2b.)

## 1. Make the edge secret

32 random bytes, the same value on the NUC and in the edge Worker:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Keep it somewhere you can paste it twice (step 2 and step 5), then nowhere.

## 2a. Run it with systemd (Node 24 on the NUC)

```sh
# Node 24 from NodeSource, or your distribution's nodejs if it is 24+
node --version

sudo useradd --system --home-dir /var/lib/stoke-hub --shell /usr/sbin/nologin stoke-hub
sudo install -d -m 0755 /opt/stoke-hub
sudo install -m 0644 /tmp/stoke-hub.mjs /opt/stoke-hub/stoke-hub.mjs
sudo install -d -m 0700 /etc/stoke-hub
sudo sh -c 'umask 077; cat > /etc/stoke-hub/edge-secret'     # paste the secret, Enter, Ctrl-D
sudo install -m 0644 stoke-hub.service /etc/systemd/system/  # from hub/ in this repo
sudo systemctl daemon-reload
sudo systemctl enable --now stoke-hub
journalctl -u stoke-hub -n 30
```

The journal shows the **bootstrap invite** — one use, 24 hours — as two plain lines:

```
stoke-hub: no accounts yet. Sign up from Stoke with this invite (valid 24 h, one use):
  INV-7K3M-QX9D-2HPA-V8RT-C4WE-JN6B
```

Everything else it logs is one JSON object per line, and never a password, token, invite, key
or secret. A restart with still no account prints a fresh invite and revokes the old one; so
does `stoke-hub invite` (below).

To use it from home before the tunnel exists, turn the LAN listener on: uncomment
`STOKE_HUB_LAN` in the unit (or put it in `/etc/stoke-hub/hub.env`, see `hub.env.example`) and
`sudo systemctl restart stoke-hub`.

## 2b. Or run it with Docker

From a checkout of this repo on the NUC:

```sh
umask 077; cat > hub/edge-secret           # paste the secret, Enter, Ctrl-D (gitignored)
docker compose -f hub/compose.yaml up -d --build
docker compose -f hub/compose.yaml logs stoke-hub | head -5     # the invite
```

The container runs as the image's `node` user (uid 1000) and Compose mounts `hub/edge-secret`
with the host file's owner and mode, so create it as the uid-1000 user (usually the first account
on the NUC) or the hub logs that it cannot read the secret and does not start.
`hub/Dockerfile.dockerignore` keeps that file out of the build context.

The edge port is published on the host's loopback only (`127.0.0.1:8787`). Behind Docker's port
publishing every LAN client appears to come from the bridge address, so per-address throttling
lumps your LAN together; the per-email lockout is unaffected.

## 3. Sign up from Stoke

In Stoke: **Settings › Accounts › Stoke**, address `http://nuc.local:8788` (Stoke appends `/hub`), or your
tailnet name if you front the LAN port with `tailscale serve --bg http://127.0.0.1:8788`
(`https://nuc.<tailnet>.ts.net`). Paste the invite, choose an email and a password of 12+
characters. The first account is the owner.

Plain `http://` is allowed only to a private address, and Stoke says what it costs: someone on
that network can read the session token (not your keys or settings, which are encrypted, and
not enough to change anything — every request is also signed by the device). Use `https` where
you can. Never Tailscale **Funnel** the LAN port: that is the public internet on the listener
that asks for no secret, and the hub refuses it.

## 4. cloudflared on the NUC

```sh
cloudflared tunnel login
cloudflared tunnel create stoke-hub               # prints the tunnel id (a UUID)
cloudflared tunnel route dns stoke-hub hub-origin.vinn.dev
sudo mkdir -p /etc/cloudflared
sudo install -m 0600 ~/.cloudflared/<TUNNEL-ID>.json /etc/cloudflared/   # the tunnel's credentials
sudo cp cloudflared.example.yml /etc/cloudflared/config.yml   # put the UUID in both <TUNNEL-ID>s
sudo cloudflared service install
```

`tunnel create` writes the credentials to YOUR `~/.cloudflared`, and `service install` copies
none of it, so the service (running as root, from `/etc/cloudflared`) cannot start without the
`install` line. The config names the tunnel by its UUID for the same reason: by name it would
also need `cert.pem`. (Not yet run as written: protech-nuc runs `cloudflared` as `vin` from
`~/stoke-hub/cloudflared/`, above.)

Point it at **127.0.0.1:8787**, the edge listener — never the LAN port. Then check it without
the Worker:

```sh
curl -s https://hub-origin.vinn.dev/hub/v1/health
# {"error":"edge-refused",...}   <- correct: the tunnel works and the hub wants the Worker's secret
```

Two things from this repo's history apply (CLAUDE.md gotchas 58 and 77): judge `cloudflared` by
what it prints, not its exit code; and a fresh `hub-origin.vinn.dev` can say NXDOMAIN for about
half an hour after `route dns` — prove it with `curl --resolve hub-origin.vinn.dev:443:<zone
proxy IP> …` and wait rather than recreating anything.

## 5. The edge Worker (from your Mac, in this repo)

```sh
npx wrangler login
npx wrangler secret put HUB_EDGE_SECRET -c wrangler.hub-edge.jsonc     # the same secret
npm run deploy:hub-edge
node hub/dist/stoke-hub.mjs health --url https://stoke.vinn.dev/hub
# https://stoke.vinn.dev/hub: stoke-hub 0.2.0, protocol 1
```

`stoke-hub-edge` is a **second Worker on the route `stoke.vinn.dev/hub/*`**; the installer
(`stoke-install`, `npm run deploy:install`) is not touched and does not need redeploying. Until
this step, `stoke.vinn.dev/hub/…` is answered by the installer — a web page, or `install.sh` to
curl — and `health` says "not a Stoke hub".

If `health` says the address "answered with a web page (HTTP 200)", that is a Cloudflare
challenge (gotcha 71): add a WAF skip rule for
`http.host eq "stoke.vinn.dev" and starts_with(http.request.uri.path, "/hub/")`, or make sure Bot
Fight Mode is off.

Optional hardening (spec §2.3): an Access application on `hub-origin.vinn.dev` with a Service
Token policy, and `npx wrangler secret put HUB_ACCESS_CLIENT_ID` / `HUB_ACCESS_CLIENT_SECRET`
for the Worker. Do not set `access.required` in cloudflared until a forwarded request has been
seen passing it.

## 6. Switch every Stoke to `https://stoke.vinn.dev/hub`

## Running it

```sh
H="node /opt/stoke-hub/stoke-hub.mjs"                 # or: docker compose exec stoke-hub node /app/stoke-hub.mjs
export STOKE_HUB_DATA=/var/lib/stoke-hub              # the unit sets it for itself; the commands need it too

sudo -u stoke-hub -E $H invite                        # a one-use invite for someone else (7 days)
sudo -u stoke-hub -E $H invite --role owner
echo 'the new password' | sudo -u stoke-hub -E $H reset-password you@example.com
sudo -u stoke-hub -E $H reset-password you@example.com --sign-out   # on a terminal: generates one
sudo -u stoke-hub -E $H backup /var/backups/stoke-hub --keep 14
sudo -u stoke-hub -E $H storage                       # every account: items, bytes kept, its cap
sudo -u stoke-hub -E $H storage friend@example.com --cap 100M      # that account's own cap
sudo -u stoke-hub -E $H storage friend@example.com --cap default   # back to the hub's
HUB_EDGE_SECRET_FILE=/etc/stoke-hub/edge-secret sudo -E $H health
```

**Storage per account.** Each account may keep `STOKE_HUB_STORAGE_CAP` bytes of synced items (25 MB
unless set). What counts is every item envelope the hub stores for it, ciphertext and all, at every
epoch. Sizes are binary: `25M`, `25MB` and `25MiB` are all 26,214,400 bytes. When a device's change
would take its account past the cap, the hub refuses that one change (`full`); everything else in
the same sync goes through, Stoke says the hub is full and what to do, and the change waits on the
device until there is room. Deleting always works, so a full account can always make room, and an
account you set below what it already holds can only shrink. Two things may take an account past
its cap on purpose: a delete (the hub cannot see that a change is a delete, so it always takes a
change that leaves an item no bigger than the largest delete could be), and the re-seal after
removing a device or making a new Recovery Kit, which puts every item back under the new key
before the old copies are pruned (refusing it would lose items). Stokes from before the cap
(beta.15 to beta.19) read the refusal as one more "the hub refused" line in their log and try again
at their next sync, never sooner. `stoke-hub storage` shows each account's figure and flags one
that is over its cap; the running hub records the default it started with, so the command shows the
figure in force even without the service's environment.

A password reset changes who can **sign in**, never what anyone can decrypt — the password opens
no key — which is why it is safe as a plain command on the NUC.

**Upgrading** is replacing `stoke-hub.mjs` and `sudo systemctl restart stoke-hub`. A stop is
graceful: requests in flight finish, every socket is told `bye`, and every Stoke reconnects on
its own and re-reads what it missed.

**Logs** are JSON lines in the journal: `journalctl -u stoke-hub -o cat | jq .` (on protech-nuc,
`~/stoke-hub/logs/hub.log`). Requests name the route, status, account and device; refusals from
strangers are rate-limited to a summary line.

From `stoke-hub` 0.2.0 the close lines say who ended a connection, which is what to read when a
remote tab keeps dropping:

| Line | Field | Means |
|---|---|---|
| `relay closed` | `code` | the code both ends were sent (always a sendable one, as before) |
| | `raw` | what the hub saw: `1006` is a drop with no close frame, `1005` a close with no code |
| | `by` | `guest`, `host` or `hub`: whose socket closed or failed, or the hub's own doing (a timer, a sign-out, a revoke, flow control) |
| | `noPong` | only on the ping round's cut: the end that stopped answering |
| | `missing` | `guest`, `host` or `both`: the end that never joined, on a relay that ended before both were in |
| | `fromGuest`, `fromHost`, `quietMs` | frames each end sent (they add up to `frames`), and how long the relay had been silent |
| `presence closed` | `rid`, `code`, `by`, `why`, `ms`, `frames`, `app` | one device's presence socket: the raw code, `device` or `hub`, the reason, its lifetime, frames received and the Stoke version. `rid` matches the upgrade's `request` line; `replaced: true` when a newer socket from that device took over |
| `relay notice replayed` | `relay`, `guest`, `host` | a host whose presence reconnected was told again of a relay still waiting for it |

The hub tells a host of a new relay once, over the presence socket it has at that moment. If that
socket was dropping, the notice went nowhere and the guest used to wait for "the other end never
joined". Now every relay still waiting for a device as its host, with its guest already in and
not yet expired, is named again when that device's presence opens. Every released Stoke skips a
notice for a relay it already serves, so the repeat is harmless. To see how often it helps, count
`relay notice replayed`, and the `missing: host` closes that remain. A `by: host` (or `guest`)
with `raw: 1011` and `why: could not deliver a frame` means that end dropped while frames were
going to it, not the hub. The lines carry ids, codes, counts and times as before; nothing new
holds a token, a key or anything from inside a frame.

## Backups, and restoring one

The database holds nothing that opens content, but it holds everything the devices have not
cached, plus the password hashes. `stoke-hub backup` runs `VACUUM INTO` — a consistent copy
while the hub serves — into `hub-YYYYMMDD-HHMM.db` and keeps the newest N. Run it nightly:

```sh
sudo install -d -o stoke-hub -g stoke-hub -m 0700 /var/backups/stoke-hub   # better: on a second disk
sudo install -m 0644 stoke-hub-backup.service stoke-hub-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now stoke-hub-backup.timer
```

An offsite copy is ciphertext, but encrypt it anyway (restic or age) for the password hashes, and
keep the NUC's own disk encrypted.

**To restore:** `sudo systemctl stop stoke-hub`, copy the backup over
`/var/lib/stoke-hub/hub.db`, delete `hub.db-wal` and `hub.db-shm` beside it, start. Every Stoke
will then see the hub "go back in time" — a shorter device list, lower item versions — and show
an alarm rather than accept it (spec §7.3). That is deliberate: it is exactly what an attacker
rolling the hub back would look like. Choosing **Republish from this device** on a Stoke puts
back what it holds.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `STOKE_HUB_DATA` | `$STATE_DIRECTORY` (systemd) | where `hub.db` lives; required |
| `STOKE_HUB_LISTEN` | `127.0.0.1:8787` | the edge listener; `off` for none |
| `STOKE_HUB_LAN` | off | the LAN/tailnet listener, e.g. `0.0.0.0:8788` |
| `STOKE_HUB_MOUNT` | `/hub` | the path the hub is served under |
| `HUB_EDGE_SECRET` / `HUB_EDGE_SECRET_FILE` | `$CREDENTIALS_DIRECTORY/hub-edge-secret` | the edge secret, 32+ characters; never a flag |
| `STOKE_HUB_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `STOKE_HUB_RATE_BURST` / `_PER_SEC` | `300` / `5` | requests per client address |
| `STOKE_HUB_STORAGE_CAP` | `25M` | what each account may keep (binary units: `25M` = 25 MiB); `stoke-hub storage <email> --cap` overrides it per account |

Fixed by the protocol (`src/shared/hub/protocol.ts`): a request body is at most 1 MiB, a presence
frame 64 KiB, a relay frame 1 MiB; 100 puts per request, 5,000 items (each at most 128 KiB) and 32
active devices per account, 8 open relays per account. The bytes an account may keep are yours to
set (`STOKE_HUB_STORAGE_CAP`, above). Sign-in locks an email for 15 minutes after 5 wrong
passwords (doubling to 24 h) and an address after 30 failures. A device that has already joined
proves itself when it signs in and is judged by its own counter instead, so a stranger guessing
your email cannot lock your devices out — only a new device waits out the lock.

A relay is flow-controlled: once 4 MiB is queued toward an end that is not reading, the hub stops
reading the other end until it drains (TCP then pushes back on the sender), and closes the relay
past 16 MiB — so two devices cannot make the hub buffer without limit and bring it down for every
account under `MemoryMax`. A socket that does not answer the hub's ping with its own payload is
cut at the next 25-second round.

## What has not been proven

The storage cap (2026-10-28) ran only in `verify:hub-server` and `verify:hub-client` on a Mac, and
against released beta.15 and beta.19 clients in a scratch run there: not yet on the NUC, and its
first open of the real `hub.db` (the in-place count) is untested against that file — back it up
before the upgrade. The close fields and the notice replay (also 2026-10-28) ran in
`verify:hub-server` and between two sandbox Stokes on a hub started from source on 127.0.0.1;
whether the replay cuts the "never joined" count in production only this hub's log can show.

Everything here ran on a Mac under Node 26, and under Electron's Node 24.18 (the NUC's major
version): the server, both listeners, the bundle, every subcommand, SIGTERM. **Not run:** on the
NUC or any Linux; the Docker image (never built — no Docker daemon was running); the systemd
units (never loaded); cloudflared; the edge Worker on Cloudflare (its HTTP half runs under node in
the suites; its WebSocket bridge, below); and Cloudflare's route-before-custom-domain precedence,
which is cited from its docs, not measured.

> **Measured on 2026-10-02**, `node scripts/hub-e2e.mts --url https://stoke.vinn.dev/hub --invite …`
> from a Mac against the deployment above: the route reaches this Worker ahead of the installer's
> custom domain, and sign-up, pairing (both screens), items, conflicts, revoke, account isolation,
> forged and replayed requests and the email lockout all pass through it. Its WebSocket bridge
> carried presence — text frames — from the first try, and turned every BINARY frame into the text
> `[object Blob]`: since compatibility date 2026-03-17 (`websocket_standard_binary_type`) a Worker
> receives binary frames as `Blob`s unless `binaryType` is set. So every "Other machines" relay died
> at its first sealed frame (`1008 "a text frame arrived after the handshake"`), and a binary frame
> sent on presence reached the hub as text (`1007 "not JSON"`, where binary gets `1003`). Fixed in
> `worker/hub-edge.ts` (`bridgeSockets`); it reaches Cloudflare only with `npm run deploy:hub-edge`.
> Under `wrangler dev` (workerd, same compatibility date) the old bridge fails the script the same
> way and the fixed one passes all of it. Also seen there: the Worker reads both ends eagerly, so
> the hub's relay flow control never sees a slow reader behind it — a 24 MB flood at a paused
> reader was buffered in the Worker, not pushed back to the sender.
