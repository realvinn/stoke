import { cutByQuarterHour, dayStartMs, monthOf } from '../../shared/localDay.ts'
import { AGENT_FIELDS, buildStatsView, emptyDay, type StatsDay, type StatsMonth, type StatsPassResult, type StatsResetResult, type StatsView, type StatsWhy } from '../../shared/stats.ts'
import type { StatsFiles, StatsLedgerMeta } from './files.ts'

export const STATS_TICK_MS = 60_000
export const TICK_CAP_MS = 120_000
export const SAMPLE_CAP_MS = 2_000
export function statsCountsHere(packaged: boolean, userDataFlag: boolean, testSeam: string | undefined): { counts: boolean; why: StatsWhy } {
  if (!packaged && testSeam === '1') return { counts: true, why: null }
  if (userDataFlag) return { counts: false, why: 'sandbox' }
  return packaged ? { counts: true, why: null } : { counts: false, why: 'development' }
}
export interface LedgerDeps {
  files: Pick<StatsFiles, 'load' | 'save' | 'saveMeta' | 'idle' | 'flushSync' | 'removeMonthsNotOf'>
  now(): number
  mono(): number
  every(fn: () => void, ms: number): { stop(): void }
  windowOpen(): boolean
  newId(): string
  onChange(view: StatsView): void
}
export class StatsLedger {
  private deps: LedgerDeps
  private meta: StatsLedgerMeta | null = null
  private months = new Map<string, StatsMonth>()
  private dirty = new Set<string>()
  private timer: { stop(): void } | null = null
  private started: Promise<void> | null = null
  private stopped = false
  private resetting = false
  private suspended = false
  private window = false
  private wall = 0
  private mono = 0
  private sample: { wall: number; mono: number } | null = null
  private revision = 0
  private backfill: StatsView['backfill'] = { filesDone: 0, filesTotal: 0 }
  private skipped = 0
  constructor(deps: LedgerDeps) { this.deps = deps }
  start(): Promise<void> {
    if (this.started) return this.started
    this.started = this.load()
    return this.started
  }
  ready(): Promise<void> { return this.started ?? Promise.reject(new Error('Stats has not started.')) }
  private async load(): Promise<void> {
    const loaded = await this.deps.files.load()
    const now = this.deps.now()
    let meta = loaded.meta
    if (meta) await this.deps.files.removeMonthsNotOf(meta.id)
    else if (loaded.months.length) {
      const newest = [...loaded.months].sort((a, b) => b.month.localeCompare(a.month))[0]
      const days = loaded.months.filter(m => m.computer === newest.computer).flatMap(m => Object.entries(m.days)).filter(([, d]) => d.openMs > 0).map(([day]) => day).sort()
      meta = { v: 1, id: newest.computer, createdAt: now, countingSince: days.length ? dayStartMs(days[0]) : now, countFrom: 0, agentStore: null }
      await this.deps.files.saveMeta(meta)
    } else {
      meta = { v: 1, id: this.deps.newId(), createdAt: now, countingSince: now, countFrom: 0, agentStore: null }
      await this.deps.files.saveMeta(meta)
    }
    this.meta = meta
    for (const month of loaded.months) if (month.computer === meta.id) this.months.set(month.month, month)
    if (this.stopped) return
    this.wall = this.deps.now(); this.mono = this.deps.mono(); this.window = this.deps.windowOpen()
    this.timer = this.deps.every(() => this.tick(), STATS_TICK_MS)
  }
  private day(day: string): StatsDay {
    const key = monthOf(day)
    let month = this.months.get(key)
    if (!month) { month = { v: 1, computer: this.meta!.id, month: key, days: {} }; this.months.set(key, month) }
    return month.days[day] ?? (month.days[day] = emptyDay())
  }
  private book(end: number, duration: number, field: 'openMs' | 'busyMs', multiplier = 1): void {
    for (const piece of cutByQuarterHour(end - duration, end)) {
      const d = this.day(piece.day), elapsed = piece.endMs - piece.startMs
      d.local ??= { openH: Array(24).fill(0), busyH: Array(24).fill(0), agentH: Array(24).fill(0) }
      d[field] += elapsed
      if (field === 'openMs') d.local.openH[piece.hour] += elapsed
      else { d.agentMs += elapsed * multiplier; d.local.busyH[piece.hour] += elapsed; d.local.agentH[piece.hour] += elapsed * multiplier }
      this.dirty.add(monthOf(piece.day))
    }
  }
  private bookTail(): void {
    const wall = this.deps.now(), mono = this.deps.mono()
    if (this.meta && !this.suspended && this.window) {
      const dt = Math.max(0, Math.min(wall - this.wall, mono - this.mono, TICK_CAP_MS))
      if (dt) this.book(wall, dt, 'openMs')
    }
    this.wall = wall; this.mono = mono
  }
  private publish(): void { this.revision++; this.deps.onChange(this.view()) }
  private save(): void { for (const key of this.dirty) { const month = this.months.get(key); if (month) this.deps.files.save(month) }; this.dirty.clear() }
  tick(): void {
    if (!this.meta || this.stopped || this.resetting) return
    const wasSuspended = this.suspended
    this.bookTail(); this.suspended = false; this.window = this.deps.windowOpen()
    if (wasSuspended) this.sample = null
    this.save(); this.publish()
  }
  mark(): void { if (!this.meta || this.stopped || this.resetting) return; this.bookTail(); this.window = this.deps.windowOpen(); this.sample = null }
  suspend(): void { if (!this.meta || this.stopped || this.resetting) return; this.bookTail(); this.suspended = true; this.sample = null }
  resume(): void { if (!this.meta || this.stopped || this.resetting) return; this.wall = this.deps.now(); this.mono = this.deps.mono(); this.suspended = false; this.sample = null; this.window = this.deps.windowOpen() }
  sampleAgents(working: number): void {
    if (!this.meta || this.stopped || this.resetting || this.suspended) return
    const wall = this.deps.now(), mono = this.deps.mono()
    if (this.sample && working >= 1) {
      const dt = Math.max(0, Math.min(wall - this.sample.wall, mono - this.sample.mono, SAMPLE_CAP_MS))
      if (dt) this.book(wall, dt, 'busyMs', Math.floor(working))
    }
    this.sample = { wall, mono }
  }
  quitFlush(): void { if (this.stopped) return; if (this.meta) this.bookTail(); this.stopped = true; this.timer?.stop(); if (this.meta) { this.save(); this.deps.files.flushSync() } }
  planInputs(): { ledger: string; countFromMs: number; timeBeforeMs: number } | null { return this.meta ? { ledger: this.meta.id, countFromMs: this.meta.countFrom, timeBeforeMs: this.meta.countingSince } : null }
  applyPass(result: StatsPassResult): void {
    if (!this.meta || result.ledger !== this.meta.id || this.resetting || this.stopped) return
    const same = this.meta.agentStore === result.storeId
    for (const incoming of result.months) {
      const current = this.months.get(incoming.month)
      const days = new Set([...Object.keys(current?.days ?? {}), ...Object.keys(incoming.days)])
      for (const key of days) {
        const day = this.day(key), next = incoming.days[key]
        for (const field of AGENT_FIELDS) day[field] = same ? (next?.[field] ?? 0) : Math.max(day[field], next?.[field] ?? 0)
      }
      this.dirty.add(incoming.month)
    }
    this.meta.agentStore = result.storeId
    void this.deps.files.saveMeta({ ...this.meta }).catch(() => {})
    this.backfill = result.filesPending ? { filesDone: result.filesTotal - result.filesPending, filesTotal: result.filesTotal } : null
    this.skipped = result.skipped; this.save(); this.publish()
  }
  async reset(): Promise<StatsResetResult> {
    if (this.resetting) return { ok: false, message: 'Stats are already being reset.' }
    this.resetting = true
    try {
      await this.deps.files.idle()
      const now = this.deps.now()
      const meta: StatsLedgerMeta = { v: 1, id: this.deps.newId(), createdAt: now, countingSince: now, countFrom: now, agentStore: null }
      await this.deps.files.saveMeta(meta)
      this.meta = meta; this.months.clear(); this.dirty.clear(); this.backfill = { filesDone: 0, filesTotal: 0 }; this.skipped = 0
      this.wall = now; this.mono = this.deps.mono(); this.sample = null; this.window = this.deps.windowOpen()
      await this.deps.files.removeMonthsNotOf(meta.id)
      this.publish(); return { ok: true, view: this.view() }
    } catch { return { ok: false, message: 'Stats could not be reset. Check the storage location and try again.' } }
    finally { this.resetting = false }
  }
  view(): StatsView {
    const meta = this.meta
    return buildStatsView({ revision: this.revision, now: this.deps.now(), counting: !!meta, why: null, computers: meta ? [{ id: meta.id, label: 'This computer', self: true, removed: false, slot: 1, countingSince: meta.countingSince, countFrom: meta.countFrom, lastSyncedAt: null, months: [...this.months.values()] }] : [], backfill: this.backfill, skipped: this.skipped })
  }
}
