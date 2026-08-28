#!/usr/bin/env bash
#
# Put the macOS release signing certificate into GitHub Actions secrets.
#
#   npm run mac:signing-secrets            # uses the "Stoke" identity
#   npm run mac:signing-secrets -- Other   # or name another one
#
# This exists because **Keychain Access was removed in macOS 26**, and every
# recipe for this job — including the one BUILDING.md used to give — begins
# "open Keychain Access". Verified on 26.5.2: there is no
# /System/Applications/Utilities/Keychain Access.app and `mdfind` finds no copy
# anywhere. Searching for "keychain" lands in the Passwords app instead, which
# has no certificates section at all, so the honest report from following the
# old instructions is "there is nothing in my certificates".
#
# What it produces is what .github/workflows/release.yml consumes:
#
#   MAC_CSC_LINK           base64 of a .p12 holding exactly one identity
#   MAC_CSC_KEY_PASSWORD   that .p12's password
#
# Why this matters at all: Squirrel.Mac checks a downloaded update against the
# RUNNING app's designated requirement, which for a certificate-signed build
# pins the leaf. So an installed copy can only be replaced by a build carrying
# the same certificate — and until CI has it, every release is ad-hoc signed
# (`cdhash H"…"`, satisfiable by nothing) and no Mac can auto-update. See
# BUILDING.md and CLAUDE.md gotcha 24.
#
# Two things it is careful about, both worth keeping if this is ever edited:
#
#   * `security export` cannot select an identity by name — it exports the whole
#     keychain's worth. On the machine this was written for that is FOUR
#     identities ("MyTouchBar Local", "Tinker Local", "localhost" and "Stoke"),
#     and shipping the other three's private keys to GitHub would be a real
#     leak. So the bundle is split with openssl and exactly one identity is
#     repackaged, then checked.
#   * The .p12 password is generated here and piped straight to `gh` on stdin.
#     Nobody ever sees it, types it, or pastes it, which means it cannot end up
#     in a shell history, a terminal scrollback or an AI transcript.

set -euo pipefail

IDENTITY="${1:-Stoke}"
KEYCHAIN="${KEYCHAIN:-$HOME/Library/Keychains/login.keychain-db}"

die() {
  echo "error: $*" >&2
  exit 1
}

[ "$(uname -s)" = "Darwin" ] || die "this only makes sense on macOS"
command -v gh >/dev/null || die "the GitHub CLI (gh) is not installed"
command -v node >/dev/null || die "node is not installed"
gh auth status >/dev/null 2>&1 || die "gh is not signed in — run: gh auth login"

# OpenSSL 3, not LibreSSL. `-legacy` is an OpenSSL 3 flag and is required in
# both directions here: macOS's Security framework cannot read an OpenSSL 3
# *default* PKCS#12 and reports it as a wrong password, and OpenSSL 3 cannot
# read the RC2-encrypted one `security export` writes without it either.
OPENSSL="$(command -v openssl)"
"$OPENSSL" version | grep -q '^OpenSSL 3' || die \
  "need OpenSSL 3 on PATH for -legacy support; found: $("$OPENSSL" version). Try: brew install openssl@3"

# The fingerprint the identity actually has, so the repackaged file can be
# checked against it rather than assumed correct. This is also the value that
# appears in the app's designated requirement:
#   codesign -d -r- /Applications/Stoke.app
#   => identifier "dev.vinn.stoke" and certificate leaf = H"<this, lowercased>"
WANT_SHA1="$(security find-identity -v -p codesigning \
  | awk -v id="\"$IDENTITY\"" '$3 == id { print $2 }')"
[ -n "$WANT_SHA1" ] || die "no valid codesigning identity named \"$IDENTITY\" in the keychain.
Existing identities:
$(security find-identity -v -p codesigning)"

TMP="$(mktemp -d)"
chmod 700 "$TMP"
# Every intermediate here holds unencrypted private keys for every identity in
# the keychain, so cleanup runs on any exit, not just the happy one.
trap 'rm -rf "$TMP"' EXIT INT TERM

# Ephemeral, and only ever inside $TMP. `security export` has no way to take a
# password other than on the command line, so this one is briefly visible to
# `ps`; it protects a file that exists for about a second in a 700 directory.
XFER_PW="$(openssl rand -base64 24)"
export STOKE_XFER_PW="$XFER_PW"

echo "==> exporting identities from $(basename "$KEYCHAIN")"
# stderr as well as stdout: `security` announces the byte count of the whole
# multi-identity bundle here, which is only ever confusing next to the
# single-identity result reported below.
security export -k "$KEYCHAIN" -t identities -f pkcs12 -P "$XFER_PW" -o "$TMP/all.p12" >/dev/null 2>&1

