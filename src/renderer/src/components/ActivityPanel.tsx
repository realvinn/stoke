import { useCallback, useEffect, useState } from 'react'
import type { ActivityReport, ActivitySlice } from '@shared/types'
import { IconClose, IconRefresh } from './Icons'

/**
 * What was worked on, per day and per project.
 *
 * Everything here comes from this machine — Claude Code's own transcripts plus
 * git where a repository exists. No model runs and nothing leaves the laptop,
 * which is why the whole report arrives in about a second where the worklog's
 * scan-and-write path took tens of seconds and real money per entry.
 */

type Period = 'today' | 'week' | 'lastWeek'

const PERIOD_LABEL: Record<Period, string> = {
  today: 'Today',
  week: 'This week',
  lastWeek: 'Last week'
}

/** Local midnight `daysAgo` days back, so a period is whole days rather than a rolling clock. */
function midnight(daysAgo: number): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - daysAgo)
  return d.getTime()
}

function range(period: Period): { from: number; to: number } {
  if (period === 'today') return { from: midnight(0), to: midnight(0) }
  if (period === 'week') return { from: midnight(6), to: midnight(0) }
  return { from: midnight(13), to: midnight(7) }
}

function hours(ms: number): string {
  return `${(ms / 3_600_000).toFixed(1)}h`
}

function dayLabel(day: string): string {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short'
  })
}

export function ActivityPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [period, setPeriod] = useState<Period>('today')
  const [report, setReport] = useState<ActivityReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async (p: Period): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const { from, to } = range(p)
      setReport(await window.stoke.activity.read(from, to))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void load(period)
  }, [load, period])

  const slices = report?.slices ?? []
  const totalMs = slices.reduce((n, s) => n + s.activeMs, 0)
  const totalLines = slices.reduce((n, s) => n + s.linesWritten, 0)
  const projectCount = new Set(slices.map((s) => s.project)).size
  const days = [...new Set(slices.map((s) => s.day))].sort().reverse()

  return (
    <section className="activity" style={{ width: '100%' }} aria-label="Activity report">
      <div className="worklog-head">
        <span className="worklog-title">Activity</span>
        <span style={{ flex: 1 }} />
        <button className="icon-btn" onClick={() => void load(period)} disabled={busy} title="Refresh">
          <IconRefresh />
          <span className="sr-only">Refresh the activity report</span>
        </button>
        <button className="icon-btn" onClick={onClose} title="Close activity panel">
          <IconClose />
          <span className="sr-only">Close activity panel</span>
        </button>
      </div>

      <div className="activity-body">
        <div className="activity-periods" role="tablist" aria-label="Period">
          {(Object.keys(PERIOD_LABEL) as Period[]).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={p === period}
              className="activity-period"
              data-active={p === period ? 'true' : undefined}
              onClick={() => setPeriod(p)}
            >
              {PERIOD_LABEL[p]}
            </button>
          ))}
        </div>

        <p className="activity-total">
          {hours(totalMs)} · {totalLines.toLocaleString()} lines · {projectCount}{' '}
          {projectCount === 1 ? 'project' : 'projects'}
        </p>

        {/*
          The numbers have to be defensible, not merely quoted. Naming the idle
          gap and saying "written/edited" is what lets someone answer "how is
          that measured?" without guessing — and stops the line count being read
          as repository growth by anyone who could go and check.
        */}
        <p className="activity-note">
          Active Claude time, gaps over {Math.round((report?.idleGapMs ?? 0) / 60_000)} min excluded.
          Lines are written or edited, not net.
        </p>

        {error && (
          <p className="activity-error" role="alert">
            {error}
          </p>
        )}

        {!!report?.skipped && (
          <p className="activity-note" role="status">
            {report.skipped} transcript{report.skipped === 1 ? '' : 's'} could not be read, so these
            totals are incomplete.
          </p>
        )}

        {/*
          "Nothing recorded" and "could not be read" are two different sentences
          on purpose. One is a fact about the week; the other is a bug, and a
          panel that renders them identically hides the bug behind a quiet week.
        */}
        {!busy && !error && days.length === 0 && (
          <p className="activity-empty">Nothing recorded for this period.</p>
        )}

        {days.map((day) => {
          const forDay = slices.filter((s) => s.day === day)
          return (
            <div key={day} className="activity-day">
              <h3 className="activity-day-head">
                <span>{dayLabel(day)}</span>
                <span>{hours(forDay.reduce((n, s) => n + s.activeMs, 0))}</span>
              </h3>
              {forDay.map((slice: ActivitySlice) => (
                <div key={`${slice.sessionId}-${slice.day}`} className="activity-row">
                  <div className="activity-row-head">
                    <span className="activity-project truncate" title={slice.project}>
                      {slice.project}
                    </span>
                    <span className="activity-metric">{hours(slice.activeMs)}</span>
                    <span className="activity-metric">{slice.linesWritten.toLocaleString()} lines</span>
                  </div>
                  {slice.title && (
                    <p className="activity-row-title truncate" title={slice.title}>
                      {slice.title}
                    </p>
                  )}
                  {(report?.commits[`${slice.project}|${slice.day}`] ?? []).slice(0, 4).map((subject) => (
                    <p key={subject} className="activity-commit truncate" title={subject}>
                      · {subject}
                    </p>
                  ))}
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </section>
  )
}
