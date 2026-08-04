# Building Stoke on Windows and on an M1 Mac

## The one rule: Mac apps must be built on a Mac

electron-builder can produce Windows and Linux packages from either OS, but **macOS
targets can only be built on macOS** — the `.dmg` and the code-signing step both need
Apple's own tooling, which does not exist on Windows.

| Building on | Can produce |
| --- | --- |
| Windows | Windows `.exe` installer, Linux AppImage |
| macOS (your M1) | macOS `.dmg`, **and** Windows and Linux packages |

So the M1 is actually the more capable build machine. There is no way to make the Windows
box emit a Mac app, and any tutorial claiming otherwise is describing a CI runner that is
secretly a Mac.

## Windows

```bash
npm install
npm run dist:win
```

Produces `release/Stoke-<version>-x64-setup.exe`, named from `package.json`. Run it; it
installs per-user (no admin prompt) and creates a Start Menu entry. `npm run dist:win:arm64`
covers Surface-class ARM machines.

**Bump `package.json` before building a release.** `electron-builder` templates both the
artifact name and `latest.yml` from it, so building without the bump emits an installer
carrying the old version and a `latest.yml` that tells every existing install it is already
up to date.

`dist:win` does **not** publish. Every release so far has uploaded three assets to the GitHub
release by hand — the installer, its `.blockmap`, and `latest.yml`. Without `latest.yml`,
electron-updater 404s and self-update silently never happens.

## macOS (M1 / Apple Silicon)

M1 is `arm64`, which is what `npm run dist:mac` targets by default.

### 1. Get the code onto the Mac

There is no remote configured yet. Either push to GitHub once:

The repo is on GitHub and public, so this is a clone:

```bash
cd ~/Code/personal          # wherever you keep personal projects
git clone git@github-personal:realvinn/stoke.git
cd stoke
```

Already cloned? `git pull` is enough. But pulling only brings **source** — there is no Mac
artifact to download. The releases page carries a Windows installer only, because a `.dmg`
can only be produced on a Mac. You build it in the next step.

…or copy the folder across instead. If you copy it, **delete `node_modules` first** — see
the warning below.

### 2. Build

```bash
npm install
npm run dist:mac
```

Produces `release/Stoke-<version>-arm64.dmg`. Open it, drag Stoke to Applications, done.

To just run it without packaging — quicker, and the right move the first time, since no
Mac code path in this project has ever been executed:

```bash
npm install
npm run dev
```

Other targets if you ever need them:

```bash
npm run dist:mac:intel      # x64, for an Intel Mac
npm run dist:mac:universal  # one binary that runs on both (roughly double the size)
```

### 3. If macOS refuses to open it

The app is not signed with a paid Apple Developer ID, so Gatekeeper may complain. In order
of likelihood:

**"Stoke is damaged and can't be opened."** Apple Silicon will not launch an arm64 binary
whose signature is missing or broken. Re-sign it ad-hoc — this is free and needs no
developer account:

```bash
codesign --force --deep --sign - /Applications/Stoke.app
```

**"Cannot be opened because the developer cannot be verified."** Strip the quarantine flag
that gets attached to downloaded files:

```bash
xattr -cr /Applications/Stoke.app
```

Or simply right-click the app → **Open** → **Open**, once. macOS remembers the choice.

**The build itself fails looking for a certificate.** Tell electron-builder to stop hunting
for one:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac
```

## Do not copy `node_modules` between the two machines

`@lydell/node-pty` ships a prebuilt native binary per platform, pulled in through
platform-specific optional dependencies. A `node_modules` installed on Windows contains
only `@lydell/node-pty-win32-x64`; copying it to the Mac gives you a tree with no usable
PTY, and the failure is confusing — the app starts and then no session will spawn.

Always run `npm install` fresh on each machine. `package-lock.json` is committed and lists
every platform's binary, so both machines resolve correctly from the same lockfile. This is
also why there is no native compile step on either OS.

## Running without packaging

For day-to-day work you do not need an installer at all:

```bash
npm install
npm run dev     # live reload, both processes
```

## Settings are per-machine

Settings and window state are stored per OS and are not synced:

- Windows — `%APPDATA%\Stoke\settings.json`
- macOS — `~/Library/Application Support/Stoke/settings.json`

Your themes and defaults will need setting once on each. The projects list is not stored
there at all — it is read live from Claude Code's own `~/.claude.json` and
`~/.claude/projects`, so each machine naturally shows that machine's projects.

## Two things that will differ on the Mac

Neither has been tested — no Mac code path in this project has ever run — but both are
predictable enough to say in advance.

**Dictation will point at nothing.** `remote.sttUrl` defaults to `http://127.0.0.1:17890`,
which is the speech sidecar on the Windows machine. On the Mac either run a sidecar
locally, or point the setting at the Windows box over Tailscale:

```jsonc
// ~/Library/Application Support/Stoke/settings.json
"remote": { "sttUrl": "http://<windows-tailscale-name>:17890" }
```

Do not put that address on the public tunnel: the sidecar has no authentication of its
own, which is exactly why Stoke proxies to it rather than exposing it.

**The plan-limit meter will probably be blank.** It reads Claude Code's OAuth token from
`~/.claude/.credentials.json`. On macOS Claude Code keeps credentials in the **Keychain**
instead, so `readOauthToken()` in `src/main/usage.ts` will find nothing and the meter
renders nothing rather than guessing. Fixing it means reading the Keychain — `security
find-generic-password` — on darwin. Unverified, but expect it.

## Regenerating the icon

`build/icon.svg` is the source. After editing it:

```bash
npm run icon    # rewrites build/icon.png at 1024x1024
```

electron-builder derives the `.ico` and `.icns` from that PNG, so there is no binary icon
asset to maintain by hand.
