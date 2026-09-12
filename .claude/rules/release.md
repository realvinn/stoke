---
paths:
  - ".github/workflows/release.yml"
  - "electron-builder.yml"
  - "scripts/mac-signing-secrets.sh"
  - "scripts/verify-updates.mts"
  - "scripts/verify-targets.mts"
  - "scripts/verify-manifests.mts"
  - "scripts/targets.mjs"
  - "scripts/merge-update-manifests.mjs"
  - "scripts/check-release-assets.mjs"
  - "scripts/assert-packaged-pty.mjs"
  - "src/main/codesign.ts"
  - "src/main/selfUpdate.ts"
---

# Packaging, signing, self-update

electron-builder, macOS signing and auto-update, the release workflow, and Windows scripting.
Loaded when a file in `paths` is read; CLAUDE.md keeps a one-line index of each. Numbers are
permanent — code comments cite them as "CLAUDE.md gotcha N".

## 7. electron-builder: an explicit `arch:` list in the config overrides the CLI flag

**electron-builder: an explicit `arch:` list in the config overrides the CLI flag.** With
it, `dist:win --x64` still built all three architectures.

## 8. PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM

**PowerShell 5.1 `Set-Content -Encoding utf8` writes a BOM.** Use
`[System.IO.File]::WriteAllText` with `UTF8Encoding($false)` when rewriting source files.
Write `settings.json` with node for the same reason — a BOM breaks the parse silently.

## 24. A macOS auto-update is installed from a `.zip`, never the `.dmg`

**A macOS auto-update is installed from a `.zip`, never the `.dmg`.** Squirrel.Mac swaps an
`.app` out of an archive, so electron-updater's `MacUpdater` searches the feed for a zip and
**rejects `dmg` and `pkg` by name** (`node_modules/electron-updater/out/MacUpdater.js:81-83`,
6.8.9), throwing `ERR_UPDATER_ZIP_FILE_NOT_FOUND` before downloading a byte. Every release up
to and including v0.4.0-beta.3 built `mac.target: [dmg]` only, so `latest-mac.yml` listed one
file and no Mac could ever update itself — while `npm run check` passed, the dmg built, CI was
green and the panel cheerfully said an update was available. Nothing fails when that target is
removed, which is why `verify:updates` asserts it is present.

Two things compound it, and both are worth knowing before declaring Mac updates fixed. First,
the zip only gets the download working; **Squirrel then verifies the downloaded app against the
running one's designated requirement**, and an ad-hoc signature's requirement is
`cdhash H"…"` — the hash of that exact binary — which no other build can satisfy by
construction. Second, **Windows needs none of this**: `NsisUpdater` only verifies a signature when
`publisherName` is set in the builder config, and it is not, so that check is skipped
(`NsisUpdater.js:84-99`). Windows self-update has always worked; only macOS was broken.

**Two claims this entry used to make were wrong, and both were load-bearing.** Corrected in
place, because each was believed for several releases.

*"A self-signed certificate can be satisfied by the next build, so it is left alone."* True in
theory and false in practice, and it is the case that actually ships. A locally built copy is
signed with whatever code-signing identity is in the login keychain — here `MyTouchBar Local`,
a certificate from an unrelated project — and the published release is not signed with it, so
the requirement `identifier "dev.vinn.stoke" and certificate leaf = H"9af1c10c…"` cannot be
met. `detectBlocker` returned null for exactly this case, so the panel offered the update, and
Squirrel refused the swap only after 123 MB had been downloaded. The rule now lives in
`src/main/codesign.ts` (no electron import, so `verify:updates` can test it) and blocks
anything that is not Apple-issued, naming the certificate.

*"`codesign -dv` prints an `Authority=` line for anything signed with a real certificate."*
It does not. **At one `v` there is no `Authority=` line at all** — measured against this very
binary, which `-dv` describes without naming its signer and `-dvv` reports as
`Authority=MyTouchBar Local`. So the old probe could only ever detect the ad-hoc case, not
because that was the intended rule but because it was the only fact in the output.

**Both of those are now fixed rather than merely documented, and the fix is that CI signs
with the same certificate.** `RELEASE_IDENTITY` in `src/main/codesign.ts` names it (`Stoke`),
`signatureBlocker` stops blocking a copy that carries it, and the release workflow imports and
*trusts* the `.p12` behind `MAC_CSC_LINK` before building. The installed copy on this machine
reports `designated => identifier "dev.vinn.stoke" and certificate leaf =
H"2bef4d37864a07cdffa024549f346178d9bf265c"` — the `Stoke` certificate — so a release signed
with it satisfies that requirement and the swap goes through.

