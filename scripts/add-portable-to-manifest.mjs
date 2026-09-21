/*
 * Lists each Windows portable zip in the merged latest.yml, so a portable copy
 * of Stoke can find its own update in the same feed the installer reads.
 *
 * WHY THIS EXISTS. electron-builder writes no update info for a Windows zip:
 * `ArchiveTarget`'s isWriteUpdateInfo defaults to false and targetFactory
 * never passes true for win (app-builder-lib 26.15.3), so each Windows job's
 * latest.yml lists its installer and nothing else, and the zip sits beside it
 * as an asset nothing points at. src/shared/installKind.ts's portableAssetFor
 * reads `files` for a `-<arch>-win.zip`; with no entry, a portable copy on
 * that arch would never be offered an update, and nothing on any screen would
 * say why.
 *
 * WHY IN THE PUBLISH JOB, AFTER THE MERGE. Each build job's manifest stays
 * exactly what electron-builder wrote, which is what lets verify:manifests hold
 * the merger to electron-builder's own `writeUpdateInfoFiles` byte for byte (its
 * oracle would stop meaning anything the moment the per-job inputs were edited).
 * The injection is one step on the merged result, and the gate runs after it.
 *
 * THE ORDER IS LOAD-BEARING. Each zip is appended AFTER every entry already
 * there, so `files[0]`, `path` and `sha512` still name an installer. NsisUpdater
 * picks with `findFile(files, 'exe')` (electron-updater 6.8.9,
 * providers/Provider.js:74-90): it filters to `.exe` first, so a zip anywhere in
 * the list is invisible to it — but a feed with NO .exe falls back to
 * `files[0]`, and hands the installer path a zip. So this refuses a manifest
 * that lists no .exe at all rather than adding a zip that could become that
 * files[0]; check-release-assets.mjs then refuses any arch whose .exe is gone.
 *
 * `sha512` is BASE64, like every other entry electron-builder writes (gotcha
 * 71: a hex digest never matches). Idempotent: a zip already listed with the
 * same digest and size is left alone, so a re-run of the publish job changes
 * nothing; the same name with different bytes is refused, because a release can
 * carry only one of them.
 *
 * No dependencies, for the same reason as the merger it borrows its YAML from:
 * the publish job has no node_modules.
 *
 * Usage:
 *   node scripts/add-portable-to-manifest.mjs <release-assets dir>
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { archRankFor, parseManifest, serializeManifest } from './merge-update-manifests.mjs'

/** A Windows portable zip, by name. The same suffix portableAssetFor reads. */
export const PORTABLE_ZIP_RE = /-win\.zip$/i

/** The feed Windows copies read — the only one a Windows zip belongs in. */
export const WIN_MANIFEST = 'latest.yml'

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The manifest with each zip listed, plus what was done.
 *
 * Pure: `zips` carries each file's name, base64 sha512 and size, already read.
 *
 * @param {object} manifest   a parsed latest.yml
 * @param {{ name: string, sha512: string, size: number }[]} zips
 * @param {string} [source]   for messages
 */
