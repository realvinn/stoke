/*
 * Auto-scan starts a paid Claude run without anybody asking it to, so the whole
 * suite is about the rules that stop it being a nuisance or a bill.
 *
 * Two failure modes are worth naming, because neither would look like a fault
 * from inside the app:
 *
 *  - **Too eager.** A resumed session arrives with its entire history already in
 *    the transcript. Counting that as new work fires a scan for a session nobody
 *    has touched, and does it on every launch.
 *  - **Too repetitive.** Nothing here is user-initiated, so a rule that misfires
 *    misfires again on the next tick, and the next. The cooldown and the hourly
 *    ceiling are the only things between a wrong verdict and a steady drip of
 *    real spending.
 *
 * The clock is injected throughout — no test here waits for real time.
 *
 *   node scripts/verify-worklog-autoscan.mts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AutoScanner,
  DEFAULT_AUTOSCAN,
  HOUR_MS,
  MAX_TRACKED,
  autoScanVerdict,
  type AutoScanConfig,
  type AutoScanSnapshot,
  type SessionActivity
} from '../src/main/worklog/autoscan.ts'
import {
  autoScanStateFile,
  readAutoScanState,
  writeAutoScanState
} from '../src/main/worklog/autoscanStore.ts'
import {
  MAX_STORED_SESSIONS,
  STORED_SESSION_MAX_AGE_MS,
  readSessionState,
  sessionStateFile,
  writeSessionState,
  type StoredSession
} from '../src/main/worklog/sessionStore.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`)
}

const NOW = 1_000_000_000
const cfg: AutoScanConfig = DEFAULT_AUTOSCAN

/** A session that every rule is happy with, so each test can spoil exactly one. */
function ready(over: Partial<SessionActivity> = {}): SessionActivity {
  return {
    sessionId: 's1',
    messageCount: 40,
    updatedAt: NOW - cfg.idleMs - 1,
    scannedMessages: 0,
    lastScanAt: 0,
    scanning: false,
    mutedUntil: 0,
    ...over
  }
}

/* ------------------------------------------------------------ the verdict */

console.log('\nwhen a session is worth scanning')

check('a quiet session with real work in it is scanned', autoScanVerdict(ready(), NOW, [], cfg), {
  scan: true
})

check(
  'a session still being written to is not',
  autoScanVerdict(ready({ updatedAt: NOW - 1_000 }), NOW, [], cfg),
  { scan: false, reason: 'not-idle' }
)
check(
  'nor one already being scanned',
  autoScanVerdict(ready({ scanning: true }), NOW, [], cfg),
  { scan: false, reason: 'scanning' }
)
check(
  'nor one the gate has already turned down',
  autoScanVerdict(ready({ mutedUntil: NOW + 1 }), NOW, [], cfg),
  { scan: false, reason: 'muted' }
)
/*
 * A transcript that has never been read has no mtime to be idle since, and a
 * zero would read as "quiet since 1970" — which is every rule passing at once.
 */
check(
  'a session with no reading yet is never scanned',
  autoScanVerdict(ready({ updatedAt: 0 }), NOW, [], cfg),
  { scan: false, reason: 'no-reading' }
)
check(
  'one question and an answer is not a work block',
  autoScanVerdict(ready({ messageCount: 4 }), NOW, [], cfg),
  { scan: false, reason: 'too-little-work' }
)
check(
  'the floor is on NEW messages, not the whole transcript',
  autoScanVerdict(ready({ messageCount: 400, scannedMessages: 398 }), NOW, [], cfg),
  { scan: false, reason: 'too-little-work' }
)
check(
  'a session scanned minutes ago waits',
  autoScanVerdict(ready({ lastScanAt: NOW - 60_000 }), NOW, [], cfg),
  { scan: false, reason: 'cooldown' }
)
check(
  'but one scanned long enough ago goes again',
  autoScanVerdict(ready({ lastScanAt: NOW - cfg.cooldownMs - 1 }), NOW, [], cfg),
  { scan: true }
)

