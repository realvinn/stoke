# Building Stoke on Windows and on an M1 Mac

## The one rule: Mac apps must be built on a Mac

electron-builder can produce Windows packages from either OS, but **macOS targets can only
be built on macOS** — the `.dmg`, the `.zip` beside it and the code-signing step all need
Apple's own tooling, which does not exist on Windows.

| Building on | Can produce |
| --- | --- |
| Windows | Windows `.exe` installer |
| macOS (your M1) | macOS `.dmg` **and** `.zip`, and Windows packages |

So the M1 is actually the more capable build machine. There is no way to make the Windows
box emit a Mac app, and any tutorial claiming otherwise is describing a CI runner that is
secretly a Mac. For an actual release neither desk has to choose: a pushed tag builds both
platforms on GitHub's runners and publishes them together — `.github/workflows/release.yml`,
described under Windows below.

**Linux is configured and has never been built.** `electron-builder.yml` carries a `linux:`
block with an AppImage target, but no npm script passes `--linux` and no CI job builds it, so
no Linux artifact has ever come out of this repo and nothing here has been run on Linux at
all. Treat that block as an intention rather than a supported platform; the README's "windows
and mac" is the honest list.

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

`dist:win` does **not** publish — it only writes into `release/`. Publishing is the tag's job,
not a hand upload. `.github/workflows/release.yml` fires on any `v*` tag: it runs the typecheck
and every verify suite that can pass on a clean runner, builds the Windows installer on
`windows-latest` and the Mac `.dmg` and `.zip` on `macos-14`, and then a single publish job —
single, because letting each matrix job publish for itself made both race and produce two draft
releases with the assets split between them — creates the GitHub release from both sets of
artifacts. So cutting a release is a version bump, a commit, and an annotated tag:

```bash
npm version 0.4.0 --no-git-tag-version
git commit -am "0.4.0"
git tag -a v0.4.0          # the annotation is what people will read
git push && git push --tags
```

The tag's annotation **is** the release notes: its first line becomes the title and the rest
becomes the body. That is why `git tag -a` and not a bare `git tag` — a lightweight tag carries
no message of its own, and the workflow warns and falls back to the tag name rather than
inventing notes from whatever commit it points at. A version with a hyphen in it is published as
a prerelease, derived from the tag, because that is how semver and electron-updater both read
it.

`workflow_dispatch` runs the identical matrix and then stops before the publish job, so the
whole build can be rehearsed without releasing anything — which is the only safe way to find out
that a build is broken.

Without `latest.yml`, electron-updater 404s and self-update silently never happens. The publish
job now enforces that instead of trusting it: it refuses to create the release if either
`latest.yml` or `latest-mac.yml` is missing, and refuses again if `latest-mac.yml` lists no
`.zip` — because a manifest can be present and still describe a Mac that cannot update itself.

## macOS (M1 / Apple Silicon)

M1 is `arm64`, which is what `npm run dist:mac` targets by default.

### 1. Get the code onto the Mac

The repo is on GitHub and public, so this is a clone:

```bash
cd ~/Code/personal          # wherever you keep personal projects
git clone https://github.com/realvinn/stoke.git
cd stoke
```

Already cloned? `git pull` is enough. Pulling brings **source** only — but a built Mac app is
no longer something you have to make yourself, because a tag builds one on a macOS runner and
the releases page carries the `.dmg` and `.zip` next to the Windows installer. Building it here
is the next step anyway, and is what you want while working on the thing.

…or copy the folder across instead. If you copy it, **delete `node_modules` first** — see
the warning below.

### 2. Build

```bash
npm install
npm run dist:mac
```

Produces two files in `release/`, because `mac.target` is `[dmg, zip]` and the zip is not
optional. `Stoke-<version>-arm64.dmg` is the one a person opens: drag Stoke to Applications,
done. `Stoke-<version>-arm64.zip` is never opened by hand — it is the only thing electron-updater
can install on macOS, because Squirrel.Mac updates by swapping an `.app` out of an archive and
its `MacUpdater` rejects "dmg" and "pkg" by name, throwing before it downloads a byte. A
dmg-only build is why no Mac could update itself up to and including v0.4.0-beta.3, while the
release looked complete from every angle, and it is why the publish job fails outright when
`latest-mac.yml` lists no zip.

To just run it without packaging — quicker, and still the right move the first time on a
machine:

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

