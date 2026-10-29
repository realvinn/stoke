import { useMemo, useState } from 'react'
import { dayStartMs } from '@shared/localDay'
import { cellState, cellValue, formatHours, formatLines, statsBuckets, statsTiles, type StatsCell, type StatsMetric, type StatsRange } from '@shared/stats'
import { useStats } from '../lib/useStats'
import { StatsChart } from './StatsChart'
import '../styles/stats.css'

const dateLabel = (key: string): string => new Date(dayStartMs(key.length === 7 ? `${key}-01` : key)).toLocaleDateString(undefined, key.length === 7 ? { month: 'short', year: 'numeric' } : { weekday: 'short', day: 'numeric', month: 'short' })
function value(c: StatsCell | undefined, metric: StatsMetric): string {
  if (!c) return 'not counting yet'
  const state = cellState(c, metric)
  if (state !== 'value') return state === 'off' ? 'off' : 'not counting yet'
  return metric === 'lines' ? `+${formatLines(c.added)} −${formatLines(c.removed)}` : formatHours(cellValue(c, metric))
}
export function StatsPanel({ onOpenSettings }: { onOpenSettings?: () => void }): React.JSX.Element {
  const { view, error } = useStats()
  const [range, setRange] = useState<StatsRange>('30d')
  const [metric, setMetric] = useState<StatsMetric>('open')
  const [selected, setSelected] = useState<number | null>(null)
  const buckets = useMemo(() => view ? statsBuckets(view, range) : [], [view, range])
  const totals = useMemo(() => view ? statsTiles(view, buckets) : null, [view, buckets])
  const shown = buckets[selected ?? buckets.length - 1]
  const current = shown?.cells.find(c => c.computerId === view?.computers.find(x => x.self)?.id)
  return <section className="stats" onKeyDown={event => { if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation() }}>
    <div className="stats-body">
      <div className="segmented stats-controls" role="group" aria-label="Period">{([['7d', '7 d'], ['30d', '30 d'], ['12mo', '12 mo']] as const).map(([id, label]) => <button key={id} className="btn" aria-pressed={range === id} onClick={() => { setRange(id); setSelected(null) }}>{label}</button>)}</div>
      {view?.why === 'development' && <p className="field-hint">Only the installed Stoke counts stats. This development build does not count.</p>}
      {view?.why === 'sandbox' && <p className="field-hint">This copy uses its own data folder, so nothing is counted here.</p>}
      {error ? <p className="stats-empty">Stats could not be read ({error}).</p> : !view || !totals || !view.computers.length ? <p className="stats-empty">Nothing counted yet.</p> : <>
        <div className="stats-tiles">
          <div><span>Stoke open</span><strong>{formatHours(totals.openMs)}</strong><small>this computer</small></div>
          <div><span>Lines by agents</span><strong>+{formatLines(totals.added)}</strong><small>−{formatLines(totals.removed)} removed</small></div>
          <div><span>Agents working</span><strong>{formatHours(totals.busyMs)}</strong><small>{totals.atOnce === null ? 'none yet' : `${totals.atOnce}× at once`}</small></div>
          <div><span>Streak</span><strong>{view.streak.current} {view.streak.current === 1 ? 'day' : 'days'}</strong><small>best {view.streak.best}</small></div>
        </div>
        <div className="segmented stats-controls" role="group" aria-label="Chart">{([['open', 'Stoke open'], ['agents', 'Agents'], ['lines', 'Lines']] as const).map(([id, label]) => <button key={id} className="btn" aria-pressed={metric === id} onClick={() => setMetric(id)}>{label}</button>)}</div>
        <p className="stats-readout" aria-live="polite">{shown ? `${value(current, metric)} · ${shown.partial ? (range === '12mo' ? 'this month so far' : 'today so far') : dateLabel(shown.key)}` : 'Nothing counted yet.'}</p>
        <StatsChart buckets={buckets} metric={metric} computers={view.computers.length} selected={selected} onSelect={setSelected} label="Stats chart" firstLabel={buckets[0] ? dateLabel(buckets[0].key) : ''} lastLabel={buckets.at(-1) ? dateLabel(buckets.at(-1)!.key) : ''} />
        <details><summary>Show table</summary><table className="stats-table"><thead><tr><th>Day</th><th>Stoke open</th><th>Agents</th><th>Added</th><th>Removed</th></tr></thead><tbody>{buckets.map(bucket => { const c = bucket.cells.find(x => x.computerId === view.computers.find(x => x.self)?.id); return <tr key={bucket.key}><th>{dateLabel(bucket.key)}{c?.estimated && <small> estimated from transcripts</small>}</th><td>{value(c, 'open')}</td><td>{value(c, 'agents')}</td><td>{c?.agents === 'value' ? `+${formatLines(c.added)}` : '—'}</td><td>{c?.agents === 'value' ? `−${formatLines(c.removed)}` : '—'}</td></tr> })}</tbody></table></details>
        {view.backfill && <p className="field-hint">Counting your history… {view.backfill.filesDone} of {view.backfill.filesTotal} transcripts</p>}
        {view.skipped > 0 && <p className="field-hint">{view.skipped} transcripts could not be read.</p>}
        <details><summary>What counts</summary><p className="field-hint">Lines by agents counts lines Claude Code and Codex wrote through their edit tools, including subagents and workflows. It does not count hand typing, shell scripts, other agents or private chats. Earlier agent time is estimated from transcripts.</p>{onOpenSettings && <button className="btn" onClick={onOpenSettings}>Reset stats…</button>}</details>
      </>}
    </div>
  </section>
}
