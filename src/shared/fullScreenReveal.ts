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
 * is inferred from where the pointer went, and the shell moves down under it.
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
   * it right now: `edge` pressed against the top, `leave` left the page inside
   * the band. A `leave` is only a guess — any window there reads the same —
   * and the page seeing the pointer back inside the band undoes it.
   */
  onReveal: 'edge' | 'leave' | null
}

export const REVEAL_IDLE: RevealState = { shifted: false, releaseAt: null, onReveal: null }

/**
 * How long the shell stays down after the pointer leaves the tabs. Asked for:
 * snapping straight back read as jumpy, and a pointer that dips below the bar
 * on its way along it should not send the tabs away.
 */
export const REVEAL_LINGER_MS = 3000

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
 * Down: the pointer pressed against the top edge (macOS is about to reveal),
 * or left the page inside the band the reveal covers (it is on the reveal).
 * Undone at once if the page then sees the pointer inside that band: the real
 * reveal spans the whole width of the band, so the pointer cannot be both on
 * it and on the page there — whatever was, it was some other window (a
 * notification banner, detached DevTools).
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
    due ? REVEAL_IDLE : patched(state, { releaseAt: state.releaseAt ?? now + lingerMs, onReveal: null })

  if (input.kind === 'tick') return due ? REVEAL_IDLE : state
  if (!state.shifted) {
    if (input.kind === 'move' && input.y < 1) return { shifted: true, releaseAt: null, onReveal: 'edge' }
    if (input.kind === 'leave' && input.y < geometry.inset && !input.overNativeView && !input.throughEdge) {
      return { shifted: true, releaseAt: null, onReveal: 'leave' }
    }
    return state
  }
  if (input.kind === 'key') return state.onReveal === null ? below() : state
  if (input.kind === 'leave') {
    if (input.overNativeView) return below()
    if (input.throughEdge) return input.y >= geometry.inset ? below() : state
    return input.y < geometry.inset ? patched(state, { releaseAt: null, onReveal: 'leave' }) : below()
  }
  if (input.y < 1) return patched(state, { releaseAt: null, onReveal: 'edge' })
  if (state.onReveal === 'leave' && input.y < geometry.inset) return REVEAL_IDLE
  if (!input.onTitleBar && input.y >= geometry.barBottom) return below()
  return patched(state, { releaseAt: null, onReveal: null })
}
