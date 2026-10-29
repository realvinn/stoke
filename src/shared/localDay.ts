/** Local calendar helpers shared by activity reporting and Stats. */
export const QUARTER_HOUR_MS = 900_000

export function dayKey(ms: number): string {
  const d = new Date(ms)
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${month}-${day}`
}

export function dayStartMs(day: string): number {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(year, month - 1, date).getTime()
}

export function addDays(day: string, n: number): string {
  const [year, month, date] = day.split('-').map(Number)
  return dayKey(new Date(year, month - 1, date + n, 12).getTime())
}

export function dayLengthMs(day: string): number { return dayStartMs(addDays(day, 1)) - dayStartMs(day) }
export function monthOf(day: string): string { return day.slice(0, 7) }
export function addMonths(month: string, n: number): string {
  const [year, m] = month.split('-').map(Number)
  return monthOf(dayKey(new Date(year, m - 1 + n, 1, 12).getTime()))
}
export function monthDays(month: string): string[] {
  const result: string[] = []
  for (let day = `${month}-01`; monthOf(day) === month; day = addDays(day, 1)) result.push(day)
  return result
}
export function monthLengthMs(month: string): number { return dayStartMs(`${addMonths(month, 1)}-01`) - dayStartMs(`${month}-01`) }

export interface DayPiece { startMs: number; endMs: number; day: string; hour: number }
export function cutByQuarterHour(startMs: number, endMs: number): DayPiece[] {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return []
  const result: DayPiece[] = []
  for (let start = startMs; start < endMs;) {
    const end = Math.min(endMs, (Math.floor(start / QUARTER_HOUR_MS) + 1) * QUARTER_HOUR_MS)
    result.push({ startMs: start, endMs: end, day: dayKey(start), hour: new Date(start).getHours() })
    start = end
  }
  return result
}
