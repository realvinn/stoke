import { useEffect, useRef, useState } from 'react'
import type { StatusLineSnapshot, UsageSnapshot, UsageWindow } from '@shared/types'
import { mergeUsageWindows, statusLineWindows } from '@shared/statusLine'
import {
  clock,
  countdown,
  isStale,
  remainingLabel,
  resetLabel,
  shortLabel,
  tone,
  worstTone
} from '@shared/usageView'

/**
 * How often the account reading is refreshed with nothing else happening.
 *
 * 30s. The account endpoint is polled on this interval *or* whenever a new
 * message starts, whichever comes first — see the `promptId` branch below. The
 * main process holds a cache of the same length, so an interval shorter than
 * this one would return the same object rather than a fresher reading.
 */
const POLL_MS = 30_000

/** The countdown text is recomputed on its own, faster clock. */
const TICK_MS = 10_000

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

function Bar({ window: w, now }: { window: UsageWindow; now: number }): React.JSX.Element {
  const ahead = w.elapsed !== null && w.percent > w.elapsed * 100
  const title =
    w.elapsed === null
      ? `${w.label}: ${w.percent}% used`
      : `${w.label}: ${w.percent}% used, ${Math.round(w.elapsed * 100)}% through the window` +
        `${ahead ? ' — ahead of pace' : ''}`

  return (
    <div
      className="usage-row"
      title={title}
      data-inactive={w.active ? undefined : true}
      role="meter"
      aria-valuenow={w.percent}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`${w.label}, ${w.percent}% used`}
    >
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
      <span className="usage-reset">
        {ahead && <span className="usage-ahead">ahead · </span>}
        {w.active ? resetLabel(w.resetsAt, w.percent, now) : 'not in use'}
      </span>
    </div>
  )
}

/**
 * The plan-limit chip in the title bar, and the panel behind it.
 *
 * The chip answers the common question without a click: how much of each
 * window is left, and when the 5-hour one comes back. Its colour is the worst
 * of the two windows' tones. The panel is the detail: bars with the pace
 * marker, the reset as a clock time, extra usage, and which source the figures
 * came from and when.
 */
