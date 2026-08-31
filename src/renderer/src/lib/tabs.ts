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

/**
 * Whether this session can be moved onto the `claude` that is installed now,
 * without losing the conversation.
 *
 * A session holds whichever binary it spawned with for its entire life, so
 * updating the CLI — by hand, or by the automatic checker six hours in — leaves
 * every open chat on the old one, silently and indefinitely. There is no way to
 * swap it in place: the only route is to stop the process and start another,
 * which is exactly what `--resume <id>` already does for a tab restored from
 * the last run. This decides when that is worth offering, and refuses out loud
 * the rest of the time rather than showing a button that cannot work.
 *
 * Pure and separate from the callback that acts on it, for the reason
 * `restartPlan` above gives and CLAUDE.md gotcha 31 states: everything here is
 * a condition on a side effect inside a click handler, which is the shape no
 * suite can otherwise reach.
 *
 * `running` comes from the session's own statusLine payload (`version`), never
 * from a version stamped on the tab at launch. The two differ precisely when it
 * matters — a stamp records what Stoke *believed* was installed at spawn time,
 * and the whole premise here is that that belief goes stale.
 */
export type RelaunchPlan =
  | { kind: 'offer'; running: string; installed: string; sessionId: string }
  | { kind: 'none'; reason: string }

/**
 * The version number inside whatever the source happened to say.
 *
 * **The two sources do not agree on format, and comparing them raw is a bug
 * that shows nothing in a unit test and everything in the running app.**
 * `probeClaude` returns `stdout.trim()` from `claude --version`, which is
 * `"2.1.237 (Claude Code)"`; the statusLine payload's `version` is the bare
 * `"2.1.237"`. So `running === installed` was false *always* — measured by
 * driving the built app, where the offer appeared on a session that was
 * already on the installed binary and would have done so on every machine, on
 * every session, permanently. A pill that is always lit is worse than no pill:
 * it trains the user to ignore the one moment it means something.
 *
 * Null for anything with no version number in it at all, which then reads as
 * "not known" rather than being compared as a string.
 */
function versionNumber(raw: string | null): string | null {
  if (!raw) return null
  // The prerelease tail is captured rather than discarded: two builds that
  // differ only in it ARE different binaries, and treating them as equal would
  // suppress a legitimate offer.
  const m = /\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/.exec(raw)
  return m ? m[0] : null
}

export function relaunchPlan(input: {
  tab: {
    kind: 'session' | 'new'
    status: 'running' | 'exited' | 'paused'
    sessionId: string
    hostId: string | null
  } | null
  /**
   * This session's own reading, or null if none has arrived. A bare
   * `"2.1.237"` from the payload — but not assumed to be, see `versionNumber`.
   */
  running: string | null
  /**
   * What `claude --version` says on disk now, or null if unknown. This is
   * `CliInfo.version`, which is the WHOLE line — `"2.1.237 (Claude Code)"` —
   * not a parsed number.
   */
  installed: string | null
}): RelaunchPlan {
  const { tab } = input
  // Normalised at the door, so nothing below can accidentally compare or
  // display a raw `--version` line.
  const running = versionNumber(input.running)
  const installed = versionNumber(input.installed)
  if (!tab || tab.kind !== 'session') return { kind: 'none', reason: 'No session in front.' }

  /*
   * `exited` and `paused` are somebody else's job — "Start again" and "Resume
   * session" respectively, both of which already spawn a fresh process and so
   * already pick up whatever is installed. Offering a third button for the same
   * act would be three ways to do one thing.
   */
  if (tab.status !== 'running') {
    return { kind: 'none', reason: 'Starting this tab again already uses the installed version.' }
  }

  /*
   * An SSH tab runs `claude` on the far machine (gotcha 18), so the local
   * version is not its version and updating locally changes nothing about it.
   * It also gets no statusLine wrapper and therefore no payload at all
   * (gotcha 2), so `running` is null here anyway — this refusal is the reason
   * rather than the mechanism, and states it rather than falling through to
   * "no reading yet", which would read as a wait that will never end.
   */
  if (tab.hostId) {
    return { kind: 'none', reason: 'This session runs on another machine, which updates itself.' }
  }

  /*
   * No id, no resume. A `--continue` session's id is chosen by the CLI after
   * launch, so Stoke never learns it (gotcha 26) and `--resume` has nothing to
   * name. The payload does state the real id, so this is closable — but it
   * needs the launch key plumbed back to the renderer to match a payload to a
   * tab, and quietly relaunching into the WRONG conversation is a far worse
   * failure than not offering.
   */
  if (!tab.sessionId) {
    return {
      kind: 'none',
      reason: 'This session was continued rather than started, so Stoke does not know its id.'
    }
  }

  // Not "no update": not knowing and being current are different, and only the
  // second one is a reason to be quiet about it forever.
  if (!running) return { kind: 'none', reason: 'This session has not reported its version yet.' }
  if (!installed) return { kind: 'none', reason: 'Stoke could not read the installed version.' }
  // Both are normalised, so this compares numbers rather than sentences.
  if (running === installed) return { kind: 'none', reason: 'Already running the installed version.' }

  return { kind: 'offer', running, installed, sessionId: tab.sessionId }
}
