import { cellState, cellValue, formatHours, formatLines, type StatsBucket, type StatsMetric } from './stats.ts'

export const COLUMN_MAX_PX = 24
export const GAP_PX = 2
export const DATA_END_PX = 4
export interface ChartBox { width: number; height: number; gutter: number; foot: number }
export interface ChartSegment { computerId: string; slot: number; y: number; h: number; path: string }
export interface ChartColumn { key: string; index: number; x: number; w: number; hitX: number; hitW: number; partial: boolean; segments: ChartSegment[] }
export interface ChartGridline { y: number; value: number; label: string }
export interface StatsChartLayout { yMax: number; unit: 'h' | 'lines'; plot: { left: number; top: number; right: number; bottom: number }; gridlines: ChartGridline[]; columns: ChartColumn[] }

function niceStep(max: number): number {
  const target = max / 4
  const magnitude = 10 ** Math.floor(Math.log10(target || 1))
  return [1, 2, 5, 10].map(n => n * magnitude).find(n => n >= target) ?? magnitude * 10
}
export function statsChartLayout(buckets: readonly StatsBucket[], metric: StatsMetric, computers: number, box: ChartBox): StatsChartLayout {
  const plot = { left: box.gutter, top: 0, right: Math.max(box.gutter, box.width), bottom: Math.max(0, box.height - box.foot) }
  const scale = metric === 'lines' ? 1 : 3_600_000
  const totals = buckets.map(b => b.cells.reduce((sum, c) => sum + (cellState(c, metric) === 'value' ? cellValue(c, metric) / scale : 0), 0))
  const tallest = Math.max(0, ...totals)
  const monthly = buckets.some(b => b.key.length === 7)
  const timeMax = Math.max(tallest, ...buckets.map(b => b.lengthMs * computers / scale), 0)
  const base = metric === 'lines' ? (tallest || 10) : timeMax
  const step = metric !== 'lines' && !monthly ? 24 : niceStep(base)
  const yMax = metric === 'lines' ? Math.ceil(base / step) * step : base
  const height = plot.bottom - plot.top
  const gridlines: ChartGridline[] = []
  for (let value = step; value <= yMax + 1e-9; value += step) gridlines.push({ y: plot.bottom - height * value / (yMax || 1), value, label: metric === 'lines' ? formatLines(value) : formatHours(value * 3_600_000) })
  const slotWidth = buckets.length ? (plot.right - plot.left) / buckets.length : 0
  const columns = buckets.map((b, index): ChartColumn => {
    const w = Math.max(0, Math.min(COLUMN_MAX_PX, slotWidth - GAP_PX))
    const hitX = plot.left + index * slotWidth
    const x = hitX + (slotWidth - w) / 2
    const values = b.cells.filter(c => cellState(c, metric) === 'value' && cellValue(c, metric) > 0).slice().sort((a, c) => a.slot - c.slot)
    let bottom = plot.bottom
    const segments = values.map((c, i): ChartSegment => {
      const rawH = height * (cellValue(c, metric) / scale) / (yMax || 1)
      const gap = i ? Math.min(GAP_PX, rawH) : 0
      const h = rawH - gap
      const y = bottom - rawH
      bottom = y
      const radius = i === values.length - 1 ? Math.min(DATA_END_PX, w / 2, h) : 0
      const path = radius > 0
        ? `M ${x} ${y + h} V ${y + radius} Q ${x} ${y} ${x + radius} ${y} H ${x + w - radius} Q ${x + w} ${y} ${x + w} ${y + radius} V ${y + h} Z`
        : `M ${x} ${y + h} V ${y} H ${x + w} V ${y + h} Z`
      return { computerId: c.computerId, slot: c.slot, y, h, path }
    })
    return { key: b.key, index, x, w, hitX, hitW: slotWidth, partial: b.partial, segments }
  })
  return { yMax, unit: metric === 'lines' ? 'lines' : 'h', plot, gridlines, columns }
}
export function nearestColumn(layout: StatsChartLayout, x: number): number | null {
  if (!layout.columns.length) return null
  const width = layout.columns[0].hitW
  return width > 0 ? Math.max(0, Math.min(layout.columns.length - 1, Math.floor((x - layout.plot.left) / width))) : 0
}
