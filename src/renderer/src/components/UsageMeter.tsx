import { useEffect, useState } from 'react'
import type { StatusLineSnapshot, UsageSnapshot, UsageWindow } from '@shared/types'
import { statusLineWindows } from '@shared/statusLine'

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

/** Local wall-clock HH:MM, for the "as of" on a reading that may be stale. */
function clock(at: number): string {
  const d = new Date(at)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
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

/**
 * The numbers in the title bar, and the bars behind them.
 *
 * Most of the time the only question is "how much is left", which is two
 * numbers and belongs where it can be read without looking for it. The bars
 * answer the second question — am I ahead of the clock — and that is worth a
 * deliberate click rather than permanent screen space.
 */
export function UsageChip(): React.JSX.Element | null {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null)
  const [line, setLine] = useState<StatusLineSnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)

  useEffect(() => {
    let live = true
    const pull = async (): Promise<void> => {
      const next = await window.stoke.usage.read()
      if (live) setSnap(next)
    }
    void pull()
    // The main process caches, and backs off further when rate-limited; this
    // only has to be often enough that the countdown does not visibly stall.
    const poll = setInterval(() => void pull(), 60_000)
    const tick = setInterval(() => setNow(Date.now()), 30_000)
    return () => {
      live = false
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [])

  useEffect(() => {
    let live = true
    // The last reading of the run, so closing every tab does not blank the
    // chip — it goes quiet and says when it last heard anything.
    void window.stoke.statusLine.last().then((s) => {
      if (live && s) setLine(s)
    })
    const off = window.stoke.statusLine.onUpdate((s) => setLine(s))
    return () => {
      live = false
      off()
    }
  }, [])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  /*
   * The statusLine payload wins when there is one. It is the live account
   * state as the CLI itself was just told it, and on macOS it is the only
   * source there is — the OAuth token lives in the Keychain, not in
   * ~/.claude/.credentials.json, which is why this chip rendered nothing there.
   */
  const fromLine = line ? statusLineWindows(line, now) : []
  const windows: UsageWindow[] =
    fromLine.length > 0 ? fromLine : snap && !snap.error ? snap.windows : []

  // Nothing at all rather than a row of zeroes: no reading is not the same as
  // no usage, and a wrong number here would be believed.
  if (!windows.length) return null

  const asOf = fromLine.length > 0 && line ? `as of ${clock(line.receivedAt)}` : null

  // The two windows that actually run out. A model-scoped one is shown in the
  // panel but would make the chip a wall of digits.
  const session = windows.find((w) => w.kind === 'session')
  const weekly = windows.find((w) => w.kind === 'weekly')
  const ahead = windows.some((w) => w.elapsed !== null && w.percent > w.elapsed * 100)

  return (
    <div className="usage-chip-wrap">
      <button
        className="usage-chip"
        data-ahead={ahead || undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={asOf ? `Plan limits, ${asOf} — click for detail` : 'Plan limits — click for detail'}
      >
        {session && <span>{session.percent}%</span>}
        {session && weekly && <span className="usage-chip-sep">·</span>}
        {weekly && <span>{weekly.percent}%</span>}
      </button>

      {open && (
        <>
          {/* Click-away, behind the panel and above everything else. */}
          <div className="usage-backdrop" onClick={() => setOpen(false)} />
          <div className="usage-panel" role="dialog" aria-label="Plan limits">
            {windows.map((w) => (
              <Bar key={`${w.kind}-${w.label}`} window={w} now={now} />
            ))}
            <p className="usage-note">
              the white mark is where you would be using it evenly. fill past it means
              you are going faster than it refills.
            </p>
            {asOf && (
              <p className="usage-note">
                read from an open session&rsquo;s status line, {asOf}. it only updates while a
                session is running.
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
