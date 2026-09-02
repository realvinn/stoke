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
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Why a suite in `check` does not run here. Both are about the runner, not
 * about the suite being unimportant — each still runs in `npm run check` on a
 * developer's machine.
 */
const EXCLUDED = {
  'verify:context':
    'reads the real transcripts in ~/.claude/projects, which a clean runner does not have. ' +
    'Its value is that it runs against real data, so synthesising fixtures would delete the reason it exists.',
  'verify:selection':
    'opens a real Electron BrowserWindow to drive xterm\'s own DOM event handling. ' +
    'A Linux runner has no display, so it needs xvfb wiring rather than a line in a list.',
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const chain = pkg.scripts?.check
if (typeof chain !== 'string') {
  console.error('package.json has no `check` script to read the suite list out of.')
  process.exit(1)
}

// The chain is `npm run a && npm run b && ... && npm run build`. Take the
// verify:* names in the order they are written, so CI fails in the same order a
// developer's own run would.
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

const toRun = suites.filter((name) => !(name in EXCLUDED))

// `--list` resolves the plan and stops, so the derivation can be inspected
// without paying for a full run — and so a reviewer can see what a push would
// actually execute.
if (process.argv.includes('--list')) {
  console.log(`from \`check\`: ${suites.length} suites`)
  for (const name of suites) console.log(`  ${name in EXCLUDED ? 'skip' : 'run '}  ${name}`)
  process.exit(0)
}

console.log(`Running ${toRun.length} of the ${suites.length} verify suites in \`npm run check\`.\n`)
for (const [name, why] of Object.entries(EXCLUDED)) console.log(`  skipped  ${name} — ${why}\n`)

let failed = null
for (const name of toRun) {
  console.log(`\n─── ${name} ${'─'.repeat(Math.max(0, 60 - name.length))}`)
  try {
    execFileSync('npm', ['run', name], { cwd: root, stdio: 'inherit' })
  } catch {
    failed = name
    break
  }
}

if (failed) {
  console.error(`\n${failed} failed.`)
  process.exit(1)
}
console.log(`\nAll ${toRun.length} suites passed.`)
