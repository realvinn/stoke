import './suite-tmpdir.mts'
import { dayKey as activityDayKey } from '../src/main/activity.ts'
import { addDays, addMonths, cutByQuarterHour, dayKey, dayLengthMs, dayStartMs, monthDays } from '../src/shared/localDay.ts'
import { idFromBytes, isId } from '../src/shared/hub/codec.ts'
import { buildStatsView, emptyDay, formatHours, formatLines, isActiveDay, parseStatsMonth, statsBuckets, statsTiles, streakOf, syncedMonth, type StatsMonth } from '../src/shared/stats.ts'
import { nearestColumn, statsChartLayout } from '../src/shared/statsChart.ts'
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import * as asyncFs from 'node:fs/promises'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { StatsFiles } from '../src/main/stats/files.ts'
import { SAMPLE_CAP_MS, STATS_TICK_MS, StatsLedger, TICK_CAP_MS, statsCountsHere } from '../src/main/stats/ledger.ts'
import { STATS_PASS_BOOT_MS, STATS_PASS_CATCHUP_MS, STATS_PASS_EVERY_MS, StatsPassScheduler } from '../src/main/stats/schedule.ts'
import type { StatsPlan } from '../src/main/stats/pass.ts'

let failures = 0
function check(label: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`)
}
function inZone(zone: string, fn: () => void): void {
  const before = process.env.TZ
  process.env.TZ = zone
  try { fn() } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before }
}
const local = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime()

check('activity uses the shared local day', activityDayKey === dayKey, true)
inZone('Australia/Melbourne', () => {
  check('DST days retain their real lengths', ['2026-10-04', '2026-04-05', '2026-10-28'].map(dayLengthMs), [82_800_000, 90_000_000, 86_400_000])
  check('midnight splits the interval', cutByQuarterHour(local(2026, 10, 27, 23, 59), local(2026, 10, 28, 0, 1)).map(p => [p.day, p.endMs - p.startMs, p.hour]), [['2026-10-27', 60_000, 23], ['2026-10-28', 60_000, 0]])
  const two = dayStartMs('2026-04-05') + 2 * 3_600_000
  check('both repeated hours have the same label', [...new Set(cutByQuarterHour(two, two + 2 * 3_600_000).map(p => p.hour))], [2])
})

inZone('America/Santiago', () => check('a day can start at 1am', [new Date(dayStartMs('2026-09-06')).getHours(), dayLengthMs('2026-09-06')], [1, 82_800_000]))
inZone('Asia/Kathmandu', () => check('quarter-hour offset still cuts midnight', cutByQuarterHour(local(2026, 10, 27, 23, 50), local(2026, 10, 28, 0, 10))[0].endMs, dayStartMs('2026-10-28')))
check('calendar arithmetic', [addMonths('2026-01', -1), monthDays('2026-02').length, monthDays('2028-02').length, addDays('2026-12-31', 1)], ['2025-12', 28, 29, '2027-01-01'])
check('empty and backwards intervals', [cutByQuarterHour(5, 5), cutByQuarterHour(9, 5)], [[], []])

const id = idFromBytes('stats', new Uint8Array(10).fill(1))
const month: StatsMonth = { v: 1, computer: id, month: '2026-10', days: { '2026-10-21': { ...emptyDay(), added: 120, local: { openH: Array(24).fill(1), busyH: Array(24).fill(0), agentH: Array(24).fill(0) } } } }
check('stats ids have their own namespace', isId('stats', id) && /^s[0-9a-hjkmnp-tv-z]{16}$/.test(id), true)
check('month round trip', parseStatsMonth(JSON.parse(JSON.stringify(month))), month)
check('missing fields default to zero', parseStatsMonth({ ...month, days: { '2026-10-21': { added: 2, ignored: 5 } } })?.days['2026-10-21'], { ...emptyDay(), added: 2 })
check('invalid records are refused', [{ ...month, v: 2 }, { ...month, computer: idFromBytes('device', new Uint8Array(10)) }, { ...month, days: { '2026-10-32': {} } }, { ...month, days: { '2026-10-21': { added: -1 } } }, { ...month, days: { '2026-10-21': { openMs: NaN } } }].map(parseStatsMonth), [null, null, null, null, null])
check('sync drops local buckets', [JSON.stringify(syncedMonth(month)).includes('local'), syncedMonth(month).days['2026-10-21'].added], [false, 120])
check('open time alone is not agent work', [isActiveDay({ ...emptyDay(), openMs: 5 }), isActiveDay({ ...emptyDay(), prompts: 1 })], [false, true])
const dir = await mkdtemp(join(tmpdir(), 'stats-files-'))
const files = new StatsFiles(dir)
await writeFile(join(dir, 'bystander'), 'keep')
files.save(month)
await files.idle()
check('saved month reloads from disk', (await files.load()).months, [month])
await writeFile(join(dir, '2026-09.json'), '{broken')
const loaded = await files.load()
check('corrupt month is set aside without touching a bystander', [loaded.setAside, await readFile(join(dir, 'bystander'), 'utf8'), (await readdir(dir)).some(n => n.startsWith('2026-09.json.bad-'))], [['2026-09.json'], 'keep', true])
const raceDir = await mkdtemp(join(tmpdir(), 'stats-race-'))
let releaseRename!: () => void
let renameStarted!: () => void
const renameWait = new Promise<void>(resolve => { releaseRename = resolve })
const renameEntered = new Promise<void>(resolve => { renameStarted = resolve })
const io = { ...asyncFs, mkdirSync, renameSync, rmSync, writeFileSync, rename: async (from: Parameters<typeof asyncFs.rename>[0], to: Parameters<typeof asyncFs.rename>[1]) => { renameStarted(); await renameWait; await asyncFs.rename(from, to) } }
const racing = new StatsFiles(raceDir, io)
racing.save(month)
await renameEntered
const newer = { ...month, days: { ...month.days, '2026-10-21': { ...month.days['2026-10-21'], added: 456 } } }
racing.save(newer)
racing.flushSync()
releaseRename()
await racing.idle()
check('quit recovery wins even if an older rename finishes later', (await racing.load()).months[0].days['2026-10-21'].added, 456)
const ledgerFiles = new StatsFiles(await mkdtemp(join(tmpdir(), 'stats-ledger-')))
let wall = local(2026, 10, 28, 14, 1), mono = 1000, windowOpen = true, clockInterval = 0
const ids = [idFromBytes('stats', new Uint8Array(10).fill(9)), idFromBytes('stats', new Uint8Array(10).fill(10))]
const ledger = new StatsLedger({ files: ledgerFiles, now: () => wall, mono: () => mono, every: (_fn, ms) => { clockInterval = ms; return { stop: () => {} } }, windowOpen: () => windowOpen, newId: () => ids.shift()!, onChange: () => {} })
await ledger.start()
check('counting is limited to the installed app and explicit test seam', [statsCountsHere(true, false, undefined), statsCountsHere(true, true, undefined), statsCountsHere(false, false, '1')], [{ counts: true, why: null }, { counts: false, why: 'sandbox' }, { counts: true, why: null }])
check('booking caps and timer cadence', [TICK_CAP_MS, SAMPLE_CAP_MS, clockInterval], [120_000, 2_000, STATS_TICK_MS])
wall += 60_000; mono += 60_000; ledger.tick()
check('an open window books elapsed time', ledger.view().computers[0].days.at(-1)!.openMs, 60_000)
ledger.sampleAgents(2)
wall += 1000; mono += 1000; ledger.sampleAgents(2)
check('agent samples distinguish busy and total time', [ledger.view().computers[0].days.at(-1)!.busyMs, ledger.view().computers[0].days.at(-1)!.agentMs], [1000, 2000])
ledger.suspend(); wall += 40 * 3_600_000; mono += 40 * 3_600_000; ledger.resume(); ledger.tick()
check('sleep is not booked', ledger.view().computers[0].days.at(-1)!.openMs, 0)
windowOpen = false; ledger.mark(); wall += 60_000; mono += 60_000; ledger.tick()
check('a closed window does not book open time', ledger.view().computers[0].days.at(-1)!.openMs, 0)
const reset = await ledger.reset()
check('reset starts a new ledger and discards prior counts', [reset.ok, ledger.planInputs()?.countFromMs, ledger.view().computers[0].days.at(-1)!.openMs], [true, wall, 0])
ledger.quitFlush()
let scheduled: { fn: () => void; ms: number } | null = null
let scheduleNow = 0
const runs: boolean[] = []
const scheduler = new StatsPassScheduler({
  plan: reportAll => ({ reportAll } as StatsPlan),
  run: async plan => { runs.push(plan.reportAll); return { ledger: id, storeId: 'test', months: [], filesTotal: 1, filesPending: runs.length === 1 ? 1 : 0, skipped: 0, bytesRead: 0, stoppedBy: null, ms: 0 } },
  apply: () => {}, after: (fn, ms) => { const timer = { fn, ms }; scheduled = timer; return { cancel: () => { if (scheduled === timer) scheduled = null } } }, now: () => scheduleNow, onError: () => { failures++ }
})
scheduler.start()
check('Stats first pass is scheduled after boot', scheduled!.ms, STATS_PASS_BOOT_MS)
scheduled!.fn(); await new Promise(resolve => setImmediate(resolve))
check('a partial pass schedules a short catch-up', [runs, scheduled!.ms], [[true], STATS_PASS_CATCHUP_MS])
scheduleNow += STATS_PASS_CATCHUP_MS; scheduled!.fn(); await new Promise(resolve => setImmediate(resolve))
check('a completed pass resumes the periodic schedule', [runs, scheduled!.ms], [[true, false], STATS_PASS_EVERY_MS])
scheduler.stop()

inZone('Australia/Melbourne', () => {
  const oct: StatsMonth = { v: 1, computer: id, month: '2026-10', days: {
    '2026-10-20': { ...emptyDay(), openMs: 3_600_000, busyMs: 600_000, agentMs: 600_000, estBusyMs: 1_200_000, estAgentMs: 1_800_000, added: 50 },
    '2026-10-21': { ...emptyDay(), openMs: 86_400_000, busyMs: 3_600_000, agentMs: 7_200_000, added: 120, removed: 4 },
    '2026-10-27': { ...emptyDay(), openMs: 600_000, busyMs: 60_000, agentMs: 60_000, prompts: 2 },
    '2026-10-28': { ...emptyDay(), openMs: 18_000_000, busyMs: 600_000, agentMs: 600_000, prompts: 1 }
  } }
  const sept: StatsMonth = { v: 1, computer: id, month: '2026-09', days: { '2026-09-10': { ...emptyDay(), estBusyMs: 3_600_000, estAgentMs: 3_600_000, added: 30, prompts: 1 } } }
  const computer = { id, label: 'This computer', self: true, removed: false, slot: 1, countingSince: local(2026, 10, 20, 9), countFrom: 0, lastSyncedAt: null, months: [sept, oct] }
  const input = { revision: 7, now: local(2026, 10, 28, 14, 2), counting: true, why: null, computers: [computer], backfill: null, skipped: 0 }
  const view = buildStatsView(input)
  const day = (key: string) => view.computers[0].days.find(d => d.day === key)!
  const buckets = statsBuckets(view, '30d')
  const cell = (key: string) => buckets.find(b => b.key === key)!.cells[0]
  check('view range and nullable pre-counting days', [view.today, view.computers[0].days[0].day, day('2026-10-19').openMs, day('2026-10-22').openMs, day('2026-09-09').added], ['2026-10-28', '2025-11-01', null, 0, null])
  check('live and transcript estimates are combined', [day('2026-10-20').busyMs, day('2026-10-20').agentMs, day('2026-10-20').timeFrom], [1_800_000, 2_400_000, 'mixed'])
  check('reset sets the beginning of backfill', buildStatsView({ ...input, computers: [{ ...computer, countFrom: local(2026, 10, 25, 8) }] }).computers[0].linesSince, '2026-10-25')
  check('ranges and empty states', [statsBuckets(view, '7d').length, buckets.length, statsBuckets(view, '12mo').length, cell('2026-10-22').open, cell('2026-10-01').open], [7, 30, 12, 'off', 'not-counting'])
  const tiles = statsTiles(view, buckets)
  check('tiles sum visible days', [tiles.openMs, tiles.busyMs, tiles.agentMs, tiles.atOnce, tiles.added, tiles.removed], [108_600_000, 6_060_000, 10_260_000, 1.7, 170, 4])
  check('streak retains yesterday while today is empty', [view.streak, streakOf(new Set(['2026-10-26', '2026-10-27']), '2026-10-28')], [{ current: 2, best: 2 }, { current: 2, best: 2 }])
  check('formatted figures', [[0, 2_700_000, 16_200_000, 345_600_000].map(n => formatHours(n, 'en-US')), [9_543, 11_000, 1_250_000].map(n => formatLines(n, 'en-US'))], [['0 h', '45 min', '4.5 h', '96 h'], ['9,543', '11k', '1.3M']])
  const box = { width: 316, height: 180, gutter: 32, foot: 18 }
  const chart = statsChartLayout(buckets, 'open', 1, box)
  const lines = statsChartLayout(buckets, 'lines', 1, box)
  check('chart columns and axes', [chart.columns.length, chart.yMax, chart.gridlines.map(g => g.value), lines.yMax, lines.gridlines.map(g => g.value)], [30, 24, [24], 150, [50, 100, 150]])
  check('full day fills the plot', chart.columns.find(c => c.key === '2026-10-21')!.segments[0].h, 162)
  check('pointer selection clamps to columns', [nearestColumn(chart, -1), nearestColumn(chart, 10000)], [0, 29])
})

console.log(failures ? `\n${failures} failure(s)` : '\nall pass')
process.exitCode = failures ? 1 : 0
