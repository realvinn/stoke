/*
 * Watch the campfire without an install.
 *
 *   node scripts/campfire-demo.mts                 # 12s fake download, this terminal's tier
 *   node scripts/campfire-demo.mts --mode=ansi16   # force a colour tier: truecolor|ansi256|ansi16|none
 *   node scripts/campfire-demo.mts --seconds=4
 *   node scripts/campfire-demo.mts --sweep         # every stage and flicker frame, stacked, no cursor moves
 *   node scripts/campfire-demo.mts --plain         # the degraded path's lines, exactly as a CI log gets them
 *
 * This exists because no pure suite can see the things that actually go wrong
 * here (gotcha 31): whether conhost renders the sequences at all, whether the
 * cursor comes back after Ctrl-C, and whether the canvas drifts when the
 * terminal scrolls at the bottom of the window. `--sweep` redirects cleanly, so
 * a Windows tester can be sent `node scripts/campfire-demo.mts --sweep > frames.txt`
 * and `type frames.txt`.
 *
 * It is a viewer, not the installer: it drives a fake byte counter rather than a
 * download. The redraw rules it demonstrates are the ones the installer must
 * use -- ESC[7A up, ESC[K per row, cursor restored FIRST in cleanup, and never
 * the alternate screen buffer, because an installer's last words ("installed
 * to /Applications/Stoke.app") are the product and the alternate buffer erases
 * the whole transcript on exit.
 */
import {
  CANVAS,
  ESC,
  FRAME_MS,
  HEARTH,
  STAGES,
  colorMode,
  decileOf,
  frameFor,
  paint,
  plainProgress,
  renderPlan,
  stageFor,
  type ColorMode
} from '../src/shared/campfire.ts'

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (hit === undefined) return undefined
  const eq = hit.indexOf('=')
  return eq < 0 ? '' : hit.slice(eq + 1)
}

const term = {
  isTty: process.stdout.isTTY === true,
  platform: process.platform,
  rows: process.stdout.rows,
  cols: process.stdout.columns
}
const forced = flag('mode') as ColorMode | undefined
const mode: ColorMode = forced ?? colorMode(process.env, term)
const write = (s: string): void => {
  process.stdout.write(s)
}

if (flag('sweep') !== undefined) {
  // Every frame, top to bottom, so one screen (or one file) shows the whole set.
  for (const stage of STAGES) {
    for (let f = 0; f < stage.frames.length; f++) {
      write(`${stage.name} ${'abc'[f]}\n`)
      write(paint([...stage.frames[f], ...HEARTH], mode) + '\n\n')
    }
  }
  process.exit(0)
}

if (flag('plain') !== undefined) {
  // The degraded path. Append-only, one line per decile, no \r and no escape byte.
  const total = 86_100_000
  write('Stoke installer\n')
  write(`downloading    ${(total / 1e6).toFixed(1)} MB\n`)
  let last = -1
  const emit = (got: number): void => {
    const line = plainProgress(got, total, last)
    if (line !== null) {
      write(line + '\n')
      last = decileOf(got, total)
    }
  }
  // 137 ticks, as a real 17-second download at 8 fps would produce.
  for (let i = 0; i <= 137; i++) emit(Math.min(total, Math.round((total * i) / 137)))
  // And once more when it finishes: the 100% line belongs to the download being
  // over, not to a tick happening to land on the last byte.
  emit(total)
  write('verifying      sha256 ok\n')
  write('done           Stoke 0.9.4\n')
  process.exit(0)
}

const plan = renderPlan(process.env, term)
if (!plan.animate && forced === undefined) {
  console.error(`no animation: ${plan.reason}. Run with --plain to see what an install prints instead.`)
  process.exit(0)
}

const seconds = Number(flag('seconds') ?? 12)
const total = 86_100_000
let cleaned = false
const cleanup = (): void => {
  if (cleaned) return
  cleaned = true
  // Cursor FIRST, before anything else that could itself fail. Unconditional,
  // because this path only runs when the cursor was hidden.
  write(`${ESC}[?25h${ESC}[0m`)
}
process.on('exit', cleanup)
process.on('SIGINT', () => {
  cleanup()
  process.exit(130)
})

write(`${ESC}[?25l`)
// Make the block exist before drawing into it, so any scrolling has already
// happened and "up 7" is correct from the first frame onwards.
write('\n'.repeat(CANVAS.rows))

const started = Date.now()
let tick = 0
const timer = setInterval(() => {
  const elapsed = (Date.now() - started) / 1000
  const progress = Math.min(1, elapsed / seconds)
  const rows = frameFor(progress, tick)
  // Up 7, then each row prefixed with erase-in-line: 3 bytes instead of padding
  // to the full width, and correct whatever the window is. Paint the whole
  // frame in one call -- a row's colour depends on WHICH row it is, so painting
  // them one at a time would make every row row 0.
  const painted = paint(rows, mode)
    .split('\n')
    .map((r) => `${ESC}[K${r}`)
    .join('\n')
  write(`${ESC}[${CANVAS.rows}A${painted}\n`)
  tick++
  if (progress >= 1) {
    clearInterval(timer)
    cleanup()
    const got = (total / 1e6).toFixed(1)
    write(`\n  ${stageFor(progress)} - ${got} MB - ${tick} frames at ${FRAME_MS}ms, tier ${mode}\n`)
  }
}, FRAME_MS)
