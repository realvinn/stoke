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
}

export function ContextBar({ used, limit, showLabel = true }: MeterProps): React.JSX.Element {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0
  const pct = Math.round(ratio * 100)
  return (
    <div className="meter-inline">
      <div
        className="meter"
        data-level={level(ratio)}
        style={{ ['--meter-scale' as string]: String(ratio) }}
        role="meter"
        aria-valuenow={used}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-label="Context window used"
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
  ready = true
}: {
  used: number
  limit: number
  ready?: boolean
}): React.JSX.Element {
  const ratio = ready && limit > 0 ? Math.min(1, used / limit) : 0
  const pct = Math.round(ratio * 100)
  return (
    <svg className="ring" viewBox="0 0 16 16" data-level={ready ? level(ratio) : 'empty'}>
      <title>{ready ? `Context ${pct}% used` : 'Context not read yet'}</title>
      <circle className="ring-track" cx="8" cy="8" r={RING_R} />
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
    </svg>
  )
}
