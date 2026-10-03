/*
 * What floats over a terminal pane, by corner, and how far the find bar keeps
 * off each (TerminalView, app.css `.term-find`).
 *
 * Every float sits over the canvas rather than in the layout, so showing one
 * never resizes the pty (a resize mid-session repaints whatever Claude Code is
 * drawing). Two corners hold more than one:
 *
 *  - The FOOT (bottom-right): the image strip (SSH uploads) and the exit card.
 *    The find bar grows down from the top with its hits and stops above the
 *    tallest of them (`--find-floor`); the toasts in `.main-col` sit above them
 *    too (`setToastFloor`, gotcha 154).
 *  - The TOP-RIGHT: the dictation strip, there since 2026-10-04 (it was
 *    bottom-left, a foot float). It keeps its corner — it is the thing saying a
 *    microphone is open — and the find bar starts below it (`--find-ceiling`).
 *
 * Pure strings and arithmetic, so verify:find holds the corners and the gap
 * without a DOM (gotcha 27: nothing here may import one).
 */

/** The foot's floats: the find bar stops above them, the toasts sit above them. */
export const FOOT_FLOATS = ':scope > .image-strip, :scope > .term-exit'

/** The top-right corner's floats above the find bar, which starts below them. */
export const CORNER_FLOATS = ':scope > .voice-strip'

/**
 * How far the find bar keeps off a corner whose floats are these heights: the
 * tallest plus one gap, as a CSS length; null when nothing is there, so the
 * property is removed rather than set to a zero that hides a bug.
 */
export function floatInset(heights: readonly number[]): string | null {
  const h = Math.max(0, ...heights.filter((x) => Number.isFinite(x)))
  return h > 0 ? `calc(${Math.ceil(h)}px + var(--space-8))` : null
}
