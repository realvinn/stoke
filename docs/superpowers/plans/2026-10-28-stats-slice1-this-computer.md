# Stats, slice 1 (this computer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Count, on this computer, the hours Stoke is open, the time agents work and the lines Claude Code and Codex write (back-filled from the transcripts still on disk), and show them in a new Stats tab, first in the side dock.

**Architecture:** Main keeps the ledger in `<userData>/stats/` (`ledger.json` plus one `StatsMonth` file per month), booking Stoke-open time from a once-a-minute tick and agent time from the existing one-second registry poll. The chat-index worker gains a `statsPass` op, the only transcript reader for this feature: it folds Claude Code and Codex transcripts incrementally into its own `stats/agents.sqlite` and returns per-day totals, which main writes into the month files. A pure `src/shared` layer turns any number of computers' months into the `StatsView` the dock tab draws (tiles, a stacked-column SVG chart with one computer in it, a table), so slice 2 hands the same function other computers' months.

**Tech Stack:** Electron 43 main and `node:worker_threads`; `node:sqlite` and `node:zlib` zstd in the worker only; React 19 with hand-drawn SVG; CSS custom properties; Node strip-types `.mts` suites and one Electron window suite.

**Spec:** `docs/superpowers/specs/2026-10-28-stats-design.md`. This plan is its §5 slice 1. Figures credited to "the scouts" are this Mac's read-only measurements of 2026-10-28, behind the spec.

## Global Constraints

