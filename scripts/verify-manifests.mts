/*
 * The update-manifest merger, and the gate that decides whether a release may
 * be published at all.
 *
 * This is the highest-consequence untested code the repo could have added, so
 * it is the one suite that does not settle for fixtures of its own invention.
 * Three oracles, in increasing order of how much they prove:
 *
 *   1. The REAL published v0.9.4 manifests, pasted in byte for byte, must
 *      survive parse -> merge -> serialise unchanged. Those bytes came out of
 *      electron-builder on a release runner, so agreeing with them is agreeing
 *      with the thing itself rather than with a fixture someone typed.
 *   2. electron-builder's OWN `writeUpdateInfoFiles` is called to produce what
 *      a single two-arch invocation would have written, and the merger's output
 *      is compared to it byte for byte. Not "follows the same rules" — the same
 *      code, run.
 *   3. electron-updater's OWN `findFile` and `MacUpdater.filterFilesForArch`
 *      are then pointed at the merged feed, per arch, and must hand each arch
 *      its own artifact. That is the property a user actually experiences, and
 *      it is the one that fails silently when a merge drops an arch.
 *
 * js-yaml is likewise the oracle for the serialiser, because the merger ships
 * its own YAML writer (it runs in the publish job, which has no node_modules)
 * and "close enough to js-yaml" is not a thing a manifest can be.
 *
 *   node scripts/verify-manifests.mts
 */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  archRankFor,
  compareUpdateFiles,
  formatScalar,
  groupByBasename,
  mergeManifests,
  mergeTree,
  parseManifest,
  serializeManifest,
  MANIFEST_RE,
} from './merge-update-manifests.mjs'
import { auditRelease, expectedFeeds, nsisPickFor, readReleaseDir } from './check-release-assets.mjs'
import { addPortableToDir, addPortableZips, sha512Base64 } from './add-portable-to-manifest.mjs'
import { TARGETS } from './targets.mjs'
import { portableAssetFor } from '../src/shared/installKind.ts'

const require = createRequire(import.meta.url)

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  )
}

function checkText(name: string, got: string, want: string): void {
  const ok = got === want
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    const g = got.split('\n')
    const w = want.split('\n')
    for (let i = 0; i < Math.max(g.length, w.length); i++) {
      if (g[i] !== w[i]) console.log(`        line ${i + 1}:\n          got  ${JSON.stringify(g[i])}\n          want ${JSON.stringify(w[i])}`)
    }
  }
}

