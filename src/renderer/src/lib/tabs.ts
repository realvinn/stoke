/**
 * Pure tab-list arithmetic, kept out of the React callbacks that used to own
 * it — the only way to check that code was to click.
 *
 * `scripts/verify-tabs.mts` runs this under `node --experimental-strip-types`,
 * which resolves no path aliases and compiles nothing. So the rule is not "no
 * imports" any more, it is narrower and it is the one that actually matters:
 * import ONLY from `src/shared`, ONLY by relative path, and ONLY with the `.ts`
 * extension spelled out — the same convention `src/main` follows and for the
 * same reason. An `@shared/...` specifier here typechecks and builds perfectly
 * and dies the moment the suite runs.
 */
import { cliFor, cliIdOf, isClaudeCode } from '../../../shared/codingClis.ts'
import type { CodingCliId } from '../../../shared/codingClis.ts'

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
 * The tab `delta` places along from `activeId`, wrapping at both ends.
 *
 * Wrapping rather than stopping: the strip is a ring in every editor that has
 * one, and a next-tab chord that silently does nothing at the last tab reads as
 * the shortcut not being bound. An unknown `activeId` — which is what the very
 * first render has, before the mount effect picks tabs[0] — lands on the first
 * tab going forwards and the last going back, rather than returning null and
 * making the first press of the chord after launch do nothing.
 *
 * Pure and here rather than inline in the keydown handler, for the reason
 * CLAUDE.md gotcha 31 gives: inside that closure the only way to check it is to
 * press the key.
 */
export function cycleTab(ids: string[], activeId: string | null, delta: -1 | 1): string | null {
  if (ids.length === 0) return null
  const at = activeId ? ids.indexOf(activeId) : -1
  if (at < 0) return delta > 0 ? ids[0] : ids[ids.length - 1]
  return ids[(at + delta + ids.length) % ids.length]
}

/**
 * `dragId` moved to `overId`'s index, as a new array.
 *
 * Splice-out-then-splice-in, so dragging right lands *after* the target and
 * dragging left lands *before* it — which is what the pointer is over in each
 * case. An unknown id on either side returns the same list rather than
 * throwing: a drop can land after the tab it was aimed at has closed.
 *
 * This is the one commit a tab drag makes, on release. Everything the strip
 * shows before then is a preview drawn with transforms (`previewSlot` below),
 * and the suite asserts the preview and this commit agree for every move.
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

/*
 * ------------------------------------------------------------ dragging a tab
 *
 * The maths behind the Chrome-style drag in `useTabDrag`. The drag used to be
 * HTML5 drag-and-drop, which hands the moving object to the OS: a translucent
 * bitmap floated freely over the whole window while the real tab sat faded in
 * its slot, and a neighbour only moved once the POINTER passed its centre —
 * 0.5 to 1.5 tab widths depending on where the tab was grabbed — and then
 * teleported a whole slot in one frame, because every swap was a committed
 * reorder of App state. "It doesn't move the other tabs."
 *
 * Now the real tab follows the pointer along the strip, the target slot is
 * decided by the dragged tab's own centre against a snapshot of the slots taken
 * when the drag began, and the neighbours slide into their preview slots with a
 * transform. Nothing the drag does changes what it measures, so no hysteresis
 * is needed, and the order is committed once, on release.
 *
 * Pure and here rather than inside the pointer handlers for gotcha 31's reason:
 * in a closure, the only way to check any of it is to drag.
 */

/** Pointer travel, in CSS px, before a press on a tab becomes a drag. */
export const TAB_DRAG_SLOP_PX = 3

/**
 * Whether a press has travelled far enough to be a drag rather than a click.
 *
 * Any direction, not only along the strip, so a press that wanders down off the
 * tab still lifts it and hands the rest of the press to the strip's pointer
 * capture. That is tidiness, not protection for the terminal: xterm reports
 * held-button motion and the release only for a press it saw itself, so a press
 * that began on a tab reaches the CLI as nothing whichever way it wanders —
 * measured in the running app against a session reporting any-motion (1003):
 * a press elsewhere, dragged across the pane and let go there, gave the pty no
 * mouse report at all, where a press inside the pane gave press, drag and
 * release. CSS px throughout — Interface scale changes rem, not pointer
 * coordinates.
 */
