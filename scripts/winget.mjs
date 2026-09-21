/*
 * The winget manifests for one Stoke release: the three files a
 * microsoft/winget-pkgs pull request carries, generated rather than typed.
 *
 * What goes in them was decided against winget-pkgs' own documentation and
 * winget-cli's source, and each choice below is one a hand-written manifest
 * would get wrong without complaint:
 *
 *   InstallerType nullsoft, and NO Silent switches. winget already passes /S
 *     and /D=<path> to a nullsoft installer itself; repeating /S is harmless,
 *     but a SilentWithProgress switch of our own replaces winget's.
 *   Scope user, Custom /currentuser. electron-builder's installer is per-user
 *     (`perMachine: false`), and /currentuser is multiUser.nsh's own switch.
 *     /allusers is never written anywhere: under /S it would demand elevation
 *     the installer does not request (`RequestExecutionLevel user`).
 *   Upgrade --updated. What electron-updater passes; the installer reads it as
 *     an update (`isUpdated`): it does not re-create a desktop shortcut the
 *     user deleted, and tells the old uninstaller to leave app data alone
 *     (templates/nsis/include/installer.nsh, installUtil.nsh).
 *   ProductCode. The Apps & Features key electron-builder writes is
 *     UUIDv5(appId, 50e065bc-3134-11e6-9bab-38c9862bdaf3) (NsisTarget.js:28,
 *     157), and it is how winget matches the installed copy to this package.
 *     Computed from APP_ID here and held against electron-builder.yml by
 *     verify:winget, because changing appId silently orphans every install.
 *   No AppsAndFeaturesEntries. The installer's own ARP entry already carries
 *     the ProductCode; restating DisplayVersion there would be wrong the
 *     moment Stoke updates itself.
 *   RequireExplicitUpgrade true. Stoke updates itself and rewrites the ARP
 *     DisplayVersion, so winget's idea of "outdated" lags by design — and the
 *     installer a `winget upgrade --all` runs must close a running Stoke to
 *     replace its files. This keeps `--all` away from it; an explicit
 *     `winget upgrade realvinn.Stoke` still works. (build/installer.nsh closes
 *     Stoke gracefully rather than killing it either way.)
 *   Publisher realvinn: must equal package.json's author, because that is the
 *     ARP Publisher the installer writes and the one winget compares.
 *
 * Stable versions only. A prerelease tag never reaches winget, and the job that
 * runs this is skipped for one — refused here too, so the rule holds for a
 * hand run as well.
 *
 * LINE ENDINGS: LF, deliberately. winget-pkgs' .editorconfig asks for CRLF, but
 * these files are Komac's input, not what lands upstream: `komac submit`
 * rewrites every file it sends (its own header, CRLF, shared installer fields
 * hoisted to the root). LF keeps verify:winget's pinned text exact and a diff of
 * it readable; YAML itself does not care.
 *
 * Usage:
 *   node scripts/winget.mjs --version 0.9.9 --installers <dir> --release-date 2026-09-21 --out <dir>
 *       <dir> holds Stoke-<version>-<arch>-setup.exe for every Windows arch in
 *       scripts/targets.mjs; writes <out>/manifests/r/realvinn/Stoke/<version>/
 *   node scripts/winget.mjs --print-urls --version 0.9.9
 *       one "<arch> <url>" line per Windows arch — what the release job downloads
 */
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { formatScalar } from './merge-update-manifests.mjs'
import { TARGETS } from './targets.mjs'

export const PUBLISHER = 'realvinn'
export const PACKAGE = 'Stoke'
export const WINGET_ID = `${PUBLISHER}.${PACKAGE}`
export const MANIFEST_VERSION = '1.12.0'
export const DEFAULT_LOCALE = 'en-US'
/** electron-builder.yml's appId; verify:winget asserts the two agree. */
export const APP_ID = 'dev.vinn.stoke'
/** electron-builder's ELECTRON_BUILDER_NS_UUID (app-builder-lib NsisTarget.js:28). */
export const ELECTRON_BUILDER_NS_UUID = '50e065bc-3134-11e6-9bab-38c9862bdaf3'
export const REPO_URL = 'https://github.com/realvinn/stoke'

export const SHORT_DESCRIPTION =
  'A desktop shell for Claude Code and other coding agents: every project, session and a docked browser in one window.'
export const DESCRIPTION =
  'Stoke runs the real claude command in a terminal it owns, so skills, MCP servers, plugins, hooks and ' +
  'slash commands behave exactly as they do anywhere else. Around it: every project in a sidebar with past ' +
  'chats to resume, several sessions open as tabs, a docked browser the agent can read and click, how full ' +
  'the context window is and how much of the plan limit is gone, dictation, and a phone view that can drive ' +
  'a session. Other coding-agent CLIs run in it the same way.'
