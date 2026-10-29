import { isId } from './hub/codec.ts'
import { addDays, addMonths, dayKey, dayLengthMs, monthDays, monthLengthMs, monthOf } from './localDay.ts'
import type { LiveSessionState } from './types.ts'

export const LIVE_FIELDS = ['openMs', 'busyMs', 'agentMs'] as const
export const AGENT_FIELDS = ['estBusyMs', 'estAgentMs', 'added', 'removed', 'prompts', 'sessions', 'tokensIn', 'tokensOut'] as const
export type LiveField = (typeof LIVE_FIELDS)[number]
export type AgentField = (typeof AGENT_FIELDS)[number]
export interface StatsDayLocal { openH: number[]; busyH: number[]; agentH: number[] }
export type StatsDay = Record<LiveField | AgentField, number> & { local?: StatsDayLocal }
export interface StatsMonth { v: 1; computer: string; month: string; days: Record<string, StatsDay> }
export type StatsAgentDay = Record<AgentField, number>
export interface StatsAgentMonth { month: string; days: Record<string, StatsAgentDay> }
export interface StatsPassResult { ledger: string; storeId: string; months: StatsAgentMonth[]; filesTotal: number; filesPending: number; skipped: number; bytesRead: number; stoppedBy: 'time' | 'cancel' | null; ms: number }
export type StatsWhy = 'development' | 'sandbox' | null

