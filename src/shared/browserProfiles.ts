/**
 * Profiles for the docked browser: separate sets of logins, like Chrome's
 * people. Each is its own persistent Electron partition, so cookies, storage
 * and cache never mix — which is what lets a Chrome or Safari profile be
 * imported as itself rather than poured into one jar where two accounts on the
 * same site overwrite each other.
 *
 * Not Stoke's other "profiles" (`profiles.ts`, project-group view filters).
 *
 * Pure: main derives partitions from it, settingsSchema hydrates with it, and
 * `scripts/verify-browser-profiles.mts` holds the rules without Electron.
 */

export interface BrowserProfile {
  /** `default`, or a generated id matching `PROFILE_ID`. Never shown. */
  id: string
  /** What the switcher shows. */
  label: string
  /** Where it came from, e.g. "Chrome · Work"; empty for one made in Stoke. */
  source: string
}

export const DEFAULT_BROWSER_PROFILE_ID = 'default'

export const DEFAULT_BROWSER_PROFILE: BrowserProfile = {
  id: DEFAULT_BROWSER_PROFILE_ID,
  label: 'Default',
  source: ''
}

/**
 * What a profile id may be. Lower-case and short on purpose: the id becomes a
 * partition name, and Electron lower-cases partition names, escapes spaces and
 * turns a `/` into a nested folder — so two ids differing only in case would
 * share one jar, and a hand-typed one could land anywhere.
 */
const PROFILE_ID = /^[a-z0-9]{1,24}$/

const MAX_LABEL = 40
const MAX_PROFILES = 32

/**
 * The partition a profile's tabs live in, derived and never stored. The
 * Default profile keeps the name the single browser always had, so everything
 * signed in before profiles existed is still signed in after.
 */
export function partitionFor(id: string): string {
  return id === DEFAULT_BROWSER_PROFILE_ID ? 'persist:stoke-browser' : `persist:stoke-browser-${id}`
}

/**
 * A settings file's profile list, repaired: Default always present and first,
 * ids valid and unique, labels non-empty and bounded. Anything unusable is
 * dropped rather than guessed at — an entry with a bad id could never be given
 * a partition anyway.
 */
export function hydrateBrowserProfiles(raw: unknown): BrowserProfile[] {
  const out: BrowserProfile[] = [{ ...DEFAULT_BROWSER_PROFILE }]
  if (!Array.isArray(raw)) return out
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const p = item as Partial<BrowserProfile>
    const label = typeof p.label === 'string' ? p.label.trim().slice(0, MAX_LABEL) : ''
    if (p.id === DEFAULT_BROWSER_PROFILE_ID) {
      // The Default profile may be renamed, never removed or re-sourced.
      if (label) out[0].label = label
      continue
    }
    if (typeof p.id !== 'string' || !PROFILE_ID.test(p.id)) continue
    if (out.some((q) => q.id === p.id)) continue
    if (out.length >= MAX_PROFILES) break
    out.push({
      id: p.id,
      label: label || 'Profile',
      source: typeof p.source === 'string' ? p.source.slice(0, 80) : ''
    })
  }
  return out
}

/** The active profile, or Default when the stored one is gone. */
export function clampCurrentProfile(raw: unknown, profiles: readonly BrowserProfile[]): string {
  return typeof raw === 'string' && profiles.some((p) => p.id === raw) ? raw : DEFAULT_BROWSER_PROFILE_ID
}

/**
 * A fresh id not already taken. `random` is passed in (main hands it
 * `crypto.randomUUID`) so the rule can be tested with a fixed sequence.
 */
export function newProfileId(taken: readonly BrowserProfile[], random: () => string): string {
  for (let i = 0; i < 64; i++) {
    const id = random().replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12)
    if (PROFILE_ID.test(id) && id !== DEFAULT_BROWSER_PROFILE_ID && !taken.some((p) => p.id === id)) return id
  }
  throw new Error('could not mint a browser profile id')
}

/** "Profile 2", "Profile 3", … — the first label not already used. */
export function nextProfileLabel(taken: readonly BrowserProfile[], base = 'Profile'): string {
  const used = new Set(taken.map((p) => p.label.toLowerCase()))
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}
