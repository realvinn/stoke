/**
 * The recording-volume line: how loud the microphone is, as 0..1.
 *
 * Pure, so `verify:voice` runs it under node strip-types (gotcha 78). The
 * browser half — the AnalyserNode and the animation frame that feed it — is in
 * `voice.ts`, which the node project excludes (gotcha 27).
 *
 * The scale is dBFS, not raw amplitude, because that is how loudness is heard:
 * speech at a normal distance sits around -30 to -15 dBFS, and on a linear scale
 * it would barely lift the line off zero while a cough pinned it. -60 dBFS is
 * the floor (a quiet room through noise suppression) and 0 the ceiling, so a
 * full-scale sine reads about 0.95 and a -30 dBFS signal exactly half.
 */

export const LEVEL_FLOOR_DB = -60

/** RMS of a block of samples in dBFS, mapped from -60..0 to 0..1. Silence is 0. */
export function levelFromSamples(samples: ArrayLike<number>): number {
  const n = samples.length
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const s = samples[i]
    sum += s * s
  }
  const rms = Math.sqrt(sum / n)
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  return Math.min(1, Math.max(0, (db - LEVEL_FLOOR_DB) / -LEVEL_FLOOR_DB))
}

/**
 * Time constants for the line's movement: it jumps up with a syllable and
 * falls back over about a quarter of a second, the way a VU meter reads, so it
 * shows speech rather than flickering with every sample block.
 */
export const LEVEL_ATTACK_MS = 30
export const LEVEL_RELEASE_MS = 250

/**
 * One step of attack/release smoothing, from the previous displayed level to a
 * new reading `dtMs` later. Frame-rate independent: a 120 Hz display and a 60 Hz
 * one settle at the same speed.
 */
export function smoothLevel(prev: number, next: number, dtMs: number): number {
  const tau = next > prev ? LEVEL_ATTACK_MS : LEVEL_RELEASE_MS
  const k = 1 - Math.exp(-Math.max(0, dtMs) / tau)
  return prev + (next - prev) * k
}

/**
 * How long the line may lie flat before the strip says so, and what counts as
 * flat: under 0.02 is below about -59 dBFS, where a live microphone in a quiet
 * room still reads above it and a virtual cable's digital silence reads 0.
 */
export const NO_SIGNAL_MS = 2000
export const NO_SIGNAL_FLOOR = 0.02

/**
 * Watches the level for a microphone that hears nothing — a virtual cable, a
 * muted input, the wrong device — which otherwise shows up only as an empty
 * transcript after the fact. Feed it every reading; it answers whether the line
 * has been flat for `NO_SIGNAL_MS` straight. Any reading above the floor resets
 * it, so the notice goes the moment sound arrives.
 */
export function createSignalWatch(flatMs = NO_SIGNAL_MS, floor = NO_SIGNAL_FLOOR): (level: number, now: number) => boolean {
  let flatSince: number | null = null
  return (level, now) => {
    if (level > floor) {
      flatSince = null
      return false
    }
    if (flatSince === null) flatSince = now
    return now - flatSince >= flatMs
  }
}
