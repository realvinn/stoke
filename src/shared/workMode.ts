/**
 * Work mode: the rules of the pretend IDE (the "Work mode" built-in plugin,
 * id `work-mode`). Not the Work boards plugin (`plugins.ts`, `workPlugin.ts`),
 * which is a different, serious thing.
 *
 * Everything here is pure and compiled by both tsconfigs (gotcha 27): no
 * `node:` import, no DOM. Main's reader (main/plugins/workMode.ts) decides
 * what may be listed and read with these rules, the renderer's overlay
 * (components/WorkMode.tsx) decides what a key and a pointer do with them, and
 * `verify:work-mode` holds them. Relative imports carry `.ts` (gotcha 78).
 *
 * What it promises the owner: the project's files are READ, never written,
 * never run and never sent; nothing secret-named, ignored, data or config is
 * opened; text shaped like a key is masked in main before it reaches the
 * renderer. It does NOT promise that every password is caught: a short one no
 * pattern knows is shown as written (gotcha 156's known class), which is why
 * the copy says it shows real code.
 */
import { PRESS_QUIET_MS } from './launcher.ts'

/* --------------------------------------------------------------- constants */

/** Characters typed per key press: the default, and the bounds of the setting. */
export const WM_CHARS_DEFAULT = 4
export const WM_CHARS_MIN = 1
export const WM_CHARS_MAX = 12
/** Two fresh Escape presses no more than this apart leave Work mode. */
export const WM_EXIT_WINDOW_MS = 800
/** After the leave, keys are swallowed until the keyboard has been quiet this long: one burst (`PRESS_QUIET_MS`). */
export const WM_TAIL_QUIET_MS = PRESS_QUIET_MS
/** The "press Esc twice to leave" pill at open, and the "again" pill after one Escape. */
export const WM_HINT_MS = 2600
export const WM_HINT_AGAIN_MS = 800
/** Pointer travel that adds one whole line, the least time between two, a hop that is a re-entry, and the idle that drops the carry. */
export const WM_PX_PER_LINE = 120
export const WM_FILL_GAP_MS = 220
export const WM_JUMP_PX = 400
export const WM_IDLE_MS = 1500
/** About one line in this many structure-neutral lines is left as a hole, never more than this many in a row. */
export const WM_SKIP_EVERY = 6
export const WM_SKIP_RUN_MAX = 2
/** Tabs per editor group, and the build panel's kept lines. */
export const WM_TABS_MAX = 6
export const WM_PANEL_LINES_MAX = 200
/** What main reads: files per picked type, files in all, a file's size bounds, all bytes, a line's length. */
export const WM_FILES_PER_TYPE = 8
export const WM_FILES_MAX = 24
export const WM_FILE_MIN_BYTES = 300
export const WM_FILE_MAX_BYTES = 65536
export const WM_TOTAL_MAX_BYTES = 1048576
export const WM_LINE_MAX_CHARS = 400
/** A Markdown line's cap instead: a paragraph is often one line, and soft wrap draws it (minified prose does not exist). */
export const WM_PROSE_LINE_MAX_CHARS = 2000
/** What main lists: paths from git, entries and depth of the walk, paths in the explorer. */
export const WM_LIST_MAX = 50000
export const WM_WALK_MAX_ENTRIES = 5000
export const WM_WALK_MAX_DEPTH = 6
export const WM_TREE_MAX = 500
/** Picked types per project, projects remembered, types offered in a menu. */
export const WM_PICKS_MAX = 8
export const WM_PROJECTS_MAX = 64
export const WM_TYPES_SHOWN = 12
/**
 * Paths of one type ranked per open, at most: past it an even, seeded sample is
 * ranked. Ranking all of a 50,000-file one-language monorepo held main for
 * about 100 ms (measured 2026-10-28, gotcha 40), and only 40 are ever tried.
 */
export const WM_RANK_POOL_MAX = 2000
/** The project's own test files the explorer adds for the chosen files, so the build panel can name real ones. */
export const WM_TREE_TESTS_MAX = 8

/** The key the bundled sample's picks are kept under (a project's is a hash of its folder). */
export const WM_SAMPLE_KEY = 'sample'

/* -------------------------------------------------------------- languages */

export type Grammar = 'js' | 'jsx' | 'clike' | 'python' | 'script' | 'css' | 'html' | 'markdown'

export interface WorkModeLanguage {
  /** What the status bar says. */
  label: string
  grammar: Grammar
  /** A dialect inside the grammar: the keyword set of a `clike` or `script` language, or a style sheet's. */
  lang?: string
}

/**
 * Every extension Work mode may read: source code, markup, style sheets, and
 * Markdown (offered when the project has it, never picked by default,
 * `NEVER_DEFAULT`). Data and config (json, yaml, toml, env, ini) are never
 * read nor offered: they are where secrets most often live, and nobody types
 * them by hand anyway. Whatever is read goes through the same redaction.
 */
export const WORK_MODE_LANGUAGES: Readonly<Record<string, WorkModeLanguage>> = {
  ts: { label: 'TypeScript', grammar: 'js' },
  tsx: { label: 'TypeScript JSX', grammar: 'jsx' },
  mts: { label: 'TypeScript', grammar: 'js' },
  cts: { label: 'TypeScript', grammar: 'js' },
  js: { label: 'JavaScript', grammar: 'js' },
  jsx: { label: 'JavaScript JSX', grammar: 'jsx' },
  mjs: { label: 'JavaScript', grammar: 'js' },
  cjs: { label: 'JavaScript', grammar: 'js' },
  py: { label: 'Python', grammar: 'python' },
  rs: { label: 'Rust', grammar: 'clike', lang: 'rust' },
  go: { label: 'Go', grammar: 'clike', lang: 'go' },
  java: { label: 'Java', grammar: 'clike', lang: 'java' },
  kt: { label: 'Kotlin', grammar: 'clike', lang: 'kotlin' },
  kts: { label: 'Kotlin', grammar: 'clike', lang: 'kotlin' },
  swift: { label: 'Swift', grammar: 'clike', lang: 'swift' },
  c: { label: 'C', grammar: 'clike', lang: 'c' },
  h: { label: 'C', grammar: 'clike', lang: 'c' },
  cc: { label: 'C++', grammar: 'clike', lang: 'cpp' },
  cpp: { label: 'C++', grammar: 'clike', lang: 'cpp' },
  cxx: { label: 'C++', grammar: 'clike', lang: 'cpp' },
  hpp: { label: 'C++', grammar: 'clike', lang: 'cpp' },
  hh: { label: 'C++', grammar: 'clike', lang: 'cpp' },
  cs: { label: 'C#', grammar: 'clike', lang: 'cs' },
  dart: { label: 'Dart', grammar: 'clike', lang: 'dart' },
  scala: { label: 'Scala', grammar: 'clike', lang: 'scala' },
  php: { label: 'PHP', grammar: 'clike', lang: 'php' },
  rb: { label: 'Ruby', grammar: 'script', lang: 'ruby' },
  lua: { label: 'Lua', grammar: 'script', lang: 'lua' },
  sh: { label: 'Shell Script', grammar: 'script', lang: 'sh' },
  bash: { label: 'Shell Script', grammar: 'script', lang: 'sh' },
  zsh: { label: 'Shell Script', grammar: 'script', lang: 'sh' },
  ex: { label: 'Elixir', grammar: 'script', lang: 'elixir' },
  exs: { label: 'Elixir', grammar: 'script', lang: 'elixir' },
  sql: { label: 'SQL', grammar: 'script', lang: 'sql' },
  css: { label: 'CSS', grammar: 'css', lang: 'css' },
  scss: { label: 'SCSS', grammar: 'css', lang: 'scss' },
  sass: { label: 'Sass', grammar: 'css', lang: 'sass' },
  less: { label: 'Less', grammar: 'css', lang: 'less' },
  styl: { label: 'Stylus', grammar: 'css', lang: 'styl' },
  html: { label: 'HTML', grammar: 'html' },
  htm: { label: 'HTML', grammar: 'html' },
  vue: { label: 'Vue', grammar: 'html' },
  svelte: { label: 'Svelte', grammar: 'html' },
  md: { label: 'Markdown', grammar: 'markdown' }
}

