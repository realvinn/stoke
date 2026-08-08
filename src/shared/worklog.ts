import type { WorklogBoards, WorklogScanReport, WorklogTarget, WorklogWatchState } from './types'

/** Canonical order. Persisted lists are filtered through it, so what is stored
 *  cannot change the order anything is written in. */
export const WORKLOG_TARGETS: readonly WorklogTarget[] = ['notion', 'clickup']

/**
 * Notion only, by default.
 *
 * The ClickUp id is kept rather than blanked even though it is unused: it is a
 * real, working list, so ticking ClickUp later is one checkbox instead of a hunt
 * through a URL bar. A default that is present-but-unused costs nothing.
 */
export const DEFAULT_WORKLOG_BOARDS: WorklogBoards = {
  targets: ['notion'],
  notionDataSource: 'collection://368d3f2d-1f02-817c-b193-000b208e36bd',
  clickupListId: '901615258684'
}

/**
 * Whether the worklog is looking at this session, in one sentence.
 *
 * Lives here rather than in the panel because it is a rule, not a layout: the
 * panel, the settings sheet and anything else that has to answer "is this
 * thing on" must give the same answer. Every branch names a next step where
 * there is one — spec §2.4.4's finding was that the feature was silent, and a
 * sentence that only says "no" is barely less silent than nothing.
 */
export function watchSentence(
  state: WorklogWatchState | null,
  watchedGroups: string[]
): string {
  const armed = watchedGroups.filter((g) => g.trim()).join(', ')
  const armedClause = armed ? ` Watching: ${armed}.` : ''

  if (!state) return 'No session is open, so there is nothing to scan.'

  switch (state.reason) {
    case 'watched-host':
      return `This session runs on ${state.group ?? 'another machine'}, which is watched.`
    case 'unwatched-host':
      return `This session runs on ${state.group ?? 'another machine'}. The worklog is switched off for that machine — turn it on under Settings, in the host's own row.`
    case 'watched-group':
      return `This session is watched (${state.group ?? 'no group'}).${armedClause}`
    case 'unwatched-group':
      return `This session is in ${state.group ?? 'no group'}, which is not watched.${armedClause}`
    case 'unknown-folder':
      return `This session's folder belongs to no project and no scan root, so it cannot be placed in a group.${armedClause}`
    case 'off':
    default:
      return 'Nothing is watched yet. Tick a profile under Settings, Worklog agent, and sessions in its folders are reviewed on their own.'
  }
}

/** How many entries, worded rather than counted at the call site. */
function entries(n: number): string {
  return `${n} ${n === 1 ? 'entry' : 'entries'}`
}

/**
 * What the last scan did, in one sentence.
 *
 * `budget` is deliberately not folded into `error`: it is the one failure with
 * a fix, and spec §2.4.1 records that it presented as an empty result for the
 * whole life of the feature. Messages are shown verbatim because they name
 * something the user can act on.
 *
 * Two cases carry a message the brief's own draft skipped, both from Task 29
 * review:
 *
 *  - `'proposed'` can still carry one (H5): a scan that drafted entries
 *    without managing to read the board first stays `'proposed'` rather than
 *    getting recast as an error, because the drafts are real work worth
 *    reviewing — but they were written blind, so they may already sit on the
 *    board under another name. Dropping the message here would make that
 *    scan look identical to an ordinary clean one, which is exactly the
 *    silent failure H5 exists to close.
 *  - `'nothing'` can too: an empty transcript ("no turns yet") and a model
 *    that read a real conversation and decided there was nothing worth
 *    logging are different facts wearing the same outcome. `runWorklogScan`
 *    (src/main/index.ts) tells them apart and puts the former in `message`;
 *    without reading it here the two would print the identical sentence.
 *
 * Takes no clock: the caller prepends its own "N minutes ago", so nothing
 * shared has to know how this app formats time.
 */
export function scanSentence(report: WorklogScanReport): string {
  const subject = report.auto ? 'Stoke scanned this on its own' : 'A scan ran'
  switch (report.outcome) {
    case 'proposed': {
      const warning = report.message
        ? ` It could not check the boards first, though, so this may repeat something already there: ${report.message}`
        : ''
      return `${subject} and proposed ${entries(report.added)}.${warning}`
    }
    case 'budget':
      return `${subject} but stopped early: ${report.message ?? 'it ran out of budget'}.`
    case 'error':
      return `${subject} but failed: ${report.message ?? 'no reason was reported'}.`
    case 'nothing':
    default:
      return report.message
        ? `${subject} but ${report.message}.`
        : `${subject} and found nothing worth logging.`
  }
}
