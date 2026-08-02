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

const R = 5.6
const CIRC = 2 * Math.PI * R

/** Compact ring for tab strips, where there is no room for a bar and caption. */
export function ContextRing({ used, limit }: { used: number; limit: number }): React.JSX.Element {
  const ratio = limit > 0 ? Math.min(1, used / limit) : 0
  const pct = Math.round(ratio * 100)
  return (
    <svg className="ring" viewBox="0 0 16 16" data-level={level(ratio)}>
      <title>{`Context ${pct}% used`}</title>
      <circle className="ring-track" cx="8" cy="8" r={R} />
      <circle
        className="ring-fill"
        cx="8"
        cy="8"
        r={R}
        strokeDasharray={CIRC}
        strokeDashoffset={CIRC * (1 - ratio)}
        strokeLinecap="round"
      />
    </svg>
  )
}
