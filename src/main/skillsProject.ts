import { createHash, randomBytes } from 'node:crypto'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { claudeConfigDir } from './claudePaths.ts'
import { expandHome, scanClaudePluginSkills, scanSkillDir } from './skillsScan.ts'
import { CLAUDE_SHARED_PLUGIN, claudeProjection, SHARED_SKILLS_DIR } from '../shared/skills.ts'

/*
 * The shared skills folder, handed to Claude Code for one launch.
 *
 * `~/.agents/skills` is read by every agent Stoke runs except Claude Code, which
 * reads `~/.claude/skills` and its plugins and nothing else (2.1.285: the binary
 * names `~/.agents/skills` only inside `claude import`, which copies). So a
 * local Claude session is launched with `--plugin-dir <set>` — "Load a plugin
 * from a directory or .zip for this session only" — where `<set>` is a plugin
 * built here, under Stoke's own userData:
 *
 *   <userData>/agents/claude-skills/<key>/.claude-plugin/plugin.json   {"name":"stoke-shared",…}
 *   <userData>/agents/claude-skills/<key>/skills/<name> -> ~/.agents/skills/<name>
 *
 * Links, never copies, so an edit to a shared skill is the edit Claude reads;
 * a junction on Windows, which needs no privilege a symlink would. Nothing is
 * written into `~/.claude`, `~/.agents` or any other agent's folder, and the
 * plugin exists only for the processes Stoke passes it to (the owner's rule:
 * every override at launch, by flag or env).
 *
 * One folder per distinct SET, named after a hash of it, and never changed
 * once built. Per-project trims (`skillOverrides`) make the set differ between
 * folders, and a running session must not have its skills rewritten under it
 * by the next launch in another project — the CLI re-reads plugin folders on
 * `/reload-plugins`. So a launch whose set already exists reuses it ("rebuilt
 * only when the set changes"), and a set from a previous run is removed on the
 * first launch of this one. A set built this run is kept until the next run:
 * a session may still be holding it.
 *
 * Deletes only inside its own directory, only names it would have made (a
 * 16-hex set or a `.build-` leftover), and never recursively: each link is
 * `unlink`ed after `lstat` says it IS a link, then the emptied folders are
 * `rmdir`ed. A recursive delete through a link or a junction is how a cleanup
 * empties the folder it pointed at; this one cannot, and a stray file anyone
 * put inside a set simply leaves that set in place.
 */

const SET_NAME = /^[0-9a-f]{16}$/
const BUILD_NAME = /^\.build-[0-9a-f]{16}-[0-9a-f]{8}$/

/**
 * The manifest, constant: nothing in it depends on the set, so a set folder's
 * name alone says what it holds. `name` is what Claude namespaces the skills
 * with (`stoke-shared:pdf`).
 */
export const SHARED_PLUGIN_MANIFEST =
  JSON.stringify(
    {
      name: CLAUDE_SHARED_PLUGIN,
      version: '1.0.0',
      description:
        'Skills from ~/.agents/skills, which Claude Code does not read on its own. Loaded by Stoke for this session only; Stoke rebuilds this folder, so edit the skills where they live.',
      author: { name: 'Stoke' }
    },
    null,
    2
  ) + '\n'

/** Where Claude Code reads managed (policy) settings files, as the CLI resolves it. */
export function managedSettingsDir(platform: string): string {
  if (platform === 'darwin') return '/Library/Application Support/ClaudeCode'
  if (platform === 'win32') return 'C:\\Program Files\\ClaudeCode'
  return '/etc/claude-code'
}

export interface ProjectorOptions {
  /** `<userData>/agents/claude-skills`. Everything this module writes is inside it. */
  root: string
  home?: string
  /** Claude Code's config directory — `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeDir?: string
  platform?: string
  /** The managed-settings directory to honour, or null to read none (a suite). */
  managedDir?: string | null
  /** A launch never waits longer than this for its skills (gotcha 40). */
  deadlineMs?: number
  /**
   * The user the CLI checks a git root's ownership against before it reads
   * that root's `settings.local.json` — this process's euid by default, null
   * where there are no uids (Windows), which the CLI reads as "never move the
   * local layer off the cwd". See `localSettingsFiles`.
   */
  uid?: number | null
}

