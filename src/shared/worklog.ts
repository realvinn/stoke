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
      /*
       * `state.group` is resolved even for 'off' - watch.ts computes it before
       * it ever checks whether `worklogGroups` is empty, and says so in as many
       * words ("Naming the group anyway is what lets it say which profile to
       * tick"). Task 29 review, minor 4: the sentence used to ask the user to
       * "tick a profile" without ever naming the one their own session sits in,
       * which is the whole reason the group was carried this far. Absent only
       * when the folder itself cannot be placed (no project, no scan root).
       */
      return state.group
        ? `Nothing is watched yet. This session is in ${state.group} — tick its profile under Settings, Worklog agent, and sessions in its folders are reviewed on their own.`
        : 'Nothing is watched yet. Tick a profile under Settings, Worklog agent, and sessions in its folders are reviewed on their own.'
  }
}

/** How many entries, worded rather than counted at the call site. */
function entries(n: number): string {
  return `${n} ${n === 1 ? 'entry' : 'entries'}`
}

/**
 * Names which session a report is about, because "this" is only sometimes true.
 *
 * `lastScan` (the caller's data, not this function's) is the last scan of
 * *any* session, and `AutoScanner` fires precisely on sessions that have gone
 * idle - the ones the user has usually switched away from, not the one on
 * screen (Task 29 review, finding 2). A manual scan is no safer: the button
 * scans whatever tab was active *then*, and the panel can still be showing
 * that report after the user has since switched tabs. Either way, the report
 * names its own session (`report.sessionId`) and the caller names the one on
 * screen (`activeSessionId`, from `WorklogWatchState.sessionId` - the panel
 * already resolves it for the state line above this one), so there is no
 * excuse for guessing.
 */
function subjectFor(report: WorklogScanReport, activeSessionId: string | null): string {
  const here = activeSessionId !== null && report.sessionId === activeSessionId
  return report.auto
    ? `Stoke scanned ${here ? 'this session' : 'another session'} on its own`
    : `A scan ran on ${here ? 'this session' : 'another session'}`
}

/**
 * Some upstream messages already arrive as complete, punctuated sentences
 * (`WorklogBudgetError`'s message, the unreadable-reply notice); others are
 * lowercase fragments written to read as the tail of "...but it: ⟨fragment⟩."
 * Splicing both kinds through the same "but X: ⟨message⟩." template is what
 * produced Task 29 review's broken frames — a doubled period on a message
 * that already ended in one, and a two-sentence message glued after a colon.
 *
 * This is the fix: treat every message as its own sentence, standing after
 * the subject rather than fused into it. Capitalises a fragment and gives it
 * a period; leaves anything that already ends in sentence-closing punctuation
 * — `.`, `!`, `?`, or a closing quote — exactly as it arrived. The quote case
 * matters on its own: `WorklogBudgetError` (runner.ts) quotes the CLI's own
 * words verbatim and deliberately ends there with no period, because the
 * words themselves are not this app's sentence to punctuate. Appending one
 * anyway is what put a stray period right after the closing quote.
 */
function asSentence(message: string): string {
  const trimmed = message.trim()
  if (!trimmed) return trimmed
  const capitalized = trimmed[0].toUpperCase() + trimmed.slice(1)
  return /[.!?"]$/.test(capitalized) ? capitalized : `${capitalized}.`
}

/**
 * What the last scan did, in one sentence.
 *
 * `budget` is deliberately not folded into `error`: it is the one failure with
 * a fix, and spec §2.4.1 records that it presented as an empty result for the
 * whole life of the feature. Messages are shown verbatim (via `asSentence`)
 * because they name something the user can act on — never paraphrased, only
 * punctuated correctly.
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
 *    without reading it here the two would print the identical sentence. This
 *    one is intentionally *not* run through `asSentence`: it is written as a
 *    fragment that continues "but ⟨message⟩", not a standalone sentence, and
 *    it carries no "this session" of its own — that would collide with a
 *    subject that just said "another session".
 *
 * `'budget'` and `'error'` messages, by contrast, always come from a source
 * this app fully controls (`WorklogBudgetError`, `WorklogParseError`, the
 * board-read budget message, or a missing-transcript fragment) and are always
 * run through `asSentence`, because at least two of those sources are already
 * complete sentences that a "but X: ⟨message⟩" frame would mangle.
 *
 * Takes the currently-active session id, not just the report, so the subject
 * can say "this session" only when it is actually true (Task 29 review,
 * finding 2) — pass `null` when no session is on screen at all.
 */
export function scanSentence(report: WorklogScanReport, activeSessionId: string | null): string {
  const subject = subjectFor(report, activeSessionId)
  switch (report.outcome) {
    case 'proposed': {
      const warning = report.message
        ? ` It could not check the boards first, though, so this may repeat something already there: ${report.message}`
        : ''
      return `${subject} and proposed ${entries(report.added)}.${warning}`
    }
    case 'budget':
      return report.message
        ? `${subject}. ${asSentence(report.message)}`
        : `${subject}, but ran out of budget before it could finish.`
    case 'error':
      return report.message
        ? `${subject}. ${asSentence(report.message)}`
        : `${subject}, but failed for no reason that was reported.`
    case 'nothing':
    default:
      return report.message
        ? `${subject}, but ${report.message}.`
        : `${subject} and found nothing worth logging.`
  }
}

/** What the title-bar worklog control is currently saying. */
export type WorklogButtonState = 'disarmed' | 'watching' | 'badged'

/**
 * Three states, in this order of precedence:
 *
 *  1. `badged` — something is waiting for a decision. It outranks everything,
 *     including the feature being switched off: a queue holding work the user
 *     has not ruled on has to stay reachable, or turning the agent off would
 *     hide real proposals with no way back to them.
 *  2. `watching` — at least one open session is the agent's business, so
 *     something may appear without being asked for.
 *  3. `disarmed` — nothing is watched and nothing is waiting. The control stays
 *     visible: hiding it made the feature unreachable on a clean install,
 *     because the only way to raise the count was the button inside the panel.
 */
export function worklogButtonState(
  states: WorklogWatchState[],
  pending: number
): WorklogButtonState {
  if (pending > 0) return 'badged'
  return states.some((s) => s.watched) ? 'watching' : 'disarmed'
}
