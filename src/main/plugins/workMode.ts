/**
 * Work mode's reader: the code of the project in front, for the pretend IDE
 * (renderer components/WorkMode.tsx). Read-only, and only ever read: nothing
 * is written into the project, nothing in it is run, nothing read is synced or
 * sent anywhere but this window's renderer.
 *
 * The rules, each a gotcha:
 * - **No sync fs, a deadline on every step, loaded lazily** (gotcha 40): a
 *   project can be on a sleeping volume. index.ts imports this module only on
 *   the first Work mode request.
 * - **No repo code runs** (gotcha 147): in a repository the listing is `git
 *   ls-files` behind `safeGitArgs` (no optional locks, `core.fsmonitor=false`,
 *   the repo's own filters emptied) and nothing else, so an ignored file is
 *   never read; elsewhere a bounded walk that never follows a link.
 * - **Nothing secret-shaped is opened** (shared/workMode.ts
 *   `workModePathClass`), nothing outside the folder is reached through a link
 *   (realpath containment, then `O_NOFOLLOW`; `O_NONBLOCK` so a FIFO cannot
 *   hold a thread, gotcha 152's shape), and every text goes through the
 *   index's secret patterns and the key-shaped net before it leaves main
 *   (`cleanForShow`, gotcha 156's two layers). Those mask text SHAPED like a
 *   key; a short password no pattern knows is shown as written, so the copy
 *   promises no more than that (review OPEN 1).
 * - **Gotcha 179**: in a repository, git lists and nothing walks; a read's
 *   realpath is judged by the same name rules as its listed path; a
 *   listing's cap counts only paths the rules let through.
 * - **Claim before the first await** (gotcha 20): two requests for one folder
 *   share one listing.
 * - **Every real timer is overridable** (gotcha 174), so the suite can make
 *   each deadline fire.
 *
 * Electron-free, relative `.ts` imports, no parameter properties: the suite
 * loads it under node's strip-types.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open, readdir, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative } from 'node:path'
import { launchFolderProblem, realpathFolder } from '../folderCheck.ts'
import { gitEnv, locateRepo, safeGitArgs } from '../gitStatus.ts'
import { redactSecrets } from '../chatIndex/parse.ts'
import { PluginStorage } from './storage.ts'
import { redactKeyShaped } from '../../shared/keyShaped.ts'
import { dropInvisible } from '../../shared/chatIndex.ts'
import { isInside, pathKey, pathRulesFor, type PathRules } from '../../shared/paths.ts'
import { parseHead } from '../../shared/gitStatus.ts'
import {
  CODE_PATHSPECS,
  WM_FILES_MAX,
  WM_FILES_PER_TYPE,
  WM_FILE_MAX_BYTES,
  WM_FILE_MIN_BYTES,
  WM_LIST_MAX,
  WM_PROJECTS_MAX,
  WM_SAMPLE_KEY,
  WM_TOTAL_MAX_BYTES,
  WM_TREE_MAX,
  WM_TREE_TESTS_MAX,
  WM_WALK_MAX_DEPTH,
  WM_WALK_MAX_ENTRIES,
  chooseCandidates,
  relatedFileScore,
  clampOptions,
  countTypes,
  emptyWorkModeState,
  extOf,
  isTestPath,
  lineCapOf,
  orderPicks,
  parseWorkModeState,
  rememberedPicks,
  skippedDir,
  sourceStem,
  testStem,
  toolchain,
  validPicks,
  workModeFolderVerdict,
  workModePathClass,
  type Toolchain,
  type WorkModeFile,
  type WorkModeOptions,
  type WorkModeReason,
  type WorkModeScan,
  type WorkModeSource,
  type WorkModeState,
  type WorkModeType
} from '../../shared/workMode.ts'

export interface WorkModeTimeouts {
  /** `git config` for the filter list. */
  config: number
  /** `git ls-files`. */
  list: number
  /** The bounded walk, and the explorer's sibling reads, in all. */
  walk: number
  /** One file's open and read. */
  file: number
  /** Every file's read, in all. */
  read: number
  /** How long a listing is reused. */
  cache: number
}

export const WORK_MODE_TIMEOUTS: WorkModeTimeouts = { config: 2000, list: 2500, walk: 1500, file: 1000, read: 3000, cache: 60_000 }

