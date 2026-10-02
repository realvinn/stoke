/**
 * The git state of the folder a tab is in, for the title bar's git chip.
 *
 * Electron-free and relative-`.ts`-only, so `verify:git` runs it under node
 * strip-types against real scratch repositories with a real `git`.
 *
 * The rules it keeps, each a gotcha:
 * - **No repo code runs** (gotcha 147). A plain `git status` executes the
 *   repo's `core.fsmonitor` hook, and re-hashing a stat-dirty file runs the
 *   repo's `filter.<x>.clean` — both measured. A tab can be open in a folder
 *   nobody has trusted yet (an unpacked archive, a clone whose `.git/config`
 *   was edited), so every status passes `-c core.fsmonitor=false`, empties
 *   every filter the REPO defines (`filterOverrides`), and takes no lock
 *   (`--no-optional-locks`), so no index write and no `post-index-change` hook,
 *   and never a fight with the agent's own `git add`.
 * - **Never fetches.** Ahead/behind is as of the last fetch, and says so.
 * - **Never a stale "clean".** A timeout, a missing git or a refusal is
 *   `changes: null` with the reason, never the last reading's zero.
 * - **Deadlines everywhere** (gotcha 40): the root walk can hit a sleeping
 *   volume, `git status` a huge repo. `execFile` errors are read `killed`
 *   first (gotcha 25), with a buffer far past 1 MB (gotcha 13).
 * - **One run per folder at a time** (gotcha 20): the in-flight promise is
 *   claimed before the first await, and a short cache lets several tabs on one
 *   repo share a process.
 */
import { execFile } from 'node:child_process'
import { access, constants, readFile, realpath } from 'node:fs/promises'
import { basename, delimiter, join, resolve } from 'node:path'
import { canonicalRootOf, gitRootOf } from './skillsProject.ts'
import { filterOverrides, NO_REPO, parseHead, parseStatusV2, type GitStatus } from '../shared/gitStatus.ts'

/** The realpath, the walk up to `.git` and the HEAD read, together. */
export const FIND_DEADLINE_MS = 1500
/** `git config` listing the filters: a config read, quick or broken. */
export const CONFIG_TIMEOUT_MS = 2000
/** `git status` itself: seconds in a very large repository. */
export const STATUS_TIMEOUT_MS = 4000
/** Untracked-heavy trees print a lot; 1 MB (execFile's default) is ~20k paths. */
export const STATUS_MAX_BUFFER = 16 * 1024 * 1024

export interface GitDeps {
  /** The git binary to run, or null when there is none to run. */
  git: () => Promise<string | null>
  /** The environment git runs with: PATH, HOME and the rest. */
  env: () => Promise<NodeJS.ProcessEnv>
  now?: () => number
  /** Overridable for a suite that wants a deadline to fire. */
  timeouts?: { find?: number; config?: number; status?: number }
}

interface ExecResult {
  stdout: string
  stderr: string
  error: (Error & { code?: string | number | null; killed?: boolean; signal?: string | null }) | null
}

