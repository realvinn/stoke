/*
 * Turns the one build mistake that has no build error into a red job.
 *
 * `@lydell/node-pty` resolves its binary at RUNTIME:
 *   const PACKAGE_NAME = `@lydell/node-pty-${process.platform}-${process.arch}`
 * npm installs only the sibling matching the BUILD HOST, so an
 * `electron-builder --win --arm64` run on an x64 runner packages
 * `node-pty-win32-x64`. The installer builds, installs and launches; the first
 * `pty.start` throws MODULE_NOT_FOUND and every tab is dead. Nothing in the
 * build says a word about it.
 *
 * So each build job asserts what it actually packaged. Cheap — it is a
 * directory listing — and it is the difference between a broken release and a
 * failed job. Written in node rather than shell because it has to run
 * identically under PowerShell, bash and whatever windows-11-arm defaults to.
 *
 * Usage:
 *   node scripts/assert-packaged-pty.mjs <target-key> [releaseDir]
 */
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TARGETS, ptyPackageFor, targetFor } from './targets.mjs'

const UNPACKED = 'app.asar.unpacked'

/**
 * Every `<...>/app.asar.unpacked/node_modules/@lydell` under `root`. Found by
 * walking rather than by composing a path, because where that directory lands
 * differs per platform (release/win-unpacked/resources/…,
 * release/mac-arm64/Stoke.app/Contents/Resources/…,
 * release/linux-unpacked/resources/…) and a hardcoded path that stops matching
 * would make this pass by finding nothing.
 */
export function findPtyDirs(root, { readdir = readdirSync, stat = statSync } = {}) {
  const hits = []
  const walk = (dir, depth) => {
    if (depth > 8) return
    let entries
    try {
      entries = readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name === UNPACKED) {
        const lydell = join(full, 'node_modules', '@lydell')
        if (stat(lydell, { throwIfNoEntry: false })?.isDirectory()) {
          hits.push({ path: lydell, packages: readdir(lydell).filter((n) => n.startsWith('node-pty-')) })
        }
        continue
      }
      walk(full, depth + 1)
    }
  }
  walk(root, 0)
  return hits
}

/**
 * @param {string} expected  e.g. "@lydell/node-pty-win32-arm64"
 * @param {{ path: string, packages: string[] }[]} hits
 * @returns {string[]} reasons this build must not ship
 */
export function auditPty(expected, hits) {
  const wanted = expected.replace('@lydell/', '')
  if (hits.length === 0) {
    return [
      `Found no ${UNPACKED}/node_modules/@lydell anywhere in the packaged output. ` +
        "electron-builder.yml's asarUnpack is what puts it there; without it the .node binary is inside " +
        'the asar and the OS loader cannot dlopen it.',
    ]
  }
  const problems = []
  for (const hit of hits) {
    if (!hit.packages.includes(wanted)) {
      problems.push(
        `${hit.path} carries ${hit.packages.join(', ') || 'no node-pty package at all'} — this build needs ` +
          `${wanted}. The runner's npm tree was the wrong architecture, so every terminal in it would throw ` +
          'MODULE_NOT_FOUND on the first session.'
      )
      continue
    }
    const strays = hit.packages.filter((n) => n !== wanted)
    if (strays.length) {
      problems.push(`${hit.path} also carries ${strays.join(', ')}, which belongs to another architecture's build.`)
    }
  }
  return problems
}

function main(argv) {
  const key = argv[0]
  const root = argv[1] ?? 'release'
  const target = targetFor(key)
  if (!target) {
    console.error(
      `::error::No build target named "${key}". Known: ${TARGETS.map((t) => t.key).join(', ')}.`
    )
    process.exit(2)
  }

  const expected = ptyPackageFor(target)
  const hits = findPtyDirs(root)
  const problems = auditPty(expected, hits)
  if (problems.length) {
    for (const problem of problems) console.error(`::error::${problem}`)
    process.exit(1)
  }
  console.log(`${expected} is present in all ${hits.length} packaged output(s) under ${root}/.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