export const TAGS = ['claude', 'claude-code', 'ai', 'coding-agent', 'agents', 'terminal', 'developer-tools', 'electron']
export const MONIKER = 'stoke'

/** RFC 4122 version 5, the same derivation electron-builder's UUID.v5 makes. */
export function uuidV5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex')
  const hash = createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest()
  const bytes = Buffer.from(hash.subarray(0, 16))
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-')
}

export const PRODUCT_CODE = uuidV5(APP_ID, ELECTRON_BUILDER_NS_UUID)

/** Every Windows arch a release builds, in scripts/targets.mjs's order — never a second list. */
export function winArches(targets = TARGETS) {
  return targets.filter((t) => t.platform === 'win32').map((t) => t.arch)
}

/** A release version winget will take: x.y.z, nothing else. */
export function assertStableVersion(version) {
  const v = String(version ?? '')
  if (v.startsWith('v')) throw new Error(`"${v}" starts with a v. Pass the version package.json holds (${v.slice(1)}), not the tag.`)
  if (/^\d+\.\d+\.\d+[-+]/.test(v)) {
    throw new Error(`${v} is a prerelease or carries build metadata. winget gets stable releases only.`)
  }
  if (!/^\d+\.\d+\.\d+$/.test(v)) throw new Error(`"${v}" is not a version of the form x.y.z.`)
  return v
}

export function installerName(version, arch) {
  return `${PACKAGE}-${version}-${arch}-setup.exe`
}

/** The release asset URL, versioned — never /latest/, which would change under a merged manifest. */
export function installerUrl(version, arch) {
  return `${REPO_URL}/releases/download/v${version}/${installerName(version, arch)}`
}

/** Where winget-pkgs keeps a version: manifests/<first letter>/<publisher>/<package>/<version>. */
export function wingetDir(version) {
  return `manifests/${PUBLISHER[0].toLowerCase()}/${PUBLISHER}/${PACKAGE}/${version}`
}

export const FILE_NAMES = {
  version: `${WINGET_ID}.yaml`,
  installer: `${WINGET_ID}.installer.yaml`,
  defaultLocale: `${WINGET_ID}.locale.${DEFAULT_LOCALE}.yaml`,
}

const header = (type) =>
  `# yaml-language-server: $schema=https://aka.ms/winget-manifest.${type}.${MANIFEST_VERSION}.schema.json\n\n`

const line = (key, value) => `${key}: ${formatScalar(value)}\n`

/**
 * The three manifests for one release. Pure: the digests come in, nothing is
 * read or fetched.
 *
 * @param {{ version: string, releaseDate: string, installers: { arch: string, url: string, sha256: string }[] }} input
 * @returns {{ dir: string, files: Record<string, string> }}
 */
