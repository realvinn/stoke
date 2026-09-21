/*
 * The winget manifests scripts/winget.mjs writes for a release, and the CLI
 * that writes them.
 *
 * The failure this exists for is quiet at every step but the last: a manifest
 * that parses, passes a dry run, becomes a pull request, and then either sits
 * in winget-pkgs' validation queue with a label nobody reads, or — worse —
 * merges and describes the wrong product code, so winget never recognises the
 * copy it installed and offers it again on every `winget upgrade`. Nothing in
 * this repo would go red for any of that. So the rules are asserted here, from
 * the sources they have to agree with rather than from a second copy:
 *
 *   ProductCode      UUIDv5 of electron-builder.yml's appId, the ARP key the
 *                    installer writes (recomputed here, not trusted)
 *   Publisher        package.json's author, which is the ARP Publisher
 *   Installers       exactly the Windows arches scripts/targets.mjs builds
 *
 * and the full text is pinned for one fixture, because a manifest is read by
 * three parsers (winget's, Komac's, the schema validator's) and "equivalent
 * YAML" is not something any of them promises.
 *
 *   node scripts/verify-winget.mts
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APP_ID,
  FILE_NAMES,
  MANIFEST_VERSION,
  PRODUCT_CODE,
  WINGET_ID,
  installerUrl,
  winArches,
  wingetDir,
  wingetManifests,
} from './winget.mjs'
import { TARGETS } from './targets.mjs'

const require = createRequire(import.meta.url)
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const read = (...p: string[]): string => readFileSync(join(ROOT, ...p), 'utf8')
const SCRIPT = join(ROOT, 'scripts', 'winget.mjs')

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const same = JSON.stringify(got) === JSON.stringify(want)
  if (!same) failures++
  console.log(
    `  ${same ? 'PASS' : 'FAIL'}  ${name}` +
      (same ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  )
}

function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`)
}

function checkText(name: string, got: string, want: string): void {
  const same = got === want
  if (!same) failures++
  console.log(`  ${same ? 'PASS' : 'FAIL'}  ${name}`)
  if (!same) {
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
  const good = message != null && expect.test(message)
  if (!good) failures++
  console.log(
    `  ${good ? 'PASS' : 'FAIL'}  ${name}` +
      (good ? '' : `\n        ${message == null ? 'it did not throw at all' : `threw ${JSON.stringify(message)}`}`)
  )
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex').toUpperCase()

/** RFC 4122 v5, written out again rather than imported: the point is to not trust winget.mjs's copy. */
function uuidV5(name: string, namespace: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

// ---------------------------------------------------------------------------
// The fixture: 0.9.9, with each installer's digest the sha256 of its arch name,
// which is also what the CLI section below writes into its dummy exe files.

const VERSION = '0.9.9'
const DATE = '2026-09-21'
const FIXTURE = {
  version: VERSION,
  releaseDate: DATE,
  installers: winArches().map((arch: string) => ({ arch, url: installerUrl(VERSION, arch), sha256: sha256(arch) })),
}
const result = wingetManifests(FIXTURE)
const files = result.files as Record<string, string>

console.log('\nthe full text, pinned')

checkText(
  `${FILE_NAMES.version}`,
  files[FILE_NAMES.version],
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.version.1.12.0.schema.json

PackageIdentifier: realvinn.Stoke
PackageVersion: 0.9.9
DefaultLocale: en-US
ManifestType: version
ManifestVersion: 1.12.0
`
)
checkText(
  `${FILE_NAMES.installer}`,
  files[FILE_NAMES.installer],
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.installer.1.12.0.schema.json

PackageIdentifier: realvinn.Stoke
PackageVersion: 0.9.9
InstallerType: nullsoft
Scope: user
InstallerSwitches:
  Custom: /currentuser
  Upgrade: '--updated'
ExpectedReturnCodes:
- InstallerReturnCode: 32
  ReturnResponse: packageInUse
- InstallerReturnCode: 1223
  ReturnResponse: cancelledByUser
UpgradeBehavior: install
ProductCode: 27e02fae-12b6-525c-aa7f-c00dfad6e928
ReleaseDate: 2026-09-21
RequireExplicitUpgrade: true
Installers:
- Architecture: x64
  InstallerUrl: https://github.com/realvinn/stoke/releases/download/v0.9.9/Stoke-0.9.9-x64-setup.exe
  InstallerSha256: ${sha256('x64')}
- Architecture: arm64
  InstallerUrl: https://github.com/realvinn/stoke/releases/download/v0.9.9/Stoke-0.9.9-arm64-setup.exe
  InstallerSha256: ${sha256('arm64')}
ManifestType: installer
ManifestVersion: 1.12.0
`
)
checkText(
  `${FILE_NAMES.defaultLocale}`,
  files[FILE_NAMES.defaultLocale],
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.defaultLocale.1.12.0.schema.json

PackageIdentifier: realvinn.Stoke
PackageVersion: 0.9.9
PackageLocale: en-US
Publisher: realvinn
PublisherUrl: https://github.com/realvinn
PublisherSupportUrl: https://github.com/realvinn/stoke/issues
Author: realvinn
PackageName: Stoke
PackageUrl: https://github.com/realvinn/stoke
License: MIT
ShortDescription: 'A desktop shell for Claude Code and other coding agents: every project, session and a docked browser in one window.'
Description: 'Stoke runs the real claude command in a terminal it owns, so skills, MCP servers, plugins, hooks and slash commands behave exactly as they do anywhere else. Around it: every project in a sidebar with past chats to resume, several sessions open as tabs, a docked browser the agent can read and click, how full the context window is and how much of the plan limit is gone, dictation, and a phone view that can drive a session. Other coding-agent CLIs run in it the same way.'
Moniker: stoke
Tags:
- claude
- claude-code
- ai
- coding-agent
- agents
- terminal
- developer-tools
- electron
ReleaseNotesUrl: https://github.com/realvinn/stoke/releases/tag/v0.9.9
ManifestType: defaultLocale
ManifestVersion: 1.12.0
`
)

// ---------------------------------------------------------------------------

console.log('\nthree files, where winget-pkgs keeps them')

check('the folder is manifests/<first letter>/<publisher>/<package>/<version>', result.dir, 'manifests/r/realvinn/Stoke/0.9.9')
check('which is the id, dot for slash, under its lowercase first letter', result.dir, `manifests/${WINGET_ID[0].toLowerCase()}/${WINGET_ID.split('.').join('/')}/${VERSION}`)
check('and wingetDir says the same', wingetDir(VERSION), result.dir)
check('named <id>.yaml, <id>.installer.yaml and <id>.locale.en-US.yaml', Object.keys(files).sort(), [
  'realvinn.Stoke.installer.yaml',
  'realvinn.Stoke.locale.en-US.yaml',
  'realvinn.Stoke.yaml',
])

/* winget-pkgs' own schema pattern for PackageIdentifier (manifest.version.1.12.0.json). */
const ID_RE = /^[^.\s\\/:*?"<>|\x01-\x1f]{1,32}(\.[^.\s\\/:*?"<>|\x01-\x1f]{1,32}){1,7}$/
ok('the PackageIdentifier fits the schema pattern', ID_RE.test(WINGET_ID))

let yaml: ((text: string) => any) | null = null
try {
  yaml = require('js-yaml').load
} catch (error) {
  failures++
  console.log(`  FAIL  js-yaml could not be loaded, so the manifests have no parser to answer to: ${String(error)}`)
}

const TYPES: Record<string, string> = {
  [FILE_NAMES.version]: 'version',
  [FILE_NAMES.installer]: 'installer',
  [FILE_NAMES.defaultLocale]: 'defaultLocale',
}
const parsed: Record<string, any> = {}
for (const [name, text] of Object.entries(files)) {
  let doc: any = null
  try {
    doc = yaml ? yaml(text) : null
  } catch (error) {
    doc = null
    failures++
    console.log(`  FAIL  ${name} does not parse as YAML: ${String(error)}`)
  }
  parsed[name] = doc ?? {}
  const type = TYPES[name]
  check(`${name}: ManifestType is ${type}`, doc?.ManifestType, type)
  check(`${name}: ManifestVersion is ${MANIFEST_VERSION}`, doc?.ManifestVersion, '1.12.0')
  check(
    `${name}: its schema header names the same type and version`,
    text.split('\n')[0],
    `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.1.12.0.schema.json`
  )
  check(`${name}: PackageIdentifier`, doc?.PackageIdentifier, 'realvinn.Stoke')
  check(`${name}: PackageVersion, as a string`, doc?.PackageVersion, '0.9.9')
  ok(`${name}: LF line endings, and a final newline`, !text.includes('\r') && text.endsWith('\n'))
  ok(`${name}: plain ASCII`, !/[^\n\x20-\x7e]/.test(text))
}

// ---------------------------------------------------------------------------

console.log('\nthe values that have to agree with somewhere else')

const builderYml = read('electron-builder.yml')
const appId = /^appId:\s*(\S+)$/m.exec(builderYml)?.[1] ?? ''
const inst = parsed[FILE_NAMES.installer]
const loc = parsed[FILE_NAMES.defaultLocale]

check("winget.mjs's APP_ID is electron-builder.yml's appId", APP_ID, appId)
check(
  "ProductCode is UUIDv5(appId), the Apps & Features key electron-builder's installer writes",
  inst.ProductCode,
  uuidV5(appId, '50e065bc-3134-11e6-9bab-38c9862bdaf3')
)
check('and it is the key installed copies already carry', PRODUCT_CODE, '27e02fae-12b6-525c-aa7f-c00dfad6e928')
const author = JSON.parse(read('package.json')).author
check('Publisher is package.json\'s author, which is the ARP Publisher winget compares', loc.Publisher, author)
check("License is package.json's", loc.License, JSON.parse(read('package.json')).license)
check(
  "the installers are exactly scripts/targets.mjs's Windows arches, in its order",
  (inst.Installers ?? []).map((i: any) => i.Architecture),
  TARGETS.filter((t: any) => t.platform === 'win32').map((t: any) => t.arch)
)
ok(
  'each InstallerSha256 is 64 uppercase hex digits',
  (inst.Installers ?? []).length > 0 && (inst.Installers ?? []).every((i: any) => /^[A-F0-9]{64}$/.test(String(i.InstallerSha256)))
)

console.log('\nhow the installer is run')
check('InstallerType nullsoft — winget passes /S and /D itself', inst.InstallerType, 'nullsoft')
check('Scope user, since the installer is per-user', inst.Scope, 'user')
check('Custom /currentuser, multiUser.nsh\'s own switch', inst.InstallerSwitches?.Custom, '/currentuser')
check('Upgrade --updated, which is what electron-updater passes', inst.InstallerSwitches?.Upgrade, '--updated')
check(
  'no Silent or SilentWithProgress of our own — they would replace winget\'s',
  Object.keys(inst.InstallerSwitches ?? {}).filter((k) => /silent/i.test(k)),
  []
)
ok('and /allusers appears in none of the three files', Object.values(files).every((t) => !/allusers/i.test(t)))
check('UpgradeBehavior install', inst.UpgradeBehavior, 'install')
check(
  'RequireExplicitUpgrade true: Stoke updates itself, so `winget upgrade --all` must not close it to do the same',
  inst.RequireExplicitUpgrade,
  true
)
ok('no AppsAndFeaturesEntries — the DisplayVersion would be stale the day Stoke updates itself', !('AppsAndFeaturesEntries' in inst))
ok('ReleaseDate is the fixture date, written plain', /^ReleaseDate: 2026-09-21$/m.test(files[FILE_NAMES.installer]))

console.log('\nevery URL is https and versioned')
for (const i of inst.Installers ?? []) {
  check(
    `${i.Architecture}: the release asset for v${VERSION}, never /latest/`,
    i.InstallerUrl,
    `https://github.com/realvinn/stoke/releases/download/v${VERSION}/Stoke-${VERSION}-${i.Architecture}-setup.exe`
  )
}
check('ReleaseNotesUrl is this version\'s tag', loc.ReleaseNotesUrl, `https://github.com/realvinn/stoke/releases/tag/v${VERSION}`)
for (const key of ['PublisherUrl', 'PublisherSupportUrl', 'PackageUrl', 'ReleaseNotesUrl']) {
  ok(`${key} is https`, /^https:\/\//.test(String(loc[key])))
}
ok('nothing anywhere says /latest/', Object.values(files).every((t) => !t.includes('/latest')))

console.log('\nthe schema\'s length limits')
const len = (v: unknown) => String(v ?? '').length
ok(`ShortDescription is 3-256 characters (${len(loc.ShortDescription)})`, len(loc.ShortDescription) >= 3 && len(loc.ShortDescription) <= 256)
ok(`Description is 3-10000 characters (${len(loc.Description)})`, len(loc.Description) >= 3 && len(loc.Description) <= 10000)
ok(`PackageName is 2-256 (${len(loc.PackageName)})`, len(loc.PackageName) >= 2 && len(loc.PackageName) <= 256)
ok(`Publisher is 2-256 (${len(loc.Publisher)})`, len(loc.Publisher) >= 2 && len(loc.Publisher) <= 256)
ok(`License is 3-512 (${len(loc.License)})`, len(loc.License) >= 3 && len(loc.License) <= 512)
ok(`Moniker is 1-40, lowercase, no spaces (${loc.Moniker})`, len(loc.Moniker) >= 1 && len(loc.Moniker) <= 40 && /^[a-z0-9-]+$/.test(String(loc.Moniker)))
const tags: string[] = Array.isArray(loc.Tags) ? loc.Tags : []
ok(`at most 16 tags (${tags.length})`, tags.length > 0 && tags.length <= 16)
check('each tag is 1-40 characters, lowercase, no spaces', tags.filter((t) => !(t.length >= 1 && t.length <= 40 && /^[a-z0-9-]+$/.test(t))), [])
check('and none repeats', tags.length, new Set(tags).size)

// ---------------------------------------------------------------------------

console.log('\nwhat the generator refuses')

const good = FIXTURE.installers
refuses('a version with a leading v — the tag, not the version', () => wingetManifests({ ...FIXTURE, version: 'v0.9.9' }), /starts with a v/)
refuses('a prerelease: winget gets stable releases only', () => wingetManifests({ ...FIXTURE, version: '1.0.0-beta.1' }), /prerelease/)
refuses('build metadata, likewise', () => wingetManifests({ ...FIXTURE, version: '0.9.9+ci.7' }), /prerelease or carries build metadata/)
refuses('a two-part version', () => wingetManifests({ ...FIXTURE, version: '0.9' }), /x\.y\.z/)
refuses('a missing arch — winget gets every Windows build or none', () => wingetManifests({ ...FIXTURE, installers: good.slice(0, 1) }), /Missing: arm64/)
refuses(
  'an arch the matrix does not build',
  () => wingetManifests({ ...FIXTURE, installers: [...good, { arch: 'ia32', url: installerUrl(VERSION, 'ia32'), sha256: sha256('ia32') }] }),
  /Not built: ia32/
)
refuses('the same arch twice', () => wingetManifests({ ...FIXTURE, installers: [...good, good[0]] }), /Twice: x64/)
refuses(
  'an unversioned URL',
  () =>
    wingetManifests({
      ...FIXTURE,
      installers: good.map((i: any) => ({ ...i, url: i.url.replace(`download/v${VERSION}`, 'latest/download') })),
    }),
  /versioned release asset/
)
refuses('a digest that is not 64 hex digits', () => wingetManifests({ ...FIXTURE, installers: good.map((i: any) => ({ ...i, sha256: 'abc' })) }), /64 hex digits/)
refuses('a release date that is not YYYY-MM-DD', () => wingetManifests({ ...FIXTURE, releaseDate: '21/09/2026' }), /YYYY-MM-DD/)
check(
  'a lowercase digest is written uppercase, as winget-pkgs expects',
  /InstallerSha256: ([A-F0-9]{64})/.exec(
    wingetManifests({ ...FIXTURE, installers: good.map((i: any) => ({ ...i, sha256: i.sha256.toLowerCase() })) }).files[FILE_NAMES.installer]
  )?.[1],
  sha256('x64')
)
/*
 * The arch list is read from the target list, not merely compared with it: a
 * matrix with one Windows target demands one installer.
 */
const x64Only = TARGETS.filter((t: any) => t.key !== 'win-arm64')
check('a matrix with only x64 asks for only x64', winArches(x64Only), ['x64'])
check(
  'and gets a one-installer manifest',
  (
    yaml?.(
      wingetManifests({ ...FIXTURE, installers: good.slice(0, 1), targets: x64Only }).files[FILE_NAMES.installer]
    )?.Installers ?? []
  ).length,
  1
)

// ---------------------------------------------------------------------------
// The CLI, run as the release job runs it, against dummy installers in a
// throwaway directory. Everything it writes goes under that directory (gotcha
// 74: fake every input), which is removed at the end.

console.log('\nthe CLI')

const work = mkdtempSync(join(tmpdir(), 'stoke-winget-'))
const exes = join(work, 'exes')
mkdirSync(exes, { recursive: true })
for (const arch of winArches()) writeFileSync(join(exes, `Stoke-${VERSION}-${arch}-setup.exe`), arch)

function run(args: string[]): { status: number; out: string; err: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { status: 0, out, err: '' }
  } catch (error: any) {
    return { status: typeof error.status === 'number' ? error.status : -1, out: String(error.stdout ?? ''), err: String(error.stderr ?? '') }
  }
}

