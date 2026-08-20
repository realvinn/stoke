import { compactTokens } from '../lib/format'

/** Thresholds at which the meter changes colour to warn about context pressure. */
function level(ratio: number): 'ok' | 'warn' | 'critical' {
  if (ratio >= 0.9) return 'critical'
  if (ratio >= 0.7) return 'warn'
  return 'ok'
}

interface MeterProps {
  used: number
  limit: number
  /** Render the "84.2k / 200k" caption beside the bar. */
  showLabel?: boolean
  /**
   * Restored from the last run: draw the reading, but it must not be able to
   * paint warn/critical. Mirrors `ContextRing`'s `paused` prop and the same
   * reasoning — a session that is not running cannot be in a live alarm
   * state, however high the number it was saved with. `--text-muted` is the
   * same "no live data" colour `.ring-plus`/`.ring-pause` already use.
   */
  paused?: boolean
}

export function ContextBar({
  used,
  limit,
  showLabel = true,
  paused = false
}: MeterProps): React.JSX.Element {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0
  const pct = Math.round(ratio * 100)
  const dataLevel = paused ? 'paused' : level(ratio)
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
      {showLabel && (
        <span className="mono" style={{ fontSize: 'var(--fs-xs)' }}>
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
  const ratio = ready && limit > 0 ? Math.min(1, used / limit) : 0
  const pct = Math.round(ratio * 100)
  /*
   * `paused` gets its own data-level rather than falling through to
   * `level(ratio)`. That ratio is a reading from the last run, not a live
   * one — if it happened to be >= 70%, `.ring[data-level='warn']` /
   * `['critical']` would paint an arc in an alert colour for a session
   * nobody is watching right now. Those rules only target `.ring-fill`,
   * which a paused ring never renders (see below), so today this is a
   * belt-and-suspenders fix rather than a visible one — but "cannot ever
   * match a warn/critical selector" is the actual guarantee gotcha 33's
   * rule is asking for, not "happens not to match this cascade today."
   */
  const dataLevel = paused ? 'paused' : ready ? level(ratio) : 'empty'
  return (
    <svg className="ring" viewBox="0 0 16 16" data-level={dataLevel}>
      <title>
        {paused
          ? `Paused — ${pct}% used when last active`
          : ready
            ? `Context ${pct}% used`
            : 'Context not read yet'}
      </title>
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
          {watched && <circle className="tab-watch" cx="8" cy="8" r={WATCH_R} />}
        </>
      )}
    </svg>
  )
}
