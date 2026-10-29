import type { StatsPassResult } from '../../shared/stats.ts'
import type { StatsPlan } from './pass.ts'

export const STATS_PASS_BOOT_MS = 45_000
export const STATS_PASS_EVERY_MS = 600_000
export const STATS_PASS_READ_FLOOR_MS = 30_000
export const STATS_PASS_CATCHUP_MS = 5_000
export const STATS_PASS_BUDGET_MS = 20_000
export interface SchedulerDeps {
  run(plan: StatsPlan): Promise<StatsPassResult | null>
  plan(reportAll: boolean): StatsPlan | null
  apply(result: StatsPassResult): void
  after(fn: () => void, ms: number): { cancel(): void }
  now(): number
  onError(err: Error): void
}
export class StatsPassScheduler {
  private deps: SchedulerDeps
  private timer: { cancel(): void } | null = null
  private started = false
  private stopped = false
  private running = false
  private queued = false
  private first = true
  private lastAt: number | null = null
  constructor(deps: SchedulerDeps) { this.deps = deps }
  private arm(ms: number): void {
    this.timer?.cancel()
    if (!this.stopped) this.timer = this.deps.after(() => { this.timer = null; this.runNow() }, ms)
  }
  start(): void { if (this.started || this.stopped) return; this.started = true; this.arm(STATS_PASS_BOOT_MS) }
  onRead(): void { if (!this.stopped && !this.running && (this.lastAt === null || this.deps.now() - this.lastAt >= STATS_PASS_READ_FLOOR_MS)) this.runNow() }
  runNow(): void {
    if (this.stopped) return
    if (this.running) { this.queued = true; return }
    const plan = this.deps.plan(this.first)
    if (!plan) { this.arm(STATS_PASS_CATCHUP_MS); return }
    this.running = true; this.lastAt = this.deps.now(); this.arm(STATS_PASS_EVERY_MS)
    void this.deps.run(plan).then(result => {
      if (this.stopped || !result) return
      this.deps.apply(result)
      this.first = false
      if (result.filesPending > 0) this.arm(STATS_PASS_CATCHUP_MS)
    }).catch(error => { if (!this.stopped) this.deps.onError(error instanceof Error ? error : new Error(String(error))) }).finally(() => {
      this.running = false
      if (this.queued && !this.stopped) { this.queued = false; this.runNow() }
    })
  }
  stop(): void { this.stopped = true; this.queued = false; this.timer?.cancel(); this.timer = null }
}
