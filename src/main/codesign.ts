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
 *                 but only by a build signed with that same certificate, which
 *                 lives in one login keychain on one machine.
 *   Developer ID  the same shape, pinned to a certificate Apple issued, which
 *                 is the one case where the thing that built the release and
 *                 the thing running it can be expected to agree.
 *
 * So "is this copy Developer ID signed" is not a proxy for the real question,
 * it is very nearly the question itself.
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
  return `This copy is signed by "${authority}", a certificate that exists only on the machine that built it. macOS checks a downloaded update against this copy's own certificate, so the swap is refused unless the published build was signed with that same certificate. Install by hand from the .dmg, or sign your releases with it.`
}