export function pastSlop(dx: number, dy: number, slop: number = TAB_DRAG_SLOP_PX): boolean {
  return Math.hypot(dx, dy) > slop
}

/**
 * The slot whose centre is nearest `x`, or -1 when there are no slots.
 *
 * Applied to the dragged tab's own centre, this is Chrome's swap: a neighbour
 * gives way once the dragged tab covers half of it, however far from the edge
 * the tab was grabbed. A tie goes to the lower index (strict `<`), so a tab
 * poised exactly halfway between two slots does not flicker between them.
 */
export function nearestSlot(centres: readonly number[], x: number): number {
  let best = -1
  let bestDistance = Infinity
  for (let i = 0; i < centres.length; i++) {
    const d = Math.abs(centres[i] - x)
    if (d < bestDistance) {
      best = i
      bestDistance = d
    }
  }
  return best
}

/**
 * How many slots tab `i` moves while the tab at `from` is previewed at `to`.
 *
 * Dragging right, everything the dragged tab has passed shifts one slot left to
 * close the gap it left; dragging left, one slot right. The dragged tab itself
 * reads 0 here — it follows the pointer, not a slot.
 */
export function previewShift(i: number, from: number, to: number): -1 | 0 | 1 {
  if (from < to && i > from && i <= to) return -1
  if (to < from && i >= to && i < from) return 1
  return 0
}

/** The slot tab `i` occupies in the preview. The dragged tab is shown at `to`. */
export function previewSlot(i: number, from: number, to: number): number {
  return i === from ? to : i + previewShift(i, from, to)
}

/** The part of an overflowing strip that is on screen, in the slots' own content coordinates. */
export interface DragView {
  /** The list's `scrollLeft`. */
  start: number
  /** `scrollLeft` plus the list's visible width. */
  end: number
  /** The dragged tab's width, so its far edge is held inside `end` too. */
  width: number
}

/**
 * The dragged tab's left edge, held between the first slot and the last —
 * and, given the `view`, inside the part of the strip that is on screen.
 *
 * The strip's own slots are the bound, which is also what keeps a lifted tab
 * out of the macOS traffic-light clearance, off the Windows caption buttons and
 * away from the + button: none of those is inside the list.
 *
 * The view matters once the strip overflows. Held by the slots alone, a tab
 * dragged to the edge to autoscroll followed the pointer half past it for the
 * whole of the scroll, and the list's overflow clipped it: measured in the
 * running app, 52 of a 112px tab out of sight, close button and half the title
 * gone behind the + button, while it was the one thing being moved. Chrome
 * holds a dragged tab inside the visible strip, and so does this. A view too
 * narrow to hold the tab at all is ignored rather than inverted.
 */
export function clampDrag(left: number, slotLefts: readonly number[], view?: DragView): number {
  if (slotLefts.length === 0) return left
  let first = slotLefts[0]
  let last = slotLefts[slotLefts.length - 1]
  if (view && view.end - view.width >= view.start) {
    first = Math.max(first, view.start)
    last = Math.min(last, view.end - view.width)
  }
  return Math.min(Math.max(left, first), last)
}

/**
 * Which ends of the view a lifted tab may still hang past: at most as far as
 * its own slot did when the drag began. Only ever switched off (`stillOver`).
 */
export interface Overhang {
  start: boolean
  end: boolean
}

/**
 * The view a lifted tab is held inside (`clampDrag`): the part of the strip on
 * screen, `scroll` to `scroll + visible`, widened at each end `over` still
 * allows to take in the tab's own slot `home`, when that slot is partly off
 * screen.
 *
 * Held by the visible part alone, a tab pressed where the strip's edge cut it
 * in half leapt the whole hidden width the moment the press became a drag —
 * measured in the running app, 56px out from under a pointer that had moved 4.
 * Widened, it follows the pointer from where it was, can go no further out than
 * that, and is held inside the view as soon as autoscroll or the pointer brings
 * the view past its slot. A slot already on screen widens nothing.
 */
