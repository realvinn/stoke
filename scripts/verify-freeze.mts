/*
 * The freeze work that needs no owner decision: the clipboard peek that must
 * not decode, and the telemetry that makes a freeze leave a trace.
 *
 * The peek is `sendSync` on every paste chord and right-click, so the window
 * waits for main's whole answer. It used to decode the clipboard image
 * (`readImage()`) to say "an image is there"; it reads TYPES now
 * (clipboardPeek.ts), and these checks hold the rule per platform with a fake
 * clipboard — including the two places the type list and the old decode
 * disagreed — plus the source of the handler, so a decode cannot come back.
 *
 * The telemetry (diagnosticsLog.ts) is driven whole with a fake app, a fake
 * clock, a fake file system and a hand-ticked sampler: rotation (and a rename
 * that keeps failing), the rate limits, the stall rule, sleep, what a line may
 * carry, and how the run before ended. The watchdog thread's rule is driven on
 * a fake clock, then the thread itself runs for real: this process's main
 * thread is held for 3 s with a busy loop and the thread must say so, while a
 * child process stopped whole for 3 s (throttling, as App Nap or a sleep does
 * it) must not, and must still exit on its own with the thread running.
 *
 *   node scripts/verify-freeze.mts
 */
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { appendFileSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { clipboardKinds, peekClipboard, type ClipboardTypes } from '../src/main/clipboardPeek.ts'
import {
  DiagnosticsLog,
  EVENT_BURST,
  EVENT_WINDOW_MS,
  EventLimiter,
  FLAG_FOCUSED,
  FLAG_KNOWN,
  FLAG_SUSPENDED,
  FLAG_VISIBLE,
  LOG_NAME,
  LoopSampler,
  PUBLISH_EVERY,
  QUIT_SLACK_MS,
  SAMPLE_MS,
  STALL_LINE_MS,
  STALL_MS,
  StallWatch,
  TAIL_BYTES,
  WATCHDOG_CONFIG,
  WINDOW_MS,
  formatLine,
  freshWatchdog,
  needsRotation,
  nodeLogFs,
  previousRun,
  startDiagnostics,
  startWatchdog,
  watchdogSource,
  watchdogStep,
  type LogFs,
  type Presence,
  type WatchdogLink,
  type WatchdogState
} from '../src/main/diagnosticsLog.ts'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`))
}

/* ------------------------------------------------------- the clipboard peek */

console.log('\nthe clipboard peek reads types, never image bytes')

/** A clipboard holding `formats` (Chromium's names) and `raw` (platform types), counting what was asked. */
function fakeClip(formats: string[], raw: string[] = [], text = ''): ClipboardTypes & { asked: string[] } {
  const asked: string[] = []
  return {
    asked,
    readText: () => text,
    availableFormats: () => formats,
    has: (f: string) => {
      asked.push(f)
      return raw.includes(f)
    }
  }
}
function peekWith(platform: string, clip: ClipboardTypes, files = 3): { peek: unknown; counted: number } {
  let counted = 0
  const peek = peekClipboard(clip, platform, () => {
    counted++
    return files
  })
  return { peek, counted }
}

{
  const plain = peekWith('darwin', fakeClip(['text/plain'], [], 'hello'))
  check('plain text: the text, no image, no files', plain.peek, { text: 'hello', hasImage: false, files: 0 })
  check('and the file paths are never read for it', plain.counted, 0)

  check('a screenshot (Chromium says image/png) is an image', peekWith('darwin', fakeClip(['image/png'])).peek, {
    text: '',
    hasImage: true,
    files: 0
  })

  const finder = peekWith('darwin', fakeClip(['text/plain', 'text/uri-list'], ['com.apple.icns'], 'a.txt'))
  check(
    "Finder's copy: files counted, and hasImage stays true for its icon, which readImage decoded (Chromium hides it)",
    finder.peek,
    { text: 'a.txt', hasImage: true, files: 3 }
  )
  check('a file URL with no image beside it is files only', peekWith('darwin', fakeClip(['text/uri-list'])).peek, {
    text: '',
    hasImage: false,
    files: 3
  })
  check(
    'macOS NSFilenamesPboardType alone (no public.file-url) still counts files',
    peekWith('darwin', fakeClip([], ['NSFilenamesPboardType'])).peek,
    { text: '', hasImage: false, files: 3 }
  )
  check("Windows: CF_DIB is Chromium's image/png", peekWith('win32', fakeClip(['image/png'])).peek, { text: '', hasImage: true, files: 0 })
  check(
    'Windows: a registered PNG alone (readImage reads it before CF_DIB) is an image',
    peekWith('win32', fakeClip([], ['PNG'])).peek,
    { text: '', hasImage: true, files: 0 }
  )
  check('Windows: Explorer files', peekWith('win32', fakeClip(['text/uri-list'])).peek, { text: '', hasImage: false, files: 3 })
  check('Linux: image/png', peekWith('linux', fakeClip(['image/png'])).peek, { text: '', hasImage: true, files: 0 })
  check(
    "Linux: GNOME Files' own target alone still counts files",
    peekWith('linux', fakeClip([], ['x-special/gnome-copied-files'])).peek,
    { text: '', hasImage: false, files: 3 }
  )
  check(
    'an icon type with NO files is not an image on macOS (only the standard list decides there)',
    clipboardKinds('darwin', [], (f) => f === 'public.tiff'),
    { image: false, files: false }
  )
  const throwing: ClipboardTypes = {
    readText: () => 't',
    availableFormats: () => {
      throw new Error('no types')
    },
    has: () => false
  }
  check('a clipboard whose type list throws claims no image and lets the file read decide', peekWith('darwin', throwing).peek, {
    text: 't',
    hasImage: false,
    files: 3
  })
  const quiet = fakeClip(['text/plain'])
  peekWith('darwin', quiet)
  check('plain text on macOS asks one raw type at most (NSFilenamesPboardType)', quiet.asked, ['NSFilenamesPboardType'])
}

{
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  const start = index.indexOf('ipcMain.on(CH.clipboardRead')
  const handler = start < 0 ? '' : index.slice(start, index.indexOf('})', start))
  check('the peek handler exists', start >= 0, true)
  check('the peek handler reads through readClipboardPeek', handler.includes('readClipboardPeek()'), true)
  check('the peek handler decodes nothing (no readImage)', /readImage|availableFormats/.test(handler), false)
  const images = readFileSync(join(root, 'src/main/sshImages.ts'), 'utf8')
  const fn = images.slice(images.indexOf('export function readClipboardPeek'), images.indexOf('export function readClipboardPeek') + 400)
  check('readClipboardPeek hands Electron\'s clipboard to peekClipboard and decodes nothing', [fn.includes('peekClipboard(clipboard'), /readImage/.test(fn.split('\n}')[0])], [true, false])
}

/* ------------------------------------------------------------- the log line */

console.log('\nwhat a line may carry')

{
  const at = Date.UTC(2026, 9, 27, 5, 12, 33, 123)
  check('time, event, fields; numbers rounded; empty fields left out', formatLine(at, 'stall', { max: 812.6, p99: 640.2, focused: true, gone: undefined, none: null, empty: '' }), '2026-10-27T05:12:33.123Z stall max=813 p99=640 focused=true')
  check('a string is one token: no spaces, cut short', formatLine(at, 'child-gone', { name: 'Network Service; rm -rf ~ ' + 'x'.repeat(200) }).split(' ').length, 3)
  check('a token is at most 64 characters', formatLine(at, 'e', { v: 'y'.repeat(500) }).split('=')[1].length, 64)
}

/* --------------------------------------------------------------- rotation */

console.log('\nthe log rotates once, and is written asynchronously')

check('an empty file never rotates', needsRotation(0, 5_000_000, 1_000_000), false)
check('a file that would pass the cap rotates first', needsRotation(999_990, 20, 1_000_000), true)
check('a file under the cap after the append does not', needsRotation(500, 20, 1_000_000), false)

/** An in-memory file system that records every call. */
function memFs(): LogFs & { files: Map<string, string>; calls: string[]; failSize: boolean; failRenames: number; tailGate: Promise<void> | null } {
  const files = new Map<string, string>()
  const calls: string[] = []
  const fs = {
    files,
    calls,
    failSize: false,
    /** This many renames fail (Windows, with `.1` held open by a viewer), then they work. */
    failRenames: 0,
    /** When set, the tail read answers only once it resolves (a slow disk at start). */
    tailGate: null as Promise<void> | null,
    append: async (file: string, text: string) => {
      calls.push('append')
      files.set(file, (files.get(file) ?? '') + text)
    },
    rename: async (from: string, to: string) => {
      calls.push('rename')
      if (fs.failRenames > 0) {
        fs.failRenames--
        throw new Error('EBUSY')
      }
      files.set(to, files.get(from) ?? '')
      files.delete(from)
    },
    tail: async (file: string, bytes: number) => {
      calls.push('tail')
      if (fs.tailGate) await fs.tailGate
      const text = files.get(file) ?? ''
      return { text: text.slice(-bytes), whole: text.length <= bytes }
    },
    size: async (file: string) => {
      calls.push('size')
      if (fs.failSize) throw new Error('EIO')
      return Buffer.byteLength(files.get(file) ?? '')
    },
    appendSync: (file: string, text: string) => {
      calls.push('appendSync')
      files.set(file, (files.get(file) ?? '') + text)
    }
  }
  return fs
}

{
  const fs = memFs()
  const log = new DiagnosticsLog('/ud', fs, 100, () => 0)
  for (let i = 0; i < 5; i++) log.write(`line-${i}`)
  check('nothing is written in the calling tick (never sync on a hot path)', fs.calls, [])
  await log.idle()
  check('a burst of writes is ONE append', fs.calls.filter((c) => c === 'append').length, 1)
  check('it lands in diagnostics.log', fs.files.get(join('/ud', LOG_NAME)), 'line-0\nline-1\nline-2\nline-3\nline-4\n')
  log.write('x'.repeat(70))
  await log.idle()
  check('past the cap the file becomes .1 and a new one starts', [fs.files.get(join('/ud', LOG_NAME)), fs.files.get(join('/ud', `${LOG_NAME}.1`))?.startsWith('line-0')], ['x'.repeat(70) + '\n', true])
  log.write('y'.repeat(70))
  await log.idle()
  check('the next rotation replaces .1: one rotation kept', [fs.files.get(join('/ud', `${LOG_NAME}.1`)), fs.files.size], ['x'.repeat(70) + '\n', 2])
  check('the size is read before every append, never counted on from one read', [fs.calls.filter((c) => c === 'size').length, fs.calls.filter((c) => c === 'append').length], [3, 3])

  // The watchdog thread appends straight to the same file; main never sees those writes.
  const shared = memFs()
  const sharedLog = new DiagnosticsLog('/ud', shared, 300, () => 0)
  const sharedFile = join('/ud', LOG_NAME)
  sharedLog.write('m'.repeat(49))
  await sharedLog.idle()
  for (let i = 0; i < 10; i++) shared.files.set(sharedFile, (shared.files.get(sharedFile) ?? '') + 'w'.repeat(49) + '\n')
  sharedLog.write('n'.repeat(9))
  await sharedLog.idle()
  check(
    "the thread's lines count toward the cap: main's next write rotates them into .1",
    [shared.files.get(sharedFile), (shared.files.get(`${sharedFile}.1`) ?? '').length],
    ['n'.repeat(9) + '\n', 550]
  )

  const failing = memFs()
  failing.failSize = true
  const flaky = new DiagnosticsLog('/ud', failing, 100, () => 0)
  flaky.write('lost')
  await flaky.idle()
  failing.failSize = false
  flaky.write('kept')
  await flaky.idle()
  check('a failed write loses its lines and the next one measures again', [failing.files.get(join('/ud', LOG_NAME)), failing.calls.filter((c) => c === 'size').length], ['kept\n', 2])

  const locked = memFs()
  locked.failRenames = 2
  const stuck = new DiagnosticsLog('/ud', locked, 100, () => 0)
  stuck.write('a'.repeat(70))
  await stuck.idle()
  stuck.write('b'.repeat(70))
  await stuck.idle()
  check(
    'a rotation that fails still appends: past the cap, nothing lost while .1 is held',
    [locked.files.get(join('/ud', LOG_NAME)), locked.files.has(join('/ud', `${LOG_NAME}.1`)), locked.calls.filter((c) => c === 'rename').length],
    ['a'.repeat(70) + '\n' + 'b'.repeat(70) + '\n', false, 1]
  )
  stuck.write('c'.repeat(70))
  await stuck.idle()
  check('and the next write tries the rotation again (still held: appended again)', [locked.calls.filter((c) => c === 'rename').length, (locked.files.get(join('/ud', LOG_NAME)) ?? '').split('\n').filter(Boolean).length], [2, 3])
  stuck.write('d'.repeat(70))
  await stuck.idle()
  check(
    'once the rename works the file rotates, keeping everything written meanwhile in .1',
    [locked.files.get(join('/ud', LOG_NAME)), (locked.files.get(join('/ud', `${LOG_NAME}.1`)) ?? '').split('\n').filter(Boolean).length],
    ['d'.repeat(70) + '\n', 3]
  )

  const held = memFs()
  const big = new DiagnosticsLog('/ud', held, 1_000_000, () => 0)
  for (let i = 0; i < 600; i++) big.write(`l${i}`)
  await big.idle()
  const text = held.files.get(join('/ud', LOG_NAME)) ?? ''
  check('lines past PENDING_MAX are counted, not held', [text.split('\n').filter(Boolean).length, /log-dropped lines=100/.test(text)], [501, true])

  const quitFs = memFs()
  const quitting = new DiagnosticsLog('/ud', quitFs, 1_000_000, () => 0)
  quitting.write('last words')
  quitting.flushSync()
  await quitting.idle()
  check('flushSync writes what is queued at once, and only once', [quitFs.files.get(join('/ud', LOG_NAME)), quitFs.calls], ['last words\n', ['appendSync']])

  const dir = mkdtempSync(join(tmpdir(), 'stoke-freeze-'))
  try {
    const real = new DiagnosticsLog(dir, nodeLogFs, 200, () => 0)
    for (let i = 0; i < 8; i++) {
      real.write(`${i}`.repeat(40))
      await real.idle()
    }
    const main = join(dir, LOG_NAME)
    check('on the real file system: both files exist, each under the cap', [existsSync(main), existsSync(`${main}.1`), statSync(main).size <= 200, statSync(`${main}.1`).size <= 200], [true, true, true, true])

    // The review's measurement, on the real file system: a 2,000-byte cap, 200 of the thread's
    // stalled/recovered pairs appended as the thread appends them, then ten main writes. Counted
    // from one read, the file reached 25,246 bytes and was never rotated.
    const capped = mkdtempSync(join(dir, 'capped-'))
    const cappedLog = new DiagnosticsLog(capped, nodeLogFs, 2_000, () => 0)
    const cappedFile = join(capped, LOG_NAME)
    cappedLog.write(formatLine(0, 'start', { version: '1' }))
    await cappedLog.idle()
    for (let i = 0; i < 200; i++) {
      appendFileSync(cappedFile, formatLine(i * 2_250, 'main-stalled', { ms: 2_000, focused: true, visible: true }) + '\n', { flag: 'a' })
      appendFileSync(cappedFile, formatLine(i * 2_250 + 2_000, 'main-recovered', { after: 2_250 }) + '\n', { flag: 'a' })
    }
    for (let i = 0; i < 10; i++) {
      cappedLog.write(formatLine(500_000 + i, 'stall', { max: 2_000 }))
      await cappedLog.idle()
    }
    check(
      "the thread's 200 pairs are rotated out by main's next write: the file stays under the cap, and .1 holds them",
      [statSync(cappedFile).size <= 2_000, (existsSync(`${cappedFile}.1`) ? readFileSync(`${cappedFile}.1`, 'utf8') : '').split('\n').filter((l) => l.includes(' main-')).length],
      [true, 400]
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* -------------------------------------------------------------- rate limits */

console.log('\nrate limits, on a fake clock')

{
  const limiter = new EventLimiter()
  const takes = Array.from({ length: EVENT_BURST + 2 }, (_, i) => limiter.take('child-gone', 1000 + i).ok)
  check(`${EVENT_BURST} lines of one kind, then held`, [takes.filter(Boolean).length, takes.at(-1)], [EVENT_BURST, false])
  check('another kind is not held by it', limiter.take('suspend', 1020).ok, true)
  check('once the window has passed, the next line carries how many were held', limiter.take('child-gone', 1000 + EVENT_WINDOW_MS + 5), { ok: true, suppressed: 2 })
}

{
  const watch = new StallWatch()
  const iso = (ms: number): string => new Date(ms).toISOString()
  const T = Date.UTC(2026, 9, 27, 5, 0, 0)
  const stall = { maxMs: 900, maxAt: T + 9_000, p99Ms: 900, over: 1, samples: 100 }
  const calm = { maxMs: 3, maxAt: T, p99Ms: 2, over: 0, samples: 100 }
  const seen = (focused: boolean, visible: boolean): Presence => ({ focused, visible })
  check('a window with no stall says nothing', watch.observe(calm, 0, seen(true, true)), null)
  check(
    'the first stall is a line at once, saying when it began (worstAt) and whether a window was shown',
    watch.observe(stall, 10_000, seen(true, true)),
    { max: 900, worstAt: iso(T + 9_000), p99: 900, over: 1, windows: 1, focused: true, visible: true }
  )
  check('a stall inside the next minute is held', watch.observe({ ...stall, maxAt: T + 15_000 }, 20_000, seen(false, true)), null)
  check('and a worse one after it', watch.observe({ ...stall, maxMs: 2400, maxAt: T + 25_000 }, 30_000, seen(false, false)), null)
  check(
    'the next line may go a minute after the last, carrying every held window (the worst and ITS time, the count)',
    watch.observe(calm, 10_000 + STALL_LINE_MS, seen(false, false)),
    { max: 2400, worstAt: iso(T + 25_000), p99: 900, over: 2, windows: 2, focused: false, visible: true }
  )
  check('nothing held, nothing said', watch.observe(calm, 200_000, seen(true, true)), null)
  check('a stall a minute after the last line goes at once', watch.observe(stall, 200_001, seen(true, true)) !== null, true)
  check('the one after it is held', watch.observe(stall, 200_002, seen(false, false)), null)
  check(
    'quit drains what is held whatever the rate; unfocused and hidden reads as such',
    watch.drain(),
    { max: 900, worstAt: iso(T + 9_000), p99: 900, over: 1, windows: 1, focused: false, visible: false }
  )
}

/* ----------------------------------------------------------- the main loop */

console.log('\nthe main-loop sampler, on a fake monotonic clock')

{
  let t = 0
  let wall = Date.UTC(2026, 9, 27, 6, 0, 0)
  const sampler = new LoopSampler(() => t, () => wall)
  let window = null
  for (let i = 0; i < WINDOW_MS / SAMPLE_MS && !window; i++) {
    t += SAMPLE_MS
    window = sampler.tick()
  }
  check('an idle window: on time, no stall', window && [Math.round(window.maxMs), window.over], [0, 0])

  const due = wall + SAMPLE_MS
  t += 800 + SAMPLE_MS
  wall += 800 + SAMPLE_MS
  sampler.tick()
  window = null
  while (!window) {
    t += SAMPLE_MS
    wall += SAMPLE_MS
    window = sampler.tick()
  }
  check('a tick 800 ms late is an 800 ms stall', [Math.round(window.maxMs), window.over], [800, 1])
  check('and its wall time is when that tick was due: when the stall began', new Date(window.maxAt).toISOString(), new Date(due).toISOString())

  let boot = 0
  const atBoot = new LoopSampler(() => boot)
  boot = 8_000 // the first tick of a sampler made just before a blocking Keychain decrypt
  let atStart = atBoot.tick()
  while (!atStart) {
    boot += SAMPLE_MS
    atStart = atBoot.tick()
  }
  check('a block straight after the sampler is made is measured (monitorEventLoopDelay drops it)', atStart && Math.round(atStart.maxMs), 7_900)

  t += 60_000
  sampler.restart()
  window = null
  while (!window) {
    t += SAMPLE_MS
    window = sampler.tick()
  }
  check('restart forgets the gap (a sleep is not a stall)', Math.round(window.maxMs), 0)
}

/* ------------------------------------------------------- the whole watch */

console.log('\nthe whole watch, with a fake app, power monitor, clock and timer')

{
  const app = new EventEmitter()
  const power = new EventEmitter()
  const fs = memFs()
  let now = 1_000_000
  let mono = 0
  let tick: (() => void) | null = null
  let stopped = false
  let focused = true
  let visible = true
  /** The watchdog's main end, as startDiagnostics drives it. */
  const dog = { file: '', beats: 0, presence: [] as Presence[], suspended: [] as boolean[], stops: 0, gone: (_why: string): void => {} }
  const diag = startDiagnostics('/ud', {
    app,
    powerMonitor: power,
    about: { version: '1.0.0-beta.19', electron: '43.2.0', os: 'darwin-26.0', arch: 'arm64', packaged: true },
    focused: () => focused,
    visible: () => visible,
    watchdog: (file, gone): WatchdogLink => {
      dog.file = file
      dog.gone = gone
      return {
        beat: () => void dog.beats++,
        presence: (p) => void dog.presence.push(p),
        suspended: (on) => void dog.suspended.push(on),
        stop: () => void dog.stops++
      }
    },
    now: () => now,
    mono: () => mono,
    every: (fn, ms) => {
      tick = fn
      check('the sampler ticks every SAMPLE_MS', ms, SAMPLE_MS)
      return { stop: () => (stopped = true) }
    },
    fs
  })
  // Read on the very next line, before any await: a start deferred even by a microtask would
  // land after the rest of whenReady (`void initSecretStore()`), so a boot block went unwatched.
  const dogFileAtReturn = dog.file
  check('the watchdog is started on the log file inside startDiagnostics, before it returns', dogFileAtReturn, join('/ud', LOG_NAME))
  const lines = async (): Promise<string[]> => {
    await diag.log.idle()
    return (fs.files.get(join('/ud', LOG_NAME)) ?? '').split('\n').filter(Boolean).map((l) => l.slice(25))
  }
  const run = (ms: number): void => {
    for (let left = ms; left > 0; left -= SAMPLE_MS) {
      mono += SAMPLE_MS
      now += SAMPLE_MS
      tick?.()
    }
  }

  check('the start line names the build and nothing personal', (await lines())[0], 'start version=1.0.0-beta.19 electron=43.2.0 os=darwin-26.0 arch=arm64 packaged=true')
  dog.gone('ERR_WORKER_INIT_FAILED')
  check('a watchdog thread that dies is said, so a silent watchdog never reads as a calm main', (await lines()).at(-1), 'watchdog-gone why=ERR_WORKER_INIT_FAILED')

  const win = Object.assign(new EventEmitter(), { id: 7 })
  app.emit('browser-window-created', {}, win)
  win.emit('unresponsive')
  now += 1_500
  win.emit('unresponsive')
  now += 1_700
  win.emit('responsive')
  win.emit('responsive')
  check('unresponsive, then responsive with how long: one line each, however often Electron says it', (await lines()).slice(2), ['window-unresponsive win=7', 'window-responsive win=7 after=3200'])

  win.emit('unresponsive')
  now += 900
  win.emit('closed')
  check('a window closed while unresponsive says so', (await lines()).slice(-1), ['window-closed-unresponsive win=7 after=900'])

  const contents = { getType: () => 'window', getURL: () => 'file:///Users/someone/secret/index.html' }
  app.emit('render-process-gone', {}, contents, { reason: 'crashed', exitCode: 11 })
  check('a renderer gone: its kind, reason and code, never its URL', (await lines()).slice(-1), ['renderer-gone kind=window reason=crashed code=11 quitting=false'])

  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 8704, name: 'GPU' })
  app.emit('child-process-gone', {}, { type: 'Utility', reason: 'clean-exit', exitCode: 0, serviceName: 'data_decoder.mojom.DataDecoderService' })
  check('a GPU crash is a line; a clean exit is not', (await lines()).slice(-1), ['child-gone type=GPU reason=crashed code=8704 name=GPU'])

  for (let i = 0; i < EVENT_BURST + 3; i++) app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
  const gpu = (await lines()).filter((l) => l.startsWith('child-gone'))
  check(`a crash loop is held to ${EVENT_BURST} lines a window`, gpu.length, EVENT_BURST)
  now += EVENT_WINDOW_MS
  app.emit('child-process-gone', {}, { type: 'GPU', reason: 'crashed', exitCode: 1 })
  check('and the next one says how many were held', (await lines()).slice(-1), ['child-gone type=GPU reason=crashed code=1 suppressed=4'])

  const beatsBefore = dog.beats
  const shownBefore = dog.presence.length
  visible = false
  run(WINDOW_MS)
  check('a calm window writes nothing', (await lines()).filter((l) => l.startsWith('stall')).length, 0)
  check(
    'every sampler tick beats the watchdog, and presence goes to it once a second',
    [dog.beats - beatsBefore, dog.presence.length - shownBefore, dog.presence.at(-1)],
    [WINDOW_MS / SAMPLE_MS, WINDOW_MS / SAMPLE_MS / PUBLISH_EVERY, { focused: true, visible: false }]
  )
  visible = true

  const stallLines = async (): Promise<string[]> => (await lines()).filter((l) => l.startsWith('stall'))
  const blockedAt = now + SAMPLE_MS // the next tick was due here when main was held
  mono += 2_000 // main held for two seconds
  now += 2_000
  focused = false
  run(WINDOW_MS)
  const first = await stallLines()
  check(
    'a 2 s block is a stall line: when it began, whether a window had focus, whether one was shown',
    [first.length, first[0]?.replace(/p99=\d+/, 'p99=N')],
    [1, `stall max=2000 worstAt=${new Date(blockedAt).toISOString()} p99=N over=1 windows=1 focused=false visible=true`]
  )

  mono += 1_200
  now += 1_200
  focused = true
  run(WINDOW_MS)
  check('a stall inside the minute after the last line is held', (await stallLines()).length, 1)

  power.emit('suspend')
  check('suspend tells the watchdog the machine is going to sleep', dog.suspended, [true])
  run(3 * SAMPLE_MS)
  mono += 3_600_000 // asleep an hour, on a monotonic clock that kept counting
  now += 3_600_000
  tick?.()
  power.emit('resume')
  check('and resume that it woke', dog.suspended, [true, false])
  run(WINDOW_MS)
  const afterSleep = await lines()
  check(
    'sleep: suspend, resume with how long; the gap is no stall, and the held one goes out after',
    [
      afterSleep.filter((l) => l.startsWith('stall')).map((l) => l.split(' ')[1]),
      afterSleep.includes('suspend'),
      afterSleep.some((l) => /^resume asleep=36003\d\d$/.test(l))
    ],
    [['max=2000', 'max=1200'], true, true]
  )

  mono += 700
  now += 700
  run(WINDOW_MS)
  check('and the next one is held again', (await stallLines()).length, 2)
  // A stall in the window still in progress at quit: 1.5 s, three samples before quitting.
  mono += 1_500
  now += 1_500
  run(3 * SAMPLE_MS)
  app.emit('before-quit')
  app.emit('child-process-gone', {}, { type: 'Utility', reason: 'killed', exitCode: 15 })
  // A will-quit listener registered after diagnostics (selfUpdate's armSwapOnQuit): its work is still watched.
  let atLaterWillQuit: unknown = null
  app.on('will-quit', () => {
    atLaterWillQuit = [dog.stops, stopped, (fs.files.get(join('/ud', LOG_NAME)) ?? '').includes(' quit uptime=')]
  })
  app.emit('will-quit')
  check('a later will-quit listener runs with the watchdog and the sampler still on, and no quit line yet', atLaterWillQuit, [0, false, false])
  app.emit('quit')
  const end = (fs.files.get(join('/ud', LOG_NAME)) ?? '').split('\n').filter(Boolean).map((l) => l.slice(25))
  check(
    'quit: the held stall AND the window in progress folded into one line, then quit, before the process goes',
    [end.at(-2)?.split(' ').filter((f) => /^(max|over|windows)=/.test(f)), /^quit uptime=\d+$/.test(end.at(-1) ?? '')],
    [['max=1500', 'over=2', 'windows=2'], true]
  )
  check('helpers ending at quit are not crashes', end.some((l) => l.includes('reason=killed')), false)
  check('the sampler stops at quit', stopped, true)
  check("the watchdog thread is stopped at Electron's quit, once", dog.stops, 1)
  check('no line carries a path', end.some((l) => l.includes('/Users/')), false)
}

/* --------------------------------------------------- how the last run ended */

console.log('\nhow the run before ended, read from the log at start')

{
  const at = (ms: number): string => new Date(ms).toISOString()
  const S = Date.UTC(2026, 9, 27, 9, 0, 0)
  const tail = (lines: string[], whole = true) => ({ text: lines.map((l) => `${l}\n`).join(''), whole })
  check('no log yet: nothing to say', previousRun(tail([]), S), null)
  check(
    'its last line a quit: clean',
    previousRun(tail([`${at(S - 9e6)} start v=1`, `${at(S - 5e6)} quit uptime=4000`]), S),
    { clean: true, lastEvent: 'quit', lastAt: at(S - 5e6) }
  )
  check(
    'its last line the watchdog\'s main-stalled (a Force Quit): unclean, saying what and when',
    previousRun(tail([`${at(S - 9e6)} start v=1`, `${at(S - 6e6)} stall max=900`, `${at(S - 5e6)} main-stalled ms=2000`]), S),
    { clean: false, lastEvent: 'main-stalled', lastAt: at(S - 5e6) }
  )
  check(
    'a quit with a line landing after it (an append in flight at quit) is still clean',
    previousRun(tail([`${at(S - 9e6)} start v=1`, `${at(S - 5e6)} quit uptime=4000`, `${at(S - 5e6 + 3)} window-responsive win=1 after=10`]), S)?.clean,
    true
  )
  check(
    "a run held from boot and Force Quit before its start line landed (it waits on this read) leaves only its watchdog's line: unclean",
    previousRun(tail([`${at(S - 9e6)} start v=1`, `${at(S - 5e6)} quit uptime=4000`, `${at(S - 1e6)} main-stalled ms=2003`]), S),
    { clean: false, lastEvent: 'main-stalled', lastAt: at(S - 1e6) }
  )
  check(
    'a watchdog line written while the quit itself ran (within QUIT_SLACK_MS) is still clean',
    previousRun(tail([`${at(S - 9e6)} start v=1`, `${at(S - 5e6)} quit uptime=4000`, `${at(S - 5e6 + QUIT_SLACK_MS)} main-stalled ms=2003`]), S)?.clean,
    true
  )
  check(
    'a quit from the run BEFORE, then a start with no quit: unclean',
    previousRun(tail([`${at(S - 9e6)} quit uptime=1`, `${at(S - 8e6)} start v=1`, `${at(S - 7e6)} suspend`]), S),
    { clean: false, lastEvent: 'suspend', lastAt: at(S - 7e6) }
  )
  check(
    "this run's own lines (the watchdog may write before the read) are not the last run's: after a clean quit",
    previousRun(tail([`${at(S - 5e6)} quit uptime=1`, `${at(S)} main-stalled ms=2400`, `${at(S + 9)} main-recovered after=9000`]), S)?.clean,
    true
  )
  check(
    '…nor after an unclean end, whose last line stays its own',
    previousRun(tail([`${at(S - 9e6)} start v=1`, `${at(S - 5e6)} stall max=600`, `${at(S + 5)} main-stalled ms=2400`]), S),
    { clean: false, lastEvent: 'stall', lastAt: at(S - 5e6) }
  )
  check(
    'a tail cut mid-line drops its first, partial line; a torn last line is skipped',
    previousRun({ text: `quit uptime=1\n${at(S - 7e6)} stall max=600\n${at(S - 6e6).slice(0, 9)}`, whole: false }, S),
    { clean: false, lastEvent: 'stall', lastAt: at(S - 7e6) }
  )
  check(
    'a cut first line that still parses as a time (".123Z" reads as the year 123) is dropped too, never read as a quit',
    previousRun({ text: '.123Z quit uptime=1\n', whole: false }, S),
    null
  )

  const boot = (fs: ReturnType<typeof memFs>, startAt: number) => {
    const app = new EventEmitter()
    const power = new EventEmitter()
    const diag = startDiagnostics('/ud', {
      app,
      powerMonitor: power,
      about: { version: '2.0.0', electron: '43.2.0', os: 'darwin-26.0', arch: 'arm64', packaged: true },
      focused: () => false,
      visible: () => false,
      now: () => startAt,
      mono: () => 0,
      every: () => ({ stop: () => {} }),
      fs
    })
    const lines = async (): Promise<string[]> => {
      await diag.log.idle()
      return (fs.files.get(join('/ud', LOG_NAME)) ?? '').split('\n').filter(Boolean)
    }
    return { app, power, lines }
  }

  const crashed = memFs()
  crashed.files.set(join('/ud', LOG_NAME), `${at(S - 9e6)} start version=1.9\n${at(S - 5e6)} main-stalled ms=2101 focused=true visible=true\n`)
  const after = boot(crashed, S)
  check(
    'a start after a Force Quit says previous=unclean on its start line, with the last line it left',
    (await after.lines()).at(-1),
    `${at(S)} start version=2.0.0 electron=43.2.0 os=darwin-26.0 arch=arm64 packaged=true previous=unclean lastEvent=main-stalled lastAt=${at(S - 5e6)}`
  )
  check('the old log is read once, at start, as a tail', crashed.calls.filter((c) => c === 'tail').length, 1)

  const quit = memFs()
  quit.files.set(join('/ud', LOG_NAME), `${at(S - 9e6)} start version=1.9\n${at(S - 5e6)} quit uptime=4000\n`)
  check('after a clean quit the start line says nothing of it', (await boot(quit, S).lines()).at(-1), `${at(S)} start version=2.0.0 electron=43.2.0 os=darwin-26.0 arch=arm64 packaged=true`)

  const slow = memFs()
  let open: () => void = () => {}
  slow.tailGate = new Promise<void>((r) => (open = r))
  slow.files.set(join('/ud', LOG_NAME), `${at(S - 5e6)} stall max=700\n`)
  const held = boot(slow, S)
  held.power.emit('suspend')
  await new Promise((r) => setTimeout(r, 10))
  check('nothing of this run is appended before the old end is read', [slow.calls.includes('append'), slow.files.get(join('/ud', LOG_NAME))], [false, `${at(S - 5e6)} stall max=700\n`])
  open()
  const heldLines = await held.lines()
  check('then the start line goes first, and what was written meanwhile after it', heldLines.slice(1).map((l) => l.split(' ')[1]), ['start', 'suspend'])

  const never = memFs()
  never.tailGate = new Promise<void>(() => {})
  const quick = boot(never, S)
  quick.app.emit('will-quit')
  quick.app.emit('quit')
  check(
    'a quit before the read answers still writes the start line first (without previous), then quit',
    (never.files.get(join('/ud', LOG_NAME)) ?? '').split('\n').filter(Boolean).map((l) => l.split(' ')[1]),
    ['start', 'quit']
  )

  const dir = mkdtempSync(join(tmpdir(), 'stoke-freeze-tail-'))
  try {
    const file = join(dir, LOG_NAME)
    check('on the real file system: no file is an empty whole tail', await nodeLogFs.tail(file, TAIL_BYTES), { text: '', whole: true })
    await nodeLogFs.append(file, 'x'.repeat(TAIL_BYTES) + '\nlast line\n')
    const t = await nodeLogFs.tail(file, TAIL_BYTES)
    check('a longer file: its last TAIL_BYTES, marked as cut', [t.text.length, t.whole, t.text.endsWith('\nlast line\n')], [TAIL_BYTES, false, true])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------- the watchdog, on a fake clock */

console.log('\nthe watchdog rule, on a fake clock')

{
  const cfg = WATCHDOG_CONFIG
  const W = Date.UTC(2026, 9, 27, 7, 0, 0)
  const fresh = (t: number): WatchdogState => freshWatchdog(t)
  /** Tick on time from `from` to `to`; `beatAt(t)` is main's last beat then. The lines, with when each was said. */
  const drive = (s: WatchdogState, from: number, to: number, beatAt: (t: number) => number, flags = 0): Array<[number, string]> => {
    const out: Array<[number, string]> = []
    for (let t = from; t <= to; t += cfg.tickMs) {
      const line = watchdogStep(s, t, beatAt(t), flags, W + t, cfg)
      if (line) out.push([t, line])
    }
    return out
  }

  check('main beating: nothing, ever', drive(fresh(0), 250, 30_000, (t) => t - 40), [])

  const held = fresh(0)
  const said = drive(held, 250, 6_000, (t) => Math.min(t, 1_000))
  check(
    'main held from 1 s: main-stalled ONCE, the first tick its beat is stallMs old, while it is still held',
    said,
    [[3_000, formatLine(W + 3_000, 'main-stalled', { ms: 2_000 })]]
  )
  check(
    'and main-recovered when the beat moves, with how long it went without one',
    watchdogStep(held, 6_250, 6_200, 0, W + 6_250, cfg),
    formatLine(W + 6_250, 'main-recovered', { after: 5_200 })
  )
  check('then quiet again', drive(held, 6_500, 9_000, (t) => t - 10), [])

  const shown = fresh(0)
  check(
    'with presence published, the line says whether a window was focused, and whether one was shown',
    drive(shown, 250, 3_000, () => 900, FLAG_KNOWN | FLAG_FOCUSED).map(([, l]) => l),
    [formatLine(W + 3_000, 'main-stalled', { ms: 2_100, focused: true, visible: false })]
  )
  check(
    '(visible too)',
    drive(fresh(0), 250, 3_000, () => 900, FLAG_KNOWN | FLAG_VISIBLE).map(([, l]) => l.split(' ').slice(3).join(' ')),
    ['focused=false visible=true']
  )

  // Throttled: App Nap, a stopped process or a sleep holds the watchdog's own timer as well as main's.
  const napped = fresh(0)
  drive(napped, 250, 1_000, (t) => t - 40)
  check(
    'the whole process held 3 s (its own tick 3 s late, main\'s beat 3 s old): throttling, not a stall',
    [watchdogStep(napped, 4_250, 960, 0, W + 4_250, cfg), drive(napped, 4_500, 12_000, (t) => t - 40)],
    [null, []]
  )
  const nappedThenHeld = fresh(0)
  drive(nappedThenHeld, 250, 1_000, (t) => t - 40)
  watchdogStep(nappedThenHeld, 4_250, 960, 0, W + 4_250, cfg)
  check(
    'but a main STILL held a whole stallMs after the watchdog is back is a stall, said with its whole age',
    drive(nappedThenHeld, 4_500, 7_000, () => 960),
    [[6_250, formatLine(W + 6_250, 'main-stalled', { ms: 5_290 })]]
  )
  const late = fresh(0)
  drive(late, 250, 1_000, (t) => Math.min(t, 1_000))
  check(
    'a watchdog tick late by less than gapMs is not throttling: a held main is still said on time',
    [cfg.gapMs > 750, watchdogStep(late, 2_000, 1_000, 0, W, cfg), drive(late, 2_250, 3_500, () => 1_000).map(([t]) => t)],
    [true, null, [3_000]]
  )

  const asleep = fresh(0)
  check('main says the machine is going to sleep: an old beat is no stall', drive(asleep, 250, 8_000, () => 100, FLAG_SUSPENDED), [])
  check(
    'and after the flag clears, main gets a whole stallMs again',
    drive(asleep, 8_250, 11_000, () => 100).map(([t]) => t),
    [10_000]
  )

  // A main that keeps stalling and recovering: the thread's lines are held to a burst per window.
  /** Main held `heldMs` from `t0`, then beating for `calmMs`: the lines said, without their times. */
  const cycle = (s: WatchdogState, t0: number, heldMs: number, calmMs: number): string[] =>
    drive(s, t0 + cfg.tickMs, t0 + heldMs + calmMs, (t) => (t <= t0 + heldMs ? t0 : t - 10)).map(([, l]) => l.split(' ').slice(1).join(' '))
  const busy = fresh(0)
  let t0 = 0
  const first: string[] = []
  for (let i = 0; i < cfg.burst; i++, t0 += 3_500) first.push(...cycle(busy, t0, 2_500, 1_000))
  check(
    `a main held 2.5 s in every 3.5 s: its first ${cfg.burst} stalls are said, each with its recovery`,
    [first.length, first.filter((l) => l === 'main-stalled ms=2000').length, first.filter((l) => l === 'main-recovered after=2740').length],
    [2 * cfg.burst, cfg.burst, cfg.burst]
  )
  const quiet: string[] = []
  for (let i = 0; i < 3; i++, t0 += 3_500) quiet.push(...cycle(busy, t0, 2_500, 1_000))
  check('past the burst, a short stall and its recovery are held back', quiet, [])
  check(
    'but one held longMs is said after all (a hang heading for Force Quit), counting the short ones held back; then its recovery',
    [cfg.longMs < 10_000, cycle(busy, t0, 7_000, 1_000)],
    [true, [`main-stalled ms=${cfg.longMs} suppressed=3`, 'main-recovered after=7240']]
  )
  drive(busy, t0 + 8_000 + cfg.tickMs, cfg.windowMs + 60_000, (t) => t - 10)
  check(
    'once the window has passed, a short stall is said at stallMs again, with nothing left to count',
    cycle(busy, cfg.windowMs + 60_000, 2_500, 1_000),
    ['main-stalled ms=2000', 'main-recovered after=2740']
  )
}

/* ------------------------------------------------- the watchdog, for real */

console.log('\nthe watchdog thread, for real: this main thread held 3 s, a child process stopped whole 3 s')

{
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  /** A deadline that does not keep this process alive once nothing waits on it. */
  const deadline = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms).unref())
  const isWin = process.platform === 'win32'
  let compiles = true
  try {
    new Script(watchdogSource())
  } catch {
    compiles = false
  }
  check("the thread's program (strings and two stringified functions) compiles as a script", compiles, true)

  const dir = mkdtempSync(join(tmpdir(), 'stoke-freeze-wd-'))
  try {
    const own = join(dir, 'own.log')
    const link = startWatchdog(own)
    check('the thread starts', link !== null, true)
    const beating = setInterval(() => link?.beat(), SAMPLE_MS)
    link?.presence({ focused: true, visible: true })

    // The child: a watchdog on its own log, main beating, then (after the stop) a real 2.5 s stall of its own.
    // On SIGUSR2 its main holds 3.5 s by the wall clock, so the stop that follows lands inside the hold and
    // main beats again only ~0.4 s after SIGCONT: its thread ticks first and finds a beat 3 s old, the very
    // case the throttling rule must not call a stall (without the hold, main's beat often wins that race).
    const childLog = join(dir, 'child.log')
    const program = [
      "process.on('SIGUSR2', () => { const from = Date.now(); while (Date.now() - from < 3500) {} })",
      'const m = await import(process.env.WD_MODULE)',
      "const link = m.startWatchdog(process.env.WD_FILE, m.WATCHDOG_CONFIG, (why) => process.stdout.write('gone ' + why + '\\n'))",
      "if (!link) { process.stdout.write('no-thread\\n'); process.exit(3) }",
      'setInterval(() => link.beat(), 100).unref()',
      "process.stdout.write('ready\\n')",
      'setTimeout(() => { const from = Date.now(); while (Date.now() - from < 2500) {} }, 3400)'
    ].join('\n')
    const child = spawn(process.execPath, ['--input-type=module', '-e', program], {
      env: { ...process.env, WD_MODULE: pathToFileURL(join(root, 'src/main/diagnosticsLog.ts')).href, WD_FILE: childLog },
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)))
    let out = ''
    const ready = await Promise.race([
      new Promise<boolean>((resolve) => child.stdout.on('data', (d: Buffer) => {
        out += d.toString()
        if (out.includes('\n')) resolve(out.startsWith('ready'))
      })),
      deadline(15_000).then(() => false)
    ])
    check('the child process started its watchdog', ready, true)
    await sleep(300)

    if (!isWin) {
      process.kill(child.pid!, 'SIGUSR2')
      await sleep(100)
      process.kill(child.pid!, 'SIGSTOP')
    }
    const heldFrom = Date.now()
    while (Date.now() - heldFrom < 3_000) {
      /* this main thread held: its watchdog must say so while it is */
    }
    const heldUntil = Date.now()
    // Main rotates the log under the thread before it can write again: its next line must land in a new file.
    renameSync(own, `${own}.1`)
    if (!isWin) process.kill(child.pid!, 'SIGCONT')
    await sleep(700)
    clearInterval(beating)
    link?.stop()

    const read = (f: string): string[] => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [])
    const before = read(`${own}.1`)
    const stalled = before.filter((l) => l.split(' ')[1] === 'main-stalled')
    const ms = Number(/ ms=(\d+)/.exec(stalled[0] ?? '')?.[1])
    check(
      'held 3 s: main-stalled once, WHILE main was held, aged 2-3 s, with what main last published',
      [stalled.length, Date.parse((stalled[0] ?? '').split(' ')[0]) < heldUntil, ms >= 2_000 && ms < 3_000, (stalled[0] ?? '').endsWith(' focused=true visible=true')],
      [1, true, true, true]
    )
    const recovered = read(own)
    check(
      'main-recovered once main beats again, with how long it went without — in the NEW file (reopened per line, so a rotation mid-run is fine)',
      [recovered.length, recovered[0]?.split(' ')[1], Number(/ after=(\d+)/.exec(recovered[0] ?? '')?.[1]) >= 3_000],
      [1, 'main-recovered', true]
    )

    const code = await Promise.race([exited, deadline(10_000).then(() => 'hung' as const)])
    if (code === 'hung') child.kill('SIGTERM')
    check("the child exits by itself with its watchdog thread still running: the thread is unref'd", code, 0)
    const childStalls = read(childLog).filter((l) => l.split(' ')[1] === 'main-stalled')
    const childMs = childStalls.map((l) => Number(/ ms=(\d+)/.exec(l)?.[1]))
    check("the child's thread was alive: its own 2.5 s stall after the stop is said", childMs.some((m) => m >= 2_000 && m < 3_000), true)
    check("and never died (the child runs as ESM, whose eval'd Worker has no require)", out.split('\n').filter((l) => l.startsWith('gone')), [])
    if (isWin) {
      console.log('  (skipped: no SIGSTOP on Windows; the throttling rule is held on the fake clock above)')
    } else {
      check('stopped whole for 3 s (throttled, as App Nap or a sleep is): no stall said for it', childMs.filter((m) => m >= 3_000), [])
    }

    // A thread that dies on its own: a BigInt tickMs throws a TypeError in the thread's setInterval.
    // Without the Worker's error listener that error is thrown on main: this suite dies with exit 1,
    // and Electron's main shows its modal "A JavaScript error occurred".
    const gone: string[] = []
    const dying = startWatchdog(join(dir, 'dying.log'), { ...WATCHDOG_CONFIG, tickMs: 1n as unknown as number }, (why) => gone.push(why))
    const diedFrom = Date.now()
    while (gone.length === 0 && Date.now() - diedFrom < 2_000) await sleep(20)
    const saidWithin = Date.now() - diedFrom
    await sleep(200) // its exit event follows the error: still said once
    dying?.stop()
    check(
      "a thread that dies is said once, by its error's name, within a second, and this process lives on",
      [dying !== null, gone, saidWithin < 1_000],
      [true, ['TypeError'], true]
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------- what the modules import */

console.log('\nthe sources a suite loads, and the Electron wiring')

{
  for (const file of ['src/main/clipboardPeek.ts', 'src/main/diagnosticsLog.ts']) {
    const text = readFileSync(join(root, file), 'utf8')
    const specs = [...text.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((m) => m[1])
    check(
      `${file} imports by relative .ts path or node: only, never an alias (gotcha 78)`,
      specs.filter((x) => !(x.startsWith('node:') || (x.startsWith('.') && x.endsWith('.ts')))),
      []
    )
  }
  const wiring = readFileSync(join(root, 'src/main/diagnostics.ts'), 'utf8')
  check(
    'diagnostics.ts starts the watchdog thread and says whether a window is shown (not hidden, not minimized)',
    [wiring.includes('watchdog: (file, gone) => startWatchdog(file, WATCHDOG_CONFIG, gone)'), /visible: anyVisible/.test(wiring), /isVisible\(\) && !w\.isMinimized\(\)/.test(wiring)],
    [true, true, true]
  )
}

/* --------------------------------------------------------------- the wiring */

console.log('\nthe wiring in index.ts')

{
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  const ready = index.indexOf('app.whenReady().then(() => {')
  const install = index.indexOf('installDiagnostics()', ready)
  const secrets = index.indexOf('initSecretStore()', ready)
  check('installed in whenReady, before the secret store can block and before the first window', ready >= 0 && install > ready && install < secrets && install < index.indexOf('createWindow()', ready), true)
}

console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) FAILED.`}`)
process.exitCode = failures === 0 ? 0 : 1
