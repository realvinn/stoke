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