function refuses(name: string, fn: () => unknown, expect: RegExp): void {
  let message: string | null = null
  try {
    fn()
  } catch (error) {
    message = error instanceof Error ? error.message : String(error)
  }
  const ok = message != null && expect.test(message)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        ${message == null ? 'it did not throw at all' : `threw ${JSON.stringify(message)}`}`)
  )
}

// ---------------------------------------------------------------------------
// The real thing. Downloaded from
// https://github.com/realvinn/stoke/releases/download/v0.9.4/latest.yml (and
// latest-mac.yml) — electron-builder's own output, from the release that is
// installed on machines today.

const REAL_LATEST = `version: 0.9.4
files:
  - url: Stoke-0.9.4-x64-setup.exe
    sha512: EakW6ulw/k4J7EXuzjTejzbQw2n3PcM+nmJfZm2yEV5dh4h/AYnoYr4WRdzVwB/XKILYG56w4Dn54O6FaeAESA==
    size: 102576420
path: Stoke-0.9.4-x64-setup.exe
sha512: EakW6ulw/k4J7EXuzjTejzbQw2n3PcM+nmJfZm2yEV5dh4h/AYnoYr4WRdzVwB/XKILYG56w4Dn54O6FaeAESA==
releaseDate: '2026-09-12T05:45:03.545Z'
`

const REAL_LATEST_MAC = `version: 0.9.4
files:
  - url: Stoke-0.9.4-arm64.zip
    sha512: B14Hg5HLDSc3bBVqvR4D4PomUL9Yyllceb+zvgHupukxDxlJE4EYJNYnDwDiBRSkOjkaoBcOQO2TffJL4mdMqw==
    size: 123361985
  - url: Stoke-0.9.4-arm64.dmg
    sha512: pmugD/YN6A1cXBrHueKz8kSKJafoR+8qYGOMGtQvkKmjhTjyxwHsZUkHh7u5zmfxOIVZaPp8rlTYriNTiAWkNw==
    size: 124213866
path: Stoke-0.9.4-arm64.zip
sha512: B14Hg5HLDSc3bBVqvR4D4PomUL9Yyllceb+zvgHupukxDxlJE4EYJNYnDwDiBRSkOjkaoBcOQO2TffJL4mdMqw==
releaseDate: '2026-09-12T05:45:17.364Z'
`

console.log('\nthe real v0.9.4 manifests')

const realWin = parseManifest(REAL_LATEST, 'latest.yml')
const realMac = parseManifest(REAL_LATEST_MAC, 'latest-mac.yml')

check('latest.yml parses to the version electron-builder wrote', realWin.version, '0.9.4')
check('a size stays a number, not the string "102576420"', realWin.files[0].size, 102576420)
check('the quoted releaseDate loses its quotes on the way in', realWin.releaseDate, '2026-09-12T05:45:03.545Z')
check('latest-mac.yml carries the two artifacts one invocation merged', realMac.files.map((f: any) => f.url), [
  'Stoke-0.9.4-arm64.zip',
  'Stoke-0.9.4-arm64.dmg',
])

// A one-input merge is the shape the very first run of this code takes in CI
// (before a second arch exists), so it is also the safest way to land the
// merger: byte-identical to what shipped means it changed nothing.
checkText(
  'a single-input merge of latest.yml is byte-identical to the published file',
  serializeManifest(mergeManifests([{ source: 'latest.yml', manifest: realWin }])),
  REAL_LATEST
)
checkText(
  'and of latest-mac.yml, zip-before-dmg order included',
  serializeManifest(mergeManifests([{ source: 'latest-mac.yml', manifest: realMac }])),
  REAL_LATEST_MAC
)

// ---------------------------------------------------------------------------

console.log('\nthe YAML writer, against js-yaml itself')

let dump: ((o: unknown, opts: unknown) => string) | null = null
try {
  dump = require('js-yaml').dump
} catch {
  failures++
  console.log(
    '  FAIL  js-yaml could not be loaded, so the serialiser has no oracle.\n' +
      '        It comes in with electron-builder (builder-util uses it for exactly this).\n' +
      '        Run npm ci. Never let this assertion be skipped: the merger ships its own\n' +
      '        YAML writer precisely so the publish job needs no node_modules, and the\n' +
      '        only thing keeping it honest is being diffed against the real one.'
  )
}

if (dump) {
  // builder-util's serializeToYaml is dump(object, { lineWidth: 8000,
  // skipInvalid: false, noRefs: true }).
  const yaml = (value: unknown) => dump!(value, { lineWidth: 8000, skipInvalid: false, noRefs: true })
  const same = (name: string, value: unknown) => checkText(name, serializeManifest(value as any), yaml(value))

  same('the real Windows manifest', realWin)
  same('the real macOS manifest', realMac)

  // The scalars that decide whether a manifest is readable at all. Each is a
  // value that has actually appeared in one of these files, or could.
  const scalars: [string, string][] = [
    ['a plain filename', 'Stoke-0.9.4-arm64.zip'],
    ['a semver', '0.9.4'],
    ['a two-part version, which IS a number and must be quoted', '1.0'],
    ['a prerelease version', '0.9.5-beta.1'],
    ['an ISO timestamp', '2026-09-12T05:45:17.364Z'],
    ['a base64 digest with slashes and a plus', 'B14Hg5HLDSc3bBVqvR4D4Pom+UL9Yy/llceb=='],
    ['a digest that happens to start with a plus', '+14Hg5HLDSc3bBVqvR4D4Pom=='],
    ['a digest that happens to start with a slash', '/14Hg5HLDSc3bBVqvR4D4Pom=='],
    ['an all-digit string', '123456'],
    ['the word yes, which YAML 1.1 reads as a boolean', 'yes'],
    ['the word no', 'no'],
    ['the word null', 'null'],
    ['the word on', 'on'],
    ['an empty string', ''],
    ['a name starting with a dash', '-weird-name.zip'],
    ['a name with a colon and a space in it', 'Stoke: the app.zip'],
    ['a name with a hash', 'Stoke #2.zip'],
    ['a name with a quote', "Stoke's.zip"],
    ['a name with a percent', '%40weird.zip'],
    ['a name with an at sign', '@weird.zip'],
    ['a name with a backtick', 'we`ird.zip'],
    ['a name with a trailing space', 'trailing .zip '],
    ['a float', '1.5e10'],
    ['a sexagesimal, which YAML 1.1 also reads as a number', '12:30:45'],
  ]
  for (const [name, value] of scalars) {
    checkText(`scalar — ${name}`, serializeManifest({ v: value }), yaml({ v: value }))
  }

  // A fuzz over the one value shape that appears three times in every manifest
  // and is generated rather than chosen: a 64-byte sha512, base64'd. 4000 of
  // them covers every leading character the alphabet can produce, including
  // the "+" and "/" that make a digest look unlike a filename.
  let digestMismatch: string | null = null
  for (let i = 0; i < 4000 && digestMismatch == null; i++) {
    const bytes = Buffer.alloc(64)
    for (let b = 0; b < 64; b++) bytes[b] = Math.floor(Math.random() * 256)
    const sha = bytes.toString('base64')
    if (serializeManifest({ sha512: sha }) !== yaml({ sha512: sha })) digestMismatch = sha
  }
  check('4000 random sha512 digests all serialise as js-yaml would', digestMismatch, null)

  // And a fuzz over short strings drawn from the characters that decide
  // quoting at all, which is where a transcription of someone else's rules
  // goes wrong. Short, because the interesting cases are the first and last
  // character and the ones adjacent to a colon or a hash.
  const ALPHABET = [...`-?:,[]{}#&*!|=>'"%@\`0123456789abyYnNoOfFtTeE._+/ ~<`]
  let fuzzMismatch: string | null = null
  let fuzzed = 0
  for (let i = 0; i < 60000 && fuzzMismatch == null; i++) {
    const length = 1 + Math.floor(Math.random() * 6)
    let value = ''
    for (let c = 0; c < length; c++) value += ALPHABET[Math.floor(Math.random() * ALPHABET.length)]
    fuzzed++
    if (serializeManifest({ v: value }) !== yaml({ v: value })) fuzzMismatch = value
  }
  check(`${fuzzed} random short strings over the characters that decide quoting`, fuzzMismatch, null)

  // The one thing js-yaml does that this does not reproduce, and must
  // therefore refuse: a tab, a line break or a control character sends it to a
  // double-quoted or block scalar with its own escaping. Guessing there is how
  // a manifest stops parsing on a user's machine.
  refuses('a tab is refused rather than written in a style this cannot reproduce', () => serializeManifest({ v: 'a\tb' }), /double-quoted/)
  refuses('so is a newline', () => serializeManifest({ v: 'a\nb' }), /double-quoted/)
  check('and a non-ASCII name is written plain, exactly as js-yaml writes it', serializeManifest({ v: 'Stöke-é.zip' }), yaml({ v: 'Stöke-é.zip' }))

  // WHICH characters get refused is js-yaml's decision, so it is read out of
  // js-yaml rather than out of a list someone typed. The rule: the merger must
  // refuse exactly the values js-yaml would write in a double-quoted or block
  // style, and write every other one itself.
  //
  // The first version of UNWRITABLE named 0x00-0x1F, 0x7F and FEFF and missed
  // 0x80-0xA0 (a non-breaking space included), 2028/2029, a lone surrogate and
  // FFFE/FFFF — for all of which js-yaml double-quotes and the merger quietly
  // wrote a plain scalar instead. A hand-kept list is how that gap opened; this
  // sweep is what closes it, and it also pins the `u` flag, without which an
  // ordinary emoji would be refused because its surrogate halves are in range.
  const style = (v: string) => {
    const out = yaml({ v })
    return out.startsWith('v: "') || out.startsWith('v: |') || out.startsWith('v: >') ? 'escaped' : 'writable'
  }
  const refusedByMerger = (v: string) => {
    try {
      serializeManifest({ v })
      return 'writable'
    } catch {
      return 'escaped'
    }
  }
  const disagreements: string[] = []
  let sampled = 0
  for (let cp = 0; cp <= 0x10ffff; cp += cp < 0x10000 ? 1 : 1009) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue // paired below, on their own
    const v = 'a' + String.fromCodePoint(cp) + 'b'
    sampled++
    if (refusedByMerger(v) !== style(v)) disagreements.push('U+' + cp.toString(16))
  }
  for (const cp of [0xd800, 0xdbff, 0xdc00, 0xdfff]) {
    const v = 'a' + String.fromCharCode(cp) + 'b'
    sampled++
    if (refusedByMerger(v) !== style(v)) disagreements.push('lone U+' + cp.toString(16))
  }
  check(`${sampled} code points: the merger refuses exactly what js-yaml would escape`, disagreements.slice(0, 8), [])
  refuses('a non-breaking space is refused, not written plain', () => serializeManifest({ v: 'a\u00a0b' }), /double-quoted/)
  refuses('so is U+2028, which is a line break to some readers and not to others', () => serializeManifest({ v: 'a\u2028b' }), /double-quoted/)
  refuses('and a lone surrogate', () => serializeManifest({ v: 'a\ud800b' }), /double-quoted/)
  check('but an emoji is still written plain — the u flag is what keeps it out of the surrogate range', serializeManifest({ v: 'Stoke-\u{1f600}.zip' }), yaml({ v: 'Stoke-\u{1f600}.zip' }))
}