- The tick: `STATS_TICK_MS = 60_000`, one process-wide `unref`'d timer. One booking is at most `TICK_CAP_MS = 120_000`: "Each tick books at most 2 minutes, so a crash or a missed sleep can never add hours".
- Stoke open = an app window exists (`appWindows().length > 0`) and the computer is awake. Sleep is not counted. A locked screen is counted (there is no lock listener).
- Agents working is sampled inside the existing 1 s registry interval, at most `SAMPLE_CAP_MS = 2_000` per sample. A tab is working only when `status === 'busy'` (never `LiveSessionState.busy`) and its pty is live, ordinary and not private. Busy time is the union over tabs, agent time the sum, "× at once" their ratio.
- Only the installed app counts: `app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')`, or an unpackaged run with `STOKE_TEST_STATS_COUNT=1`. Any other copy books nothing, runs no transcript pass and creates nothing under `stats/`.
- Each computer books its own local day (`dayKey`), cut at UTC quarter-hours. A day is its own length (23, 24 or 25 h), never `86_400_000`. The chart adds days by date label, and main says what "today" is.
- Uptime starts the day this ships. Lines and agent time are back-filled from the surviving transcripts of every Claude Code and Codex session on the computer, including ones started outside Stoke (approved).
- The wording is "Lines by agents", never "lines in your repo" or "lines of code".
- Each edit counts once, by its tool-call id (Claude `tool_use.id`, Codex `item.id`). `api-request*` records are never read. Subagent and workflow transcripts are included. A whole-file write counts every line it wrote. "Removed" is the smaller second figure.
- Never counted: hand typing; `Bash`/`exec` writes (sed, scripts, codegen); other agents; private chats (`isPrivateProjectDir` on the listing, `!private` on the sampler); `userData/ssh-transcripts`; Claude Cowork.
- The ledger lives in `<userData>/stats/` (folder 0700, files 0600), never in `settings.json` (gotcha 63). Main writes only `ledger.json` and `YYYY-MM.json`; the worker writes only `agents.sqlite`.
- The chat-index worker is the only reader of transcripts. Main never opens one for stats and never imports `node:sqlite`, `rules.ts`, `store.ts` or `pass.ts` except as `import type` (gotcha 40).
- No sync fs at boot and no eager heavy import in main (gotcha 40): the ledger loads async, and only `quitFlush` writes synchronously.
- In `src/main`: relative imports carry `.ts`; no TypeScript parameter properties; IPC names go into `src/shared/ipc.ts` first.
- `src/shared/*.ts` has no `node:` import and no DOM (gotcha 27). Suites import `src/shared` and the electron-free `src/main/stats/*` modules by relative `.ts` paths only (gotcha 78).
- Claim before the first `await`, and say whose the claim is (gotchas 20, 51, 66). That covers Reset, passes and the Settings button.
- Colour goes only through CSS custom properties: `--series-1`…`--series-4`, `--series-other`, `--chart-grid`. No hex in a component or a stylesheet rule. Accent strokes use `--accent-ink` (gotcha 44). No `themes.ts` literal moves (gotcha 43).
- The Stats tab is a dock column, and nothing in it floats (gotcha 14); its readout sits in the panel's flow. It has no motion (gotcha 72), and the table is a `<details>` (gotcha 137).
- The Stats panel root and the dock's tab row stop plain keys. Otherwise `typeThroughKey` types Enter, Space and letters into the session in front, and the button never runs.
- A Settings row needs a `data-setting` mark and a `SETTING_ROWS` entry (gotcha 138). Settings opens by id through `resolveSettingsTarget` (App's `openSettings`).
- Suites:
  - Each joins `package.json`'s `check` chain and CLAUDE.md's list (gotcha 62), and its tally and `process.exitCode` are the file's last statements (gotcha 50).
  - `import './suite-tmpdir.mts'` is the first import of any node suite that writes files (gotcha 74). Fake every input, and assert the shipped constants (gotcha 175).
  - Every real timer gets an override (gotcha 174). A window suite pins reduced motion and bounds its polls and captures (gotcha 161).
- Tests and the driven proof use synthetic transcripts under a scratch HOME. Never the owner's `~/.claude` or `~/.codex`, and never a real `claude` or `codex` (gotchas 112, 128, 133).
- Find code by name, never by line number. `index.ts`, `ipc.ts`, `api.ts`, `preload/index.ts`, `theme.ts`, `app.css`, `CLAUDE.md` and `package.json` carry another session's uncommitted Work-mode edits; never revert or reformat them.
- Agents working in this shared tree never commit. The lead commits each task's hunks (`git add -p` on shared files) once the whole slice passes `npm run check`.

## Review Focus

1. **A DST night, or a clock change while Stoke runs** (NTP after a wake, a manual change, travel). No hour may be lost or doubled beyond one tick: a fall-back day can hold 25 h, a backward jump books nothing for that tick, and "today" is main's. Its test: Task 7, `clock jumps and DST`.
2. **Sleep longer than a day, or a suspend whose resume never comes.** The slept days read "off", at most one capped tick is booked across the gap, and counting carries on at the next tick. Its test: Task 7, `long sleep and missed events`.
3. **Two transcripts holding the same edit:** a resume, a fork, a `continued-in` copy, or a Codex thread that was `.jsonl` and is now `.jsonl.zst`. Each edit is counted once. Its tests: Task 8, `the same edit in two files`, and Task 10, `zst handover`.
4. **A huge first back-fill on a slow disk** (gigabytes, 12 MB lines). Stoke stays responsive. A pass stops at its budget, reads newest first and resumes mid-file next time, and the final totals equal one unbudgeted pass. Meanwhile the tab says "Counting your history…". Its test: Task 10, `budgeted back-fill`.
5. **A torn or malformed transcript line** (the CLI mid-append, truncated JSON, a byte that is not UTF-8). An unfinished last line is not consumed, and it counts once when it is finished. A bad line is skipped, and nothing throws. Its test: Task 10, `torn and bad lines`.

## The slice-2 contract (how other computers' months are summed with no format change)

1. A month file is a `StatsMonth`: `{ v: 1, computer, month, days }`.
   - `computer` is the LEDGER id, `s` plus 16 lowercase Crockford characters. It is never the hub device id, which a sign-out changes (gotcha 143).
   - Every top-level day number is additive across days and computers. Everything local-only sits under `local`.
2. Slice 2 seals `syncedMonth(m)` as `t6/stats/<computer>/<YYYY-MM>`. That function is a key filter: it drops `local` and nothing else. `parseItemPath` validates the id with `isId('stats', …)`, which Task 2 adds to `codec.ts`.
3. Other computers' months are cached in the same shape at `stats/peers/<ledgerId>/<YYYY-MM>.json`, beside an `about.json`. None of slice 1's files move.
4. `buildStatsView` already takes `computers: StatsComputerInput[]` (`self`, `removed`, `slot`, `lastSyncedAt`), and `statsBuckets` sums by date label. Task 3's `the slice-2 contract` test feeds it a peer's synced month, which has no `local`.
5. A new counter is appended to `AGENT_FIELDS` or `LIVE_FIELDS`. `parseStatsMonth` reads a missing field as 0 and ignores an unknown one.

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/localDay.ts` (new) | The local calendar: day keys, bounds and lengths of days and months, quarter-hour cuts |
| `src/shared/stats.ts` (new) | `StatsMonth`, the worker→main result, Reset's result; the view and its pure builders (buckets, tiles, streak, formatting); `workingTabs`, `codexAccountHomes` |
| `src/shared/statsChart.ts` (new) | Chart geometry: columns, stacked pieces, gridlines, hit slots |
| `src/shared/series.ts` (new) | The `--series-1…4` seeds and the dataviz validator port |
| `src/main/stats/files.ts` (new) | `StatsFiles`: async atomic writes, set-aside, the sync flush |
| `src/main/stats/ledger.ts` (new) | `StatsLedger`: booking, gates, caps, merging pass results, Reset, the view; no electron |
| `src/main/stats/schedule.ts` (new) | `StatsPassScheduler`: when transcript passes run |
| `src/main/stats/rules.ts` (new) | The counting rules: pure folds of one Claude or Codex line |
| `src/main/stats/store.ts` (new) | `StatsStore`: the worker's `agents.sqlite` |
| `src/main/stats/pass.ts` (new) | The listing, the byte-gated incremental reader, one budgeted pass |
| `src/main/stats.ts` (new) | Electron wiring: `installStats` |
| `src/renderer/src/lib/useStats.ts` (new) | Subscribe before pull; keep the highest revision |
| `src/renderer/src/components/StatsChart.tsx` (new) | The SVG chart |
| `src/renderer/src/components/StatsPanel.tsx` (new) | The Stats tab: period, tiles, metric, readout, chart, table, notes |
| `src/renderer/src/components/StatsSettings.tsx` (new) | Settings › Stats › Reset stats |
| `src/renderer/src/styles/stats.css` (new) | The Stats rules, imported by the Stats components |
| `scripts/verify-stats.mts` (new) | Node suite: the shared layer, files, ledger, scheduler, wiring pins |
| `scripts/verify-stats-transcripts.mts` (new) | Node suite: rules, store, pass, the worker op |
| `scripts/verify-stats-window.mts` (new) | Electron window suite with screenshots |
| `src/main/activity.ts` | Re-exports `dayKey` from `shared/localDay.ts` |
| `src/shared/hub/codec.ts` | The `stats` id kind (`s`, 10 bytes) |
| `src/renderer/src/lib/theme.ts` | Four literal `--series-N` writes in `applyAppearance` |
| `src/renderer/src/styles/app.css` | `--series-other` and `--chart-grid`, in both appearances |
| `src/main/chatIndex/protocol.ts`, `worker.ts`, `host.ts` | The `statsPass` op |
| `src/main/pty.ts` | `PtyManager.countsForStats` |
| `src/main/index.ts` | Install, the sampler call, the quit flush, IPC handlers, `statsDir` |
| `src/shared/ipc.ts`, `src/preload/index.ts`, `src/shared/api.ts` | `stats:read`, `stats:changed`, `stats:reset` |
| `src/shared/settingsIndex.ts`, `src/renderer/src/components/SettingsSheet.tsx` | The `stats` page and its row |
| `src/renderer/src/components/WorkDock.tsx`, `TitleBar.tsx`, `App.tsx` | Stats first and the default; the tooltip; the Settings link |
| `scripts/verify-theme-gen.mts`, `verify-hub.mts`, `verify-settings-search.mts`, `verify-activity.mts` | New checks |
| `package.json`, `CLAUDE.md`, `ARCHITECTURE.md` | Suites, a Layout line, the file map, the suite list, a Stats section |

---

### Task 1: Local days

**Files:**
- Create: `src/shared/localDay.ts`, `scripts/verify-stats.mts`
- Modify: `src/main/activity.ts`. Its `dayKey` becomes a re-export from `../shared/localDay.ts`; `verify:activity` must stay green.
- Modify: `package.json`. Add `"verify:stats": "node scripts/verify-stats.mts"`, and `npm run verify:stats` in `check` right after `verify:activity`.
- Modify: `CLAUDE.md`'s suite list (`activity, stats, worklog-gate`), and `ARCHITECTURE.md` (a file-map line, and a Testing line for `verify:stats`).
- Test: `scripts/verify-stats.mts`

**Interfaces:**
- Consumes: nothing.
- Produces (`src/shared/localDay.ts`):
```ts
export const QUARTER_HOUR_MS = 900_000
export function dayKey(ms: number): string               // local 'YYYY-MM-DD', activity.ts's body unchanged
export function dayStartMs(day: string): number          // new Date(y, m - 1, d).getTime(): the day's first real instant
export function dayLengthMs(day: string): number         // dayStartMs(next day) - dayStartMs(day)
export function addDays(day: string, n: number): string
export function monthOf(day: string): string             // 'YYYY-MM'
export function addMonths(month: string, n: number): string
export function monthDays(month: string): string[]       // every day key of the month, in order
export function monthLengthMs(month: string): number
export interface DayPiece { startMs: number; endMs: number; day: string; hour: number }
export function cutByQuarterHour(startMs: number, endMs: number): DayPiece[]
```

- [ ] **Step 1: Write the failing test.** Create `scripts/verify-stats.mts`.
  - Its first import is `import './suite-tmpdir.mts'`.
  - Helpers: `section(name)`; `check(label, got, want)`, which compares key-sorted JSON so that a rebuilt object's key order never matters, and `ok(label, cond)`, both printing PASS/FAIL as verify-theme-gen does; `local(y, mo, d, h = 0, mi = 0)`, which is `new Date(y, mo - 1, d, h, mi).getTime()`; and `inZone(tz, fn)`, which sets `process.env.TZ` and restores it.
  - The file ends with these two statements, and every later task adds its section above them:
    `console.log(failures ? \`\n${failures} failure(s)\` : '\nall pass')` and `process.exitCode = failures ? 1 : 0`.

```ts
section('local days')
check('activity re-exports the same dayKey', activityDayKey === dayKey, true)
inZone('Australia/Melbourne', () => {
  check('spring forward is 23 h, fall back 25 h, a plain day 24 h', ['2026-10-04', '2026-04-05', '2026-10-28'].map(dayLengthMs), [82_800_000, 90_000_000, 86_400_000])
  check('a midnight booking splits', cutByQuarterHour(local(2026, 10, 27, 23, 59), local(2026, 10, 28, 0, 1)).map(p => [p.day, p.endMs - p.startMs, p.hour]), [['2026-10-27', 60_000, 23], ['2026-10-28', 60_000, 0]])
  const two = dayStartMs('2026-04-05') + 2 * 3_600_000
  check('the repeated hour is hour 2 both times', [...new Set(cutByQuarterHour(two, two + 2 * 3_600_000).map(p => p.hour))], [2])
})
inZone('America/Santiago', () => check('a day that starts at 01:00', [new Date(dayStartMs('2026-09-06')).getHours(), dayLengthMs('2026-09-06')], [1, 82_800_000]))
inZone('Asia/Kathmandu', () => check('a +5:45 midnight is a cut', cutByQuarterHour(local(2026, 10, 27, 23, 50), local(2026, 10, 28, 0, 10)).find(p => p.day === '2026-10-27')!.endMs, dayStartMs('2026-10-28')))
check('calendar steps', [addMonths('2026-01', -1), monthDays('2026-02').length, monthDays('2028-02').length, addDays('2026-12-31', 1)], ['2025-12', 28, 29, '2027-01-01'])
check('an empty or backward interval has no pieces', [cutByQuarterHour(5, 5), cutByQuarterHour(9, 5)], [[], []])
```

- [ ] **Step 2: Run it and see it fail.** Run `npm run verify:stats`. Expected: exit 1 with `ERR_MODULE_NOT_FOUND` naming `src/shared/localDay.ts`.
- [ ] **Step 3: Implement `src/shared/localDay.ts`** to the interface above.
  - `cutByQuarterHour` steps from `startMs` to each next multiple of `QUARTER_HOUR_MS` since the epoch, and labels each piece with its start's local day and `getHours()`. Every current offset and DST jump is a whole number of quarter-hours, so no piece straddles a local midnight or hour.
  - `activity.ts` imports `dayKey` for its own use and re-exports it.
- [ ] **Step 4: Run it and see it pass.** Run `npm run verify:stats`: expected `all pass`, exit 0. Then run `npm run verify:activity`: expected `all pass`.
- [ ] **Step 5: Lead commits.** Agents in this shared tree never commit. The lead commits this task's hunks once the whole slice passes `npm run check`.

### Task 2: The month record (the on-disk contract)

**Files:**
- Create: `src/shared/stats.ts` (this task's half)
- Modify: `src/shared/hub/codec.ts` (`ID_BYTES.stats = 10`, `ID_PREFIX.stats = 's'`)
- Modify: `scripts/verify-hub.mts`, with one check beside "a host SYNC id starts with h"
- Modify: `ARCHITECTURE.md`
- Test: `scripts/verify-stats.mts`, `scripts/verify-hub.mts`

**Interfaces:**
- Consumes: `idFromBytes` and `isId` from `src/shared/hub/codec.ts`; `monthOf` (Task 1).
- Produces (`src/shared/stats.ts`):
```ts
export const LIVE_FIELDS = ['openMs', 'busyMs', 'agentMs'] as const                  // main's, booked live
export const AGENT_FIELDS = ['estBusyMs', 'estAgentMs', 'added', 'removed', 'prompts', 'sessions', 'tokensIn', 'tokensOut'] as const   // the worker's
export type LiveField = (typeof LIVE_FIELDS)[number]
export type AgentField = (typeof AGENT_FIELDS)[number]
export interface StatsDayLocal { openH: number[]; busyH: number[]; agentH: number[] }   // 24 ms buckets by local hour; never synced
export type StatsDay = Record<LiveField | AgentField, number> & { local?: StatsDayLocal }
export interface StatsMonth { v: 1; computer: string; month: string; days: Record<string, StatsDay> }   // days keyed 'YYYY-MM-DD'
export type StatsAgentDay = Record<AgentField, number>
export interface StatsAgentMonth { month: string; days: Record<string, StatsAgentDay> }
export interface StatsPassResult { ledger: string; storeId: string; months: StatsAgentMonth[]; filesTotal: number; filesPending: number; skipped: number; bytesRead: number; stoppedBy: 'time' | 'cancel' | null; ms: number }
export type StatsWhy = 'development' | 'sandbox' | null
export function emptyDay(): StatsDay
export function parseStatsMonth(raw: unknown): StatsMonth | null
export function syncedMonth(m: StatsMonth): StatsMonth
export function isActiveDay(d: StatsDay): boolean    // agent work: busyMs + estBusyMs > 0, prompts > 0 or added + removed > 0; Stoke open alone is not
```
  `estBusyMs` and `estAgentMs` are the transcript estimate of agent time, made only before `countingSince`. `tokensIn` is uncached + cache write + cache read.

- [ ] **Step 1: Write the failing test.** Add a `month record` section to verify-stats.mts. In verify-hub.mts, add `ok('a stats ledger id starts with s', isId('stats', idFromBytes('stats', bytes(10, 7))))`.

```ts
section('month record')
const A = idFromBytes('stats', new Uint8Array(10).fill(1))
ok('a ledger id is s + 16 Crockford characters', /^s[0-9a-hjkmnp-tv-z]{16}$/.test(A))
const m: StatsMonth = { v: 1, computer: A, month: '2026-10', days: { '2026-10-21': { ...emptyDay(), openMs: 86_400_000, added: 120, local: { openH: Array(24).fill(3_600_000), busyH: Array(24).fill(0), agentH: Array(24).fill(0) } } } }
check('a month round-trips', parseStatsMonth(JSON.parse(JSON.stringify(m))), m)
check('a missing field reads 0 and an unknown one is ignored', parseStatsMonth({ ...m, days: { '2026-10-21': { openMs: 5, later: 9 } } })?.days['2026-10-21'], { ...emptyDay(), openMs: 5 })
check('refused: v 2, a device id, a day outside its month, a negative or NaN count',
  [{ ...m, v: 2 }, { ...m, computer: idFromBytes('device', new Uint8Array(10)) }, { ...m, days: { '2026-11-01': emptyDay() } },
   { ...m, days: { '2026-10-21': { ...emptyDay(), added: -1 } } }, { ...m, days: { '2026-10-21': { ...emptyDay(), openMs: NaN } } }].map(parseStatsMonth), [null, null, null, null, null])
check('syncedMonth drops local and nothing else', [JSON.stringify(syncedMonth(m)).includes('local'), syncedMonth(m).days['2026-10-21'].added], [false, 120])
check('Stoke open alone is not agent work; a prompt is', [isActiveDay({ ...emptyDay(), openMs: 5 }), isActiveDay({ ...emptyDay(), prompts: 1 })], [false, true])
```

- [ ] **Step 2: Run them and see them fail.** Run `npm run verify:stats`: expected `ERR_MODULE_NOT_FOUND` for `src/shared/stats.ts`. Run `npm run verify:hub`: expected the suite to stop on `HubCodecError: an stats id takes undefined bytes`.
- [ ] **Step 3: Implement** the interface above in `src/shared/stats.ts`, and the two codec entries.
  - `parseStatsMonth` rebuilds each day from the two field lists (a whitelist, like `validateTheme`). It keeps a `local` only when all three arrays are 24 finite numbers that are 0 or more.
  - `syncedMonth` returns a deep copy without `local`.
- [ ] **Step 4: Run them and see them pass.** `npm run verify:stats` and `npm run verify:hub` both print `all pass`. The hub's pinned vectors are unchanged.
- [ ] **Step 5: Lead commits.**

### Task 3: The view (the aggregation API)

**Files:**
- Modify: `src/shared/stats.ts` (this task's half)
- Test: `scripts/verify-stats.mts`

**Interfaces:**
- Consumes: Task 1, and Task 2's types.
- Produces (`src/shared/stats.ts`):
```ts
export type StatsRange = '7d' | '30d' | '12mo'
export type StatsMetric = 'open' | 'agents' | 'lines'
export type StatsResetResult = { ok: true; view: StatsView } | { ok: false; message: string }
export interface StatsComputerInput { id: string; label: string; self: boolean; removed: boolean; slot: number; countingSince: number | null; countFrom: number; lastSyncedAt: number | null; months: readonly StatsMonth[] }
export interface StatsDayView { day: string; lengthMs: number; openMs: number | null; busyMs: number | null; agentMs: number | null; added: number | null; removed: number | null; timeFrom: 'live' | 'transcripts' | 'mixed' | null }
export interface StatsComputerView { id: string; label: string; self: boolean; removed: boolean; slot: number; countingSince: string | null; linesSince: string | null; lastSyncedAt: number | null; days: StatsDayView[] }
export interface StatsView { revision: number; counting: boolean; why: StatsWhy; today: string; asOf: number; computers: StatsComputerView[]; streak: { current: number; best: number }; backfill: { filesDone: number; filesTotal: number } | null; skipped: number }
export interface StatsCell { computerId: string; slot: number; open: 'value' | 'off' | 'not-counting'; agents: 'value' | 'not-counting'; openMs: number; busyMs: number; agentMs: number; added: number; removed: number; estimated: boolean }
export interface StatsBucket { key: string; partial: boolean; lengthMs: number; cells: StatsCell[] }   // key 'YYYY-MM-DD' or 'YYYY-MM'
export interface StatsTiles { openMs: number; computers: number; busyMs: number; agentMs: number; atOnce: number | null; added: number; removed: number; streak: { current: number; best: number } }
export function buildStatsView(input: { revision: number; now: number; counting: boolean; why: StatsWhy; computers: readonly StatsComputerInput[]; backfill: StatsView['backfill']; skipped: number }): StatsView
export function statsBuckets(view: StatsView, range: StatsRange): StatsBucket[]
export function cellValue(c: StatsCell, metric: StatsMetric): number                       // open → openMs, agents → busyMs, lines → added
export function cellState(c: StatsCell, metric: StatsMetric): 'value' | 'off' | 'not-counting'
export function statsTiles(view: StatsView, buckets: readonly StatsBucket[]): StatsTiles
export function streakOf(active: ReadonlySet<string>, today: string): { current: number; best: number }
export function formatHours(ms: number, locale?: string): string
export function formatLines(n: number, locale?: string): string
```
  The rules the tests pin:
  - `today = dayKey(now)`. `days` runs from the first day of the month 11 months back through today. A day after today is never shown, but it is never deleted.
  - Days before `countingSince`'s day have `openMs` null; from that day on, an empty day is 0.
  - `linesSince` is `dayKey(countFrom)` when `countFrom > 0`, else the earliest day with any `AGENT_FIELDS` value above 0. Before it, `busyMs`, `agentMs`, `added` and `removed` are null.
  - The view's `busyMs` is `busyMs + estBusyMs`, and its `agentMs` is `agentMs + estAgentMs`.
  - `timeFrom` is `transcripts` before the counting day, `mixed` on it, and `live` after it.
  - The streak counts a day active on any computer. If today is not active yet, the current run still includes yesterday.
  - Buckets: 7 d and 30 d end today; 12 mo is 12 months ending this month; the last bucket is `partial`.
  - A month bucket sums its days. Its `lengthMs` is the month's full length.
  - A bucket with no day on or after `countingSince` is `open: 'not-counting'`; counted with no open time, it is `'off'`. A bucket with no day on or after `linesSince` is `agents: 'not-counting'`.
  - `estimated` is true when any of the bucket's days is `transcripts` or `mixed`.
  - Tiles sum the value cells of the buckets, and `atOnce` is `agentMs / busyMs` to one decimal, or null.

- [ ] **Step 1: Write the failing test.** Add a `view` section. Fixture, in `Australia/Melbourne` with `now = local(2026, 10, 28, 14, 2)`, for computer `A` with `countingSince = local(2026, 10, 20, 9)` and `countFrom = 0`:
  - Sept: `'2026-09-10' { estBusyMs: 3_600_000, estAgentMs: 3_600_000, added: 30, prompts: 1 }`.
  - Oct: `'2026-10-20' { openMs: 3_600_000, busyMs: 600_000, agentMs: 600_000, estBusyMs: 1_200_000, estAgentMs: 1_800_000, added: 50 }`.
  - Oct: `'2026-10-21' { openMs: 86_400_000, busyMs: 3_600_000, agentMs: 7_200_000, added: 120, removed: 4 }`.
  - Oct: `'2026-10-27' { openMs: 600_000, busyMs: 60_000, agentMs: 60_000, prompts: 2 }`.
  - Oct: `'2026-10-28' { openMs: 18_000_000, busyMs: 600_000, agentMs: 600_000, prompts: 1 }`.
  - Names used below:
    - `oct` and `sept` are those two months;
    - `a` is the computer's `StatsComputerInput`, and `input` is the whole `buildStatsView` input (`revision: 7`, `counting: true`, `why: null`, `backfill: null`, `skipped: 0`), with `v = buildStatsView(input)`;
    - `B = idFromBytes('stats', new Uint8Array(10).fill(2))`;
    - `b7`, `b30` and `b12` are `statsBuckets(v, '7d' | '30d' | '12mo')`;
    - `dayOf(view, day)` and `cellOf(buckets, key)` look one up, and `pick(obj, keys)` keeps those keys.

```ts
section('view')
check('today is main’s, days run Nov 2025 → today', [v.today, v.computers[0].days[0].day, v.computers[0].days.at(-1)!.day], ['2026-10-28', '2025-11-01', '2026-10-28'])
check('Stoke open: null before counting, 0 on a counted empty day', [dayOf(v, '2026-10-19').openMs, dayOf(v, '2026-10-22').openMs], [null, 0])
check('agent time adds the live and the estimated parts', [dayOf(v, '2026-10-20').busyMs, dayOf(v, '2026-10-20').agentMs], [1_800_000, 2_400_000])
check('lines start at the earliest transcript day', [v.computers[0].linesSince, dayOf(v, '2026-09-09').added, dayOf(v, '2026-09-10').added], ['2026-09-10', null, 30])
check('timeFrom around the counting day', ['2026-10-19', '2026-10-20', '2026-10-21'].map(d => dayOf(v, d).timeFrom), ['transcripts', 'mixed', 'live'])
check('after a Reset lines start on the reset day', buildStatsView({ ...input, computers: [{ ...a, countFrom: local(2026, 10, 25, 8) }] }).computers[0].linesSince, '2026-10-25')
check('7 d / 30 d / 12 mo buckets', [b7.length, b7.at(-1)!.key, b7.at(-1)!.partial, b30.length, b12.length, b12[0].key, b12.at(-1)!.key], [7, '2026-10-28', true, 30, 12, '2025-11', '2026-10'])
check('off, not counting yet, and an all-uncounted month', [cellState(cellOf(b30, '2026-10-22'), 'open'), cellState(cellOf(b30, '2026-10-01'), 'open'), cellState(b12[0].cells[0], 'lines')], ['off', 'not-counting', 'not-counting'])
check('the slice-2 contract: a peer’s synced month sums by date label', statsBuckets(buildStatsView({ ...input, computers: [a, { ...a, id: B, self: false, slot: 2, months: [syncedMonth({ ...oct, computer: B })] }] }), '30d').find(b => b.key === '2026-10-21')!.cells.map(c => c.openMs), [86_400_000, 86_400_000])
check('30 d tiles', pick(statsTiles(v, b30), ['openMs', 'busyMs', 'agentMs', 'atOnce', 'added', 'removed']), { openMs: 108_600_000, busyMs: 6_060_000, agentMs: 10_260_000, atOnce: 1.7, added: 170, removed: 4 })
check('the view’s streak', v.streak, { current: 2, best: 2 })
check('streakOf: yesterday’s run holds before today is active; best is the longest anywhere', [streakOf(new Set(['2026-10-26', '2026-10-27']), '2026-10-28'), streakOf(new Set(['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-28']), '2026-10-28')], [{ current: 2, best: 2 }, { current: 1, best: 3 }])
check('formatHours', [0, 2_700_000, 16_200_000, 345_600_000, 4_579_200_000].map(x => formatHours(x, 'en-US')), ['0 h', '45 min', '4.5 h', '96 h', '1,272 h'])
check('formatLines', [9_543, 11_000, 248_000, 1_250_000].map(n => formatLines(n, 'en-US')), ['9,543', '11k', '248k', '1.3M'])
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:stats`: expected a SyntaxError naming the missing `buildStatsView` export, or FAIL lines under `view`; exit 1.
- [ ] **Step 3: Implement** the functions above in `src/shared/stats.ts`. The formatting rule: under 1 h, minutes; under 10 h, one decimal; otherwise whole hours with grouping. Lines show whole numbers under 10,000, then `k`, then one-decimal `M`. Both use `Intl.NumberFormat(locale)`.
- [ ] **Step 4: Run it and see it pass.** `npm run verify:stats`: `all pass`.
- [ ] **Step 5: Lead commits.**

### Task 4: Chart geometry

**Files:**
- Create: `src/shared/statsChart.ts`
- Test: `scripts/verify-stats.mts`

**Interfaces:**
- Consumes: `StatsBucket`, `StatsMetric`, `cellValue` and `cellState` (Task 3).
- Produces:
```ts
export const COLUMN_MAX_PX = 24
export const GAP_PX = 2
export const DATA_END_PX = 4
export interface ChartBox { width: number; height: number; gutter: number; foot: number }   // px; gutter: tick labels on the left; foot: two date labels underneath
export interface ChartSegment { computerId: string; slot: number; y: number; h: number; path: string }
export interface ChartColumn { key: string; index: number; x: number; w: number; hitX: number; hitW: number; partial: boolean; segments: ChartSegment[] }
export interface ChartGridline { y: number; value: number; label: string }
export interface StatsChartLayout { yMax: number; unit: 'h' | 'lines'; plot: { left: number; top: number; right: number; bottom: number }; gridlines: ChartGridline[]; columns: ChartColumn[] }
export function statsChartLayout(buckets: readonly StatsBucket[], metric: StatsMetric, computers: number, box: ChartBox): StatsChartLayout
export function nearestColumn(layout: StatsChartLayout, x: number): number | null   // clamps to the first or last column; null only with no columns
```
  The rules the tests pin:
  - The plot is `[gutter, width] × [0, height − foot]`. Each column's slot is the plot width divided by the number of columns. Its width is `min(COLUMN_MAX_PX, slot − GAP_PX)`, centred in the slot. Its hit area is the whole slot at full plot height.
  - For the time metrics, `yMax` in hours is `max(longest bucket lengthMs × computers, tallest column) / 3_600_000`.
    - Day buckets get a gridline at every multiple of 24 h up to `yMax`, labelled `24 h`.
    - Month buckets and the Lines metric get at most 4 gridlines, on the smallest step of 1, 2 or 5 × 10^k that gives at most 4.
  - For Lines, `yMax` is the first multiple of that step at or above the tallest column, and 10 when every column is 0.
  - Stacking: pieces stack in `slot` order from the baseline, each at its exact share of the plot. Every piece above the first gives its bottom `GAP_PX` to the gap.
  - Only the top piece's path rounds its top corners, by `min(DATA_END_PX, w / 2, h)`.
  - A cell whose state is not `value`, or whose value is 0, draws no piece.

- [ ] **Step 1: Write the failing test.** Add a `chart` section over Task 3's fixture, in the same zone, with `box = { width: 316, height: 180, gutter: 32, foot: 18 }`. The names below:
  - `b30two` is the 30 d buckets of Task 3's two-computer view, and `bFall` is 30 d ending `'2026-04-20'`, which holds the 25 h `'2026-04-05'`.
  - `L12` is `statsChartLayout(b12, 'open', 1, box)` and `Llines` is `statsChartLayout(b30, 'lines', 1, box)`, whose tallest column is 120.
  - `zeros` is 30 buckets with no lines. `colOf(layout, key)` finds a column, and `round2` rounds to two decimals.

```ts
section('chart')
const L30 = statsChartLayout(b30, 'open', 1, box)
check('30 columns', L30.columns.length, 30)
ok('every column 1–24 px wide, ≥ 2 px apart, inside the plot', L30.columns.every((c, i, a) => c.w >= 1 && c.w <= 24 && c.x >= L30.plot.left && c.x + c.w <= L30.plot.right + 1e-6 && (i === 0 || c.x - (a[i - 1].x + a[i - 1].w) >= 2 - 1e-6)))
check('at 7 d a column is capped at 24 px', statsChartLayout(b7, 'open', 1, box).columns[0].w, 24)
check('one computer, 30 d: 24 h top, one gridline', [L30.yMax, L30.gridlines.map(g => g.label)], [24, ['24 h']])
check('a range holding a 25 h day tops out at 25 h', statsChartLayout(bFall, 'open', 1, box).yMax, 25)
check('two computers: gridlines at 24 h and 48 h', statsChartLayout(b30two, 'open', 2, box).gridlines.map(g => g.value), [24, 48])
check('12 mo: the longest month, gridlines on a nice step', [L12.yMax, L12.gridlines.map(g => g.value)], [744, [200, 400, 600]])
check('lines: step 50 for a tallest column of 120', [Llines.yMax, Llines.gridlines.map(g => g.value)], [150, [50, 100, 150]])
check('an all-zero lines chart still has an axis', statsChartLayout(zeros, 'lines', 1, box).gridlines.map(g => g.value), [5, 10])
check('a full day is the full plot height', round2(colOf(L30, '2026-10-21').segments[0].h), 162)
const seg = colOf(statsChartLayout(b30two, 'open', 2, box), '2026-10-21').segments
check('stacked: 81 and 79 px, 2 px apart, only the top rounded', [round2(seg[0].h), round2(seg[1].h), round2(seg[0].y - (seg[1].y + seg[1].h)), /[AQ]/.test(seg[0].path), /[AQ]/.test(seg[1].path)], [81, 79, 2, false, true])
check('off, not counting and zero draw nothing', [colOf(L30, '2026-10-22').segments.length, colOf(L30, '2026-10-01').segments.length], [0, 0])
check('nearestColumn snaps by slot and clamps', [nearestColumn(L30, L30.columns[3].hitX + 0.5), nearestColumn(L30, -50), nearestColumn(L30, 9_999)], [3, 0, 29])
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:stats`: expected `ERR_MODULE_NOT_FOUND` for `src/shared/statsChart.ts`.
- [ ] **Step 3: Implement `src/shared/statsChart.ts`** to the rules above. It is pure, with relative `.ts` imports only.
- [ ] **Step 4: Run it and see it pass.** `npm run verify:stats`: `all pass`.
- [ ] **Step 5: Lead commits.**

### Task 5: Series tokens and their validator

**Files:**
- Create: `src/shared/series.ts`
- Modify: `src/renderer/src/lib/theme.ts`. In `applyAppearance`, after the `--meter-*` writes, add `const series = seriesScale(theme.colors, theme.appearance)` and four LITERAL calls, `root.style.setProperty('--series-1', series.slots[0])` through `'--series-4'`. They must be literal, because verify:color's token scan sees only a literal `setProperty('--x'`. Also add a comment on why the tokens are derived at apply time, as `meter.ts` explains for itself.
- Modify: `src/renderer/src/styles/app.css`.
  - In `:root`, beside `--ring-bypass`: `--series-other: color-mix(in oklab, var(--border-strong), var(--text-faint));` and `--chart-grid: var(--border-subtle);`.
  - In `:root[data-appearance='light']`: `--series-other: color-mix(in oklab, var(--border-strong), var(--text-faint) 75%);` and `--chart-grid: var(--border);`.
- Modify: `scripts/verify-theme-gen.mts`, with a section above its tally. The spec puts the validator here.
- Modify: `ARCHITECTURE.md`
- Test: `scripts/verify-theme-gen.mts`, plus `npm run verify:color`, whose token scan must stay green.

**Interfaces:**
- Consumes: `parseColor`, `toOklch`, `oklchToRgb`, `contrastRatio` and `perceptualDistance` from `src/shared/color.ts`; `Appearance` from `src/shared/ladder.ts`; `ThemeColors`.
- Produces:
```ts
export const SERIES_SEEDS: Record<Appearance, readonly [string, string, string, string]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100'],      // dataviz reference palette, slots 1-4
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500']
}
export const SERIES_GATES = { band: { light: [0.43, 0.77], dark: [0.48, 0.67] }, chromaMin: 0.1, cvdTarget: 8, cvdFloor: 6, normalMin: 15, contrastMin: 3 } as const
export const SERIES_OTHER_MIX: Record<Appearance, number> = { dark: 0.5, light: 0.75 }   // app.css's mix toward --text-faint
export function seriesScale(colors: Pick<ThemeColors, 'bg' | 'bgSunken'>, appearance: Appearance): { slots: readonly [string, string, string, string] }
export type Cvd = 'protan' | 'deutan' | 'tritan'
export function simulateCvd(c: Rgb, kind: Cvd): Rgb
export interface SeriesReport { inBand: boolean; chroma: boolean; cvdWorst: number; tritanWorst: number; normalWorst: number; contrast: number[]; relief: number[] }
export function seriesReport(palette: readonly string[], surface: string, appearance: Appearance): SeriesReport
```
  - `seriesScale` returns the seeds for the appearance. The scouts measured slot 1 at 3.46:1 or better on every built-in dock surface, and 3.44:1 or better over 432 generated themes. It takes the colours so that a per-theme floor can be added later with no call-site change.
  - `simulateCvd` is Machado, Oliveira & Fernandes (2009) at severity 1.0, in linear sRGB, clamped to [0, 1]:
    - protan `[[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]]`;
    - deutan `[[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]]`;
    - tritan `[[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]]`.
  - `seriesReport` checks adjacent pairs only. ΔE is `100 × perceptualDistance`. `cvdWorst` is the minimum over protan and deutan; tritan is reported, not gated. `relief` lists the indexes under 3:1 on `surface`.

- [ ] **Step 1: Write the failing test** (verify-theme-gen, `series tokens`).
  - `themeTs` and `appCss` are `theme.ts` and `app.css` read with `readFileSync`; `count(text, s)` counts the occurrences.
  - `REF8` is palette.md's 8 slots. Light: `#2a78d6 #eb6834 #1baf7a #eda100 #e87ba4 #008300 #6250d6 #e34948`. Dark: `#3987e5 #d95926 #199e70 #c98500 #d55181 #008300 #9085e9 #e66767`.
  - `mixOklab` is copied from verify:color's `BYPASS_MIX` mirror. `r1` rounds to one decimal.

```ts
const rep = (p: readonly string[], s: string, a: Appearance) => { const r = seriesReport(p, s, a); return [r1(r.cvdWorst), r1(r.normalWorst)] }
check('the port reproduces palette.md (reference 8)', [rep(REF8.light, '#fcfcfb', 'light'), rep(REF8.dark, '#1a1a19', 'dark')], [[9.1, 19.6], [8.4, 19.3]])
check('the four seeds', [rep(SERIES_SEEDS.light, '#fcfcfb', 'light'), rep(SERIES_SEEDS.dark, '#1a1a19', 'dark')], [[9.1, 22.9], [8.4, 19.8]])
check('the gates are the validator’s', SERIES_GATES, { band: { light: [0.43, 0.77], dark: [0.48, 0.67] }, chromaMin: 0.1, cvdTarget: 8, cvdFloor: 6, normalMin: 15, contrastMin: 3 })
for (const t of BUILT_IN_THEMES) {
  const s = seriesScale(t.colors, t.appearance).slots
  const other = toHex(mixOklab(parseColor(t.colors.borderStrong)!, parseColor(t.colors.textFaint)!, SERIES_OTHER_MIX[t.appearance]))
  const slots = seriesReport(s, t.colors.bgSunken, t.appearance), all = seriesReport([...s, other], t.colors.bgSunken, t.appearance)
  ok(`${t.id}: slots in band with chroma`, slots.inBand && slots.chroma)
  ok(`${t.id}: adjacent CVD ≥ 8 and normal ≥ 15, through Other`, all.cvdWorst >= 8 && all.normalWorst >= 15)
  ok(`${t.id}: slot 1 ≥ 3:1 on --bg-sunken, --bg and --surface`, [t.colors.bgSunken, t.colors.bg, t.colors.surface].every(g => contrastRatio(parseColor(s[0])!, parseColor(g)!) >= 3))
  ok(`${t.id}: Other ≥ 3:1 on --bg-sunken`, all.contrast[4] >= 3)
  console.log(`  note  ${t.id}: under 3:1 on the dock (the table is the relief): ${JSON.stringify(slots.relief)}`)
}
// sweepBreaks: inside the existing generated-theme sweep's loop, push the seed's label whenever slot 1 or Other is under 3:1 on its bgSunken
check('generated themes: slot 1 and Other clear 3:1 on the dock for every seed', sweepBreaks, [])
ok('theme.ts writes the four slots literally', [1, 2, 3, 4].every(n => themeTs.includes(`setProperty('--series-${n}'`)))
check('app.css declares Other and the grid in both appearances', [count(appCss, '--series-other:'), count(appCss, '--chart-grid:')], [2, 2])
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:theme-gen`: expected `ERR_MODULE_NOT_FOUND` for `src/shared/series.ts`.
- [ ] **Step 3: Implement** `src/shared/series.ts`, the `theme.ts` lines and the `app.css` tokens. If the generated sweep finds a seed under 3:1, add a lightness floor to `seriesScale`, the way `meter.ts` uses `solveTier`, rather than loosening the check.
- [ ] **Step 4: Run them and see them pass.** `npm run verify:theme-gen`: `all pass`. `npm run verify:color`: `all pass`, with `--series-1…4`, `--series-other` and `--chart-grid` counted as defined.
- [ ] **Step 5: Lead commits.**

### Task 6: The ledger's files

**Files:**
- Create: `src/main/stats/files.ts`
- Modify: `CLAUDE.md` Layout, one line under `src/main/` (new directory): `stats.ts, stats/   the Stats ledger: stats.ts wires it; stats/ledger, files, schedule have no electron import; stats/rules, store, pass run only in the chat-index worker`
- Modify: `ARCHITECTURE.md`
- Test: `scripts/verify-stats.mts`

**Interfaces:**
- Consumes: `StatsMonth` and `parseStatsMonth` (Task 2); `isId` (codec).
- Produces:
```ts
export interface StatsLedgerMeta { v: 1; id: string; createdAt: number; countingSince: number; countFrom: number; agentStore: string | null }
export function parseLedgerMeta(raw: unknown): StatsLedgerMeta | null
export type StatsFs = Pick<typeof import('node:fs/promises'), 'mkdir' | 'readdir' | 'readFile' | 'open' | 'rename' | 'rm' | 'chmod'> & Pick<typeof import('node:fs'), 'writeFileSync' | 'renameSync' | 'mkdirSync' | 'rmSync'>
export interface StatsLoad { meta: StatsLedgerMeta | null; months: StatsMonth[]; setAside: string[] }
export class StatsFiles {
  constructor(dir: string, fs?: StatsFs)                 // explicit fields; no parameter properties
  load(opts?: { readOnly?: boolean }): Promise<StatsLoad>   // readOnly: renames nothing and creates nothing
  save(month: StatsMonth): void                           // queues; a queued snapshot of the same month is replaced
  saveMeta(meta: StatsLedgerMeta): Promise<void>
  idle(): Promise<void>
  flushSync(): void                                       // quit and session-end: everything queued, now
  removeMonthsNotOf(ledgerId: string): Promise<number>
}
```
  The rules:
  - The files are `ledger.json` and `YYYY-MM.json` in `dir` (folder 0700, files 0600). Every other name is left alone: `agents.sqlite*`, `peers/`, `*.bad-*`.
  - One async write runs at a time: `${file}.${randomUUID()}.tmp` opened `wx` with 0600, written, `sync()`ed, then renamed. That is `PluginStorage`'s shape. Never use `writePrivateFile`'s fixed `.tmp`, which removes an in-flight temp.
  - `flushSync` writes with `writeFileSync` to a uuid temp of its own, then `renameSync`.
  - A file that does not parse is renamed to `<name>.bad-<ms>`, listed in `setAside`, and never overwritten.

- [ ] **Step 1: Write the failing test.** Add a `files` section. It uses a fresh `mkdtemp` under the suite's scratch `tmpdir()`, and `counting(fs)`, a real-fs wrapper that counts renames and can hold one write open.

```ts
section('files')
f.save(m); await f.idle()
check('save then load round-trips', (await f.load()).months, [m])
ok('folder 0700, files 0600', process.platform === 'win32' || (modeOf(dir) === 0o700 && modeOf(join(dir, '2026-10.json')) === 0o600))
check('three saves of one month during a held write: two writes, the last wins', [cfs.renames, (await f2.load()).months[0].days['2026-10-21'].openMs], [2, 3])
check('a corrupt month is set aside, and a later save writes beside it', [load.setAside, existsSync(join(dir, '2026-09.json.bad-1000')), existsSync(join(dir, '2026-09.json'))], [['2026-09.json'], true, true])
check('a readOnly load renames nothing and creates no folder', [readdirSync(dir2), existsSync(join(dir2, 'missing'))], [['2026-09.json'], false])
check('flushSync lands what is queued, and no .tmp is left', [(await f.load()).months.length, readdirSync(dir).filter(n => n.endsWith('.tmp'))], [2, []])
check('removeMonthsNotOf keeps its months, ledger.json and a bystander', readdirSync(dir).sort(), ['2026-10.json', 'agents.sqlite', 'ledger.json'])
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:stats`: expected `ERR_MODULE_NOT_FOUND` for `src/main/stats/files.ts`.
- [ ] **Step 3: Implement `src/main/stats/files.ts`** to the rules above. It has no electron import, and its folder is injected.
- [ ] **Step 4: Run it and see it pass.** `npm run verify:stats`: `all pass`.
- [ ] **Step 5: Lead commits.**

### Task 7: The ledger

**Files:**
- Create: `src/main/stats/ledger.ts`
- Modify: `ARCHITECTURE.md`
- Test: `scripts/verify-stats.mts`

**Interfaces:**
- Consumes: Task 1; Tasks 2 and 3 (`buildStatsView`, `StatsResetResult`, `StatsPassResult`); Task 6.
- Produces:
```ts
export const STATS_TICK_MS = 60_000
export const TICK_CAP_MS = 120_000
export const SAMPLE_CAP_MS = 2_000
export function statsCountsHere(packaged: boolean, userDataFlag: boolean, testSeam: string | undefined): { counts: boolean; why: StatsWhy }
export interface LedgerDeps {
  files: Pick<StatsFiles, 'load' | 'save' | 'saveMeta' | 'idle' | 'flushSync' | 'removeMonthsNotOf'>
  now(): number
  mono(): number
  every(fn: () => void, ms: number): { stop(): void }
  windowOpen(): boolean
  newId(): string                     // production: idFromBytes('stats', randomBytes(10))
  onChange(view: StatsView): void
}
export class StatsLedger {
  constructor(deps: LedgerDeps)
  start(): Promise<void>
  ready(): Promise<void>
  tick(): void
  mark(): void                        // a window appeared, or the last one closed
  suspend(): void
  resume(): void
  sampleAgents(working: number): void
  quitFlush(): void
  applyPass(result: StatsPassResult): void
  planInputs(): { ledger: string; countFromMs: number; timeBeforeMs: number } | null   // { meta.id, meta.countFrom, meta.countingSince }; null until start() resolves
  reset(): Promise<StatsResetResult>
  view(): StatsView
}
```
  The rules the tests pin:
  - **Start.**
    - `start()` loads the files. With no readable `ledger.json`, it recovers from the months if there are any: it adopts the newest month's `computer`, sets `countFrom: 0`, and sets `countingSince` to the start of the earliest day with `openMs > 0` (else now). It deletes nothing.
    - With nothing at all, it mints `{ id: newId(), createdAt: now, countingSince: now, countFrom: 0, agentStore: null }` and saves it.
    - Only when `ledger.json` was read does it call `removeMonthsNotOf(meta.id)`, which clears a Reset that crashed halfway.
    - It then arms `every(tick, STATS_TICK_MS)`. Nothing is booked before `start()` resolves.
  - **Booking.**
    - A tick or a mark books `clamp(min(Δmono, Δwall), 0, TICK_CAP_MS)`, ending at the current wall time. It books under the window state recorded at the previous mark, then re-reads `windowOpen()`.
    - `mark()` also drops the sampler's anchor.
    - `suspend()` books up to now and opens a gap. The next `resume()` or tick closes the gap and books nothing for it.
  - **Sampling.**
    - `sampleAgents(n)` books `dt = clamp(min(Δmono, Δwall), 0, SAMPLE_CAP_MS)`. When `n ≥ 1`, it adds `busyMs += dt` and `agentMs += n × dt` over `[now − dt, now)`, by quarter-hour pieces and local hour buckets.
    - The first sample after start, a suspend or a mark books nothing.
  - **Persisting and pushing.** Samples accumulate in memory. A tick saves every month that changed, and pushes `onChange` when today's numbers moved or the day rolled over.
  - **Quit.** `quitFlush()` acts once: it books the tail, stops the tick, and calls `files.flushSync()`.
  - **Merging a pass.**
    - `applyPass(r)` drops `r` when `r.ledger !== meta.id`.
    - For each reported month, when `r.storeId === meta.agentStore`, it replaces every day's `AGENT_FIELDS` (a day absent from the report becomes 0). Otherwise it keeps the larger of the stored and reported value, field by field, so a rebuilt store can never lower history whose transcripts are gone. It then records `agentStore = r.storeId`.
    - `backfill` becomes `{ filesDone: filesTotal − filesPending, filesTotal }` while files are pending, else null. A ledger that has never merged a pass reports `{ filesDone: 0, filesTotal: 0 }`.
  - **Reset.**
    - `reset()` is claimed synchronously. A second call while one runs gets `{ ok: false, message: 'Stats are already being reset.' }`.
    - It awaits `files.idle()`, then saves a new meta `{ id: newId(), createdAt: now, countingSince: now, countFrom: now, agentStore: null }`, then calls `removeMonthsNotOf(newId)`, then clears the months in memory and pushes.
  - **The view.** `view()` is `buildStatsView` with one computer: `{ id, label: 'This computer', self: true, removed: false, slot: 1, countingSince, countFrom, lastSyncedAt: null, months }`.

- [ ] **Step 1: Write the failing test.** Add a `ledger` section.
  - Every input is fake: in-memory files that record calls, separate wall and mono clocks, `every` captured (the test calls the tick), a `windowOpen` switch, a `newId` sequence, and a push recorder.
  - Each check runs on a fresh, started ledger with a window open, in `Australia/Melbourne`, with both clocks starting at `T0 = local(2026, 10, 28, 14, 1)`, unless it says otherwise.
  - `bookedAfter({ wall, mono })` moves each clock by its amount, ticks, and returns the Stoke-open ms that tick booked.
  - `bookedAfterMark()` ticks with no window; 30 s later it opens one and calls `mark()`; 30 s after that it ticks again, and returns what that tick booked.

```ts
section('ledger')
check('the shipped constants', [STATS_TICK_MS, TICK_CAP_MS, SAMPLE_CAP_MS, every.ms], [60_000, 120_000, 2_000, 60_000])
check('who counts', [[true, false, undefined], [true, true, undefined], [true, true, '1'], [false, false, undefined], [false, true, undefined], [false, false, '1'], [false, true, '1']].map(a => statsCountsHere(...a)),
  [{ counts: true, why: null }, { counts: false, why: 'sandbox' }, { counts: false, why: 'sandbox' }, { counts: false, why: 'development' }, { counts: false, why: 'sandbox' }, { counts: true, why: null }, { counts: true, why: null }])
check('first boot: a fresh id, counting from now, back-filling everything', [isId('stats', meta.id), meta.countingSince, meta.countFrom, view.backfill], [true, T0, 0, { filesDone: 0, filesTotal: 0 }])
check('a tick with a window books one minute into the day and its hour', [today.openMs, today.local!.openH[14]], [60_000, 60_000])
check('a stalled process books at most the cap', bookedAfter({ wall: 600_000, mono: 600_000 }), 120_000)
check('no window books nothing; a window opened 30 s before a tick books 30 s', [bookedWith(false), bookedAfterMark()], [0, 30_000])
section('clock jumps and DST')     // Review Focus 1
check('wall back an hour: nothing that tick, a minute the next', [bookedAfter({ wall: -3_600_000, mono: 60_000 }), bookedAfter({ wall: 60_000, mono: 60_000 })], [0, 60_000])
check('wall forward an hour books the monotonic minute on the new date', [bookedAfter({ wall: 3_600_000, mono: 60_000 }), lastBookedDay()], [60_000, dayKey(clock.wall)])
inZone('Australia/Melbourne', () => check('a fall-back day of minute ticks holds 25 h, its 02:00 bucket 2 h', [day('2026-04-05').openMs, day('2026-04-05').local!.openH[2]], [90_000_000, 7_200_000]))
check('23:59:30 → 00:00:30 splits 30 s / 30 s', [day('2026-10-27').openMs, day('2026-10-28').openMs], [30_000, 30_000])
section('long sleep and missed events')   // Review Focus 2
check('suspend at T0, 40 h asleep (mono still), resume: nothing booked; the whole slept day 2026-10-29 reads off', [bookedAcrossSleep(40 * 3_600_000), cellState(cellOf(statsBuckets(ledger.view(), '30d'), '2026-10-29'), 'open')], [0, 'off'])
check('a suspend with no resume: the next tick books nothing, the one after a minute', [bookedAfter({ wall: 93_600_000, mono: 93_600_000 }), bookedAfter({ wall: 60_000, mono: 60_000 })], [0, 60_000])
check('a missed suspend, mono still (macOS): one minute', bookedAfter({ wall: 28_800_000, mono: 60_000 }), 60_000)
check('a missed suspend, mono counting sleep (Windows): at most the cap', bookedAfter({ wall: 28_800_000, mono: 28_800_000 }), 120_000)
section('agents, quit, passes, reset')
check('two tabs, 10 samples a second apart: the first books nothing', [today.busyMs, today.agentMs], [9_000, 18_000])
check('after a 5 s pause a sample books 2 s', busyAfterPause(5_000), 2_000)
check('quitFlush books the tail and flushes once', [files.calls.filter(c => c === 'flushSync').length, ranTwice], [1, false])
check('a pass for another ledger is dropped', changedBy({ ...pass, ledger: 'sother000000000000' }), false)
check('the same store replaces a day (lines may go down)', mergedAdded({ storeId: S1, prior: 10, reported: 7 }), 7)
check('a new store never lowers a day', mergedAdded({ storeId: S2, prior: 10, reported: 7 }), 10)
check('back-fill shows while files are pending', ledger.view().backfill, { filesDone: 600, filesTotal: 843 })
check('reset: a second press while one runs is refused', await second, { ok: false, message: 'Stats are already being reset.' })
check('reset: a new id from now; saveMeta before removeMonthsNotOf', [meta2.id !== meta.id, meta2.countingSince, meta2.countFrom, files.calls.slice(-2)], [true, T, T, ['saveMeta', 'removeMonthsNotOf']])
check('reset: a pass still tagged with the old ledger is dropped', changedBy({ ...pass, ledger: meta.id }), false)
check('a lost ledger.json is recovered from the months, nothing deleted', [recovered.id, recovered.countFrom, files.calls.includes('removeMonthsNotOf')], [A, 0, false])
check('another ledger’s months beside a good ledger.json are removed', files.removedFor, [meta.id])
check('a clock set to 2030 keeps its days; the view stops at main’s today', [hasMonth('2030-01'), ledger.view().today], [true, dayKey(clock.wall)])
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:stats`: expected `ERR_MODULE_NOT_FOUND` for `src/main/stats/ledger.ts`.
- [ ] **Step 3: Implement `src/main/stats/ledger.ts`** to the rules above. It has no electron import; all its fields are assigned in the constructor; it books through `cutByQuarterHour`.
- [ ] **Step 4: Run it and see it pass.** `npm run verify:stats`: `all pass`.
- [ ] **Step 5: Lead commits.**

### Task 8: The counting rules

**Files:**
- Create: `src/main/stats/rules.ts`, `scripts/verify-stats-transcripts.mts`
- Modify: `package.json`. Add `"verify:stats-transcripts": "node scripts/verify-stats-transcripts.mts"`, in `check` right after `verify:stats`.
- Modify: `CLAUDE.md` (`activity, stats, stats-transcripts, worklog-gate`), and `ARCHITECTURE.md` (a file-map line and a Testing line).
- Test: `scripts/verify-stats-transcripts.mts`

**Interfaces:**
- Consumes: `dayKey` (Task 1); `safeParse`, `textOf` and `isUsefulPrompt` from `src/main/sessionFile.ts`.
- Produces:
```ts
export const RULES_VERSION = 1
export const LINE_HEAD_BYTES = 4096
export type Role = 'top' | 'sub' | 'wf' | 'thread' | 'subthread'
export type Counter = 'added' | 'removed' | 'edits' | 'prompts' | 'sessions' | 'replies' | 'tokUncached' | 'tokCacheRead' | 'tokCacheWrite' | 'tokOut' | 'tcUncached' | 'tcCacheRead' | 'tcCacheWrite' | 'tcOut' | 'turnMs'
export interface Booker {
  add(day: string, counter: Counter, n: number): void
  turn(startMs: number, endMs: number): void     // already clipped to [countFromMs, timeBeforeMs)
  model(day: string, model: string, replies: number, tokOut: number): void
  seen(id: string): boolean                      // 'e:' edit, 'm:' message, 'p:' prompt, 'i:' Codex item
  see(id: string, day: string): void
}
export interface FileState { pending: Record<string, { tool: string; added: number; removed: number }>; msgs: [id: string, booked: number][]; responses: string[]; prompted: boolean; source?: 'user' | 'subagent'; model?: string; lastSig?: string; cwd?: string }
export interface FoldCtx { role: Role; countFromMs: number; timeBeforeMs: number }
export function emptyFileState(): FileState
export function linesOf(text: string): number
export function lineDiff(oldText: string, newText: string, cap?: number): { added: number; removed: number }   // Myers on lines after trimming the common head and tail; cap 2_000, past it every line counts
export function patchCounts(structuredPatch: unknown): { added: number; removed: number } | null
export function unifiedDiffCounts(diff: string): { added: number; removed: number }
export function wantedClaude(head: Buffer, state: FileState, role: Role): boolean
export function wantedCodex(head: Buffer): boolean
export function foldClaudeLine(line: string, state: FileState, ctx: FoldCtx, b: Booker): void
export function foldCodexLine(line: string, state: FileState, ctx: FoldCtx, b: Booker): void
```
  The rules. They follow the spec, plus the shapes the scouts measured on CLI 2.1.312 and Codex 0.151–0.163.
  - **What is read.**
    - Claude records `assistant`, `user`, `attachment` and `system`. Codex `session_meta`, `turn_context`, `token_usage_record`, and `event_msg` of type `token_count`, `item_completed` or `task_complete`.
    - A record with no timestamp, or one stamped before `countFromMs`, books nothing. The day is `dayKey(timestamp)`.
  - **Claude edits.** Each is booked on its `tool_result` record's day, unless the result has `is_error` (its id then stays unseen). It counts once per `tool_use.id` (`'e:'`), with `edits += 1`.
    - `Edit`: the `+` and `-` lines of `toolUseResult.structuredPatch` when it is an array, else the pending `lineDiff(old_string, new_string)`.
    - `Write`: a result of `type: 'create'` counts `linesOf(content)`; `'update'` counts the patch; with no result it counts `linesOf(input.content)`.
    - `MultiEdit`: the patch, else the sum of `lineDiff` over `edits[]`.
    - `NotebookEdit`: `insert` and `replace` count `linesOf(new_source)`; `delete` counts 0.
  - **Claude tokens**, per `message.id` (`'m:'`).
    - The first record books the input, cache creation, cache read and output tokens. A later record of the same id books `max(0, output − booked)`.
    - The state keeps the last 16 ids. A `<synthetic>` model is skipped. Each id adds `replies += 1` and a model row.
  - **Claude prompts**, top-level files only.
    - A `user` record counts when it has no `tool_result`; is not `isMeta`, `isCompactSummary`, `isVisibleInTranscriptOnly` or `isSidechain`; has `origin.kind === 'human'` when `origin` exists (else its text does not start `<task-notification>`); passes `isUsefulPrompt`; and does not start `[Request interrupted`.
    - So does an `attachment` `queued_command` with `commandMode === 'prompt'` and a human origin.
    - Each counts once per uuid (`'p:'`; for a queued one, its `source_uuid`). The file's first counted prompt also books `sessions += 1`.
  - **Claude turn time**, top-level only: a `system` `turn_duration` record books `turnMs += durationMs` and `turn(ts − durationMs, ts)`, both clipped to `[countFromMs, timeBeforeMs)`.
  - **Codex edits.** A `FileChange` counts only with `status === 'completed'`, once per `item.id` (`'i:'`). Per `changes[path]`:
    - `add` counts `linesOf(content)`;
    - `update` counts `unifiedDiffCounts(unified_diff)`, skipping `+++` and `---`;
    - `delete` counts `linesOf(content)` as removed, else 0.
  - **Codex prompts.** A `UserMessage` counts only in a user thread (`session_meta.source` is not `{ subagent }`), once per `item.id`. The thread's first one books `sessions += 1`.
  - **Codex tokens.** `token_usage_record.usage` goes into `tok*` once per `response_id`, with uncached = input − cached − cache_write. `token_count.info.last_token_usage` goes into `tc*`, skipping an exact repeat of the previous one. The model is the latest `turn_context.model`, or `'?'` before one.
  - **Codex turn time**, user threads only: `task_complete.duration_ms`, clipped the same way.
  - **The byte gate** on a line's first 4 KB.
    - Claude: refuse a line that starts `{"type":"api-request`. Want `"role":"assistant"`; `"type":"tool_result"` only while `pending` is non-empty; and, for role `top`, `"role":"user"`, `"queued_command"` and `"turn_duration"`.
    - Codex: want the record types above.
    - A malformed line books nothing and never throws.

- [ ] **Step 1: Write the failing test.**
  - First import `import './suite-tmpdir.mts'`; set `process.env.TZ = 'Australia/Melbourne'`; same helpers and tally as verify-stats.
  - Fixture builders: `asstEdit`, `editResult`, `asstWrite`, `writeResult`, `msg`, `human`, `queued`, `turnDur`, `codexMeta`, `fileChange`, `userMessage`, `usageRecord`, `tokenCount`, `taskComplete`. Each returns a JSON line, with plain words only (gotcha 157).
  - `rec()` is a recording Booker. `fold(lines, role, ctx?)` runs a fresh state over the lines (default ctx: `countFromMs: 0`, `timeBeforeMs` = 2026-10-28 00:00), and returns `{ days, totals }`, holding the non-zero counters only.
  - `T(mo, d, h = 12, mi = 0)` is a 2026 local time as an ISO timestamp, and `T_MS` is the same in ms.

```ts
section('rules')
check('linesOf', ['', 'a', 'a\n', 'a\nb'].map(linesOf), [0, 1, 1, 2])
check('lineDiff: one changed line; past the cap every line', [lineDiff('a\nb\nc', 'a\nB\nc'), lineDiff(lines(3000, 'x'), lines(3000, 'y'), 2000)], [{ added: 1, removed: 1 }, { added: 3000, removed: 3000 }])
check('Edit with the CLI’s patch, booked on the result’s day', fold([asstEdit('t1', T(10, 27, 23, 59)), editResult('t1', T(10, 28, 0, 0), { patch: ['+a', '+b', '-c', ' d'] })], 'top').days, { '2026-10-28': { added: 2, removed: 1, edits: 1 } })
check('Edit with no toolUseResult uses the input diff', added(fold([asstEdit('t2', ts, { old: 'a\nb', new: 'a\nB\nC' }), editResult('t2', ts)], 'wf')), 2)
check('Write: create, update, and no result', [create, update, bare], [{ added: 3, removed: 0 }, { added: 1, removed: 1 }, { added: 4, removed: 0 }])
check('an errored result books nothing and leaves the id unseen', [total(errored), b.seen('e:t3')], [0, false])
check('an api-request-blob copy books nothing, and the gate refuses it', [total(fold([blobCopyOf('t1')], 'top')), wantedClaude(Buffer.from('{"type":"api-request-blob"'), emptyFileState(), 'top')], [0, false])
section('the same edit in two files')   // Review Focus 3
check('a resumed or forked copy of an edit counts once', [added(file1), added(file2SameBooker)], [2, 0])
check('a result in a later append is booked then', [added(firstAppend), added(secondAppend)], [0, 2])
check('one message over three records: output from the last, input once', pick(fold([msg('m1', 10), msg('m1', 30), msg('m1', 52)], 'top').totals, ['tokOut', 'tokUncached', 'replies']), { tokOut: 52, tokUncached: 5, replies: 1 })
check('prompts: human yes; notification, isMeta, subagent, repeat no; queued yes', [p(human()), p(notification()), p(meta()), p(human(), 'sub'), p(human(), 'top', 'twice'), p(queued())], [1, 0, 0, 0, 1, 1])
check('a session is booked once, on its first counted prompt’s day', fold([human('u1', T(10, 26)), human('u2', T(10, 27))], 'top').days['2026-10-26'].sessions, 1)
check('turn time is clipped to before countingSince', [turnMs(turnDur(T(10, 27, 10), 600_000)), turnMs(turnDur(T(10, 29, 10), 600_000))], [600_000, 0])
check('nothing stamped before countFromMs counts', total(fold([human('u', T(10, 1))], 'top', { countFromMs: T_MS(10, 2) })), 0)
check('Codex FileChange: update +2 −1, add +2, delete with no content 0, not completed 0', [u, a, d, n], [{ added: 2, removed: 1 }, { added: 2, removed: 0 }, { added: 0, removed: 0 }, { added: 0, removed: 0 }])
check('Codex prompts count in a user thread only', [p(userMessage(), 'thread'), p(userMessage(), 'subthread')], [1, 0])
check('Codex tokens: records into tok*, token_count into tc*, an exact repeat skipped', [tok.tokOut, tok.tcOut], [700, 400])
check('a malformed line books nothing and does not throw', total(fold(['{"type":"assistant","message":{', '\u0000ÿ'], 'top')), 0)
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:stats-transcripts`: expected `ERR_MODULE_NOT_FOUND` for `src/main/stats/rules.ts`.
- [ ] **Step 3: Implement `src/main/stats/rules.ts`** to the rules above. It is pure: no fs, no clock, and its state is plain JSON.
- [ ] **Step 4: Run it and see it pass.** `npm run verify:stats-transcripts`: `all pass`.
- [ ] **Step 5: Lead commits.**

### Task 9: The worker's store

**Files:**
- Create: `src/main/stats/store.ts`
- Modify: `ARCHITECTURE.md`
- Test: `scripts/verify-stats-transcripts.mts`

**Interfaces:**
- Consumes: `Counter`, `Role`, `FileState` and `RULES_VERSION` (Task 8); `StatsAgentMonth` (Task 2); `monthOf` (Task 1).
- Produces:
```ts
export const STATS_STORE_FILE = 'agents.sqlite'
export const BUSY_BITS = 1500                                   // minutes in the longest local day
export interface FileRow { key: string; agent: 'claude' | 'codex'; role: Role; path: string; form: 'jsonl' | 'zst'; dev: number; ino: number; size: number; mtimeMs: number; offset: number; state: FileState; project: string | null; goneMs: number | null }
export interface FileBatch { counters: Map<string, Partial<Record<Counter, number>>>; busy: Map<string, Uint8Array>; models: Map<string, Map<string, [replies: number, tokOut: number]>>; seen: Map<string, string> }   // keyed by day; seen id → day
export class StatsStore {
  static open(dir: string): StatsStore
  readonly storeId: string
  adopt(plan: { ledger: string; countFromMs: number; timeBeforeMs: number }): boolean   // true when it (re)built
  meta(): { ledger: string | null; countFromMs: number; timeBeforeMs: number; rules: number }
  file(key: string): FileRow | null
  files(): FileRow[]
  seen(id: string): boolean
  commit(row: FileRow, batch: FileBatch, fromZero: boolean): string[]                // one transaction; returns the months it changed
  markGone(key: string, now: number): void
  months(which: 'all' | readonly string[]): StatsAgentMonth[]
  close(): void
}
```
  The schema (`node:sqlite` `DatabaseSync`, WAL, chmodded 0600 after each open and commit, like `chatIndex/store.ts`'s `lockDown`):
```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);   -- ledger, countFromMs, timeBeforeMs, rules, storeId
CREATE TABLE file (key TEXT PRIMARY KEY, agent TEXT NOT NULL, role TEXT NOT NULL, path TEXT NOT NULL, form TEXT NOT NULL, dev INTEGER, ino INTEGER, size INTEGER, mtime_ms INTEGER, offset INTEGER NOT NULL DEFAULT 0, state TEXT, project TEXT, gone_ms INTEGER);
CREATE TABLE file_day (key TEXT NOT NULL, day TEXT NOT NULL, added INTEGER NOT NULL DEFAULT 0, removed INTEGER NOT NULL DEFAULT 0, edits INTEGER NOT NULL DEFAULT 0, prompts INTEGER NOT NULL DEFAULT 0, sessions INTEGER NOT NULL DEFAULT 0, replies INTEGER NOT NULL DEFAULT 0, tok_uncached INTEGER NOT NULL DEFAULT 0, tok_cache_read INTEGER NOT NULL DEFAULT 0, tok_cache_write INTEGER NOT NULL DEFAULT 0, tok_out INTEGER NOT NULL DEFAULT 0, tc_uncached INTEGER NOT NULL DEFAULT 0, tc_cache_read INTEGER NOT NULL DEFAULT 0, tc_cache_write INTEGER NOT NULL DEFAULT 0, tc_out INTEGER NOT NULL DEFAULT 0, turn_ms INTEGER NOT NULL DEFAULT 0, busy BLOB, PRIMARY KEY (key, day));
CREATE TABLE file_day_model (key TEXT NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL, replies INTEGER NOT NULL, tok_out INTEGER NOT NULL, PRIMARY KEY (key, day, model));
CREATE TABLE seen (id TEXT PRIMARY KEY, key TEXT NOT NULL, day TEXT NOT NULL);
CREATE INDEX seen_key ON seen(key);
```
  The rules:
  - `adopt` rebuilds when the ledger or `RULES_VERSION` differs. A rebuild drops every row, mints a new `storeId`, and records the plan's `countFromMs` and `timeBeforeMs`.
  - `commit` with `fromZero` first deletes that file's `file_day`, `file_day_model` and `seen` rows, then sums the batch in and saves the cursor and state. All of it is one transaction.
  - A gone file keeps every row: Claude Code deletes transcripts after 30 days.
  - `months()` reports, per day:
    - added, removed, prompts and sessions, summed;
    - `tokensIn = uncached + cacheRead + cacheWrite` and `tokensOut = out`, taking the `tc*` sums instead for a Codex file that has no `tok*` at all;
    - `estAgentMs` = Σ `turn_ms`, and `estBusyMs` = 60 000 × the popcount of the OR of that day's `busy` bitmaps.
  - A database that does not open is renamed to `agents.sqlite.bad-<ms>`, and a fresh one is made.

- [ ] **Step 1: Write the failing test** (a `store` section, in a scratch folder). The names below:
  - `id0` is `s.storeId` read after the first two `adopt` calls, so the third alone must change it.
  - `batch5` adds 5 lines on `'2026-10-27'`. The two turns are 10:00–10:30 and 10:15–10:45 that day, in two files.

```ts
section('store')
check('adopt: builds, keeps, then rebuilds for another ledger with a new storeId', [s.adopt(p), s.adopt(p), s.adopt({ ...p, ledger: B }), s.storeId !== id0], [true, false, true, true])
check('a re-read from zero replaces the file’s contribution', (s.commit(row, batch5, true), s.commit(row, batch5, true), s.months('all')[0].days['2026-10-27'].added), 5)
check('a gone file still counts', (s.markGone(row.key, NOW), s.months('all')[0].days['2026-10-27'].added), 5)
check('a re-read deletes only its own seen rows', [s.seen('e:of-file-1'), s.seen('e:of-file-2')], [false, true])
check('two overlapping turns: busy is the union, agent time the sum', pick(s.months('all')[0].days['2026-10-27'], ['estBusyMs', 'estAgentMs']), { estBusyMs: 2_700_000, estAgentMs: 3_600_000 })
check('Codex: records win; a file with only token_count uses it', [codexWithRecords.tokensOut, codexOnlyCounts.tokensOut], [700, 400])
check('months(["2026-10"]) returns only October', s.months(['2026-10']).map(m => m.month), ['2026-10'])
check('a corrupt agents.sqlite is set aside and a fresh store made', [existsSync(join(dir, `agents.sqlite.bad-${NOW}`)), StatsStore.open(dir).storeId !== old], [true, true])
ok('0700 folder, 0600 database', process.platform === 'win32' || (modeOf(dir) === 0o700 && modeOf(join(dir, 'agents.sqlite')) === 0o600))
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:stats-transcripts`: expected `ERR_MODULE_NOT_FOUND` for `src/main/stats/store.ts`.
- [ ] **Step 3: Implement `src/main/stats/store.ts`** to the schema and rules above. `node:sqlite` is imported statically here, because only the worker and the suite load this module (gotcha 40).
- [ ] **Step 4: Run it and see it pass.** `npm run verify:stats-transcripts`: `all pass`.
- [ ] **Step 5: Lead commits.**

### Task 10: The listing, the reader and one pass

**Files:**
- Create: `src/main/stats/pass.ts`
- Modify: `ARCHITECTURE.md`
- Test: `scripts/verify-stats-transcripts.mts`

**Interfaces:**
- Consumes: Tasks 8 and 9; `claudeRoots`, `codexHome` and `type SourceEnv` from `src/main/chatIndex/sources.ts`; `isPrivateProjectDir` from `src/shared/privateChat.ts`; `dayStartMs` (Task 1); `StatsPassResult` (Task 2).
- Produces:
```ts
export const READ_CHUNK_BYTES = 1 << 20
export const COMMIT_EVERY_BYTES = 32 << 20
export interface StatsPlan { ledger: string; countFromMs: number; timeBeforeMs: number; env: SourceEnv; codexHomes: string[]; reportAll: boolean; budgetMs: number }
export interface StatsCandidate { key: string; agent: 'claude' | 'codex'; role: Role; path: string; form: 'jsonl' | 'zst'; size: number; mtimeMs: number; dev: number; ino: number }
export function listStatsFiles(plan: StatsPlan): { files: StatsCandidate[]; errors: number }
export interface PassHooks { yieldTurn(): Promise<void>; cancelled(): boolean; now(): number; commitEveryBytes?: number }
export function runStatsPass(plan: StatsPlan, store: StatsStore, hooks: PassHooks): Promise<StatsPassResult>
```
  The rules:
  - **The Claude listing.**
    - Every root of `claudeRoots(plan.env)`, realpath-deduplicated.
    - `<slug>/<id>.jsonl` is `top`, `<slug>/<id>/subagents/agent-*.jsonl` is `sub`, and `<slug>/<id>/subagents/workflows/<run>/agent-*.jsonl` is `wf`. Never `journal.jsonl` or any file that is not `.jsonl`.
    - A slug for which `isPrivateProjectDir(slug, plan.env.privateRoots ?? [])` is skipped whole. The key is `c:<path>`.
  - **The Codex listing.**
    - `[codexHome(plan.env), ...plan.codexHomes]`, realpath-deduplicated. Walk `sessions/YYYY/MM/DD/` for `rollout-*-<uuid>.jsonl` and `.jsonl.zst`, never the `threads` table.
    - The key is `x:<uuid>`, and the `.jsonl` wins while both exist. A file starts as `thread`; `session_meta.source` can make it `subthread`.
  - **Order and cost.** Files are read newest `mtimeMs` first. An unchanged `(dev, ino, size, mtimeMs)` costs one stat.
  - **Same file, or read again from 0.**
    - `store.adopt(plan)` runs first.
    - A file is the same when its dev and ino match, `size ≥ offset`, and the byte before `offset` is `\n`. It is then read from `offset`; otherwise from 0, with `fromZero`.
    - A Codex key whose form moved from `jsonl` to `zst` instead skips `offset` decompressed bytes and checks that `\n` the same way.
  - **Reading.**
    - `readSync` in `READ_CHUNK_BYTES` chunks, cut at the last `\n`. A trailing unfinished line is never consumed.
    - Each line's first `LINE_HEAD_BYTES` go through `wantedClaude` or `wantedCodex` before any decode. A long line's pieces are kept as a list, never re-joined per chunk, and dropped as soon as the head is refused.
    - A `.zst` streams through `zlib.createZstdDecompress()`, and its cursor counts decompressed bytes.
    - The Booker writes into a `FileBatch`. `turn(start, end)` sets one bit per minute, `floor((t − dayStartMs(day)) / 60_000)`, splitting at local midnight.
    - `FileRow.project` is the first `cwd` a record states (Claude) or `session_meta.cwd` (Codex). It is kept local for slice 3's top projects, and never reported.
  - **Committing and stopping.**
    - `store.commit` runs every `COMMIT_EVERY_BYTES` (`hooks.commitEveryBytes` in a suite) at a line boundary, and at each file's end. `await hooks.yieldTurn()` runs between chunks.
    - After a commit, the pass stops once `hooks.now() − start ≥ plan.budgetMs` (`stoppedBy: 'time'`) or `hooks.cancelled()` (`'cancel'`), leaving the cursor for the next pass.
  - **Files that vanish or fail.** A stored key missing from this listing gets `store.markGone`, and its rows are kept. An unreadable file adds `skipped += 1` and keeps its cursor.
  - **The result.** `months` is `store.months('all')` when `plan.reportAll`, else the months that `commit` changed. `filesPending` counts the files not yet read to their end. `bytesRead` counts the bytes consumed past the cursors (decompressed for `.zst`), never the one-byte newline check.

- [ ] **Step 1: Write the failing test.**
  - The scratch HOME `<scratch>/home` holds `.claude/projects/<slug>/…` and `.codex/sessions/2026/10/20/…`, written with Task 8's builders. The store lives in `<scratch>/ud/stats`.
  - `pass(plan)` calls `runStatsPass` with `setImmediate` yields and a fake `now`. `sum(r)` totals a result's months.

```ts
section('pass')
check('listing: top, sub, wf; no journal, no .meta.json, no private slug', listStatsFiles(plan).files.filter(f => f.agent === 'claude').map(f => f.role).sort(), ['sub', 'top', 'wf'])
check('a Codex .jsonl and its .zst are one thread, and an account home is read', listStatsFiles(plan).files.filter(f => f.agent === 'codex').map(f => [f.key, f.form]), [[`x:${U1}`, 'jsonl'], [`x:${U2}`, 'jsonl']])
check('an append reads only its bytes and adds only its edit', [r2.bytesRead, sum(r2).added - sum(r1).added], [appended.length, 3])
check('a rewritten file is re-read from 0 and replaces its contribution', sum(afterRewrite).added, 4)
check('a deleted transcript’s days stay', sum(afterDelete).added, sum(beforeDelete).added)
check('a new ledger rebuilds and counts only from countFromMs', [rebuilt.storeId !== r1.storeId, sum(rebuilt).added], [true, ADDED_AFTER_RESET])
check('reportAll reports every month; otherwise the months changed', [all.months.map(m => m.month), some.months.map(m => m.month)], [['2026-09', '2026-10'], ['2026-10']])
section('torn and bad lines')   // Review Focus 5
check('an unfinished last line is not consumed, and counts once when finished', [sum(a1).added, sum(a2).added, sum(a3).added], [10, 10, 13])
check('a malformed line and a non-UTF-8 byte are skipped; the rest counts', sum(bad).added, 6)
check('a 12 MB unwanted line is skipped and the pass ends', [huge.stoppedBy, sum(huge).added], [null, 2])
section('zst handover')   // Review Focus 3, Codex half
check('a thread compressed after it was read adds nothing', sum(afterZst), sum(beforeZst))
section('budgeted back-fill')   // Review Focus 4
check('budget 0 stops mid-file with files pending', [first.stoppedBy, first.filesPending > 0], ['time', true])
check('repeated passes end equal to one unbudgeted pass', JSON.stringify(lastOfLoop.months), JSON.stringify(oneShot.months))
check('newest file first', firstCommittedKey, newestKey)
ok('nothing written outside the store; the fixtures are byte-identical', sameTree(homeBefore, homeAfter) && !existsSync(join(ud, 'chat-index')))
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:stats-transcripts`: expected `ERR_MODULE_NOT_FOUND` for `src/main/stats/pass.ts`.
- [ ] **Step 3: Implement `src/main/stats/pass.ts`** to the rules above. It uses sync fs on purpose, as `chatIndex/sources.ts` explains (libuv's pool is shared with pty writes); only the zstd stream is async.
- [ ] **Step 4: Run it and see it pass.** `npm run verify:stats-transcripts`: `all pass`.
- [ ] **Step 5: Lead commits.**

### Task 11: The worker's statsPass op

**Files:**
- Modify: `src/main/chatIndex/protocol.ts`, `worker.ts`, `host.ts`, and `ARCHITECTURE.md`
- Test: `scripts/verify-stats-transcripts.mts`; `npm run verify:chat-sources` stays green.

**Interfaces:**
- Consumes: `runStatsPass` and `StatsPlan` (Task 10); `StatsStore` (Task 9); `StatsPassResult` (Task 2).
- Produces:
```ts
// protocol.ts
export interface WorkerData { dir: string; statsDir?: string }              // statsDir: <userData>/stats
| { id: number; op: 'statsPass'; plan: StatsPlan }                           // WorkerRequest
statsPass: StatsPassResult | null                                            // WorkerResults; null: one is already running
// host.ts
export interface ChatIndexHostOptions { /* … */ statsDir?: string }
statsPass(plan: StatsPlan): Promise<StatsPassResult | null>                // ChatIndexHost: claimed synchronously; a call while one runs queues that plan (the newest wins) and returns null
get statsRunning(): boolean
```
  The rules:
  - The worker keeps its own `statsRunning` and `stopStats`, never `running` or `stopPass`. It opens the `StatsStore` at `statsDir` on first need. `yieldTurn` is `setImmediate`.
  - `cancel` (chat history switched off) never stops a stats pass. `delete` and `rebuild` never touch `statsDir`.
  - `close` (`settle`) stops the stats pass and closes its store.
  - A stats pass never creates the chat index's store or folder.
  - The host's idle stop waits for a running stats pass, and its `exit` handler clears `statsRunning`.
  - A stats op without `statsDir` fails with "The stats store is not configured."

- [ ] **Step 1: Write the failing test** (a `worker op` section). It runs the real worker from `src/main/chatIndex/worker.ts` under node, as verify:chat-sources does, with `dir` and `statsDir` in a scratch userData and Task 10's HOME.

```ts
section('worker op')
check('a stats pass through the host counts the fixtures', sum(await host.statsPass(plan)).added, EXPECTED_ADDED)
check('a second call while one runs returns null, and its plan runs next', [await second, ranAfter], [null, true])
check('cancel (chat history off) leaves a stats pass to finish', (await withCancel).stoppedBy, null)
check('Delete index leaves stats/agents.sqlite', (await host.deleteIndex(), existsSync(join(statsDir, 'agents.sqlite'))), true)
check('a stats pass creates no chat-index folder', existsSync(join(userData, 'chat-index')), false)
ok('stop() during a pass ends within 2 s', stopMs < 2_000)
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:stats-transcripts`: expected `TypeError: host.statsPass is not a function`.
- [ ] **Step 3: Implement** the protocol entries, the worker's `case 'statsPass'`, and the host's method and options, to the rules above.
- [ ] **Step 4: Run them and see them pass.** `npm run verify:stats-transcripts` and `npm run verify:chat-sources`: both `all pass`.
- [ ] **Step 5: Lead commits.**

### Task 12: When passes run

**Files:**
- Create: `src/main/stats/schedule.ts`
- Modify: `ARCHITECTURE.md`
- Test: `scripts/verify-stats.mts`

**Interfaces:**
- Consumes: `import type { StatsPlan } from './pass.ts'`. It must be type-only, or main would load `node:sqlite` (gotcha 40). Also `StatsPassResult` (Task 2).
- Produces:
```ts
export const STATS_PASS_BOOT_MS = 45_000          // after the chat pass's 30 s (gotcha 40)
export const STATS_PASS_EVERY_MS = 600_000
export const STATS_PASS_READ_FLOOR_MS = 30_000
export const STATS_PASS_CATCHUP_MS = 5_000
export const STATS_PASS_BUDGET_MS = 20_000
export interface SchedulerDeps {
  run(plan: StatsPlan): Promise<StatsPassResult | null>
  plan(reportAll: boolean): StatsPlan | null        // null: not counting, or the ledger not loaded yet
  apply(result: StatsPassResult): void
  after(fn: () => void, ms: number): { cancel(): void }
  now(): number
  onError(err: Error): void
}
export class StatsPassScheduler {
  constructor(deps: SchedulerDeps)
  start(): void
  onRead(): void
  runNow(): void
  stop(): void
}
```
  The rules:
  - The first pass runs at `start + STATS_PASS_BOOT_MS`. Every pass, whoever starts it, re-arms the periodic timer to `STATS_PASS_EVERY_MS` after it began, so a read-started pass replaces the boot one.
  - The process's first pass is `reportAll: true`, whoever starts it, to heal a result that landed in the worker but not in main. Every later one is `false`.
  - A result with `filesPending > 0` brings the next pass forward to `STATS_PASS_CATCHUP_MS`.
  - `onRead` runs a pass now when none began in the last `STATS_PASS_READ_FLOOR_MS` (or ever) and none is running.
  - One pass at a time: a `runNow` during a run runs once after it.
  - `plan()` returning null means nothing runs. A rejected run goes to `onError`, and the schedule carries on. `stop` cancels every timer.

- [ ] **Step 1: Write the failing test** (a `schedule` section, with a fake `after` queue and clock):

```ts
section('schedule')
check('the shipped constants', [STATS_PASS_BOOT_MS, STATS_PASS_EVERY_MS, STATS_PASS_READ_FLOOR_MS, STATS_PASS_CATCHUP_MS, STATS_PASS_BUDGET_MS], [45_000, 600_000, 30_000, 5_000, 20_000])
check('boot + 45 s with reportAll, then every 10 min without', runs.slice(0, 2).map(r => [r.at, r.reportAll]), [[45_000, true], [645_000, false]])
check('a pass that left files pending is followed 5 s later', runs[2].at - runs[1].endedAt, 5_000)
check('a read within 30 s of a pass starts none; after 30 s one', [ranAt(+10_000), ranAt(+31_000)], [false, true])
check('a read at 1 s starts the first pass, reportAll, and the next periodic one moves to 601 s', [firstFromRead, nextPeriodicAt], [{ at: 1_000, reportAll: true }, 601_000])
check('one at a time: runNow during a run runs once after it', concurrentMax, 1)
check('no plan, no run', runsWithNullPlan, 0)
check('a failed run is reported and the schedule carries on', [errors.length, runsAfterFailure > 0], [1, true])
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:stats`: expected `ERR_MODULE_NOT_FOUND` for `src/main/stats/schedule.ts`.
- [ ] **Step 3: Implement `src/main/stats/schedule.ts`** to the rules above.
- [ ] **Step 4: Run it and see it pass.** `npm run verify:stats`: `all pass`.
- [ ] **Step 5: Lead commits.**

### Task 13: Wiring in main, and the IPC

**Files:**
- Create: `src/main/stats.ts`
- Modify: `src/main/index.ts`, `src/main/pty.ts`, `src/shared/ipc.ts`, `src/preload/index.ts`, `src/shared/api.ts`, and `src/shared/stats.ts` (adds `workingTabs` and `codexAccountHomes`)
- Modify: `ARCHITECTURE.md`. Add the file map entries and a short `## Stats` section: the ledger, the worker pass, the view, and the slice-2 contract above.
- Test: `scripts/verify-stats.mts`

**Interfaces:**
- Consumes: Tasks 6, 7 and 12; `ChatIndexHost.statsPass` (Task 11); `type StatsPlan` (Task 10); and in `index.ts`, `chatEnv()`, `chatHost()`, `appWindows()`, `send()`, `appFrame()` and `getSettings()`.
- Produces:
```ts
// src/main/stats.ts
export interface StatsHandle { view(): Promise<StatsView>; reset(): Promise<StatsResetResult>; sampleAgents(working: number): void; quitFlush(): void; onRead(): void }
export function installStats(deps: { windowOpen(): boolean; push(view: StatsView): void; runPass(plan: StatsPlan): Promise<StatsPassResult | null>; env(): SourceEnv; codexHomes(): string[] }): StatsHandle | null   // null only when setting up threw (logged as "[stoke] stats:")
// src/shared/stats.ts
export function workingTabs(states: readonly Pick<LiveSessionState, 'ptyId' | 'status'>[], counts: (ptyId: string) => boolean): number
export function codexAccountHomes(accounts: Record<string, { cli: string; kind: string; home: string }>): string[]
// src/main/pty.ts, PtyManager
countsForStats(ptyId: string): boolean     // !!s && !s.exited && s.ordinary && !s.private: false for any unknown id
// src/shared/ipc.ts, after `// activity`
statsRead: 'stats:read', statsChanged: 'stats:changed', statsReset: 'stats:reset'
// src/shared/api.ts, StokeApi
stats: { read(): Promise<StatsView>; onChange(cb: (view: StatsView) => void): () => void; reset(): Promise<StatsResetResult> }
```
  What it does:
  - **`installStats`** decides who counts with exactly `statsCountsHere(app.isPackaged, app.commandLine.hasSwitch('user-data-dir'), process.env.STOKE_TEST_STATS_COUNT)`.
    - **When it counts,** it builds:
      - `new StatsFiles(join(app.getPath('userData'), 'stats'))`, and a `StatsLedger` with `now: Date.now`, `mono: () => performance.now()`, `every` = an unref'd `setInterval`, and `newId: () => idFromBytes('stats', randomBytes(10))`. Then `void ledger.start()`.
      - `powerMonitor` `suspend` and `resume` listeners.
      - `app.on('browser-window-created', (_e, w) => { setImmediate(() => ledger.mark()); w.on('session-end', () => handle.quitFlush()) })`. The deferral is there because `win` is assigned after the event fires. On Windows, `session-end` is the only event a shutdown or logout gives.
      - `app.on('window-all-closed', () => ledger.mark())`.
      - A `StatsPassScheduler`. Its `plan(reportAll)` returns null while `ledger.planInputs()` is null, else `{ ...inputs, env: deps.env(), codexHomes: deps.codexHomes(), reportAll, budgetMs: STATS_PASS_BUDGET_MS }`. Its `after` is an unref'd `setTimeout`. Then `start()`.
      - `reset()` is `ledger.reset()` followed by `scheduler.runNow()`.
    - **When it does not count,** it starts no timer, no listener and no pass, and creates nothing. Its `view()` builds from `files.load({ readOnly: true })` with `counting: false`. Its `reset()` answers `{ ok: false, message: 'Only the installed Stoke counts stats, so there is nothing to reset here.' }`.
  - **`index.ts`:**
    - a module-level `let stats: StatsHandle | null = null`;
    - in `whenReady`, right after `installHubWake(…)`: `stats = installStats({ windowOpen: () => appWindows().length > 0, push: (v) => send(CH.statsChanged, v), runPass: (plan) => chatHost().statsPass(plan), env: chatEnv, codexHomes: () => codexAccountHomes(getSettings().accounts) })`;
    - in `chatHost()`: `statsDir: join(app.getPath('userData'), 'stats')`;
    - the registry interval becomes `void registry?.pass()`, then `const states = liveSessionStates()`, then `stats?.sampleAgents(workingTabs(states, (id) => ptys?.countsForStats(id) ?? false))`, and the existing loop runs over `states`;
    - in `before-quit`, right after `flushSettings()`: `stats?.quitFlush()`;
    - in `registerIpc`, beside `CH.activityRead`:
      - `stats:read` throws `'Open Stats in Stoke.'` unless `appFrame(event)`, then runs `stats?.onRead()` and returns `stats.view()`, or throws `'Stats could not start.'`.
      - `stats:reset` answers `{ ok: false, message: 'Open Stats in Stoke.' }` unless `appFrame(event)`.
  - **The preload:** `stats: { read: () => ipcRenderer.invoke(CH.statsRead), onChange: (cb) => on<[Parameters<typeof cb>[0]]>(CH.statsChanged, cb), reset: () => ipcRenderer.invoke(CH.statsReset) }`.

- [ ] **Step 1: Write the failing test.** Add a `wiring` section: pure checks, plus pins on the source text (gotcha 31). The source is read with `readFileSync` and comments are stripped first. Mutate each pin to red once by hand while writing it.

```ts
section('wiring')
check('workingTabs: busy only, and only what counts', workingTabs([{ ptyId: 'a', status: 'busy' }, { ptyId: 'b', status: 'shell' }, { ptyId: 'c', status: 'waiting' }, { ptyId: 'd', status: 'busy' }, { ptyId: 'e', status: null }], (id) => id !== 'd'), 1)
check('codexAccountHomes: Codex logins only', codexAccountHomes({ a: { cli: 'codex', kind: 'login', home: '/h/a' }, b: { cli: 'claude', kind: 'login', home: '/h/b' }, c: { cli: 'codex', kind: 'key', home: '' } }), ['/h/a'])
ok('the sampler runs in the registry interval, before the portable loop', /void registry\?\.pass\(\)\s*const states = liveSessionStates\(\)\s*stats\?\.sampleAgents\(workingTabs\(states, /.test(indexTs))
ok('quitFlush is in the once-per-quit block, right after flushSettings()', /appQuitting = true[\s\S]*?flushSettings\(\)\s*stats\?\.quitFlush\(\)/.test(indexTs))
ok('installStats runs after installHubWake and before registerIpc', order(indexTs, 'installHubWake(', 'installStats(', 'registerIpc()'))
ok('who counts is the installed-app test', statsTs.includes("statsCountsHere(app.isPackaged, app.commandLine.hasSwitch('user-data-dir'), process.env.STOKE_TEST_STATS_COUNT)"))
ok('both stats handlers check appFrame', /CH\.statsRead[\s\S]{0,200}appFrame\(event\)/.test(indexTs) && /CH\.statsReset[\s\S]{0,200}appFrame\(event\)/.test(indexTs))
ok('main imports no worker-side stats module except as a type', ![indexTs, statsTs, hostTs, protocolTs].some(t => /import (?!type\b)[^;]*from '\.{1,2}\/stats\/(pass|store|rules)\.ts'/.test(t)) && !/import (?!type\b)[^;]*from '\.\/(pass|store|rules)\.ts'/.test(scheduleTs))   // index.ts's own './store.ts' is the settings store, so the paths name stats/
ok('countsForStats fails closed', /countsForStats\(ptyId: string\): boolean \{[^}]*!!s && !s\.exited && s\.ordinary && !s\.private/.test(ptyTs))
ok('the channels exist and the preload exposes read, onChange and reset', ['stats:read', 'stats:changed', 'stats:reset'].every(c => ipcTs.includes(`'${c}'`)) && /stats: \{\s*read:[\s\S]*onChange:[\s\S]*reset:/.test(preloadTs))
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:stats`: expected a SyntaxError on the missing `workingTabs` export, then FAIL lines under `wiring`; exit 1.
- [ ] **Step 3: Implement** everything in "What it does", in the order given. Run `npm run typecheck` before the suite.
- [ ] **Step 4: Run them and see them pass.** `npm run verify:stats`: `all pass`. `npm run typecheck`: no errors. `npm run verify:pty-exit`: still `all pass`, since its before-quit regex reads the same block.
- [ ] **Step 5: Lead commits.**

### Task 14: Settings › Stats, and Reset

**Files:**
- Create: `src/renderer/src/components/StatsSettings.tsx`
- Modify: `src/shared/settingsIndex.ts`, `src/renderer/src/components/SettingsSheet.tsx`, `scripts/verify-settings-search.mts`, `ARCHITECTURE.md`
- Test: `npm run verify:settings-search`

**Interfaces:**
- Consumes: `window.stoke.stats.reset()` (Task 13); `FieldHint` and the two-step pattern of `ChatHistorySettings.tsx`'s Delete index; `AccountSyncSettings.tsx`'s `useRun` shape (a ref claimed before the await, released in `.finally`).
- Produces:
  - page id `'stats'` and row id `'stats.reset'`;
  - `export function StatsSettings(): React.JSX.Element`.

  The exact entries:
  - `SettingsPageId` gains `'stats'`, after `'chats'`.
  - `SETTINGS_PAGES`, after `chats`: `{ id: 'stats', label: 'Stats', hint: 'What the Stats tab counts on this computer, and starting it over', keywords: ['statistics', 'uptime', 'hours', 'lines written', 'lines of code', 'agents working', 'streak', 'chart'] }`.
  - The `navTree` Configuration list: `['chats', 'stats', 'voice', 'projects', 'hosts', 'browser']`.
  - `SETTING_ROWS`, after the chats rows: `{ id: 'stats.reset', page: 'stats', label: 'Reset stats', keywords: ['clear stats', 'start over', 'delete stats', 'forget', 'ledger', 'uptime', 'lines'] }`.
  - `SettingsSheet`: `{loc.page === 'stats' && <StatsSettings />}`, beside the chats page.
  - `StatsSettings`, in `<div className="field" data-setting="stats.reset">`:
    - `.field-label` "Reset stats", and a `FieldHint`: "Stats counts, on this computer only, the hours Stoke is open, the time agents work and the lines Claude Code and Codex write. They stay in Stoke's data folder."
    - A ghost "Reset stats…" reveals a `data-variant="danger"` "Forget this computer's stats" and a ghost "Keep them". Above them sits `FieldHint tone="warning"`: "This forgets every hour and line counted on this computer. Counting starts again now, and nothing from before now is counted again, even from transcripts still on disk."
    - The result is said in the row ("Stats reset. Counting started again at 14:02.", or the refusal's message), never in a toast (gotcha 154).

- [ ] **Step 1: Write the failing test.** In `verify-settings-search.mts`, add `'components/StatsSettings.tsx': ['stats']` to BOTH `pagesOf` maps, and put `'stats'` after `'chats'` in the pinned Configuration list. Add:

```ts
check('"reset stats" and "uptime" land on Stats', ['reset stats', 'uptime'].map(q => searchSettings(entries, q)[0]?.entry.loc.page), ['stats', 'stats'])
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:settings-search`: expected FAIL on the Configuration list (no `stats` node) and on the two searches; exit 1.
- [ ] **Step 3: Implement** the entries and the component to the copy above. `npm run typecheck` must pass.
- [ ] **Step 4: Run it and see it pass.** `npm run verify:settings-search`: `all pass`. The label scan finds "Reset stats" on its own page.
- [ ] **Step 5: Lead commits.**

### Task 15: The chart component

**Files:**
- Create: `src/renderer/src/components/StatsChart.tsx`, `src/renderer/src/styles/stats.css` (the chart's rules), `scripts/verify-stats-window.mts`
- Modify: `package.json`. Add `"verify:stats-window": "electron scripts/verify-stats-window.mts"`, in `check` right after `verify:shell-layout`. ci-verify routes it to a display by itself.
- Modify: `CLAUDE.md` (`shell-layout, stats-window, pty-exit`), and `ARCHITECTURE.md` (a file-map line and a Testing line)
- Test: `scripts/verify-stats-window.mts`

**Interfaces:**
- Consumes: `statsChartLayout`, `nearestColumn` and `ChartBox` (Task 4); `StatsBucket` and `StatsMetric` (Task 3); the tokens (Task 5).
- Produces: `export function StatsChart(props: { buckets: readonly StatsBucket[]; metric: StatsMetric; computers: number; selected: number | null; onSelect(index: number | null): void; label: string; firstLabel: string; lastLabel: string }): React.JSX.Element`

  The rules:
  - **One SVG.** `<svg className="stats-chart" role="group" tabIndex={0} aria-label={label}>`. Its `width`, `height` and `viewBox` equal its wrapper's border box, measured with a `ResizeObserver` (`box: 'border-box'`, gotcha 151), so one user unit is one CSS px.
  - **The box.** `ChartBox.gutter` is 2.5 × and `foot` is 1.5 × the root font size in px, so the labels fit at every Interface scale.
  - **What is drawn inside it** (gotcha 33):
    - solid 1 px hairline gridlines `.stats-grid` in `--chart-grid`, and the baseline `.stats-baseline` in `--border-strong`;
    - tick labels `.stats-tick`, in `--text-faint` at `font-size: var(--fs-xs)`;
    - `<path className="stats-bar" data-slot={slot}>` for each piece, coloured by `.stats-bar[data-slot='1'] { fill: var(--series-1) }` through 4;
    - the selected column's marker `.stats-selected`, stroked in `--accent-ink`;
    - "so far" under a partial column, and `firstLabel` and `lastLabel` along the foot.
  - **Input.** ArrowLeft, ArrowRight, Home and End move the selection. One `pointermove` snaps through `nearestColumn`, and `pointerleave` calls `onSelect(null)`.
  - **Restraint.** No `fill=` attribute, no hex, no transition, no animation.

- [ ] **Step 1: Write the failing test.** Create `scripts/verify-stats-window.mts` on verify-shell-layout's shape, with verify-tab-overflow's pins:
  - module-scope `app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')`, `app.on('window-all-closed', () => {})` and `app.whenReady().then(main)`;
  - a `fixture.tsx` under `out/stats-window-XXXX/`, built by vite as an iife, importing the real components, `applyAppearance`, `BUILT_IN_THEMES`, `styles/app.css`, and the real `buildStatsView` over synthetic months;
  - CDP `debugger.attach('1.3')`; print the machine's reduced-motion setting; pin `Emulation.setEmulatedMedia` `no-preference` and assert it took; clear it at the end and assert the machine's setting is back;
  - a 1 s frame probe, printed;
  - every wait an `until(code, what)` poll that names what never happened;
  - captures through `captureTestWindow` (10 s);
  - console errors asserted empty;
  - `finally { win?.destroy(); rmSync(temp); app.exit(process.exitCode ? 1 : 0) }`;
  - `win.showInactive()` on win32.

  A `chart` section mounts `<StatsChart>` alone in a 340 px `.work-dock`:

```ts
await until(`document.querySelectorAll('.stats-bar').length === ${BARS_30}`, '30 d bars drawn')            // 30 days less the off and not-counting ones
for (const t of BUILT_IN_THEMES) { await setTheme(t.id)
  ok(`${t.id}: a bar's fill resolves and clears 3:1 on the dock`, contrast(await run(`getComputedStyle(document.querySelector('.stats-bar')).fill`), await run(`getComputedStyle(document.querySelector('.work-dock')).backgroundColor`)) >= 3) }   // read in a later evaluation than the switch (gotcha 161)
for (const px of [16, 25.6]) { await setRootPx(px)
  ok(`${px}px: the svg is its wrapper’s border box, ticks inside, no overflow`, await run(`(${geometryProbe})()`)) }
check('ArrowRight from column 28 selects 29; a pointer over column 3 selects 3', [await keyOn('.stats-chart', 'Right', 28), await pointerOverColumn(3)], [29, 3])
ok('no hex and no fill= attribute in StatsChart.tsx or stats.css', ![chartTsx, statsCss].some(s => /#[0-9a-f]{3,8}\b/i.test(stripComments(s)) || /\bfill=/.test(s)))
```

- [ ] **Step 2: Run it and see it fail.** `npm run verify:stats-window`: expected exit 1, with vite unable to resolve `components/StatsChart.tsx`.
- [ ] **Step 3: Implement** `StatsChart.tsx` and the chart rules in `stats.css` (imported by `StatsChart.tsx`), to the rules above.
- [ ] **Step 4: Run it and see it pass.** `npm run verify:stats-window`: `PASS stats window: …`, exit 0.
- [ ] **Step 5: Lead commits.**

### Task 16: The Stats tab

**Files:**
- Create: `src/renderer/src/components/StatsPanel.tsx`, `src/renderer/src/lib/useStats.ts`
- Modify: `src/renderer/src/components/WorkDock.tsx`, `TitleBar.tsx`, `App.tsx`, and `src/renderer/src/styles/stats.css`
- Modify: `scripts/verify-activity.mts`. Its className check must also cover `StatsPanel.tsx`, `StatsChart.tsx`, `StatsSettings.tsx` and `WorkDock.tsx`, against `app.css` plus `stats.css`.
- Modify: `ARCHITECTURE.md`
- Test: `scripts/verify-stats-window.mts`, `npm run verify:activity`

**Interfaces:**
- Consumes: Tasks 3, 4, 13, 14 and 15; `openSettings` in `App.tsx`.
- Produces:
```ts
export const STATS_PANEL_REFRESH_MS = 60_000
export function useStats(): { view: StatsView | null; error: string }   // subscribe before pull, keep the highest revision (usePlugins' shape), read() again every 60 s while mounted
export function StatsPanel(props: { onOpenSettings?: () => void }): React.JSX.Element
// WorkDock: props gain onOpenSettings?: () => void; panel is 'stats' | 'activity' | 'work', default 'stats'
```
  The layout and copy:
  - **The root.** `<section className="stats">`, with `onKeyDown={(e) => { if (e.ctrlKey || e.metaKey || e.altKey) return; e.stopPropagation() }}` (Toaster's shape). The same handler goes on `.work-dock-tabs`.
  - **The period.** `.segmented role="group" aria-label="Period"`: [7 d] [30 d] [12 mo], defaulting to 30 d.
  - **The tiles,** 2 × 2 in `.stats-tiles`, wrapping at scale 1.6. Each is a label, a value and a sub-line:
    - "Stoke open": `formatHours`, then "this computer".
    - "Lines by agents": `+${formatLines(added)}`, then `−${formatLines(removed)} removed`.
    - "Agents working": `formatHours(busy)`, then `${atOnce}× at once` (or "none yet").
    - "Streak": "N day" or "N days", then `best N`.
  - **The metric.** `.segmented aria-label="Chart"`: [Stoke open] [Agents] [Lines].
  - **The readout,** `<p className="stats-readout" aria-live="polite">`, value first: "5 h · today so far", "24 h · Wed 21 Oct", "off · Mon 5 Oct", "not counting yet · Mon 5 Oct", "+1,234 −56 · Mon 5 Oct". The date is `toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })`; a month is `{ month: 'short', year: 'numeric' }`.
  - **The chart and the table.** Then `<StatsChart>`, with this computer in slot 1: one colour and no legend, since the tiles name it. Then `<details><summary>Show table</summary><table className="stats-table">`: one row per bucket, with the columns Day | Stoke open | Agents working | Lines added | Removed. Rows with `estimated` are marked "estimated from transcripts".
  - **The notes:**
    - `why === 'development'`: "Only the installed Stoke counts stats. This is a development build, so nothing is counted here."
    - `why === 'sandbox'`: "This copy runs with its own data folder, so nothing is counted here."
    - `backfill`: "Counting your history… {done} of {total} transcripts".
    - `skipped > 0`: "{n} transcripts could not be read."
    - Always, a `<details>` "What counts": "Lines by agents counts the lines Claude Code and Codex wrote into files, from each edit's own patch, subagents and workflows included. It does not count hand typing, sed, scripts or codegen run through Bash, other agents, or private chats. Days before {countingSince} are estimated from transcripts." It also holds a link button "Reset stats…", which calls `onOpenSettings`.
  - **Empty and error states.** Empty is "Nothing counted yet.", centred with `margin: auto` (gotcha 60). An error is "Stats could not be read ({error})." These are two different sentences.
  - **The dock.** `WorkDock` shows [Stats] [Activity] [Work boards], with Stats first and the default. The tab-row close shows when `panel !== 'activity'` ("Close Stats panel" or "Close Work panel"). Activity's own head is unchanged.
  - **The title bar.** Its `title` becomes "Stats, activity and work boards", plus the existing worklog sentence when `worklogCount > 0`. Its sr-only text becomes "Open stats, activity and work boards".
  - **App.** `<WorkDock onOpenSettings={() => openSettings('stats', { id: 'stats.reset', fallback: null })} … />`.
  - **The CSS.**
    - `.work-dock > .stats { flex: 1; min-height: 0; display: flex; flex-direction: column }`, and `.stats-body { overflow-y: auto; scrollbar-gutter: stable }`. No background of its own: `.work-dock` is the surface (gotcha 54).
    - "−N removed" is in `--text-muted`, never `--danger`. Tile values are semibold, in proportional figures.
    - `.stats-table td { font-variant-numeric: tabular-nums }`.

- [ ] **Step 1: Write the failing test.** Add a `panel` section to the window suite.
  - The fixture mounts the real `WorkDock` with `window.stoke = { stats: { read, onChange, reset }, activity: { read }, work: { … } }`, stubbed only as far as each panel calls them.
  - It uses a synthetic view: 30 known days, today partial, one off day, days before counting, and 12 months.
  - A window `keydown` listener records any non-null `typeThroughKey(e, { overlayOpen: false, hasTerminal: true })`, using the real one from `lib/shortcuts.ts`.

```ts
check('Stats is first and pressed on mount; Activity and Work boards still switch; Close shows on Stats', await run(`(${dockProbe})()`), { first: 'Stats', pressed: 'Stats', switches: true, close: true })
for (const t of BUILT_IN_THEMES) ok(`${t.id}: the dock is opaque --bg-sunken`, await dockIsSunken(t.id))
for (const px of [16, 25.6]) ok(`${px}px at 340 px: no horizontal overflow; tiles, both groups and the tab row inside the dock`, await fits(px))
check('focus the chart, ArrowLeft: the readout leads with the value and matches its table row', await readoutMatchesRow(), true)
ok('"so far", "off" and "not counting yet" appear in words', await hasWords(['so far', 'off', 'not counting yet']))
check('the table has a row per bucket at 30 d / 7 d / 12 mo', await tableRows(), [30, 7, 12])
check('Enter and Space on 7 d, the Stats tab, the chart and Show table type nothing; the buttons and the summary act', await keyIsolation(), { typed: [], acted: true })   // trusted keys: win.webContents.sendInputEvent
ok('a view still back-filling says so', await withView({ backfill: { filesDone: 600, filesTotal: 843 } }, () => hasWords(['Counting your history… 600 of 843 transcripts'])))
check('under reduce: no animation, the geometry unchanged', await reducedMotion(), { animations: 0, same: true })
ok('TitleBar names where it goes', titleBarTsx.includes('Stats, activity and work boards') && !titleBarTsx.includes('Toggle worklog review'))
writeFileSync(resolve('out/stats-dock.png'), (await captureTestWindow(win)).toPNG())              // Ember
writeFileSync(resolve('out/stats-dock-light.png'), (await captureTestWindow(win)).toPNG())        // Daylight, after setTheme('daylight')
```

- [ ] **Step 2: Run them and see them fail.** `npm run verify:stats-window`: expected exit 1, with vite unable to resolve `components/StatsPanel.tsx`. `npm run verify:activity`: expected FAIL naming `StatsPanel.tsx`.
- [ ] **Step 3: Implement** `useStats`, `StatsPanel`, and the WorkDock, TitleBar, App and `stats.css` changes, to the copy above.
- [ ] **Step 4: Run them and see them pass.** `npm run verify:stats-window`: `PASS stats window: …`, exit 0; then look at both PNGs. `npm run verify:activity`: `all pass`. `npm run verify:layers`: `all pass` (nothing floats).
- [ ] **Step 5: Lead commits.**

### Task 17: The whole slice: the check, a driven proof, the gotchas

**Files:**
- Modify: `.claude/rules/<area>.md` and `CLAUDE.md`, one index line per new gotcha.
- Modify: `ARCHITECTURE.md`, wherever the proof corrects it.

- [ ] **Step 1: Run the full check.** `T=$(mktemp -d) && TMPDIR=$T npm run check`, in the background, since it takes several minutes. Expected: every suite passes and the build completes.
  - Then `grep -nE '^const [A-Za-z_$]+ = require\("' out/main/index.js` must list only node builtins, `electron`, `@lydell/node-pty` and `ws`, as before (gotcha 40).
  - `grep -l 'node:sqlite' out/main/*.js` must list worker chunks only, never `out/main/index.js`.
- [ ] **Step 2: Build a sandbox,** all under `S=$(mktemp -d)`.
  - Set `HOME=$S/home`, `CLAUDE_CONFIG_DIR=$S/home/.claude`, and `SHELL=$S/bin/sh` (a copy of `/bin/sh`).
  - `node $S/make.mjs`, using verify-stats-transcripts' builders, writes:
    - Claude: a top-level session 40 days back and one today, a subagent, a workflow agent, and a private-slug folder (which must not count);
    - Codex: a `.jsonl` today, and a `.jsonl.zst` 20 days back.
  - It prints the expected totals.
- [ ] **Step 3: Drive the built app.**
  - Launch it in the background: `STOKE_TEST_STATS_COUNT=1 HOME=… CLAUDE_CONFIG_DIR=… SHELL=… npx electron . --user-data-dir=$S/ud --use-mock-keychain --remote-debugging-port=9339 --disable-backgrounding-occluded-windows`.
  - Over CDP (`scripts/cdp-eval.mjs`), open the dock from the title-bar button.
  - Poll, bounded, until `window.stoke.stats.read()` has `backfill === null`. Its 30 d lines must equal the printed totals, and the private folder's lines must be absent.
  - Today's Stoke open must grow by about 60 000 per minute over two ticks.
  - Go through 7 d, 30 d and 12 mo with each metric. Capture `Page.captureScreenshot` without `clip` in Ember and in Daylight, to `$S/stats-ember.png` and `$S/stats-daylight.png`, and look at both.
- [ ] **Step 4: Reset** from Settings › Stats, with the two clicks.
  - The view now holds today only. `ledger.json` has a new id, the old months are gone, and the next pass counts nothing from before the reset.
- [ ] **Step 5: Quit properly** (`app.quit()` over CDP, never a force kill).
  - `$S/ud/stats` must be 0700, holding `ledger.json`, `YYYY-MM.json` and `agents.sqlite` at 0600.
  - Every fixture under `$S/home` must be byte-identical.
  - Then relaunch without `STOKE_TEST_STATS_COUNT`. The tab must say the copy is not counted, and nothing under `$S/ud/stats` may change (compare mtimes).
- [ ] **Step 6: Record gotchas** from 178 on, as `## N.` entries in the rule file whose `paths:` match. Main-process entries go in `.claude/rules/main.md`. A renderer entry needs its file added to a rule file's `paths:` in the same commit. Each also gets one index line in CLAUDE.md.
  - Record only what this build measured. Candidates to check:
    - `browser-window-created` fires before `win` is assigned, which is why the gate's mark is deferred;
    - `api-request-blob` records carry a copy of every `tool_use`, which is why the reader never opens `api-request*`;
    - the transcripts the chat index's listing misses: workflow agents, Codex account homes, and `.jsonl.zst`;
    - Activity's and Work boards' panel bodies still type Enter and Space into the session.
- [ ] **Step 7: Lead commits and pushes.** Use focused commits, one per task group, each message saying why, and include only this slice's hunks. Then push, per CLAUDE.md's convention. Cutting a release stays a separate act.
