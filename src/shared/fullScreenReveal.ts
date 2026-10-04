/**
 * Keeping the tab strip reachable under macOS's full-screen reveal. Gotcha 105.
 *
 * In native full screen, pushing the pointer against the top of the screen
 * slides the menu bar down AND, under it, a standard title-bar strip holding the
 * traffic lights (Electron makes that strip opaque in full screen:
 * `NativeWindowMac::NotifyWindowEnterFullScreen`). Both are separate windows
 * drawn over the page, so the page cannot paint around them or click through
 * them. Measured on macOS 27 (MacBookPro17,1): a 30pt menu bar plus a 32pt
 * strip, 62pt in all, against a 44px title bar — every tab covered. macOS 27
 * also slides it down on ENTERING full screen and leaves it there while the
 * pointer is still, which is the report that started this.
 *
 * Nothing in Electron says when it is showing. What the page does see, measured
 * by warping the cursor over a full-screen window: a `mouseout` with no
 * `relatedTarget` the moment the pointer is over the strip or the menu bar
 * (at the pointer's own clientY — 0, 45, 61 all arrived), and a `mouseover`
 * the moment it is back on the page (63 was already the page). So the reveal
 * is inferred from where the pointer went, and the shell moves down under it —
 * once the pointer is ON the reveal, never in anticipation of it: macOS waits
 * before revealing, so a pointer that only touched the top edge moved the tabs
 * for a menu bar that never came ("my mouse hasn't even activated the top menu
 * bar and stoke already moved", the owner, 2026-10-05).
 *
 * Pure, with the geometry passed in, so `scripts/verify-fullscreen.mts` can run
 * the rule without a window, a screen or a pointer.
 */

/** Measured on macOS 27. Only used when the work area reads no menu bar. */
export const FALLBACK_MENU_BAR = 30
/** macOS 11–15's standard title bar. Only used when the measurement fails. */
export const FALLBACK_TITLE_BAR = 28
/** Anything past this is a bad read, not a menu bar. */
const MAX_INSET = 160

export interface RevealMeasure {
  /** The full-screen window's top edge, below its display's top edge. */
  windowTop: number
  /** `workArea.y - bounds.y` of that display: the menu bar's height, or 0 when hidden. */
  menuBar: number
  /** A standard titled window's frame-to-content height: the strip's height. */
  titleBar: number
}

/**
 * How far the reveal reaches into the full-screen window, in px from its top.
 *
 * A window that starts below its display's top — a notched MacBook, where full
 * screen stays under the camera housing, or "Automatically hide and show the
 * menu bar: Never" — already clears the menu bar, so only the strip reaches it.
 * That is Chromium's own rule (`TopUIFullscreenYOffset`). Otherwise the menu bar
 * lands on the window too. A menu bar that reads 0 is one hidden on the desktop
 * as well, which still slides down in full screen, so it takes the fallback
 * rather than being dropped — as does any read that is not a positive number.
 */
export function revealInsetFor(m: RevealMeasure): number {
  const titleBar = m.titleBar > 0 ? m.titleBar : FALLBACK_TITLE_BAR
  const inset = m.windowTop > 0 ? titleBar : (m.menuBar > 0 ? m.menuBar : FALLBACK_MENU_BAR) + titleBar
  return Math.min(Math.round(inset), MAX_INSET)
}

/** What main tells the renderer about full screen's reveal. */
export interface RevealInfo {
  /** `revealInsetFor`'s answer; 0 when not full screen or not a Mac. */
  inset: number
  /** Whether this macOS slides the reveal down on entering full screen (`revealsOnEntry`). */
  onEntry: boolean
}

/**
 * Whether this macOS slides the reveal down as full screen begins and leaves
 * it there. Measured on 27 only; 11–15 wait for the pointer at the top edge,
 * and 26 is unmeasured, so it is left out rather than guessed. Starting
 * shifted where it does not reveal would hold the tabs under an empty band.
 * `systemVersion` is `process.getSystemVersion()`.
 */
export function revealsOnEntry(systemVersion: string): boolean {
  const major = Number.parseInt(systemVersion, 10)
  return Number.isFinite(major) && major >= 27
}

export type RevealPointer =
  /**
   * A `mousemove` (or the `mouseup` ending a drag) on the page. `onTitleBar`:
   * over the title bar or something hanging off it — an open popover, its
   * backdrop, a context menu — which is still "at the tabs" however low it
   * reaches.
   */
  | { kind: 'move'; y: number; buttons: number; onTitleBar: boolean }
  /**
   * A `mouseout` with no `relatedTarget`: the pointer left the page. That is the
   * reveal when it happens in the band the reveal covers — unless it went into
   * the docked browser, whose `WebContentsView` is a second page, so leaving
   * for it looks exactly the same (`overNativeView`), or out through a side or
   * the bottom of the window to another display (`throughEdge`).
   */
  | { kind: 'leave'; y: number; buttons: number; overNativeView: boolean; throughEdge: boolean }