const busyHour = Array.from({ length: cfg.maxPerHour }, (_, i) => NOW - i * 60_000)
check('the hourly ceiling holds', autoScanVerdict(ready(), NOW, busyHour, cfg), {
  scan: false,
  reason: 'hourly-limit'
})
check(
  'and scans older than an hour do not count towards it',
  autoScanVerdict(ready(), NOW, busyHour.map((t) => t - HOUR_MS), cfg),
  { scan: true }
)

/* ----------------------------------------------------------- the baseline */

console.log('\nopening a session is not the same as working in it')

function scanner(
  over: Partial<Parameters<typeof AutoScanner.prototype.constructor>[0]> = {},
  clock = { now: NOW }
): { s: AutoScanner; scans: string[]; clock: { now: number } } {
  const scans: string[] = []
  const s = new AutoScanner({
    enabled: () => true,
    watched: () => true,
    scan: async (id) => {
      scans.push(id)
      return 1
    },
    now: () => clock.now,
    ...over
  })
  return { s, scans, clock }
}

/**
 * Seed a session, then do `count` messages of work in it.
 *
 * Two readings, not one, and that is the behaviour under test: the first
 * reading of a session is a baseline rather than work. A single `observe` would
 * describe a session that was already that long when Stoke first saw it, which
 * is precisely the case that must NOT be scanned.
 */
function worked(s: AutoScanner, id: string, count: number, updatedAt: number): void {
  s.observe(id, 0, updatedAt)
  s.observe(id, count, updatedAt)
}

{
  const { s, scans, clock } = scanner()
  // A resumed session: 300 messages already on disk, quiet for an hour.
  s.observe('resumed', 300, NOW - HOUR_MS)
  await s.evaluate()
  check('a resumed session is not scanned for work done before Stoke saw it', scans, [])

  // Now the user actually does something.
  s.observe('resumed', 300 + cfg.minNewMessages, NOW - HOUR_MS)
  clock.now = NOW
  await s.evaluate()
  check('but the work they do afterwards is', scans, ['resumed'])
}

{
  const { s, scans } = scanner()
  s.observe('live', 10, NOW - 1_000)
  s.observe('live', 30, NOW - 1_000)
  await s.evaluate()
  check('a session still being typed into is left alone', scans, [])
}

/*
 * The mtime must never go backwards. findSessionFile can land on a different
 * file after a fork, and an older reading would look like a session that has
 * been quiet for longer than it has — which is a scan mid-turn.
 */
{
  const { s } = scanner()
  s.observe('fork', 10, NOW - 1_000)
  s.observe('fork', 12, NOW - HOUR_MS)
  check('an older reading does not make a live session look idle', s.state('fork')?.updatedAt, NOW - 1_000)
}

/* -------------------------------------------------------------- the gate */

console.log('\nthe gate still decides, and a no is remembered for a while')

{
  let asked = 0
  const { s, scans, clock } = scanner({
    watched: () => {
      asked++
      return false
    }
  })
  worked(s, 'unwatched', 40, NOW - cfg.idleMs - 1)
  await s.evaluate()
  check('an unwatched session is not scanned', scans, [])
  check('the gate was consulted once', asked, 1)

  clock.now = NOW + cfg.tickMs
  await s.evaluate()
  check('and not consulted again on the next tick, because that costs a disk read', asked, 1)

  clock.now = NOW + cfg.cooldownMs + 1
  await s.evaluate()
  check('it is asked again once the mute lapses', asked, 2)
}

{
  const { s, scans } = scanner({
    watched: () => {
      throw new Error('the project list could not be read')
    }
  })
  worked(s, 'broken', 40, NOW - cfg.idleMs - 1)
  await s.evaluate()
  check('a gate that cannot answer is not a licence to scan', scans, [])
}

{
  const { s, scans } = scanner({ enabled: () => false })
  worked(s, 'off', 40, NOW - cfg.idleMs - 1)
  await s.evaluate()
  check('and nothing happens at all when the setting is off', scans, [])
}

