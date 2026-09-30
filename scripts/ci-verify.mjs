/*
 * Runs, in CI, every verify suite that `npm run check` runs — derived from the
 * chain itself rather than transcribed beside it.
 *
 * The release workflow used to carry a hand-written list of twenty `- run:`
 * lines with a comment telling the next person to keep it in step with
 * package.json. That instruction was already being ignored when it was written
 * (four suites had drifted out), it was fixed once by hand in 36d491f, and
 * within two days it had drifted again by exactly the same mechanism: three
 * commits each added a suite to the `check` chain and none of them knew a
 * second file existed. verify:theme-gen, verify:drop and verify:remote were
 * all in `check` and none of them ran in the gate that gates a release — so a
 * regression in the theme generator's byte-for-byte reproduction, in the
 * shell-quoting of a dropped filename, or in where the phone link points would
 * fail locally and publish anyway.
 *
 * Two files that must agree, updated by hand, is the defect. There is only one
 * list now, and it is the one the developer already has to edit. A suite added
 * to `check` runs here on the next push with no second edit; a suite removed
 * from `check` stops running here for the same reason.
 *
 * The exclusions are still hand-written, because each is a judgement rather
 * than a fact — but they are ASSERTED against the chain, so an exclusion that
 * names a suite the chain no longer runs is an error rather than a line nobody
 * notices. That is the same failure this script exists to remove, one level up.
 *
 * A suite that needs a display is NOT an exclusion: whether one exists is a
 * fact about the runner, so it is decided per run rather than written down.
 * Which suites need one is derived too — a `check` suite whose script starts
 * Electron opens windows — so a new Electron suite gets a display, or an
 * honest skip, with no edit here. On Linux without a DISPLAY it runs under
 * `xvfb-run -a`; with neither it is skipped and says so. verify:selection was
 * kept out of CI from the day it was written (fcb4dc9, "needs a display"), and
 * so ran only on a Mac — which is how it came to pass only there while its own
 * comments called it portable (gotcha 113).
 *
 *   npm run verify:ci                          run the plan
 *   npm run verify:ci -- --list                print it, run nothing
 *   npm run verify:ci -- --list --platform linux   the plan as a Linux runner
 *                                              would resolve it, from here
 */
import { execFileSync, execSync } from 'node:child_process'
import { accessSync, constants, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { delimiter, dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Why a suite in `check` does not run here. About the runner, not about the
 * suite being unimportant — each still runs in `npm run check` on a
 * developer's machine.
 */
const EXCLUDED = {
  'verify:context':
    'reads the real transcripts in ~/.claude/projects, which a clean runner does not have. ' +
    'Its value is that it runs against real data, so synthesising fixtures would delete the reason it exists.',
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const chain = pkg.scripts?.check
if (typeof chain !== 'string') {
  console.error('package.json has no `check` script to read the suite list out of.')
  process.exit(1)
}

// The chain is `npm run a && npm run b && ... && npm run build`. Take the
// verify:* names in the order they are written, so CI fails in the same order a
// developer's own run would. The character class is also what makes a name
// safe to hand a shell on Windows below.
const suites = [...chain.matchAll(/npm run (verify:[a-z0-9-]+)/g)].map((m) => m[1])

if (suites.length === 0) {
  console.error('Parsed no verify suites out of the `check` chain. The chain format must have changed:\n  ' + chain)
  process.exit(1)
}

// An exclusion for a suite that is no longer in the chain is stale, and a stale
// exclusion is how a list starts lying. Fail rather than skip nothing quietly.
const stale = Object.keys(EXCLUDED).filter((name) => !suites.includes(name))
if (stale.length) {
  console.error(
    `These suites are excluded from CI but are no longer in the \`check\` chain: ${stale.join(', ')}.\n` +
      'Remove the exclusion, or restore the suite. An exclusion that names nothing hides the next drift.'
  )
  process.exit(1)
}

const missing = suites.filter((name) => !pkg.scripts?.[name])
if (missing.length) {
  console.error(`The \`check\` chain runs scripts that do not exist: ${missing.join(', ')}.`)
  process.exit(1)
}

// `--platform` resolves the plan as another OS would. Only for `--list`: a run
// is always this machine's, and a display route chosen for another platform
// would be a lie about what executed.
const listOnly = process.argv.includes('--list')
const platformArg = (() => {
  const at = process.argv.findIndex((a) => a === '--platform' || a.startsWith('--platform='))
  if (at === -1) return null
  const arg = process.argv[at]
  return arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : (process.argv[at + 1] ?? '')
})()
if (platformArg !== null && !listOnly) {
  console.error('--platform only changes what `--list` prints; a run always resolves against this machine.')
  process.exit(1)
}
if (platformArg !== null && !['darwin', 'win32', 'linux'].includes(platformArg)) {
  console.error(`--platform takes darwin, win32 or linux (process.platform's spelling), not "${platformArg}".`)
  process.exit(1)
}
const platform = platformArg ?? process.platform

/** A suite needs a display when its own script starts Electron. */
const needsDisplay = (name) => /^electron\s/.test(pkg.scripts[name])

/** The first executable `name` on PATH, or null. POSIX only — its one caller is. */
function onPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const file = join(dir, name)
    try {
      accessSync(file, constants.X_OK)
      return file
    } catch {
      /* not here */
    }
  }
  return null
}

/**
 * How a suite that needs a display runs on `platform`: as is, under
 * `xvfb-run -a`, or not at all — each with the reason `--list` prints.
 *
 * macOS and Windows runners have a desktop session, so a window opens. Linux
 * uses a DISPLAY (or Wayland socket) when one is set, which is a developer's
 * desktop; a CI runner sets neither, and that is the case xvfb is for.
 */
function displayRoute() {
  if (platform === 'darwin' || platform === 'win32') {
    return { how: 'run', why: 'the desktop session is the display' }
  }
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) {
    return { how: 'run', why: `a display is set (${process.env.DISPLAY ? `DISPLAY=${process.env.DISPLAY}` : 'WAYLAND_DISPLAY'})` }
  }
  const xvfb = onPath('xvfb-run')
  if (xvfb) return { how: 'xvfb', why: `no DISPLAY, so it runs under ${xvfb} -a` }
  return {
    how: 'skip',
    why: 'no DISPLAY and no xvfb-run on PATH. It opens a real Electron window; install xvfb (the CI workflow does).',
  }
}