export function wingetManifests({ version, releaseDate, installers, targets = TARGETS }) {
  const v = assertStableVersion(version)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(releaseDate)) || Number.isNaN(Date.parse(`${releaseDate}T00:00:00Z`))) {
    throw new Error(`ReleaseDate must be YYYY-MM-DD, not ${JSON.stringify(releaseDate)}.`)
  }

  const want = winArches(targets)
  if (want.length === 0) throw new Error('scripts/targets.mjs builds no Windows target, so there is nothing to submit.')
  const given = installers.map((i) => i.arch)
  const missing = want.filter((a) => !given.includes(a))
  const extra = given.filter((a) => !want.includes(a))
  const twice = given.filter((a, i) => given.indexOf(a) !== i)
  if (missing.length || extra.length || twice.length) {
    throw new Error(
      `The installers must be exactly the Windows arches scripts/targets.mjs builds (${want.join(', ')}). ` +
        [missing.length && `Missing: ${missing.join(', ')}.`, extra.length && `Not built: ${extra.join(', ')}.`, twice.length && `Twice: ${twice.join(', ')}.`]
          .filter(Boolean)
          .join(' ')
    )
  }
  const ordered = want.map((arch) => installers.find((i) => i.arch === arch))
  for (const i of ordered) {
    if (i.url !== installerUrl(v, i.arch)) {
      throw new Error(`${i.arch}: InstallerUrl must be the versioned release asset ${installerUrl(v, i.arch)}, not ${i.url}.`)
    }
    if (!/^[A-Fa-f0-9]{64}$/.test(String(i.sha256))) throw new Error(`${i.arch}: InstallerSha256 must be 64 hex digits, not ${JSON.stringify(i.sha256)}.`)
  }

  const common = line('PackageIdentifier', WINGET_ID) + line('PackageVersion', v)

  const versionFile =
    header('version') +
    common +
    line('DefaultLocale', DEFAULT_LOCALE) +
    line('ManifestType', 'version') +
    line('ManifestVersion', MANIFEST_VERSION)

  const installerFile =
    header('installer') +
    common +
    line('InstallerType', 'nullsoft') +
    line('Scope', 'user') +
    'InstallerSwitches:\n' +
    `  Custom: ${formatScalar('/currentuser')}\n` +
    `  Upgrade: ${formatScalar('--updated')}\n` +
    line('UpgradeBehavior', 'install') +
    line('ProductCode', PRODUCT_CODE) +
    // Plain, as every winget-pkgs manifest writes it; validated above, so it
    // cannot be anything but a date.
    `ReleaseDate: ${releaseDate}\n` +
    line('RequireExplicitUpgrade', true) +
    'Installers:\n' +
    ordered
      .map(
        (i) =>
          `- Architecture: ${formatScalar(i.arch)}\n` +
          `  InstallerUrl: ${formatScalar(i.url)}\n` +
          `  InstallerSha256: ${formatScalar(String(i.sha256).toUpperCase())}\n`
      )
      .join('') +
    line('ManifestType', 'installer') +
    line('ManifestVersion', MANIFEST_VERSION)

  const localeFile =
    header('defaultLocale') +
    common +
    line('PackageLocale', DEFAULT_LOCALE) +
    line('Publisher', PUBLISHER) +
    line('PublisherUrl', `https://github.com/${PUBLISHER}`) +
    line('PublisherSupportUrl', `${REPO_URL}/issues`) +
    line('Author', PUBLISHER) +
    line('PackageName', PACKAGE) +
    line('PackageUrl', REPO_URL) +
    line('License', 'MIT') +
    line('ShortDescription', SHORT_DESCRIPTION) +
    line('Description', DESCRIPTION) +
    line('Moniker', MONIKER) +
    'Tags:\n' +
    TAGS.map((t) => `- ${formatScalar(t)}\n`).join('') +
    line('ReleaseNotesUrl', `${REPO_URL}/releases/tag/v${v}`) +
    line('ManifestType', 'defaultLocale') +
    line('ManifestVersion', MANIFEST_VERSION)

  return {
    dir: wingetDir(v),
    files: {
      [FILE_NAMES.version]: versionFile,
      [FILE_NAMES.installer]: installerFile,
      [FILE_NAMES.defaultLocale]: localeFile,
    },
  }
}

/** Uppercase SHA-256 of a file, read in chunks. */
export function sha256Upper(path) {
  const hash = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1 << 20)
    let read
    while ((read = readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, read))
  } finally {
    closeSync(fd)
  }
  return hash.digest('hex').toUpperCase()
}

function argValue(argv, flag) {
  const at = argv.indexOf(flag)
  return at === -1 ? undefined : argv[at + 1]
}

function main(argv) {
  const fail = (message) => {
    console.error(`::error::${message}`)
    process.exit(1)
  }
  try {
    if (argv.includes('--print-urls')) {
      const v = assertStableVersion(argValue(argv, '--version'))
      for (const arch of winArches()) console.log(`${arch} ${installerUrl(v, arch)}`)
      return
    }

    const version = argValue(argv, '--version')
    const dir = argValue(argv, '--installers')
    const releaseDate = argValue(argv, '--release-date')
    const out = argValue(argv, '--out')
    if (!version || !dir || !releaseDate || !out) {
      console.error(
        'usage: node scripts/winget.mjs --version <x.y.z> --installers <dir> --release-date <YYYY-MM-DD> --out <dir>\n' +
          '       node scripts/winget.mjs --print-urls --version <x.y.z>'
      )
      process.exit(2)
    }
    const v = assertStableVersion(version)
    const installers = winArches().map((arch) => {
      const path = join(dir, installerName(v, arch))
      if (!existsSync(path)) {
        throw new Error(`${path} is missing. winget gets every Windows arch scripts/targets.mjs builds, or none of them.`)
      }
      return { arch, url: installerUrl(v, arch), sha256: sha256Upper(path) }
    })
    const result = wingetManifests({ version: v, releaseDate, installers })
    const target = join(out, ...result.dir.split('/'))
    mkdirSync(target, { recursive: true })
    for (const [name, text] of Object.entries(result.files)) {
      writeFileSync(join(target, name), text)
      console.log(join(target, name))
    }
    for (const i of installers) console.log(`  ${i.arch}  ${i.sha256}  ${i.url}`)
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error))
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