/* --------------------------------------------------------------- the run */

console.log('\none scan at a time, and no work is lost by it')

{
  /*
   * The count is banked before the run, not after. A scan takes tens of seconds
   * and the user carries on typing; recording the count on completion would
   * swallow everything written during the run, and that work would then never
   * be logged by anything.
   */
  let release: (() => void) | null = null
  const scans: string[] = []
  const clock = { now: NOW }
  const s = new AutoScanner({
    enabled: () => true,
    watched: () => true,
    scan: async (id) => {
      scans.push(id)
      await new Promise<void>((r) => {
        release = r
      })
      return 1
    },
    now: () => clock.now
  })

  worked(s, 'slow', 40, NOW - cfg.idleMs - 1)
  await s.evaluate()
  check('the scan started', scans, ['slow'])

  // Work continues while the run is in flight.
  s.observe('slow', 90, NOW - cfg.idleMs - 1)
  await s.evaluate()
  check('a second scan is not started while the first is running', scans, ['slow'])

  release?.()
  await new Promise((r) => setTimeout(r, 0))
  check('the banked count is the one from before the run', s.state('slow')?.scannedMessages, 40)
  ok(
    'so the 50 messages written during it are still unscanned work',
    (s.state('slow')?.messageCount ?? 0) - (s.state('slow')?.scannedMessages ?? 0) === 50,
    JSON.stringify(s.state('slow'))
  )
}

{
  /*
   * A failed scan still counts as attempted. Leaving the baseline alone would
   * re-fire the moment the cooldown lapsed, and a destination that is down stays
   * down — turning one failure into a slow, silent loop of paid runs.
   */
  const clock = { now: NOW }
  let attempts = 0
  const s = new AutoScanner({
    enabled: () => true,
    watched: () => true,
    scan: async () => {
      attempts++
      throw new Error('the run failed')
    },
    now: () => clock.now
  })
  worked(s, 'failing', 40, NOW - cfg.idleMs - 1)
  await s.evaluate()
  await new Promise((r) => setTimeout(r, 0))
  check('a failed scan moves the baseline anyway', s.state('failing')?.scannedMessages, 40)

  clock.now = NOW + cfg.cooldownMs + 1
  await s.evaluate()
  check('so it does not retry itself into a loop', attempts, 1)
}

{
  const clock = { now: NOW }
  const { s, scans } = scanner({}, clock)
  for (let i = 0; i < cfg.maxPerHour + 2; i++) worked(s, `s${i}`, 40, NOW - cfg.idleMs - 1)
  await s.evaluate()
  check('the hourly ceiling caps a burst of sessions', scans.length, cfg.maxPerHour)
}

{
  /*
   * The gate reads the project list off disk, so a pass can outlive the interval
   * that started it. Two passes overlapping must not each claim the same
   * session: that is two paid Claude runs for one work block, and two prompts
   * asking the identical question.
   */
  const scans: string[] = []
  const clock = { now: NOW }
  const s = new AutoScanner({
    enabled: () => true,
    // Slow on purpose: this await is the window the race lives in.
    watched: async () => {
      await new Promise((r) => setTimeout(r, 5))
      return true
    },
    scan: async (id) => {
      scans.push(id)
      return 1
    },
    now: () => clock.now
  })
  worked(s, 'raced', 40, NOW - cfg.idleMs - 1)
  await Promise.all([s.evaluate(), s.evaluate(), s.evaluate()])
  await new Promise((r) => setTimeout(r, 10))
  check('three overlapping passes start exactly one scan', scans, ['raced'])
}

/* ------------------------------------------------------------- the memory */

console.log('\ntracking is bounded, and outlives a closed tab')