Three things about that arrangement that will cost time if forgotten. **Setting
`CSC_LINK`/`CSC_KEY_PASSWORD` and stopping there does not work, and fails silently**:
electron-builder imports a `.p12` and sets its partition list but never trusts it
(`grep -rn add-trusted-cert node_modules/app-builder-lib/` finds nothing), then searches with
`security find-identity -v` — *valid* identities only — and an untrusted self-signed
certificate is not valid, so the build falls through to a warning and ships an unsigned
bundle. Hence the explicit `security add-trusted-cert` step, and hence `CSC_LINK` is
deliberately NOT left set on the build step (with it set, electron-builder builds its own
untrusted keychain and searches that one instead). **The identity name is a shared constant
across three files** — `electron-builder.yml`, `codesign.ts`, and the `.p12` itself — and
naming one the pipeline does not use converts a cheap up-front refusal into a 120 MB download
that fails at the end. And **changing the certificate breaks the update chain exactly once**:
the installed copy pins the old leaf, so the first build under a new one must be installed by
hand, and macOS re-asks for the microphone grant because privacy permissions are tied to the
signature.

**macOS 26 removed Keychain Access, which kills every "export it from the GUI" recipe.**
Verified on 26.5.2: no `/System/Applications/Utilities/Keychain Access.app`, and `mdfind`
finds no copy anywhere. Searching for "keychain" opens the Passwords app, which has no
certificates section at all — so the honest report from following the old instructions is
"there is nothing in my certificates". `npm run mac:signing-secrets` does the whole job from
the CLI instead, and two things it guards against are worth knowing on their own.
**`security export` cannot select an identity by name** — it exports the entire keychain's
worth, four identities here, so the naive one-liner would ship three unrelated private keys
to GitHub; the bundle is split with openssl and the result is asserted to hold exactly one
identity and one key, matching the fingerprint `security find-identity` reported. And
**`gh secret set NAME < <(base64 -i missing.p12)` sets an empty secret and prints a tick**:
the process substitution opens an fd whether or not the command inside it succeeded, so `gh`
reads zero bytes and reports success. The workflow's gate is `[ -n "$MAC_CSC_LINK" ]` for
exactly that reason, and says "unset or empty" rather than "not set".

Third, and separate: **`CSC_IDENTITY_AUTO_DISCOVERY: false` does not produce an ad-hoc
signature, it produces no signing pass at all.** With no identity to find, electron-builder
skips the step and ships whatever the prebuilt Electron binary carried. Measured on the
published `Stoke-0.5.2-arm64.zip`: `Identifier=Electron` rather than `dev.vinn.stoke`,
`codesign --verify --strict` exiting 1 with "code has no resources but signature indicates they
must be present", and **none** of the six entitlements `electron-builder.yml` specifies — no
microphone, no JIT, no `disable-library-validation`. The release job passes
`-c.mac.identity=-` now, which takes the real ad-hoc path (`MacTargetHelper.findSigningIdentity`
has an explicit `qualifier === "-"` branch); verified locally to give the right identifier, a
`--verify --strict --deep` exit 0, and all six entitlements. It still cannot auto-update, for
the `cdhash` reason above, but it is a valid app rather than a broken one.

> **Checked against the code on 2026-09-11** — an automated review, each point re-verified
> by a second pass. The entry above is the original text; where the two disagree, the code
> has moved on. Line numbers drift; search for the names.
> - Only on the fallback path now. `MAC_SIGN_ARGS=-c.mac.identity=-` (with `CSC_IDENTITY_AUTO_DISCOVERY=false`) is set solely by the 'Fall back to an ad-hoc signature' step (.github/workflows/release.yml:236-243), which runs only when `MAC_CSC_LINK` is unset or empty. With the secret present, 'Import and trust the signing certificate' sets `MAC_SIGN_ARGS=` empty (:213) and the build signs with `mac.identity: Stoke` from electron-builder.yml. Two comments in electron-builder.yml's mac block are stale the same way: 'CI overrides this on the command line with `-c.mac.identity=-`' and 'Signing is left on auto-discovery', both sitting beside a pinned `identity: Stoke`.
> - Five places, not three. .github/workflows/release.yml hardcodes it twice (`security find-certificate -c "Stoke"` at :207, and `security find-identity -v -p codesigning | grep -q "Stoke"` at :212), and scripts/mac-signing-secrets.sh defaults `IDENTITY="${1:-Stoke}"` (:42). The RELEASE_IDENTITY doc comment in src/main/codesign.ts repeats the same 'three places' undercount.

## 67. One npm tree holds exactly one arch's terminal, so a cross-arch build ships a dead app with a green run

**`@lydell/node-pty` resolves its binary at RUNTIME and npm only installs the build host's.**
`node_modules/@lydell/node-pty/index.js:1` is

```js
const PACKAGE_NAME = `@lydell/node-pty-${process.platform}-${process.arch}`
```

and `requirePlatformSpecificPackage()` does `require(PACKAGE_NAME)`. The `.node` file is not in
`@lydell/node-pty` at all — it is in one of six siblings declared as `optionalDependencies`,
each carrying `os`/`cpu` fields, and npm installs only the one matching the machine it ran on.
So **one `npm ci` can furnish exactly one arch, and one `electron-builder` invocation can
produce exactly one working arch.**

`electron-builder --win --arm64` on `windows-latest` therefore packages `node-pty-win32-x64`.
The installer builds, installs, launches, and throws `MODULE_NOT_FOUND` on the first
`pty.start` — every tab dead, and **no build error anywhere in that sequence**. It is the
shape this file exists to catalogue: a green run over a broken product.

