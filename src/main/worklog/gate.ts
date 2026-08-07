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
 * The path arithmetic itself now lives in `src/shared/paths.ts`, so the renderer
 * can apply the identical rule for the profile chip without a second
 * implementation. This file is the main-process face of it: it resolves the
 * platform once and keeps the three-argument signature the gate is tested on.
 */
import {
  foldGroup,
  groupForCwd as groupForCwdShared,
  pathRulesFor,
  type PathRules
} from '../../shared/paths.ts'
import type { Project } from '@shared/types'

/** This machine's comparison rules, resolved once. */
export const GATE_RULES: PathRules = pathRulesFor(process.platform)

export { foldGroup }

export function groupForCwd(cwd: string, projects: Project[], roots: string[] = []): string | null {
  return groupForCwdShared(cwd, projects, GATE_RULES, roots)
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
export function shouldWatch(
  cwd: string,
  projects: Project[],
  worklogGroups: string[],
  roots: string[] = []
): boolean {
  if (worklogGroups.length === 0) return false
  return isWatchedGroup(groupForCwd(cwd, projects, roots), worklogGroups)
}