{
  const { s } = scanner()
  for (let i = 0; i < MAX_TRACKED + 10; i++) s.observe(`old${i}`, 1, NOW - MAX_TRACKED - 10 + i)
  let tracked = 0
  for (let i = 0; i < MAX_TRACKED + 10; i++) if (s.state(`old${i}`)) tracked++
  check('the map does not grow without bound', tracked, MAX_TRACKED)
  ok('and the oldest is what went', !s.state('old0'), 'old0 should have been evicted')
  ok('while the newest is kept', !!s.state(`old${MAX_TRACKED + 9}`))
}

{
  /*
   * Closing a tab does not stop tracking, and that is deliberate: finishing and
   * closing is the most natural end of a work block there is, and it happens
   * seconds before the idle timer would have fired.
   */
  const clock = { now: NOW }
  const { s, scans } = scanner({}, clock)
  worked(s, 'closed', 40, NOW - cfg.idleMs - 1)
  // No further readings arrive — the PTY is gone and the watcher unwatched it.
  clock.now = NOW + 60_000
  await s.evaluate()
  check('a session whose tab closed is still scanned', scans, ['closed'])
}

{
  const { s } = scanner()
  s.observe('gone', 5, NOW)
  s.dispose()
  check('dispose forgets everything', s.state('gone'), null)
  s.observe('after', 5, NOW)
  check('and a disposed scanner takes no more readings', s.state('after'), null)
}

{
  /*
   * `start()` is what makes any of this happen unattended, and everything above
   * calls `evaluate()` by hand — so without this the whole suite would still
   * pass with the interval deleted and the feature dead. Real timers, tiny tick.
   */
  const scans: string[] = []
  const s = new AutoScanner({
    config: { tickMs: 20, idleMs: 10 },
    enabled: () => true,
    watched: () => true,
    scan: async (id) => {
      scans.push(id)
      return 1
    }
  })
  s.start()
  s.observe('ticked', 0, Date.now() - 5_000)
  s.observe('ticked', 40, Date.now() - 5_000)
  await new Promise((r) => setTimeout(r, 200))
  s.dispose()
  check('start() actually drives evaluation on its own', scans, ['ticked'])
}

{
  /*
   * The window can close during the gate's disk read. Starting a paid
   * `claude -p` for a window that no longer exists is a bill and no proposal.
   */
  const scans: string[] = []
  const clock = { now: NOW }
  const s = new AutoScanner({
    enabled: () => true,
    watched: async () => {
      await new Promise((r) => setTimeout(r, 5))
      return true
    },
    scan: async (id) => {
      scans.push(id)
      return 1
    },
    now: () => clock.now
  })
  worked(s, 'closing', 40, NOW - cfg.idleMs - 1)
  const pass = s.evaluate()
  s.dispose()
  await pass
  await new Promise((r) => setTimeout(r, 20))
  check('a window closing mid-gate does not start a paid run', scans, [])
}

/* --------------------------------------------------------------- the state */

console.log('\nthe file the state survives in')
{
  const dir = mkdtempSync(join(tmpdir(), 'stoke-autoscan-'))
  const file = autoScanStateFile(dir)
  const written: AutoScanSnapshot = {
    sessions: [{ sessionId: 's1', scannedMessages: 7, lastScanAt: 3, mutedUntil: 4 }],
    recentScans: [1, 2]
  }
  writeAutoScanState(file, written)
  check('it round-trips', readAutoScanState(file), written)
  check('a missing file is an empty state, not a crash', readAutoScanState(join(dir, 'nope.json')), {
    sessions: [],
    recentScans: []
  })
  writeAutoScanState(file, {
    sessions: [{ sessionId: '', scannedMessages: 1, lastScanAt: 0, mutedUntil: 0 }],
    recentScans: ['x' as never]
  })
  check('and junk is dropped rather than restored', readAutoScanState(file), {
    sessions: [],
    recentScans: []
  })
  rmSync(dir, { recursive: true, force: true })
}

