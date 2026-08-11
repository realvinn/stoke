/**
 * Profiles: which slice of the machine you are looking at.
 *
 * A profile is a **view filter and nothing more**. Every profile can reach
 * every file and every project — you can always open Claude's history, point at
 * any directory, and start or resume a chat anywhere. The point is that sitting
 * in a lecture you are not looking at work from somewhere else.
 *
 * They key off `Project.group`, which is already the parent folder's name, and
 * those folders already carry separate git identities.
 * So the grouping is not invented here — it is the one the machine already has.
 *
 * Two lists meet in this file:
 *
 *  - the **derived seed**, seen on a machine that has never touched Settings.
 *    It comes from the folders that actually exist and costs the user nothing.
 *  - the **stored records** in `Settings.profiles`, which are what the user
 *    made or changed. They win, and they survive a machine that has none of
 *    their folders — a Mac must not silently eat the Windows config.
 *
 * `resolveProfiles` merges the two. Everything else reads its output.
 */
import type { ProfileConfig } from './types'
/*
 * Relative with an explicit `.ts`, even though this is a shared module and the
 * rest of them import extensionlessly. Extensionless works only for type-only
 * imports, which are erased — this is a value import, and
 * `node scripts/verify-profiles.mts` loads this file directly under
 * --experimental-strip-types, where './paths' resolves to nothing. Both
 * tsconfigs allow the extension after Steps 5a and 5b.
 */
import { foldGroup } from './paths.ts'

/** The derived seed's shape. `ResolvedProfile` is assignable to this. */
export interface Profile {
  /** Matches `Project.group`, the parent folder name. */
  id: string
  label: string
  /** Replaces the theme accent while this profile is active. */
  accent: string
  accentHover: string
  accentSoft: string
  /** Text drawn on top of the accent. Must clear 4.5:1 against it. */
  accentContrast: string
  /**
   * A second colour for profiles that carry one. Only Study does; it marks the
   * chip so the two academic-looking profiles never blur together at a glance.
   */
  secondary?: string
}

/**
 * A profile after the derived seed and the stored record have been merged.
 *
 * It is a `ProfileConfig` — the persisted shape — plus the seed's optional
 * second colour, which has nowhere to live in the stored record and is not
 * worth a settings field of its own.
 */
export interface ResolvedProfile extends ProfileConfig {
  secondary?: string
}

export const PROFILES: Profile[] = [
  {
    id: 'personal',
    label: 'Personal',
    // Unchanged: this is the app's own accent, and personal work is the default
    // register the theme was designed around.
    accent: '#ff9552',
    accentHover: '#ffab74',
    accentSoft: 'rgba(255, 149, 82, 0.14)',
    accentContrast: '#1a1108'
  },
  {
    id: 'school',
    label: 'Study',
    // Red, paired with blue. Kept lighter than the danger token so a profile
    // never reads as an error state.
    accent: '#ff6b6b',
    accentHover: '#ff8a8a',
    accentSoft: 'rgba(255, 107, 107, 0.14)',
    accentContrast: '#1a0d0d',
    secondary: '#6ea8fe'
  },
  {
    id: 'work',
    label: 'Work',
    accent: '#5fd08a',
    accentHover: '#83deA5',
    accentSoft: 'rgba(95, 208, 138, 0.14)',
    accentContrast: '#08170f'
  },
  {
    id: 'side',
    label: 'Side',
    accent: '#b48ef7',
    accentHover: '#c8aaf9',
    accentSoft: 'rgba(180, 142, 247, 0.14)',
    accentContrast: '#140b1f'
  }
]

/** One assignable colour. Every entry clears 4.5:1, asserted by verify:profiles. */
export interface ProfileSwatch {
  id: string
  name: string
  accent: string
  accentHover: string
  accentSoft: string
  accentContrast: string
}

/**
 * The colours a profile may take.
 *
 * A fixed list rather than a free-form picker, because `accentContrast` is text
 * drawn on top of `accent` and a hand-typed pair goes unreadable without ever
 * erroring. Picking from here is the only way the UI assigns colour, so the
 * 4.5:1 floor holds by construction.
 *
 * The first four are the named profiles' own colours; the last four are what an
 * unrecognised folder gets, and their order is load-bearing — see FALLBACK.
 */