// ---------------------------------------------------------------------------

console.log('\nthe parser refuses what it cannot read')

refuses(
  'a nested mapping is not guessed at',
  () => parseManifest('version: 1\nextra:\n  deep:\n    deeper: 1\n', 'x.yml'),
  /not the update-manifest shape/
)
refuses(
  'a flow sequence is refused at the line it appears on, not three steps later',
  () => parseManifest('files: [a, b]\n', 'x.yml'),
  /flow collections/
)
refuses('a tab-indented line is refused', () => parseManifest('files:\n\t- url: a\n', 'x.yml'), /not the update-manifest shape/)
refuses(
  'a mapping key with no list item above it is refused',
  () => parseManifest('version: 1\n    url: a\n', 'x.yml'),
  /no list item above it/
)
check(
  'a comment and a blank line are skipped, not refused',
  parseManifest('# written by electron-builder\n\nversion: 0.9.4\n', 'x.yml'),
  { version: '0.9.4' }
)
check(
  'CRLF survives, because an artifact can cross a Windows runner',
  parseManifest('version: 0.9.4\r\nfiles:\r\n  - url: a.exe\r\n    size: 5\r\n', 'x.yml'),
  { version: '0.9.4', files: [{ url: 'a.exe', size: 5 }] }
)

// ---------------------------------------------------------------------------

console.log('\narch order — the tie-break electron-builder sorts by')

check('arm64 in a name', archRankFor('Stoke-1.0.0-arm64.zip'), 3)
check('x64 in a name', archRankFor('Stoke-1.0.0-x64.zip'), 1)
check('arm64 is not read as armv7l, even though it contains "arm"', archRankFor('Stoke-1.0.0-arm64.dmg'), 3)
check('x86_64, which an AppImage uses and which contains no "x64"', archRankFor('Stoke-1.0.0-x86_64.AppImage'), 1)
check('universal sorts last of the named arches', archRankFor('Stoke-1.0.0-universal.dmg'), 4)
check('a name with no arch at all sorts first, as arch === null does', archRankFor('Stoke-1.0.0.AppImage'), -1)
check('the combined NSIS installer, likewise', archRankFor('Stoke-1.0.0-setup.exe'), -1)

check(
  'a zip beats a dmg regardless of arch, because MacUpdater will not read a dmg',
  [
    { url: 'Stoke-1.0.0-arm64.dmg' },
    { url: 'Stoke-1.0.0-x64.zip' },
    { url: 'Stoke-1.0.0-x64.dmg' },
    { url: 'Stoke-1.0.0-arm64.zip' },
  ]
    .sort(compareUpdateFiles)
    .map((f) => f.url),
  ['Stoke-1.0.0-x64.zip', 'Stoke-1.0.0-arm64.zip', 'Stoke-1.0.0-x64.dmg', 'Stoke-1.0.0-arm64.dmg']
)

// ---------------------------------------------------------------------------
// electron-builder's own merge, as the oracle.

console.log('\nthe merge, against electron-builder\'s own writeUpdateInfoFiles')

const DATE = '2026-09-12T05:45:17.364Z'
const work = mkdtempSync(join(tmpdir(), 'stoke-manifests-'))

type Artifact = { url: string; sha512: string; size: number; arch: string }

/** One job's manifest: exactly what a single electron-builder invocation writes. */
async function jobManifest(name: string, artifacts: Artifact[]): Promise<string> {
  let writeUpdateInfoFiles: any
  let Arch: any
  try {
    ;({ writeUpdateInfoFiles } = require('app-builder-lib/out/publish/updateInfoBuilder.js'))
    ;({ Arch } = require('builder-util'))
  } catch (error) {
    throw new Error(
      'app-builder-lib/out/publish/updateInfoBuilder.js could not be loaded, so there is no oracle for the ' +
        'merge. electron-builder has probably moved it; re-point this suite rather than deleting the check — ' +
        `the rules in merge-update-manifests.mjs are a transcription of that file. (${String(error)})`
    )
  }
  const dir = mkdtempSync(join(work, 'oracle-'))
  const file = join(dir, name)
  const tasks = artifacts.map((a) => ({
    file,
    info: {
      version: '0.9.4',
      files: [{ url: a.url, sha512: a.sha512, size: a.size }],
      path: a.url,
      sha512: a.sha512,
      releaseDate: DATE,
    },
    publishConfiguration: { provider: 'github', owner: 'realvinn', repo: 'stoke' },
    packager: {},
    arch: Arch[a.arch],
  }))
  await writeUpdateInfoFiles(tasks, { emitArtifactCreated: async () => {} })
  return readFileSync(file, 'utf8')
}

const MAC_ARM: Artifact[] = [
  { url: 'Stoke-0.9.4-arm64.zip', sha512: 'B14Hg5HLDSc3bBVqvR4D4PomUL9Yyllceb+zvgHupukxDxlJE4EYJNYnDwDiBRSkOjkaoBcOQO2TffJL4mdMqw==', size: 123361985, arch: 'arm64' },
  { url: 'Stoke-0.9.4-arm64.dmg', sha512: 'pmugD/YN6A1cXBrHueKz8kSKJafoR+8qYGOMGtQvkKmjhTjyxwHsZUkHh7u5zmfxOIVZaPp8rlTYriNTiAWkNw==', size: 124213866, arch: 'arm64' },
]
const MAC_X64: Artifact[] = [
  { url: 'Stoke-0.9.4-x64.zip', sha512: 'Cc4Hg5HLDSc3bBVqvR4D4PomUL9Yyllceb+zvgHupukxDxlJE4EYJNYnDwDiBRSkOjkaoBcOQO2TffJL4mdMqw==', size: 129900001, arch: 'x64' },
  { url: 'Stoke-0.9.4-x64.dmg', sha512: 'Dd5ugD/YN6A1cXBrHueKz8kSKJafoR+8qYGOMGtQvkKmjhTjyxwHsZUkHh7u5zmfxOIVZaPp8rlTYriNTiAWkNw==', size: 130700002, arch: 'x64' },
]
const WIN_X64: Artifact[] = [
  { url: 'Stoke-0.9.4-x64-setup.exe', sha512: 'EakW6ulw/k4J7EXuzjTejzbQw2n3PcM+nmJfZm2yEV5dh4h/AYnoYr4WRdzVwB/XKILYG56w4Dn54O6FaeAESA==', size: 102576420, arch: 'x64' },
]
const WIN_ARM: Artifact[] = [
  { url: 'Stoke-0.9.4-arm64-setup.exe', sha512: 'Ff7W6ulw/k4J7EXuzjTejzbQw2n3PcM+nmJfZm2yEV5dh4h/AYnoYr4WRdzVwB/XKILYG56w4Dn54O6FaeAESA==', size: 99110000, arch: 'arm64' },
]

