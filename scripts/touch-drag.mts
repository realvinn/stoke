/**
 * A finger drag through Chromium's own input pipeline, for the suites that
 * prove touch scrolling: trusted touchstart, touchmove and touchend from CDP
 * `Input.dispatchTouchEvent`, as a touch screen sends them.
 *
 * Never `Input.synthesizeScrollGesture` with `gestureSourceType: 'touch'`
 * (CLAUDE.md gotcha 180). On Linux (Electron 43.2, X11 under xvfb, CI's
 * ubuntu runner) it delivers the touchstart and then no touchmove at all, so
 * nothing scrolls. Measured on a plain overflow box, the control: one
 * touchstart, zero touchmoves, scrollTop 0, with or without phone emulation
 * and with or without --touch-events=enabled. The same drag sent as
 * dispatched touches scrolled it about 450 px there, and macOS scrolls either
 * way. verify:account-remote's list check failed on every Linux run for that
 * reason alone.
 *
 * `dy` is the finger's travel, in CSS px: negative moves it up (the content
 * scrolls down), as `synthesizeScrollGesture`'s `yDistance` read. Keep the
 * whole drag inside the viewport: a touch outside it is not the drag a person
 * makes.
 */
export async function touchDrag(
  send: (method: string, params?: Record<string, unknown>) => Promise<unknown>,
  x: number,
  y: number,
  dy: number,
  opts: { steps?: number; frameMs?: number } = {}
): Promise<void> {
  const steps = Math.max(1, opts.steps ?? Math.ceil(Math.abs(dy) / 20))
  const frameMs = opts.frameMs ?? 16
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + (dy * i) / steps }] })
    await new Promise((done) => setTimeout(done, frameMs))
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}