export const PROFILE_SWATCHES: ProfileSwatch[] = [
  {
    id: 'ember',
    name: 'Ember',
    accent: '#ff9552',
    accentHover: '#ffab74',
    accentSoft: 'rgba(255, 149, 82, 0.14)',
    accentContrast: '#1a1108'
  },
  {
    id: 'coral',
    name: 'Coral',
    accent: '#ff6b6b',
    accentHover: '#ff8a8a',
    accentSoft: 'rgba(255, 107, 107, 0.14)',
    accentContrast: '#1a0d0d'
  },
  {
    id: 'moss',
    name: 'Moss',
    accent: '#5fd08a',
    accentHover: '#83deA5',
    accentSoft: 'rgba(95, 208, 138, 0.14)',
    accentContrast: '#08170f'
  },
  {
    id: 'iris',
    name: 'Iris',
    accent: '#b48ef7',
    accentHover: '#c8aaf9',
    accentSoft: 'rgba(180, 142, 247, 0.14)',
    accentContrast: '#140b1f'
  },
  {
    id: 'azure',
    name: 'Azure',
    accent: '#6ea8fe',
    accentHover: '#8fbdff',
    accentSoft: 'rgba(110, 168, 254, 0.14)',
    accentContrast: '#08111f'
  },
  {
    id: 'amber',
    name: 'Amber',
    accent: '#f7c948',
    accentHover: '#f9d66f',
    accentSoft: 'rgba(247, 201, 72, 0.14)',
    accentContrast: '#1d1705'
  },
  {
    id: 'teal',
    name: 'Teal',
    accent: '#4ecdc4',
    accentHover: '#77dcd5',
    accentSoft: 'rgba(78, 205, 196, 0.14)',
    accentContrast: '#041a18'
  },
  {
    id: 'blossom',
    name: 'Blossom',
    accent: '#f78ec1',
    accentHover: '#faaed3',
    accentSoft: 'rgba(247, 142, 193, 0.14)',
    accentContrast: '#1f0913'
  }
]

/**
 * Colours for folders this file has never heard of.
 *
 * Deliberately the tail of PROFILE_SWATCHES and deliberately *copied* field by
 * field rather than spread: a swatch also carries `id` and `name`, and spreading
 * one into a derived profile would overwrite the profile's own id with the
 * colour's. The four entries and their order match the original list exactly, so
 * a machine with no named folders derives the colours it always did.
 */
const FALLBACK = PROFILE_SWATCHES.slice(4).map((s) => ({
  accent: s.accent,
  accentHover: s.accentHover,
  accentSoft: s.accentSoft,
  accentContrast: s.accentContrast
}))

/**
 * The one way group names and profile ids are compared, anywhere.
 *
 * Windows folder names are case-insensitive, and `Project.group` is whatever
 * casing the path happened to carry, so `Task` and `task` are the same folder
 * and must be the same profile. Comparing them raw made a profile silently
 * match nothing.
 */
export { foldGroup }

/** Last path segment, for either separator, ignoring a trailing one. */
export function folderName(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut >= 0 ? trimmed.slice(cut + 1) : trimmed
}

/*
 * `sameFolderName(path, name, caseInsensitive)` used to live here — the
 * "does this folder already carry this name" test, so `G:/Code/Task` named
 * `Task` did not become `G:/Code/Task/Task`. It is gone rather than kept: its
 * `caseInsensitive` flag was a platform guess, and `isNamed` in
 * src/main/profiles.ts answers the same question by asking the filesystem
 * whether the two paths are the same directory. Nothing in the app called this
 * after that change; only the suite did, and a helper kept alive by its own
 * test is how the guess would creep back in.
 */

