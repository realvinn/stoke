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
`src/main/selfUpdate.ts` runs `codesign -dvv` against its own executable at startup and reads
the report off **stderr**, which is where `codesign` writes it — the command also exits
non-zero for an unsigned target, so the failure path is read as carefully as the success one.
The rule itself is in `src/main/codesign.ts`, which imports no electron so `verify:updates` can
test it.

**Both `v`s matter.** At one level of verbosity `codesign` prints `Signature=adhoc` but no
`Authority=` line at all, so a probe using `-dv` can only ever detect the ad-hoc case. That was
this project's bug for several releases, and the case it hid is the common one.

### How "Restart and install" works on macOS, and when it does not

Squirrel.Mac installs an update by swapping one `.app` for another, and first checks the
downloaded bundle against the **running** bundle's designated requirement. What that
requirement says depends entirely on how the running copy was signed:

| How this copy was signed | Its designated requirement | Can a later build satisfy it? |
| --- | --- | --- |
| ad-hoc | `cdhash H"…"` — this exact binary's hash | Never, by construction |
| self-signed | `identifier "…" and certificate leaf = H"…"` | Only if signed with that same certificate |
| Developer ID | same shape, pinned to an Apple-issued cert | Yes — this is the case it is designed for |

The middle row is the one that decides everything here, and it cuts both ways. A locally built
copy is signed with whatever code-signing identity `electron-builder.yml` names — `Stoke`, a
self-signed certificate in the login keychain. If the **published release is signed with that
same certificate**, the swap is allowed and auto-update works; if it is not, the swap is
refused. Both halves therefore have to be arranged together, which is what the next section is
for.

`src/main/codesign.ts` encodes exactly that rule. `RELEASE_IDENTITY` names the certificate the
releases are signed with, and a copy carrying it is *not* blocked. Anything else self-signed is,
by name — on the machine this was written on that was **`MyTouchBar Local`**, a certificate
belonging to an entirely different project that happened to be the only identity in the keychain
when electron-builder went looking. Blocking up front matters because the alternative is paying
for a ~123MB download that is rejected at the very end.

**If you change the certificate, change `RELEASE_IDENTITY` with it.** It is a shared constant
between three places — `mac.identity` in `electron-builder.yml`, the `.p12` behind the
`MAC_CSC_LINK` secret, and that line — and naming one the pipeline does not actually use turns a
cheap up-front refusal back into the expensive late one.

To see which case you are in:

```bash
codesign -dvv /Applications/Stoke.app 2>&1 | grep -E 'Authority|Signature'
```

**What the published builds actually are.** Until 0.5.3 CI set `CSC_IDENTITY_AUTO_DISCOVERY:
false` and nothing else, and the comment beside it claimed the result was an ad-hoc signature.
It was not. With no identity to find, electron-builder skips signing altogether and ships
whatever the prebuilt Electron binary already carried — measured on the published
`Stoke-0.5.2-arm64.zip`: `Identifier=Electron`, `codesign --verify --strict` exiting 1 with
"code has no resources but signature indicates they must be present", and **none** of the
entitlements this repo specifies (microphone, JIT, library validation). The release job now
passes `-c.mac.identity=-`, which asks for a genuine ad-hoc signing pass: right bundle
identifier, sealed resources, entitlements applied. That is now the **fallback** rather than the
only path — it is taken when `MAC_CSC_LINK` is not set, and such a build still cannot auto-update
(row one of the table above), but it is a valid, correctly built app.

### Making "Restart and install" actually work

Both halves have to hold at once: **the installed copy and the published build must be signed
by the same certificate.** Step 2 is done and step 1 has been done on the machine this was
written on; **step 3 is the only one left, and it needs two repository secrets that only you can
create** — the release workflow warns and falls back to an ad-hoc build until they exist, and an
ad-hoc release cannot update anybody. Cheapest route without an Apple Developer account:

1. Create one self-signed code-signing certificate, named for this project rather than
   whatever else is in your keychain. Keychain Access → **Certificate Assistant** → **Create a
   Certificate…** → Name `Stoke`, Identity Type **Self Signed Root**, Certificate Type **Code
   Signing** → Create. Confirm it took:

   ```bash
   security find-identity -v -p codesigning     # should list "Stoke"
   ```

   > **macOS 26 removed Keychain Access.** Verified on 26.5.2: there is no
   > `/System/Applications/Utilities/Keychain Access.app`, and `mdfind` finds no copy anywhere.
   > Searching for "keychain" opens the Passwords app, which has no certificates section — so
   > following the paragraph above reports "there is nothing in my certificates", which is true.
   > If the identity already exists (as it does on the machine this was written on) nothing here
   > needs the GUI: step 3 is fully scripted. Creating a *new* one without Keychain Access needs
   > `openssl req -x509` plus `security import` and `security add-trusted-cert`, which is not
   > written up here because it has not been done.

2. Point electron-builder at it, so local builds stop picking up a stray identity. **Done** —
   `electron-builder.yml` already says this, and `RELEASE_IDENTITY` in `src/main/codesign.ts`
   names the same certificate:

   ```yaml
   # electron-builder.yml
   mac:
     identity: Stoke
   ```

