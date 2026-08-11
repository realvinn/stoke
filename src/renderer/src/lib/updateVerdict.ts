import type { CliRunResult, UpdateInfo } from '@shared/api'

/**
 * Whether "Update now" is worth pressing, and what to say on hover.
 *
 * The greying-out asked for: once a check says the CLI is current there is
 * nothing for the button to do, and after a successful update the re-check that
 * follows produces exactly that state. Two cases deliberately leave it enabled,
 * because in both of them *not knowing* is the reason and refusing to run the
 * updater would only remove the way to find out:
 *
 *   - the registry could not be reached, so `updateAvailable` is meaningless
 *   - the installed version could not be read at all
 *
 * That second one is why `current` is tested as well as `latest`. A missing
 * `claude` still yields a perfectly successful registry lookup and a false
 * `updateAvailable`, so testing `latest` alone disables the button beneath the
 * words "already on the latest version" — a claim about a version nobody read.
 *
 * @param info the last check, or null while the first one is still in flight.
 */
export function updateButton(info: UpdateInfo | null): { enabled: boolean; hint: string } {
  if (info === null) return { enabled: false, hint: 'Checking for updates…' }
  if (info.updateAvailable) {
    return { enabled: true, hint: `Install Claude Code ${info.latest}.` }
  }
  if (info.error !== null) {
    return { enabled: true, hint: 'Could not check the registry, but the updater can still be run.' }
  }
  if (info.current === null) {
    return {
      enabled: true,
      hint: 'Stoke could not read the installed version — run this to find out why.'
    }
  }
  if (info.latest === null) {
    return { enabled: true, hint: 'No version came back from the registry; the updater can still be run.' }
  }
  return { enabled: false, hint: `Already on the latest version (${info.latest}).` }
}

/**
 * What a finished `claude update` should say, in one line.
 *
 * Lives here rather than beside the panel that draws it so that a suite can run
 * it under `node --experimental-strip-types`, which cannot parse JSX — and this
 * is logic worth running, because the interesting outcomes are the quiet ones.
 *
 * The three that matter are not "worked" and "failed". They are:
 *
 *   - the version moved                  → it worked
 *   - nothing was waiting, nothing moved  → also fine, and must not read as a fault
 *   - something WAS waiting, nothing moved → a failure wearing a success's clothes
 *
 * That last case is the one a person means by "sometimes it doesn't work".
 * `claude update` exits 0 for it: an npm-global or Homebrew install that cannot
 * write to its own prefix reports no error and changes nothing. Exit status
 * therefore cannot answer "did it update?", which is why `from` and `to` are
 * measured either side of the run and compared here instead of inferred.
 *
 * @param wanted whether the check *before* the update found a newer version. It
 *   is the only thing separating case two from case three — identical results,
 *   opposite meanings. Reading it from a fresh check would always give false.
 */
export function updateVerdict(
  result: CliRunResult,
  wanted: boolean
): { tone: 'success' | 'danger' | 'warning'; text: string } {
  if (!result.ok) {
    return { tone: 'danger', text: result.error ?? 'The update failed.' }
  }
  if (result.from && result.to && result.from !== result.to) {
    return { tone: 'success', text: `Updated ${result.from} → ${result.to}.` }
  }
  if (wanted) {
    return {
      tone: 'warning',
      text: `The updater finished without error, but the version is still ${
        result.to ?? 'unchanged'
      }. Run doctor — an npm-global or Homebrew install usually has to be updated by its own package manager.`
    }
  }
  return { tone: 'success', text: `Already on ${result.to ?? 'the latest version'}.` }
}
