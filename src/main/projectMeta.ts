/**
 * What the user has said about a folder, over and above what Claude's own files
 * record: an emoji, a display name, and whether they added the folder at all.
 *
 * Kept out of projects.ts and out of index.ts on purpose. index.ts imports
 * electron, so nothing in it can be run by a verify suite — and every one of
 * these rules fails by listing the wrong set of folders rather than by
 * throwing, which is exactly the class a typecheck cannot catch.
 *
 * Paths are compared with `pathKey`, never with `===`: the picker hands back
 * whatever casing the OS dialog produced, and on APFS and NTFS that is a
 * different string for the same folder.
 */
import type { Project, ProjectMeta, Settings } from '@shared/types'
import type { PathRules } from '../shared/paths.ts'
import { basenameOf, normalizePath, parentName, pathKey } from '../shared/paths.ts'

export interface ProjectMetaOptions {
  rules: PathRules
  /** `Settings.pinnedProjects`, so a manually added folder can be pinned too. */
  pinned: string[]
  /** Does this folder exist on disk? `existsSync` in the app. */
  exists: (path: string) => boolean
}

/**
 * The trim caps.
 *
 * Exported, and `settingsSchema.ts`'s `hydrateProjectMeta` imports `tidy` from
 * here rather than restating either number. Two copies of the same magic
 * number in two files, with a comment in one asserting they agree, is how the
 * store and the patch end up capping at different lengths and nothing fails.
 *
 * 16 characters of emoji, because a single glyph can be a ZWJ sequence of six
 * code points plus variation selectors; 64 of label, because it is a sidebar
 * row and anything longer is ellipsised into meaninglessness anyway.
 */
export const MAX_EMOJI_CHARS = 16
export const MAX_LABEL_CHARS = 64

/**
 * Trim and cap one record the same way `hydrateSettings` will on the way to
 * disk — because `hydrateSettings` calls this very function — so the patch a
 * caller gets back is byte-for-byte what ends up stored and a test can assert
 * on it.
 *
 * A record that says nothing is dropped rather than kept as `{}` — otherwise
 * the settings file accumulates an empty object for every folder that was ever
 * right-clicked.
 */
export function tidy(meta: ProjectMeta): ProjectMeta | null {
  const out: ProjectMeta = {}
  if (typeof meta.emoji === 'string') {
    const emoji = meta.emoji.trim().slice(0, MAX_EMOJI_CHARS)
    if (emoji) out.emoji = emoji
  }
  if (typeof meta.label === 'string') {
    const label = meta.label.trim().slice(0, MAX_LABEL_CHARS)
    if (label) out.label = label
  }
  // Only a literal true. A truthy leftover must not conjure a project out of a
  // folder nobody added.
  if (meta.addedManually === true) out.addedManually = true
  return Object.keys(out).length ? out : null
}

/** Every stored record except the one for `key`, plus that record if it exists. */
function split(
  stored: Record<string, ProjectMeta>,
  key: string,
  rules: PathRules
): { rest: Record<string, ProjectMeta>; current: ProjectMeta } {
  const rest: Record<string, ProjectMeta> = {}
  let current: ProjectMeta = {}
  for (const [path, value] of Object.entries(stored)) {
    if (pathKey(path, rules) === key) current = value
    else rest[path] = value
  }
  return { rest, current }
}

/**
 * The patch for "the user picked this folder in the Open dialog".
 *
 * Un-hiding is not a nicety: `listProjects` applies `hiddenProjects` last, so a
 * folder that was hidden and then explicitly added would be recorded, listed,
 * and then filtered straight back out — the picker would report success and the
 * sidebar would never change, which is precisely the failure spec 2.5 reports.
 */
export function manualProjectPatch(
  settings: Settings,
  rawPath: string,
  rules: PathRules
): Partial<Settings> {
  const path = normalizePath(rawPath.trim(), rules)
  if (!path) return {}
  const key = pathKey(path, rules)
  const { rest, current } = split(settings.projectMeta ?? {}, key, rules)
  const entry = tidy({ ...current, addedManually: true })
  if (entry) rest[path] = entry
  return {
    projectMeta: rest,
    hiddenProjects: (settings.hiddenProjects ?? []).filter((p) => pathKey(p, rules) !== key)
  }
}

/**
 * The patch for one folder's metadata record.
 *
 * `meta` REPLACES the record; it is not merged into it. The renderer already
 * holds every field on `Project`, so it can send the whole record, and a
 * replace has one unambiguous way to clear a field — where a merge would need
 * `undefined` to survive a structured clone, which is not something to bet a
 * user's pinned folder on. `null` deletes the record outright, which for a
 * folder that only existed because `addedManually` was set is also how it
 * leaves the sidebar.
 */
export function projectMetaPatch(
  settings: Settings,
  rawPath: string,
  meta: ProjectMeta | null,
  rules: PathRules
): Partial<Settings> {
  const path = normalizePath(rawPath.trim(), rules)
  if (!path) return {}
  const key = pathKey(path, rules)
  const { rest } = split(settings.projectMeta ?? {}, key, rules)
  const entry = meta ? tidy(meta) : null
  if (entry) rest[path] = entry
  return { projectMeta: rest }
}

/**
 * Add the folders only the user knows about, then stamp every project with its
 * record.
 *
 * The append half is the missing source spec 2.5 names: `listProjects` learns
 * about folders from Claude's history and from scan roots, and a scan root
 * enumerates its CHILDREN, so a single folder the user picked has never had any
 * way to become a project.
 */
export function applyProjectMeta(
  projects: Project[],
  meta: Record<string, ProjectMeta>,
  opts: ProjectMetaOptions
): Project[] {
  const { rules, pinned, exists } = opts
  const byKey = new Map<string, ProjectMeta>()
  for (const [path, value] of Object.entries(meta)) byKey.set(pathKey(path, rules), value)

  const out = [...projects]
  const present = new Set(out.map((p) => pathKey(p.path, rules)))
  const pinnedKeys = new Set(pinned.map((p) => pathKey(p, rules)))

  for (const [rawPath, value] of Object.entries(meta)) {
    if (value.addedManually !== true) continue
    const path = normalizePath(rawPath, rules)
    const key = pathKey(path, rules)
    if (!path || present.has(key)) continue
    present.add(key)
    out.push({
      path,
      name: basenameOf(path) || path,
      group: parentName(path),
      encodedDir: null,
      sessionCount: 0,
      lastModified: null,
      lastCost: null,
      lastPrompt: null,
      exists: exists(path),
      pinned: pinnedKeys.has(key),
      emoji: null,
      label: null,
      addedManually: true
    })
  }

  return out.map((p) => {
    const record = byKey.get(pathKey(p.path, rules))
    if (!record) return p
    return {
      ...p,
      emoji: record.emoji ?? null,
      label: record.label ?? null,
      addedManually: record.addedManually === true
    }
  })
}
