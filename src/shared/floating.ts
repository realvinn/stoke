/*
 * Whether a floating layer — a popover, a menu, a picker — lies over the docked
 * browser, which is the only case where the browser has to be hidden for it.
 *
 * The browser is a native WebContentsView that Electron composites above the
 * whole renderer (gotcha 14), so no z-index can put DOM over it. The one answer
 * is to hide the view while something floats where it is. Hiding it for every
 * menu would blank the browser for a right-click in the terminal on the far
 * side of the window, so the test is geometry, not "is anything open".
 *
 * Pure and DOM-free so `verify:layers` can run it; the renderer's store
 * (`lib/floatingLayers.ts`) feeds it `getBoundingClientRect()` values.
 */

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

/** A box with no area covers nothing and is covered by nothing. */
function hasArea(r: Rect): boolean {
  return r.right > r.left && r.bottom > r.top
}

/**
 * True when any layer overlaps the browser's rect. Edges that merely touch do
 * not overlap: a menu whose right edge sits exactly on the browser's left edge
 * paints nothing under it.
 *
 * A `null` hole — the browser's placeholder is not in the page — errs towards
 * hiding. The caller only asks while the browser is meant to be showing, so no
 * placeholder there is a layout this code has not seen, and a layer drawn
 * behind the browser is the failure being prevented.
 */
export function coversBrowser(layers: readonly Rect[], hole: Rect | null): boolean {
  const live = layers.filter(hasArea)
  if (live.length === 0) return false
  if (!hole) return true
  if (!hasArea(hole)) return false
  return live.some((r) => r.right > hole.left && r.left < hole.right && r.bottom > hole.top && r.top < hole.bottom)
}
