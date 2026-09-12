/*
 * Merges the per-job update manifests one release's build matrix produced into
 * the one manifest per platform electron-updater actually reads.
 *
 * WHY THIS EXISTS, precisely. `getUpdateInfoFileName`
 * (app-builder-lib/out/publish/updateInfoBuilder.js) applies an arch suffix
 * ONLY on Linux:
 *
 *   Windows   x64 -> latest.yml            arm64 -> latest.yml            COLLIDE
 *   macOS     x64 -> latest-mac.yml        arm64 -> latest-mac.yml        COLLIDE
 *   Linux     x64 -> latest-linux.yml      arm64 -> latest-linux-arm64.yml  no
 *
 * Within ONE electron-builder invocation the collision is already solved:
 * `writeUpdateInfoFiles` keys tasks by file name and, on a hit, does
 * `existingTask.info.files.push(...task.info.files)` — it merges the arrays.
 * The published v0.9.4 latest-mac.yml is the proof: one invocation, two
 * artifacts, one file listing both the zip and the dmg.
 *
 * ACROSS invocations there is no merge at all. `writeUpdateInfoFiles` ends in
 * `outputFile(task.file, content)`, which overwrites — and one arch per job on
 * a native runner (scripts/targets.mjs explains why that is mandatory) means
 * two jobs each write a `latest.yml`. Downloading them with
 * `merge-multiple: true` flattens both onto one name with no warning, and the
 * loser's users get a feed that does not list their arch: every installed copy
 * on that arch silently stops updating, while the release looks complete from
 * every angle. That is gotcha 24's failure shape exactly (v0.4.0-beta.3's
 * dmg-only latest-mac.yml), which is why this is a merge with a suite rather
 * than a `cp`.
 *
 * The rules below follow updateInfoBuilder.js so the output is what a single
 * invocation would have produced. scripts/verify-manifests.mts asserts that
 * against the real published v0.9.4 manifests, byte for byte.
 *
 * NO DEPENDENCIES, deliberately. This runs in the publish job, which downloads
 * artifacts and nothing else — a js-yaml import would mean an `npm ci` there
 * just to read eight lines of YAML. The parser is strict instead: it refuses
 * anything outside the manifest shape rather than guessing, and
 * verify:manifests cross-checks the serialiser against the real js-yaml.
 *
 * Usage:
 *   node scripts/merge-update-manifests.mjs <inDir> --out <outDir>
 */
import { readdirSync, readFileSync, statSync, mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, basename, relative } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * builder-util's Arch enum, which is the tie-break order
 * `writeUpdateInfoFiles` sorts by. Copied rather than imported because this
 * module must run with no node_modules present.
 */
export const ARCH_ORDER = { ia32: 0, x64: 1, armv7l: 2, arm64: 3, universal: 4 }

/** A manifest filename electron-updater would fetch. */
export const MANIFEST_RE = /^latest(-mac|-linux(-[a-z0-9]+)?)?\.yml$/

// ---------------------------------------------------------------- YAML, the
// exact subset electron-builder writes. Strict on the way in: a construct this
// does not understand is an error, never a silently dropped key.

/*
 * Everything below to `formatScalar` is a transcription of js-yaml 4's own
 * dumper, narrowed to the scalars a manifest holds (no multi-line strings, no
 * non-printables). Transcribed rather than approximated because the point of
 * this file is to produce exactly what electron-builder produces — builder-util
 * calls js-yaml's `dump`, so "close enough" is a diff in a released manifest.
 * verify:manifests diffs the two implementations over a battery and a fuzz.
 *
 * Sources, js-yaml 4.1.x dist/js-yaml.js:
 *   DEPRECATED_BOOLEANS_SYNTAX / DEPRECATED_BASE60_SYNTAX  (writeScalar)
 *   isPlainSafeFirst / isPlainSafeLast / isPlainSafe        (chooseScalarStyle)
 *   resolveYamlNull / Boolean / Integer / Float / Timestamp / Merge
 */

/** writeScalar's noCompatMode escape hatch: YAML 1.1 booleans js-yaml no longer resolves but still quotes. */
const DEPRECATED_BOOLEANS = new Set(
  ['y', 'Y', 'yes', 'Yes', 'YES', 'on', 'On', 'ON', 'n', 'N', 'no', 'No', 'NO', 'off', 'Off', 'OFF']
)
const DEPRECATED_BASE60 = /^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?$/

