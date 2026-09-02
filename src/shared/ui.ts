/** Interface scale bounds. Below 0.8 the title bar clips; above 1.6 the
 *  940px minimum window can no longer hold the launcher. */
export const UI_SCALE_MIN = 0.8
export const UI_SCALE_MAX = 1.6
export const FONT_SIZE_MIN = 9
export const FONT_SIZE_MAX = 24

/** Clamp anything to a usable interface scale. NaN and junk become 1. */
export function clampUiScale(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 1
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, n))
}

/** Same, for the terminal font size. */
export function clampFontSize(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 13
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(n)))
}

/* ------------------------------------------------------------ remote port */

export const REMOTE_PORT_DEFAULT = 7878

/**
 * A usable listening port, or the default. Below 1024 needs root and above
 * 65535 does not exist; a fraction, NaN or an empty box all land on the
 * default rather than on whatever `Number('')` happens to be. Applied at
 * hydrate and on commit, never on every keystroke — clamping mid-edit is how
 * typing "8080" used to persist 8, 80 and 808 on the way.
 */
export function clampPort(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return REMOTE_PORT_DEFAULT
  return n
}

/* ------------------------------------------------------------------- zoom */

export const UI_SCALE_DEFAULT = 1
export const FONT_SIZE_DEFAULT = 13
export const UI_SCALE_STEP = 0.1
export const FONT_SIZE_STEP = 1

/**
 * What the zoom keys move.
 *
 * A setting rather than a decision, because Stoke has two independent size
 * settings and which one "zoom" means depends on what someone came from. A
 * terminal (Terminal.app, iTerm2) scales only its font, because the chrome
 * around it belongs to the OS. An editor (VS Code) scales everything, because
 * the chrome is its own. Stoke is the second kind of app with the first kind of
 * content, so both answers are defensible and neither is a default worth
 * arguing for on someone else's behalf.
 */
export type ZoomTarget = 'both' | 'terminal' | 'interface'

export const ZOOM_TARGETS: readonly ZoomTarget[] = ['both', 'terminal', 'interface']

/** Anything unrecognised becomes the default rather than disabling zoom. */
export function clampZoomTarget(value: unknown): ZoomTarget {
  return ZOOM_TARGETS.includes(value as ZoomTarget) ? (value as ZoomTarget) : 'both'
}

/** The pair of size settings zoom operates on. */
export interface ZoomState {
  uiScale: number
  fontSize: number
}

/**
 * One zoom step: `1` in, `-1` out, `0` back to the defaults.
 *
 * Returns the whole pair rather than a delta, so a caller patches settings once
 * and cannot apply half a step. Each half is clamped independently by its own
 * existing bound, which means the two genuinely do come apart at the extremes —
 * interface scale tops out at 1.6 while the font still has room to 24. That is
 * honest rather than tidy: pinning them together would mean the tighter bound
 * silently caps the looser one, and someone who wants 24px text on a 1.6 scale
 * would have no way to say so.
 *
 * Scale is snapped to the 0.1 grid. Floats do not add cleanly — ten additions
 * of 0.1 reach 0.9999999999999999 — and a slider bound to that value would show
 * a figure nobody chose. The cost is that zooming from a hand-typed 1.25 lands
 * on 1.4 rather than 1.35, which is the grid doing what a grid is for.
 */
export function zoomStep(current: ZoomState, direction: -1 | 0 | 1, target: ZoomTarget): ZoomState {
  const movesScale = target === 'both' || target === 'interface'
  const movesFont = target === 'both' || target === 'terminal'

  if (direction === 0) {
    return {
      uiScale: movesScale ? UI_SCALE_DEFAULT : clampUiScale(current.uiScale),
      fontSize: movesFont ? FONT_SIZE_DEFAULT : clampFontSize(current.fontSize)
    }
  }

  const scaled = clampUiScale(current.uiScale) + direction * UI_SCALE_STEP
  return {
    uiScale: movesScale ? clampUiScale(Math.round(scaled * 10) / 10) : clampUiScale(current.uiScale),
    fontSize: movesFont
      ? clampFontSize(clampFontSize(current.fontSize) + direction * FONT_SIZE_STEP)
      : clampFontSize(current.fontSize)
  }
}