/** This process's effective uid, as the CLI asks for its own; null where Node has none (Windows). */
function processUid(): number | null {
  if (typeof process.geteuid === 'function') return process.geteuid()
  if (typeof process.getuid === 'function') return process.getuid()
  return null
}

/** A `.git` that counts, as the CLI's root walk tests it: a folder or a file, or a link to one. */
async function isGitEntry(path: string): Promise<boolean> {
  try {
    const l = await lstat(path)
    if (l.isDirectory() || l.isFile()) return true
    if (!l.isSymbolicLink()) return false
    const s = await stat(path)
    return s.isDirectory() || s.isFile()
  } catch {
    return false
  }
}

/** The nearest folder at or above `start` holding a `.git`, or null. `start` is already real. */
async function gitRootOf(start: string): Promise<string | null> {
  let dir = resolve(start)
  for (;;) {
    if (await isGitEntry(join(dir, '.git'))) return dir
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

async function realOr(path: string): Promise<string> {
  return realpath(path).catch(() => resolve(path))
}

async function isRegularFile(path: string): Promise<boolean> {
  return (await lstat(path).catch(() => null))?.isFile() === true
}

/**
 * The repository a git root belongs to, as the CLI canonicalises it: a linked
 * worktree (`.git` is a FILE, `gitdir: <main>/.git/worktrees/<name>`) resolves
 * to the MAIN worktree's root, when git's own back-pointers agree; anything
 * else — a plain repo, a submodule, a layout that does not check out — is the
 * root itself. A worktree of a bare repo answers the bare folder, which the
 * ownership check then refuses (it has no `.git`), as the CLI's does.
 */
async function canonicalRootOf(root: string): Promise<string> {
  try {
    const text = (await readFile(join(root, '.git'), 'utf8')).trim()
    if (!text.startsWith('gitdir:')) return root
    const gitDir = resolve(root, text.slice(7).trim())
    if (!(await isRegularFile(join(gitDir, 'commondir')))) return root
    const common = resolve(gitDir, (await readFile(join(gitDir, 'commondir'), 'utf8')).trim())
    if (dirname(gitDir) !== join(common, 'worktrees')) return root
    if (!(await isRegularFile(join(gitDir, 'gitdir')))) return root
    const back = resolve(gitDir, (await readFile(join(gitDir, 'gitdir'), 'utf8')).trim())
    if ((await realOr(back)) !== join(await realOr(root), '.git')) return root
    if (basename(common) !== '.git') return (await isGitEntry(join(common, '.git'))) ? root : common
    return dirname(common)
  } catch {
    return root
  }
}

/**
 * Does the user own the root, its `.git` and its `.claude` (when present)? The
 * CLI will not read a local-settings file out of a folder someone else
 * controls; any failure to tell is a no.
 */
async function ownedBy(root: string, uid: number): Promise<boolean> {
  try {
    const rootUid = (await stat(root)).uid
    const gitUid = (await lstat(join(root, '.git'))).uid
    let claudeUid: number | null = null
    try {
      claudeUid = (await lstat(join(root, '.claude'))).uid
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    return rootUid === uid && gitUid === uid && (claudeUid === null || claudeUid === uid)
  } catch {
    return false
  }
}

/**
 * The `settings.local.json` files Claude Code merges for a session in `cwd`,
 * lowest first. NOT simply `<cwd>/.claude/settings.local.json` (2.1.285,
 * gotcha 117): the CLI reads the local layer from the cwd's CANONICAL git root
 * — the repo's top, and for a linked worktree the MAIN worktree's top — and
 * merges the cwd's own copy underneath it as a legacy layer. It stays at the
 * cwd alone when there is no repo, the root IS the cwd, the root is `$HOME`,
 * or the root, its `.git` or its `.claude` is not the user's; and always where
 * there are no uids ("canonicalization is POSIX-only").
 *
 * So a tab started in a repo's subfolder, or in a worktree under
 * `.claude/worktrees/`, has the owner's per-project trims from the repo's top,
 * and missing them here would lend every skill they turn off.
 */
export async function localSettingsFiles(cwd: string, home: string, uid: number | null): Promise<string[]> {
  const real = await realOr(cwd)
  const own = join(real, '.claude', 'settings.local.json')
  if (uid === null) return [own]
  const found = await gitRootOf(real)
  if (!found) return [own]
  const root = await realOr(await canonicalRootOf(found))
  if (root === real) return [own]
  const realHome = await realpath(home).catch(() => null)
  if (realHome === null || root === realHome) return [own]
  if (!(await ownedBy(root, uid))) return [own]
  return [own, join(root, '.claude', 'settings.local.json')]
}

/**
 * The merged `skillOverrides` Claude would read in `cwd`, in the CLI's order:
 * user < project (`<cwd>/.claude/settings.json`) < local (`localSettingsFiles`,
 * the cwd's legacy copy under the repo root's). Each file is read under a
 * deadline (gotcha 40), and the whole prepare is under another.
 */
export async function skillOverridesFor(
  cwd: string,
  opts: { claudeDir: string; home: string; uid: number | null }
): Promise<Record<string, unknown>> {
  const locals = await localSettingsFiles(cwd, opts.home, opts.uid)
  const layers = await Promise.all(
    [join(opts.claudeDir, 'settings.json'), join(cwd, '.claude', 'settings.json'), ...locals].map((f) =>
      readJsonUnder(f, 1500)
    )
  )
  const merged: Record<string, unknown> = {}
  for (const l of layers) {
    const o = l?.skillOverrides
    if (o && typeof o === 'object' && !Array.isArray(o)) Object.assign(merged, o)
  }
  return merged
}

async function readJsonUnder(path: string, deadlineMs: number): Promise<Record<string, unknown> | null> {
  const read = readFile(path, 'utf8').then(
    (raw) => {
      try {
        const v: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
        return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
      } catch {
        return null
      }
    },
    () => null
  )
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs)
  })
  const v = await Promise.race([read, late])
  clearTimeout(timer)
  return v
}

