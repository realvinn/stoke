import { useEffect, useState } from 'react'
import type { UsageSnapshot, UsageWindow } from '@shared/types'

/**
 * Plan limits, and whether you are ahead of the clock.
 *
 * A bare percentage answers the wrong question. 40% used means nothing without
 * knowing how far into the window you are: 40% at the four-hour mark of a
 * five-hour window is comfortable, and 40% twenty minutes in is not. So each
 * bar carries a marker at the elapsed fraction of its own window. Fill sitting
 * left of the marker means you are under the pace the window refills at; right
 * of it means the limit arrives before the reset does.
 */

function countdown(resetsAt: number | null, now: number): string {
  if (resetsAt === null) return 'unused'
  const ms = resetsAt - now
  if (ms <= 0) return 'resetting'
  const mins = Math.floor(ms / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ${mins % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

/**
 * Colour follows the account's own severity, except that overrunning the pace
 * is worth showing before the account is anywhere near its limit — that is the
 * whole point of the marker.
 */
function tone(w: UsageWindow): string {
  if (w.severity && w.severity !== 'normal') return w.severity
  if (w.elapsed !== null && w.percent > w.elapsed * 100 + 10) return 'warning'
  return 'normal'
}

function Bar({ window: w, now }: { window: UsageWindow; now: number }): React.JSX.Element {
  const ahead = w.elapsed !== null && w.percent > w.elapsed * 100
  const title =
    w.elapsed === null
      ? `${w.label}: ${w.percent}% used`
      : `${w.label}: ${w.percent}% used, ${Math.round(w.elapsed * 100)}% through the window` +
        `${ahead ? ' — ahead of pace' : ''}`

  return (
    <div className="usage-row" title={title}>
      <span className="usage-label">{w.label}</span>
      <span
        className="usage-track"
        data-tone={tone(w)}
        style={{ '--usage-fill': w.percent / 100 } as React.CSSProperties}
      >
        <span className="usage-fill" />
        {w.elapsed !== null && (
          <span className="usage-pace" style={{ left: `${w.elapsed * 100}%` }} aria-hidden="true" />
        )}
      </span>
      <span className="usage-pct">{w.percent}%</span>
      <span className="usage-reset">{countdown(w.resetsAt, now)}</span>
    </div>
  )
}

export function UsageMeter(): React.JSX.Element | null {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    let live = true
    const pull = async (): Promise<void> => {
      const next = await window.stoke.usage.read()
      if (live) setSnap(next)
    }
    void pull()
    // The main process caches for a minute; this only has to be often enough
    // that the countdown does not visibly stall.
    const poll = setInterval(() => void pull(), 60_000)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      live = false
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [])

  // Nothing at all rather than a row of zeroes: an unreachable endpoint is not
  // the same as no usage, and a wrong number here would be believed.
  if (!snap || snap.error || !snap.windows.length) return null

  return (
    <div className="usage-meter">
      {snap.windows.map((w) => (
        <Bar key={`${w.kind}-${w.label}`} window={w} now={now} />
      ))}
    </div>
  )
}