const out1 = join(work, 'out')
const ran = run(['--version', VERSION, '--installers', exes, '--release-date', DATE, '--out', out1])
check('a good run exits 0', ran.status, 0)
const written = join(out1, 'manifests', 'r', 'realvinn', 'Stoke', VERSION)
check('and writes the three files under <out>/manifests/r/realvinn/Stoke/<version>', Object.values(FILE_NAMES).map((n) => existsSync(join(written, n))), [true, true, true])
checkText(
  'hashing the real files gives exactly the pinned manifest — the digest is the uppercase sha256 of the bytes',
  existsSync(join(written, FILE_NAMES.installer)) ? readFileSync(join(written, FILE_NAMES.installer), 'utf8') : '',
  files[FILE_NAMES.installer]
)

const urls = run(['--print-urls', '--version', VERSION])
check(
  '--print-urls prints one "<arch> <url>" per Windows arch, which is what the release job downloads',
  urls.out.trim().split('\n'),
  winArches().map((a: string) => `${a} ${installerUrl(VERSION, a)}`)
)

const refusedV = run(['--version', `v${VERSION}`, '--installers', exes, '--release-date', DATE, '--out', join(work, 'o2')])
check('the CLI refuses a leading v', [refusedV.status, /starts with a v/.test(refusedV.err)], [1, true])
ok('and writes nothing', !existsSync(join(work, 'o2')))