3. Give CI the same certificate:

   ```bash
   npm run mac:signing-secrets
   ```

   That is the whole step. `scripts/mac-signing-secrets.sh` exports the identity, repackages it
   as a single-identity `.p12`, checks the result against the fingerprint the keychain reports,
   and pipes both values to `gh`. The password is generated inside the script and never printed,
   so it cannot end up in a shell history or a scrollback.

   Two traps it exists to avoid, both hit for real:

   - **`security export` cannot select an identity by name.** It exports the whole keychain's
     worth — four identities on the machine this was written for (`MyTouchBar Local`,
     `Tinker Local`, `localhost`, `Stoke`) — so the obvious one-liner would put three unrelated
     private keys into a GitHub secret. The script splits the bundle with `openssl` and asserts
     that exactly one identity and one key survive.
   - **`gh secret set NAME < <(base64 -i missing.p12)` sets an EMPTY secret and prints a tick.**
     The process substitution opens a file descriptor whether or not the command inside it
     succeeded, so `gh` reads zero bytes and reports success; the secret then exists, looks
     configured in the GitHub UI, and contains nothing. The workflow's `[ -n "$MAC_CSC_LINK" ]`
     gate treats that as absent and says "unset or empty" rather than trying to import it.

   The workflow already reads exactly those two names, imports and trusts the certificate, and
   fails the build rather than shipping an unsigned app if the identity does not come back from
   `security find-identity`. With them absent it emits a `::warning::` saying the build cannot
   auto-update and carries on ad-hoc, so a release is never blocked on this — it is just not
   updatable.

   **Setting those two secrets is not enough, and the way it fails is silent.** electron-builder
   imports a `.p12` into a temporary keychain and sets its partition list, and that is all —
   `grep -rn add-trusted-cert node_modules/app-builder-lib/` returns **zero** hits
   (`macCodeSign.js:165-168`). It then searches with `security find-identity -v`, i.e. *valid
   identities only* (`macCodeSign.js:195,206`), and an untrusted self-signed certificate is not
   valid: `codesign --sign` on one reports `no identity found` and signs nothing — measured. So
   the build would fall through to a warning and ship an **unsigned** bundle, which is the exact
   failure you started with, now with secrets configured and looking fixed.

   The runner has to trust the certificate explicitly. **That step now ships** — see "Import and
   trust the signing certificate" in `.github/workflows/release.yml`, reproduced here because
   the reasoning belongs with the rest of this section. Note that `CSC_LINK` is deliberately NOT
   left set on the build step: with it set, electron-builder builds its own *untrusted* keychain
   and searches that one instead (`macCodeSign.js:184-189`), and the identity comes from step 2's
   `identity:` key rather than from the environment.

   ```yaml
   - name: Import and trust the signing certificate
     if: runner.os == 'macOS'
     env:
       CSC_P12_BASE64: ${{ secrets.MAC_CSC_LINK }}
       CSC_KEY_PASSWORD: ${{ secrets.MAC_CSC_KEY_PASSWORD }}
     run: |
       set -euo pipefail
       KC="$RUNNER_TEMP/stoke-signing.keychain-db"
       KCPW="$(openssl rand -base64 24)"
       echo "$CSC_P12_BASE64" | base64 --decode > "$RUNNER_TEMP/stoke.p12"
       security create-keychain -p "$KCPW" "$KC"
       security set-keychain-settings -lut 21600 "$KC"
       security unlock-keychain -p "$KCPW" "$KC"
       security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')
       security import "$RUNNER_TEMP/stoke.p12" -k "$KC" -P "$CSC_KEY_PASSWORD" \
         -T /usr/bin/codesign -T /usr/bin/productbuild
       security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KCPW" "$KC" >/dev/null
       openssl pkcs12 -in "$RUNNER_TEMP/stoke.p12" -passin "pass:$CSC_KEY_PASSWORD" \
         -nokeys -legacy -out "$RUNNER_TEMP/stoke.cer"
       sudo security add-trusted-cert -d -r trustRoot -p codeSign \
         -k /Library/Keychains/System.keychain "$RUNNER_TEMP/stoke.cer"
       rm -f "$RUNNER_TEMP/stoke.p12"
       # Fail here rather than shipping an unsigned app.
       security find-identity -v -p codesigning | grep -q "Stoke"
   ```

   The `-legacy` flag on that `openssl pkcs12` is the same one the certificate script needs:
   macOS's Security framework cannot read an OpenSSL 3 default PKCS#12 and fails with "MAC
   verification failed during PKCS12 import (wrong password?)". The `sudo add-trusted-cert -d`
   line relies on GitHub runners having passwordless sudo; that is standard, but it is the one
   line here that has not been executed — the rest is verified against app-builder-lib's source
   and against `codesign`'s actual behaviour.

   Be deliberate about this route regardless: it puts an exportable private key in a GitHub
   secret, decrypted into a runner VM you do not own, on every build. It is a key nobody else
   trusts, so the blast radius is small — but it is still a private key in someone else's
   infrastructure, and "build the mac artifacts locally and upload them to the release" avoids
   the question entirely.

Two consequences worth knowing before you start. **Changing the signing certificate breaks the
update chain exactly once** — the currently installed copy pins the old certificate, so the
first build under the new one must be installed by hand from the `.dmg`; every release after
that can update itself. And **macOS ties privacy permissions to the signature**, so the
microphone grant for dictation is reset and will be asked for again the first time you dictate.

The alternative is a paid Apple Developer ID (`CSC_LINK` plus the `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` secrets for notarising), which additionally
removes every Gatekeeper complaint in this section for everybody, not just for you.

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
