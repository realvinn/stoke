/*
 * The one list of what gets built, for whom, and on which machine.
 *
 * There used to be two: a `strategy.matrix.include` in the release workflow and
 * a set of `dist:*` scripts in package.json, each carrying its own copy of
 * `--win --x64` and friends. That is the defect this repo has already paid for
 * twice (scripts/ci-verify.mjs, CLAUDE.md gotcha 62), and it was already
 * drifting here: package.json carried `dist:win:arm64` and `dist:mac:intel`
 * for platforms CI had never built, so "what `npm run dist:*` produces" and
 * "what a release contains" were different answers with nothing to reconcile
 * them. The workflow reads its matrix out of this file (`--matrix`), and the
 * npm scripts resolve their flags out of it too (`--build <key>`), so they
 * cannot disagree.
 *
 * ONE ARCH PER JOB, ON A NATIVE RUNNER. This is the load-bearing constraint and
 * it is not an optimisation — it is the only arrangement that produces a
 * working terminal.
 *
 *   node_modules/@lydell/node-pty/index.js:1 is
 *     const PACKAGE_NAME = `@lydell/node-pty-${process.platform}-${process.arch}`
 *   and requirePlatformSpecificPackage() does `require(PACKAGE_NAME)`.
 *   verify:targets asserts both, so this premise cannot quietly stop holding.
 *
 * The .node binary is not in `@lydell/node-pty` at all; it lives in one of six
 * siblings declared as optionalDependencies, each carrying `os`/`cpu` fields.
 * npm installs only the one matching the BUILD HOST, so one npm tree holds
 * exactly one arch's pty and one electron-builder invocation can produce
 * exactly one working arch. `electron-builder --win --arm64` on an x64 runner
 * packages `node-pty-win32-x64`, installs, launches, and throws MODULE_NOT_FOUND
 * on the first `pty.start` — every tab dead, no build error, CI green. Splitting
 * a platform's two arches across two native runners is what avoids that, and
 * scripts/assert-packaged-pty.mjs is what turns a mistake here into a red job
 * instead of a silent one.
 *
 * `--mac --universal` is broken by the same fact and is deliberately absent:
 * app-builder-lib's doUniversalPack calls doPack twice from the SAME
 * node_modules, so both slices get whichever single node-pty-darwin-* package
 * is on disk and the other arch gets no sibling directory at all.
 *
 * Usage:
 *   node scripts/targets.mjs --list             human-readable
 *   node scripts/targets.mjs --matrix           one line of JSON for $GITHUB_OUTPUT
 *   node scripts/targets.mjs --args mac-arm64   the electron-builder flags
 *   node scripts/targets.mjs --build mac-arm64  run electron-builder with them
 */
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

/**
 * Environment a Windows arm64 build needs, whatever runs it. The installer's
 * payload is 7z, extracted at install time by NSIS's nsis7z plugin (19.00),
 * which predates the ARM64 branch filter 7-Zip 23+ picks by itself for ARM64
 * executables — so an arm64 installer built without this exits 0 and installs
 * nothing (the v0.9.9 one did; gotcha 102). BCJ is lossless and nsis7z reads
 * it. x64 needs nothing: its default, BCJ2, is one nsis7z reads. The release
 * workflow sets the same on its Windows build step, and
 * scripts/assert-nsis-payload.mjs reads the built installer back.
 */
export const WINDOWS_ARM64_BUILD_ENV = { ELECTRON_BUILDER_7Z_FILTER: 'BCJ' }

/** The environment `--build` adds for a target. */
export function buildEnvFor(target) {
  return target.platform === 'win32' && target.arch === 'arm64' ? WINDOWS_ARM64_BUILD_ENV : {}
}

/**
 * @typedef {object} Target
 * @property {string} key       stable id; the artifact name and the dist script both use it
 * @property {string} name      the GitHub Actions job name
 * @property {string} runner    the `runs-on` label
 * @property {string[]} args    electron-builder flags, in order
 * @property {NodeJS.Platform} platform  process.platform of the runner
 * @property {string} arch      process.arch of the runner
 * @property {string} script    the package.json script that builds this locally
 */

