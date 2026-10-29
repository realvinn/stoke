import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import { nearestColumn, statsChartLayout } from '@shared/statsChart'
import type { StatsBucket, StatsMetric } from '@shared/stats'

export function StatsChart({ buckets, metric, computers, selected, onSelect, label, firstLabel, lastLabel }: { buckets: readonly StatsBucket[]; metric: StatsMetric; computers: number; selected: number | null; onSelect(index: number | null): void; label: string; firstLabel: string; lastLabel: string }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState({ width: 300, height: 180, gutter: 40, foot: 24 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = (): void => {
      const rect = el.getBoundingClientRect(), font = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16
      setBox(current => current.width === rect.width && current.height === rect.height && current.gutter === font * 2.5 ? current : { width: rect.width, height: rect.height, gutter: font * 2.5, foot: font * 1.5 })
    }
    measure(); const observer = new ResizeObserver(measure); observer.observe(el, { box: 'border-box' })
    return () => observer.disconnect()
  }, [])
  const layout = useMemo(() => statsChartLayout(buckets, metric, computers, box), [buckets, metric, computers, box])
  return <div className="stats-chart-wrap" ref={ref}>
    <svg className="stats-chart" role="group" tabIndex={0} aria-label={label} width={box.width} height={box.height} viewBox={`0 0 ${box.width} ${box.height}`}
      onPointerMove={event => { const rect = event.currentTarget.getBoundingClientRect(); onSelect(nearestColumn(layout, event.clientX - rect.left)) }} onPointerLeave={() => onSelect(null)}
      onKeyDown={event => { let next: number | null = null; if (event.key === 'ArrowLeft') next = Math.max(0, (selected ?? layout.columns.length) - 1); else if (event.key === 'ArrowRight') next = Math.min(layout.columns.length - 1, (selected ?? -1) + 1); else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = layout.columns.length - 1; if (next !== null && next >= 0) { event.preventDefault(); event.stopPropagation(); onSelect(next) } }}>
      {layout.gridlines.map(line => <g key={line.value}><line className="stats-grid" x1={layout.plot.left} x2={layout.plot.right} y1={line.y} y2={line.y} /><text className="stats-tick" x={layout.plot.left - 4} y={line.y} textAnchor="end" dominantBaseline="middle">{line.label}</text></g>)}
      <line className="stats-baseline" x1={layout.plot.left} x2={layout.plot.right} y1={layout.plot.bottom} y2={layout.plot.bottom} />
      {layout.columns.flatMap(column => column.segments.map(segment => <path key={`${column.key}:${segment.computerId}`} className="stats-bar" data-slot={segment.slot} d={segment.path} />))}
      {selected !== null && layout.columns[selected] && <line className="stats-selected" x1={layout.columns[selected].hitX + layout.columns[selected].hitW / 2} x2={layout.columns[selected].hitX + layout.columns[selected].hitW / 2} y1={0} y2={layout.plot.bottom} />}
      <text className="stats-tick" x={layout.plot.left} y={box.height - 3}>{firstLabel}</text><text className="stats-tick" textAnchor="end" x={layout.plot.right} y={box.height - 3}>{lastLabel}</text>
    </svg>
  </div>
}