export function UsageChip(): React.JSX.Element | null {
  const [snap, setSnap] = useState<UsageSnapshot | null>(null)
  const [line, setLine] = useState<StatusLineSnapshot | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const chipRef = useRef<HTMLButtonElement>(null)

  /*
   * The account pull, reachable from the statusLine effect below without
   * making that effect depend on this one — the same ref idiom `TerminalView`
   * uses for `openUrlRef`, and for the reason CLAUDE.md gotcha 31 gives:
   * re-running an effect to pick up a new closure tears down the subscription
   * it owns, and here that subscription is the thing being listened to.
   */
  const pullRef = useRef<(reason: 'poll' | 'message') => void>(() => {})

  useEffect(() => {
    let live = true
    const pull = (reason: 'poll' | 'message'): void => {
      void window.stoke.usage.read(reason).then((next) => {
        if (live) setSnap(next)
      })
    }
    pullRef.current = pull
    pull('poll')
    // The main process caches, and backs off further when rate-limited; this
    // only has to be often enough that the countdown does not visibly stall.
    const poll = setInterval(() => pull('poll'), POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => {
      live = false
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [])

  useEffect(() => {
    let live = true

    /*
     * The last prompt id seen per session, which is what makes "or every
     * message" implementable at all.
     *
     * A payload arriving is not a message: the CLI rewrites the file about
     * three times a second for the whole of a turn, so `receivedAt` moving
     * says only that something was redrawn. `prompt_id` changes exactly once
     * per user message. Keyed by session because two open sessions have
     * unrelated prompt ids, and alternating pushes between them would
     * otherwise read as a message every time.
     */
    const lastPrompt = new Map<string, string>()

    const take = (s: StatusLineSnapshot): void => {
      // Keep the newest reading rather than the newest arrival. `pushStatusLine`
      // sends each session's own payload, so with two sessions open an idle
      // one's older reading can arrive after a live one's and would otherwise
      // tick the chip backwards.
      setLine((prev) => (prev && prev.receivedAt > s.receivedAt ? prev : s))

      if (s.promptId && lastPrompt.get(s.sessionId) !== s.promptId) {
        lastPrompt.set(s.sessionId, s.promptId)
        pullRef.current('message')
      }
    }

    // The last reading of the run, so closing every tab does not blank the
    // chip — it goes quiet and says when it last heard anything.
    void window.stoke.statusLine.last().then((s) => {
      if (live && s) take(s)
    })
    const off = window.stoke.statusLine.onUpdate(take)
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
    // Focus lands in the panel so Tab walks it, and comes back to the chip.
    panelRef.current?.querySelector<HTMLElement>('button, [tabindex]')?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      chipRef.current?.focus()
    }
  }, [open])

  /*
   * Whichever of the two sources was read more recently states the figures,
   * and the account states severity either way. mergeUsageWindows explains
   * why that comparison exists and what it fixed; the short version is that
   * the payload stops being rewritten when its session ends, and outranking
   * the account on the strength of being "the live one" is exactly how the
   * chip came to freeze for the rest of the run.
   *
   * -Infinity, not 0, for a source that has not answered: it has to lose every
   * comparison, and a real timestamp is never below it.
   */
  const fromLine = line ? statusLineWindows(line, now) : []
  const fromAccount = snap && !snap.error ? snap.windows : []
  const payloadAt = fromLine.length > 0 && line ? line.receivedAt : -Infinity
  const accountAt = fromAccount.length > 0 && snap ? snap.fetchedAt : -Infinity
  const windows: UsageWindow[] = mergeUsageWindows(fromLine, fromAccount, payloadAt, accountAt)

  // Before the first account read has answered there is nothing to say, and a
  // wrong number here would be believed. Once it HAS answered, an error is
  // drawn as an error rather than as the chip vanishing.
  if (!snap && !windows.length) return null

  const readAt = Math.max(payloadAt, accountAt)
  const asOf = Number.isFinite(readAt) ? clock(readAt) : null
  const stale = Number.isFinite(readAt) && isStale(readAt, now)

  // The two windows that actually run out. A model-scoped one is shown in the
  // panel but would make the chip a wall of digits.
  const session = windows.find((w) => w.kind === 'session')
  const weekly = windows.find((w) => w.kind === 'weekly')
  const rows = [session, weekly].filter((w): w is UsageWindow => w !== undefined)
  const worst = worstTone(rows)

  const label = rows.length
    ? rows
        .map(
          (w) =>
            `${w.label}: ${remainingLabel(w)}${w.kind === 'session' ? `, ${resetLabel(w.resetsAt, w.percent, now)}` : ''}`
        )
        .join('; ')
    : (snap?.error ?? 'Plan limits unavailable')

  return (
    <div className="usage-chip-wrap">
      <button
        ref={chipRef}
        className="usage-chip"
        data-tone={rows.length ? worst : 'none'}
        data-stale={stale || undefined}
        aria-expanded={open}
        aria-label={`Plan limits. ${label}${stale && asOf ? `. As of ${asOf}` : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={`${label}${asOf ? ` — as of ${asOf}` : ''}. Click for detail.`}
      >
        {rows.length ? (
          rows.map((w) => (
            <span className="usage-mini" data-tone={tone(w)} key={w.kind} aria-hidden="true">
              <span className="usage-mini-label">{shortLabel(w)}</span>
              <span
                className="usage-track usage-mini-track"
                style={{ '--usage-fill': w.percent / 100 } as React.CSSProperties}
              >
                <span className="usage-fill" />
                {w.elapsed !== null && (
                  <span className="usage-pace" style={{ left: `${w.elapsed * 100}%` }} />
                )}
              </span>
              <span className="usage-mini-left">{remainingLabel(w)}</span>
              <span className="usage-mini-reset">
                {w.kind === 'session' ? countdown(w.resetsAt, w.percent, now) : ''}
              </span>
            </span>
          ))
        ) : (
          <span className="usage-mini" aria-hidden="true">
            <span className="usage-mini-label">limits</span>
            <span className="usage-mini-left">—</span>
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click-away, behind the panel and above everything else. */}
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="popover usage-panel" role="dialog" aria-label="Plan limits" ref={panelRef}>
            <div className="usage-head">
              <span className="popover-title">Plan limits</span>
              {asOf && (
                <span className="usage-head-meta" data-stale={stale || undefined}>
                  {accountAt > payloadAt ? 'from your account' : 'from the open session'} · {asOf}
                  {stale ? ' · stale' : ''}
                </span>
              )}
            </div>

            {windows.map((w) => (
              <Bar key={`${w.kind}-${w.label}`} window={w} now={now} />
            ))}

            {snap?.extraCredits?.enabled && (
              <div className="usage-row" title="Paid overage, once a window is spent">
                <span className="usage-label">Extra usage</span>
                <span
                  className="usage-track"
                  data-tone="normal"
                  style={{ '--usage-fill': Math.min(1, snap.extraCredits.percent / 100) } as React.CSSProperties}
                >
                  <span className="usage-fill" />
                </span>
                <span className="usage-pct">{Math.round(snap.extraCredits.percent)}%</span>
                <span className="usage-reset">paid overage</span>
              </div>
            )}

            {snap?.error && (
              <div className="usage-error">
                <span className="popover-text" data-tone="warning">
                  {snap.error}
                  {snap.error.startsWith('Not signed in')
                    ? ' Plan limits need a Claude.ai sign-in; an API key has none.'
                    : ''}
                </span>
                <button className="btn" data-size="sm" onClick={() => pullRef.current('message')}>
                  Try again
                </button>
              </div>
            )}

            <p className="popover-text">
              {windows.length
                ? 'The marker is where you would be at an even pace; fill past it means you are going faster than the window refills.'
                : 'No reading yet.'}
              {accountAt > payloadAt
                ? ` Refreshed every ${POLL_MS / 1000}s, and again whenever a message starts.`
                : fromAccount.length > 0
                  ? ' The account is read too, so these keep updating once every session is closed.'
                  : windows.length
                    ? ' The account could not be reached, so this stops updating when the last session closes.'
                    : ''}
            </p>
          </div>
        </>
      )}
    </div>
  )
}