"$OPENSSL" pkcs12 -in "$TMP/all.p12" -passin env:STOKE_XFER_PW -nodes -legacy \
  -out "$TMP/all.pem" 2>/dev/null

cat > "$TMP/extract.mjs" <<'NODE'
/*
 * Pull one identity out of `openssl pkcs12 -nodes` output.
 *
 * The dump is a flat sequence of bags, each a "Bag Attributes" header followed
 * by one PEM block, with the certificate and the private key of one identity
 * appearing as two separate bags that share a friendlyName. Splitting on the
 * header and keeping the bags whose friendlyName matches is therefore enough,
 * and is more robust than trying to pair them by localKeyID.
 */
import { readFileSync, writeFileSync } from 'node:fs'

const [, , pemPath, name, outCrt, outKey] = process.argv
const bags = readFileSync(pemPath, 'utf8').split(/(?=Bag Attributes)/)

let cert = null
let key = null
for (const bag of bags) {
  // Anchored to the line, so "Stoke" does not also match "Stoke Local".
  if (!new RegExp(`^\\s*friendlyName: ${name}\\s*$`, 'm').test(bag)) continue
  cert ??= bag.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----\n/)?.[0] ?? null
  key ??= bag.match(/-----BEGIN (?:RSA |EC )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC )?PRIVATE KEY-----\n/)?.[0] ?? null
}

if (!cert) throw new Error(`no certificate bag named "${name}"`)
if (!key) throw new Error(`no private key bag named "${name}" — the identity has no exportable key`)
writeFileSync(outCrt, cert, { mode: 0o600 })
writeFileSync(outKey, key, { mode: 0o600 })
NODE

echo "==> extracting \"$IDENTITY\" (discarding every other identity)"
node "$TMP/extract.mjs" "$TMP/all.pem" "$IDENTITY" "$TMP/one.crt" "$TMP/one.key"

EXPORT_PW="$(openssl rand -base64 24)"
export STOKE_EXPORT_PW="$EXPORT_PW"
"$OPENSSL" pkcs12 -export -legacy -inkey "$TMP/one.key" -in "$TMP/one.crt" \
  -name "$IDENTITY" -passout env:STOKE_EXPORT_PW -out "$TMP/one.p12"

echo "==> verifying the repackaged bundle"
GOT_SHA1="$("$OPENSSL" x509 -in "$TMP/one.crt" -noout -fingerprint -sha1 \
  | sed 's/.*=//; s/://g')"
[ "$GOT_SHA1" = "$WANT_SHA1" ] || die "fingerprint mismatch: keychain says $WANT_SHA1, bundle has $GOT_SHA1"

# Exactly one identity, and it is the right one. A bundle that still carried a
# second identity would work perfectly and leak a private key, so this is
# checked rather than trusted.
BAGS="$("$OPENSSL" pkcs12 -in "$TMP/one.p12" -passin env:STOKE_EXPORT_PW -nokeys -legacy 2>/dev/null \
  | grep -c 'friendlyName:' || true)"
[ "$BAGS" = "1" ] || die "expected exactly one identity in the bundle, found $BAGS"

KEYS="$("$OPENSSL" pkcs12 -in "$TMP/one.p12" -passin env:STOKE_EXPORT_PW -nocerts -nodes -legacy 2>/dev/null \
  | grep -c 'BEGIN PRIVATE KEY' || true)"
[ "$KEYS" = "1" ] || die "expected exactly one private key in the bundle, found $KEYS"

echo "    sha1 $GOT_SHA1, 1 identity, 1 key"

echo "==> setting repository secrets"
# Piped rather than passed with --body, so neither value is ever an argv
# element visible to `ps`. `set -o pipefail` is on, so a failure in base64
# aborts instead of quietly setting an empty secret — which is exactly what
# `gh secret set X < <(base64 -i missing.p12)` does, tick and all.
base64 -i "$TMP/one.p12" | gh secret set MAC_CSC_LINK
printf '%s' "$EXPORT_PW" | gh secret set MAC_CSC_KEY_PASSWORD

cat <<EOF

Done. Both secrets are set from the "$IDENTITY" certificate.

The password was generated here and piped straight to gh; it is not printed,
stored, or recoverable. Re-run this script to rotate it.

Next: cut a release, or rehearse without publishing anything —

    gh workflow run Release && sleep 5 && gh run watch

The macOS job should annotate "Signing with the release certificate — this
build can auto-update." If it says MAC_CSC_LINK is unset or empty, the secrets
did not land. If the certificate imports but is unusable, the job fails at the
find-identity check rather than shipping a quietly unsigned app.
EOF