/** Each suite in chain order, with how it runs here and, where not plainly, why. */
const plan = suites.map((name) => {
  if (name in EXCLUDED) return { name, how: 'skip', why: EXCLUDED[name] }
  if (needsDisplay(name)) return { name, ...displayRoute() }
  return { name, how: 'run', why: null }
})

// `--list` resolves the plan and stops, so the derivation can be inspected
// without paying for a full run — and so a reviewer can see what a push would
// actually execute.
if (listOnly) {
  console.log(`from \`check\`: ${suites.length} suites, resolved for ${platform}`)
  for (const step of plan) console.log(`  ${step.how.padEnd(4)}  ${step.name}`)
  const explained = plan.filter((step) => step.why)
  if (explained.length) console.log('')
  for (const step of explained) console.log(`  ${step.name}: ${step.why}`)
  process.exit(0)
}

const toRun = plan.filter((step) => step.how !== 'skip')

console.log(`Running ${toRun.length} of the ${suites.length} verify suites in \`npm run check\`.\n`)
for (const step of plan.filter((s) => s.how === 'skip')) console.log(`  skipped  ${step.name} — ${step.why}\n`)
for (const step of plan.filter((s) => s.how === 'xvfb')) console.log(`  xvfb     ${step.name} — ${step.why}\n`)

/*
 * One suite, as `npm run <name>`.
 *
 * On Windows `npm` is `npm.cmd`, which execFile cannot start: without a shell
 * it finds no `npm.exe` (ENOENT), and Node refuses to spawn a .cmd directly at
 * all since the April 2024 fix for CVE-2024-27980. So Windows goes through the
 * shell, with a command line built only from a name the chain regex above
 * limited to [a-z0-9:-]. This script never ran on Windows before the CI legs
 * that now call it there.
 *
 * Xvfb's own default screen is 8 bits deep; Chromium wants 24.
 */
function runSuite(step) {
  const opts = { cwd: root, stdio: 'inherit' }
  if (step.how === 'xvfb') {
    execFileSync('xvfb-run', ['-a', '-s', '-screen 0 1280x1024x24', 'npm', 'run', step.name], opts)
  } else if (process.platform === 'win32') {
    execSync(`npm run ${step.name}`, opts)
  } else {
    execFileSync('npm', ['run', step.name], opts)
  }
}

let failed = null
for (const step of toRun) {
  console.log(`\n─── ${step.name} ${'─'.repeat(Math.max(0, 60 - step.name.length))}`)
  try {
    runSuite(step)
  } catch {
    failed = step.name
    break
  }
}

if (failed) {
  console.error(`\n${failed} failed.`)
  process.exit(1)
}
console.log(`\nAll ${toRun.length} suites passed.`)
