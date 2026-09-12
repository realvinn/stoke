/*
 * The gate between a built matrix and a published release.
 *
 * The failure it exists for is silent by construction: a release that carries
 * four of its five platforms looks complete from every angle — green run, green
 * publish, assets on the page — and the missing arch's installed copies simply
 * never learn another version exists. Nothing on any screen says so. That is
 * exactly what v0.4.0-beta.3 shipped (a dmg-only latest-mac.yml, so no Mac
 * could ever update itself; CLAUDE.md gotcha 24), and every extra job in the
 * matrix adds another way to ship it.
 *
 * So the rule is not "the manifests exist". It is: for every target the repo
 * claims to build, the feed that target's updater will fetch must list a file
 * that target's updater will accept, and that file must actually be on disk.
 * The expectations are derived from scripts/targets.mjs rather than written out
 * again here — adding a platform to the matrix tightens this gate in the same
 * edit, which is the only arrangement that does not drift.
 *
 * Pure apart from `main`, so scripts/verify-manifests.mts can assert the rule
 * itself rather than only its output (CLAUDE.md gotcha 31).
 *
 * Usage:
 *   node scripts/check-release-assets.mjs <dir> [--version 0.9.5]
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { MANIFEST_RE, parseManifest } from './merge-update-manifests.mjs'
import { TARGETS } from './targets.mjs'

/**
 * Which feed each target's electron-updater fetches, and what it must find in
 * it. Mirrors `getUpdateInfoFileName` (arch-suffixed only on Linux) on the
 * write side and `getChannelFilePrefix` on the read side.
 *
 * `archInUrl` is on for the two platforms whose manifest is shared between
 * arches, because there the url substring is the ONLY thing that tells the two
 * apart: electron-updater picks `files.find(f => f.url.includes(process.arch))`
 * (Provider.js). It is off for Linux, whose feed is already per-arch and whose
 * AppImage is named with no arch token at all for x64 —
 * `getArtifactArchName(x64, "AppImage")` is `x86_64`, which does not contain
 * "x64", so asserting the substring there would fail a correct release.
 *
 * `zip` is on for macOS only: MacUpdater searches the feed for a .zip and
 * rejects "dmg" and "pkg" by name, so a mac arch listed only as a dmg is an
 * arch that cannot update.
 */
export function expectedFeeds(targets = TARGETS) {
  const feeds = new Map()
  for (const target of targets) {
    const { manifest, archInUrl, zip } =
      target.platform === 'win32'
        ? { manifest: 'latest.yml', archInUrl: true, zip: false }
        : target.platform === 'darwin'
          ? { manifest: 'latest-mac.yml', archInUrl: true, zip: true }
          : {
              manifest: target.arch === 'x64' ? 'latest-linux.yml' : `latest-linux-${target.arch}.yml`,
              archInUrl: false,
              zip: false,
            }
    if (!feeds.has(manifest)) feeds.set(manifest, { manifest, archInUrl, zip, archs: [], targets: [] })
    const feed = feeds.get(manifest)
    if (!feed.archs.includes(target.arch)) feed.archs.push(target.arch)
    feed.targets.push(target.key)
  }
  return [...feeds.values()]
}

/**
 * Every reason this directory must not be published, as sentences. Empty means
 * publish.
 *
 * @param {object} input
 * @param {Map<string, object>} input.manifests  basename -> parsed manifest
 * @param {Set<string>} input.assets             filenames present on disk
 * @param {string} [input.version]               the version the tag promised
 * @param {object[]} [input.targets]
 */
export function auditRelease({ manifests, assets, version, targets = TARGETS }) {
  const problems = []

  for (const feed of expectedFeeds(targets)) {
    const manifest = manifests.get(feed.manifest)
    if (!manifest) {
      problems.push(
        `${feed.manifest} is missing, so ${feed.targets.join(' and ')} can never auto-update from this release.`
      )
      continue
    }
    const files = Array.isArray(manifest.files) ? manifest.files : []
    if (files.length === 0) {
      problems.push(`${feed.manifest} lists no files at all.`)
      continue
    }
    if (!feed.archInUrl) continue

    for (const arch of feed.archs) {
      const match = files.filter((f) => {
        const url = String(f.url ?? '')
        // arm64 contains no "x64", and "x64" contains no "arm64", so a plain
        // substring test separates the two — which is the same test
        // electron-updater itself applies.
        if (!url.includes(arch)) return false
        return feed.zip ? url.endsWith('.zip') : true
      })
      if (match.length === 0) {
        problems.push(
          `${feed.manifest} lists no ${feed.zip ? '.zip ' : ''}file whose name contains "${arch}", so ${arch} ` +
            `installs will not find a download in it. Listed: ${files.map((f) => f.url).join(', ')}.`
        )
      }
    }
  }

  for (const [name, manifest] of manifests) {
    for (const file of Array.isArray(manifest.files) ? manifest.files : []) {
      const url = String(file.url ?? '')
      if (url && !assets.has(url)) {
        problems.push(`${name} names ${url}, which is not in the release directory — the update would 404.`)
      }
    }
    if (version != null && String(manifest.version) !== version) {
      problems.push(
        `${name} says version ${manifest.version} but this release is ${version}. ` +
          'package.json and the tag have to agree, or installed copies compare against the wrong number.'
      )
    }
  }

  return problems
}

/** Read a flat release directory into the shape `auditRelease` wants. */
export function readReleaseDir(dir) {
  const manifests = new Map()
  const assets = new Set()
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    if (MANIFEST_RE.test(entry.name)) {
      manifests.set(entry.name, parseManifest(readFileSync(join(dir, entry.name), 'utf8'), entry.name))
    } else {
      assets.add(entry.name)
    }
  }
  return { manifests, assets }
}

function main(argv) {
  const dir = argv.find((a) => !a.startsWith('--'))
  const versionAt = argv.indexOf('--version')
  const version = versionAt === -1 ? undefined : argv[versionAt + 1]
  if (!dir) {
    console.error('usage: node scripts/check-release-assets.mjs <dir> [--version <x.y.z>]')
    process.exit(2)
  }
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`::error::${dir} is not a directory, so there is nothing to publish.`)
    process.exit(1)
  }

  const { manifests, assets } = readReleaseDir(dir)
  for (const [name, manifest] of manifests) {
    console.log(`${name}  ${(manifest.files ?? []).map((f) => basename(String(f.url))).join(', ')}`)
  }

  const problems = auditRelease({ manifests, assets, version })
  if (problems.length) {
    for (const problem of problems) console.error(`::error::${problem}`)
    console.error(`\n${problems.length} reason(s) not to publish this release.`)
    process.exit(1)
  }
  console.log(`\n${manifests.size} manifests and ${assets.size} assets, all accounted for.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
