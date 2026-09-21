/*
 * What a release is made of, and whether the three places that have to agree
 * about it still do.
 *
 * The defect this guards is not a broken build — it is a build that succeeds
 * and ships a dead terminal. `@lydell/node-pty` resolves
 * `"@lydell/node-pty-" + process.platform + "-" + process.arch` at RUNTIME, and
 * npm only ever installs the sibling matching the build host, so
 * `electron-builder --win --arm64` on an x64 runner produces an installer that
 * builds, installs, launches and throws MODULE_NOT_FOUND on the first
 * `pty.start`. There is no build-time error anywhere in that sequence.
 *
 * So the rules asserted here are: every target's runner is NATIVE for the arch
 * it builds; the workflow and the dist:* scripts both resolve their flags from
 * scripts/targets.mjs rather than carrying their own copies; and every
 * platform/arch node-pty publishes a prebuilt for is either built or named as
 * deliberately unbuilt — the same shape as ci-verify.mjs's asserted exclusion
 * list, for the same reason (CLAUDE.md gotcha 62).
 *
 *   node scripts/verify-targets.mts
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import { TARGETS, NOT_BUILT, buildEnvFor, matrixJson, ptyPackageFor, targetFor } from './targets.mjs'
import { auditPty, findPtyDirs } from './assert-packaged-pty.mjs'

const require = createRequire(import.meta.url)
const root = new URL('../', import.meta.url)
const read = (name: string) => readFileSync(fileURLToPath(new URL(name, root)), 'utf8')

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  )
}
function ok(name: string, cond: boolean): void {
  check(name, cond, true)
}

const pkg = JSON.parse(read('package.json'))
const workflow = read('.github/workflows/release.yml')
const builderConfig = read('electron-builder.yml')

// ---------------------------------------------------------------------------

console.log('\nthe target list is well formed')

check('every target has every field', TARGETS.filter((t) => !t.key || !t.name || !t.runner || !t.args?.length || !t.platform || !t.arch || !t.script).map((t) => t.key), [])
check('keys are unique, because the artifact name is keyed on them', new Set(TARGETS.map((t) => t.key)).size, TARGETS.length)
check('job names are unique, because a matrix with two identical names is unreadable in the UI', new Set(TARGETS.map((t) => t.name)).size, TARGETS.length)
check('targetFor finds each of them', TARGETS.map((t) => targetFor(t.key)?.key), TARGETS.map((t) => t.key))
check('and nothing else', targetFor('mac-universal'), null)

const PLATFORM_FLAG: Record<string, string> = { win32: '--win', darwin: '--mac', linux: '--linux' }
check(
  "each target's platform flag matches the platform it claims",
  TARGETS.filter((t) => t.args[0] !== PLATFORM_FLAG[t.platform]).map((t) => t.key),
  []
)
check(
  'and its arch flag matches the arch it claims',
  TARGETS.filter((t) => t.args[1] !== `--${t.arch}`).map((t) => t.key),
  []
)
check(
  'no target passes two arches — one invocation can only ever produce one working arch',
  TARGETS.filter((t) => t.args.length !== 2).map((t) => t.key),
  []
)
check(
  'and none asks for --universal, which app-builder-lib packs twice from one node_modules',
  TARGETS.filter((t) => t.args.includes('--universal')).map((t) => t.key),
  []
)

// ---------------------------------------------------------------------------
// The assertion that stops a silently broken terminal.

console.log('\nevery runner is native for the arch it builds')

/**
 * GitHub-hosted runner labels, and what CPU each actually has. The whole point
 * of the table: `windows-latest` is x64, so pairing it with `--arm64` is the
 * mistake that has no build error. arm64 Linux/Windows runners went GA for
 * public repos on 2025-08-07; macos-13 has been retired, so Intel macOS is
 * macos-15-intel / macos-26-intel.
 */