/** A link's target, comparable: junctions can read back with the `\\?\` prefix. */
function linkKey(target: string, platform: string): string {
  const t = target.replace(/^\\\\\?\\/, '')
  return platform === 'win32' ? t.toLowerCase() : t
}

export class ClaudeSkillsProjector {
  private readonly root: string
  private readonly home: string
  private readonly claudeDir: string
  private readonly platform: string
  private readonly managedDir: string | null
  private readonly deadlineMs: number
  private readonly uid: number | null
  /** Serialises every prepare: the claim, taken before any await (gotcha 20). */
  private queue: Promise<unknown> = Promise.resolve()
  /** Sets handed to a session this run. Never removed until the next run. */
  private readonly inUse = new Set<string>()

  constructor(opts: ProjectorOptions) {
    this.root = opts.root
    this.home = opts.home ?? homedir()
    this.claudeDir = opts.claudeDir ?? claudeConfigDir(process.env, this.home)
    this.platform = opts.platform ?? process.platform
    this.managedDir = opts.managedDir === undefined ? managedSettingsDir(this.platform) : opts.managedDir
    this.deadlineMs = opts.deadlineMs ?? 3000
    this.uid = opts.uid === undefined ? processUid() : opts.uid
  }

  /**
   * The `--plugin-dir` for a Claude Code launch in `cwd`, or null when there
   * is nothing to share, a policy forbids the flag, or anything failed or ran
   * late. Never throws: a launch without shared skills is a launch, and one
   * refused over them is not.
   *
   * Chained onto the queue synchronously, before the first await, so two
   * launches at once (a restore opening several tabs) cannot both build, or
   * one prune what the other is building.
   */
  prepare(cwd: string): Promise<string | null> {
    const run = this.queue.then(() => this.prepareNow(cwd))
    this.queue = run.catch(() => null)
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.deadlineMs)
    })
    return Promise.race([run.catch(() => null), late]).finally(() => clearTimeout(timer))
  }

  private overridesFor(cwd: string): Promise<Record<string, unknown>> {
    return skillOverridesFor(cwd, { claudeDir: this.claudeDir, home: this.home, uid: this.uid })
  }

  /**
   * `disableSideloadFlags` in a managed-settings file makes the CLI refuse
   * `--plugin-dir` AT STARTUP ("This machine's managed settings
   * (disableSideloadFlags) refused the launch", 2.1.285; gotcha 117) — a
   * session that never starts, gotcha 19's shape. Only the files are readable from here; an
   * MDM-delivered or server-managed policy is not, and the setting is the way
   * out on such a machine.
   */
  private async sideloadForbidden(): Promise<boolean> {
    if (!this.managedDir) return false
    const dropIn = join(this.managedDir, 'managed-settings.d')
    const extra = await readdir(dropIn).then(
      (names) => names.filter((n) => n.endsWith('.json')).map((n) => join(dropIn, n)),
      () => [] as string[]
    )
    const files = await Promise.all(
      [join(this.managedDir, 'managed-settings.json'), ...extra].map((f) => readJsonUnder(f, 1000))
    )
    return files.some((f) => f?.disableSideloadFlags === true)
  }

  private async prepareNow(cwd: string): Promise<string | null> {
    if (await this.sideloadForbidden()) return null
    const sharedAbs = expandHome(SHARED_SKILLS_DIR, this.home)
    const [shared, claude, plugins, overrides] = await Promise.all([
      scanSkillDir(SHARED_SKILLS_DIR, sharedAbs),
      scanSkillDir('~/.claude/skills', join(this.claudeDir, 'skills')),
      scanClaudePluginSkills(this.claudeDir),
      this.overridesFor(cwd)
    ])
    const set = claudeProjection([shared, claude, plugins], overrides).map((k) => ({
      name: k.name,
      target: join(sharedAbs, k.name)
    }))
    await mkdir(this.root, { recursive: true })
    if (set.length === 0) {
      await this.prune()
      return null
    }
    const key = createHash('sha256')
      .update(JSON.stringify([SHARED_PLUGIN_MANIFEST, set.map((k) => [k.name, k.target])]))
      .digest('hex')
      .slice(0, 16)
    const dir = join(this.root, key)
    if (!(await this.holds(dir, set))) {
      await removeOwnedSet(dir)
      await this.build(key, dir, set)
    }
    this.inUse.add(key)
    await this.prune()
    return dir
  }

  /** Is `dir` exactly this set: the manifest, and these links and nothing else? */
  private async holds(dir: string, set: { name: string; target: string }[]): Promise<boolean> {
    try {
      if ((await readFile(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) !== SHARED_PLUGIN_MANIFEST) return false
      const names = (await readdir(join(dir, 'skills'))).sort()
      if (JSON.stringify(names) !== JSON.stringify(set.map((k) => k.name).sort())) return false
      for (const k of set) {
        const got = await readlink(join(dir, 'skills', k.name))
        if (linkKey(got, this.platform) !== linkKey(k.target, this.platform)) return false
      }
      return true
    } catch {
      return false
    }
  }

  /** Build beside, then rename into place, so a half-built set is never a set. */
  private async build(key: string, dir: string, set: { name: string; target: string }[]): Promise<void> {
    const tmp = join(this.root, `.build-${key}-${randomBytes(4).toString('hex')}`)
    try {
      await mkdir(join(tmp, '.claude-plugin'), { recursive: true })
      await writeFile(join(tmp, '.claude-plugin', 'plugin.json'), SHARED_PLUGIN_MANIFEST, 'utf8')
      await mkdir(join(tmp, 'skills'))
      for (const k of set) {
        await symlink(k.target, join(tmp, 'skills', k.name), this.platform === 'win32' ? 'junction' : 'dir')
      }
      await rename(tmp, dir)
    } catch (err) {
      await removeOwnedSet(tmp)
      throw err
    }
  }

  /** Remove every set of an earlier run, and any half-built leftover. */
  private async prune(): Promise<void> {
    let names: string[]
    try {
      names = await readdir(this.root)
    } catch {
      return
    }
    for (const n of names) {
      if ((SET_NAME.test(n) && !this.inUse.has(n)) || BUILD_NAME.test(n)) await removeOwnedSet(join(this.root, n))
    }
  }
}

/**
 * Take a set folder apart without ever following a link: unlink what `lstat`
 * says is a link, unlink the manifest if it is a plain file, then `rmdir` the
 * folders, which fails — and leaves them — if anything else is inside.
 */
export async function removeOwnedSet(dir: string): Promise<void> {
  const skills = join(dir, 'skills')
  for (const name of await readdir(skills).catch(() => [] as string[])) {
    const p = join(skills, name)
    if ((await lstat(p).catch(() => null))?.isSymbolicLink()) await unlink(p).catch(() => {})
  }
  await rmdir(skills).catch(() => {})
  const manifest = join(dir, '.claude-plugin', 'plugin.json')
  if ((await lstat(manifest).catch(() => null))?.isFile()) await unlink(manifest).catch(() => {})
  await rmdir(join(dir, '.claude-plugin')).catch(() => {})
  await rmdir(dir).catch(() => {})
}
