/**
 * The cwd → project group rule, in the one place both processes can run it.
 *
 * The switch this answers is per project *group* — the parent folder name that
 * already separates `personal` from `gitea-company` on this machine — and it is
 * read off the session's own working directory, **never** off the profile chip
 * in the sidebar. That distinction is the whole point of this module. The chip
 * is a view filter: a Work session can be running in a background tab while the
 * user browses Personal, so keying off the chip would either skip that session
 * or, worse, hand a personal session to an agent that files it into a work
 * tracker. Both failures are silent — the wrong sessions get logged, or none do
 * — which is why the rule lives in one small, tested module rather than inline
 * at each call site.
 *
 * It sits in `src/shared` rather than in `src/main/worklog/gate.ts` because the
 * renderer needs the same answer for the profile chip, and a second
 * implementation over there is exactly how the longest-prefix bug below got in.
 *
 * Everything here is pure and touches neither disk, Electron nor `process`, so
 * `scripts/verify-worklog-gate.mts` and `scripts/verify-profiles.mts` exercise
 * it under `node --experimental-strip-types` with no app running — and so
 * `tsconfig.web.json`, which gives `src/shared` no Node types, still compiles
 * it. The platform is passed in; it is never read.
 */
import type { Project } from './types'

/**
 * How this OS compares paths.
 *
 * Passed in rather than read off `process`, because this module is compiled for
 * the renderer too — and because case-folding on macOS is a real fix, not a
 * detail: APFS is case-insensitive by default, and gate.ts folded only on
 * Windows.
 */
export interface PathRules {
  sep: '/' | '\\'
  caseInsensitive: boolean
}

/** `process.platform` in main, `window.stoke.platform` in the renderer. */
export function pathRulesFor(platform: string): PathRules {
  return {
    sep: platform === 'win32' ? '\\' : '/',
    caseInsensitive: platform === 'win32' || platform === 'darwin'
  }
}

/**
 * Native separators, trailing ones removed. Deliberately the same rule as
 * `normalize` in projects.ts, because the paths compared here were written by
 * it — any drift there would quietly stop matching here.
 *
 * The empty string stays empty, and that is contractual: a `new` tab's cwd is
 * `''`, an empty prefix matches every path, and a value that survived as `'/'`
 * would hand every New tab the first project in the list.
 */
