import { useEffect, useRef, useState } from 'react'
import type { StatusLineSnapshot, UsageBoard, UsageReading, UsageTarget, UsageWindow } from '@shared/types'
import { keepUsage } from '@shared/statusLine'
import { CLAUDE_DEFAULT_KEY, chipRows, claudeWindowsFor, panelGroups, usageChipKey, usageTargetKey } from '@shared/usageSources'
import { cliFor } from '@shared/codingClis'
import { useFloatingLayer } from '../lib/floatingLayers'
import {
  balanceText,
  clock,
  countdown,
  isStale,
  remainingLabel,
  shortLabel,
  tone,
  windowResetLabel,
  worstTone
} from '@shared/usageView'
import { agentMark } from '../lib/agentColor'

/**
 * How often the reading the chip shows is refreshed with nothing else happening.
 *
 * 30s. The account endpoint is polled on this interval *or* whenever a new
 * message starts, whichever comes first — see the `promptId` branch below. The
 * main process holds a floor of the same length per source, so an interval
 * shorter than this one would return the same object rather than a fresher
 * reading.
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
      {/* In the order they are drawn: the text line, then the bar alone on
          the line below (app.css `.usage-row`'s grid areas). */}
      <span className="usage-label">{w.label}</span>
      <span className="usage-pct">{w.percent}%</span>
      <span className="usage-reset">
        {ahead && <span className="usage-ahead">ahead · </span>}
        {w.active ? windowResetLabel(w, now) : 'not in use'}
      </span>
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
    </div>
  )
}

/**
 * What one reading draws: its windows (a Claude account's merged with that
 * account's own sessions' payload, and nothing of any other account's), when
 * they were read, and from where.
 */
interface ReadingView {
  reading: UsageReading
  windows: UsageWindow[]
  /** When the figures shown were read; -Infinity for none. */
  readAt: number
  /** Where they came from, for the panel's meta line. */
  from: string
}

function viewOf(reading: UsageReading, lines: Record<string, StatusLineSnapshot>, now: number): ReadingView {
  const snap = reading.snapshot
  if (reading.source === 'anthropic') {
    /*
     * Whichever of the two sources was read more recently states the
     * figures, and the account states severity either way.
     * mergeUsageWindows explains why that comparison exists; the short
     * version is that the payload stops being rewritten when its session
     * ends, and outranking the account on the strength of being "the live
     * one" is how the chip came to freeze for the rest of the run.
     * `claudeWindowsFor` adds the account rule: only THIS account's payload.
     */
    const m = claudeWindowsFor(reading.accountId, lines[reading.accountId] ?? null, snap, now)
    const readAt = Math.max(m.payloadAt, m.accountAt)
    return { reading, windows: m.windows, readAt, from: m.accountAt > m.payloadAt ? 'from the account' : 'from the open session' }
  }
  const has = snap.windows.length > 0 || (snap.balances?.length ?? 0) > 0
  return {
    reading,
    windows: snap.windows,
    readAt: has ? snap.fetchedAt : -Infinity,
    from: snap.asOfLastTurn ? 'as of the last Codex turn' : reading.source === 'openrouter' ? 'from the key' : 'from the account'
  }
}