const RUNNERS: Record<string, { platform: string; arch: string }> = {
  'windows-latest': { platform: 'win32', arch: 'x64' },
  'windows-2022': { platform: 'win32', arch: 'x64' },
  'windows-2025': { platform: 'win32', arch: 'x64' },
  'windows-11-arm': { platform: 'win32', arch: 'arm64' },
  'macos-14': { platform: 'darwin', arch: 'arm64' },
  'macos-15': { platform: 'darwin', arch: 'arm64' },
  'macos-26': { platform: 'darwin', arch: 'arm64' },
  'macos-latest': { platform: 'darwin', arch: 'arm64' },
  'macos-15-intel': { platform: 'darwin', arch: 'x64' },
  'macos-26-intel': { platform: 'darwin', arch: 'x64' },
  'ubuntu-latest': { platform: 'linux', arch: 'x64' },
  'ubuntu-22.04': { platform: 'linux', arch: 'x64' },
  'ubuntu-24.04': { platform: 'linux', arch: 'x64' },
  'ubuntu-22.04-arm': { platform: 'linux', arch: 'arm64' },
  'ubuntu-24.04-arm': { platform: 'linux', arch: 'arm64' },
}

check(
  'every runner label is one GitHub publishes',
  TARGETS.filter((t) => !(t.runner in RUNNERS)).map((t) => `${t.key}: ${t.runner}`),
  []
)
check(
  'and it runs the target platform',
  TARGETS.filter((t) => RUNNERS[t.runner]?.platform !== t.platform).map((t) => `${t.key}: ${t.runner}`),
  []
)
check(
  'and the target ARCH — a cross-arch build ships a terminal that throws MODULE_NOT_FOUND',
  TARGETS.filter((t) => RUNNERS[t.runner]?.arch !== t.arch).map((t) => `${t.key}: ${t.runner} is ${RUNNERS[t.runner]?.arch}`),
  []
)
check('macos-13 is gone from the runner list and must not come back', 'macos-13' in RUNNERS, false)

// ---------------------------------------------------------------------------

console.log('\nnode-pty coverage — built, or deliberately not')

// Read off disk rather than required: @lydell/node-pty's "exports" map does
// not expose ./package.json.
const ptyPkg = JSON.parse(read('node_modules/@lydell/node-pty/package.json'))
const publishedPrebuilts = Object.keys(ptyPkg.optionalDependencies ?? {})
  .filter((name) => name.startsWith('@lydell/node-pty-'))
  .sort()

// The premise of the whole one-arch-per-job design, asserted rather than
// remembered: the binary is chosen from process.platform/process.arch when the
// app RUNS, not when it is built. If node-pty ever stops doing this, the matrix
// could collapse back to one job per platform — and this is the line that would
// say so instead of the constraint quietly outliving its reason.
const ptyIndex = read('node_modules/@lydell/node-pty/index.js')
check(
  'node-pty still picks its binary from process.platform/process.arch at runtime',
  /PACKAGE_NAME\s*=\s*`@lydell\/node-pty-\$\{process\.platform\}-\$\{process\.arch\}`/.test(ptyIndex),
  true
)
check('and still loads it by that name rather than by a bundled path', /require\(PACKAGE_NAME\)/.test(ptyIndex), true)
check('and still publishes six prebuilts, one per platform/arch', publishedPrebuilts.length, 6)
check(
  "each target's expected prebuilt is one node-pty actually publishes",
  TARGETS.filter((t) => !publishedPrebuilts.includes(ptyPackageFor(t))).map((t) => ptyPackageFor(t)),
  []
)

const covered = new Set(TARGETS.map((t) => t.key))
const excluded = new Set(Object.keys(NOT_BUILT))
const asKey = (pkgName: string) => {
  const [, platform, arch] = /^@lydell\/node-pty-(win32|darwin|linux)-(x64|arm64)$/.exec(pkgName) ?? []
  return platform === 'win32' ? `win-${arch}` : `${platform === 'darwin' ? 'mac' : platform}-${arch}`
}
check(
  'every prebuilt node-pty publishes is either built or named in NOT_BUILT',
  publishedPrebuilts.map(asKey).filter((key) => !covered.has(key) && !excluded.has(key)),
  []
)
check(
  'and NOT_BUILT names nothing that is in fact built — a stale exclusion is how a list starts lying',
  [...excluded].filter((key) => covered.has(key)),
  []
)
check(
  'each NOT_BUILT entry says why, rather than merely existing',
  Object.entries(NOT_BUILT).filter(([, why]) => !why || why.length < 30).map(([key]) => key),
  []
)

// ---------------------------------------------------------------------------