/** Types offered but never picked by default: prose is where a note to self lives, so the owner opts in. */
export const NEVER_DEFAULT: ReadonlySet<string> = new Set(['md'])

/** The longest line a file of this type may have before it is taken for minified (`WM_LINE_MAX_CHARS`). */
export function lineCapOf(ext: string): number {
  return ext === 'md' ? WM_PROSE_LINE_MAX_CHARS : WM_LINE_MAX_CHARS
}

export function isWorkModeExt(ext: unknown): ext is string {
  return typeof ext === 'string' && Object.hasOwn(WORK_MODE_LANGUAGES, ext)
}

/** The status bar's language for an extension. */
export function languageOf(ext: string): string {
  return isWorkModeExt(ext) ? WORK_MODE_LANGUAGES[ext].label : 'Plain Text'
}

/** `git ls-files` pathspecs for every readable extension, so a monorepo answers only code. */
export const CODE_PATHSPECS: readonly string[] = Object.keys(WORK_MODE_LANGUAGES).map((ext) => `*.${ext}`)

/* -------------------------------------------------------------- wire types */

export type Toolchain = 'vite' | 'next' | 'node' | 'cargo' | 'go' | 'python' | 'ruby' | 'gradle' | 'make'

export interface WorkModeOptions {
  charsPerKey: number
  /** The bottom panel that prints a build line now and then. */
  panel: boolean
}

export const WM_OPTIONS_DEFAULT: WorkModeOptions = { charsPerKey: WM_CHARS_DEFAULT, panel: true }

/** One file as the renderer gets it: a path relative to the project, never absolute, and text already redacted. */
export interface WorkModeFile {
  path: string
  ext: string
  text: string
  eol: 'LF' | 'CRLF'
}

export interface WorkModeType {
  ext: string
  count: number
}

export type WorkModeReason = 'no-folder' | 'refused' | 'unreadable' | 'slow' | 'empty' | 'disabled'

export interface WorkModeProject {
  name: string
  branch: string | null
  toolchain: Toolchain
}

export interface WorkModeScan {
  project: WorkModeProject | null
  reason: WorkModeReason | null
  types: WorkModeType[]
  picks: string[]
  options: WorkModeOptions
}

export interface WorkModeSource extends WorkModeScan {
  files: WorkModeFile[]
  /** Up to `WM_TREE_MAX` relative paths, directories ending in `/`. */
  tree: string[]
}

/** Why the Settings panel shows the sample website instead (the IDE itself never says). */
export function reasonText(reason: WorkModeReason | null): string {
  switch (reason) {
    case 'no-folder':
      return 'The tab in front has no folder on this computer, so Work mode types'
    case 'refused':
      return 'Work mode never reads your home folder, a folder above it, or Stoke’s own, so it types'
    case 'unreadable':
      return 'That folder could not be read, so Work mode types'
    case 'slow':
      return 'That folder took too long to list, so Work mode types'
    case 'empty':
      return 'Nothing of the picked file types could be read there, so Work mode types'
    case 'disabled':
      return 'Work mode is turned off, so it would type'
    default:
      return 'Work mode types'
  }
}

/* ------------------------------------------------------- what may be read */

export type WorkModePathClass = 'skip' | 'name' | 'read'

/** Directories never listed, read or shown: dependencies, build and vendor output, caches. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'third_party', 'dist', 'build', 'out', 'target',
  'coverage', '.next', '.nuxt', '.svelte-kit', '.output', '.turbo', '.cache', '.parcel-cache', '__pycache__',
  '.venv', 'venv', '.tox', 'site-packages', 'pods', 'deriveddata', '.gradle', 'storybook-static', 'release',
  'tmp', 'temp', 'logs'
])

const LOCKFILES: ReadonlySet<string> = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lock', 'bun.lockb', 'cargo.lock',
  'poetry.lock', 'pipfile.lock', 'gemfile.lock', 'composer.lock', 'go.sum', 'mix.lock', 'podfile.lock', 'flake.lock'
])

/** Files whose NAME says they hold a credential. */
const SECRET_NAMES: ReadonlySet<string> = new Set([
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd', '.pgpass', 'known_hosts', 'authorized_keys'
])

/** Extensions that hold keys, certificates, vaults or infrastructure state. */
const SECRET_EXTS: ReadonlySet<string> = new Set([
  'pem', 'key', 'p12', 'pfx', 'crt', 'cer', 'der', 'jks', 'keystore', 'kdbx', 'gpg', 'asc', 'ovpn', 'p8', 'tfvars', 'tfstate'
])

/**
 * A segment (without its extension) that names a credential. Errs towards
 * skipping: `password-strength.ts` is skipped, and `passwordReset.tsx` is not
 * (no separator after the word), which is the price of reading by name.
 */
export const SECRET_SEGMENT =
  /(^|[._-])(secrets?|credentials?|passwords?|passwd|api[_-]?keys?|private[_-]?keys?|service[_-]?account)([._-]|$)/i

/**
 * Shown in the explorer only, never opened. Everything else that is not a
 * readable type is never shown at all. (A README.md is Markdown, so it is read
 * like any other `.md`, and only once the owner picks Markdown.)
 */
const NAME_ONLY: ReadonlySet<string> = new Set([
  'license', 'package.json', 'tsconfig.json', 'makefile', 'cargo.toml', 'go.mod', 'pyproject.toml',
  'requirements.txt', 'gemfile', 'pom.xml', 'build.gradle'
])

/** Generated files: minified, maps, bundles, snapshots. */
const GENERATED = /\.min\.(?:js|css)$|\.map$|\.bundle\.js$|\.chunk\.js$|\.snap$|\.generated\./

/** The lower-case extension of a path's last segment, '' when it has none (a dotfile has none). */
export function extOf(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/** A segment with its last extension cut, for the secret-name test. */
function stem(segment: string): string {
  const dot = segment.lastIndexOf('.')
  return dot > 0 ? segment.slice(0, dot) : segment
}

/**
 * Whether a path relative to the project may be read, only shown, or must be
 * skipped. Judged lower-case, `/`-separated, every segment. A secret-shaped
 * name anywhere in the path skips it; so does any directory that is a
 * dependency, build output, a cache, or hidden.
 */
export function workModePathClass(relPath: string): WorkModePathClass {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean)
  if (parts.length === 0) return 'skip'
  const lower = parts.map((p) => p.toLowerCase())
  const dirs = lower.slice(0, -1)
  const base = lower[lower.length - 1]
  if (lower.some((p) => p === '.' || p === '..')) return 'skip'
  if (dirs.some((d) => SKIP_DIRS.has(d) || d.startsWith('.'))) return 'skip'
  if (LOCKFILES.has(base) || base.endsWith('.lock')) return 'skip'
  if (GENERATED.test(base)) return 'skip'
  if (base.startsWith('.env') || SECRET_NAMES.has(base) || base.startsWith('id_')) return 'skip'
  const ext = extOf(base)
  if (SECRET_EXTS.has(ext)) return 'skip'
  if (lower.some((p) => SECRET_SEGMENT.test(stem(p)) || SECRET_SEGMENT.test(p))) return 'skip'
  if (isWorkModeExt(ext) && !base.startsWith('.')) return 'read'
  if (NAME_ONLY.has(base)) return 'name'
  return 'skip'
}

