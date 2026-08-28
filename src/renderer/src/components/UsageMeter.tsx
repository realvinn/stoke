import { useEffect, useRef, useState } from 'react'
import type { StatusLineSnapshot, UsageSnapshot, UsageWindow } from '@shared/types'
import { mergeUsageWindows, statusLineWindows } from '@shared/statusLine'

/**
 * How often the account reading is refreshed with nothing else happening, and
 * how often the countdown text is recomputed.
 *
 * 30s for both. The account endpoint is polled on this interval *or* whenever a
 * new message starts, whichever comes first — see the `promptId` branch below.
 * The main process holds a cache of the same length, so an interval shorter
 * than this one would return the same object rather than a fresher reading.
 */
const POLL_MS = 30_000

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

/**
 * `resetsAt === null` used to mean only one thing: an account window that had
 * never been touched. From the statusLine payload it means something else
 * too — a window `reading()` (statusLine.ts) parsed a `used_percentage` for
 * but no `resets_at` for, independently. So a null reset no longer implies
 * zero usage: with `percent > 0` this says the reset time is unknown, rather
 * than the false "unused", which would contradict the percentage sitting
 * right next to it.
 */
function countdown(resetsAt: number | null, percent: number, now: number): string {
  if (resetsAt === null) return percent > 0 ? 'unknown' : 'unused'
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
      <span className="usage-reset">{countdown(w.resetsAt, w.percent, now)}</span>
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
    const tick = setInterval(() => setNow(Date.now()), POLL_MS)
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
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  /*
   * Whichever of the two sources was read more recently states the figures,
   * and the account states severity either way. mergeUsageWindows explains
   * why that comparison exists and what it fixed; the short version is that
   * the payload stops being rewritten when its session ends, and outranking
   * the account on the strength of being "the live one" is exactly how the
   * chip came to freeze for the rest of the run.
   *
   * The two sources fail independently, and that is the point of merging them
   * rather than picking one. The payload exists only while a session is up;
   * the account route needs the network and a token. macOS used to have
   * neither — `readCredentials` looked only at ~/.claude/.credentials.json,
   * which does not exist there — so the chip really did go blank the moment
   * the last tab closed. It reads the login Keychain too now, so an idle app
   * still has figures.
   *
   * -Infinity, not 0, for a source that has not answered: it has to lose every
   * comparison, and a real timestamp is never below it.
   */
  const fromLine = line ? statusLineWindows(line, now) : []
  const fromAccount = snap && !snap.error ? snap.windows : []
  const payloadAt = fromLine.length > 0 && line ? line.receivedAt : -Infinity
  const accountAt = fromAccount.length > 0 && snap ? snap.fetchedAt : -Infinity
  const windows: UsageWindow[] = mergeUsageWindows(fromLine, fromAccount, payloadAt, accountAt)

  // Nothing at all rather than a row of zeroes: no reading is not the same as
  // no usage, and a wrong number here would be believed.
  if (!windows.length) return null

  /*
   * "as of" names when the figures on screen were read, so it has to follow
   * the same comparison the merge just made rather than always quoting the
   * payload. Quoting the payload while showing the account's numbers would
   * put a stale time next to a fresh reading, which is worse than no time.
   */
  const readAt = Math.max(payloadAt, accountAt)
  const asOf = Number.isFinite(readAt) ? `as of ${clock(readAt)}` : null

  // The two windows that actually run out. A model-scoped one is shown in the
  // panel but would make the chip a wall of digits.
  const session = windows.find((w) => w.kind === 'session')
  const weekly = windows.find((w) => w.kind === 'weekly')
  const ahead = windows.some((w) => w.elapsed !== null && w.percent > w.elapsed * 100)

  // With both windows the pair of numbers is self-explanatory (5-hour, then
  // weekly, always in that order). Alone, a bare "29%" names nothing — so a
  // solo window gets a short prefix, and the tooltip names it too.
  const soleWindow = session && !weekly ? session : weekly && !session ? weekly : null
  const chipTitle = soleWindow ? soleWindow.label : 'Plan limits'

  return (
    <div className="usage-chip-wrap">
      <button
        className="usage-chip"
        data-ahead={ahead || undefined}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={asOf ? `${chipTitle}, ${asOf} — click for detail` : `${chipTitle} — click for detail`}
      >
        {session && (
          <span>
            {!weekly && '5h '}
            {session.percent}%
          </span>
        )}
        {session && weekly && <span className="usage-chip-sep">·</span>}
        {weekly && (
          <span>
            {!session && 'wk '}
            {weekly.percent}%
          </span>
        )}
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
            {/*
             * Names the source the figures actually came from, which is now a
             * question with two answers rather than one. This used to say "an
             * open session's own figures" unconditionally whenever a payload
             * existed — and it stayed on screen, next to numbers that had
             * stopped moving, for the rest of the run. It is the sentence
             * someone reads before deciding whether to trust a reading they
             * are looking at hours later, so it has to follow the same
             * comparison the merge made.
             */}
            {asOf && (
              <p className="usage-note">
                {accountAt > payloadAt
                  ? `read from your account, ${asOf}. refreshed every ${POLL_MS / 1000}s, and again whenever a message starts.`
                  : fromAccount.length > 0
                    ? `an open session's own figures, ${asOf} — the account is read directly too, so these stay up once every session is closed.`
                    : `read from an open session's status line, ${asOf}. the account could not be reached, so this stops updating when the last session closes.`}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  )
}