console.log('\nthe dist:* scripts and the matrix cannot drift apart')

const distScripts = Object.keys(pkg.scripts).filter((name) => name.startsWith('dist:'))
check(
  'every target has a dist script',
  TARGETS.filter((t) => !distScripts.includes(t.script)).map((t) => t.script),
  []
)
check(
  'every dist script belongs to a target — no orphan building something CI never does',
  distScripts.filter((name) => !TARGETS.some((t) => t.script === name)),
  []
)
check(
  'and each resolves its flags through targets.mjs rather than repeating them',
  distScripts.filter((name) => !new RegExp(`targets\\.mjs --build ${TARGETS.find((t) => t.script === name)?.key}(\\s|$)`).test(pkg.scripts[name])),
  []
)
check(
  'no dist script spells out an electron-builder platform flag of its own',
  distScripts.filter((name) => /--(win|mac|linux|x64|arm64|universal)\b/.test(pkg.scripts[name])),
  []
)

const matrix = JSON.parse(matrixJson())
check('--matrix is one JSON object with an include array', Array.isArray(matrix.include), true)
check('with one entry per target', matrix.include.length, TARGETS.length)
check('carrying the flags as one string, which is what the run step interpolates', matrix.include.map((m: any) => m.args), TARGETS.map((t) => t.args.join(' ')))
check('and it is a single line, because $GITHUB_OUTPUT is line-oriented', matrixJson().includes('\n'), false)

// ---------------------------------------------------------------------------

console.log('\nthe workflow reads the matrix rather than keeping its own')

// Parsed rather than grepped. A regex over YAML cannot tell a step from a
// comment describing one, and three of the assertions below are about the
// ABSENCE of something, where a comment mentioning it would read as presence.
let wf: any
try {
  wf = require('js-yaml').load(workflow)
} catch (error) {
  failures++
  console.log(`  FAIL  .github/workflows/release.yml does not parse as YAML: ${String(error)}`)
  wf = { jobs: {} }
}

const jobs = wf.jobs ?? {}
// js-yaml reads the key `on:` as the boolean true, YAML 1.1 style.
const triggers = wf.on ?? wf[true as unknown as string] ?? {}
const stepsOf = (id: string) => (jobs[id]?.steps ?? []) as any[]
const runsOf = (id: string) => stepsOf(id).map((s) => String(s.run ?? '')).join('\n')

check('the five jobs are there and named', Object.keys(jobs), ['verify', 'prepare', 'build', 'publish', 'winget'])
check('build waits for both the gate and the matrix', jobs.build?.needs, ['verify', 'prepare'])
check('publish waits for every build leg', jobs.publish?.needs, 'build')
check('prepare publishes the matrix as an output', jobs.prepare?.outputs?.matrix, '${{ steps.targets.outputs.matrix }}')
check('and computes it by running targets.mjs', /targets\.mjs --matrix/.test(runsOf('prepare')), true)
check('build consumes that output', jobs.build?.strategy?.matrix, '${{ fromJSON(needs.prepare.outputs.matrix) }}')
check("fail-fast stays off, so one dead platform does not delete the others' artifacts", jobs.build?.strategy?.['fail-fast'], false)
check('the job name and the runner both come from the matrix', [jobs.build?.name, jobs.build?.['runs-on']], ['${{ matrix.name }}', '${{ matrix.runner }}'])

const upload = stepsOf('build').find((s) => String(s.uses ?? '').startsWith('actions/upload-artifact'))
check(
  'artifacts are named per target key, not per runner — two mac jobs would share a runner-derived name',
  upload?.with?.name,
  'installers-${{ matrix.key }}'
)
check('and the upload globs cover every format the matrix can produce', ['exe', 'dmg', 'zip', 'AppImage', 'blockmap', 'latest*.yml'].filter((ext) => !String(upload?.with?.path ?? '').includes(ext)), [])

// Every ${{ matrix.X }} the workflow reads has to be a field targets.mjs
// actually emits, or the step silently interpolates an empty string.
const matrixEntry = JSON.parse(matrixJson()).include[0]
const referenced = [...new Set([...workflow.matchAll(/\$\{\{\s*matrix\.([a-zA-Z0-9_]+)\s*\}\}/g)].map((m) => m[1]))].sort()
check('every matrix field the workflow reads is one targets.mjs emits', referenced.filter((f) => !(f in matrixEntry)), [])
check('and the fields it reads are the ones worth emitting', referenced, ['args', 'key', 'name', 'runner'])

