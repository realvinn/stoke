/**
 * The tab ring's geometry, and which of bypass mode's beads it draws.
 *
 * No imports, so ContextMeter.tsx and verify:statusline (under node's
 * strip-types) run the same code. Everything is in the ring's own viewBox units:
 * a 16-unit box drawn 14px wide at Interface scale 1, so one unit is 0.875 CSS
 * px there.
 */

/** Radius of the ring's track and arc. */
export const RING_R = 5.6

/**
 * Width of the track and the arc. MIRRORS `.ring circle { stroke-width }` in
 * app.css, which is what actually paints it; change both or neither.
 */
export const RING_STROKE = 2.5

/** How many beads bypass mode draws round a ring with no arc on it. */
export const RING_BEADS = 8

/**
 * The smallest gap left between a bead and the arc's round end, in viewBox
 * units: a hair under a CSS pixel at Interface scale 1, two device pixels on a
 * Retina screen. Enough to read as a gap rather than as a bead fused to the cap.
 */
export const BEAD_CLEARANCE = 1

const CIRC = 2 * Math.PI * RING_R
const PITCH = CIRC / RING_BEADS
const BEAD_R = RING_STROKE / 2

/** Straight-line distance between two points on the ring `d` apart along it. */
function chord(d: number): number {
  return 2 * RING_R * Math.sin(d / (2 * RING_R))
}

/**
 * Which of the `RING_BEADS` beads to draw for a ring whose arc covers `ratio`
 * of it (0 when no arc is drawn: not ready, paused). Bead `k` sits at `k/8` of
 * the way round from where the arc starts.
 *
 * A bead the arc would touch is left out WHOLE. The beads used to be one dashed
 * track under the arc (`stroke-dasharray: 0 <pitch>`), which cannot skip a dash,
 * so wherever the arc stopped short of a bead the bead stuck out past the arc's
 * round cap as a grey nub -- measured in the running app at 20%, 30% and 70%
 * (1.76 units, 1.5 CSS px, of bead beyond the cap at 20%), and at 81% as a grey
 * blob stuck to the edge of the solid red disc. And every bead under the arc bled
 * through its antialiased edges as grey specks along the arc on a 2x screen.
 *
 * Kept, then, only if the bead clears the arc's end cap AND its start cap by
 * `BEAD_CLEARANCE`. The start cap sits exactly on bead 0 and one pitch from bead
 * 7, which clears it, so the bead just before 12 o'clock stays until the arc
 * passes 77.4%; beyond that no bead is clear of both caps and none is drawn,
 * the unfilled notch standing empty where a plain ring shows its grey track.
 * Out-of-range input is clamped, and NaN counts as no arc: every bead.
 */
export function ringBeads(ratio: number): number[] {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0
  const arc = r * CIRC
  const reach = 2 * BEAD_R + BEAD_CLEARANCE
  const out: number[] = []
  for (let k = 0; k < RING_BEADS; k++) {
    const s = k * PITCH
    if (r > 0 && (s <= arc || chord(s - arc) < reach || chord(CIRC - s) < reach)) continue
    out.push(k)
  }
  return out
}

/** Centre of bead `k`, before `.ring`'s -90deg turn puts bead 0 at 12 o'clock. */
export function beadCentre(k: number): { cx: number; cy: number } {
  const a = (2 * Math.PI * k) / RING_BEADS
  return { cx: 8 + RING_R * Math.cos(a), cy: 8 + RING_R * Math.sin(a) }
}