console.log('\nwhat the scanner offers up to be written')
{
  /*
   * The hourly ceiling is a spending control. Held in memory it was cleared by
   * quitting the app, which is not a control at all.
   */
  const spent = Array.from({ length: DEFAULT_AUTOSCAN.maxPerHour }, (_, i) => NOW - i * 1000)
  const scanner = new AutoScanner({
    enabled: () => true,
    watched: () => true,
    scan: async () => 0,
    now: () => NOW,
    restore: () => ({ sessions: [], recentScans: [...spent, NOW - 2 * HOUR_MS] })
  })
  // Two readings, because the first sets the baseline. Without the second this
  // session is 'too-little-work', which autoScanVerdict answers *before* it
  // ever looks at the hourly ceiling — so the assertion below would pass for
  // entirely the wrong reason.
  scanner.observe('s1', 40, NOW - cfg.idleMs - 1)
  scanner.observe('s1', 40 + cfg.minNewMessages, NOW - cfg.idleMs - 1)
  check(
    'the hourly ceiling survives a restart',
    autoScanVerdict(scanner.state('s1')!, NOW, scanner.snapshot().recentScans, cfg),
    { scan: false, reason: 'hourly-limit' }
  )
  check(
    'scans older than an hour are not carried forward',
    scanner.snapshot().recentScans.length,
    DEFAULT_AUTOSCAN.maxPerHour
  )
  check(
    'and nothing is ever offered up mid-scan',
    scanner.snapshot().sessions.every((s) => !('scanning' in s)),
    true
  )
  scanner.dispose()
}

console.log('\nwhat survives a restart')
{
  /*
   * A resumed session arrives with its whole history in the transcript, so the
   * first reading sets the baseline rather than counting as work. Held only in
   * memory, that rule re-fired on every launch: the baseline jumped to the
   * current count and the work done just before the restart could never be
   * logged by anything.
   */
  /* `lastScanAt` is set one millisecond past the cooldown, so this session is
     eligible on every rule except the one being tested. A more recent value
     would make the verdict below 'cooldown' and prove nothing about baselines. */
  const restored: AutoScanSnapshot = {
    sessions: [
      { sessionId: 's1', scannedMessages: 100, lastScanAt: NOW - cfg.cooldownMs - 1, mutedUntil: 0 }
    ],
    recentScans: [NOW - 1000]
  }
  const scanner = new AutoScanner({
    enabled: () => true,
    watched: () => true,
    scan: async () => 0,
    now: () => NOW,
    restore: () => restored
  })
  scanner.observe('s1', 140, NOW - cfg.idleMs - 1)
  check(
    'a restored baseline is not overwritten by the first reading',
    scanner.state('s1')?.scannedMessages,
    100
  )
  check(
    'and the last scan time comes back with it',
    scanner.state('s1')?.lastScanAt,
    NOW - cfg.cooldownMs - 1
  )
  check(
    'so the 40 messages written before the restart still count as new work',
    autoScanVerdict(scanner.state('s1')!, NOW, [], cfg),
    { scan: true }
  )

  scanner.observe('s2', 12, NOW - cfg.idleMs - 1)
  check('a session nobody stored still baselines on first sight', scanner.state('s2')?.scannedMessages, 12)
  scanner.dispose()
}

console.log('\nand when it is written down')
{
  /* A muted session is a state change worth keeping: without the write, a
     restart un-mutes every session the gate just turned away. */
  const writes: AutoScanSnapshot[] = []
  const scanner = new AutoScanner({
    enabled: () => true,
    watched: () => false,
    scan: async () => 0,
    now: () => NOW,
    persist: (s) => writes.push(s)
  })
  // Two readings again: the first is the baseline, the second is the work that
  // makes this session a scan candidate at all.
  scanner.observe('s1', 40, NOW - cfg.idleMs - 1)
  scanner.observe('s1', 40 + cfg.minNewMessages, NOW - cfg.idleMs - 1)
  await scanner.evaluate()
  check('muting a session writes the state out', writes.length >= 1, true)
  ok(
    'and what it wrote has the session muted, not claimed',
    writes.at(-1)!.sessions.some((s) => s.sessionId === 's1' && s.mutedUntil > NOW),
    JSON.stringify(writes.at(-1))
  )
  scanner.dispose()
}