check(
  'no electron-builder platform flag is written out in the workflow — that would be the second list',
  /npx electron-builder\s+--(win|mac|linux)/.test(runsOf('build')),
  false
)
check('every build job asserts what node-pty it actually packaged', /assert-packaged-pty\.mjs \$\{\{ matrix\.key \}\}/.test(runsOf('build')), true)

const download = stepsOf('publish').find((s) => String(s.uses ?? '').startsWith('actions/download-artifact'))
check('the publish job downloads every build artifact', download?.with?.pattern, 'installers-*')
check(
  'and NOT with merge-multiple, which silently flattens two latest.yml into one',
  'merge-multiple' in (download?.with ?? {}),
  false
)
check('it checks the repo out, since the merger lives there', stepsOf('publish').some((s) => String(s.uses ?? '').startsWith('actions/checkout')), true)
check('it merges the manifests', /merge-update-manifests\.mjs dist --out release-assets/.test(runsOf('publish')), true)
check('gates on the merged result', /check-release-assets\.mjs release-assets/.test(runsOf('publish')), true)
check('and uploads the merged directory, never the raw download tree', /gh release create "\$TAG" release-assets\/\*/.test(runsOf('publish')), true)
check('nothing publishes from dist/', /gh release create [^\n]*\bdist\/\*/.test(runsOf('publish')), false)

// ORDER, not just presence, and the distinction is the whole of it: a gate that
// runs after `gh release create` is not a gate, it is a post-mortem — the
// release is already on the page, already being fetched by every installed
// copy's updater, and the red job changes none of that. The three steps were
// asserted only to EXIST until a reviewer moved the gate below the publish step
// and this suite stayed green.
const publishRuns = stepsOf('publish').map((s) => String(s.run ?? ''))
const stepWith = (re: RegExp) => publishRuns.findIndex((r) => re.test(r))
const mergeAt = stepWith(/merge-update-manifests\.mjs/)
const portableAt = stepWith(/add-portable-to-manifest\.mjs release-assets/)
const gateAt = stepWith(/check-release-assets\.mjs/)
const createAt = stepWith(/gh release create/)
check('each of the four publish steps is actually there', [mergeAt, portableAt, gateAt, createAt].some((i) => i === -1), false)
check('the merge runs before the gate, which has nothing to read otherwise', mergeAt < gateAt, true)
/*
 * The portable zips are listed AFTER the merge — each job's manifest has to
 * stay electron-builder's own output for verify:manifests' oracle to mean
 * anything, and before the merge there is no single latest.yml to add to — and
 * BEFORE the gate, which refuses a Windows feed with no zip for an arch. Either
 * order swapped is a red release, or worse, a green one with no portable feed.
 */
check('the portable zips are listed after the merge', mergeAt < portableAt, true)
check('and before the gate, which requires them', portableAt < gateAt, true)
check('and the gate runs BEFORE the release is created, or it is a post-mortem', gateAt < createAt, true)

console.log('\nthe winget job')

/*
 * `needs: publish`, inside this workflow, and not a separate workflow on
 * `release: published`: a release created with GITHUB_TOKEN triggers no other
 * workflow, so that one would never run. And stable tags only — winget has no
 * prerelease channel, and the publish job marks a hyphenated tag as one.
 */
