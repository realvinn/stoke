/** Forward vertical swipes to applications that own terminal mouse scrolling.
 * Native browser/xterm scrolling remains responsible for ordinary scrollback,
 * horizontal panning, selection and multi-touch gestures. */
export function mountTerminalTouchScroll(root: HTMLElement, options: {
  enabled: () => boolean
  lineHeight: () => number
  wheel: (x: number, y: number, delta: number) => void
  signal: AbortSignal
}): void {
  let gesture: { id: number; x: number; y: number; lastY: number; remainder: number; vertical: boolean } | null = null
  root.addEventListener('touchstart', (event) => {
    const touch = event.touches[0]
    gesture = event.touches.length === 1 && options.enabled()
      ? { id: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, remainder: 0, vertical: false }
      : null
  }, { capture: true, passive: true, signal: options.signal })
  root.addEventListener('touchmove', (event) => {
    const g = gesture
    if (!g || !options.enabled() || event.touches.length !== 1) { gesture = null; return }
    const touch = Array.from(event.touches).find((t) => t.identifier === g.id)
    if (!touch) { gesture = null; return }
    const dx = Math.abs(touch.clientX - g.x), dy = Math.abs(touch.clientY - g.y)
    if (!g.vertical) {
      if (Math.max(dx, dy) < 8) return
      if (dx >= dy) { gesture = null; return }
      g.vertical = true
    }
    event.preventDefault()
    event.stopPropagation()
    g.remainder += g.lastY - touch.clientY
    g.lastY = touch.clientY
    const line = Math.max(8, options.lineHeight())
    // One xterm wheel event is one application report. Bound each move so a
    // paused browser cannot flood the agent when touch events resume.
    const steps = Math.trunc(g.remainder / line)
    g.remainder %= line
    for (let i = 0; i < Math.min(6, Math.abs(steps)); i++) options.wheel(g.x, g.y, Math.sign(steps) * line)
  }, { capture: true, passive: false, signal: options.signal })
  const clear = (): void => { gesture = null }
  root.addEventListener('touchend', clear, { passive: true, signal: options.signal })
  root.addEventListener('touchcancel', clear, { passive: true, signal: options.signal })
}
