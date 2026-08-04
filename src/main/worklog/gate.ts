/**
 * The worklog gate: whether the agent is allowed to look at a session at all.
 *
 * The switch is per project *group* — the parent folder name that already
 * separates `personal` from `gitea-company` on this machine — and it is read off
 * the session's own working directory, **never** off the profile chip in the
 * sidebar. That distinction is the whole point of this file. The chip is a view
 * filter: a Work session can be running in a background tab while the user
 * browses Personal, so keying off the chip would either skip that session or,
 * worse, hand a personal session to an agent that files it into a work tracker.
 * Both failures are silent — the wrong sessions get logged, or none do — which
 * is why the rule lives in one small, tested function rather than inline at the
 * call site.
 *
 * Everything here is pure and touches neither disk nor Electron, so
 * `scripts/verify-worklog-gate.mts` can exercise it under
 * `node --experimental-strip-types` with no app running.
 */
import { basename, dirname, sep } from 'node:path'
import type { Project } from '@shared/types'

const isWin = process.platform === 'win32'

/**
 * Native separators, trailing ones removed. Deliberately the same rule as
 * `normalize` in projects.ts, because the paths we compare against were written
 * by it — any drift there would quietly stop matching here.
 */
function normalizePath(p: string): string {
  const trimmed = p.trim()
  const native = isWin ? trimmed.replace(/\//g, '\\') : trimmed.replace(/\\/g, '/')
  return native.replace(/[\\/]+$/, '') || native
}

/** Comparison key for a path: normalised, and case-folded where the OS is. */
function pathKey(p: string): string {
  const n = normalizePath(p)
  return isWin ? n.toLowerCase() : n
}

/**
 * Group names are folded on every platform, not just Windows. They are display
 * strings the user can retype (`ProfileConfig.groups` says "compared
 * case-folded"), so `Personal` and `personal` must be the same switch even on a
 * case-sensitive filesystem.
 */
export function foldGroup(group: string): string {
  return group.trim().toLowerCase()
}

/**
 * Resolve a session's working directory to the `Project.group` that owns it, or
 * null when no known project does.
 *
 * Only the passed project list is consulted — the group is never invented from
 * the shape of the path. Deriving it structurally would mean any folder that
 * happens to sit under a directory named `personal` gets treated as that
 * profile's work, including places that are not projects at all. The project
 * list already covers new repositories that have no Claude history yet, because
 * `listProjects` scans the configured project roots (projects.ts step 3); the
 * caller's job is simply to pass a current list rather than one cached at boot.
 *
 * A cwd *inside* a project counts as that project: sessions are often started a
 * level or two down, and the transcript records the real cwd.
 */
export function groupForCwd(cwd: string, projects: Project[]): string | null {
  const key = pathKey(cwd)
  if (!key) return null

  let best: Project | null = null
  let bestLength = -1

  for (const project of projects) {
    const projectKey = pathKey(project.path)
    if (!projectKey) continue

    // The separator on the prefix test is load-bearing: without it a project at
    // `…\Stoke` would claim `…\Stoke-old`, which is a different repo in a
    // possibly different group.
    const prefix = projectKey.endsWith(sep) ? projectKey : projectKey + sep
    if (key !== projectKey && !key.startsWith(prefix)) continue

    // Longest match wins, so a project nested inside another beats its parent.
    if (projectKey.length > bestLength) {
      best = project
      bestLength = projectKey.length
    }
  }

  if (!best) return null

  // `group` is normally already `basename(dirname(path))` (projects.ts:163).
  // Recompute when it is absent rather than reporting "no group": a Project can
  // be rebuilt by hand — a test fixture, or a record that crossed the remote
  // bridge — and losing the group there would silently switch the agent off.
  const group = best.group || basename(dirname(normalizePath(best.path)))
  return group || null
}

/** Whether a group is one the user asked the worklog agent to watch. */
export function isWatchedGroup(group: string | null, worklogGroups: string[]): boolean {
  if (!group) return false
  const wanted = foldGroup(group)
  if (!wanted) return false
  return worklogGroups.some((g) => foldGroup(g) === wanted)
}

/**
 * The gate itself: should the worklog agent review a session running in `cwd`?
 *
 * Note what this signature does *not* take: the active profile. There is
 * nowhere to pass the sidebar selection in, by design.
 *
 * An empty `worklogGroups` — the shipped default — watches nothing at all. Off
 * has to be genuinely off, or the first launch after an update would start
 * spending tokens on every session without anyone asking for it.
 */
export function shouldWatch(cwd: string, projects: Project[], worklogGroups: string[]): boolean {
  if (worklogGroups.length === 0) return false
  return isWatchedGroup(groupForCwd(cwd, projects), worklogGroups)
}