const macArmYml = await jobManifest('latest-mac.yml', MAC_ARM)
const macX64Yml = await jobManifest('latest-mac.yml', MAC_X64)
const winX64Yml = await jobManifest('latest.yml', WIN_X64)
const winArmYml = await jobManifest('latest.yml', WIN_ARM)
const macBothYml = await jobManifest('latest-mac.yml', [...MAC_ARM, ...MAC_X64])
const winBothYml = await jobManifest('latest.yml', [...WIN_X64, ...WIN_ARM])

// The macOS arm64 job's own manifest, produced by the real thing just now,
// must be the file that actually shipped. If this fails, the oracle and the
// release disagree and nothing below can be trusted.
checkText('the oracle reproduces the published latest-mac.yml from the same inputs', macArmYml, REAL_LATEST_MAC)

const mergedMac = serializeManifest(
  mergeManifests([
    { source: 'installers-mac-arm64/latest-mac.yml', manifest: parseManifest(macArmYml, 'a') },
    { source: 'installers-mac-x64/latest-mac.yml', manifest: parseManifest(macX64Yml, 'b') },
  ])
)
checkText(
  'two macOS jobs merge into exactly what one two-arch invocation would have written',
  mergedMac,
  macBothYml
)

const mergedWin = serializeManifest(
  mergeManifests([
    { source: 'installers-win-x64/latest.yml', manifest: parseManifest(winX64Yml, 'a') },
    { source: 'installers-win-arm64/latest.yml', manifest: parseManifest(winArmYml, 'b') },
  ])
)
checkText('and two Windows jobs, likewise', mergedWin, winBothYml)

// Order of the inputs must not matter: download-artifact does not promise one,
// and a merge that depended on it would produce a different file on a re-run.
checkText(
  'the arm64 job arriving first changes nothing',
  serializeManifest(
    mergeManifests([
      { source: 'b', manifest: parseManifest(winArmYml, 'b') },
      { source: 'a', manifest: parseManifest(winX64Yml, 'a') },
    ])
  ),
  winBothYml
)

// ---------------------------------------------------------------------------
// The case the spec singles out: two inputs, ONE manifest, BOTH arches — and
// what happens to a real updater reading it.

console.log('\nthe case that silently breaks auto-update')

const merged = mergeManifests([
  { source: 'a', manifest: parseManifest(macArmYml, 'a') },
  { source: 'b', manifest: parseManifest(macX64Yml, 'b') },
])
check('one manifest, not two', typeof merged.version, 'string')
check('listing all four artifacts', merged.files.length, 4)
check('both arches present', [
  merged.files.some((f: any) => f.url.includes('arm64')),
  merged.files.some((f: any) => f.url.includes('x64')),
], [true, true])
check('path points at the first file after sorting, as createUpdateInfo does', merged.path, merged.files[0].url)
check('and sha512 with it', merged.sha512, merged.files[0].sha512)

// electron-updater's own selection, run against the merged feed. This is the
// assertion that would have caught v0.4.0-beta.3's dmg-only feed, and it is the
// one that catches a merge that drops an arch.
let updaterOracle = true
let findFile: any
let MacUpdater: any
try {
  ;({ findFile } = require('electron-updater/out/providers/Provider.js'))
  ;({ MacUpdater } = require('electron-updater/out/MacUpdater.js'))
} catch (error) {
  updaterOracle = false
  failures++
  console.log(`  FAIL  electron-updater's own selection could not be loaded: ${String(error)}`)
}

if (updaterOracle) {
  const resolved = merged.files.map((f: any) => ({
    url: new URL(f.url, 'https://github.com/realvinn/stoke/releases/download/v0.9.4/'),
    info: { url: f.url, sha512: f.sha512, size: f.size },
  }))

  for (const [label, isArm] of [
    ['an Apple silicon Mac', true],
    ['an Intel Mac', false],
  ] as [string, boolean][]) {
    const forArch = MacUpdater.filterFilesForArch(resolved, isArm)
    const picked = findFile(forArch, 'zip', ['pkg', 'dmg'])
    check(`${label} is handed its own zip out of the merged feed`, picked?.info.url, isArm ? 'Stoke-0.9.4-arm64.zip' : 'Stoke-0.9.4-x64.zip')
  }

  // Windows has no arch filter; NsisUpdater goes straight to findFile, which
  // matches on process.arch and falls back to the first entry. process.arch is
  // a configurable own property, so both branches can be exercised from one
  // machine rather than only the one this suite happens to run on.
  const winMerged = mergeManifests([
    { source: 'a', manifest: parseManifest(winX64Yml, 'a') },
    { source: 'b', manifest: parseManifest(winArmYml, 'b') },
  ])
  const winResolved = winMerged.files.map((f: any) => ({
    url: new URL(f.url, 'https://github.com/realvinn/stoke/releases/download/v0.9.4/'),
    info: { url: f.url, sha512: f.sha512, size: f.size },
  }))
  const realArch = process.arch
  for (const arch of ['x64', 'arm64']) {
    Object.defineProperty(process, 'arch', { value: arch, configurable: true })
    check(`Windows ${arch} is handed its own installer`, findFile(winResolved, 'exe')?.info.url, `Stoke-0.9.4-${arch}-setup.exe`)
  }
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true })

  // The counterfactual, which is the whole point: before the merge, one job's
  // manifest simply overwrote the other's. Show what that feed does to the arch
  // it does not list — and note the shape of the failure, because it is the
  // reason the publish gate exists rather than a log line. electron-updater
  // does not degrade, it throws, at update time, on the user's machine.
  const arm64OnlyResolved = parseManifest(macArmYml, 'a').files.map((f: any) => ({
    url: new URL(f.url, 'https://x/'),
    info: { url: f.url },
  }))
  let intelOutcome = 'it found a file'
  try {
    findFile(MacUpdater.filterFilesForArch(arm64OnlyResolved, false), 'zip', ['pkg', 'dmg'])
  } catch (error) {
    intelOutcome = error instanceof Error ? error.message : String(error)
  }
  check(
    'an un-merged feed leaves an Intel Mac with nothing to download at all — the failure this exists to prevent',
    intelOutcome,
    'No files provided'
  )
}