export function emptyDay(): StatsDay {
  return { openMs: 0, busyMs: 0, agentMs: 0, estBusyMs: 0, estAgentMs: 0, added: 0, removed: 0, prompts: 0, sessions: 0, tokensIn: 0, tokensOut: 0 }
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const count = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0
function validDay(day: string, month: string): boolean {
  if (!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(day) || !day.startsWith(`${month}-`)) return false
  const [year, m, d] = day.split('-').map(Number)
  return d >= 1 && d <= new Date(Date.UTC(year, m, 0)).getUTCDate()
}
export function parseStatsMonth(raw: unknown): StatsMonth | null {
  if (!object(raw) || raw.v !== 1 || typeof raw.computer !== 'string' || !isId('stats', raw.computer) || typeof raw.month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(raw.month) || !object(raw.days)) return null
  const days: Record<string, StatsDay> = {}
  for (const [key, value] of Object.entries(raw.days)) {
    if (!validDay(key, raw.month) || !object(value)) return null
    const day = emptyDay()
    for (const field of [...LIVE_FIELDS, ...AGENT_FIELDS]) {
      const v = value[field]
      if (v === undefined) continue
      if (!count(v)) return null
      day[field] = v
    }
    if (object(value.local)) {
      const { openH, busyH, agentH } = value.local
      if ([openH, busyH, agentH].every(a => Array.isArray(a) && a.length === 24 && a.every(count))) {
        day.local = { openH: [...openH as number[]], busyH: [...busyH as number[]], agentH: [...agentH as number[]] }
      }
    }
    days[key] = day
  }
  return { v: 1, computer: raw.computer, month: raw.month, days }
}
export function syncedMonth(m: StatsMonth): StatsMonth {
  return { ...m, days: Object.fromEntries(Object.entries(m.days).map(([key, { local: _local, ...day }]) => [key, { ...day }])) }
}
export function isActiveDay(d: StatsDay): boolean { return d.busyMs + d.estBusyMs > 0 || d.prompts > 0 || d.added + d.removed > 0 }

export type StatsRange = '7d' | '30d' | '12mo'
export type StatsMetric = 'open' | 'agents' | 'lines'
export type StatsResetResult = { ok: true; view: StatsView } | { ok: false; message: string }
export interface StatsComputerInput { id: string; label: string; self: boolean; removed: boolean; slot: number; countingSince: number | null; countFrom: number; lastSyncedAt: number | null; months: readonly StatsMonth[] }
export interface StatsDayView { day: string; lengthMs: number; openMs: number | null; busyMs: number | null; agentMs: number | null; added: number | null; removed: number | null; timeFrom: 'live' | 'transcripts' | 'mixed' | null }
export interface StatsComputerView { id: string; label: string; self: boolean; removed: boolean; slot: number; countingSince: string | null; linesSince: string | null; lastSyncedAt: number | null; days: StatsDayView[] }
export interface StatsView { revision: number; counting: boolean; why: StatsWhy; today: string; asOf: number; computers: StatsComputerView[]; streak: { current: number; best: number }; backfill: { filesDone: number; filesTotal: number } | null; skipped: number }
export interface StatsCell { computerId: string; slot: number; open: 'value' | 'off' | 'not-counting'; agents: 'value' | 'not-counting'; openMs: number; busyMs: number; agentMs: number; added: number; removed: number; estimated: boolean }
export interface StatsBucket { key: string; partial: boolean; lengthMs: number; cells: StatsCell[] }
export interface StatsTiles { openMs: number; computers: number; busyMs: number; agentMs: number; atOnce: number | null; added: number; removed: number; streak: { current: number; best: number } }

export function streakOf(active: ReadonlySet<string>, today: string): { current: number; best: number } {
  const sorted = [...active].filter(d => d <= today).sort()
  let best = 0, run = 0, previous = ''
  for (const day of sorted) { run = previous && addDays(previous, 1) === day ? run + 1 : 1; best = Math.max(best, run); previous = day }
  let current = 0, day = active.has(today) ? today : addDays(today, -1)
  while (active.has(day)) { current++; day = addDays(day, -1) }
  return { current, best }
}

export function buildStatsView(input: { revision: number; now: number; counting: boolean; why: StatsWhy; computers: readonly StatsComputerInput[]; backfill: StatsView['backfill']; skipped: number }): StatsView {
  const today = dayKey(input.now)
  const start = `${addMonths(monthOf(today), -11)}-01`
  const active = new Set<string>()
  const computers = input.computers.map(c => {
    const stored = new Map<string, StatsDay>()
    for (const month of c.months) if (month.computer === c.id) for (const [day, value] of Object.entries(month.days)) stored.set(day, value)
    const countSince = c.countingSince === null ? null : dayKey(c.countingSince)
    const firstAgent = [...stored.entries()].filter(([, d]) => AGENT_FIELDS.some(f => d[f] > 0)).map(([day]) => day).sort()[0]
    const linesSince = c.countFrom > 0 ? dayKey(c.countFrom) : firstAgent && countSince ? (firstAgent < countSince ? firstAgent : countSince) : firstAgent ?? countSince
    const days: StatsDayView[] = []
    for (let day = start; day <= today; day = addDays(day, 1)) {
      const d = stored.get(day) ?? emptyDay()
      if (isActiveDay(d) && (!linesSince || day >= linesSince)) active.add(day)
      const hasOpen = countSince !== null && day >= countSince
      const hasAgents = linesSince !== null && day >= linesSince
      days.push({ day, lengthMs: dayLengthMs(day), openMs: hasOpen ? d.openMs : null, busyMs: hasAgents ? d.busyMs + d.estBusyMs : null, agentMs: hasAgents ? d.agentMs + d.estAgentMs : null, added: hasAgents ? d.added : null, removed: hasAgents ? d.removed : null, timeFrom: !hasAgents ? null : !countSince || day < countSince ? 'transcripts' : day === countSince ? 'mixed' : 'live' })
    }
    return { id: c.id, label: c.label, self: c.self, removed: c.removed, slot: c.slot, countingSince: countSince, linesSince, lastSyncedAt: c.lastSyncedAt, days }
  })
  return { revision: input.revision, counting: input.counting, why: input.why, today, asOf: input.now, computers, streak: streakOf(active, today), backfill: input.backfill, skipped: input.skipped }
}

export function statsBuckets(view: StatsView, range: StatsRange): StatsBucket[] {
  const month = monthOf(view.today)
  const count = range === '7d' ? 7 : 30
  const keys = range === '12mo' ? Array.from({ length: 12 }, (_, i) => addMonths(month, i - 11)) : Array.from({ length: count }, (_, i) => addDays(view.today, i - count + 1))
  const byComputer = view.computers.map(c => ({ c, days: new Map(c.days.map(d => [d.day, d])) }))
  return keys.map((key, index) => {
    const dates = range === '12mo' ? monthDays(key).filter(d => d <= view.today) : [key]
    const cells = byComputer.map(({ c, days }): StatsCell => {
      const selected = dates.map(d => days.get(d)).filter((d): d is StatsDayView => !!d)
      const openDays = selected.filter(d => d.openMs !== null), agentDays = selected.filter(d => d.busyMs !== null)
      const sum = (field: 'openMs' | 'busyMs' | 'agentMs' | 'added' | 'removed'): number => selected.reduce((n, d) => n + (d[field] ?? 0), 0)
      const openMs = sum('openMs')
      return { computerId: c.id, slot: c.slot, open: !openDays.length ? 'not-counting' : openMs ? 'value' : 'off', agents: agentDays.length ? 'value' : 'not-counting', openMs, busyMs: sum('busyMs'), agentMs: sum('agentMs'), added: sum('added'), removed: sum('removed'), estimated: agentDays.some(d => d.timeFrom === 'transcripts' || d.timeFrom === 'mixed') }
    })
    return { key, partial: index === keys.length - 1, lengthMs: range === '12mo' ? monthLengthMs(key) : dayLengthMs(key), cells }
  })
}
export function cellValue(c: StatsCell, metric: StatsMetric): number { return metric === 'open' ? c.openMs : metric === 'agents' ? c.busyMs : c.added }
export function cellState(c: StatsCell, metric: StatsMetric): 'value' | 'off' | 'not-counting' { return metric === 'open' ? c.open : c.agents }
export function statsTiles(view: StatsView, buckets: readonly StatsBucket[]): StatsTiles {
  const totals = { openMs: 0, busyMs: 0, agentMs: 0, added: 0, removed: 0 }
  const computers = new Set<string>()
  for (const b of buckets) for (const c of b.cells) {
    if (c.open === 'value') { totals.openMs += c.openMs; computers.add(c.computerId) }
    if (c.agents === 'value') { totals.busyMs += c.busyMs; totals.agentMs += c.agentMs; totals.added += c.added; totals.removed += c.removed }
  }
  return { ...totals, computers: computers.size, atOnce: totals.busyMs ? Math.round(10 * totals.agentMs / totals.busyMs) / 10 : null, streak: view.streak }
}
export function formatHours(ms: number, locale?: string): string {
  const hours = ms / 3_600_000
  if (hours < 1 && ms > 0) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(ms / 60_000)} min`
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: hours < 10 ? 1 : 0 }).format(hours)} h`
}
export function formatLines(n: number, locale?: string): string {
  if (n < 10_000) return new Intl.NumberFormat(locale).format(n)
  if (n < 1_000_000) return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(n / 1000)}k`
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(n / 1_000_000)}M`
}
export function workingTabs(states: readonly Pick<LiveSessionState, 'ptyId' | 'status'>[], counts: (ptyId: string) => boolean): number { return states.filter(s => s.status === 'busy' && counts(s.ptyId)).length }
export function codexAccountHomes(accounts: Record<string, { cli: string; kind: string; home: string }>): string[] { return [...new Set(Object.values(accounts).filter(a => a.cli === 'codex' && a.kind === 'login' && a.home).map(a => a.home))] }