That ad-hoc signature is also exactly what stops Stoke updating itself, and Stoke knows it.
`src/main/selfUpdate.ts` runs `codesign -dv` against its own executable at startup and reads
the report off **stderr**, which is where `codesign` writes it — the command also exits
non-zero for an unsigned target, so the failure path is read as carefully as the success one.
A `Signature=adhoc` line in that report is the answer: Squirrel.Mac verifies a downloaded app
against the *running* app's designated requirement, and for an ad-hoc signature that
requirement is `cdhash H"…"` — the hash of this exact binary — which no other build can satisfy
by construction. So the Download button is disabled and the panel says "This build is ad-hoc
signed, so macOS will refuse to swap it for a downloaded one", rather than letting you pay for
a ~100MB download that would be rejected at the very end. Anything signed with a real
certificate prints an `Authority=` line instead and is left alone — including a self-signed
one, whose requirement pins a certificate rather than a hash and therefore *can* be satisfied
by the next build. CI builds set `CSC_IDENTITY_AUTO_DISCOVERY: false` with no Developer ID
available, so ad-hoc is the shipped state on macOS today: updates there arrive by downloading
the next `.dmg` by hand.

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

## Two things that differ on the Mac

Neither is a prediction any more. The Mac has been built, launched and driven through its real
UI here several times — sessions started, prompts sent, the context ring and the usage chip
read out of the running DOM — and the second of these was found that way rather than reasoned
about in advance.

What that did *not* exercise, and is still genuinely unverified, is worth listing so it is not
mistaken for tested. The `hiddenInset` title bar and the traffic-light padding: every
screenshot came from CDP's `Page.captureScreenshot`, which paints page content and not
Electron's native window chrome, and this machine has neither Accessibility nor Screen
Recording permission for an OS-level capture to fall back on. The login-shell PATH probe in
`cli.ts`: every launch here inherited a working PATH from the shell that started Electron,
never the Finder/Dock case with no inherited PATH that the probe exists for. And the Cmd-based
shortcuts: buttons were driven by dispatching `.click()` on the DOM, never a real
`metaKey`-modified keystroke, so `shortcuts.ts`'s Mac branch has not actually fired.

**Dictation will point at nothing.** `remote.sttUrl` defaults to `http://127.0.0.1:17890`,
which is the speech sidecar on the Windows machine. On the Mac either run a sidecar
locally, or point the setting at the Windows box over Tailscale:

```jsonc
// ~/Library/Application Support/Stoke/settings.json
"remote": { "sttUrl": "http://<windows-tailscale-name>:17890" }
```

Do not put that address on the public tunnel: the sidecar has no authentication of its
own, which is exactly why Stoke proxies to it rather than exposing it.

**The account route to plan limits does not work here, and that is now confirmed rather than
expected.** `readOauthToken()` in `src/main/usage.ts` reads Claude Code's OAuth token from
`~/.claude/.credentials.json`; on macOS Claude Code keeps it in the login **Keychain** instead,
so the read finds nothing and `window.stoke.usage.read()` comes back with "Not signed in to
Claude Code." Fixing that route means reading the Keychain — `security find-generic-password` —
on darwin.

The meter itself is not blank, though, and that is the part worth knowing before going hunting
for a bug. `UsageMeter.tsx` draws from two sources, not one: the statusLine payload's own
`rate_limits` and the account snapshot, combined by `mergeUsageWindows`. The payload wins on
`percent` and `resetsAt` because it is the account state as the CLI itself was just told it, so
on macOS — where only the payload arrives — the chip and the panel still render. What goes
missing with the account call is `severity`: the payload states none at all, so a window the
account would have flagged `warning` or `critical` falls back to `normal` and only the pace
marker tones it. The model-scoped weekly window goes with it, since the payload has no way to
express that kind either. Two caveats on the payload as a sole source: it only exists once a
session has had an API response come back — a freshly mounted session legitimately has none,
and no reading must never be drawn as 0% — and it appears to populate only under Claude.ai
subscription (OAuth) auth. With no session open the chip shows the last reading of the run and
says what time it heard it.

## Regenerating the icon

`build/icon.svg` is the source. After editing it:

```bash
npm run icon    # rewrites build/icon.png at 1024x1024
```

electron-builder derives the `.ico` and `.icns` from that PNG, so there is no binary icon
asset to maintain by hand.