// ---------------------------------------------------------------------------

console.log('\nthe merge refuses rather than guesses')

refuses(
  'two versions means two commits, and half a release is worse than none',
  () =>
    mergeManifests([
      { source: 'installers-win-x64/latest.yml', manifest: parseManifest(winX64Yml, 'a') },
      { source: 'installers-win-arm64/latest.yml', manifest: { ...parseManifest(winArmYml, 'b'), version: '0.9.5' } },
    ]),
  /different versions[\s\S]*0\.9\.4[\s\S]*0\.9\.5|different versions[\s\S]*0\.9\.5[\s\S]*0\.9\.4/
)
refuses(
  'and it names which job carried which version',
  () =>
    mergeManifests([
      { source: 'installers-win-x64/latest.yml', manifest: parseManifest(winX64Yml, 'a') },
      { source: 'installers-win-arm64/latest.yml', manifest: { ...parseManifest(winArmYml, 'b'), version: '0.9.5' } },
    ]),
  /installers-win-arm64\/latest\.yml/
)
refuses('a manifest with no version', () => mergeManifests([{ source: 'x', manifest: { files: [{ url: 'a' }] } }]), /states no version/)
refuses('a manifest listing no files', () => mergeManifests([{ source: 'x', manifest: { version: '1' } }]), /lists no files/)
refuses(
  'the same filename with different bytes in two jobs',
  () =>
    mergeManifests([
      { source: 'a', manifest: { version: '1', files: [{ url: 'same.exe', sha512: 'AAA' }] } },
      { source: 'b', manifest: { version: '1', files: [{ url: 'same.exe', sha512: 'BBB' }] } },
    ]),
  /different sha512/
)
check(
  'but an identical duplicate is just a duplicate',
  mergeManifests([
    { source: 'a', manifest: { version: '1', files: [{ url: 'same.exe', sha512: 'AAA' }] } },
    { source: 'b', manifest: { version: '1', files: [{ url: 'same.exe', sha512: 'AAA' }] } },
  ]).files.length,
  1
)
refuses(
  'an unknown key the inputs disagree about is a decision, not a merge',
  () =>
    mergeManifests([
      { source: 'a', manifest: { version: '1', files: [{ url: 'a.exe' }], stagingPercentage: 10 } },
      { source: 'b', manifest: { version: '1', files: [{ url: 'b.exe' }], stagingPercentage: 90 } },
    ]),
  /disagree about "stagingPercentage"/
)
check(
  'an unknown key the inputs agree about is carried through, not dropped',
  mergeManifests([
    { source: 'a', manifest: { version: '1', files: [{ url: 'a.exe' }], stagingPercentage: 10 } },
    { source: 'b', manifest: { version: '1', files: [{ url: 'b.exe' }], stagingPercentage: 10 } },
  ]).stagingPercentage,
  10
)
check(
  'releaseDate takes the latest, because the jobs finish at different times',
  mergeManifests([
    { source: 'a', manifest: { version: '1', files: [{ url: 'a.exe' }], releaseDate: '2026-09-12T05:45:03.545Z' } },
    { source: 'b', manifest: { version: '1', files: [{ url: 'b.exe' }], releaseDate: '2026-09-12T05:51:44.000Z' } },
  ]).releaseDate,
  '2026-09-12T05:51:44.000Z'
)

// ---------------------------------------------------------------------------

console.log('\ngrouping — Linux is the platform that must NOT be merged')

const grouped = groupByBasename([
  { source: 'dist/installers-win-x64/latest.yml', manifest: {} },
  { source: 'dist/installers-win-arm64/latest.yml', manifest: {} },
  { source: 'dist/installers-linux-x64/latest-linux.yml', manifest: {} },
  { source: 'dist/installers-linux-arm64/latest-linux-arm64.yml', manifest: {} },
])
check('two Windows jobs are one group', grouped.get('latest.yml')?.length, 2)
check('latest-linux.yml stays its own group', grouped.get('latest-linux.yml')?.length, 1)
check('and latest-linux-arm64.yml is a different one — the arch suffix is real there', grouped.get('latest-linux-arm64.yml')?.length, 1)

check('latest.yml is recognised as a manifest', MANIFEST_RE.test('latest.yml'), true)
check('so is latest-mac.yml', MANIFEST_RE.test('latest-mac.yml'), true)
check('so is latest-linux-arm64.yml', MANIFEST_RE.test('latest-linux-arm64.yml'), true)
check('a beta channel file is not, so it cannot be merged into the stable feed', MANIFEST_RE.test('beta.yml'), false)
check('and an installer certainly is not', MANIFEST_RE.test('Stoke-0.9.4-x64-setup.exe'), false)

// ---------------------------------------------------------------------------

console.log('\nthe whole download-artifact tree')

const tree = join(work, 'dist')
// Each Windows job also produces its portable zip — the win `zip` target — and
// its latest.yml does NOT list it: electron-builder writes no update info for a
// Windows zip, which is why add-portable-to-manifest.mjs exists.
const jobs: [string, string, string, string[]][] = [
  ['installers-win-x64', 'latest.yml', winX64Yml, ['Stoke-0.9.4-x64-setup.exe', 'Stoke-0.9.4-x64-setup.exe.blockmap', 'Stoke-0.9.4-x64-win.zip']],
  ['installers-win-arm64', 'latest.yml', winArmYml, ['Stoke-0.9.4-arm64-setup.exe', 'Stoke-0.9.4-arm64-setup.exe.blockmap', 'Stoke-0.9.4-arm64-win.zip']],
  ['installers-mac-arm64', 'latest-mac.yml', macArmYml, ['Stoke-0.9.4-arm64.zip', 'Stoke-0.9.4-arm64.dmg']],
  ['installers-mac-x64', 'latest-mac.yml', macX64Yml, ['Stoke-0.9.4-x64.zip', 'Stoke-0.9.4-x64.dmg']],
]
for (const [job, manifestName, body, assets] of jobs) {
  mkdirSync(join(tree, job), { recursive: true })
  writeFileSync(join(tree, job, manifestName), body)
  for (const asset of assets) writeFileSync(join(tree, job, asset), asset)
}
const linuxYml = await jobManifest('latest-linux.yml', [
  { url: 'Stoke-0.9.4.AppImage', sha512: 'Gg8W6ulw/k4J7EXuzjTejzbQw2n3PcM+nmJfZm2yEV5dh4h/AYnoYr4WRdzVwB/XKILYG56w4Dn54O6FaeAESA==', size: 118000000, arch: 'x64' },
])
mkdirSync(join(tree, 'installers-linux-x64'), { recursive: true })
writeFileSync(join(tree, 'installers-linux-x64', 'latest-linux.yml'), linuxYml)
writeFileSync(join(tree, 'installers-linux-x64', 'Stoke-0.9.4.AppImage'), 'Stoke-0.9.4.AppImage')