const refusedPre = run(['--version', '1.0.0-beta.1', '--installers', exes, '--release-date', DATE, '--out', join(work, 'o3')])
check('the CLI refuses a prerelease', [refusedPre.status, /prerelease/.test(refusedPre.err)], [1, true])

const onlyX64 = join(work, 'only-x64')
mkdirSync(onlyX64, { recursive: true })
writeFileSync(join(onlyX64, `Stoke-${VERSION}-x64-setup.exe`), 'x64')
const refusedMissing = run(['--version', VERSION, '--installers', onlyX64, '--release-date', DATE, '--out', join(work, 'o4')])
check(
  "the CLI refuses a directory missing an arch's exe, and names it",
  [refusedMissing.status, /Stoke-0\.9\.9-arm64-setup\.exe is missing/.test(refusedMissing.err)],
  [1, true]
)
ok('and writes nothing', !existsSync(join(work, 'o4')))

const refusedDate = run(['--version', VERSION, '--installers', exes, '--release-date', 'yesterday', '--out', join(work, 'o5')])
check('the CLI refuses a bad release date', [refusedDate.status, /YYYY-MM-DD/.test(refusedDate.err)], [1, true])

const usage = run(['--version', VERSION])
check('and a missing argument is a usage error, exit 2', usage.status, 2)

