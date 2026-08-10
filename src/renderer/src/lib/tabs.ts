/**
 * Pure tab-list arithmetic, kept out of the React callbacks that used to own
 * it — the only way to check that code was to click.
 */

/**
 * Which tab id to select once `closedId` is gone, or null when the list empties.
 *
 * The tab that takes the closed one's index, falling back to the one before it.
 * The old rule selected the *last* tab, so closing the first of five threw the
 * user to the far end of the strip — the one place they were not looking.
 */
export function neighbourOf(ids: string[], closedId: string): string | null {
  const at = ids.indexOf(closedId)
  if (at < 0) return null
  const rest = ids.filter((id) => id !== closedId)
  if (rest.length === 0) return null
  return rest[Math.min(at, rest.length - 1)]
}

/**
 * Insert `tab` at `replaceTabId`'s index in `list`, or append when
 * `replaceTabId` is absent or names a tab no longer in the list.
 *
 * A session started from a New Project tab takes that tab's place rather than
 * appending beside it — appending would leave the launcher sitting next to
 * the terminal it just started, which reads as the button having failed.
 * `startSession` and `startHostSession` both call this one function instead
 * of each carrying its own copy of the same replace-or-append arithmetic.
 */
export function replaceOrAppend<T extends { id: string }>(
  list: T[],
  tab: T,
  replaceTabId?: string | null
): T[] {
  const at = replaceTabId ? list.findIndex((t) => t.id === replaceTabId) : -1
  if (at < 0) return [...list, tab]
  const next = [...list]
  next[at] = tab
  return next
}
