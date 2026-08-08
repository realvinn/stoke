/**
 * Whether the worklog agent may look at one session, and why.
 *
 * One predicate, deliberately. The red dot in the tab strip, the panel's
 * "is this thing on" sentence and the automatic run that costs real money all
 * read this — and if any two of them could disagree, the user would be told
 * one thing while another happened. It answers `why` as well as `whether`
 * because spec §2.4.4 records that "working but nothing to report" and "never
 * ran" were indistinguishable, and the reason is the field that separates them.
 *
 * The gate's own rule is preserved exactly: watching is decided from the
 * session's own working directory and **never** from the profile chip in the
 * sidebar. There is nowhere to pass the chip in — see gate.ts's header for why
 * that matters, and scripts/verify-worklog-gate.mts for the assertion.
 *
 * Two rules that only look like details:
 *
 *  - **A remote session is gated by its machine, before anything else.** An
 *    SSH session's `cwd` is the *local* folder Stoke was pointed at, not the
 *    directory the remote shell is in (CLAUDE.md gotcha 18), so the folder rule
 *    would match by accident or never — both silently.
 *  - **`worklogAuto` is not consulted here.** That switch decides whether a
 *    scan starts on its own; it does not decide whose business a session is.
 *    A watched session with auto off is still watched, and the Scan button
 *    still applies to it.
 *
 * Pure, and imports neither electron nor the filesystem, so
 * scripts/verify-worklog-gate.mts exercises every branch under
 * `node --experimental-strip-types`.
 */
import { groupForCwd, isWatchedGroup } from './gate.ts'
import type { Project, SshHost, WorklogWatchState } from '@shared/types'

/**
 * The part of an SSH host the gate reads.
 *
 * Declared as a Pick of SshHost rather than restated, because index.ts passes
 * hostForSession() straight in: if SshHost ever drops or renames one of these,
 * the typecheck fails here instead of the host gate silently widening.
 *
 * It resolves to `{ label: string; alias: string; worklog?: boolean }`. Only a
 * literal `true` in `worklog` switches a machine on.
 */
export type WatchHost = Pick<SshHost, 'label' | 'alias' | 'worklog'>

export interface WatchInput {
  sessionId: string
  /** The session's own working directory. Ignored entirely when `host` is set. */
  cwd: string
  /** The machine it runs on, when that is not this one. */
  host: WatchHost | null
  /** A current project list, never one cached at boot: a repository cloned
   *  during this run is a project the gate has to be able to see. */
  projects: Project[]
  /** `Settings.projectRoots`. A folder under a root belongs to that root. */
  roots: string[]
  worklogGroups: string[]
  /** Epoch ms this was decided. */
  now: number
}

export function watchStateFrom(input: WatchInput): WorklogWatchState {
  /** Field order matches WorklogWatchState's own declaration, `decidedAt` last —
   *  every caller and test compares this by serialised shape, so the order is
   *  part of the contract, not cosmetic. */
  const decide = (
    watched: boolean,
    reason: WorklogWatchState['reason'],
    group: string | null,
    remote: boolean
  ): WorklogWatchState => ({
    sessionId: input.sessionId,
    watched,
    reason,
    group,
    remote,
    decidedAt: input.now
  })

  if (input.host) {
    const group = input.host.label || input.host.alias || null
    return input.host.worklog === true
      ? decide(true, 'watched-host', group, true)
      : decide(false, 'unwatched-host', group, true)
  }

  const group = groupForCwd(input.cwd, input.projects, input.roots)

  /*
   * "Off" is reported before "unwatched", and the group is still named.
   *
   * An empty watch list is the shipped default and means the feature does
   * nothing at all — which is a different sentence from "this folder is not on
   * the list", and the panel says a different thing for each. Naming the group
   * anyway is what lets it say *which* profile to tick.
   */
  if (input.worklogGroups.length === 0) {
    return decide(false, 'off', group, false)
  }

  if (!group) {
    return decide(false, 'unknown-folder', null, false)
  }

  return isWatchedGroup(group, input.worklogGroups)
    ? decide(true, 'watched-group', group, false)
    : decide(false, 'unwatched-group', group, false)
}