rmSync(work, { recursive: true, force: true })

console.log('\nthe installer\'s own exit codes, named for winget')
/*
 * build/installer.nsh never kills a running Stoke: it exits 32 when Stoke
 * would not close and 1223 when a person at the wizard declined. nullsoft gets
 * no default mapping in winget, so without these a user reads "Installer failed
 * with exit code: 32". Held against the .nsh itself, so a new exit code there
 * cannot ship unnamed.
 */
{
  const nsh = readFileSync(fileURLToPath(new URL('../build/installer.nsh', import.meta.url)), 'utf8')
  const codes = [...nsh.matchAll(/^\s*SetErrorLevel (\d+)\s*$/gm)].map((m) => Number(m[1])).sort((a, b) => a - b)
  const mapped = [...files[FILE_NAMES.installer].matchAll(/- InstallerReturnCode: (\d+)\n  ReturnResponse: (\w+)/g)].map((m) => [Number(m[1]), m[2]] as [number, string])
  check('every exit code build/installer.nsh can end with is mapped in the manifest', mapped.map((m) => m[0]).sort((a, b) => a - b), codes)
  check('32 (would not close) is packageInUse, 1223 (declined) is cancelledByUser', mapped, [[32, 'packageInUse'], [1223, 'cancelledByUser']])
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
