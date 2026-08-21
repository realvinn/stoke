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

/**
 * `dragId` moved to `overId`'s index, as a new array.
 *
 * Splice-out-then-splice-in, so dragging right lands *after* the target and
 * dragging left lands *before* it — which is what the pointer is over in each
 * case. An unknown id on either side returns the same list rather than
 * throwing: a drop can land after the tab it was aimed at has closed.
 */
export function moveTab<T extends { id: string }>(
  list: T[],
  dragId: string,
  overId: string
): T[] {
  const from = list.findIndex((t) => t.id === dragId)
  const to = list.findIndex((t) => t.id === overId)
  if (from < 0 || to < 0 || from === to) return list
  const next = [...list]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/**
 * How a tab should be started again after its session exits.
 *
 * Pure, and separate from the callback that acts on it, because the bug this
 * exists to prevent was invisible to every suite in the repo. `restartTab` read
 * `startSession({ cwd: tab.cwd })` for every tab, and a remote tab's `cwd` is
 * the host *alias* rather than a path — `startHostSession` stores it that way
 * because an SSH session's real working directory is on the far machine
 * (CLAUDE.md gotcha 18). So "Start again" on a dropped VPS session launched a
 * local `claude` in a folder named `vps`, which does not exist. Measured: ssh
 * exited 255, Start again produced a second tab that exited 1 with an empty
 * terminal, and the status bar still named the alias as the working directory.
 *
 * The decision is three-way, not two, because a host can be deleted from
 * Settings while a tab that used it is still open — and "restart it locally in
 * a folder named after the alias" is the one answer that must never be given.
 */
export type RestartPlan =
  | { kind: 'host'; hostId: string }
  | { kind: 'local'; cwd: string }
  | { kind: 'impossible'; reason: string }

export function restartPlan(
  tab: { cwd: string; hostId?: string | null },
  hostIds: string[]
): RestartPlan {
  if (tab.hostId) {
    return hostIds.includes(tab.hostId)
      ? { kind: 'host', hostId: tab.hostId }
      : {
          kind: 'impossible',
          reason: 'That host is no longer in Settings, so there is nothing to reconnect to.'
        }
  }
  return { kind: 'local', cwd: tab.cwd }
}