/** Title-case a folder name for display: `my-projects` -> `My projects`. */
function titleCase(id: string): string {
  const words = id.replace(/[-_]+/g, ' ').trim()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** Stable index into FALLBACK, so an unseeded record keeps its colour. */
function swatchIndex(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h % FALLBACK.length
}

/**
 * Which profiles the folder layout alone suggests.
 *
 * The named profiles above describe one machine's layout. Hardcoding them meant
 * a machine organised any other way — a Mac with a single `~/Code` folder, say —
 * matched nothing and showed no profiles at all. So: use the named ones when
 * they are present, and otherwise fall back to whatever folders are actually
 * there, which is the same rule that produced the named list in the first place.
 *
 * `counts` maps a group to how many projects it holds. The fallback ignores
 * groups with a single project, since a lone repo parked in Documents is not a
 * category of work.
 *
 * This is only a **seed**, and it used to be less than that: with any named
 * folder present it returned the named list and stopped, so on a machine whose
 * only named folder is `personal` the whole of `work` had no chip and there
 * was no route to one except making a record by hand. The two halves are
 * merged now — named first in their own order, then whatever else holds more
 * than one project, capped at the four fallback colours. User records are
 * still layered on top by `resolveProfiles` rather than fighting for a place
 * in here.
 */
export function deriveProfiles(counts: Map<string, number>): Profile[] {
  const folded = new Set([...counts.keys()].map(foldGroup))
  const known = PROFILES.filter((p) => folded.has(foldGroup(p.id)))

  /*
   * What the named profiles already speak for: their ids, and their labels.
   * The labels matter — `work` is labelled Work, so a folder called
   * `work` sitting beside it would produce two chips reading Work, and the
   * chip is all the user sees.
   */
  const claimed = new Set<string>()
  for (const p of known) {
    claimed.add(foldGroup(p.id))
    claimed.add(foldGroup(p.label))
  }

  const extras: Profile[] = []
  const candidates = [...counts.entries()]
    .filter(([id, n]) => id.trim() !== '' && n > 1)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))

  for (const [id] of candidates) {
    if (extras.length >= FALLBACK.length) break
    const key = foldGroup(id)
    if (claimed.has(key) || claimed.has(foldGroup(titleCase(id)))) continue
    /* Both, exactly as the named loop above claims both — a seeded extra has a
       label as well as an id, and `my_stuff` and `my-stuff` are different ids
       that title-case to the same "My stuff". Claiming only the id let both
       through, and two chips reading the same word is the thing the comment
       above says the chip cannot survive. */
    claimed.add(key)
    claimed.add(foldGroup(titleCase(id)))
    const c = FALLBACK[extras.length]
    extras.push({
      id,
      label: titleCase(id),
      accent: c.accent,
      accentHover: c.accentHover,
      accentSoft: c.accentSoft,
      accentContrast: c.accentContrast
    })
  }

  return [...known, ...extras]
}

function seedToResolved(p: Profile): ResolvedProfile {
  return {
    id: p.id,
    groups: [p.id],
    label: p.label,
    accent: p.accent,
    accentHover: p.accentHover,
    accentSoft: p.accentSoft,
    accentContrast: p.accentContrast,
    secondary: p.secondary
  }
}

/** What a stored record with no matching seed gets for anything it omits. */
function unseeded(id: string): ResolvedProfile {
  const c = FALLBACK[swatchIndex(id)]
  return {
    id,
    groups: [id],
    label: titleCase(id),
    accent: c.accent,
    accentHover: c.accentHover,
    accentSoft: c.accentSoft,
    accentContrast: c.accentContrast
  }
}

/**
 * Lay one stored record over its seed.
 *
 * Every field is optional in practice: `store.ts` accepts a record as long as it
 * has an id and a groups array, precisely so a hand-edited `settings.json` that
 * only renames a profile does not have to restate four colours. Empty strings
 * count as absent for the same reason.
 *
 * `groups: []` is meaningful and must survive: it is how a deleted seed is
 * remembered. Nothing else can express "I do not want the Study chip" without a
 * settings field that does not exist.
 */
function overlay(seed: ResolvedProfile | undefined, rec: ProfileConfig): ResolvedProfile {
  const base = seed ?? unseeded(rec.id)
  const accent = rec.accent || base.accent
  return {
    id: base.id,
    groups: Array.isArray(rec.groups)
      ? rec.groups.filter((g) => typeof g === 'string' && g.trim() !== '')
      : base.groups,
    label: (typeof rec.label === 'string' && rec.label.trim()) || base.label,
    accent,
    accentHover: rec.accentHover || base.accentHover,
    accentSoft: rec.accentSoft || base.accentSoft,
    accentContrast: rec.accentContrast || base.accentContrast,
    createdByUser: rec.createdByUser ?? base.createdByUser,
    // Study's blue hairline belongs to Study's red. Recolouring the profile
    // drops it rather than pairing blue with whatever was chosen.
    secondary: accent === base.accent ? base.secondary : undefined
  }
}

/**
 * Every profile this machine knows about: the derived seed with the stored
 * records laid over it, then any stored record the seed never suggested.
 *
 * Nothing is dropped here. A record whose folders do not exist on this machine
 * stays in the list — losing it would mean opening Settings once on a second
 * machine and writing the first machine's profiles out of existence. Presence is
 * a rendering question, and `visibleProfiles` is where it is asked.
 */