/** A directory the walk and the tree pass over: a skipped name, or hidden. */
export function skippedDir(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('.') || SKIP_DIRS.has(lower) || SECRET_SEGMENT.test(lower)
}

/* -------------------------------------------------------- types and picks */

/** Most files first; a tie goes alphabetically, so it is the same every time. */
const byCount = (a: WorkModeType, b: WorkModeType): number => b.count - a.count || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0)

/** How many readable files of each type, most first (`byCount`). */
export function countTypes(readPaths: readonly string[]): WorkModeType[] {
  const counts = new Map<string, number>()
  for (const p of readPaths) {
    const ext = extOf(p)
    if (isWorkModeExt(ext)) counts.set(ext, (counts.get(ext) ?? 0) + 1)
  }
  return [...counts].map(([ext, count]) => ({ ext, count })).sort(byCount)
}

/**
 * The types typed by default: the two most used, and a third when it has at
 * least half the second's files (`ts 300, tsx 120, mjs 50` is two; `js 10,
 * css 6, html 4` is three). Markdown is never one of them (`NEVER_DEFAULT`),
 * however many files it has.
 */
export function defaultPicks(types: readonly WorkModeType[]): string[] {
  const ranked = [...types].filter((t) => t.count > 0 && isWorkModeExt(t.ext) && !NEVER_DEFAULT.has(t.ext)).sort(byCount)
  const out = ranked.slice(0, 2).map((t) => t.ext)
  if (ranked.length >= 3 && ranked[2].count * 2 >= ranked[1].count) out.push(ranked[2].ext)
  return out
}

/**
 * Picks the project has, most-used first (`countTypes`' order: count, then
 * name), whatever order they were ticked in. The left editor types the first
 * (`windowQueues`), so the most-used picked type is always the left one, the
 * next the right (prove Finding 2: unticking TS and ticking it again put .tsx,
 * 2 files, on the left and .ts, 7, on the right, and kept it across a restart).
 */
export function orderPicks(picks: readonly string[], types: readonly WorkModeType[]): string[] {
  const rank = new Map([...types].filter((t) => t.count > 0).sort(byCount).map((t, i) => [t.ext, i] as const))
  return [...new Set(picks)].filter((ext) => rank.has(ext)).sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0))
}

/** Remembered picks that still exist in this project, most-used first (`orderPicks`); the defaults when none do. */
export function rememberedPicks(remembered: readonly string[] | null | undefined, types: readonly WorkModeType[]): string[] {
  const kept = orderPicks(remembered ?? [], types)
  return kept.length ? kept.slice(0, WM_PICKS_MAX) : defaultPicks(types)
}

/** A pick list from the renderer: a non-empty array of unique known extensions, at most `WM_PICKS_MAX`. Null when it is not. */
export function validPicks(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > WM_PICKS_MAX) return null
  if (!raw.every(isWorkModeExt)) return null
  if (new Set(raw).size !== raw.length) return null
  return [...raw]
}

/* ------------------------------------------------------- the folder itself */

export type WorkModeFolderVerdict = 'ok' | 'shallow' | 'home' | 'stoke'

export interface FolderVerdictRules {
  home: string
  userData: string
  privateRoots: readonly string[]
  /** `/` or `\`, and whether paths compare case-folded (`pathRulesFor`). */
  rules: { sep: '/' | '\\'; caseInsensitive: boolean }
}

/** Path segments, a Windows drive not counted: `/` and `C:\` are 0, `/Users` is 1. The same rule as `folderDepth` (shared/remotePhone.ts). */
export function pathDepth(p: string): number {
  const segs = p.split(/[\\/]+/).filter(Boolean)
  return /^[A-Za-z]:$/.test(segs[0] ?? '') ? segs.length - 1 : segs.length
}

function keyOf(p: string, rules: FolderVerdictRules['rules']): string {
  const trimmed = p.trim()
  const native = rules.sep === '\\' ? trimmed.replace(/\//g, '\\') : trimmed.replace(/\\/g, '/')
  const n = native.replace(/[\\/]+$/, '') || native
  return rules.caseInsensitive ? n.toLowerCase() : n
}

function inside(parent: string, child: string, rules: FolderVerdictRules['rules']): boolean {
  const a = keyOf(parent, rules)
  const b = keyOf(child, rules)
  if (!a || !b) return false
  if (a === b) return true
  return b.startsWith(a.endsWith(rules.sep) ? a : a + rules.sep)
}

/**
 * Whether Work mode may read a (realpath'd) folder. Never the root, a
 * top-level folder, the home folder or anything above it (a home is full of
 * everything), and never Stoke's own data or a private chat's scratch folder
 * (gotchas 148 and 150).
 */
export function workModeFolderVerdict(real: string, v: FolderVerdictRules): WorkModeFolderVerdict {
  if (pathDepth(real) < 2) return 'shallow'
  if (v.home && inside(real, v.home, v.rules)) return 'home'
  if ((v.userData && inside(v.userData, real, v.rules)) || v.privateRoots.some((r) => !!r && inside(r, real, v.rules))) return 'stoke'
  return 'ok'
}

/* ------------------------------------------------------ choosing the files */

/**
 * FNV-1a over the parts (joined by a separator no path holds), then murmur3's
 * finaliser. Without the finaliser FNV's low bit alternates between line 9
 * and line 10's keys, so `hash % 6` almost never picked two neighbouring
 * lines and the holes' run cap was never reached (found by a mutant that
 * removed the cap and stayed green).
 */
export function hash32(...parts: Array<string | number>): number {
  let h = 0x811c9dc5
  const s = parts.join('\u0001')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/** A small seeded generator (mulberry32), for the panel and the suite. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SOURCE_TOPS: ReadonlySet<string> = new Set([
  'src', 'lib', 'app', 'components', 'pages', 'server', 'client', 'packages', 'internal', 'cmd', 'pkg', 'core', 'ui', 'web', 'api'
])
const TEST_SEGMENTS: ReadonlySet<string> = new Set(['__tests__', 'test', 'tests', 'spec', 'specs', 'fixtures', 'mocks', '__mocks__', 'e2e', 'example', 'examples', 'docs'])

/** How good a file is to type: real source first, tests, typings and barrels last. */
export function candidateScore(path: string, seed: number): number {
  const parts = path.toLowerCase().split('/')
  const base = parts[parts.length - 1]
  let score = 0
  if (parts.length > 1 && SOURCE_TOPS.has(parts[0])) score += 3
  if (parts.slice(0, -1).some((p) => TEST_SEGMENTS.has(p)) || /\.(?:test|spec|stories)\./.test(base)) score -= 4
  if (base.endsWith('.d.ts')) score -= 3
  if (/^index\./.test(base)) score -= 2
  if (parts.length > 4) score -= parts.length - 4
  return score + (hash32(seed, path) % 1000) / 1000
}

/** Prefer files from the same feature, then nearby directories and matching names. */
export function relatedFileScore(anchor: string, candidate: string): number {
  const a = anchor.toLowerCase().split('/'), b = candidate.toLowerCase().split('/')
  const an = a.pop() ?? '', bn = b.pop() ?? ''
  let common = 0
  while (common < a.length && common < b.length && a[common] === b[common]) common++
  const words = (name: string): string[] => name.replace(/\.[^.]+$/, '').split(/[._-]+/).filter(w => w.length >= 3 && !['index', 'test', 'spec', 'style', 'styles'].includes(w))
  const aw = words(an), bw = words(bn)
  const names = aw.filter(w => bw.includes(w)).length + (aw.length && bw.length && aw.join('') === bw.join('') ? 1 : 0)
  const sameDir = a.length > 0 && a.length === b.length && common === a.length
  return (sameDir ? 40 : 0) + common * 8 - Math.abs(a.length - b.length) + names * 24
}

/**
 * For each pick, its readable paths best first. Deterministic per seed; never a
 * path that is not `read`. A type with more than `cap` paths is ranked from an
 * even, seeded sample of `cap` of them (`WM_RANK_POOL_MAX`).
 */
export function chooseCandidates(readPaths: readonly string[], picks: readonly string[], seed: number, cap = WM_RANK_POOL_MAX): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const ext of picks) out.set(ext, [])
  for (const p of readPaths) out.get(extOf(p))?.push(p)
  for (const [ext, all] of out) {
    const step = Math.ceil(all.length / Math.max(1, cap))
    const pool = step > 1 ? all.filter((_, i) => i % step === Math.abs(seed) % step) : all
    const list = pool.filter((p) => workModePathClass(p) === 'read')
    const scored = list.map((p) => ({ p, s: candidateScore(p, seed) }))
    scored.sort((a, b) => b.s - a.s || (a.p < b.p ? -1 : a.p > b.p ? 1 : 0))
    out.set(ext, scored.map((x) => x.p))
  }
  return out
}

