import { contextLevel, contextPercent } from '@shared/contextLevel'
import { compactTokens } from '../lib/format'

/*
 * Which colour a reading is: `contextLevel(contextPercent(used, limit))`, from
 * src/shared/contextLevel.ts, the one copy of the rule the phone runs too.
 * 0-30% low (green), 31-60% mid (orange), 61-80% high (red), 81%+ full (solid
 * red). Banded on the SAME rounded percent the caption and the tooltip print, so
 * the colour changes exactly when the number does. The colours themselves are
 * --meter-low/-mid/-high, solved per theme by shared/meter.ts.
 *
 * The fill's LENGTH still comes from the unrounded ratio: the bar and the arc
 * are geometry, and 30.4% is drawn as 30.4%.
 */
function ratioOf(used: number, limit: number): number {
  return limit > 0 && used > 0 ? Math.min(1, used / limit) : 0
}

interface MeterProps {
  used: number
  limit: number
  /** Render the "84.2k / 200k" caption beside the bar. */
  showLabel?: boolean
  /**
   * Restored from the last run: draw the reading, but it must not be able to
   * paint an alarm tier. Mirrors `ContextRing`'s `paused` prop and the same
   * reasoning — a session that is not running cannot be in a live alarm
   * state, however high the number it was saved with. `--text-muted` is the
   * same "no live data" colour `.ring-plus`/`.ring-pause` already use.
   *
   * Only the status bar's reading of a paused tab sets this. The sidebar and
   * launcher rows are past sessions too, and deliberately draw the same tiers
   * as a live one: there the number is the point — it is how full that
   * conversation would be if you resumed it now.
   */
  paused?: boolean
}

export function ContextBar({
  used,
  limit,
  showLabel = true,
  paused = false
}: MeterProps): React.JSX.Element {
  const ratio = ratioOf(used, limit)
  const pct = contextPercent(used, limit)
  const dataLevel = paused ? 'paused' : contextLevel(pct)
  return (
    <div className="meter-inline">
      <div
        className="meter"
        data-level={dataLevel}
        style={{ ['--meter-scale' as string]: String(ratio) }}
        role="meter"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-label={paused ? 'Context window used when last active' : 'Context window used'}
      >
        <div className="meter-fill" />
      </div>
      {/* `.meter-caption` directly after `.meter`: app.css turns it --danger at 'full'. */}
      {showLabel && (
        <span className="meter-caption mono">
          {compactTokens(used)}/{compactTokens(limit)} · {pct}%
        </span>
      )}
    </div>
  )
}

/** Radius of the tab ring, shared so anything drawn in the same slot lines up. */
export const RING_R = 5.6
const CIRC = 2 * Math.PI * RING_R

/*
 * The worklog dot, in the ring's own viewBox units rather than CSS pixels.
 *
 * It lives inside this <svg> for one reason: concentricity. It used to be a
 * sibling <span> laid over the ring in the same grid cell, which centres
 * correctly and *paints* half a pixel out. The slot is 14px and the dot was
 * 5px, so `place-items: center` offsets it by (14 - 5) / 2 = 4.5px — and
 * Chromium pixel-snaps a painted background box while leaving SVG geometry
 * exactly where the maths put it. The two therefore disagreed by 0.5px
 * diagonally, and the direction flipped with the tab strip's own sub-pixel
 * position, which is why it read as "the dot is off centre" rather than as
 * anything reproducible. Measured at scales 1, 2, 8 and 16: the span is out by
 * 0.707px at every offset, a <circle> at cx/cy 8 is exact at every offset.
 *
 * 2.86 keeps the drawn size: 2.86 * 2 * (14 / 16) = 5.005px, the 5px it always
 * was. Being in viewBox units it now also scales with Interface scale, which
 * a rem-sized box only did at whole-pixel scales.
 */
const WATCH_R = 2.86

/*
 * The solid disc a full (81%+) ring gets. "Just solid red" was the ask, and a
 * redder arc is not solid: shape carries it, the same way the arc's length
 * carries how full.
 *
 * Inside this <svg> for gotcha 33's reason, like the watch dot. Its radius
 * follows from the stroke: `.ring circle` draws the track and the arc 2.5 wide
 * (app.css), so their inner edge is at RING_R - 1.25. The core reaches 0.25 past
 * that, under the arc, so antialiasing leaves no hairline of page between the
 * disc and the arc — and it is drawn BEFORE the track, so wherever the arc has
 * not reached yet the track paints over that overlap and the unfilled part of
 * the ring still reads as a gap. The bypass beads sit on it whole for the same
 * reason. A circle about the centre is unaffected by `.ring`'s -90deg turn.
 */
const CORE_R = RING_R - 1

/*
 * The bypass mark's beads: zero-length dashes with round caps, `BEADS` of them
 * evenly round the track. The pitch is computed here from the same radius the
 * track is drawn at and handed to app.css as `--ring-bead-pitch`, so the pattern
 * always closes cleanly at 12 o'clock — a dash length typed into the stylesheet
 * would stop closing the moment RING_R changed. 8 beads of 2.5 units on a
 * 35.19-unit circumference leaves a 1.9-unit gap between them: 2.19px beads and
 * 1.66px gaps at Interface scale 1, dotted rather than the 11 square teeth the
 * 1.6/1.6 dash drew.
 */
