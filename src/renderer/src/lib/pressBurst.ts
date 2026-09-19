import {
  NO_BURST,
  isActivationKey,
  isDeliberateInput,
  launcherHoldsFocus,
  launcherPressAllowed,
  nextBurst,
  pressAllowed,
  type PressBurst
} from '@shared/launcher'

/*
 * One record of the activation-key burst in progress, for the whole window
 * (see `pressAllowed` in shared/launcher.ts, and gotcha 88).
 *
 * The listener is registered when this module is first evaluated — imported
 * from main.tsx, before React renders anything — so it is the FIRST capture
 * listener on `window`: listeners on one target run in registration order, so
 * every component's own capture handler (the splash, the agent picker) sees
 * the burst already folded with the press it is handling, and a splash that
 * swallows the key with `stopPropagation` cannot hide it from this record.
 */
let burst: PressBurst = NO_BURST

/** When the latest deliberate input landed (`isDeliberateInput`, gotcha 93). */
let deliberateAt = -Infinity
const listeners = new Set<() => void>()

window.addEventListener(
  'keydown',
  (e) => {
    if (isActivationKey(e.key)) burst = nextBurst(burst, performance.now(), e.repeat)
    else if (e.isTrusted && isDeliberateInput(e)) markDeliberate()
  },
  true
)
window.addEventListener(
  'pointerdown',
  (e) => {
    if (e.isTrusted && isDeliberateInput(e)) markDeliberate()
  },
  true
)

function markDeliberate(): void {
  const first = deliberateAt === -Infinity
  deliberateAt = performance.now()
  if (first || listeners.size) for (const fn of listeners) fn()
}

/** Called on every deliberate input; returns the unsubscribe. */
export function onDeliberate(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/** The clock `armedAt` must be read from. */
export function pressClock(): number {
  return performance.now()
}

/**
 * Whether the activation key being handled right now may act on a surface
 * armed at `armedAt`. Call only from inside a keydown handler for Enter/Space.
 */
export function activationAllowed(armedAt: number): boolean {
  return pressAllowed(burst, armedAt)
}

/**
 * The launcher's stricter check: the burst rule plus a deliberate input since
 * it armed (`launcherPressAllowed`, gotcha 93). Call only from inside a
 * keydown handler for Enter/Space.
 */
export function launcherActivationAllowed(armedAt: number | null): boolean {
  return launcherPressAllowed(burst, armedAt, deliberateAt)
}

/** Whether the launcher holds focus off Start right now (`launcherHoldsFocus`). */
export function launcherHoldingFocus(armedAt: number | null): boolean {
  return launcherHoldsFocus(armedAt, deliberateAt)
}
