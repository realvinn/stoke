import { PANE_INPUT_MS } from '@shared/sizeClaim'

/*
 * When someone last acted on THIS window: a key, a press, the wheel, or the
 * window itself being resized. Read by the size claim (shared/sizeClaim.ts):
 * a terminal pane that changes size counts as "being used" only shortly after
 * one of these, so a strip appearing above a terminal nobody is at never takes
 * a remote session's grid from the machine that is using it.
 *
 * Registered once, in the capture phase, when the module is first imported
 * (before any terminal mounts); trusted events only, so nothing a page script
 * dispatches counts as a person.
 */
let lastAt = -Infinity

const mark = (e: Event): void => {
  if (e.isTrusted) lastAt = performance.now()
}
for (const type of ['keydown', 'pointerdown', 'wheel'] as const) {
  window.addEventListener(type, mark, { capture: true, passive: true })
}
window.addEventListener('resize', mark, { passive: true })

/** Someone acted on this window within `PANE_INPUT_MS`. */
export function recentlyUsed(): boolean {
  return performance.now() - lastAt < PANE_INPUT_MS
}