export function dragView(
  scroll: number,
  visible: number,
  home: number,
  width: number,
  over: Overhang = { start: true, end: true }
): DragView {
  return {
    start: over.start ? Math.min(scroll, home) : scroll,
    end: over.end ? Math.max(scroll + visible, home + width) : scroll + visible,
    width
  }
}

/**
 * The overhang left once the lifted tab sits at `left`: an end whose allowance
 * the tab has come wholly inside is switched off for the rest of the drag.
 *
 * The allowance is for where the tab STARTED, not a licence. Kept for the
 * whole drag, it let a tab pressed half behind the right edge, dragged to the
 * left edge while the strip scrolled back 465px, and then dragged back past the
 * right edge run straight out of sight: measured in the running app, wholly
 * behind the + button for as long as autoscroll took to bring its old slot
 * back, because the view still stretched to take that slot in.
 */
export function stillOver(
  over: Overhang,
  left: number,
  width: number,
  scroll: number,
  visible: number
): Overhang {
  return {
    start: over.start && left < scroll,
    end: over.end && left + width > scroll + visible
  }
}

/**
 * How far to scroll a strip whose visible part runs from `start` to `end` so
 * that the span `left`..`right` is wholly on screen: negative towards the
 * start, positive towards the end, 0 when it already is. A span wider than the
 * view is lined up at its start. Screen or content coordinates, as long as all
 * four agree.
 *
 * For the tab a drag just put down. It is the selected tab — a press selects —
 * and a slot at the edge of an overflowing strip can be half behind the list's
 * clip: the tab was held on screen for the whole drag and then landed with its
 * close button and half its title out of sight. Measured in the running app,
 * 56 of 112px.
 */
export function revealDelta(left: number, right: number, start: number, end: number): number {
  if (left < start) return left - start
  if (right > end) return Math.min(right - end, left - start)
  return 0
}

/** How close to the strip's visible edge, in CSS px, a drag starts scrolling it. */
export const AUTOSCROLL_ZONE_PX = 24
/** The fastest the strip scrolls under a drag, in CSS px per second. */
export const AUTOSCROLL_MAX_PX_S = 600

/**
 * How fast an overflowing strip should scroll under a drag, in px per second:
 * negative towards the start, positive towards the end, 0 in the middle.
 *
 * It ramps with depth into the edge zone and holds at full speed past the edge,
 * so dragging off the end of the strip keeps it moving. HTML5 drag-and-drop may
 * or may not have autoscrolled a hidden-scrollbar list; a pointer drag
 * certainly does not, so this is the whole of it.
 */
export function autoscrollVelocity(
  x: number,
  start: number,
  end: number,
  zone: number = AUTOSCROLL_ZONE_PX,
  max: number = AUTOSCROLL_MAX_PX_S
): number {
  if (end - start <= 2 * zone) return 0
  if (x < start + zone) return -max * Math.min(1, (start + zone - x) / zone)
  if (x > end - zone) return max * Math.min(1, (x - (end - zone)) / zone)
  return 0
}

/**
 * The session tabs in the order their terminal panes are rendered — sorted by
 * id, which is to say an order that does not follow the strip.
 *
 * The panes are stacked and all but one hidden, so their DOM order means
 * nothing on screen. It mattered anyway, because it followed the strip: a
 * reorder that moved a pane's node blurred the xterm inside it, so dragging
 * the active tab rightwards took the keyboard away from the session you were
 * typing into. Keyed on a pure function of the SET of tabs, a reorder moves no
 * pane at all, and an open or a close only inserts or removes one — React
 * never moves an existing node for either.
 */