/** One source's block in the panel. */
function ReadingBlock({
  view,
  now,
  tag,
  onRetry
}: {
  view: ReadingView
  now: number
  /** "this tab" for the active account; "in the chip" for the launcher's Default account. */
  tag: string | null
  onRetry: () => void
}): React.JSX.Element {
  const { reading, windows, readAt } = view
  const snap = reading.snapshot
  const asOf = Number.isFinite(readAt) ? clock(readAt) : null
  const stale = Number.isFinite(readAt) && isStale(readAt, now)
  const waitingUntil = snap.error && snap.retryUntil && snap.retryUntil > now ? clock(snap.retryUntil) : null
  const vendor = { anthropic: 'Anthropic', openrouter: 'OpenRouter', cline: 'Cline', kimi: 'Kimi', codex: 'Codex' }[reading.source]
  return (
    <div className="usage-reading" data-active={tag ? true : undefined} data-key={reading.key}>
      <div className="usage-reading-head">
        <span className="usage-reading-name">
          {reading.label}
          {reading.snapshot.plan ? <span className="usage-plan"> · {reading.snapshot.plan}</span> : null}
          {tag ? <span className="usage-this-tab"> · {tag}</span> : null}
        </span>
        {asOf && (
          <span className="usage-head-meta" data-stale={stale || undefined}>
            {view.from} · {asOf}
            {stale ? ' · stale' : ''}
          </span>
        )}
      </div>
      {reading.detail && <span className="usage-reading-detail">{reading.detail}</span>}

      {windows.map((w) => (
        <Bar key={`${w.kind}-${w.label}`} window={w} now={now} />
      ))}

      {snap.extraCredits?.enabled && (
        <div className="usage-row" title="Paid overage, once a window is spent">
          <span className="usage-label">Extra usage</span>
          <span className="usage-pct">{Math.round(snap.extraCredits.percent)}%</span>
          <span className="usage-reset">paid overage</span>
          <span
            className="usage-track"
            data-tone="normal"
            style={{ '--usage-fill': Math.min(1, snap.extraCredits.percent / 100) } as React.CSSProperties}
          >
            <span className="usage-fill" />
          </span>
        </div>
      )}

      {(snap.balances ?? []).map((b) => (
        <div className="usage-balance" key={b.label} title={b.title}>
          <span className="usage-label">{b.label}</span>
          <span className="usage-balance-value">{balanceText(b)}</span>
        </div>
      ))}

      {snap.note && <span className="popover-text usage-note">{snap.note}</span>}

      {snap.error && (
        <div className="usage-error">
          <span className="popover-text" data-tone="warning">
            {snap.error}
            {reading.source === 'anthropic' && snap.error.startsWith('Not signed in')
              ? ' Plan limits need a Claude.ai sign-in; an API key has none.'
              : ''}
            {/*
              When a read is paused, say until when: main will not re-fetch
              before then, so "Try again" genuinely cannot do anything yet.
              Whose pause it is gets said accurately: `retryAfter` is set only
              when the source sent `Retry-After`; without it the wait is
              Stoke's own escalating guess.
            */}
            {waitingUntil &&
              (snap.retryAfter
                ? ` ${vendor} asked for a pause; trying again at ${waitingUntil}.`
                : ` Trying again at ${waitingUntil}.`)}
            {(windows.length > 0 || (snap.balances?.length ?? 0) > 0) && asOf
              ? ` The figures above are the last good reading, from ${asOf}.`
              : ''}
          </span>
          <button className="btn" data-size="sm" disabled={waitingUntil !== null} onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * The usage chip in the title bar, and the panel behind it.
 *
 * The chip follows the tab in front: its agent, on its account (`target`).
 * A Claude tab on a second account shows THAT account's plan limits; a Codex
 * tab its Codex home's; a tab pointed at OpenRouter the key; a Cline tab the
 * Cline balance. An agent with nothing Stoke can read falls back to Claude
 * Code's Default account, as the chip always was, and says so.
 *
 * The panel lists every source Stoke can read, grouped by agent and then
 * account, hiding each one that has no reading — so it answers "how much is
 * left anywhere" without a tab per account.
 */
export function UsageChip({ target, accountLabel }: { target: UsageTarget | null; accountLabel?: string }): React.JSX.Element | null {
  const [board, setBoard] = useState<UsageBoard | null>(null)
  // The newest payload per account: `keepUsage` within an account only.
  const [lines, setLines] = useState<Record<string, StatusLineSnapshot>>({})
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  // The panel drops from the title bar over the docked browser (gotcha 14).
  useFloatingLayer(panelRef, open)
  const chipRef = useRef<HTMLButtonElement>(null)

  /*
   * The tab being followed and whether the panel is open, read by the poll
   * without re-arming it (gotcha 31: re-running an effect to pick up a new
   * closure tears down what it owns).
   */
  const targetRef = useRef(target)
  targetRef.current = target
  const openRef = useRef(open)
  openRef.current = open

  /*
   * One pull, reachable from every effect below. With `forAccount` it is a
   * read made for another account's message: its readings are taken, but
   * which reading answers for the tab in front stays what the last read FOR
   * that tab said.
   */
  const pullRef = useRef<(reason: 'poll' | 'message', forAccount?: UsageTarget) => void>(() => {})
  useEffect(() => {
    let live = true
    // Counts reads made FOR the tab in front; only the newest may say which reading that is.
    let targetSeq = 0
    const pull = (reason: 'poll' | 'message', forAccount?: UsageTarget): void => {
      const mine = forAccount ? -1 : ++targetSeq
      const asked = forAccount ?? targetRef.current
      const call = openRef.current ? window.stoke.usage.all : window.stoke.usage.read
      void call(reason, asked).then((next) => {
        if (!live) return
        setBoard((prev) => {
          // A read for another account, or one overtaken by a newer read,
          // brings its readings but not its idea of which one is in front.
          const own = mine === targetSeq
          return { readings: next.readings, activeKey: own || !prev ? next.activeKey : prev.activeKey, target: own || !prev ? next.target : prev.target }
        })
      })
    }
    pullRef.current = pull
    pull('poll')
    // Main caches per source, and backs off further when one is rate-limited;
    // this only has to be often enough that the countdown does not stall.
    const poll = setInterval(() => pull('poll'), POLL_MS)
    const tick = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => {
      live = false
      clearInterval(poll)
      clearInterval(tick)
    }
  }, [])

  // A new tab in front, or the panel opening: read now, not at the next poll.
  const targetKey = usageTargetKey(target)
  useEffect(() => {
    pullRef.current('poll')
  }, [targetKey, open])

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
      const account = s.accountId || 'default'
      // Keep the newest reading rather than the newest arrival — and keep the
      // account's rate limits even when the newest payload states none, which
      // is every payload until its session's first API response lands. Per
      // account: another account's payload is another account's figures.
      // Same rule main applies to `lastStatusLines`; see `keepUsage`.
      setLines((prev) => ({ ...prev, [account]: keepUsage(prev[account] ?? null, s) }))

      if (s.promptId && lastPrompt.get(s.sessionId) !== s.promptId) {
        lastPrompt.set(s.sessionId, s.promptId)
        // Refresh the account that session spends, which need not be the tab in front.
        pullRef.current('message', { cli: 'claude', accountId: account })
      }
    }

    // The last reading per account this run, so closing every tab does not
    // blank the chip — it goes quiet and says when it last heard anything.
    void window.stoke.statusLine.last().then((all) => {
      if (live) for (const s of all ?? []) take(s)
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

  const readings = board?.readings ?? []
  const shownKey = usageChipKey(board, target)
  const answered = !!board && usageTargetKey(board.target) === targetKey
  const unavailable = answered && shownKey === null
  const active = readings.find((r) => r.key === shownKey) ?? null
  // Before the first answer, the Default account's payload alone can still speak.
  const view: ReadingView | null = active
    ? viewOf(active, lines, now)
    : !target && lines.default && !board
      ? viewOf(
          { key: CLAUDE_DEFAULT_KEY, source: 'anthropic', cli: 'claude', accountId: 'default', label: 'Default', detail: null, snapshot: { windows: [], extraCredits: null, fetchedAt: 0, error: null } },
          lines,
          now
        )
      : null

  // Before the first read has answered there is nothing to say, and a wrong
  // number here would be believed. Once it HAS answered, an error is drawn as
  // an error rather than as the chip vanishing.
  if (!target && !board && !view?.windows.length) return null

  const windows = view?.windows ?? []
  const snap = view?.reading.snapshot ?? null
  const asOf = view && Number.isFinite(view.readAt) ? clock(view.readAt) : null
  const stale = !!view && Number.isFinite(view.readAt) && isStale(view.readAt, now)
  const rows = chipRows(windows)
  const worst = worstTone(rows)
  const balance = !rows.length ? snap?.balances?.[0] : undefined

  const who = view
    ? view.reading.cli
      ? `${cliFor(view.reading.cli).label}${view.reading.accountId !== 'default' ? ` (${view.reading.label})` : ''}`
      : view.reading.label
    : target ? `${cliFor(target.cli).label}${target.accountId !== 'default' ? ` (${accountLabel ?? target.accountId})` : ''}` : 'Claude Code'
  const followed = target ? cliFor(target.cli).label : null
  const label = rows.length
    ? rows
        .map(
          (w) =>
            `${w.label}: ${remainingLabel(w)}${w.kind === 'session' ? `, ${windowResetLabel(w, now)}` : ''}`
        )
        .join('; ')
    : balance
      ? `${balance.label}: ${balanceText(balance)}`
      : (snap?.error ?? snap?.note ?? (answered ? 'No readable usage for this account' : 'Reading this account’s usage…'))

  // Whose figures these are, in that agent's (or that account's) colour.
  const markKey = view ? (view.reading.cli && view.reading.accountId !== 'default' ? view.reading.accountId : view.reading.cli) : target ? target.accountId !== 'default' ? target.accountId : target.cli : 'claude'
  const groups = panelGroups(readings, shownKey, (r) => (r.source === 'anthropic' ? viewOf(r, lines, now).windows.length : 0))
  const retry = (): void => pullRef.current('message')

  return (
    <div className="usage-chip-wrap">
      <button
        ref={chipRef}
        className="usage-chip"
        {...agentMark(markKey)}
        data-source={view?.reading.source}
        data-account={view?.reading.accountId ?? target?.accountId}
        data-unavailable={unavailable || undefined}
        data-tone={rows.length ? worst : 'none'}
        data-stale={stale || undefined}
        aria-expanded={open}
        aria-label={`Usage, ${who}. ${label}${stale && asOf ? `. As of ${asOf}` : ''}`}
        onClick={() => setOpen((v) => !v)}
        title={`${who} — ${label}${asOf ? ` — as of ${asOf}` : ''}. Click for every account.`}
      >
        {rows.length ? (
          rows.map((w) => (
            <span className="usage-mini" data-tone={tone(w)} key={`${w.kind}-${w.label}`} aria-hidden="true">
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
        ) : balance ? (
          <span className="usage-mini usage-mini-balance" aria-hidden="true">
            <span className="usage-mini-label">{balance.unit === 'usd' ? 'credit' : 'cr'}</span>
            <span className="usage-mini-left">{balanceText(balance)}</span>
          </span>
        ) : (
          <span className="usage-mini" aria-hidden="true">
            <span className="usage-mini-label">usage</span>
            <span className="usage-mini-left">—</span>
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click-away, behind the panel and above everything else. */}
          <div className="popover-backdrop" onClick={() => setOpen(false)} />
          <div className="popover usage-panel" role="dialog" aria-label="Usage" ref={panelRef}>
            <div className="usage-head">
              <span className="popover-title">Usage</span>
              {unavailable && followed && <span className="usage-head-meta">{who}: none readable</span>}
            </div>

            {!view && target && <p className="popover-text" role="status">{label}</p>}

            {groups.map((g) => (
              <section className="usage-group" key={g.source} aria-label={g.title}>
                <h3 className="usage-group-title" {...agentMark(g.source === 'openrouter' ? null : g.readings[0]?.cli)}>
                  {g.title}
                </h3>
                {g.readings.map((r) => (
                  <ReadingBlock
                    key={r.key}
                    view={viewOf(r, lines, now)}
                    now={now}
                    tag={r.key !== shownKey ? null : target ? 'this tab' : 'in the chip'}
                    onRetry={retry}
                  />
                ))}
              </section>
            ))}
            {!groups.length && <p className="popover-text">No reading yet.</p>}

            <p className="popover-text">
              The marker is where you would be at an even pace; fill past it means you are going faster than the window refills.
              {' '}Claude Code accounts refresh every {POLL_MS / 1000}s and whenever a message starts; Codex figures are its last turn&rsquo;s.
              {groups.some((g) => g.source === 'cline')
                ? ' Cline states no free-model allowance, so only its credit balance is shown.'
                : ''}
            </p>
          </div>
        </>
      )}
    </div>
  )
}
