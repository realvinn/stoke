export interface RevealFrame { x: number; y: number; width: number; height: number; onscreen: boolean }
export interface RevealBounds { x: number; y: number; width: number; height: number }

/**
 * The lowest native edge, in the shell's coordinate space. The sampler sends
 * BOTH the system menu bar and Stoke's own AppKit title strip. The menu bar
 * alone ends at 30pt while the strip below it can end at 62pt (or more with a
 * toolbar); adding a guessed strip to the menu would drift during animation.
 * Core Graphics and Electron window bounds are points, including on Retina.
 */
export function nativeRevealOffset(raw: unknown, window: RevealBounds, inset: number): number | null {
  if (!Array.isArray(raw) || raw.length > 128 || !Number.isFinite(inset) || inset <= 0) return null
  let offset = 0
  for (const frame of raw as RevealFrame[]) {
    if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || typeof frame.onscreen !== 'boolean') return null
    if (!frame.onscreen || frame.height < 16 || frame.height > 160 || Math.abs(frame.x - window.x) > 3 || Math.abs(frame.width - window.width) > 4) continue
    const bottom = frame.y + frame.height - window.y
    if (frame.y > window.y + inset || bottom <= 0 || bottom > 160) continue
    // A fractional native edge must clear the next CSS pixel too.
    offset = Math.max(offset, Math.ceil(bottom))
  }
  return offset
}
