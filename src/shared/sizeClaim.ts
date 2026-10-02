/*
 * Who sizes a pty that two machines are showing: the one being USED, last
 * active wins (tmux's `window-size latest`).
 *
 * A hub remote tab (RemoteTerminal, the guest) and the session's own tab on
 * the machine it runs on (TerminalView, the host) each draw the same pty. Only
 * one grid can be the pty's, so whichever side was used last asks for its own:
 * the guest sends `{type:'resize', force:true}` through the relay, the host
 * fits its pane and resizes as it always did. The side not in use keeps
 * drawing the pty's grid as it is — empty space round it, or a scroll — and
 * takes it back only when someone uses it again.
 *
 * "Used" is a focus, a key, a click, or the pane changing size while its
 * terminal holds the keyboard in a focused window and someone has just acted
 * on that window (`claimCounts`). Never a tab merely being on show, never a
 * timer, never a strip appearing above a terminal nobody is at, and never the
 * other side's resize: otherwise two machines left open on one session would
 * fight over it for ever. Three guards keep it from becoming a ping-pong:
 *
 * - A claim waits `CLAIM_DEBOUNCE_MS`, so a burst of keys is one resize.
 * - A claim is held back while a resize from the OTHER side is settling
 *   (`CLAIM_SETTLE_MS`): a key pressed just as the other side took the grid is
 *   sent after it lands, not raced against it.
 * - The pty echoing this side's own claim back is not "the other side"
 *   (`foreignSize`), so a claim never arms the settle window against itself.
 *
 * The pane-size trigger must watch the pane's BORDER box: the side not in use
 * scrolls a grid larger than its pane, and the scrollbars appearing shrink the
 * content box, which would otherwise read as "the pane resized" and claim the
 * grid straight back (gotcha 151).
 *
 * Pure apart from the timers it is handed (gotcha 27); imports nothing.
 */

export interface Grid {
  cols: number
  rows: number
}

export type ClaimTrigger = 'focus' | 'key' | 'click' | 'pane'

/** A burst of triggers inside this is one claim. */
export const CLAIM_DEBOUNCE_MS = 150
/** How long after the other side resized the pty this side waits before claiming it back. */
export const CLAIM_SETTLE_MS = 800
/**
 * How recently someone must have acted on a window (a key, a press, the
 * wheel, or the window itself resized) for its pane changing size to count.
 */
export const PANE_INPUT_MS = 2000
/** The phone server's own bound on a requested dimension (server.ts `MAX_TERM_DIM`). */
export const MAX_GRID_DIM = 1000

export function isGrid(v: unknown): v is Grid {
  if (!v || typeof v !== 'object') return false
  const g = v as Record<string, unknown>
  const dim = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= MAX_GRID_DIM
  return dim(g.cols) && dim(g.rows)
}

export function sameGrid(a: Grid | null | undefined, b: Grid | null | undefined): boolean {
  return !!a && !!b && a.cols === b.cols && a.rows === b.rows
}

/** What a side knows about itself when something happens. */
export interface ClaimContext {
  /** The terminal is on show (its tab in front, the link open). */
  shown: boolean
  /** Its terminal holds the keyboard. */
  focused: boolean
  /** The window has the OS's focus. */
  windowFocused: boolean
  /** Someone acted on this window inside `PANE_INPUT_MS`: a key, a press, the wheel, or resizing it. */
  recentInput: boolean
}

/**
 * Whether an event means this side is being used. Nothing counts while the
 * terminal is not on show. A focus, a key or a click on it always does: each
 * is a person, here. A pane resize counts only while its terminal holds the
 * keyboard in a focused window that someone has just acted on — dragging the
 * window, toggling the sidebar — so a strip appearing above a terminal nobody
 * is at (a worklog proposal, another machine's question) is layout, not use,
 * and cannot take the grid from the machine that is.
 */
export function claimCounts(trigger: ClaimTrigger, f: ClaimContext): boolean {
  if (!f.shown) return false
  if (trigger === 'pane') return f.focused && f.windowFocused && f.recentInput
  return true
}

export type ClaimVerdict = { t: 'none' } | { t: 'wait'; ms: number } | { t: 'send'; grid: Grid }

/**
 * What a due claim does: nothing when this side's pane cannot be measured or
 * already matches the pty's grid; wait while the other side's resize settles;
 * else send the grid that fits this side's pane.
 */
export function claimVerdict(f: { want: Grid | null; have: Grid | null; now: number; foreignAt: number | null }): ClaimVerdict {
  if (!isGrid(f.want)) return { t: 'none' }
  if (sameGrid(f.want, f.have)) return { t: 'none' }
  if (f.foreignAt !== null) {
    const since = f.now - f.foreignAt
    if (since >= 0 && since < CLAIM_SETTLE_MS) return { t: 'wait', ms: CLAIM_SETTLE_MS - since }
  }
  return { t: 'send', grid: { cols: f.want.cols, rows: f.want.rows } }
}

/** A grid the pty reports is the other side's doing unless it is this side's own last claim coming back. */
export function foreignSize(got: Grid, mine: Grid | null): boolean {
  return !sameGrid(got, mine)
}

export interface SizeClaimerDeps {
  now(): number
  setTimer(fn: () => void, ms: number): unknown
  clearTimer(handle: unknown): void
  /** The grid this side's pane fits now, or null when it cannot be measured (hidden, detached). */
  want(): Grid | null
  /** The pty's grid as this side last heard it. */
  have(): Grid | null
  send(grid: Grid): void
}

/**
 * One side's claims. `trigger` on every event that might be use; `sized` on
 * every grid the pty reports. The claim itself runs on a timer, so `want` and
 * `have` are read when it is due, not when the first key of a burst landed.
 */
export class SizeClaimer {
  private readonly d: SizeClaimerDeps
  private timer: unknown
  private foreignAt: number | null
  private lastSent: Grid | null

  constructor(d: SizeClaimerDeps) {
    this.d = d
    this.timer = null
    this.foreignAt = null
    this.lastSent = null
  }

  /** Something happened on this side. True when it counted as use (a claim is now due). */
  trigger(kind: ClaimTrigger, f: ClaimContext): boolean {
    if (!claimCounts(kind, f)) return false
    if (this.timer === null) this.timer = this.d.setTimer(() => this.fire(), CLAIM_DEBOUNCE_MS)
    return true
  }

  /** The pty's grid moved. True when the other side moved it (and the settle window starts now). */
  sized(grid: Grid): boolean {
    if (!foreignSize(grid, this.lastSent)) return false
    this.foreignAt = this.d.now()
    this.lastSent = null
    return true
  }

  /** A claim is waiting to be sent. */
  get pending(): boolean {
    return this.timer !== null
  }

  dispose(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer)
    this.timer = null
  }

  private fire(): void {
    this.timer = null
    const v = claimVerdict({ want: this.d.want(), have: this.d.have(), now: this.d.now(), foreignAt: this.foreignAt })
    if (v.t === 'wait') {
      this.timer = this.d.setTimer(() => this.fire(), v.ms)
      return
    }
    if (v.t !== 'send') return
    this.lastSent = v.grid
    this.d.send(v.grid)
  }
}
