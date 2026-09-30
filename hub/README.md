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

In Stoke: **Settings › Hub**, address `http://nuc.local:8788` (Stoke appends `/hub`), or your
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
cloudflared tunnel create stoke-hub               # prints the tunnel id
cloudflared tunnel route dns stoke-hub hub-origin.vinn.dev
sudo cp cloudflared.example.yml /etc/cloudflared/config.yml   # edit <TUNNEL-ID>
sudo cloudflared service install
```

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
# https://stoke.vinn.dev/hub: stoke-hub 0.1.0, protocol 1
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
HUB_EDGE_SECRET_FILE=/etc/stoke-hub/edge-secret sudo -E $H health
```

A password reset changes who can **sign in**, never what anyone can decrypt — the password opens
no key — which is why it is safe as a plain command on the NUC.

**Upgrading** is replacing `stoke-hub.mjs` and `sudo systemctl restart stoke-hub`. A stop is
graceful: requests in flight finish, every socket is told `bye`, and every Stoke reconnects on
its own and re-reads what it missed.

**Logs** are JSON lines in the journal: `journalctl -u stoke-hub -o cat | jq .`. Requests name the
route, status, account and device; refusals from strangers are rate-limited to a summary line.

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

Fixed by the protocol (`src/shared/hub/protocol.ts`): a request body is at most 1 MiB, a presence
frame 64 KiB, a relay frame 1 MiB; 100 puts per request, 5,000 items and 32 active devices per
account, 8 open relays per account. Sign-in locks an email for 15 minutes after 5 wrong
passwords (doubling to 24 h) and an address after 30 failures. A device that has already joined
proves itself when it signs in and is judged by its own counter instead, so a stranger guessing
your email cannot lock your devices out — only a new device waits out the lock.

A relay is flow-controlled: once 4 MiB is queued toward an end that is not reading, the hub stops
reading the other end until it drains (TCP then pushes back on the sender), and closes the relay
past 16 MiB — so two devices cannot make the hub buffer without limit and bring it down for every
account under `MemoryMax`. A socket that does not answer the hub's ping with its own payload is
cut at the next 25-second round.

## What has not been proven

Everything here ran on a Mac under Node 26, and under Electron's Node 24.18 (the NUC's major
version): the server, both listeners, the bundle, every subcommand, SIGTERM. **Not run:** on the
NUC or any Linux; the Docker image (never built — no Docker daemon was running); the systemd
units (never loaded); cloudflared; the edge Worker on Cloudflare (its HTTP half runs under node in
the suites; its WebSocket bridge needs the Workers runtime and has never carried a frame); and
Cloudflare's route-before-custom-domain precedence, which is cited from its docs, not measured.
