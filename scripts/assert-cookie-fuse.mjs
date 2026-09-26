/*
 * Reads the Electron fuses back out of every packaged build and refuses one
 * that stores cookies unencrypted, or that cannot run as node.
 *
 * The fuses are bytes in the Electron binary, flipped by electron-builder from
 * `electronFuses` in electron-builder.yml, and nothing at build or run time
 * says what they are. Two of them matter here, in opposite directions:
 *
 *   - EnableCookieEncryption must be ON. Off, Chromium writes every cookie's
 *     value into the partition's SQLite file as plain text (measured: the value
 *     column held the string, encrypted_value was 0 bytes), and the browser
 *     import refuses logins (gotcha 107). It is one-way: a store written
 *     encrypted is unreadable to a build with the fuse off, so a release that
 *     lost it would sign every user out.
 *   - RunAsNode must stay ON. The statusLine wrapper and the hook shim run
 *     Stoke's own binary with ELECTRON_RUN_AS_NODE=1 (statusLine.ts); off, the
 *     context meter and every activity dot go dark with no error anywhere.
 *
 * Usage:
 *   node scripts/assert-cookie-fuse.mjs [releaseDir]
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
// CommonJS: named imports are not visible to ESM, so take the default.
import fuses from '@electron/fuses'

const { FuseV1Options, getCurrentFuseWire } = fuses
/** The wire holds ASCII: '1' (49) on. FuseState is not exported by the package. */
const ENABLE = 49

/**
 * Every packaged Electron binary under `root`, in the form getCurrentFuseWire
 * takes: a macOS `.app` bundle, a Windows `Stoke.exe`, a Linux `stoke`. Found by
 * walking, like assert-packaged-pty.mjs, because the folders differ per target.
 */
export function findPackagedApps(root, { readdir = readdirSync, stat = statSync } = {}) {
  const hits = []
  const walk = (dir, depth) => {
    if (depth > 4) return
    let entries
    try {
      entries = readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory() && entry.name.endsWith('.app')) {
        hits.push(full)
        continue
      }
      if (entry.isFile() && dir.endsWith('-unpacked') && /^(stoke|Stoke\.exe)$/.test(entry.name)) {
        hits.push(full)
        continue
      }
      if (entry.isDirectory() && !stat(full, { throwIfNoEntry: false })?.isSymbolicLink?.()) walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return hits
}

/**
 * @param {Record<number, number>} wire  getCurrentFuseWire's answer
 * @returns {string[]} reasons this build must not ship
 */
export function auditFuses(wire) {
  const problems = []
  if (wire[FuseV1Options.EnableCookieEncryption] !== ENABLE) {
    problems.push(
      'EnableCookieEncryption is not on: every cookie would be written to disk as plain text, and a user ' +
        'upgrading from an encrypting build would find their store unreadable. Check electronFuses in electron-builder.yml.'
    )
  }
  if (wire[FuseV1Options.RunAsNode] !== ENABLE) {
    problems.push(
      'RunAsNode is not on: the statusLine wrapper and hook shim run Stoke as node (ELECTRON_RUN_AS_NODE), ' +
        'so the context meter and activity dots would silently stop.'
    )
  }
  return problems
}

async function main(argv) {
  const root = argv[0] ?? 'release'
  const apps = findPackagedApps(root)
  if (apps.length === 0) {
    console.error(`::error::Found no packaged Stoke under ${root}/ to read the fuses of.`)
    process.exit(1)
  }
  let failed = false
  for (const app of apps) {
    const problems = auditFuses(await getCurrentFuseWire(app))
    for (const problem of problems) console.error(`::error::${app}: ${problem}`)
    if (problems.length) failed = true
    else console.log(`${app}: cookies encrypted, run-as-node kept.`)
  }
  if (failed) process.exit(1)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2))