const out = join(work, 'release-assets')
const result = mergeTree(tree, out)

check('five jobs produce three manifests, not five', result.written.map((w: any) => w.name).sort(), [
  'latest-linux.yml',
  'latest-mac.yml',
  'latest.yml',
])
check('every asset is flattened into one directory, both portable zips included', result.assets.length, 11)
checkText('the merged Windows feed is the two-arch one', readFileSync(join(out, 'latest.yml'), 'utf8'), winBothYml)
checkText('the merged macOS feed is the two-arch one', readFileSync(join(out, 'latest-mac.yml'), 'utf8'), macBothYml)
checkText('the Linux feed passes through untouched', readFileSync(join(out, 'latest-linux.yml'), 'utf8'), linuxYml)

mkdirSync(join(work, 'clash', 'a'), { recursive: true })
mkdirSync(join(work, 'clash', 'b'), { recursive: true })
writeFileSync(join(work, 'clash', 'a', 'latest.yml'), winX64Yml)
writeFileSync(join(work, 'clash', 'b', 'latest.yml'), winArmYml)
writeFileSync(join(work, 'clash', 'a', 'Stoke-0.9.4-setup.exe'), 'one')
writeFileSync(join(work, 'clash', 'b', 'Stoke-0.9.4-setup.exe'), 'two')
refuses(
  'two jobs emitting the same asset filename is refused, not silently resolved',
  () => mergeTree(join(work, 'clash'), join(work, 'clash-out')),
  /both produced "Stoke-0\.9\.4-setup\.exe"/
)
mkdirSync(join(work, 'empty'), { recursive: true })
refuses(
  'a tree with no manifests at all is refused',
  () => mergeTree(join(work, 'empty'), join(work, 'empty-out')),
  /No update manifests/
)

// ---------------------------------------------------------------------------
// The portable zips, listed in the MERGED latest.yml — one step after the merge
// and one before the gate. Everything above ran on electron-builder's own
// per-job output, untouched, which is the whole reason the injection happens
// here rather than in each job: the oracle above would otherwise be comparing
// the merger to a manifest electron-builder never wrote.

console.log('\nthe portable zips, listed after the merge')

const b64 = (text: string) => createHash('sha512').update(text).digest('base64')
const mergedWinText = readFileSync(join(out, 'latest.yml'), 'utf8')
const injected = addPortableToDir(out)
const injectedText = readFileSync(join(out, 'latest.yml'), 'utf8')
const injectedWin = parseManifest(injectedText, 'latest.yml')

check('both zips are added, x64 first — the Arch enum order, not readdir order', injected.added, [
  'Stoke-0.9.4-x64-win.zip',
  'Stoke-0.9.4-arm64-win.zip',
])
check(
  'AFTER the installers, so files[0] is still an .exe',
  injectedWin.files.map((f: any) => f.url),
  ['Stoke-0.9.4-x64-setup.exe', 'Stoke-0.9.4-arm64-setup.exe', 'Stoke-0.9.4-x64-win.zip', 'Stoke-0.9.4-arm64-win.zip']
)
check(
  'path and sha512 still name the x64 installer, exactly as the merge left them',
  [injectedWin.path, injectedWin.sha512],
  [parseManifest(mergedWinText, 'x').path, parseManifest(mergedWinText, 'x').sha512]
)
check(
  "each zip's sha512 is the BASE64 digest of its bytes, like every entry electron-builder writes",
  injectedWin.files.slice(2).map((f: any) => f.sha512),
  [b64('Stoke-0.9.4-x64-win.zip'), b64('Stoke-0.9.4-arm64-win.zip')]
)
check(
  'and sha512Base64 reads the file to the same answer',
  sha512Base64(join(out, 'Stoke-0.9.4-x64-win.zip')),
  b64('Stoke-0.9.4-x64-win.zip')
)
check(
  'its size is the size on disk, as a number',
  injectedWin.files.slice(2).map((f: any) => f.size),
  [statSync(join(out, 'Stoke-0.9.4-x64-win.zip')).size, statSync(join(out, 'Stoke-0.9.4-arm64-win.zip')).size]
)
checkText(
  'the rewritten file is the merged one plus two entries, nothing else moved',
  injectedText,
  mergedWinText.replace(
    /\npath: /,
    '\n' +
      `  - url: Stoke-0.9.4-x64-win.zip\n    sha512: ${b64('Stoke-0.9.4-x64-win.zip')}\n    size: ${'Stoke-0.9.4-x64-win.zip'.length}\n` +
      `  - url: Stoke-0.9.4-arm64-win.zip\n    sha512: ${b64('Stoke-0.9.4-arm64-win.zip')}\n    size: ${'Stoke-0.9.4-arm64-win.zip'.length}\n` +
      'path: '
  )
)
checkText('it round-trips through the merger\'s own reader and writer', serializeManifest(parseManifest(injectedText, 'x')), injectedText)
if (dump) {
  checkText(
    'and is what js-yaml itself would write for the same object',
    injectedText,
    dump(injectedWin, { lineWidth: 8000, skipInvalid: false, noRefs: true })
  )
}
checkText('the macOS feed is not touched', readFileSync(join(out, 'latest-mac.yml'), 'utf8'), macBothYml)

const again = addPortableToDir(out)
check('a second run adds nothing', again.added, [])
check('and reports both as already listed with the same bytes', again.already, ['Stoke-0.9.4-x64-win.zip', 'Stoke-0.9.4-arm64-win.zip'])
checkText('and leaves the file byte-for-byte as it was', readFileSync(join(out, 'latest.yml'), 'utf8'), injectedText)