function run(file: string, args: string[], opts: { env: NodeJS.ProcessEnv; timeout: number; maxBuffer: number }): Promise<ExecResult> {
  return new Promise((done) => {
    execFile(
      file,
      args,
      { env: opts.env, timeout: opts.timeout, maxBuffer: opts.maxBuffer, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => done({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error })
    )
  })
}

/**
 * Why a git run failed, in a sentence. `killed` before any numeric code
 * (gotcha 25): a timeout is `killed: true, code: null`, and a maxBuffer overrun
 * is a kill too, with Node's own `ERR_*` code.
 */
export function describeGitError(r: ExecResult): string {
  const e = r.error
  if (!e) return ''
  if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'too many changes to count'
  if (e.killed) return 'git took too long to answer'
  if (e.code === 'ENOENT') return 'git was not found'
  if (typeof e.code === 'number') {
    const line = r.stderr.split('\n').map((l) => l.trim()).find(Boolean)
    return line ? line.replace(/^(fatal|error):\s*/i, '') : `git exited with code ${e.code}`
  }
  return e.message || 'git could not be run'
}

/** Git's own variables from Stoke's environment would point it elsewhere (a hook's `GIT_DIR`), so none survive. */
export function gitEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) if (!/^GIT_/i.test(k)) env[k] = v
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_TERMINAL_PROMPT = '0'
  env.LC_ALL = 'C'
  return env
}

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | 'late'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>((done) => {
    timer = setTimeout(() => done('late'), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

interface Located {
  root: string
  gitDir: string
  head: string
  main: string
}

/** Find the work tree, its git dir and HEAD with no process at all. Null outside a repository. */
async function locate(path: string): Promise<Located | null> {
  const real = await realpath(path).catch(() => resolve(path))
  const root = await gitRootOf(real)
  if (!root) return null
  const dotGit = join(root, '.git')
  let gitDir = dotGit
  const asFile = await readFile(dotGit, 'utf8').catch(() => null)
  if (asFile !== null) {
    const m = /^gitdir:\s*(.+)$/m.exec(asFile.trim())
    if (!m) return null
    gitDir = resolve(root, m[1].trim())
  }
  const head = await readFile(join(gitDir, 'HEAD'), 'utf8').catch(() => '')
  const main = await canonicalRootOf(root)
  return { root, gitDir, head, main }
}

/**
 * One reading of `path`. Never throws: every failure is a reading that says
 * what it could not find out.
 */
export async function readGitStatus(path: string, deps: GitDeps): Promise<GitStatus> {
  const now = deps.now ?? Date.now
  const t = { find: FIND_DEADLINE_MS, config: CONFIG_TIMEOUT_MS, status: STATUS_TIMEOUT_MS, ...deps.timeouts }

  const found = await withDeadline(locate(path).catch(() => null), t.find)
  if (found === 'late') return { ...NO_REPO, error: 'the folder did not answer in time', at: now() }
  if (!found) return { ...NO_REPO, at: now() }

  const head = parseHead(found.head)
  const base: GitStatus = {
    ...NO_REPO,
    repo: true,
    root: found.root,
    branch: head.branch,
    oid: head.oid,
    detached: head.detached,
    worktree: found.main !== found.root ? { main: found.main, name: basename(found.root) } : null,
    at: now()
  }

  const git = await deps.git().catch(() => null)
  if (!git) return { ...base, error: 'git was not found', at: now() }
  const env = gitEnv(await deps.env())

  /*
   * Which filters the repo defines, to empty them for the status. `git config`
   * reads config and runs nothing. Exit 1 with no output is "none found".
   */
  const cfg = await run(git, ['--no-optional-locks', '-C', found.root, 'config', '--null', '--show-scope', '--name-only', '--get-regexp', '^filter\\.'], {
    env,
    timeout: t.config,
    maxBuffer: 1024 * 1024
  })
  let overrides: string[] | null
  if (!cfg.error || (cfg.error.code === 1 && !cfg.error.killed && !cfg.stdout)) {
    overrides = filterOverrides(cfg.stdout)
  } else if (typeof cfg.error.code === 'number' && !cfg.error.killed) {
    /*
     * A git older than 2.26 has no `--show-scope`. List the names alone and
     * empty every filter, the user's own included: a wrong "changed" on an
     * LFS file is the price of running nothing from the repo.
     */
    const bare = await run(git, ['--no-optional-locks', '-C', found.root, 'config', '--null', '--name-only', '--get-regexp', '^filter\\.'], {
      env,
      timeout: t.config,
      maxBuffer: 1024 * 1024
    })
    overrides =
      !bare.error || (bare.error.code === 1 && !bare.stdout)
        ? filterOverrides(bare.stdout.split('\0').filter(Boolean).map((k) => `unknown\0${k}`).join('\0') + '\0')
        : null
  } else overrides = null
  if (overrides === null) return { ...base, error: 'the repository’s filter settings could not be read safely', at: now() }

  const st = await run(
    git,
    [
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      ...overrides,
      '-C',
      found.root,
      'status',
      '--porcelain=v2',
      '--branch',
      '--ignore-submodules=dirty'
    ],
    { env, timeout: t.status, maxBuffer: STATUS_MAX_BUFFER }
  )
  if (st.error) return { ...base, error: describeGitError(st), at: now() }

  const p = parseStatusV2(st.stdout)
  return {
    ...base,
    branch: p.detached ? null : (p.branch ?? base.branch),
    oid: p.oid ?? base.oid,
    detached: p.detached,
    unborn: p.unborn,
    upstream: p.upstream,
    upstreamGone: p.upstream !== null && p.ahead === null,
    ahead: p.ahead,
    behind: p.behind,
    changes: p.changes,
    error: null,
    at: now()
  }
}

/* ------------------------------------------------------------ finding git */

/**
 * The first `git` on `pathEnv`, or null. On macOS `/usr/bin/git` is a stub
 * until the Command Line Tools are installed, and running it opens Apple's
 * install dialog — on every poll. So that one path is taken only when
 * `xcode-select -p` answers (it prompts nothing); reasoned from how the stub
 * behaves, not reproduced (this Mac has the tools).
 */
export async function findGit(
  pathEnv: string,
  opts: { platform?: string; cltInstalled?: () => Promise<boolean> } = {}
): Promise<string | null> {
  const platform = opts.platform ?? process.platform
  const names = platform === 'win32' ? ['git.exe'] : ['git']
  for (const dir of pathEnv.split(platform === 'win32' ? ';' : delimiter)) {
    if (!dir) continue
    // Never a Store alias (gotcha 99's rule for every binary Stoke runs).
    if (platform === 'win32' && /\\WindowsApps\\?$/i.test(dir)) continue
    for (const name of names) {
      const file = join(dir, name)
      const ok = await access(file, platform === 'win32' ? constants.F_OK : constants.X_OK).then(
        () => true,
        () => false
      )
      if (!ok) continue
      if (platform === 'darwin' && file === '/usr/bin/git') {
        const clt = await (opts.cltInstalled ?? cltInstalled)().catch(() => false)
        if (!clt) continue
      }
      return file
    }
  }
  return null
}

async function cltInstalled(): Promise<boolean> {
  const r = await run('/usr/bin/xcode-select', ['-p'], { env: process.env, timeout: 2000, maxBuffer: 64 * 1024 })
  return !r.error && r.stdout.trim().length > 0
}

/* ------------------------------------------------- sharing runs between tabs */

/**
 * Readings by folder, deduplicated and briefly cached. `read` claims the
 * in-flight slot synchronously — before any await — so two tabs (or the
 * renderer's timer and a click) asking at once start one git, not two.
 */
export class GitStatusReader {
  private readonly deps: GitDeps
  private readonly cacheMs: number
  private readonly inflight = new Map<string, Promise<GitStatus>>()
  private readonly cache = new Map<string, GitStatus>()

  constructor(deps: GitDeps, cacheMs = 1500) {
    this.deps = deps
    this.cacheMs = cacheMs
  }

  read(path: string, fresh = false): Promise<GitStatus> {
    const now = (this.deps.now ?? Date.now)()
    const hit = this.cache.get(path)
    if (!fresh && hit && now - hit.at < this.cacheMs) return Promise.resolve(hit)
    const running = this.inflight.get(path)
    if (running) return running
    const job = readGitStatus(path, this.deps)
      .then((r) => {
        this.cache.delete(path)
        this.cache.set(path, r)
        while (this.cache.size > 64) this.cache.delete(this.cache.keys().next().value as string)
        return r
      })
      .finally(() => this.inflight.delete(path))
    this.inflight.set(path, job)
    return job
  }

  /** How many git runs are in flight right now (for the suite). */
  get running(): number {
    return this.inflight.size
  }
}
