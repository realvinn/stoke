export interface RevealFrame { x: number; y: number; width: number; height: number; onscreen: boolean }
export interface RevealBounds { x: number; y: number; width: number; height: number }

/** The bottom of macOS's actual full-width reveal, in the shell's coordinate space. */
export function nativeRevealOffset(raw: unknown, window: RevealBounds, inset: number): number | null {
  if (!Array.isArray(raw) || raw.length > 128 || !Number.isFinite(inset) || inset <= 0) return null
  let offset = 0
  for (const frame of raw as RevealFrame[]) {
    if (!frame || ![frame.x, frame.y, frame.width, frame.height].every(Number.isFinite) || typeof frame.onscreen !== 'boolean') return null
    if (!frame.onscreen || frame.height < 16 || frame.height > 160 || Math.abs(frame.x - window.x) > 3 || Math.abs(frame.width - window.width) > 4) continue
    const bottom = frame.y + frame.height - window.y
    if (frame.y > window.y + inset || bottom <= 0 || bottom > 160) continue
    offset = Math.max(offset, Math.round(bottom))
  }
  return offset
}