/**
 * The characters isPlainSafeFirst rejects, plus whitespace.
 *
 * `, [ ] { }` are on this list for the FIRST position only, and that asymmetry
 * is measured rather than assumed: isPlainSafe takes an `inblock` flag, and a
 * value in a block mapping or a block sequence — which is every value in a
 * manifest — is in block context, where those five are ordinary characters.
 * js-yaml really does dump `{ v: 'a{b' }` as `v: a{b`.
 */
const UNSAFE_FIRST = new Set([...`-?:,[]{}#&*!|=>'"%@\``, ' ', '\t'])

const YAML_NULL = /^(?:~|null|Null|NULL)$/
const YAML_BOOL = /^(?:true|True|TRUE|false|False|FALSE)$/
const YAML_DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/
const YAML_TIMESTAMP =
  /^[0-9]{4}-[0-9]{1,2}-[0-9]{1,2}(?:[Tt]|[ \t]+)[0-9]{1,2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9]{1,2}(?::[0-9]{2})?))?$/
const YAML_FLOAT =
  /^(?:[-+]?(?:[0-9]+)(?:\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/
const YAML_FLOAT_SPECIAL = /^(?:[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$/

/** resolveYamlInteger, transcribed. Note it rejects underscores, unlike YAML 1.1. */
function resolvesAsInteger(data) {
  const max = data.length
  if (!max) return false
  let index = 0
  let ch = data[index]
  if (ch === '-' || ch === '+') ch = data[++index]
  if (ch === '0') {
    if (index + 1 === max) return true
    ch = data[++index]
    if (ch === 'b') return /^[01]+$/.test(data.slice(index + 1))
    if (ch === 'x') return /^[0-9A-Fa-f]+$/.test(data.slice(index + 1))
    if (ch === 'o') return /^[0-7]+$/.test(data.slice(index + 1))
  }
  const rest = data.slice(index)
  return rest.length > 0 && /^[0-9]+$/.test(rest)
}

function resolvesImplicitly(value) {
  if (YAML_NULL.test(value)) return true
  if (YAML_BOOL.test(value)) return true
  if (resolvesAsInteger(value)) return true
  if (YAML_FLOAT.test(value) && (Number.isFinite(parseFloat(value)) || YAML_FLOAT_SPECIAL.test(value))) return true
  if (YAML_DATE.test(value) || YAML_TIMESTAMP.test(value)) return true
  if (value === '<<') return true
  return false
}

/**
 * A character js-yaml calls unprintable sends it to its double-quoted or block
 * style, which has its own escaping rules and which no url, digest or version
 * can legitimately need. Reproducing those rules on spec would be the guess
 * this whole file avoids, so the value is refused instead — loudly, at the
 * point it appears.
 *
 * This is the exact complement of js-yaml's own `isPrintable`, not a list of
 * the obvious offenders, and the difference was measured rather than reasoned.
 * `isPrintable` is
 *
 *   0x20-0x7E | 0xA1-0xD7FF (minus 2028/2029) | 0xE000-0xFFFD (minus FEFF)
 *             | 0x10000-0x10FFFF
 *
 * so **0x7F through 0xA0 — a non-breaking space included — plus 2028/2029, a
 * lone surrogate and FFFE/FFFF are unprintable too**, and the first version of
 * this regex named only 0x00-0x1F, 0x7F and FEFF. For every character in that
 * gap the two implementations disagreed silently: js-yaml double-quoted, this
 * wrote a plain scalar, and the promise to refuse rather than guess was not
 * being kept. The `u` flag is load-bearing — without it \ud800-\udfff matches
 * the two halves of an ordinary astral character, which js-yaml calls
 * printable, so an emoji in a filename would be refused instead.
 */
const UNWRITABLE = /[\u0000-\u001f\u007f-\u00a0\u2028\u2029\ud800-\udfff\ufeff\ufffe\uffff]/u

/**
 * True when js-yaml would single-quote this string rather than write it plain.
 * Throws for a string js-yaml would write in neither style.
 */
export function needsQuoting(value) {
  const bad = UNWRITABLE.exec(value)
  if (bad) {
    throw new Error(
      `A manifest value contains ${JSON.stringify(bad[0])}, which js-yaml would escape into a double-quoted ` +
        `or block scalar: ${JSON.stringify(value)}. Nothing electron-builder writes into a manifest can ` +
        'contain one, so this is a corrupt input rather than a case to handle.'
    )
  }
  if (value === '') return true
  if (DEPRECATED_BOOLEANS.has(value) || DEPRECATED_BASE60.test(value)) return true

  if (UNSAFE_FIRST.has(value[0])) return true
  const last = value[value.length - 1]
  if (last === ' ' || last === ':') return true

  for (let i = 0; i < value.length; i++) {
    // A '#' is safe only directly after a non-space; a ':' is safe only
    // directly before one.
    if (value[i] === '#') {
      const prev = value[i - 1]
      if (prev === undefined || prev === ' ') return true
    }
    if (value[i - 1] === ':' && value[i] === ' ') return true
  }

  return resolvesImplicitly(value)
}

/** One scalar, as js-yaml's default dump would write it. */
export function formatScalar(value) {
  if (typeof value === 'number') return String(value)
  if (typeof value === 'boolean') return String(value)
  if (value == null) return 'null'
  const text = String(value)
  return needsQuoting(text) ? `'${text.replace(/'/g, "''")}'` : text
}

function parseScalar(raw, where) {
  const text = raw.trim()
  if (text.startsWith("'")) {
    if (!text.endsWith("'") || text.length < 2) throw new Error(`${where}: unterminated single-quoted scalar`)
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('"')) {
    if (!text.endsWith('"') || text.length < 2) throw new Error(`${where}: unterminated double-quoted scalar`)
    return text.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  // A flow collection would parse as a plain string and then quietly not be a
  // list, so `files: [a, b]` would reach mergeManifests as the string "[a, b]"
  // and be reported as "lists no files" — true, but three steps from the cause.
  if (text.startsWith('[') || text.startsWith('{')) {
    throw new Error(`${where}: flow collections are not part of the update-manifest shape`)
  }
  if (/^-?\d+$/.test(text)) return Number(text)
  return text
}

/**
 * The manifest shape and nothing else: top-level `key: scalar`, plus one
 * `files:` block sequence of flat mappings. Anything else throws with the line
 * number, because a manifest this cannot read is a manifest nobody should
 * publish half of.
 */
export function parseManifest(text, source = 'manifest') {
  const out = {}
  const lines = text.split('\n')
  let list = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '')
    const where = `${source}:${i + 1}`
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue

    const top = /^([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(line)
    if (top) {
      const [, key, rest] = top
      if (rest.trim() === '') {
        list = []
        out[key] = list
      } else {
        list = null
        out[key] = parseScalar(rest, where)
      }
      continue
    }

    const item = /^ {2}- ([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(line)
    if (item) {
      if (list == null) throw new Error(`${where}: a list item with no list above it`)
      list.push({ [item[1]]: parseScalar(item[2], where) })
      continue
    }

    const cont = /^ {4}([A-Za-z][A-Za-z0-9_]*):(.*)$/.exec(line)
    if (cont) {
      if (list == null || list.length === 0) throw new Error(`${where}: a mapping key with no list item above it`)
      list[list.length - 1][cont[1]] = parseScalar(cont[2], where)
      continue
    }

    throw new Error(
      `${where}: this is not the update-manifest shape and will not be guessed at: ${JSON.stringify(line)}`
    )
  }

  return out
}

/** js-yaml.dump's output for this shape, reproduced without js-yaml. */
export function serializeManifest(manifest) {
  let out = ''
  for (const [key, value] of Object.entries(manifest)) {
    if (value === undefined) continue
    if (Array.isArray(value)) {
      out += `${key}:\n`
      for (const entry of value) {
        let first = true
        for (const [k, v] of Object.entries(entry)) {
          if (v === undefined) continue
          out += `${first ? '  - ' : '    '}${k}: ${formatScalar(v)}\n`
          first = false
        }
        if (first) throw new Error(`${key} holds an empty entry, which has no representation here`)
      }
    } else {
      out += `${key}: ${formatScalar(value)}\n`
    }
  }
  return out
}

// ------------------------------------------------------------------- merging

/**
 * The arch a file's own name declares, as an ARCH_ORDER value, or null when it
 * declares none. -1 is what `writeUpdateInfoFiles` gives `arch === null` (a
 * universal or combined artifact) so it sorts first.
 *
 * Derived from the name rather than from a build event, because across jobs the
 * name is all there is — and it is the same rule electron-updater's own
 * `findFile` applies on the read side, which is what makes it the right one:
 * `Provider.js` picks the entry whose url contains `process.arch`. Order
 * matters here: arm64 contains "arm", and x86_64 does not contain "x64".
 */
export function archRankFor(url) {
  const name = url.toLowerCase()
  if (name.includes('universal')) return ARCH_ORDER.universal
  if (name.includes('arm64') || name.includes('aarch64')) return ARCH_ORDER.arm64
  if (name.includes('armv7l') || name.includes('armhf')) return ARCH_ORDER.armv7l
  if (name.includes('x86_64') || name.includes('x64') || name.includes('amd64')) return ARCH_ORDER.x64
  if (name.includes('ia32') || name.includes('i386') || name.includes('i686')) return ARCH_ORDER.ia32
  return -1
}

/**
 * `writeUpdateInfoFiles`'s comparator, at file granularity: a .zip first
 * (MacUpdater searches the feed for one and rejects dmg/pkg by name — gotcha
 * 24), then arch-null before arch-specific, then the Arch enum's own order, so
 * x64(1) precedes arm64(3).
 */
export function compareUpdateFiles(a, b) {
  const zipDiff = (a.url.endsWith('.zip') ? 0 : 100) - (b.url.endsWith('.zip') ? 0 : 100)
  if (zipDiff !== 0) return zipDiff
  return archRankFor(a.url) - archRankFor(b.url)
}

/**
 * One manifest out of several for the same platform.
 *
 * @param {{ source: string, manifest: object }[]} inputs
 */
export function mergeManifests(inputs) {
  if (inputs.length === 0) throw new Error('mergeManifests was given nothing to merge')

  // A version mismatch means two jobs built different commits, so half the
  // manifest would be stale the moment it published. Loud, and naming both
  // sides, because the alternative is a release that updates some users to a
  // build that does not exist.
  const versions = new Map()
  for (const { source, manifest } of inputs) {
    const version = manifest.version
    if (version == null || version === '') throw new Error(`${source} states no version`)
    if (!versions.has(String(version))) versions.set(String(version), [])
    versions.get(String(version)).push(source)
  }
  if (versions.size > 1) {
    const detail = [...versions.entries()].map(([v, who]) => `  ${v}  ${who.join(', ')}`).join('\n')
    throw new Error(
      `Refusing to merge manifests built from different versions:\n${detail}\n` +
        'One of these jobs built a different commit. Re-run the whole matrix rather than publishing half a release.'
    )
  }

  const files = []
  const seen = new Map()
  for (const { source, manifest } of inputs) {
    const list = manifest.files
    if (!Array.isArray(list) || list.length === 0) throw new Error(`${source} lists no files`)
    for (const file of list) {
      if (typeof file.url !== 'string' || file.url === '') throw new Error(`${source} has a file entry with no url`)
      const already = seen.get(file.url)
      if (already) {
        // The same artifact named by two jobs. Identical is a harmless
        // duplicate; different bytes under one name means two different builds
        // would fight over one release asset, which is not recoverable later.
        if (already.entry.sha512 !== file.sha512) {
          throw new Error(
            `${file.url} appears in both ${already.source} and ${source} with different sha512 values. ` +
              'Two jobs produced different bytes under one name; the release could only ever carry one of them.'
          )
        }
        continue
      }
      seen.set(file.url, { source, entry: file })
      files.push(file)
    }
  }

  files.sort(compareUpdateFiles)

  // `path`/`sha512` are electron-updater 1.x-2.15 fallbacks, read only when
  // `files` is empty (Provider.js). Set from files[0] after sorting anyway,
  // matching createUpdateInfo, so the output is what one invocation would have
  // written rather than merely equivalent.
  const merged = {
    version: inputs[0].manifest.version,
    files,
    path: files[0].url,
    sha512: files[0].sha512,
  }

  // The latest wins: a release is published once, and the date a reader cares
  // about is when the last of its artifacts was built.
  const dates = inputs.map((i) => i.manifest.releaseDate).filter((d) => typeof d === 'string' && d !== '')
  if (dates.length) merged.releaseDate = dates.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b))

  // Anything else electron-builder wrote (stagingPercentage, and whatever a
  // future version adds) is carried through rather than dropped, but only when
  // every input agrees — a key that differs between arches is a decision, not
  // a merge.
  const known = new Set(['version', 'files', 'path', 'sha512', 'releaseDate'])
  for (const key of new Set(inputs.flatMap((i) => Object.keys(i.manifest)))) {
    if (known.has(key)) continue
    const values = inputs.map((i) => JSON.stringify(i.manifest[key] ?? null))
    if (new Set(values).size !== 1) {
      throw new Error(
        `The inputs disagree about "${key}" (${values.join(' vs ')}). ` +
          'Merging would have to pick one, and picking silently is how an arch gets dropped.'
      )
    }
    merged[key] = inputs[0].manifest[key]
  }

  return merged
}

/**
 * Group manifests by their basename. `latest.yml` from two Windows jobs is one
 * group; `latest-linux.yml` and `latest-linux-arm64.yml` are two, because
 * Linux is the one platform electron-builder already splits per arch.
 */
export function groupByBasename(found) {
  const groups = new Map()
  for (const item of found) {
    const name = basename(item.source)
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(item)
  }
  return groups
}

// ------------------------------------------------------------------------ IO

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

/**
 * Read a download-artifact tree (one directory per build job), merge every
 * manifest group, and copy the whole release's assets into one flat directory
 * ready for `gh release create`.
 */
export function mergeTree(inDir, outDir) {
  const all = walk(inDir)
  const manifests = []
  const assets = []
  for (const file of all) {
    if (MANIFEST_RE.test(basename(file))) manifests.push(file)
    else assets.push(file)
  }

  if (manifests.length === 0) {
    throw new Error(
      `No update manifests under ${inDir}. Every build job writes a latest*.yml; finding none means the ` +
        'artifacts did not arrive, and publishing would produce a release nothing can update from.'
    )
  }

  mkdirSync(outDir, { recursive: true })

  // Assets first, so a name collision is reported before anything is written
  // over. Two jobs emitting the same filename is a real bug (a missing ${arch}
  // in an artifactName, say), and `cp` would simply pick a winner.
  const placed = new Map()
  for (const file of assets) {
    const name = basename(file)
    const already = placed.get(name)
    if (already) {
      throw new Error(
        `Two build jobs both produced "${name}" (${relative(inDir, already)} and ${relative(inDir, file)}). ` +
          'A release can only carry one, so one platform\'s artifact would be lost silently.'
      )
    }
    placed.set(name, file)
    copyFileSync(file, join(outDir, name))
  }

  const written = []
  for (const [name, group] of groupByBasename(
    manifests.map((source) => ({ source, manifest: parseManifest(readFileSync(source, 'utf8'), source) }))
  )) {
    const merged = mergeManifests(group)
    writeFileSync(join(outDir, name), serializeManifest(merged))
    written.push({ name, from: group.map((g) => relative(inDir, g.source)), files: merged.files.map((f) => f.url) })
  }

  return { written, assets: [...placed.keys()].sort() }
}

function main(argv) {
  const inDir = argv.find((a) => !a.startsWith('--'))
  const outAt = argv.indexOf('--out')
  const outDir = outAt === -1 ? null : argv[outAt + 1]
  if (!inDir || !outDir) {
    console.error('usage: node scripts/merge-update-manifests.mjs <inDir> --out <outDir>')
    process.exit(2)
  }
  if (!statSync(inDir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`${inDir} is not a directory.`)
    process.exit(1)
  }

  let result
  try {
    result = mergeTree(inDir, outDir)
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }

  for (const { name, from, files } of result.written) {
    console.log(`${name}  <- ${from.join(', ')}`)
    for (const url of files) console.log(`    ${url}`)
  }
  console.log(`\n${result.assets.length} assets and ${result.written.length} manifests in ${outDir}.`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2))