const winget = jobs.winget ?? {}
check('it waits for the publish job, so it only ever submits a release that passed the gate', winget.needs, 'publish')
check(
  'and runs only for a stable tag — a hyphen is a prerelease',
  winget.if,
  "startsWith(github.ref, 'refs/tags/') && !contains(github.ref_name, '-')"
)
const wingetRuns = stepsOf('winget').map((s) => String(s.run ?? ''))
const wingetStep = (re: RegExp) => wingetRuns.findIndex((r) => re.test(r))
const tokenAt = wingetStep(/WINGET_TOKEN/)
const printAt = wingetStep(/winget\.mjs --print-urls/)
const writeAt = wingetStep(/winget\.mjs --version/)
const komacAt = wingetStep(/sha256sum -c/)
const dedupeAt = wingetStep(/repos\/microsoft\/winget-pkgs\/contents/)
const dryAt = wingetStep(/submit [^\n]*--dry-run/)
const submitAt = wingetStep(/submit [^\n]*--yes/)
check(
  'every step is there: token check, download, write, Komac, dedupe, dry run, submit',
  [tokenAt, printAt, writeAt, komacAt, dedupeAt, dryAt, submitAt].map((i) => i !== -1),
  [true, true, true, true, true, true, true]
)
check(
  'in that order — nothing is submitted before the dedupe and the checked dry run',
  [tokenAt, printAt, writeAt, komacAt, dedupeAt, dryAt, submitAt].every((v, i, a) => i === 0 || a[i - 1] < v),
  true
)
check(
  'the token is tested in a step that reads env, the way the signing step does',
  stepsOf('winget')[tokenAt]?.env?.WINGET_TOKEN,
  '${{ secrets.WINGET_TOKEN }}'
)
check('Komac is pinned by digest, not just by version', /KOMAC_SHA256=[0-9a-f]{64}/.test(wingetRuns[komacAt] ?? ''), true)
check(
  'the dry run is checked for all three ManifestType lines — Komac drops a file it cannot parse and exits 0',
  ['version', 'installer', 'defaultLocale'].every((t) => (wingetRuns[dryAt] ?? '').includes(t)) &&
    /ManifestType: \$\{TYPE\}/.test(wingetRuns[dryAt] ?? ''),
  true
)
check(
  'and the submission must print a pull request URL',
  /microsoft\/winget-pkgs\/pull\/\[0-9\]\+/.test(wingetRuns[submitAt] ?? '') && /GITHUB_STEP_SUMMARY/.test(wingetRuns[submitAt] ?? ''),
  true
)
check(
  'the dry run and the submission run only when the dedupe said there is something to send',
  [stepsOf('winget')[dryAt]?.if, stepsOf('winget')[submitAt]?.if].every((c) => /steps\.dedupe\.outputs\.skip == 'false'/.test(String(c))),
  true
)
check('it never builds anything, so it never needs npm ci', /npm ci/.test(wingetRuns.join('\n')), false)

/*
 * No `secrets.` inside ANY `if:` in the workflow. A secret in a condition is
 * not reliably available and evaluates as empty where it is not — which reads
 * as "not configured" and skips the step under a green tick. Walked over every
 * job and step rather than grepped, so a comment mentioning the rule cannot
 * satisfy or break it.
 */
const conditions: string[] = []
for (const [id, job] of Object.entries(jobs) as [string, any][]) {
  if (job?.if != null) conditions.push(`${id}: ${String(job.if)}`)
  for (const step of job?.steps ?? []) if (step?.if != null) conditions.push(`${id}/${step.name ?? step.uses ?? '?'}: ${String(step.if)}`)
}
check('no `if:` anywhere in the workflow reads secrets', conditions.filter((c) => /\bsecrets\./.test(c)), [])
check('and that walk saw the conditions it is meant to police', conditions.length > 5, true)

check('workflow_dispatch is still a trigger, so the whole matrix can be rehearsed without a tag', 'workflow_dispatch' in triggers, true)
check('a tag still triggers it', triggers.push?.tags, ['v*'])
check('and publishing is still gated on a tag', jobs.publish?.if, "startsWith(github.ref, 'refs/tags/')")

// ---------------------------------------------------------------------------

console.log('\nelectron-builder.yml leaves the architecture to the flags')

// Gotcha 7: an explicit arch: list in the config OVERRIDES the CLI flag, so
// `--x64` would still build all three and every job would produce every arch's
// artifact under one name.
check(
  'no platform block pins an arch: list, which would override the --x64/--arm64 flag',
  /^\s+arch:/m.test(builderConfig),
  false
)
/*
 * Windows builds the installer AND a portable zip, from one invocation — that is
 * what puts resources/app-update.yml inside the zip — and the two need two
 * names. Parsed, not grepped, because the rule is about which KEY holds which
 * pattern: nsis.artifactName names the installer, win.artifactName is the only
 * key that can name a win zip, and a top-level artifactName would be the
 * fallback for every target without a name of its own — the Linux AppImage,
 * whose arch-free name install.sh and the publish gate both rely on.
 */
