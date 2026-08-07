import type { WorklogBoards, WorklogTarget } from './types'

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