/**
 * A pointer event, a key pressed outside the title bar, or the linger timer
 * coming due. The last two carry the buttons held right now: either can land
 * in the middle of a drag.
 */
export type RevealInput = RevealPointer | { kind: 'key'; buttons: number } | { kind: 'tick'; buttons: number }

export interface RevealGeometry {
  /** `revealInsetFor`'s answer, as sent to the renderer. 0 when nothing covers the window. */
  inset: number
  /**
   * The title bar's bottom edge where it RESTS, in clientY — while shifted,
   * `inset` + its height. Not its live rect: that is mid-slide for a moment
   * after every shift, and would read the pointer as below a bar still coming.
   */
  barBottom: number
}

export interface RevealState {
  shifted: boolean
  /** When a shifted shell goes back up, if the pointer stays below the title bar until then. */
  releaseAt: number | null
  /**
   * The pointer was last seen going up onto the reveal, so the tabs are under
   * it right now: `edge` pressed against the top while already shifted (the
   * reveal on its way back), `leave` left the page inside the band. A `leave`
   * is only a guess — any window there reads the same — and the page seeing
   * the pointer back inside the band undoes it.
   */
  onReveal: 'edge' | 'leave' | null
  /** When that `leave` came: inside `REVEAL_SLIDE_MS` of it, the page seeing the pointer in the band is macOS's slide. */
  leftAt: number | null
  /** Unshifted, when the pointer last pressed against the top edge: within `REVEAL_EDGE_MEMORY_MS`, a corner trip. */
  edgeAt: number | null
}

export const REVEAL_IDLE: RevealState = { shifted: false, releaseAt: null, onReveal: null, leftAt: null, edgeAt: null }

/**
 * How long the shell stays down after the pointer leaves the tabs: long enough
 * that a pointer dipping below the bar on its way along it does not send them
 * away, and no longer than macOS keeps the menu bar out once the pointer has
 * left it. Measured on macOS 27 (2026-10-05, the pointer and the menu bar's
 * window sampled every 8ms): the reveal starts back up about 260ms after the
 * pointer drops out of it, and is gone about 140ms later. It was 3 seconds,
 * asked for when the first cut snapped back the moment the pointer came off
 * the reveal ("a bit too jumpy"); with the slide, the owner then found the
 * shell hanging down long after the menu bar had gone ("the top menu bar hides
 * so much quicker than stoke hides").
 */
export const REVEAL_LINGER_MS = 250

/**
 * How long macOS's reveal takes to slide in or out, with room to spare
 * (measured about 145ms each way, the same sampling). While it slides, its
 * moving bottom edge can pass a moving pointer, so the page sees the pointer
 * inside the band without the reveal being gone: a pointer heading down as
 * the reveal arrives outruns it, and one nudged up into the strip as it leaves
 * is left behind. Read as "some other window", either undid the shift and
 * bounced the tabs.
 */
export const REVEAL_SLIDE_MS = 250

/**
 * How long after pressing against the top edge a leave through a SIDE edge
 * still counts as the reveal. Pinned in a top corner, the pointer slides down
 * the side while macOS waits (14px in the measured trip), so the leave for the
 * reveal comes at clientX 0 or the last column, below clientY 0. Longer than
 * the measured ~270ms wait plus its ~145ms slide.
 */
export const REVEAL_EDGE_MEMORY_MS = 1000

/**
 * Keys that are only modifiers. Pressed on their own, they are the start of a
 * Cmd- or Ctrl-click on a tab, not typing, so they must not start the countdown
 * that would slide the tab away before the click lands.
 */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'OS', 'Super', 'Hyper', 'Fn', 'FnLock', 'CapsLock'])

/** Whether a keydown's `key` counts as typing for the reveal: anything but a bare modifier. */
export function revealKeyCounts(key: string): boolean {
  return !MODIFIER_KEYS.has(key)
}

/**
 * How soon after entering full screen the shell may start shifted, where
 * `revealsOnEntry` says macOS slid the reveal down with full screen itself.
 * Later than this, whatever turned `follow` on did not come with a reveal.
 */
export const REVEAL_ENTRY_GRACE_MS = 5000