let builder: any = {}
try {
  builder = require('js-yaml').load(builderConfig) ?? {}
} catch (error) {
  failures++
  console.log(`  FAIL  electron-builder.yml does not parse as YAML: ${String(error)}`)
}
check('win.target is the installer and the portable zip', (builder.win?.target ?? []).map((t: any) => (typeof t === 'string' ? t : t.target)), ['nsis', 'zip'])
check('the installer keeps its name, through nsis.artifactName', builder.nsis?.artifactName, '${productName}-${version}-${arch}-setup.${ext}')
check('the zip is named by win.artifactName, with -win in it', builder.win?.artifactName, '${productName}-${version}-${arch}-win.${ext}')
check('no top-level artifactName, which would rename the Linux AppImage', 'artifactName' in builder, false)
check('and no top-level zip block, which electron-builder refuses outright', 'zip' in builder, false)

/*
 * The collision the `-win` exists to prevent, computed rather than described:
 * every file every target produces, expanded from the patterns above, must be a
 * different name — the publish job's merge refuses two assets with one name.
 */
const expand = (pattern: string, arch: string, ext: string) =>
  pattern.replace('${productName}', 'Stoke').replace('${version}', '9.9.9').replace('${arch}', arch).replace('${ext}', ext)
const produced: string[] = []
for (const t of TARGETS) {
  if (t.platform === 'win32') {
    produced.push(expand(builder.nsis?.artifactName ?? '', t.arch, 'exe'))
    produced.push(expand(builder.win?.artifactName ?? '', t.arch, 'zip'))
  } else if (t.platform === 'darwin') {
    for (const ext of ['dmg', 'zip']) produced.push(expand(builder.mac?.artifactName ?? '', t.arch, ext))
  } else {
    // No linux artifactName: electron-builder passes arch as null for x64 and
    // strips `-${arch}`, so the AppImage is Stoke-<version>.AppImage.
    produced.push(t.arch === 'x64' ? 'Stoke-9.9.9.AppImage' : `Stoke-9.9.9-${t.arch}.AppImage`)
  }
}
check(
  'no two targets produce the same file name — a Windows zip named like the mac zip would collide',
  produced.filter((n, i) => produced.indexOf(n) !== i),
  []
)
check(
  'and without -win it WOULD collide: Stoke-<v>-x64.zip is the Intel mac zip',
  expand('${productName}-${version}-${arch}.${ext}', 'x64', 'zip'),
  expand(builder.mac?.artifactName ?? '', 'x64', 'zip')
)

const linuxBlock = /^linux:\n((?:[ \t].*\n|\n)*)/m.exec(builderConfig)?.[1] ?? ''
check('there is a linux: block', linuxBlock.length > 0, true)
check('and AppImage is its target — the only Linux format that self-updates without elevation', /AppImage/.test(linuxBlock), true)
check(
  'no deb or rpm, each of which brings a package-type file and an updater that shells out with sudo',
  /\b(deb|rpm|snap|pacman)\b/.test(linuxBlock),
  false
)
check(
  'toolsets.appimage is set, or the AppImage needs libfuse2 and will not start on a default Ubuntu 24.04',
  /^toolsets:\n(?:[ \t].*\n|\n)*?[ \t]+appimage:/m.test(builderConfig),
  true
)

// ---------------------------------------------------------------------------

console.log('\nthe packaged-output assertion')

const forWinArm = ptyPackageFor(targetFor('win-arm64')!)
check('composes the runtime name node-pty will require', forWinArm, '@lydell/node-pty-win32-arm64')
check(
  'a correct build reports nothing',
  auditPty(forWinArm, [{ path: 'release/win-arm64-unpacked/…/@lydell', packages: ['node-pty-win32-arm64'] }]),
  []
)
check(
  'the wrong arch is reported, naming what was found and what was wanted',
  auditPty(forWinArm, [{ path: 'p', packages: ['node-pty-win32-x64'] }]).length,
  1
)
check(
  'and the message says MODULE_NOT_FOUND, because that is what a user would otherwise see first',
  auditPty(forWinArm, [{ path: 'p', packages: ['node-pty-win32-x64'] }])[0].includes('MODULE_NOT_FOUND'),
  true
)
check(
  'an empty @lydell directory is reported too, not treated as "nothing wrong here"',
  auditPty(forWinArm, [{ path: 'p', packages: [] }]).length,
  1
)
check(
  'a stray second arch alongside the right one is reported',
  auditPty(forWinArm, [{ path: 'p', packages: ['node-pty-win32-arm64', 'node-pty-win32-x64'] }]).length,
  1
)
check(
  'finding no app.asar.unpacked at all fails rather than passing vacuously',
  auditPty(forWinArm, []).length,
  1
)
check(
  'every packaged output is checked, not just the first',
  auditPty(forWinArm, [
    { path: 'a', packages: ['node-pty-win32-arm64'] },
    { path: 'b', packages: ['node-pty-win32-x64'] },
  ]).length,
  1
)