export function paneOrder<T extends { id: string; kind: string }>(list: readonly T[]): T[] {
  return list
    .filter((t) => t.kind === 'session')
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
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
  | { kind: 'local'; cwd: string; cli: CodingCliId }
  | { kind: 'impossible'; reason: string }

export function restartPlan(
  tab: { cwd: string; hostId?: string | null; cliId?: CodingCliId },
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
  /*
   * The CLI travels with the plan. Without it "Start again" on an exited Codex
   * tab spawns `claude` in that folder — a different program, silently, in a
   * tab that still says Codex.
   */
  return { kind: 'local', cwd: tab.cwd, cli: cliIdOf(tab.cliId) }
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
 * The running version comes from the process itself — the CLI's session
 * registry, else its statusLine payload (`version`) — never from a version
 * stamped on the tab at launch. The two differ precisely when it matters — a
 * stamp records what Stoke *believed* was installed at spawn time, and the
 * whole premise here is that that belief goes stale.
 *
 * An offer is not permission to act. `busy` says whether a turn is running,
 * and `requestRelaunch` (App.tsx) asks before killing one; `sessionId` is the
 * session to bring back, which after a `/clear` is not the one the tab was
 * launched with.
 */
export type RelaunchPlan =
  | {
      kind: 'offer'
      running: string
      installed: string
      /**
       * The session to bring back: the one the process is on NOW, from the
       * CLI's own registry when it has said, else the tab's. See `live` below.
       */
      sessionId: string
      /**
       * Nothing has been written for this session yet, so a relaunch starts the
       * same id afresh (`--session-id`) rather than resuming one. Main decides
       * the flag against the disk in the end (`resumeOrMint`); this is what the
       * renderer asks for and what the dialog can say.
       */
      fresh: boolean
      /**
       * A turn in flight: true, idle: false, cannot say: null. Only a stated
       * `false` may relaunch without asking — killing the process mid-turn
       * loses the turn (SIGHUP fires no `Stop`, the streaming reply is never
       * persisted, and the resumed session opens on "Interrupted").
       */
      busy: boolean | null
    }
  | { kind: 'none'; reason: string }

/**
 * What the CLI's own session registry says about the tab's process — the
 * fields of `LiveSessionState` the plan reads. See `src/shared/claudeRegistry.ts`.
 */
export interface LiveReading {
  sessionId: string | null
  busy: boolean | null
  version: string | null
}

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
export function versionNumber(raw: string | null): string | null {
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
    cliId?: CodingCliId
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
  /**
   * The CLI's own registry reading for this tab's process, when there is one.
   *
   * It wins on the two things it states, and both wins are corrections, not
   * preferences. Its `sessionId` is the session the process is on NOW: a
   * `/clear` or an in-TUI `/resume` moves it, and a tab that has not heard the
   * rebind yet still holds the old id — relaunching that one resumes the
   * pre-`/clear` conversation, or, when the old id never got a transcript,
   * exits 1 with "No conversation found". And its `version` is the running
   * binary, stated from the first second, where the payload's arrives only
   * once the TUI renders (gotcha 48 is about reading the right one of those).
   */
  live?: LiveReading | null
  /**
   * Whether a transcript exists for a session id: true, false, or null when
   * nothing has said. `contexts[id].ready` is the renderer's answer — the
   * context watcher found the file.
   */
  hasTranscript?: (sessionId: string) => boolean | null
}): RelaunchPlan {
  const { tab } = input
  const live = input.live ?? null
  // Normalised at the door, so nothing below can accidentally compare or
  // display a raw `--version` line. The registry's version first: it is the
  // binary the process is running, stated before the payload says anything.
  const running = versionNumber(live?.version ?? null) ?? versionNumber(input.running)
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
   * Before the no-id branch below, deliberately.
   *
   * A non-Claude session has no id either, so falling through would refuse it
   * with "this session was continued rather than started" — a sentence about
   * Claude Code's `--continue`, offered for a tab not running Claude Code at
   * all. And the refusal has to happen at all, because this pill's entire
   * action is `claude --resume <id>`: an offer here would replace a Codex
   * session with a Claude one, in the same tab, on one click.
   */
  if (!isClaudeCode(cliIdOf(tab.cliId))) {
    return {
      kind: 'none',
      reason: `This session runs ${cliFor(cliIdOf(tab.cliId)).label}, which Stoke does not update.`
    }
  }

  /*
   * No id, no resume. A `--continue` session's id is chosen by the CLI after
   * launch; the registry names it within a second or two (and the tab is
   * rebound to it), so this refusal now only covers that first second — and a
   * machine where the registry cannot be read at all. Quietly relaunching into
   * the WRONG conversation is a far worse failure than not offering.
   */
  const sessionId = live?.sessionId || tab.sessionId
  if (!sessionId) {
    return {
      kind: 'none',
      reason: 'This session was continued rather than started, and has not said its id yet.'
    }
  }

  // Not "no update": not knowing and being current are different, and only the
  // second one is a reason to be quiet about it forever.
  if (!running) return { kind: 'none', reason: 'This session has not reported its version yet.' }
  if (!installed) return { kind: 'none', reason: 'Stoke could not read the installed version.' }
  // Both are normalised, so this compares numbers rather than sentences.
  if (running === installed) return { kind: 'none', reason: 'Already running the installed version.' }

  return {
    kind: 'offer',
    running,
    installed,
    sessionId,
    fresh: input.hasTranscript?.(sessionId) === false,
    busy: live?.busy ?? null
  }
}

/** Who asked for a relaunch that is waiting for its session to go idle. */
export type PendingOrigin = 'user' | 'auto'

/**
 * What a relaunch waiting for idle should do right now: fire, keep waiting, or
 * be dropped.
 *
 * Dropped when the plan stops being an offer — the tab exited or closed, was
 * relaunched some other way, or the versions agree now — because a pending
 * relaunch that outlives its reason would fire later on a session nobody asked
 * to have killed. Only a stated idle (`busy === false`) fires; `null` waits,
 * like `true`, because "cannot say" is not permission.
 *
 * An AUTOMATIC one is also dropped, back to the pill, the moment its tab is in
 * front or has been typed into since its last submitted prompt — the two cases
 * where "idle" can be hiding someone mid-sentence, since typing a draft leaves
 * the registry saying `idle` (measured). One the USER asked for with Wait fires
 * regardless: they chose it, looking at the tab.
 */
export function pendingRelaunchStep(input: {
  origin: PendingOrigin
  plan: RelaunchPlan
  inFront: boolean
  typedSinceSubmit: boolean
}): 'fire' | 'wait' | 'drop' {
  const { plan } = input
  if (plan.kind !== 'offer') return 'drop'
  if (input.origin === 'auto' && (input.inFront || input.typedSinceSubmit)) return 'drop'
  if (plan.busy !== false) return 'wait'
  return 'fire'
}

/**
 * Whether a tab should be relaunched onto a newly installed CLI without being
 * asked (`Settings.cliRelaunch === 'auto'`): now, once it goes idle, or not.
 *
 * Never the tab in front — someone may be typing into it; it keeps the pill.
 * Never one typed into since its last submitted prompt, for the same reason
 * one tab over. Never twice for the same session and target version
 * (`alreadyTried`, keyed by `autoRelaunchKey`): if a relaunch comes back on the
 * old version — a `claude` on PATH that is not the one `claude --version`
 * answered for — a level-triggered rule would otherwise kill and restart that
 * session once a second, forever.
 */
export function autoRelaunchStep(input: {
  mode: 'ask' | 'auto'
  plan: RelaunchPlan
  inFront: boolean
  alreadyTried: boolean
  pending: boolean
  relaunching: boolean
  typedSinceSubmit: boolean
}): 'relaunch' | 'queue' | 'skip' {
  const { plan } = input
  if (input.mode !== 'auto' || plan.kind !== 'offer') return 'skip'
  if (input.inFront || input.alreadyTried || input.pending || input.relaunching) return 'skip'
  if (input.typedSinceSubmit) return 'skip'
  return plan.busy === false ? 'relaunch' : 'queue'
}

/** One automatic attempt per session per target version. See `autoRelaunchStep`. */
export function autoRelaunchKey(plan: { sessionId: string; installed: string }): string {
  return `${plan.sessionId}@${plan.installed}`
}

/**
 * The running tabs whose process says a turn is in flight — what a restart of
 * the whole app would interrupt. A tab with no reading (SSH, another CLI, a
 * registry that could not be read) is not counted: nothing can say, and the
 * dialog would otherwise ask about every SSH tab forever.
 */
export function busyTabIds(
  tabs: readonly { id: string; kind: string; status: string; ptyId: string }[],
  live: Readonly<Record<string, { busy: boolean | null } | undefined>>
): string[] {
  return tabs
    .filter((t) => t.kind === 'session' && t.status === 'running' && live[t.ptyId]?.busy === true)
    .map((t) => t.id)
}

/**
 * The tab list with the tab on `ptyId` moved onto `sessionId`, or the same
 * array when nothing changed (so a no-op rebind costs no render).
 */
export function rebindTabs<T extends { ptyId: string; sessionId: string }>(
  list: T[],
  ptyId: string,
  sessionId: string
): T[] {
  if (!ptyId || !sessionId) return list
  let changed = false
  const next = list.map((t) => {
    if (t.ptyId !== ptyId || t.sessionId === sessionId) return t
    changed = true
    return { ...t, sessionId }
  })
  return changed ? next : list
}

/**
 * A session-keyed map with `from`'s entry moved to `to` — unless `to` already
 * has one, which is newer by construction and wins. The same object when
 * there is nothing to move.
 */
export function moveKey<V>(map: Record<string, V>, from: string, to: string): Record<string, V> {
  if (!from || from === to || !(from in map)) return map
  const next = { ...map }
  if (!(to in next)) next[to] = next[from]
  delete next[from]
  return next
}

/**
 * Whether bytes written to a pty were typing — text that could now be sitting
 * unsent in the prompt box — rather than keys and terminal chatter.
 *
 * xterm writes a great deal the user never typed: focus reports (`ESC [ I`),
 * mouse reports, answers to colour queries (OSC 11) and device attributes. All
 * of that is escape sequences; so are arrows and function keys. Strip them and
 * any printable character left over is typing, a paste included (its bracket
 * markers are escapes, its body is not). A bare Enter or Backspace is not.
 * Errs towards true, which only ever costs an automatic relaunch — the pill
 * stays.
 */
export function looksTyped(data: string): boolean {
  const rest = data
    // OSC … BEL or ST
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    // CSI, including SGR mouse and bracketed-paste markers
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // SS3 — application-mode arrows and F1-F4 are three bytes, `ESC O <final>`
    .replace(/\x1bO[\s\S]?/g, '')
    // Any other escape: Alt+key arrives as ESC and one character
    .replace(/\x1b[\s\S]?/g, '')
  return /[^\x00-\x1f\x7f]/.test(rest)
}

/**
 * Which tab is selected once a session finishes starting.
 *
 * Every single start focuses its new tab, which is right: you pressed a button
 * and the thing you asked for should be in front of you. `Resume all` is the
 * exception, and it was wrong in a way that got worse the more tabs you had.
 * It fires one `resumeTabFor` per paused tab, all concurrently, and each one
 * unconditionally called `setActiveTabId(tab.id)` when its own PTY came up — so
 * the selected tab was decided by whichever `pty.start` happened to resolve
 * LAST. Whatever you had been looking at, including a live session you were
 * typing into, was yanked away a second or two after the press, to a tab chosen
 * by a race.
 *
 * `focus: false` says "put this where it belongs, do not take me there". It is
 * not the same as never focusing, because a resumed tab is a NEW tab object
 * with a new id replacing the old one at its index: if the tab being replaced
 * was the selected one, leaving `activeTabId` alone would leave it naming a tab
 * that no longer exists. So the rule is "follow only if I was already there",
 * which for `Resume all` means the selection stays exactly where it was in
 * every case — either on something untouched, or on the same card, now live.
 *
 * The updater is functional rather than reading `activeTabId` from a closure:
 * several of these land in one tick and each must see the previous one's
 * result, which is gotcha 56's rule.
 */
export function focusAfterStart(
  setActiveTabId: (update: (current: string | null) => string) => void,
  newTabId: string,
  replacedTabId: string | null | undefined,
  focus: boolean | undefined
): void {
  setActiveTabId((current) =>
    focus === false ? (current === replacedTabId ? newTabId : (current ?? newTabId)) : newTabId
  )
}