/* --------------------------------------------------------------- toolchain */

/** What the project builds with, from its top-level names, for the build panel's wording. */
export function toolchain(topLevelNames: readonly string[]): Toolchain {
  const names = new Set(topLevelNames.map((n) => n.replace(/\/$/, '').toLowerCase()))
  const has = (re: RegExp): boolean => [...names].some((n) => re.test(n))
  if (names.has('package.json')) {
    if (has(/^vite\.config\./)) return 'vite'
    if (has(/^next\.config\./)) return 'next'
    return 'node'
  }
  if (names.has('cargo.toml')) return 'cargo'
  if (names.has('go.mod')) return 'go'
  if (names.has('pyproject.toml') || names.has('requirements.txt') || names.has('setup.py')) return 'python'
  if (names.has('gemfile')) return 'ruby'
  if (names.has('pom.xml') || has(/^build\.gradle/)) return 'gradle'
  return 'make'
}

/* ---------------------------------------------------------------- explorer */

export interface ExplorerNode {
  name: string
  /** Relative path; a directory's has no trailing `/`. */
  path: string
  dir: boolean
  children: ExplorerNode[]
}

const byName = (a: ExplorerNode, b: ExplorerNode): number =>
  a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || (a.name < b.name ? -1 : 1)

/** The nested, folders-first explorer from a flat list (`dir/` for a directory), at most `cap` paths. */
export function explorerNodes(tree: readonly string[], cap = WM_TREE_MAX): ExplorerNode[] {
  const root: ExplorerNode = { name: '', path: '', dir: true, children: [] }
  const dirs = new Map<string, ExplorerNode>([['', root]])
  const ensureDir = (path: string): ExplorerNode => {
    const hit = dirs.get(path)
    if (hit) return hit
    const cut = path.lastIndexOf('/')
    const parent = ensureDir(cut < 0 ? '' : path.slice(0, cut))
    const node: ExplorerNode = { name: path.slice(cut + 1), path, dir: true, children: [] }
    parent.children.push(node)
    dirs.set(path, node)
    return node
  }
  const seen = new Set<string>()
  for (const raw of tree.slice(0, cap)) {
    const isDir = raw.endsWith('/')
    const path = raw.replace(/\/+$/, '')
    if (!path || seen.has(raw)) continue
    seen.add(raw)
    if (isDir) {
      ensureDir(path)
      continue
    }
    const cut = path.lastIndexOf('/')
    const parent = ensureDir(cut < 0 ? '' : path.slice(0, cut))
    if (!parent.children.some((c) => !c.dir && c.path === path)) parent.children.push({ name: path.slice(cut + 1), path, dir: false, children: [] })
  }
  const sort = (n: ExplorerNode): void => {
    n.children.sort(byName)
    for (const c of n.children) if (c.dir) sort(c)
  }
  sort(root)
  return root.children
}

/* ------------------------------------------------------- the two editors */

/**
 * Which files each editor types, as indexes into `files`. The left types the
 * first pick's files in order; the right the other picks', round-robin. One
 * pick (or nothing for the right): the files alternate. A first pick with no
 * files gives way to the next. A single file goes to both.
 */
export function windowQueues(files: readonly WorkModeFile[], picks: readonly string[]): { left: number[]; right: number[] } {
  if (files.length === 0) return { left: [], right: [] }
  if (files.length === 1) return { left: [0], right: [0] }
  const byExt = new Map<string, number[]>()
  files.forEach((f, i) => {
    const list = byExt.get(f.ext) ?? []
    list.push(i)
    byExt.set(f.ext, list)
  })
  const order = picks.filter((ext) => (byExt.get(ext)?.length ?? 0) > 0)
  for (const ext of byExt.keys()) if (!order.includes(ext)) order.push(ext)
  const left = [...(byExt.get(order[0]) ?? [])]
  const rest = order.slice(1).map((ext) => [...(byExt.get(ext) ?? [])])
  const right: number[] = []
  for (let round = 0; rest.some((l) => round < l.length); round++) for (const l of rest) if (round < l.length) right.push(l[round])
  if (right.length === 0) {
    const all = left
    return { left: all.filter((_, i) => i % 2 === 0), right: all.filter((_, i) => i % 2 === 1) }
  }
  // The second editor starts on the closest companion to the first; keep the
  // original order for equally related files and keep every file in its queue.
  if (left.length) right.sort((a, b) => relatedFileScore(files[left[0]].path, files[b].path) - relatedFileScore(files[left[0]].path, files[a].path))
  return { left, right }
}

/* ----------------------------------------------------------------- keys */

export type WorkModeKeyKind = 'pass' | 'exit' | 'ignore' | 'save' | 'type'

export interface WorkModeKeyEvent {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  isComposing?: boolean
  repeat?: boolean
}

const LONE_MODIFIERS: ReadonlySet<string> = new Set(['Shift', 'Control', 'Alt', 'AltGraph', 'Meta', 'CapsLock', 'Fn', 'FnLock', 'OS', 'Hyper', 'Super', 'NumLock', 'ScrollLock', 'Symbol', 'SymbolLock'])

export function isLoneModifier(key: string): boolean {
  return LONE_MODIFIERS.has(key)
}

/** The letter a chord names, by key or (with Option, which changes the key on a Mac) by its physical key. */
function letter(e: WorkModeKeyEvent): string {
  if (/^Key[A-Z]$/.test(e.code ?? '')) return (e.code as string).slice(3).toLowerCase()
  return e.key.length === 1 ? e.key.toLowerCase() : ''
}