// The walk itself, against a synthetic tree, so "found nothing" cannot be the
// reason this passes.
const tree: Record<string, string[]> = {
  release: ['win-arm64-unpacked'],
  'release/win-arm64-unpacked': ['resources'],
  'release/win-arm64-unpacked/resources': ['app.asar.unpacked'],
  'release/win-arm64-unpacked/resources/app.asar.unpacked': ['node_modules'],
  'release/win-arm64-unpacked/resources/app.asar.unpacked/node_modules': ['@lydell'],
  'release/win-arm64-unpacked/resources/app.asar.unpacked/node_modules/@lydell': ['node-pty-win32-arm64'],
}
const fakeReaddir = (dir: string, opts?: { withFileTypes?: boolean }) => {
  const names = tree[dir.split('\\').join('/')] ?? []
  return opts?.withFileTypes ? names.map((name) => ({ name, isDirectory: () => true })) : names
}
const fakeStat = (path: string) => (tree[path.split('\\').join('/')] ? { isDirectory: () => true } : undefined)
check(
  'the walk reaches an @lydell nested four levels under a platform directory',
  findPtyDirs('release', { readdir: fakeReaddir as never, stat: fakeStat as never }).map((h) => h.packages),
  [['node-pty-win32-arm64']]
)

console.log('\nan arm64 installer its own extractor can read (gotcha 102)')
/*
 * NSIS's nsis7z (19.00) cannot decode 7-Zip's ARM64 branch filter, which 7-Zip
 * 23+ picks by itself for ARM64 executables: the v0.9.9 arm64 installer exited
 * 0 and installed nothing. Every route that builds win-arm64 must pass
 * ELECTRON_BUILDER_7Z_FILTER=BCJ, and every Windows build job must read the
 * installer back — the assertion is what makes a regression a red job.
 */
{
  check('npm run dist:win:arm64 builds with the BCJ filter', buildEnvFor(targetFor('win-arm64')), { ELECTRON_BUILDER_7Z_FILTER: 'BCJ' })
  check('and x64 with nothing extra (its default, BCJ2, installs)', buildEnvFor(targetFor('win-x64')), {})
  check('mac and linux builds are untouched', TARGETS.filter((t) => t.platform !== 'win32').map((t) => buildEnvFor(t)), TARGETS.filter((t) => t.platform !== 'win32').map(() => ({})))
  const winStep = /- name: Build installers \(Windows\)[\s\S]*?(?=\n      - name: )/.exec(workflow)?.[0] ?? ''
  ok('the release workflow\'s Windows build sets the filter for arm64', winStep.includes("ELECTRON_BUILDER_7Z_FILTER: ${{ matrix.arch == 'arm64' && 'BCJ' || '' }}"))
  const buildAt = workflow.indexOf('- name: Build installers (Windows)')
  const assertAt = workflow.indexOf('node scripts/assert-nsis-payload.mjs release')
  const uploadAt = workflow.indexOf('- name: Upload installers')
  ok('and reads the built installer back, after building and before uploading', buildAt >= 0 && assertAt > buildAt && uploadAt > assertAt)
  const winWorkflow = read('.github/workflows/windows.yml')
  ok('the Windows workflow builds the same way and asserts the same', winWorkflow.includes("ELECTRON_BUILDER_7Z_FILTER: ${{ matrix.arch == 'arm64' && 'BCJ' || '' }}") && winWorkflow.includes('node scripts/assert-nsis-payload.mjs release'))
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