const BEADS = 8
const BEAD_PITCH = CIRC / BEADS

/**
 * Compact ring for tab strips, where there is no room for a bar and caption.
 *
 * `ready` false draws the track and nothing else. That case exists because the
 * strip used to render a 7px dot until the watcher reported and then swap in a
 * 14px ring, which shoved the label and the close button 7px sideways with no
 * transition. An empty circle says the same thing — no reading yet — without
 * moving anything.
 */
export function ContextRing({
  used,
  limit,
  ready = true,
  watched = false,
  paused = false
}: {
  used: number
  limit: number
  ready?: boolean
  /** Draw the worklog dot in the middle. See WATCH_R for why it lives here. */
  watched?: boolean
  /** Restored from the last run: draw the reading, but say it is not live. */
  paused?: boolean
}): React.JSX.Element {
  const ratio = ready ? ratioOf(used, limit) : 0
  const pct = ready ? contextPercent(used, limit) : 0
  /*
   * `paused` gets its own data-level rather than falling through to the
   * reading's tier. That reading is from the last run, not a live one — if it
   * happened to be 61% or more, `.ring[data-level='high']` / `['full']` would
   * paint an alarm for a session nobody is watching right now. Most of those
   * rules target `.ring-fill` and `.ring-core`, which a paused ring never
   * renders (see below) — but `['full'] .tab-watch` targets the worklog dot,
   * which it does, and would turn a watched paused tab's dot to the page
   * colour over no disc: erased. So this is not only belt-and-suspenders any
   * more; "cannot ever match an alarm selector" is the guarantee gotcha 33's
   * rule is asking for, not "happens not to match this cascade today."
   */
  const dataLevel = paused ? 'paused' : ready ? contextLevel(pct) : 'empty'
  return (
    <svg
      className="ring"
      viewBox="0 0 16 16"
      data-level={dataLevel}
      style={{ ['--ring-bead-pitch' as string]: String(BEAD_PITCH) }}
    >
      <title>
        {paused
          ? `Paused — ${pct}% used when last active`
          : ready
            ? `Context ${pct}% used`
            : 'Context not read yet'}
      </title>
      {dataLevel === 'full' && <circle className="ring-core" cx="8" cy="8" r={CORE_R} />}
      <circle className="ring-track" cx="8" cy="8" r={RING_R} />
      {paused ? (
        <>
          {/*
           * Drawn BEFORE the pause bars — the opposite order from the live
           * branch below, where the dot goes last. The dot's r=2.86 fill
           * geometrically covers the middle of both bars no matter which is
           * on top, so one of them wins; only the losing shape's round-cap
           * *tips* survive outside the dot's circle. Dot-on-top (the live
           * ordering) left a solid red circle with two grey stubs poking out
           * top and bottom of each bar — not a pause icon, and not obviously
           * a dot either. Bars-on-top keeps the pause glyph exactly as drawn
           * everywhere else, unbroken and still legible as "II", with the
           * red dot showing through the gap between the bars and in slivers
           * past their outer edges — a watched accent behind a clean pause
           * icon, rather than the pause icon reduced to debris behind a dot.
           * Paused is the state a tab in this branch is actually in; watched
           * is the annotation. Confirmed against a real screenshot with both
           * true — no verify suite renders this component, so a screenshot
           * is the only way this combination gets checked at all.
           */}
          {watched && <circle className="tab-watch" cx="8" cy="8" r={WATCH_R} />}
          {/*
           * Two vertical bars, drawn as if the ring had no rotation. `.ring`
           * carries `transform: rotate(-90deg)` unconditionally (it is what
           * turns the fill arc's 3-o'clock start into 12 o'clock), and that
           * transform applies to every child, this path included — a plain
           * `v4.8` pair would come out as two *horizontal* bars on screen,
           * an equals sign rather than a pause icon. `ring-plus`'s cross is
           * exempt because a plus is unchanged by a 90° turn; two parallel
           * bars are not. Drawing the bars horizontal here, pre-rotation, is
           * what lands them vertical once the parent's transform is applied —
           * confirmed against the rendered screenshot, not just the maths.
           */}
          <path className="ring-pause" d="M5.6 6.6h4.8M5.6 9.4h4.8" />
        </>
      ) : (
        <>
          {ready && (
            <circle
              className="ring-fill"
              cx="8"
              cy="8"
              r={RING_R}
              strokeDasharray={CIRC}
              strokeDashoffset={CIRC * (1 - ratio)}
              strokeLinecap="round"
            />
          )}
          {/*
           * Last, so it sits on top of the full ring's disc. Red on red would
           * vanish there, so app.css inverts it to --bg at 'full' — the one
           * level where the centre of the ring is not the tab's own ground.
           */}
          {watched && <circle className="tab-watch" cx="8" cy="8" r={WATCH_R} />}
        </>
      )}
    </svg>
  )
}