console.log('\na completed scan writes its own state too, not only a muted one')
{
  /*
   * Task 32 review, finding 2: the block above only drove `watched: () =>
   * false` through `evaluate()`'s own `save()`. `run()` has an independent
   * `save()` in its `finally`, and nothing here reached it — deleting it would
   * not have failed this suite despite dropping every baseline `run()` ever
   * writes.
   */
  const writes: AutoScanSnapshot[] = []
  const scanner = new AutoScanner({
    enabled: () => true,
    watched: () => true,
    scan: async () => 1,
    now: () => NOW,
    persist: (s) => writes.push(s)
  })
  worked(scanner, 's1', 40, NOW - cfg.idleMs - 1)
  await scanner.evaluate()
  // evaluate() fires run() with `void`, so it does not wait for the scan;
  // give the held promise a turn to settle before reading what was written.
  await new Promise((r) => setTimeout(r, 0))
  check('a completed scan writes the state out', writes.length >= 1, true)
  ok(
    'and what it wrote has the session banked and unclaimed',
    writes.at(-1)!.sessions.some(
      (s) => s.sessionId === 's1' && s.scannedMessages === 40 && s.lastScanAt === NOW
    ),
    JSON.stringify(writes.at(-1))
  )
  check(
    'and nothing written by a completed scan carries one in flight',
    writes.every((snap) => snap.sessions.every((s) => !('scanning' in s))),
    true
  )
  scanner.dispose()
}

/* ------------------------------------------------------------- the teardown */

console.log('\ndispose() races the awaits, and a save arriving after it must not win')

