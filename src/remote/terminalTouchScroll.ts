/** Vertical swipes over the terminal.
 * - An application that owns terminal mouse scrolling (Claude Code's full
 *   screen) gets them as wheel reports (`enabled`, `wheel`).
 * - Otherwise they scroll xterm's own scrollback (`scrollback`). xterm 6 draws
 *   its scrollback in a scrollable element that answers the wheel only, with no
 *   native scroller under it, so a finger never moved it: measured at 390x844
 *   in Chromium, a 600px swipe over 400 lines of history left the top row where
 *   it was. Older lines come after the box's own overflow has scrolled to its
 *   top; newer lines come before it scrolls down, so the box and the buffer read
 *   as one column.
 * Native browser scrolling remains responsible for the box's own overflow (a
 * desktop grid taller or wider than the phone), horizontal panning, selection
 * and multi-touch gestures. */
export function mountTerminalTouchScroll(root: HTMLElement, options: {
  enabled: () => boolean
  lineHeight: () => number
  wheel: (x: number, y: number, delta: number) => void
  /** xterm's own scrollback. `room(-1)`: older lines above the view; `room(1)`: newer below it. */
  scrollback?: { room: (direction: -1 | 1) => boolean; scroll: (lines: number) => void }
  signal: AbortSignal
}): void {
  type Gesture = { id: number; x: number; y: number; lastY: number; remainder: number; mode: 'wheel' | 'lines' | null }
  let gesture: Gesture | null = null
  /** Who takes a vertical swipe, decided once per gesture at its first clear move. */
  const owner = (older: boolean): Gesture['mode'] => {
    if (options.enabled()) return 'wheel'
    const lines = options.scrollback
    if (!lines) return null
    // Finger down (older): the box's own overflow first, then the buffer.
    if (older) return root.scrollTop <= 0 && lines.room(-1) ? 'lines' : null
    // Finger up (newer): the buffer back to its bottom first, then the box.
    return lines.room(1) ? 'lines' : null
  }
  root.addEventListener('touchstart', (event) => {
    const touch = event.touches[0]
    gesture = event.touches.length === 1 && (options.enabled() || options.scrollback)
      ? { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, remainder: 0, mode: null }
      : null
  }, { capture: true, passive: true, signal: options.signal })
  root.addEventListener('touchmove', (event) => {
    const g = gesture
    if (!g || event.touches.length !== 1) { gesture = null; return }
    const touch = Array.from(event.touches).find((t) => t.identifier === g.id)
    if (!touch) { gesture = null; return }
    if (!g.mode) {
      const dx = Math.abs(touch.clientX - g.x), dy = Math.abs(touch.clientY - g.y)
      if (Math.max(dx, dy) < 8) return
      if (dx >= dy) { gesture = null; return }
      g.mode = owner(touch.clientY > g.y)
      if (!g.mode) { gesture = null; return }
    }
    // The application took or gave up mouse reporting mid-swipe: let go.
    if ((g.mode === 'wheel') !== options.enabled()) { gesture = null; return }
    event.preventDefault()
    event.stopPropagation()
    g.remainder += g.lastY - touch.clientY
    g.lastY = touch.clientY
    const line = Math.max(8, options.lineHeight())
    const steps = Math.trunc(g.remainder / line)
    g.remainder %= line
    if (g.mode === 'lines') { if (steps) options.scrollback!.scroll(steps); return }
    // One xterm wheel event is one application report. Bound each move so a
    // paused browser cannot flood the agent when touch events resume.
    for (let i = 0; i < Math.min(6, Math.abs(steps)); i++) options.wheel(g.x, g.y, Math.sign(steps) * line)
  }, { capture: true, passive: false, signal: options.signal })
  const clear = (): void => { gesture = null }
  root.addEventListener('touchend', clear, { passive: true, signal: options.signal })
  root.addEventListener('touchcancel', clear, { passive: true, signal: options.signal })
}
