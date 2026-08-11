import type { WorklogBoards, WorklogTarget } from '@shared/types'
import { WORKLOG_TARGETS } from '../../../shared/worklog.ts'

/**
 * The id field that belongs to a destination. One place, so the tick box and
 * the disabled state cannot disagree about which id they mean.
 */
export function idFor(
  ids: Pick<WorklogBoards, 'notionDataSource' | 'clickupListId'>,
  target: WorklogTarget
): string {
  return target === 'notion' ? ids.notionDataSource : ids.clickupListId
}

/**
 * The record to store, given what the user just did.
 *
 * The same filter `hydrateWorklogBoards` applies (contracts §0.5,
 * settingsSchema.ts): canonical order, and a destination with no id is
 * dropped. Applying it here rather than trusting the store means the panel
 * can never show a destination the runner would refuse to write to — which is
 * the failure Task 19's "no board is switched on" error exists to catch, one
 * layer too late.
 *
 * Lives in its own file, apart from WorklogSettings.tsx, for one reason: that
 * file has JSX in it, and Node's type-stripping — which is how
 * scripts/verify-settings.mts runs, with no bundler — cannot load a `.tsx`
 * file at all (it does not recognise the extension). Pulling this one rule
 * out into a plain `.ts` module is what makes it something a script can import
 * and assert directly, rather than a copy of `hydrateWorklogBoards`'s rule
 * that only ever gets exercised by clicking through the panel.
 */
export function nextBoards(
  boards: WorklogBoards,
  ticked: Set<WorklogTarget>,
  ids: Pick<WorklogBoards, 'notionDataSource' | 'clickupListId'>
): WorklogBoards {
  const merged: WorklogBoards = { ...boards, ...ids, targets: boards.targets }
  return {
    ...merged,
    targets: WORKLOG_TARGETS.filter((t) => ticked.has(t) && idFor(merged, t).trim().length > 0)
  }
}