{
  /*
   * Task 32 review, finding 1. `dispose()` is reachable mid-scan — a window
   * closing on macOS does not quit the process — and it clears `this.sessions`
   * synchronously. A `save()` that resumes after that point would snapshot an
   * empty live map and overwrite the file with `[] ++ stillRestored`, dropping
   * the baseline for every session that was tracked at dispose time, not only
   * the one that was scanning. Proven against a real file, through the real
   * `writeAutoScanState`, not a mock: a mock persist would not show a
   * *truncation*, only that a function was called.
   */
  const dir = mkdtempSync(join(tmpdir(), 'stoke-autoscan-dispose-watched-'))
  const file = autoScanStateFile(dir)
  try {
    // A settled session, muted and persisted for real, so there is a
    // known-good file on disk before the race below ever touches it.
    const settled = new AutoScanner({
      enabled: () => true,
      watched: () => false,
      scan: async () => 0,
      now: () => NOW,
      persist: (s) => writeAutoScanState(file, s)
    })
    worked(settled, 'kept', 40, NOW - cfg.idleMs - 1)
    await settled.evaluate()
    settled.dispose()
    const before = readAutoScanState(file)
    ok(
      'the baseline session made it to disk before the race',
      before.sessions.some((s) => s.sessionId === 'kept'),
      JSON.stringify(before)
    )

    // A fresh scanner restores that file — standing in for the scanner
    // `activate()` builds after a window reopens — and tracks a second
    // session whose gate check is still in flight when the window closes.
    // `kept` is observe()'d too, moving it out of `restored` and into the
    // live map: exactly what `dispose()`'s `this.sessions.clear()` wipes,
    // not a session sitting untouched in `restored`, which the clear never
    // touches.
    let releaseWatched: ((v: boolean) => void) | null = null
    const racing = new AutoScanner({
      enabled: () => true,
      watched: () =>
        new Promise<boolean>((r) => {
          releaseWatched = r
        }),
      scan: async () => 0,
      now: () => NOW,
      restore: () => readAutoScanState(file),
      persist: (s) => writeAutoScanState(file, s)
    })
    worked(racing, 'racing', 40, NOW - cfg.idleMs - 1)
    racing.observe('kept', 40, NOW - cfg.idleMs - 1)

    const pass = racing.evaluate()
    // The window closes while `watched('racing')` is still unresolved.
    racing.dispose()
    releaseWatched?.(false)
    await pass
    await new Promise((r) => setTimeout(r, 0))

    const after = readAutoScanState(file)
    check('the file is untouched by a save a disposed scanner attempted', after, before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

{
  /* The same race, through `run()`'s `finally` instead of `evaluate()`'s
     `!watched` branch: a scan still running when the window closes. */
  const dir = mkdtempSync(join(tmpdir(), 'stoke-autoscan-dispose-run-'))
  const file = autoScanStateFile(dir)
  try {
    const settled = new AutoScanner({
      enabled: () => true,
      watched: () => false,
      scan: async () => 0,
      now: () => NOW,
      persist: (s) => writeAutoScanState(file, s)
    })
    worked(settled, 'kept', 40, NOW - cfg.idleMs - 1)
    await settled.evaluate()
    settled.dispose()
    const before = readAutoScanState(file)

    let releaseScan: (() => void) | null = null
    const racing = new AutoScanner({
      enabled: () => true,
      watched: () => true,
      scan: () =>
        new Promise<number>((r) => {
          releaseScan = () => r(0)
        }),
      now: () => NOW,
      restore: () => readAutoScanState(file),
      persist: (s) => writeAutoScanState(file, s)
    })
    worked(racing, 'racing', 40, NOW - cfg.idleMs - 1)
    racing.observe('kept', 40, NOW - cfg.idleMs - 1)

    // evaluate() starts run() with `void` and returns without waiting for it.
    await racing.evaluate()
    // The window closes while the scan itself is still in flight.
    racing.dispose()
    releaseScan?.()
    await new Promise((r) => setTimeout(r, 0))

    const after = readAutoScanState(file)
    check('the file is untouched by a scan that finished after dispose()', after, before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* --------------------------------------------------------- session folders */

console.log('\nwhich folder each session was started in, across a restart')
{
  const dir = mkdtempSync(join(tmpdir(), 'stoke-sessions-'))
  const file = sessionStateFile(dir)

  const local: StoredSession = { sessionId: 's1', cwd: '/Users/x/work/api', hostId: null, at: NOW }
  const remote: StoredSession = { sessionId: 's2', cwd: '/srv/app', hostId: 'h-1', at: NOW }
  writeSessionState(file, [local, remote])
  // NOW explicitly, not the defaulted Date.now(): plan-resolutions.md Task 33
  // — the suite's clock is 1970, and readSessionState()'s age filter would
  // drop both records against the real clock, failing this check and then
  // throwing on the [0] below.
  check('it round-trips', readSessionState(file, NOW), [local, remote])
  check(
    'a local session keeps a null host rather than losing the field',
    readSessionState(file, NOW)[0].hostId,
    null
  )

  writeSessionState(file, [
    { ...local, at: NOW - STORED_SESSION_MAX_AGE_MS - 1 },
    { ...remote, at: NOW }
  ])
  check(
    'a record older than the age limit is dropped on read',
    readSessionState(file, NOW).map((s) => s.sessionId),
    ['s2']
  )

  const many: StoredSession[] = Array.from({ length: MAX_STORED_SESSIONS + 20 }, (_, i) => ({
    sessionId: `s${i}`,
    cwd: '/x',
    hostId: null,
    at: NOW - i * 1000
  }))
  writeSessionState(file, many)
  const trimmed = readSessionState(file, NOW)
  check('the list is capped', trimmed.length, MAX_STORED_SESSIONS)
  check('and it is the newest that are kept', trimmed[0].sessionId, 's0')

  for (const junk of ['{', '[]', 'null', '[1,2,3]', '[{"cwd":"/x"}]']) {
    writeFileSync(file, junk, 'utf8')
    check(`junk (${junk}) reads back as an empty list`, readSessionState(file, NOW), [])
  }

  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