export function resolveProfiles(
  counts: Map<string, number>,
  stored: ProfileConfig[]
): ResolvedProfile[] {
  const byId = new Map<string, ResolvedProfile>()
  const order: string[] = []

  for (const seed of deriveProfiles(counts)) {
    const key = foldGroup(seed.id)
    // Two groups differing only in case are one folder on Windows; the first
    // spelling seen wins rather than producing two chips for one place.
    if (byId.has(key)) continue
    byId.set(key, seedToResolved(seed))
    order.push(key)
  }

  for (const rec of stored ?? []) {
    if (!rec || typeof rec.id !== 'string' || rec.id.trim() === '') continue
    const key = foldGroup(rec.id)
    const seed = byId.get(key)
    if (!seed) order.push(key)
    byId.set(key, overlay(seed, rec))
  }

  return order.map((key) => byId.get(key) as ResolvedProfile)
}

/**
 * The profiles worth showing, given what is actually on this machine.
 *
 * A profile earns a chip when one of its groups holds a project, or when its
 * folder is one of the scanned roots. The second half matters more than it
 * looks: a profile created against a brand-new empty folder has no projects yet,
 * and without the roots check the user would press Create and watch nothing
 * happen — the exact failure mode this project keeps producing.
 */
export function visibleProfiles(
  profiles: ResolvedProfile[],
  counts: Map<string, number>,
  roots: string[] = []
): ResolvedProfile[] {
  const present = new Set<string>()
  for (const [group, n] of counts) if (n > 0) present.add(foldGroup(group))
  for (const root of roots) {
    const name = folderName(root)
    if (name) present.add(foldGroup(name))
  }
  return profiles.filter((p) => p.groups.some((g) => present.has(foldGroup(g))))
}

/**
 * Resolve the selected profile against a list.
 *
 * `available` is required and there is no fallback to `PROFILES`. There used to
 * be, and it meant a profile the user had deleted came back the moment anything
 * asked for it by id — the sidebar had no chip for it and the accent was painted
 * from it anyway.
 */
export function profileFor(
  id: string | null,
  available: ResolvedProfile[]
): ResolvedProfile | null {
  if (!id) return null
  const key = foldGroup(id)
  return available.find((p) => foldGroup(p.id) === key) ?? null
}

/** A free id for a new profile, keeping the group name where it is not taken. */
export function nextProfileId(group: string, taken: string[]): string {
  const base = group.trim() || 'profile'
  const used = new Set(taken.map(foldGroup))
  if (!used.has(foldGroup(base))) return base
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`
    if (!used.has(foldGroup(candidate))) return candidate
  }
  return `${base}-${Date.now()}`
}

/* ------------------------------------------------------------- the creator */

/**
 * What creating a profile will do to the disk.
 *
 *  - `reuse`  — the chosen folder is already the profile's folder, either
 *               because it is named that or because the child already exists.
 *  - `create` — nothing is there yet, so the child folder is made.
 *
 * There is deliberately no "adopt the chosen folder because it happens to hold
 * projects" case. That silently made picking `G:/Code` and naming a profile
 * `Task` produce a profile covering all of `G:/Code`, which looked like it had
 * worked. The name decides the folder; imports are a consequence of the folder.
 *
 * For a plan with no error the action and `willCreate` always agree — `create`
 * means `willCreate: true` and `reuse` means `willCreate: false`, enforced in
 * `planProfile`. `describePlan` below states the action in words, so the pair
 * disagreeing printed "It starts empty" above a list of the projects already
 * inside.
 */
export type ProfileAction = 'reuse' | 'create'

export interface ProfilePlan {
  action: ProfileAction
  /** The folder the user picked, as given. */
  chosen: string
  /** The folder that ends up holding this profile's projects. */
  root: string
  /**
   * The `Project.group` value this profile matches — the root's own name.
   * `Project.group` is `basename(dirname(path))`, so a profile rooted at
   * `G:/Code/Task` matches only what lives *inside* Task.
   */
  group: string
  /** Sub-folders that become projects as soon as the root is scanned. */
  imports: string[]
  /** True when `root` does not exist yet and has to be made. */
  willCreate: boolean
  /** Non-null means nothing can be written; the message is for the user. */
  error: string | null
}

export interface CreateProfileInput {
  folder: string
  name: string
  accent: string
  accentHover: string
  accentSoft: string
  accentContrast: string
}

/** One sentence describing a plan, for the preview shown before committing. */
export function describePlan(plan: ProfilePlan): string {
  if (plan.error) return plan.error
  const n = plan.imports.length
  const projects = n === 1 ? '1 project' : `${n} projects`
  switch (plan.action) {
    case 'reuse':
      return `Use ${plan.root} as it is — ${projects} already inside it join this profile.`
    default:
      return `Create ${plan.root}. It starts empty; anything you put in it joins this profile.`
  }
}
