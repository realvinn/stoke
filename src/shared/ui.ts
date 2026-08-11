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
