import { NO_BURST, isActivationKey, nextBurst, pressAllowed, type PressBurst } from '@shared/launcher'

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

window.addEventListener(
  'keydown',
  (e) => {
    if (isActivationKey(e.key)) burst = nextBurst(burst, performance.now(), e.repeat)
  },
  true
)

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