The same fact kills `--mac --universal` outright, which is why `dist:mac:universal` was
removed rather than left as an option. `app-builder-lib`'s `doUniversalPack` calls `doPack`
twice **from the same project directory and the same `node_modules`** and hands the two `.app`s
to `@electron/universal`. `arch` selects the Electron dist, not the npm tree, so both slices
get whichever single `node-pty-darwin-*` package is on disk and the other arch has no sibling
directory at all — MODULE_NOT_FOUND again, not a bad-architecture error, inside a bundle that
is also roughly twice the download.

**The whole matrix follows from that: one arch per job, on a native runner.** The list lives in
`scripts/targets.mjs` and nowhere else — the workflow reads it (`--matrix` through a `prepare`
job), and the `dist:*` scripts resolve their flags from it (`--build <key>`), because two
hand-kept lists of build flags is gotcha 62's defect and it had already happened here:
`dist:win:arm64` and `dist:mac:intel` existed in package.json for platforms CI never built.
`verify:targets` asserts each runner's real CPU against the arch its target claims, so
`windows-latest` + `--arm64` fails the suite rather than the user.

**And each build job reads back what it actually packaged** — `scripts/assert-packaged-pty.mjs`
walks `release/` for `app.asar.unpacked/node_modules/@lydell` and refuses anything but the
expected package. It is a directory listing, and it is the only thing that turns this silent
runtime failure into a red job.

## 68. A manifest is named per platform, not per arch, so two jobs writing one is the default outcome

**`getUpdateInfoFileName` applies an arch suffix only on Linux.**
`app-builder-lib/out/publish/updateInfoBuilder.js`:

| platform | x64 | arm64 | collide? |
|---|---|---|---|
| Windows | `latest.yml` | `latest.yml` | **yes** |
| macOS | `latest-mac.yml` | `latest-mac.yml` | **yes** |
| Linux | `latest-linux.yml` | `latest-linux-arm64.yml` | no |

`electron-updater/out/providers/Provider.js`'s `getChannelFilePrefix` mirrors it on the read
side, so Linux is the one platform where splitting arches across jobs is safe by construction.

**Within one invocation the collision is already solved for you** and it is worth knowing why,
because it is what makes the shipped `latest-mac.yml` look like it handles two artifacts:
`writeUpdateInfoFiles` keys tasks by file name and, on a hit, does
`existingTask.info.files.push(...task.info.files)`. **Across invocations there is no merge at
all** — that function ends in `outputFile`, which overwrites. Two jobs each write a
`latest.yml`, and `actions/download-artifact`'s `merge-multiple: true` then flattens them onto
one name **with no warning**. Whichever lands last wins; the other arch's installed copies read
a feed that does not list their build and stop updating, permanently and silently, while the
release looks complete from every angle. That is gotcha 24's failure shape, reached by a
different route.

So: unique artifact names per job, **no `merge-multiple`**, and
`scripts/merge-update-manifests.mjs` between the download and `gh release create`. Its rules
are `updateInfoBuilder.js`'s, transcribed: assert `version` identical across inputs and fail
loudly on a mismatch (a mismatch means two jobs built different commits); concatenate and
dedupe `files` by url; sort zip-first, then `arch === null` first, then by the `Arch` enum
(`ia32 0, x64 1, armv7l 2, arm64 3, universal 4`), so **`path`/`sha512` end up naming the x64
zip on a two-arch mac release** — correct, and only surprising if you expected arm64; take the
latest `releaseDate`. It carries its own YAML reader and writer so the publish job needs no
`npm ci`, and that writer is a transcription of js-yaml's own `chooseScalarStyle` plus the five
implicit resolvers, with three things that are measured rather than reasoned: `,[]{}` are
unsafe only as the FIRST character because a manifest value is always in block context;
`yes`/`no`/`on`/`off` are quoted by `DEPRECATED_BOOLEANS_SYNTAX` even though js-yaml 4 no
longer resolves them as booleans; and a tab or a line break is **refused**, because those send
js-yaml to a double-quoted style this does not reproduce.

`verify:manifests` is the suite, and it takes its oracles from the real thing rather than from
fixtures: the published v0.9.4 manifests must round-trip byte for byte, a two-arch merge must
equal what electron-builder's own `writeUpdateInfoFiles` writes for the same artifacts, and
electron-updater's own `findFile`/`MacUpdater.filterFilesForArch` must hand each arch its own
zip out of the merged feed. The counterfactual is asserted too: against an un-merged feed,
`findFile` throws `No files provided` on the arch that was dropped.

**The publish gate is derived from the matrix, not written out.** `check-release-assets.mjs`
asks `scripts/targets.mjs` which feed each target's updater fetches and what it must find
there, so adding a platform tightens the gate in the same edit. A missing manifest, a mac arch
listed only as a dmg, a manifest naming a file that was never uploaded, or a tag that disagrees
with what the manifests say all refuse the release.