/** @type {Target[]} */
export const TARGETS = [
  {
    key: 'win-x64',
    name: 'Windows x64',
    runner: 'windows-latest',
    args: ['--win', '--x64'],
    platform: 'win32',
    arch: 'x64',
    script: 'dist:win',
  },
  {
    key: 'win-arm64',
    name: 'Windows arm64',
    // Not windows-latest with --arm64: that runner is x64, so npm ci fetches
    // node-pty-win32-x64 and the build ships a Surface installer with no
    // terminal. arm64 Windows runners went GA for public repos on 2025-08-07.
    runner: 'windows-11-arm',
    args: ['--win', '--arm64'],
    platform: 'win32',
    arch: 'arm64',
    script: 'dist:win:arm64',
  },
  {
    key: 'mac-arm64',
    name: 'macOS arm64',
    // The runner every release so far has been built on. Left alone on purpose:
    // it is the one mac image whose signing steps are measured rather than
    // assumed (see the release workflow's two LibreSSL/find-certificate traps).
    runner: 'macos-14',
    args: ['--mac', '--arm64'],
    platform: 'darwin',
    arch: 'arm64',
    script: 'dist:mac',
  },
  {
    key: 'mac-x64',
    name: 'macOS x64',
    // macos-13 has been retired from GitHub's runner list; macos-15-intel is
    // the current Intel label. Its keychain import has never run — flagged
    // loudly in the job itself rather than assumed to work.
    runner: 'macos-15-intel',
    args: ['--mac', '--x64'],
    platform: 'darwin',
    arch: 'x64',
    script: 'dist:mac:intel',
  },
  {
    key: 'linux-x64',
    name: 'Linux x64',
    runner: 'ubuntu-latest',
    args: ['--linux', '--x64'],
    platform: 'linux',
    arch: 'x64',
    script: 'dist:linux',
  },
]

/**
 * Platform/arch pairs `@lydell/node-pty` publishes a prebuilt for, and which of
 * them this repo deliberately does not build. Written out rather than inferred,
 * because "we chose not to" and "nobody noticed" look identical in a matrix —
 * and asserted against node-pty's own optionalDependencies by verify:targets,
 * so a pair that gains or loses a prebuilt cannot pass unremarked.
 */
export const NOT_BUILT = {
  'linux-arm64':
    'Out of scope this round. Linux x64 is itself unexercised — no Stoke build has ever run on ' +
    'Linux at all — so a second Linux arch would double a surface area nobody has booted once.',
}

/** @param {string} key */
export function targetFor(key) {
  return TARGETS.find((t) => t.key === key) ?? null
}

/**
 * The `{ include: [...] }` shape `strategy.matrix` consumes through fromJSON.
 * Emitted as one line because $GITHUB_OUTPUT is line-oriented.
 */
export function matrixJson() {
  return JSON.stringify({
    include: TARGETS.map(({ key, name, runner, args, platform, arch }) => ({
      key,
      name,
      runner,
      args: args.join(' '),
      platform,
      arch,
    })),
  })
}

/** The `@lydell/node-pty-<platform>-<arch>` a build for this target must contain. */
export function ptyPackageFor(target) {
  return `@lydell/node-pty-${target.platform}-${target.arch}`
}

function fail(message) {
  console.error(message)
  process.exit(1)
}

function resolve(key) {
  const target = targetFor(key)
  if (target) return target
  fail(
    `No build target named "${key}". Known targets: ${TARGETS.map((t) => t.key).join(', ')}.\n` +
      'Add it to scripts/targets.mjs — the workflow matrix and the dist:* scripts both read from there.'
  )
}

function main(argv) {
  if (argv.includes('--matrix')) {
    process.stdout.write(matrixJson() + '\n')
    return
  }

  const argsAt = argv.indexOf('--args')
  if (argsAt !== -1) {
    process.stdout.write(resolve(argv[argsAt + 1]).args.join(' ') + '\n')
    return
  }

  const buildAt = argv.indexOf('--build')
  if (buildAt !== -1) {
    const target = resolve(argv[buildAt + 1])
    // Everything after the key is passed through, so `npm run dist:mac --
    // --publish never` lands where it was written rather than wherever npm's
    // append-to-the-whole-string behaviour would have put it.
    const extra = argv.slice(buildAt + 2)
    const args = [...target.args, ...extra]
    console.log(`electron-builder ${args.join(' ')}`)
    const env = { ...process.env, ...buildEnvFor(target) }
    const run = spawnSync('npx', ['electron-builder', ...args], { stdio: 'inherit', shell: process.platform === 'win32', env })
    // A spawn that never started has `status: null` and its reason only in
    // `error`, so `run.status ?? 1` alone exits 1 having printed nothing at
    // all — the shape this repo keeps meeting (gotchas 46, 52): never make the
    // tool's own answer unreadable. electron-builder's own non-zero exits have
    // already printed through `stdio: 'inherit'`.
    if (run.error) {
      console.error(`Could not run electron-builder: ${run.error.message}`)
      process.exit(1)
    }
    process.exit(run.status ?? 1)
  }

  // --list, and the bare invocation, print the same thing: this file's whole
  // contents, so "what does a release contain" is one command away.
  console.log('Built by every release:\n')
  for (const t of TARGETS) {
    console.log(`  ${t.key.padEnd(10)} ${t.name.padEnd(14)} ${t.runner.padEnd(16)} electron-builder ${t.args.join(' ')}`)
    console.log(`  ${' '.repeat(10)} npm run ${t.script} — expects ${ptyPackageFor(t)}`)
  }
  console.log('\nDeliberately not built:\n')
  for (const [key, why] of Object.entries(NOT_BUILT)) console.log(`  ${key.padEnd(10)} ${why}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
