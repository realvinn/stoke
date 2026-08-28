/**
 * Reading a macOS code signature well enough to say whether this copy of Stoke
 * could ever install an update over itself.
 *
 * Pure, and in its own file with no `electron` import, for the reason
 * `projectMeta.ts` gives: `selfUpdate.ts` imports `app`, so nothing in it can
 * be run by a verify suite, and this is a rule that fails by returning the
 * wrong answer rather than by throwing — exactly the class a typecheck cannot
 * catch. `verify:updates` imports this directly.
 *
 * The thing being decided is narrow and worth stating precisely. Squirrel.Mac
 * installs an update by swapping one `.app` for another, and before it does it
 * checks the downloaded bundle against the *running* bundle's designated
 * requirement. What that requirement says is decided by how the running copy
 * was signed:
 *
 *   ad-hoc        `cdhash H"…"` — the hash of this exact binary. No other build
 *                 can satisfy it, by construction, ever.
 *   self-signed   `identifier "…" and certificate leaf = H"…"` — satisfiable,
 *                 but only by a build signed with that same certificate.
 *   Developer ID  the same shape, pinned to a certificate Apple issued, which
 *                 is the one case where the thing that built the release and
 *                 the thing running it can be expected to agree.
 *
 * The question is therefore not "is this Apple-signed" but "can the published
 * release satisfy this copy's requirement", and for a self-signed certificate
 * that has a real answer: yes, if the release was signed with the same one.
 * Measured on the copy this was written against —
 *
 *   designated => identifier "dev.vinn.stoke"
 *                 and certificate leaf = H"2bef4d37864a07cdffa024549f346178d9bf265c"
 *
 * — which is the "Stoke" certificate in the login keychain, and is satisfiable
 * by any build signed with it, CI's included. See RELEASE_IDENTITY below.
 */

/**
 * Authorities that mean "Apple issued this to a developer account", and so that
 * a release built elsewhere can plausibly carry the same certificate.
 *
 * `Developer ID Application` is the one that matters for a distributed app.
 * The others are here so a locally-signed development build is not reported as
 * a *permanent* blocker on the strength of a name Stoke did not recognise —
 * being wrong in the direction of "let them try" is the cheaper mistake.
 */
const APPLE_AUTHORITIES =
  /^(Developer ID Application|Apple Development|Apple Distribution|Mac Developer|3rd Party Mac Developer Application)\b/

/**
 * The certificate published releases are signed with, named exactly as
 * `codesign` reports it.
 *
 * This is the whole reason macOS auto-update works at all here, and it is a
 * shared secret between three places that have to agree or the rule below
 * lies: `mac.identity` in electron-builder.yml, the `.p12` behind the
 * `MAC_CSC_LINK` repository secret, and this constant. Change one and change
 * all three — BUILDING.md has the export recipe.
 *
 * It is a self-signed certificate rather than a Developer ID, which costs
 * nothing and is enough for the one thing Squirrel actually checks: the
 * downloaded bundle's leaf certificate against the running bundle's designated
 * requirement. It buys nothing else — the app is still unnotarised, so a first
 * install still meets Gatekeeper the hard way — but "the update swap is
 * refused" and "the first launch needs a right-click" are different problems
 * and only the first one is this file's business.
 *
 * The honesty condition: this must name a certificate the release pipeline
 * really uses. Naming one it does not turns a blocker that stops before
 * downloading into a 120 MB round trip ending in the same refusal, which is
 * strictly worse. The release workflow warns loudly when the secret is absent
 * and falls back to ad-hoc, and an ad-hoc *release* cannot update anyone
 * regardless of what this says.
 */
const RELEASE_IDENTITY = 'Stoke'

/** The leaf authority of a `codesign -dv` report, or null if it states none. */
export function leafAuthority(report: string): string | null {
  // `codesign -dv` prints the chain leaf-first, so the first line is the leaf.
  const line = /^Authority=(.+)$/m.exec(report)
  const name = line?.[1]?.trim()
  return name ? name : null
}

/**
 * Why this copy could never install a downloaded update, or null if it might.
 *
 * `report` is the *stderr* of `codesign -dv` — that is where it writes, which
 * is why the caller reads the failure path as attentively as the success one.
 *
 * Returns null whenever the answer is not a confident no. A probe that cannot
 * answer must not stand in the way of a path that might work.
 */
export function signatureBlocker(report: string): string | null {
  if (!report.trim()) return null

  if (/Signature=adhoc/.test(report)) {
    return 'This build is ad-hoc signed, so macOS will refuse to swap it for a downloaded one. Updates have to be installed by hand from the .dmg.'
  }

  const authority = leafAuthority(report)
  if (!authority) return null
  if (APPLE_AUTHORITIES.test(authority)) return null
  /*
   * The self-signed certificate the releases themselves are signed with. Its
   * designated requirement pins the leaf, and the leaf is the same one CI
   * signs with, so the swap is satisfiable — which is exactly what a locally
   * built copy needs, because a local build and a release build are signed by
   * the same certificate by construction.
   *
   * Compared exactly, not loosely. `codesign` reports the certificate's common
   * name verbatim, and a substring test would let "Stoke Local" or anything
   * else beginning with those five characters through.
   */
  if (authority === RELEASE_IDENTITY) return null

  /*
   * A self-signed certificate. This is the case that used to slip through, and
   * it is the worse of the two failures: the ad-hoc branch above at least
   * stopped before downloading. Here `blocked` stayed null, the panel offered
   * the update, and Squirrel refused the swap only after the whole archive had
   * been fetched — 123 MB on the release this was found against.
   *
   * Named rather than described, because the certificate is very often not the
   * one the reader expects: the copy that turned this up was signed by
   * "MyTouchBar Local", a certificate belonging to an entirely different
   * project that happened to be the only code-signing identity in the keychain
   * when electron-builder went looking for one.
   */
  return `This copy is signed by "${authority}", which is not the certificate Stoke's releases are signed with. macOS checks a downloaded update against this copy's own certificate, so the swap would be refused. Install by hand from the .dmg, or rebuild this copy with the "${RELEASE_IDENTITY}" certificate.`
}