if (updaterOracle) {
  // The property a user experiences, from the injected feed: the installer
  // route still gets each arch its own installer, and the portable route its
  // own zip. findFile is electron-updater's own; portableAssetFor is the one
  // Stoke ships (src/shared/installKind.ts).
  const resolved = injectedWin.files.map((f: any) => ({
    url: new URL(f.url, 'https://github.com/realvinn/stoke/releases/download/v0.9.4/'),
    info: { url: f.url, sha512: f.sha512, size: f.size },
  }))
  const realArch = process.arch
  for (const arch of ['x64', 'arm64']) {
    Object.defineProperty(process, 'arch', { value: arch, configurable: true })
    check(`Windows ${arch}: findFile(files, 'exe') still hands it its own installer`, findFile(resolved, 'exe')?.info.url, `Stoke-0.9.4-${arch}-setup.exe`)
    check(`Windows ${arch}: portableAssetFor hands a portable copy its own zip`, portableAssetFor(injectedWin.files, arch)?.url, `Stoke-0.9.4-${arch}-win.zip`)
  }
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true })
  check('and an arch the release does not build gets no zip, never another arch\'s', portableAssetFor(injectedWin.files, 'ia32'), null)
}

const WIN_BASE = parseManifest(winBothYml, 'latest.yml')
const zip = (name: string) => ({ name, sha512: b64(name), size: name.length })
refuses(
  'a zip from a different version is refused, naming both',
  () => addPortableZips(WIN_BASE, [zip('Stoke-0.9.5-x64-win.zip')]),
  /Stoke-0\.9\.5-x64-win\.zip is not version 0\.9\.4/
)
refuses(
  'the same name with different bytes is refused — a release can carry only one',
  () => addPortableZips(injectedWin, [{ ...zip('Stoke-0.9.4-x64-win.zip'), sha512: b64('other bytes') }]),
  /already lists Stoke-0\.9\.4-x64-win\.zip with different bytes/
)
refuses(
  'a feed with no .exe is refused, because findFile would then hand the installer route files[0]',
  () => addPortableZips({ version: '0.9.4', files: [{ url: 'Stoke-0.9.4-arm64.zip', sha512: b64('m'), size: 1 }] }, [zip('Stoke-0.9.4-x64-win.zip')]),
  /lists no \.exe/
)
refuses('a hex digest is refused — electron-builder writes base64 (gotcha 71)', () => addPortableZips(WIN_BASE, [{ ...zip('Stoke-0.9.4-x64-win.zip'), sha512: 'ab'.repeat(64) }]), /base64/)

mkdirSync(join(work, 'no-manifest'), { recursive: true })
writeFileSync(join(work, 'no-manifest', 'Stoke-0.9.4-x64-win.zip'), 'z')
refuses('win zips with no latest.yml beside them are refused', () => addPortableToDir(join(work, 'no-manifest')), /no latest\.yml to list them in/)
mkdirSync(join(work, 'no-zips'), { recursive: true })
writeFileSync(join(work, 'no-zips', 'latest.yml'), winBothYml)
check('a directory with no win zips is left alone — whether zips are REQUIRED is the gate\'s rule', addPortableToDir(join(work, 'no-zips')).zips, [])
checkText('and its latest.yml is untouched', readFileSync(join(work, 'no-zips', 'latest.yml'), 'utf8'), winBothYml)

// And the CLI the publish job runs exits non-zero on a refusal, rather than
// printing the reason and carrying on into the gate.
mkdirSync(join(work, 'wrong-version'), { recursive: true })
writeFileSync(join(work, 'wrong-version', 'latest.yml'), winBothYml)
writeFileSync(join(work, 'wrong-version', 'Stoke-0.9.5-arm64-win.zip'), 'z')
let cliExit = 0
let cliErr = ''
try {
  execFileSync(process.execPath, [fileURLToPath(new URL('./add-portable-to-manifest.mjs', import.meta.url)), join(work, 'wrong-version')], { stdio: ['ignore', 'pipe', 'pipe'] })
} catch (error: any) {
  cliExit = error.status
  cliErr = String(error.stderr ?? '')
}
check('the CLI exits 1 on a version mismatch', cliExit, 1)
check('with a GitHub ::error:: line that names the file', /::error::.*Stoke-0\.9\.5-arm64-win\.zip is not version 0\.9\.4/.test(cliErr), true)

// ---------------------------------------------------------------------------

console.log('\nthe publish gate')

const feeds = expectedFeeds(TARGETS)
check(
  'the expectations are derived from the matrix, so a new platform tightens the gate',
  feeds.map((f: any) => `${f.manifest}:${f.archs.join('+')}`).sort(),
  ['latest-linux.yml:x64', 'latest-mac.yml:arm64+x64', 'latest.yml:x64+arm64']
)
check('only macOS demands a .zip as its update', feeds.filter((f: any) => f.zip).map((f: any) => f.manifest), ['latest-mac.yml'])
check('only Windows demands an installer AND a portable zip per arch', feeds.filter((f: any) => f.portable).map((f: any) => f.manifest), ['latest.yml'])
check(
  'Linux is exempt from the arch-in-the-url rule, because its x64 AppImage has no arch in its name',
  feeds.find((f: any) => f.manifest === 'latest-linux.yml')?.archInUrl,
  false
)

const good = readReleaseDir(out)
check('the merged, zip-listed release directory publishes', auditRelease({ ...good, version: '0.9.4' }), [])

// The same directory as the merge left it, before the injector ran: every
// installer present, no zip listed. Refused once per arch — which is what makes
// the injector's position in the publish job a rule rather than a habit.
const notInjected = new Map(good.manifests)
notInjected.set('latest.yml', parseManifest(mergedWinText, 'x'))
check(
  'the feed the merge alone produces is refused, once per Windows arch — the zips are not in it',
  auditRelease({ manifests: notInjected, assets: good.assets, version: '0.9.4' }),
  ['x64', 'arm64'].map(
    (arch) =>
      `latest.yml lists no -${arch}-win.zip, so portable copies on ${arch} would never update. ` +
      'scripts/add-portable-to-manifest.mjs lists each zip in the publish job; either it did not run ' +
      `or the ${arch} job produced no zip. Listed: Stoke-0.9.4-x64-setup.exe, Stoke-0.9.4-arm64-setup.exe.`
  )
)