/**
 * What a key does in Work mode. A few OS chords pass through untouched (no
 * `preventDefault`, so the default menu and the OS still act on them): on a
 * Mac Quit, Hide, Hide Others, Minimise, cycling windows and full screen;
 * elsewhere Alt+F4 and F11. Escape counts towards leaving and never types.
 * Cmd/Ctrl+S saves. Lone modifiers, dead keys and an IME's keys do nothing.
 * Everything else types — Cmd+W, Cmd+T, Cmd+K, Cmd+R and the zoom chords too.
 */
export function workModeKey(e: WorkModeKeyEvent, isMac: boolean): WorkModeKeyKind {
  if (e.isComposing || e.key === 'Dead' || e.key === 'Process' || e.key === 'Unidentified' || e.key === '') return 'ignore'
  if (isLoneModifier(e.key)) return 'ignore'
  if (e.key === 'Escape') return 'exit'
  const l = letter(e)
  if (isMac) {
    if (e.metaKey && !e.ctrlKey && !e.altKey && (l === 'q' || l === 'm')) return 'pass'
    if (e.metaKey && !e.ctrlKey && l === 'h') return 'pass'
    if (e.metaKey && !e.ctrlKey && (e.code === 'Backquote' || e.key === '`' || e.key === '~')) return 'pass'
    if (e.metaKey && e.ctrlKey && !e.altKey && l === 'f') return 'pass'
  } else {
    if (e.altKey && e.key === 'F4') return 'pass'
    if (e.key === 'F11') return 'pass'
  }
  if ((isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) && !e.altKey && l === 's') return 'save'
  return 'type'
}