export interface WorkModeDeps {
  userData: string
  home: string
  platform: NodeJS.Platform
  git: () => Promise<string | null>
  env: () => Promise<NodeJS.ProcessEnv>
  enabled: () => Promise<boolean>
  privateRoots: () => string[]
  now?: () => number
  random?: () => number
  /** Every real timer is overridable (gotcha 174). */
  timeouts?: Partial<WorkModeTimeouts>
}

/** C0 and C1 controls other than tab and newline. */
// eslint-disable-next-line no-control-regex
const SHOW_CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
// eslint-disable-next-line no-control-regex
const PATH_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/

/**
 * What every text goes through before it leaves main: controls other than tab
 * and newline dropped, invisible characters inside words dropped (they split a
 * key for a pattern but not for a reader), then the index's secret patterns,
 * then the key-shaped net. Null when nothing is left to show.
 */
export function cleanForShow(text: string): string | null {
  const out = redactKeyShaped(redactSecrets(dropInvisible(text.replace(SHOW_CONTROLS, ''))))
  return out.trim() ? out : null
}

/** A path or a name is shown only if neither layer would change it: a hashed artefact's name is key-shaped. */
function cleanName(s: string): boolean {
  return redactSecrets(s) === s && redactKeyShaped(s) === s
}

/** The work-mode.json key for a folder: a hash, so the file names no folder. */
export function picksKey(real: string, rules: PathRules): string {
  return createHash('sha256').update(pathKey(real, rules)).digest('hex').slice(0, 32)
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((done) => {
    timer = setTimeout(() => done('late'), ms)
    timer.unref?.()
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

const yieldTurn = (): Promise<void> => new Promise((done) => setImmediate(done))

/**
 * Paths judged between two turns of main's loop while listing. Each costs a few
 * microseconds (the secret patterns, the path rules), and a monorepo lists tens
 * of thousands: 50,000 in one go held main for about 220 ms (measured
 * 2026-10-28, gotcha 40), every pty and IPC reply waiting behind it.
 */
const LIST_SLICE = 1000

interface Listing {
  real: string
  key: string
  name: string
  branch: string | null
  tool: Toolchain
  /** Readable paths, relative to `real`, `/`-separated. */
  readPaths: string[]
  /** Top-level entries for the explorer: `dir/` or a file's name. */
  top: string[]
  /** The walk's entries per directory ('' is the top), or null for a git listing. */
  walked: Map<string, string[]> | null
  /** The repository's work tree, when the folder is in one. */
  repo: boolean
}

type Listed = { listing: Listing; reason: null } | { listing: Listing | null; reason: WorkModeReason }

interface RunResult {
  stdout: string
  error: (Error & { code?: string | number | null; killed?: boolean }) | null
}

function run(file: string, args: string[], env: NodeJS.ProcessEnv, timeout: number): Promise<RunResult> {
  return new Promise((done) => {
    execFile(file, args, { env, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true, encoding: 'utf8' }, (error, stdout) =>
      done({ stdout: String(stdout ?? ''), error })
    )
  })
}

export class WorkModeReader {
  private deps: WorkModeDeps
  private t: WorkModeTimeouts
  private rules: PathRules
  private storage: PluginStorage<WorkModeState>
  /** Picks and options kept in memory when the file cannot be read or written: they still hold for this run. */
  private memory: WorkModeState | null = null
  private inflight = new Map<string, Promise<Listed>>()
  private cache = new Map<string, { at: number; listed: Listed }>()
  private generation = 0

  constructor(deps: WorkModeDeps) {
    this.deps = deps
    this.t = { ...WORK_MODE_TIMEOUTS, ...deps.timeouts }
    this.rules = pathRulesFor(deps.platform)
    this.storage = new PluginStorage(join(deps.userData, 'plugins', 'work-mode.json'), parseWorkModeState, emptyWorkModeState)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private places: Promise<{ home: string; userData: string }> | null = null
  /** Home and userData through their links, resolved once (a deadline each, gotcha 40). */
  private resolvedPlaces(): Promise<{ home: string; userData: string }> {
    return (this.places ??= Promise.all([realpathFolder(this.deps.home), realpathFolder(this.deps.userData)]).then(([home, userData]) => ({ home, userData })))
  }

  /** Ends whatever is in flight: its answer is dropped, and the next request lists afresh. */
  stop(): void {
    this.generation++
    this.inflight.clear()
    this.cache.clear()
  }

  private async state(): Promise<WorkModeState> {
    if (this.memory) return structuredClone(this.memory)
    try {
      return await this.storage.read()
    } catch {
      return emptyWorkModeState()
    }
  }

  private async save(edit: (s: WorkModeState) => WorkModeState): Promise<WorkModeState> {
    if (!this.memory) {
      try {
        return await this.storage.change((s) => edit(s))
      } catch {
        // The file is unreadable or the disk refused: keep the change for this run, never throw it across IPC.
        this.memory = parseWorkModeState(edit(await this.state()))
        return structuredClone(this.memory)
      }
    }
    this.memory = parseWorkModeState(edit(structuredClone(this.memory)))
    return structuredClone(this.memory)
  }

  /* ------------------------------------------------------------ listing */

  /** The folder's listing, shared by every request for the same raw `cwd` in flight, cached briefly by its real path. */
  private listed(cwd: unknown): Promise<Listed> {
    const raw = typeof cwd === 'string' ? cwd : ''
    const running = this.inflight.get(raw)
    if (running) return running
    // Claimed before the first await (gotcha 20).
    const gen = this.generation
    const job = this.list(cwd, gen).finally(() => {
      if (this.inflight.get(raw) === job) this.inflight.delete(raw)
    })
    this.inflight.set(raw, job)
    return job
  }

  private async list(cwd: unknown, gen: number): Promise<Listed> {
    if (typeof cwd !== 'string' || cwd.length > 4096 || PATH_CONTROLS.test(cwd) || !isAbsolute(cwd)) return { listing: null, reason: 'no-folder' }
    if (!(await this.deps.enabled().catch(() => false))) return { listing: null, reason: 'disabled' }
    if ((await launchFolderProblem(cwd)) !== null) return { listing: null, reason: 'unreadable' }
    const real = await realpathFolder(cwd)
    const roots = (() => {
      try {
        return this.deps.privateRoots()
      } catch {
        return []
      }
    })()
    /*
     * The folder is a realpath, so the places it may not be are judged as typed
     * AND resolved (gotcha 91): a home or a userData reached through a link
     * (macOS's /tmp, a symlinked home) was not refused when only the typed
     * path was compared. Found driving a sandbox whose HOME was under /tmp.
     */
    const typed = { home: this.deps.home, userData: this.deps.userData, privateRoots: roots, rules: this.rules }
    const resolved = { ...(await this.resolvedPlaces()), privateRoots: await Promise.all(roots.map((r) => realpathFolder(r))), rules: this.rules }
    const verdict = [typed, resolved].map((v) => workModeFolderVerdict(real, v)).find((v) => v !== 'ok') ?? 'ok'
    if (verdict !== 'ok') return { listing: null, reason: 'refused' }
    const hit = this.cache.get(real)
    if (hit && this.now() - hit.at < this.t.cache) return hit.listed
    const listed = await this.listFolder(real)
    if (gen !== this.generation) return { listing: null, reason: 'slow' }
    this.cache.delete(real)
    this.cache.set(real, { at: this.now(), listed })
    while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value as string)
    return listed
  }

  private async listFolder(real: string): Promise<Listed> {
    const found = await withDeadline(locateRepo(real).catch(() => null), this.t.walk)
    const repo = found && found !== 'late' ? found : null
    const head = repo ? parseHead(repo.head) : null
    const branchRaw = head ? (head.branch ?? head.oid) : null
    const branch = branchRaw ? redactKeyShaped(branchRaw.replace(PATH_CONTROLS, '').slice(0, 80)) : null
    const name = redactKeyShaped(basename(real).replace(PATH_CONTROLS, '').slice(0, 120)) || 'project'

    const topEntries = await withDeadline(readdir(real, { withFileTypes: true }).catch(() => null), this.t.walk)
    const topNames = topEntries && topEntries !== 'late' ? topEntries : []
    const tool = toolchain(topNames.filter((d) => !d.isSymbolicLink()).map((d) => d.name))

    const nothing = (reason: WorkModeReason, walked: Map<string, string[]> | null = null): Listed => ({
      listing: { real, key: picksKey(real, this.rules), name, branch, tool, readPaths: [], top: [], walked, repo: !!repo },
      reason
    })
    let paths: string[]
    let walked: Map<string, string[]> | null = null
    if (found === 'late') return nothing('slow')
    if (repo) {
      /*
       * In a repository only what git lists is read: tracked files, and
       * untracked ones it does not ignore. A walk cannot honour .gitignore, and
       * an ignored file is where a project keeps its local secrets (a
       * config.local, a settings file), so a listing that cannot run (git
       * missing, an unsafe filter config, its deadline) is no listing at all.
       */
      const listed = await this.gitList(real, repo.root)
      if (listed === 'late') return nothing('slow')
      if (listed === null) return nothing('unreadable')
      paths = listed
    } else {
      const w = await this.walk(real)
      walked = w.dirs
      paths = w.files
      if (paths.length === 0 && w.late) return nothing('slow', walked)
    }
    const readPaths: string[] = []
    const topFiles = new Set<string>()
    for (let i = 0; i < paths.length; i++) {
      if (i % LIST_SLICE === LIST_SLICE - 1) await yieldTurn()
      if (workModePathClass(paths[i]) !== 'read') continue
      readPaths.push(paths[i])
      if (!paths[i].includes('/')) topFiles.add(paths[i])
    }
    const top = new Set<string>()
    for (const d of topNames) {
      if (d.isSymbolicLink()) continue
      if (d.isDirectory()) {
        if (!skippedDir(d.name) && cleanName(d.name) && (walked !== null || readPaths.some((p) => p.startsWith(d.name + '/')))) top.add(d.name + '/')
      } else if (d.isFile() && cleanName(d.name)) {
        // A code file is named only if it was listed: never the name of one git ignores.
        const cls = workModePathClass(d.name)
        if (cls === 'name' || (cls === 'read' && (walked !== null || topFiles.has(d.name)))) top.add(d.name)
      }
    }
    const listing: Listing = { real, key: picksKey(real, this.rules), name, branch, tool, readPaths, top: [...top], walked, repo: !!repo }
    return readPaths.length ? { listing, reason: null } : { listing, reason: 'empty' }
  }

  /**
   * `git ls-files` of the code types git shows (tracked, or untracked and not
   * ignored: `--exclude-standard` reads the ignore files and runs nothing),
   * relative to `real`, behind gotcha 147's switches. Null when git cannot be
   * run safely, 'late' past its deadline.
   */
  private async gitList(real: string, root: string): Promise<string[] | null | 'late'> {
    const git = await this.deps.git().catch(() => null)
    if (!git) return null
    const env = gitEnv(await this.deps.env().catch(() => ({}) as NodeJS.ProcessEnv))
    const prefix = await safeGitArgs(git, root, env, this.t.config)
    if (prefix === null) return null
    const r = await run(git, [...prefix, '-C', real, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...CODE_PATHSPECS], env, this.t.list)
    // `killed` before any numeric code (gotcha 25): a timeout is a kill, as is an overrun buffer.
    if (r.error) return r.error.killed ? 'late' : null
    const out: string[] = []
    let seen = 0
    for (const p of r.stdout.split('\0')) {
      if (out.length >= WM_LIST_MAX) break
      if (++seen % LIST_SLICE === 0) await yieldTurn()
      // Only a readable path counts towards the cap: git prints untracked paths first and the index sorted, so a
      // node_modules sorting before src/ would otherwise use it up (found in review). The cheap rules go first.
      if (!p || p.length > 300 || PATH_CONTROLS.test(p) || workModePathClass(p) !== 'read' || !cleanName(p)) continue
      out.push(p)
    }
    return out
  }

  /** A breadth-first walk that never follows a link, skips dependency, build and hidden folders, and stops at its bounds. */
  private async walk(real: string): Promise<{ files: string[]; dirs: Map<string, string[]>; late: boolean }> {
    const files: string[] = []
    const dirs = new Map<string, string[]>()
    const deadline = this.now() + this.t.walk
    let entries = 0
    let late = false
    let queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }]
    while (queue.length && entries < WM_WALK_MAX_ENTRIES) {
      if (this.now() >= deadline) {
        late = true
        break
      }
      const batch = queue.slice(0, 8)
      queue = queue.slice(8)
      const read = await withDeadline(
        Promise.all(batch.map((d) => readdir(d.rel ? join(real, ...d.rel.split('/')) : real, { withFileTypes: true }).catch(() => []))),
        Math.max(1, deadline - this.now())
      )
      if (read === 'late') {
        late = true
        break
      }
      batch.forEach((d, i) => {
        const kids: string[] = []
        for (const e of read[i]) {
          if (entries >= WM_WALK_MAX_ENTRIES) break
          entries++
          if (e.isSymbolicLink() || PATH_CONTROLS.test(e.name) || !cleanName(e.name)) continue
          const rel = d.rel ? `${d.rel}/${e.name}` : e.name
          if (rel.length > 300) continue
          if (e.isDirectory()) {
            if (skippedDir(e.name)) continue
            kids.push(e.name + '/')
            if (d.depth + 1 < WM_WALK_MAX_DEPTH) queue.push({ rel, depth: d.depth + 1 })
          } else if (e.isFile()) {
            const cls = workModePathClass(rel)
            if (cls === 'skip') continue
            kids.push(e.name)
            if (cls === 'read') files.push(rel)
          }
        }
        dirs.set(d.rel, kids)
      })
    }
    return { files, dirs, late }
  }

  /* ------------------------------------------------------------ answers */

  /**
   * A scan. When the folder gives nothing to type (no folder, refused, empty)
   * the renderer types the bundled sample, so `picks` are then the SAMPLE's
   * remembered ones (`WM_SAMPLE_KEY`), or none.
   */
  private async scanOf(listed: Listed, state: WorkModeState): Promise<WorkModeScan> {
    const options = state.options
    const samplePicks = state.picks[WM_SAMPLE_KEY]?.types ?? []
    if (!listed.listing) return { project: null, reason: listed.reason, types: [], picks: samplePicks, options }
    const l = listed.listing
    const types: WorkModeType[] = countTypes(l.readPaths)
    const picks = types.length ? rememberedPicks(state.picks[l.key]?.types, types) : samplePicks
    return { project: { name: l.name, branch: l.branch, toolchain: l.tool }, reason: listed.reason, types, picks, options }
  }

  /** The project's types, picks and options, no file contents. Never throws. */
  async scan(cwd: unknown): Promise<WorkModeScan> {
    try {
      return await this.scanOf(await this.listed(cwd), await this.state())
    } catch {
      return { project: null, reason: 'unreadable', types: [], picks: [], options: (await this.state()).options }
    }
  }

  /** The scan, the files to type and the explorer's tree. Never throws: a reason with no files means the sample. */
  async source(cwd: unknown): Promise<WorkModeSource> {
    const gen = this.generation
    try {
      const listed = await this.listed(cwd)
      const scan = await this.scanOf(listed, await this.state())
      if (!listed.listing || listed.reason !== null) return { ...scan, files: [], tree: listed.listing?.top.slice(0, WM_TREE_MAX) ?? [] }
      const l = listed.listing
      const files = await this.readFiles(l, scan.picks, gen)
      if (gen !== this.generation) return { ...scan, reason: 'slow', files: [], tree: [] }
      if (files.length === 0) return { ...scan, reason: 'empty', files: [], tree: l.top.slice(0, WM_TREE_MAX) }
      const tree = await this.treeOf(l, files)
      return { ...scan, files, tree }
    } catch {
      return { project: null, reason: 'unreadable', types: [], picks: [], options: (await this.state()).options, files: [], tree: [] }
    }
  }

  private async readFiles(l: Listing, picks: readonly string[], gen: number): Promise<WorkModeFile[]> {
    const seed = Math.floor((this.deps.random ?? Math.random)() * 0x7fffffff)
    const ranked = chooseCandidates(l.readPaths, picks, seed)
    const deadline = this.now() + this.t.read
    const out: WorkModeFile[] = []
    let bytes = 0
    const accepted = new Map<string, number>(picks.map((p) => [p, 0]))
    const tried = new Map<string, number>(picks.map((p) => [p, 0]))
    const cursor = new Map<string, number>(picks.map((p) => [p, 0]))
    // Round-robin over the picks, so every picked type gets files before any gets its last.
    for (let progress = true; progress && out.length < WM_FILES_MAX; ) {
      progress = false
      for (const ext of picks) {
        if (out.length >= WM_FILES_MAX || bytes >= WM_TOTAL_MAX_BYTES) return out
        if (this.now() >= deadline || gen !== this.generation) return out
        const list = ranked.get(ext) ?? []
        if ((accepted.get(ext) ?? 0) >= WM_FILES_PER_TYPE || (tried.get(ext) ?? 0) >= 40) continue
        const at = cursor.get(ext) ?? 0
        if (at >= list.length) continue
        cursor.set(ext, at + 1)
        tried.set(ext, (tried.get(ext) ?? 0) + 1)
        progress = true
        const rel = list[at]
        const read = await withDeadline(this.readOne(l.real, rel), Math.max(1, Math.min(this.t.file, deadline - this.now())))
        if (read === 'late' || read === null) continue
        if (bytes + read.bytes > WM_TOTAL_MAX_BYTES) continue
        const text = cleanForShow(read.text)
        // Between files, so main is never held longer than one file's clean (gotcha 156's measured ~13 ms per 64 KB).
        await yieldTurn()
        if (text === null) continue
        bytes += read.bytes
        accepted.set(ext, (accepted.get(ext) ?? 0) + 1)
        out.push({ path: rel, ext: extOf(rel), text, eol: read.eol })
        if (out.length === 1) {
          // Once an actual readable file is known, keep the other editor in
          // the same feature where possible. Preserve attempts already made.
          for (const [kind, paths] of ranked) {
            if (this.now() >= deadline || gen !== this.generation) return out
            const done = cursor.get(kind) ?? 0
            const remaining = paths.slice(done).map((path, order) => ({ path, order, score: relatedFileScore(rel, path) }))
            remaining.sort((a, b) => b.score - a.score || a.order - b.order)
            ranked.set(kind, [...paths.slice(0, done), ...remaining.map(item => item.path)])
            await yieldTurn()
          }
        }
      }
    }
    return out
  }

  /**
   * One file, or null. Its realpath must stay inside the folder (no parent
   * link leads out) and pass the same name rules as its listed path (no parent
   * link leads into a secret-named or hidden folder inside it); it is opened
   * with `O_NOFOLLOW` (no final link) and
   * `O_NONBLOCK` (a FIFO swapped in never blocks), judged by `fstat` of that
   * descriptor, read whole, and taken only as UTF-8 with no NUL and no
   * minified line.
   */
  private async readOne(real: string, rel: string): Promise<{ text: string; eol: 'LF' | 'CRLF'; bytes: number } | null> {
    const full = join(real, ...rel.split('/'))
    const resolved = await realpath(full).catch(() => null)
    if (!resolved || !isInside(real, resolved, this.rules)) return null
    // Judged where it really is, too: a parent swapped for a link INSIDE the folder can lead a listed
    // path into a secret-named or hidden folder, which the name rules never let it open.
    if (workModePathClass(relative(real, resolved)) !== 'read') return null
    if (this.deps.platform === 'win32') {
      // No O_NOFOLLOW there: refuse a link by looking first.
      const st = await lstat(full).catch(() => null)
      if (!st || !st.isFile()) return null
    }
    const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0)
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(full, flags)
      const st = await handle.stat()
      if (!st.isFile() || st.size < WM_FILE_MIN_BYTES || st.size > WM_FILE_MAX_BYTES) return null
      const buf = Buffer.alloc(st.size)
      let got = 0
      while (got < st.size) {
        const { bytesRead } = await handle.read(buf, got, st.size - got, got)
        if (bytesRead === 0) break
        got += bytesRead
      }
      if (got !== st.size || buf.includes(0)) return null
      let text: string
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(buf)
      } catch {
        return null
      }
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
      const eol = text.includes('\r\n') ? 'CRLF' : 'LF'
      text = text.replace(/\r\n?/g, '\n')
      const cap = lineCapOf(extOf(rel))
      for (const line of text.split('\n')) if (line.length > cap) return null
      return { text, eol, bytes: got }
    } catch {
      return null
    } finally {
      await handle?.close().catch(() => {})
    }
  }

  /**
   * The explorer: the top level, every chosen file's folders, the project's own
   * tests of the chosen files (so the build panel names real ones, at most
   * `WM_TREE_TESTS_MAX`; names only, from the listing the rules already
   * passed), and the chosen files' siblings (at most 12 folders read).
   */
  private async treeOf(l: Listing, files: readonly WorkModeFile[]): Promise<string[]> {
    const out = new Set<string>(l.top)
    const parents = new Set<string>()
    const addWithFolders = (path: string): void => {
      const parts = path.split('/')
      for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/') + '/')
      out.add(path)
    }
    for (const f of files) {
      addWithFolders(f.path)
      parents.add(f.path.split('/').slice(0, -1).join('/'))
    }
    const stems = new Set(files.filter((f) => !isTestPath(f.path)).map((f) => sourceStem(f.path)))
    let tests = 0
    for (let i = 0; i < l.readPaths.length && tests < WM_TREE_TESTS_MAX && out.size < WM_TREE_MAX; i++) {
      if (i % LIST_SLICE === LIST_SLICE - 1) await yieldTurn()
      const p = l.readPaths[i]
      if (out.has(p) || !isTestPath(p) || !stems.has(testStem(p))) continue
      addWithFolders(p)
      tests++
    }
    const deadline = this.now() + this.t.walk
    let reads = 0
    for (const dir of parents) {
      if (out.size >= WM_TREE_MAX) break
      const prefix = dir ? dir + '/' : ''
      if (l.walked) {
        for (const kid of l.walked.get(dir) ?? []) out.add(prefix + kid)
        continue
      }
      // A git listing: the tracked code beside it, and only the explorer's name-only files from the folder itself.
      for (const p of l.readPaths) if (p.startsWith(prefix) && !p.slice(prefix.length).includes('/')) out.add(p)
      if (reads >= 12 || this.now() >= deadline) continue
      reads++
      const entries = await withDeadline(readdir(dir ? join(l.real, ...dir.split('/')) : l.real, { withFileTypes: true }).catch(() => []), Math.max(1, deadline - this.now()))
      if (entries === 'late') continue
      for (const e of entries) if (e.isFile() && workModePathClass(prefix + e.name) === 'name' && cleanName(e.name)) out.add(prefix + e.name)
    }
    return [...out].slice(0, WM_TREE_MAX)
  }

  /**
   * Save the picked types for this project (only types it has), and answer its
   * scan. A folder that gives nothing to type means the sample is on screen,
   * so the picks are the sample's then (`WM_SAMPLE_KEY`).
   */
  async pick(cwd: unknown, types: unknown): Promise<WorkModeScan> {
    const wanted = validPicks(types)
    const listed = await this.listed(cwd).catch((): Listed => ({ listing: null, reason: 'unreadable' }))
    if (!wanted || listed.reason === 'disabled') return this.scanOf(listed, await this.state())
    if (!listed.listing || listed.listing.readPaths.length === 0) {
      const state = await this.save((s) => {
        s.picks[WM_SAMPLE_KEY] = { types: wanted, at: this.now() }
        s.revision++
        return s
      })
      return this.scanOf(listed, state)
    }
    // Most-used first, whatever order they were ticked in: the left editor types the first (`orderPicks`).
    const kept = orderPicks(wanted, countTypes(listed.listing.readPaths))
    if (!kept.length) return this.scanOf(listed, await this.state())
    const key = listed.listing.key
    const state = await this.save((s) => {
      s.picks[key] = { types: kept, at: this.now() }
      const keys = Object.keys(s.picks).sort((a, b) => s.picks[b].at - s.picks[a].at)
      for (const k of keys.slice(WM_PROJECTS_MAX)) delete s.picks[k]
      s.revision++
      return s
    })
    return this.scanOf(listed, state)
  }

  /** Characters per key (an integer, clamped to 1-12) and the build panel (a boolean); anything else is ignored. */
  async options(patch: unknown): Promise<WorkModeOptions> {
    const current = (await this.state()).options
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return current
    if (!(await this.deps.enabled().catch(() => false))) return current
    const p = patch as Record<string, unknown>
    const next: WorkModeOptions = { ...current }
    if (typeof p.charsPerKey === 'number' && Number.isInteger(p.charsPerKey)) next.charsPerKey = clampOptions({ charsPerKey: p.charsPerKey }).charsPerKey
    if (typeof p.panel === 'boolean') next.panel = p.panel
    if (next.charsPerKey === current.charsPerKey && next.panel === current.panel) return current
    const state = await this.save((s) => {
      s.options = next
      s.revision++
      return s
    })
    return state.options
  }
}