// A lost arm64 job, in the new shape: its installer AND its zip gone from the
// feed and from the directory.
const lostArm = { ...injectedWin, files: injectedWin.files.filter((f: any) => !f.url.includes('arm64')) }
const dropArch = new Map(good.manifests)
dropArch.set('latest.yml', lostArm)
const dropAssets = new Set([...good.assets].filter((a) => !(a.includes('arm64') && (a.endsWith('.exe') || a.endsWith('-win.zip')))))
const dropped = auditRelease({ manifests: dropArch, assets: dropAssets, version: '0.9.4' })
check('a latest.yml that lost its arm64 job is refused twice — installer and zip', dropped.length, 2)
check(
  'the first says what arm64 would be handed instead: the x64 installer',
  dropped[0],
  'latest.yml lists no .exe whose name contains "arm64", so arm64 Windows installs would be handed ' +
    'Stoke-0.9.4-x64-setup.exe instead. Listed: Stoke-0.9.4-x64-setup.exe, Stoke-0.9.4-x64-win.zip.'
)
check(
  'the second that a portable copy on arm64 would never update',
  dropped[1],
  'latest.yml lists no -arm64-win.zip, so portable copies on arm64 would never update. ' +
    'scripts/add-portable-to-manifest.mjs lists each zip in the publish job; either it did not run ' +
    'or the arm64 job produced no zip. Listed: Stoke-0.9.4-x64-setup.exe, Stoke-0.9.4-x64-win.zip.'
)

/*
 * The counterfactual the Windows rule exists for. A feed that lists portable
 * zips has something other than an installer in it, and electron-updater's
 * findFile(files, 'exe') falls back to files[0] when there is no .exe at all —
 * so a feed whose installers went missing hands the installer route a ZIP. The
 * gate refuses it; the real findFile shows what it would have done; and the
 * gate's own description of the fallback (nsisPickFor) is held to the real
 * thing across every feed shape here, so its messages cannot drift from what
 * electron-updater does.
 */
const zipsOnly = { ...injectedWin, files: injectedWin.files.filter((f: any) => f.url.endsWith('.zip')) }
const armExeGone = { ...injectedWin, files: injectedWin.files.filter((f: any) => f.url !== 'Stoke-0.9.4-arm64-setup.exe') }
const armZipGone = { ...injectedWin, files: injectedWin.files.filter((f: any) => f.url !== 'Stoke-0.9.4-arm64-win.zip') }
const withWin = (m: object) => {
  const map = new Map(good.manifests)
  map.set('latest.yml', m)
  return auditRelease({ manifests: map, assets: good.assets, version: '0.9.4' })
}
check(
  "a feed with its zips but arm64's installer gone is refused, and says arm64 would get the x64 installer",
  withWin(armExeGone),
  [
    'latest.yml lists no .exe whose name contains "arm64", so arm64 Windows installs would be handed ' +
      'Stoke-0.9.4-x64-setup.exe instead. Listed: Stoke-0.9.4-x64-setup.exe, Stoke-0.9.4-x64-win.zip, Stoke-0.9.4-arm64-win.zip.',
  ]
)
check(
  'a feed of zips with no installer at all is refused for both arches — each would download a zip as its installer',
  withWin(zipsOnly).map((p: string) => /Windows installs would download a zip as their installer \(Stoke-0\.9\.4-x64-win\.zip\)/.test(p)),
  [true, true]
)
check(
  "a feed missing only arm64's zip is refused: portable copies on arm64 would never update",
  withWin(armZipGone).map((p: string) => p.slice(0, p.indexOf('.', p.indexOf('never update')) + 1)),
  ['latest.yml lists no -arm64-win.zip, so portable copies on arm64 would never update.']
)
if (updaterOracle) {
  const realArch = process.arch
  const feedsToProbe: [string, any][] = [
    ['the full feed', injectedWin],
    ["arm64's installer gone", armExeGone],
    ['zips only', zipsOnly],
    ["arm64's zip gone", armZipGone],
  ]
  const disagreements: string[] = []
  for (const [label, m] of feedsToProbe) {
    const resolved = m.files.map((f: any) => ({ url: new URL(f.url, 'https://x/'), info: { url: f.url } }))
    for (const arch of ['x64', 'arm64']) {
      Object.defineProperty(process, 'arch', { value: arch, configurable: true })
      const real = findFile(resolved, 'exe')?.info.url
      const ours = nsisPickFor(m.files, arch)?.url
      if (real !== ours) disagreements.push(`${label}/${arch}: findFile ${real}, gate ${ours}`)
    }
  }
  Object.defineProperty(process, 'arch', { value: 'arm64', configurable: true })
  const zipsOnlyPick = findFile(zipsOnly.files.map((f: any) => ({ url: new URL(f.url, 'https://x/'), info: { url: f.url } })), 'exe')?.info.url
  Object.defineProperty(process, 'arch', { value: realArch, configurable: true })
  check("the gate's account of the fallback matches electron-updater's own findFile on every feed and arch", disagreements, [])
  check(
    'and on the zips-only feed the real findFile really does hand an arm64 installer route a zip',
    zipsOnlyPick,
    'Stoke-0.9.4-x64-win.zip'
  )
  check(
    "while portableAssetFor finds no arm64 zip in the feed that lost it — hence \"would never update\"",
    portableAssetFor(armZipGone.files, 'arm64'),
    null
  )
}

const dmgOnly = new Map(good.manifests)
dmgOnly.set('latest-mac.yml', {
  version: '0.9.4',
  files: [{ url: 'Stoke-0.9.4-arm64.dmg' }, { url: 'Stoke-0.9.4-x64.dmg' }],
})
check(
  'a dmg-only mac feed is refused on both arches — gotcha 24, which shipped once',
  auditRelease({ manifests: dmgOnly, assets: good.assets, version: '0.9.4' }).filter((p: string) => p.includes('.zip')).length,
  2
)

const noLinux = new Map(good.manifests)
noLinux.delete('latest-linux.yml')
check(
  'a missing latest-linux.yml names the job that could not update',
  auditRelease({ manifests: noLinux, assets: good.assets, version: '0.9.4' }),
  ['latest-linux.yml is missing, so linux-x64 can never auto-update from this release.']
)

const missingAsset = new Set(good.assets)
missingAsset.delete('Stoke-0.9.4-arm64.zip')
check(
  'a manifest naming a file that was never uploaded is caught before publishing, not by a user',
  auditRelease({ manifests: good.manifests, assets: missingAsset, version: '0.9.4' }),
  ['latest-mac.yml names Stoke-0.9.4-arm64.zip, which is not in the release directory — the update would 404.']
)
check(
  'a tag that disagrees with what the manifests say',
  auditRelease({ ...good, version: '0.9.5' }).every((p: string) => p.includes('says version 0.9.4 but this release is 0.9.5')),
  true
)
check('...once per manifest, so none of them is missed', auditRelease({ ...good, version: '0.9.5' }).length, 3)

rmSync(work, { recursive: true, force: true })

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