/** The keys the in-mode menu's own controls use: moving focus, pressing a button, ticking a box. */
const MENU_NATIVE_KEYS: ReadonlySet<string> = new Set(['Tab', ' ', 'Enter', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/**
 * A key on the in-mode menu (its Escape is handled before this): left to the
 * menu's controls only if they use it, an OS chord passes as everywhere else,
 * and anything else is BLOCKED (`preventDefault`). Main takes no tab or window
 * chord while Work mode is up (`switchWindow`), so a chord the page leaves
 * alone goes on to the default application menu: Cmd/Ctrl+W there is Close
 * Window, whose `closed` handler ends every session, and Cmd/Ctrl+R reloads.
 */
export function workModeMenuKey(e: WorkModeKeyEvent, isMac: boolean): 'native' | 'pass' | 'block' {
  if (!e.metaKey && !e.ctrlKey && !e.altKey && MENU_NATIVE_KEYS.has(e.key)) return 'native'
  return workModeKey(e, isMac) === 'pass' ? 'pass' : 'block'
}

export interface ExitState {
  firstAt: number | null
}

export const EXIT_START: ExitState = { firstAt: null }

/**
 * The leave chord: two fresh Escapes no more than `windowMs` apart, with no
 * other key between them. A held Escape's repeats and a lone modifier change
 * nothing; any other key starts over. A single Escape in a burst of typing
 * therefore never leaves.
 */
export function exitStep(
  state: ExitState,
  ev: { key: string; repeat: boolean; at: number; kind: WorkModeKeyKind },
  windowMs = WM_EXIT_WINDOW_MS
): { state: ExitState; leave: boolean; armed: boolean } {
  if (ev.key === 'Escape') {
    if (ev.repeat) return { state, leave: false, armed: false }
    if (state.firstAt !== null && ev.at - state.firstAt <= windowMs && ev.at >= state.firstAt) return { state: EXIT_START, leave: true, armed: false }
    return { state: { firstAt: ev.at }, leave: false, armed: true }
  }
  if (isLoneModifier(ev.key)) return { state, leave: false, armed: false }
  return { state: EXIT_START, leave: false, armed: false }
}

/** Whether the keyboard has been quiet long enough since the last key for the leave to finish. */
export function tailDone(lastKeyAt: number, now: number): boolean {
  return now - lastKeyAt >= WM_TAIL_QUIET_MS
}

/* --------------------------------------------------------------- pointer */

export interface PointerState {
  x: number | null
  y: number | null
  at: number
  carry: number
  lastFill: number
}

export const POINTER_START: PointerState = { x: null, y: null, at: 0, carry: 0, lastFill: -Infinity }

/**
 * How much pointer travel has earned a line. A hop past `WM_JUMP_PX` (the
 * pointer re-entering) earns nothing and drops the carry; an idle past
 * `WM_IDLE_MS` drops it too. A line is due once the carry reaches
 * `WM_PX_PER_LINE` and `WM_FILL_GAP_MS` has passed since the last, so a fast
 * sweep still adds about four and a half lines a second at most.
 */
export function pointerBudget(state: PointerState, p: { x: number; y: number; at: number }): { state: PointerState; fill: boolean } {
  if (state.x === null || state.y === null) return { state: { ...state, x: p.x, y: p.y, at: p.at, carry: 0 }, fill: false }
  const dist = Math.hypot(p.x - state.x, p.y - state.y)
  if (dist > WM_JUMP_PX) return { state: { ...state, x: p.x, y: p.y, at: p.at, carry: 0 }, fill: false }
  let carry = p.at - state.at > WM_IDLE_MS ? 0 : state.carry
  carry = Math.min(carry + dist, 2 * WM_PX_PER_LINE)
  if (carry >= WM_PX_PER_LINE && p.at - state.lastFill >= WM_FILL_GAP_MS) {
    return { state: { x: p.x, y: p.y, at: p.at, carry: carry - WM_PX_PER_LINE, lastFill: p.at }, fill: true }
  }
  return { state: { ...state, x: p.x, y: p.y, at: p.at, carry }, fill: false }
}

/* ------------------------------------------------------------ the store */

export interface WorkModeState {
  schema: 1
  revision: number
  options: WorkModeOptions
  picks: Record<string, { types: string[]; at: number }>
}

export function emptyWorkModeState(): WorkModeState {
  return { schema: 1, revision: 0, options: { ...WM_OPTIONS_DEFAULT }, picks: {} }
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Options as stored: characters per key an integer from 1 to 12, the panel a boolean; anything else its default. */
export function clampOptions(raw: unknown): WorkModeOptions {
  const r = record(raw) ? raw : {}
  const n = typeof r.charsPerKey === 'number' && Number.isInteger(r.charsPerKey) ? r.charsPerKey : WM_CHARS_DEFAULT
  return { charsPerKey: Math.min(WM_CHARS_MAX, Math.max(WM_CHARS_MIN, n)), panel: typeof r.panel === 'boolean' ? r.panel : WM_OPTIONS_DEFAULT.panel }
}

/** A picks key: a 32-hex hash of a folder, or the sample's. */
export function isPicksKey(k: string): boolean {
  return k === WM_SAMPLE_KEY || /^[0-9a-f]{32}$/.test(k)
}

/**
 * The plugin's file, leniently: bad entries dropped, unknown types dropped,
 * every list capped, the oldest projects past `WM_PROJECTS_MAX` dropped. It
 * never throws on a JSON object — picks are not precious, and a broken file
 * must never stop Work mode from opening.
 */
export function parseWorkModeState(raw: unknown): WorkModeState {
  const out = emptyWorkModeState()
  if (!record(raw)) return out
  if (typeof raw.revision === 'number' && Number.isSafeInteger(raw.revision) && raw.revision >= 0) out.revision = raw.revision
  out.options = clampOptions(raw.options)
  const picks: Array<[string, { types: string[]; at: number }]> = []
  if (record(raw.picks)) {
    for (const [k, v] of Object.entries(raw.picks)) {
      if (!isPicksKey(k) || !record(v) || !Array.isArray(v.types)) continue
      const types = [...new Set(v.types.filter(isWorkModeExt))].slice(0, WM_PICKS_MAX)
      if (!types.length) continue
      const at = typeof v.at === 'number' && Number.isFinite(v.at) ? v.at : 0
      picks.push([k, { types, at }])
    }
  }
  picks.sort((a, b) => b[1].at - a[1].at)
  for (const [k, v] of picks.slice(0, WM_PROJECTS_MAX)) out.picks[k] = v
  return out
}

/* ----------------------------------------------------- the panel's tests */

/** The name of a path's last segment without its extension, lower-case: `retry` for `src/Retry.ts`. */
export function sourceStem(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  return (dot > 0 ? base.slice(0, dot) : base).toLowerCase()
}

/** The runner family a type's tests belong to: vitest for the JS family, pytest, `go test`, RSpec; null for none here. */
function testFamily(ext: string): 'js' | 'py' | 'go' | 'rb' | null {
  if (['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'js'
  if (ext === 'py' || ext === 'go' || ext === 'rb') return ext
  return null
}

/**
 * Whether a path is a test file, by the conventions of the runners the panel
 * plays: `*.test.*` and `*.spec.*` (vitest, jest), a JS file in `__tests__/`,
 * Python's `test_*.py` and `*_test.py`, Go's `*_test.go`, RSpec's `*_spec.rb`.
 */
export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase()
  const base = lower.slice(lower.lastIndexOf('/') + 1)
  if (base.endsWith('.d.ts')) return false
  if (/\.(?:test|spec)\.[a-z0-9]+$/.test(base)) return true
  if (/(?:^|\/)__tests__\//.test(lower) && /\.[cm]?[jt]sx?$/.test(base)) return true
  return /^test_.+\.py$|_test\.(?:py|go)$|_spec\.rb$/.test(base)
}

/** The name a test is for: `retry` for `src/retry.test.ts`, `tests/test_retry.py`, `retry_test.go` or `spec/retry_spec.rb`. */
export function testStem(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  return base.replace(/\.(?:test|spec)(?=\.[^.]+$)/, '').replace(/\.[^.]+$/, '').replace(/^test_/, '').replace(/_(?:test|spec)$/, '')
}

/**
 * The test file the panel names for a source: the project's own test of it
 * when the explorer lists one (`tests`: the same name and runner, the nearest
 * folder first), else the one its runner would look for (`retry.test.ts`
 * beside `retry.ts`, `tests/test_retry.py`, `retry_test.go` beside, RSpec's
 * `spec/` mirror). A test is its own; null for what no runner tests (style
 * sheets, markup, typings, Markdown). Prove Finding 4: the panel printed
 * `✓ src/retry.ts (15 tests)`, a source file as a test file.
 */
export function testFileFor(source: string, tests: readonly string[]): string | null {
  const ext = extOf(source)
  const family = testFamily(ext)
  if (!family || source.toLowerCase().endsWith('.d.ts')) return null
  if (isTestPath(source)) return source
  const cut = source.lastIndexOf('/')
  const dir = cut < 0 ? '' : source.slice(0, cut)
  const stem = sourceStem(source)
  const own = tests.filter((t) => isTestPath(t) && testFamily(extOf(t)) === family && testStem(t) === stem)
  if (own.length) {
    const near = (t: string): number => {
      const td = t.slice(0, t.lastIndexOf('/') + 1)
      const sd = dir ? dir + '/' : ''
      let i = 0
      while (i < td.length && i < sd.length && td[i] === sd[i]) i++
      return i
    }
    return [...own].sort((a, b) => near(b) - near(a) || (a < b ? -1 : a > b ? 1 : 0))[0]
  }
  const name = source.slice(cut + 1, source.lastIndexOf('.'))
  const at = dir ? dir + '/' : ''
  if (family === 'js') return `${at}${name}.test.${ext === 'tsx' || ext === 'jsx' ? ext : ext.endsWith('ts') ? 'ts' : 'js'}`
  if (family === 'py') return `tests/test_${name}.py`
  if (family === 'go') return `${at}${name}_test.go`
  const mirror = dir.replace(/^(?:lib|app)(?:\/|$)/, '')
  return `spec/${mirror ? mirror + '/' : ''}${name}_spec.rb`
}

/** How many tests a test file holds: its own number, the same on every run (3 to 23). */
export function testCount(path: string): number {
  return 3 + (hash32('wm-tests', path) % 21)
}

/* ------------------------------------------------------------- the panel */

const PANEL_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g

/** A relative path safe to print: no control, at most 80 characters; an absolute one (never sent, but) is cut to its name. */
function shownPath(p: string): string {
  let clean = p.replace(PANEL_CONTROLS, '')
  if (/^(?:[\\/]|[A-Za-z]:)/.test(clean)) clean = clean.replace(/^.*[\\/]/, '')
  return clean.length > 80 ? '…' + clean.slice(-79) : clean
}

const pad2 = (v: number): string => String(v).padStart(2, '0')

/** A wall-clock time as Vite and tsc print it (`toLocaleTimeString` in en-US): `9:41:03 PM`. */
export function clock12(ms: number): string {
  const d = new Date(ms)
  const h = d.getHours()
  return `${h % 12 || 12}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())} ${h < 12 ? 'AM' : 'PM'}`
}

/** As vitest's "Start at" and Guard print it: `21:41:03`. */
export function clock24(ms: number): string {
  const d = new Date(ms)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

/**
 * The time a burst is stamped with: the wall clock, never before the last
 * burst's, so the panel's times only go forward, even when the clock is set
 * back. Prove Finding 4: every line drew a random hour from 08:00 to 18:59, out
 * of order (09:05:29, 18:26:32, 17:09:17) and hours from the real time.
 */
export function panelTime(last: number, now: number): number {
  if (!Number.isFinite(now)) return Number.isFinite(last) ? last : 0
  return Number.isFinite(last) && last > now ? last : now
}

/** What a burst is about: the toolchain, the project's NAME (never its path), and the files it may name. */
export interface PanelSource {
  tool: Toolchain
  /** A folder's last segment: npm's echo of the script and a Go module's name. */
  name: string
  /** Relative paths of the files the editors type. */
  files: readonly string[]
  /** Relative paths of the project's own test files, as the explorer lists them (`isTestPath`). */
  tests: readonly string[]
}

export type PanelKind = 'start' | 'tick' | 'save'

/**
 * A burst's output. `dev` goes on the end of the first terminal (the dev server
 * or the watcher). `test` is the whole screen of the second, `npm test`
 * (vitest in watch mode clears it for each run), or null to leave it as it is:
 * test output never lands in the dev server's terminal.
 */
export interface PanelOut {
  dev: string[]
  test: string[] | null
}

/** Lines a burst may print, at most: the dev terminal's, and the test terminal's screen. */
export const WM_PANEL_DEV_MAX = 14
export const WM_PANEL_TEST_MAX = 24
/** Test files one run lists. */
const PANEL_RUN_FILES = 5

/** Whether the toolchain's panel splits off a test terminal: a JS project's dev server and its vitest are two commands. */
export function hasTestTerminal(tool: Toolchain): boolean {
  return tool === 'vite' || tool === 'next' || tool === 'node'
}

/** npm's package name for a folder name: lower-case, nothing npm refuses. */
function npmName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9._~-]+/g, '-')
      .replace(/^[-._~]+|[-._~]+$/g, '')
      .slice(0, 60) || 'app'
  )
}

/** The route Next.js names for a page file (`app/blog/page.tsx` is `/blog`, `pages/about.tsx` is `/about`), or null. */
function nextRoute(path: string): string | null {
  const p = path.replace(/^src\//, '')
  const app = /^app\/(?:(.*)\/)?page\.[jt]sx?$/.exec(p)
  if (app) return '/' + (app[1] ?? '').split('/').filter((s) => s && !/^\(.*\)$/.test(s)).join('/')
  const pages = /^pages\/(.+)\.[jt]sx?$/.exec(p)
  if (pages && !/(?:^|\/)_|^api\//.test(pages[1])) return '/' + pages[1].replace(/(?:^|\/)index$/, '')
  return null
}

/**
 * A few lines for the bottom panel, the way the project's own tools print
 * them. They name only the project's name and the relative paths of loaded
 * files, the project's own tests and tests named after those files, never the
 * folder's path or a user name. Every time is the wall clock `at` (`clock12`,
 * `clock24`), test counts belong to each test file (`testCount`) and add up,
 * and every run passes. Each line is at most 160 characters with no control
 * character; `dev` holds at most `WM_PANEL_DEV_MAX` lines, `test` at most
 * `WM_PANEL_TEST_MAX`. `changed` is the file a save or a tick is about.
 */
export function panelBurst(src: PanelSource, rng: () => number, kind: PanelKind, at: number, changed: string | null = null): PanelOut {
  const paths = src.files.map(shownPath).filter(Boolean)
  const tests = src.tests.map(shownPath).filter((p) => p && isTestPath(p))
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rng() * xs.length) % xs.length]
  const ms = (lo: number, hi: number): number => Math.round(lo + rng() * (hi - lo))
  const n = (lo: number, hi: number): number => Math.floor(lo + rng() * (hi - lo + 1))
  const secs = (lo: number, hi: number): string => (ms(lo * 100, hi * 100) / 100).toFixed(2)
  const pkg = npmName(src.name)
  const t12 = clock12(at)
  const t24 = clock24(at)
  const file = changed ? shownPath(changed) : paths.length ? pick(paths) : ''
  const testOf = (p: string): string | null => (p ? testFileFor(p, tests) : null)
  /** The tests a first run lists: those of the loaded files, then the project's own, one runner's only. */
  const runFiles = (family: 'js' | 'py'): string[] => {
    const out: string[] = []
    for (const p of paths) {
      const t = testOf(p)
      if (t && testFamily(extOf(t)) === family && !out.includes(t)) out.push(t)
    }
    for (const t of tests) if (testFamily(extOf(t)) === family && !out.includes(t)) out.push(t)
    return out.slice(0, PANEL_RUN_FILES)
  }
  /** One vitest run (watch mode): each file with its own count, totals that add up, all passing. */
  const vitest = (files: readonly string[], first: boolean, version: string): string[] => {
    const runs = files.slice(0, PANEL_RUN_FILES).map((p) => ({ p, count: testCount(p), ms: ms(2, 48) }))
    const total = runs.reduce((s, r) => s + r.count, 0)
    const testsMs = runs.reduce((s, r) => s + r.ms, 0)
    const transform = ms(20, 140)
    const collect = ms(30, 160)
    const prepare = ms(40, 220)
    return [
      ...(first ? ['', `> ${pkg}@${version} test`, '> vitest', ''] : [` RERUN  ${file}`, '']),
      ...runs.map((r) => ` ✓ ${r.p} (${r.count} ${r.count === 1 ? 'test' : 'tests'}) ${r.ms}ms`),
      '',
      ` Test Files  ${runs.length} passed (${runs.length})`,
      `      Tests  ${total} passed (${total})`,
      `   Start at  ${t24}`,
      `   Duration  ${transform + collect + testsMs + prepare + ms(10, 80)}ms (transform ${transform}ms, setup 0ms, collect ${collect}ms, tests ${testsMs}ms, environment 0ms, prepare ${prepare}ms)`,
      '',
      ' PASS  Waiting for file changes...',
      '       press h to show help, press q to quit'
    ]
  }
  /** The test terminal for a JS toolchain: the first run at start, a rerun when a file with a test changed, else unchanged. */
  const jsTests = (version: string): string[] | null => {
    if (kind === 'start') {
      const all = runFiles('js')
      return all.length ? vitest(all, true, version) : null
    }
    const t = testOf(file)
    return t && testFamily(extOf(t)) === 'js' ? vitest([t], false, version) : null
  }
  let dev: string[] = []
  let test: string[] | null = null
  switch (src.tool) {
    case 'vite':
      dev =
        kind === 'start'
          ? ['', `> ${pkg}@0.0.0 dev`, '> vite', '', `  VITE v6.1.0  ready in ${ms(280, 640)} ms`, '', '  ➜  Local:   http://localhost:5173/', '  ➜  Network: use --host to expose', '  ➜  press h + enter to show help']
          : file
            ? [extOf(file) === 'html' ? `${t12} [vite] (client) page reload ${file}` : `${t12} [vite] (client) hmr update /${file}`]
            : []
      test = jsTests('0.0.0')
      break
    case 'next': {
      const route = nextRoute(file)
      dev =
        kind === 'start'
          ? ['', `> ${pkg}@0.1.0 dev`, '> next dev', '', '   ▲ Next.js 15.2.0', '   - Local:        http://localhost:3000', '', ' ✓ Starting...', ` ✓ Ready in ${(n(9, 30) / 10).toFixed(1)}s`]
          : route
            ? [` ○ Compiling ${route} ...`, ` ✓ Compiled ${route} in ${ms(90, 900)}ms (${n(300, 1400)} modules)`]
            : [` ✓ Compiled in ${ms(80, 400)}ms (${n(300, 1400)} modules)`]
      test = jsTests('0.1.0')
      break
    }
    case 'node':
      dev =
        kind === 'start'
          ? ['', `> ${pkg}@1.0.0 watch`, '> tsc --watch --preserveWatchOutput', '', `[${t12}] Starting compilation in watch mode...`, '', `[${t12}] Found 0 errors. Watching for file changes.`]
          : [`[${t12}] File change detected. Starting incremental compilation...`, '', `[${t12}] Found 0 errors. Watching for file changes.`]
      test = jsTests('1.0.0')
      break
    case 'cargo': {
      // cargo-watch runs both commands on every change; the test count is the crate's own, the same each run.
      const crate = pkg.replace(/[^a-z0-9_]+/g, '_')
      const hash = (hash32('crate', pkg).toString(16) + hash32('crate-2', pkg).toString(16)).padStart(16, '0').slice(0, 16)
      const count = 4 + (hash32('cargo-tests', pkg) % 36)
      const root = paths.includes('src/lib.rs') || !paths.includes('src/main.rs') ? 'src/lib.rs' : 'src/main.rs'
      dev = [
        `[Running 'cargo check && cargo test']`,
        `    Checking ${pkg} v0.1.0`,
        `    Finished \`dev\` profile [unoptimized + debuginfo] target(s) in ${secs(0.4, 6)}s`,
        `   Compiling ${pkg} v0.1.0`,
        `    Finished \`test\` profile [unoptimized + debuginfo] target(s) in ${secs(0.8, 9)}s`,
        `     Running unittests ${root} (target/debug/deps/${crate}-${hash})`,
        '',
        `running ${count} tests`,
        `test result: ok. ${count} passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in ${secs(0.01, 0.9)}s`,
        '',
        '[Finished running. Exit status: 0]'
      ]
      break
    }
    case 'go': {
      // A command that runs once: its packages at start, then the terminal waits at the prompt.
      if (kind !== 'start') break
      const dirs = [...new Set(paths.filter((p) => extOf(p) === 'go').map((p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')))].slice(0, 6)
      dev = dirs.length ? dirs.map((d) => `ok  \t${pkg}${d ? '/' + d : ''}\t${(n(80, 900) / 1000).toFixed(3)}s`) : [`?   \t${pkg}\t[no test files]`]
      break
    }
    case 'python': {
      const runs = (kind === 'start' ? runFiles('py') : [testOf(file)].filter((t): t is string => !!t && extOf(t) === 'py')).map((p) => ({ p, count: testCount(p) }))
      if (!runs.length) break
      const total = runs.reduce((s, r) => s + r.count, 0)
      let done = 0
      dev = [
        `${'='.repeat(17)} test session starts ${'='.repeat(17)}`,
        `collected ${total} items`,
        '',
        ...runs.map((r) => {
          done += r.count
          return `${`${r.p} ${'.'.repeat(r.count)}`.padEnd(48)} [${String(Math.round((100 * done) / total)).padStart(3)}%]`
        }),
        '',
        `${'='.repeat(16)} ${total} passed in ${secs(0.1, 2.4)}s ${'='.repeat(16)}`,
        `${'#'.repeat(14)} waiting for changes ${'#'.repeat(14)}`
      ]
      break
    }
    case 'ruby': {
      if (kind === 'start') {
        dev = [`${t24} - INFO - Guard::RSpec is running`, `${t24} - INFO - Guard is now watching at '${pkg}'`]
        break
      }
      const spec = testOf(file)
      if (!spec || extOf(spec) !== 'rb') break
      const count = testCount(spec)
      dev = [`${t24} - INFO - Running: ${spec}`, '.'.repeat(count), '', `Finished in ${secs(0.05, 1.5)} seconds (files took ${secs(0.3, 1.2)} seconds to load)`, `${count} examples, 0 failures`, '']
      break
    }
    case 'gradle': {
      // The build's task count is the project's own, the same each run; how many ran varies.
      const total = 5 + (hash32('gradle-tasks', pkg) % 5)
      const ran = n(1, Math.min(4, total - 1))
      const body = ['> Task :compileJava', '> Task :classes', '> Task :test', '', `BUILD SUCCESSFUL in ${n(2, 9)}s`, `${total} actionable tasks: ${ran} executed, ${total - ran} up-to-date`, '', 'Waiting for changes to input files... (ctrl-d to exit)']
      dev = kind === 'start' ? body : ['Change detected, executing build...', '', ...body]
      break
    }
    default: {
      // `make watch`: only C and C++ files are compiled, never a style sheet or a script.
      const isC = (p: string): boolean => /\.(?:c|cc|cpp|cxx)$/.test(p)
      const compile = (p: string): string => `${/\.c$/.test(p) ? 'cc' : 'c++'} -O2 -Wall -c ${p} -o build/${sourceStem(p)}.o`
      const cFiles = paths.filter(isC)
      if (kind === 'start') dev = cFiles.length ? [...cFiles.slice(0, 4).map(compile), 'cc -o build/app build/*.o'] : ["make: Nothing to be done for 'all'."]
      else if (isC(file)) dev = [compile(file), 'cc -o build/app build/*.o']
    }
  }
  const clean = (lines: readonly string[], max: number): string[] => lines.slice(0, max).map((l) => l.replace(PANEL_CONTROLS, '').slice(0, 160))
  return { dev: clean(dev, WM_PANEL_DEV_MAX), test: test === null ? null : clean(test, WM_PANEL_TEST_MAX) }
}

/** How a terminal colours a panel line: a pass in green, a run's header, the quiet details, else plain. */
export function panelLineKind(text: string): 'out' | 'ok' | 'dim' | 'info' {
  if (/^\s*(?:✓|ok\b|PASS\b|BUILD SUCCESSFUL|test result: ok|Test Files\s|Tests\s+\d+ passed|=+ \d+ passed|\d+ examples, 0 failures)/.test(text)) return 'ok'
  if (/^\s*(?:RERUN\b|VITE\b|▲|➜|\[Running\b)/.test(text)) return 'info'
  if (/^\s*(?:Start at\b|Duration\b|press h\b|> )/.test(text)) return 'dim'
  return 'out'
}

const PROMPT_COMMAND: Record<Toolchain, string> = {
  vite: 'npm run dev',
  next: 'npm run dev',
  node: 'npm run watch',
  cargo: 'cargo watch -x check -x test',
  go: 'go test ./...',
  python: 'pytest --looponfail',
  ruby: 'bundle exec guard',
  gradle: './gradlew build --continuous',
  make: 'make watch'
}

/** A shell prompt: the project's NAME only (a path's last segment, controls dropped, at most 40 characters) and its branch. */
function promptFor(name: string, branch: string | null, command: string): string {
  const clean = (s: string, max: number): string => s.replace(PANEL_CONTROLS, '').replace(/\s+/g, ' ').trim().slice(0, max)
  const base = clean(name.replace(/[\\/]+$/, '').replace(/^.*[\\/]/, ''), 40) || 'app'
  const b = branch ? clean(branch, 40) : ''
  return `${base}${b ? ` git:(${b})` : ''} $ ${command}`
}

/** The first terminal's first line: the toolchain's dev or watch command. Never the folder's path or a user name. */
export function panelPrompt(name: string, branch: string | null, tool: Toolchain): string {
  return promptFor(name, branch, PROMPT_COMMAND[tool])
}

/** The test terminal's first line (`hasTestTerminal`): `npm test`, vitest in watch mode. */
export function panelTestPrompt(name: string, branch: string | null): string {
  return promptFor(name, branch, 'npm test')
}

/* --------------------------------------------------------- status bar */

/**
 * The indentation a file uses: tabs when more lines start with a tab than with
 * spaces, else the most common positive step between two indented lines (2, 4
 * or 8). Four when nothing says.
 */
export function detectIndent(text: string): { tabs: boolean; size: 2 | 4 | 8 } {
  const lines = text.split('\n')
  let tabbed = 0
  let spaced = 0
  const steps = new Map<number, number>()
  let prev = 0
  for (const line of lines) {
    if (!line.trim()) continue
    if (line.startsWith('\t')) {
      tabbed++
      continue
    }
    const m = /^ +/.exec(line)
    const n = m ? m[0].length : 0
    if (n > 0) spaced++
    const step = Math.abs(n - prev)
    if (step > 0) steps.set(step, (steps.get(step) ?? 0) + 1)
    prev = n
  }
  if (tabbed > spaced) return { tabs: true, size: 4 }
  let best = 4
  let bestCount = 0
  for (const size of [2, 4, 8]) {
    const c = steps.get(size) ?? 0
    if (c > bestCount) {
      best = size
      bestCount = c
    }
  }
  return { tabs: false, size: best as 2 | 4 | 8 }
}