export function normalizePath(p: string, rules: PathRules): string {
  const trimmed = p.trim()
  if (!trimmed) return ''
  const native =
    rules.sep === '\\' ? trimmed.replace(/\//g, '\\') : trimmed.replace(/\\/g, '/')
  // A path that is nothing but separators — `/`, or `\\` — keeps them rather
  // than normalising to the empty string, which every prefix test matches.
  // `G:\\` becomes `G:`, and still compares correctly: everything under it
  // starts `G:\\`.
  return native.replace(/[\\/]+$/, '') || native
}

/** Comparison key for a path: normalised, and case-folded where the OS is. */
export function pathKey(p: string, rules: PathRules): string {
  const n = normalizePath(p, rules)
  return rules.caseInsensitive ? n.toLowerCase() : n
}

/**
 * Is `child` the same folder as `parent`, or inside it?
 *
 * The separator on the prefix test is load-bearing: without it a project at
 * `…/Stoke` claims `…/Stoke-old`, which is a different repo in a possibly
 * different group. An empty parent or child is inside nothing — that is the
 * empty-cwd guard, stated once and reused by `groupForCwd`.
 */
export function isInside(parent: string, child: string, rules: PathRules): boolean {
  const parentKey = pathKey(parent, rules)
  const childKey = pathKey(child, rules)
  if (!parentKey || !childKey) return false
  if (childKey === parentKey) return true
  const prefix = parentKey.endsWith(rules.sep) ? parentKey : parentKey + rules.sep
  return childKey.startsWith(prefix)
}

/**
 * Last path segment, either separator, ignoring trailing ones.
 *
 * Separator-agnostic and rules-free on purpose: it is also handed paths that
 * crossed the remote bridge from a machine whose separator is not this one.
 */
export function basenameOf(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  return cut === -1 ? trimmed : trimmed.slice(cut + 1)
}

/**
 * The segment before the last — which is what `Project.group` is.
 *
 * Empty for a path whose parent is the filesystem root, because `/` has no
 * name and inventing one would put every top-level folder in a group.
 */
export function parentName(p: string): string {
  const trimmed = p.trim().replace(/[\\/]+$/, '')
  if (!trimmed) return ''
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
  if (cut <= 0) return ''
  return basenameOf(trimmed.slice(0, cut))
}

/**
 * Group names are folded on every platform, not just where the filesystem is.
 * They are display strings the user can retype (`ProfileConfig.groups` says
 * "compared case-folded"), so `Personal` and `personal` must be one switch even
 * on a case-sensitive filesystem. Canonical home; `src/shared/profiles.ts`
 * re-exports it, so its existing importers are unaffected.
 */
export function foldGroup(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Resolve a working directory to the `Project.group` that owns it, or null.
 *
 * Three steps, in this order:
 *
 *  1. Longest-prefix match over `projects`, **skipping any project whose own
 *     path is one of `roots`**. A scan root is a container of projects, not a
 *     project; Claude registered it only because a session was once started
 *     there. Without that skip, `/Users/thevinh/dev/work` — itself a registered
 *     project — swallows every sibling under it and answers with group `dev`,
 *     which is spec §2.4.3 exactly: 7 of 12 work folders were never watched.
 *  2. The longest `root` that contains the cwd. The group is `basenameOf(root)`,
 *     because a project directly inside that root would have had
 *     `parentName(path)` — the root's own name.
 *  3. Null. The group is never invented from the shape of the path: any folder
 *     under a directory called `personal` would otherwise be treated as that
 *     profile's work, including places that are not projects at all.
 *
 * A cwd *inside* a project counts as that project: sessions are often started a
 * level or two down, and the transcript records the real cwd.
 */
export function groupForCwd(
  cwd: string,
  projects: Project[],
  rules: PathRules,
  roots: string[] = []
): string | null {
  if (!pathKey(cwd, rules)) return null

  const rootKeys = new Set(
    roots.map((r) => pathKey(r, rules)).filter((k) => k !== '')
  )

  let best: Project | null = null
  let bestLength = -1
  for (const project of projects) {
    const projectKey = pathKey(project.path, rules)
    if (!projectKey) continue
    // Step 1's skip. A root that is also a registered project is still a root.
    if (rootKeys.has(projectKey)) continue
    if (!isInside(project.path, cwd, rules)) continue
    // Longest match wins, so a project nested inside another beats its parent.
    if (projectKey.length > bestLength) {
      best = project
      bestLength = projectKey.length
    }
  }

  if (best) {
    // `group` is normally already `parentName(path)` (projects.ts:163).
    // Recompute when it is absent rather than reporting "no group": a Project
    // can be rebuilt by hand — a test fixture, or a record that crossed the
    // remote bridge — and losing the group there would silently switch the
    // agent off.
    return best.group || parentName(normalizePath(best.path, rules)) || null
  }

  let bestRoot = ''
  let bestRootLength = -1
  for (const root of roots) {
    const rootKey = pathKey(root, rules)
    if (!rootKey) continue
    if (!isInside(root, cwd, rules)) continue
    if (rootKey.length > bestRootLength) {
      bestRoot = root
      bestRootLength = rootKey.length
    }
  }
  if (bestRoot) return basenameOf(normalizePath(bestRoot, rules)) || null

  return null
}

/**
 * The two fields of a profile this rule needs.
 *
 * Structural rather than an import of `ResolvedProfile`, so paths.ts stays a
 * leaf: profiles.ts already imports this module, and a type-only import back
 * would be erased at runtime but would still read as a cycle to anyone
 * following the file.
 */
export interface GroupOwner {
  id: string
  groups: string[]
}

/**
 * Which profile owns the work in `cwd`, or null.
 *
 * Null means **leave the chip where it is**, not "select nothing". A tab whose
 * folder belongs to no profile must not clear whatever the user is looking at.
 *
 * Never call this for an SSH tab. `ssh -t <alias>` runs claude on the far
 * machine, so the tab's `cwd` holds the host alias rather than a folder — see
 * CLAUDE.md gotcha 18 — and resolving it would name whichever local project
 * happened to share that word. `Tab.hostId` is the signal that it is one.
 *
 * `roots` is the scan-root list, passed through to `groupForCwd` so a folder
 * that has no Claude history of its own still resolves through the root that
 * contains it.
 */
export function profileIdForCwd(
  cwd: string,
  projects: Project[],
  roots: string[],
  profiles: GroupOwner[],
  platform: string
): string | null {
  const group = groupForCwd(cwd, projects, pathRulesFor(platform), roots)
  if (!group) return null
  const key = foldGroup(group)
  const owner = profiles.find((p) => p.groups.some((g) => foldGroup(g) === key))
  return owner ? owner.id : null
}