/** `state` itself when `patch` changes nothing, so callers can compare by identity. */
function patched(state: RevealState, patch: Partial<RevealState>): RevealState {
  for (const k of Object.keys(patch) as (keyof RevealState)[]) {
    if (patch[k] !== state[k]) return { ...state, ...patch }
  }
  return state
}

/**
 * The shell's state after one input. Returns `state` itself when nothing
 * changed, so a caller can compare by identity.
 *
 * Down: the pointer left the page inside the band the reveal covers, so it is
 * on the reveal. Not when it is merely pressed against the top edge: macOS
 * waits before it reveals (about 270ms, measured), and a pointer that touches
 * the edge and comes away gets no reveal at all, so shifting there moved the
 * tabs for nothing. When the reveal does come, the pointer's next move is over
 * it and the page sees it leave. A leave through a side edge is another
 * display, except from a top corner: pinned there — the Apple menu's, Control
 * Center's — the pointer leaves for the reveal at clientX 0 or the last
 * column, at the top or a little down the side (`REVEAL_EDGE_MEMORY_MS`).
 * Undone if the page then sees the pointer inside that band more
 * than `REVEAL_SLIDE_MS` after the leave: the real reveal spans the whole width
 * of the band, so once it is out the pointer cannot be both on it and on the
 * page there — whatever was, it was some other window (a notification banner,
 * detached DevTools). Sooner than that, it may be the reveal's own edge
 * sliding past the pointer, so the guess is kept, not undone and not dropped.
 *
 * Back up: only after the pointer has been below the SHIFTED title bar for
 * `lingerMs` — never the moment it comes off the reveal, because macOS hides
 * the reveal exactly when the pointer drops out of it, which is how you reach
 * the tabs that were just moved under it; going up then would pull the tab
 * away from the click. Coming back onto the tabs, anything hanging off them,
 * or the reveal cancels the countdown. Leaving for the docked browser counts
 * as below: it is under the title bar, and so does leaving through a side or
 * the bottom of the window below the band. A key pressed outside the title bar
 * counts as below too, unless the pointer is up on the reveal: someone typing
 * with the pointer resting on the tabs has finished with them, and the shift
 * is hiding the status bar and the bottom rows of the terminal they are
 * typing into.
 *
 * A held button never moves the shell: that is a tab drag or a text selection,
 * and moving the shell under it would move what it is dragging. A countdown
 * that comes due under a held button waits, and the first buttonless event
 * below after that releases it.
 */
export function nextReveal(
  state: RevealState,
  input: RevealInput,
  geometry: RevealGeometry,
  now: number,
  lingerMs = REVEAL_LINGER_MS
): RevealState {
  if (geometry.inset <= 0) return patched(state, REVEAL_IDLE)
  if (input.buttons !== 0) return state
  const due = state.shifted && state.releaseAt !== null && now >= state.releaseAt
  // Below the bar, one way or another: count down, or go up if the count is out.
  const below = (): RevealState =>
    due ? REVEAL_IDLE : patched(state, { releaseAt: state.releaseAt ?? now + lingerMs, onReveal: null, leftAt: null })

  if (input.kind === 'tick') return due ? REVEAL_IDLE : state
  if (!state.shifted) {
    if (input.kind === 'move') return patched(state, { edgeAt: input.y < 1 ? now : state.edgeAt })
    const fromCorner = input.kind === 'leave' && (input.y < 1 || (state.edgeAt !== null && now - state.edgeAt < REVEAL_EDGE_MEMORY_MS))
    if (input.kind === 'leave' && input.y < geometry.inset && !input.overNativeView && (!input.throughEdge || fromCorner)) {
      return { shifted: true, releaseAt: null, onReveal: 'leave', leftAt: now, edgeAt: null }
    }
    return state
  }
  if (input.kind === 'key') return state.onReveal === null ? below() : state
  if (input.kind === 'leave') {
    if (input.overNativeView) return below()
    if (input.throughEdge) return input.y >= geometry.inset ? below() : state
    return input.y < geometry.inset ? patched(state, { releaseAt: null, onReveal: 'leave', leftAt: now }) : below()
  }
  if (input.y < 1) return patched(state, { releaseAt: null, onReveal: 'edge', leftAt: null })
  if (state.onReveal === 'leave' && input.y < geometry.inset) {
    const sliding = state.leftAt !== null && now - state.leftAt < REVEAL_SLIDE_MS
    return sliding ? patched(state, { releaseAt: null }) : REVEAL_IDLE
  }
  if (!input.onTitleBar && input.y >= geometry.barBottom) return below()
  return patched(state, { releaseAt: null, onReveal: null, leftAt: null })
}
