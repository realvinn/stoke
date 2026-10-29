import { app, powerMonitor } from 'electron'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { idFromBytes } from '../shared/hub/codec.ts'
import { buildStatsView, type StatsResetResult, type StatsView } from '../shared/stats.ts'
import type { SourceEnv } from './chatIndex/sources.ts'
import type { StatsPlan } from './stats/pass.ts'
import type { StatsPassResult } from '../shared/stats.ts'
import { StatsFiles } from './stats/files.ts'
import { StatsLedger, statsCountsHere } from './stats/ledger.ts'
import { STATS_PASS_BUDGET_MS, StatsPassScheduler } from './stats/schedule.ts'

export interface StatsHandle { view(): Promise<StatsView>; reset(): Promise<StatsResetResult>; sampleAgents(working: number): void; quitFlush(): void; onRead(): void }
export function installStats(deps: { windowOpen(): boolean; push(view: StatsView): void; runPass(plan: StatsPlan): Promise<StatsPassResult | null>; env(): SourceEnv; codexHomes(): string[] }): StatsHandle | null {
  try {
    const files = new StatsFiles(join(app.getPath('userData'), 'stats'))
    const mode = statsCountsHere(app.isPackaged, app.commandLine.hasSwitch('user-data-dir'), process.env.STOKE_TEST_STATS_COUNT)
    if (!mode.counts) {
      return {
        async view() {
          const loaded = await files.load({ readOnly: true }), meta = loaded.meta
          return buildStatsView({ revision: 0, now: Date.now(), counting: false, why: mode.why, backfill: null, skipped: 0, computers: meta ? [{ id: meta.id, label: 'This computer', self: true, removed: false, slot: 1, countingSince: meta.countingSince, countFrom: meta.countFrom, lastSyncedAt: null, months: loaded.months.filter(m => m.computer === meta.id) }] : [] })
        },
        async reset() { return { ok: false, message: 'Only the installed Stoke counts stats, so there is nothing to reset here.' } },
        sampleAgents() {}, quitFlush() {}, onRead() {}
      }
    }
    const ledger = new StatsLedger({ files, now: Date.now, mono: () => performance.now(), every: (fn, ms) => { const timer = setInterval(fn, ms); timer.unref(); return { stop: () => clearInterval(timer) } }, windowOpen: deps.windowOpen, newId: () => idFromBytes('stats', randomBytes(10)), onChange: deps.push })
    void ledger.start().catch(error => console.error('[stoke] stats:', error))
    const scheduler = new StatsPassScheduler({
      run: deps.runPass,
      plan: reportAll => { const inputs = ledger.planInputs(); return inputs ? { ...inputs, env: deps.env(), codexHomes: deps.codexHomes(), reportAll, budgetMs: STATS_PASS_BUDGET_MS } : null },
      apply: result => ledger.applyPass(result),
      after: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref(); return { cancel: () => clearTimeout(timer) } },
      now: Date.now,
      onError: error => console.error('[stoke] stats pass:', error.message)
    })
    scheduler.start()
    powerMonitor.on('suspend', () => ledger.suspend())
    powerMonitor.on('resume', () => ledger.resume())
    app.on('browser-window-created', (_event, window) => { setImmediate(() => ledger.mark()); window.on('session-end', () => handle.quitFlush()); window.on('closed', () => setImmediate(() => ledger.mark())) })
    app.on('window-all-closed', () => ledger.mark())
    const handle: StatsHandle = {
      async view() { await ledger.ready(); return ledger.view() },
      async reset() { await ledger.ready(); const result = await ledger.reset(); if (result.ok) scheduler.runNow(); return result },
      sampleAgents: count => ledger.sampleAgents(count),
      quitFlush: () => { scheduler.stop(); ledger.quitFlush() },
      onRead: () => scheduler.onRead()
    }
    return handle
  } catch (error) { console.error('[stoke] stats:', error); return null }
}