export function addPortableZips(manifest, zips, source = WIN_MANIFEST) {
  const version = manifest.version
  if (version == null || version === '') throw new Error(`${source} states no version.`)
  const files = Array.isArray(manifest.files) ? manifest.files : []

  if (!files.some((f) => String(f.url ?? '').toLowerCase().endsWith('.exe'))) {
    throw new Error(
      `${source} lists no .exe, so there is no installer for the zips to follow. NsisUpdater's findFile ` +
        "falls back to files[0] when a feed has no .exe, so adding a zip here could hand every Windows copy " +
        'a zip as its installer. The Windows build jobs did not deliver their manifests; re-run them.'
    )
  }

  // Two different expectations, and both refuse rather than guess: the name
  // must carry the manifest's version exactly (a zip from another build is a
  // file the installer's users would never be offered and a portable user would
  // be offered by mistake), and it must name one arch.
  const shape = new RegExp(`^.+-${escapeRe(String(version))}-([A-Za-z0-9_]+)-win\\.zip$`)
  for (const zip of zips) {
    if (!PORTABLE_ZIP_RE.test(zip.name)) throw new Error(`${zip.name} is not a Windows portable zip.`)
    if (!shape.test(zip.name)) {
      throw new Error(
        `${zip.name} is not version ${version}, which is what ${source} says this release is. ` +
          'One of the Windows jobs built a different commit; re-run the whole matrix rather than ' +
          'publishing a portable build nobody can match to its installer.'
      )
    }
    if (typeof zip.sha512 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(zip.sha512) || zip.sha512.length !== 88) {
      throw new Error(`${zip.name}: sha512 must be the 88-character base64 digest electron-builder writes, not ${JSON.stringify(zip.sha512)}.`)
    }
    if (!Number.isInteger(zip.size) || zip.size <= 0) throw new Error(`${zip.name}: size must be a positive integer.`)
  }

  const next = files.map((f) => ({ ...f }))
  const added = []
  const already = []
  // x64 before arm64, the Arch enum's own order — so the output does not
  // depend on the order readdir happened to return.
  const ordered = [...zips].sort((a, b) => archRankFor(a.name) - archRankFor(b.name) || a.name.localeCompare(b.name))
  for (const zip of ordered) {
    const listed = next.find((f) => f.url === zip.name)
    if (listed) {
      if (listed.sha512 !== zip.sha512 || Number(listed.size) !== zip.size) {
        throw new Error(
          `${source} already lists ${zip.name} with different bytes (sha512 ${listed.sha512}, size ${listed.size}) ` +
            `than the file on disk (sha512 ${zip.sha512}, size ${zip.size}). A release can carry only one of them.`
        )
      }
      already.push(zip.name)
      continue
    }
    next.push({ url: zip.name, sha512: zip.sha512, size: zip.size })
    added.push(zip.name)
  }

  // Every other key keeps its place, so `path`/`sha512` still follow `files`
  // exactly as electron-builder ordered them, and still name the installer.
  return { manifest: { ...manifest, files: next }, added, already }
}

/** A file's sha512, base64, read in chunks so a 130 MB zip is never one buffer. */
export function sha512Base64(path) {
  const hash = createHash('sha512')
  const fd = openSync(path, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1 << 20)
    let read
    while ((read = readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, read))
  } finally {
    closeSync(fd)
  }
  return hash.digest('base64')
}

/**
 * Do it to a flat release directory. Rewrites latest.yml only when something
 * was added, so a second run leaves the file's bytes and mtime alone.
 */
export function addPortableToDir(dir) {
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && PORTABLE_ZIP_RE.test(e.name))
    .map((e) => e.name)
    .sort()
  const manifestPath = join(dir, WIN_MANIFEST)
  if (names.length === 0) return { added: [], already: [], zips: [] }
  if (!existsSync(manifestPath)) {
    throw new Error(
      `${dir} holds ${names.join(', ')} but no ${WIN_MANIFEST} to list them in. Every Windows job writes one; ` +
        'finding none means the merge did not run or the manifests never arrived.'
    )
  }
  const before = readFileSync(manifestPath, 'utf8')
  const zips = names.map((name) => ({ name, sha512: sha512Base64(join(dir, name)), size: statSync(join(dir, name)).size }))
  const { manifest, added, already } = addPortableZips(parseManifest(before, manifestPath), zips, manifestPath)
  if (added.length) writeFileSync(manifestPath, serializeManifest(manifest))
  return { added, already, zips: names }
}

function main(argv) {
  const dir = argv.find((a) => !a.startsWith('--'))
  if (!dir) {
    console.error('usage: node scripts/add-portable-to-manifest.mjs <dir>')
    process.exit(2)
  }
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`::error::${dir} is not a directory.`)
    process.exit(1)
  }
  let result
  try {
    result = addPortableToDir(dir)
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
  if (result.zips.length === 0) {
    // Not an error HERE: whether a release must carry portable zips is the
    // gate's rule (it derives it from scripts/targets.mjs), and it runs next.
    console.log(`No *-win.zip in ${dir}; ${WIN_MANIFEST} left as it was.`)
    return
  }
  for (const name of result.added) console.log(`${WIN_MANIFEST}  + ${name}`)
  for (const name of result.already) console.log(`${WIN_MANIFEST}  = ${name} (already listed, same bytes)`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
