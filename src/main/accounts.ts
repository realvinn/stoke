/*
 * The on-disk half of accounts (shared/accounts.ts): the folder each login
 * account signs in to, the links that keep one Claude Code tree, the index
 * the `stoke` command reads, and the name Claude Code gives its Keychain item.
 *
 * Where: `~/.stoke/accounts/<cli>-<slug>`. Not under userData — the dev and
 * packaged builds have different userData (gotcha 12), and the `stoke`
 * command, run from any shell with no app, has to find the same folders.
 *
 * What a Claude account's folder holds. Claude Code keeps EVERYTHING under its
 * config dir, so a bare second dir would be a second machine: its transcripts,
 * its session registry and its skills somewhere Stoke never reads. The dirs in
 * `CLAUDE_SHARED_DIRS` are therefore DIRECTORY links (junctions on Windows)
 * into the default tree, so every account's transcripts, `/resume` list,
 * registry files, skills, agents, commands and plugins stay one tree — the
 * context meter, `listSessions`, `RegistryPoller`, `resumeOrMint`, the
 * activity report and the worklog all read it unchanged, and a conversation
 * started on one account resumes on another. What stays per account is the
 * sign-in: `.claude.json` (the `oauthAccount`) and `.credentials.json` — never
 * linked, never created, never copied (gotcha 38) — plus history and caches.
 * FILES are never linked: a writer that saves by temp-file-and-rename replaces
 * the link with a file and the two copies silently diverge. `settings.json`
 * and `CLAUDE.md` are copied once instead, and are the account's own after.
 *
 * Codex: only `skills` is linked, and `config.toml` copied once. Its
 * `sessions` stay per account — they carry that account's rate limits.
 * Every other agent gets an empty real folder (Grok refuses a symlinked home).
 *
 * No electron import, so `scripts/verify-accounts.mts` runs every function here
 * against SYNTHETIC homes (gotcha 74): nothing here reads `homedir()` itself.
 */
import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { copyFile, lstat, mkdir, readFile, readlink, realpath, rename, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { accountIndexText, ACCOUNT_INDEX_NAME, type AgentAccount } from '../shared/accounts.ts'
import type { CodingCliId } from '../shared/codingClis.ts'
import { oauthSuffix } from './claudePaths.ts'

/* ------------------------------------------------------------- Keychain */

/**
 * The macOS Keychain service Claude Code keeps an account's OAuth token under,
 * `wN()` in the 2.1.285 bundle:
 *
 *   let n = env.CLAUDE_SECURESTORAGE_CONFIG_DIR,
 *       t = n !== undefined ? !n : !env.CLAUDE_CONFIG_DIR,
 *       r = n !== undefined ? n.normalize("NFC") : configDir(),   // NFC too
 *       c = t ? "" : `-${sha256(r).hex.substring(0, 8)}`
 *   return `Claude Code${OAUTH_FILE_SUFFIX}-credentials${c}`
 *
 * So the Default account (no variable) is the plain `Claude Code-credentials`,
 * and every account home gets its own item named after the EXACT string it was
 * handed — which is why a home is realpath'd once, when it is made, and that
 * one string is what every launch passes.
 */
export function claudeKeychainService(env: Record<string, string | undefined>): string {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR
  const plain = secure !== undefined ? !secure : !env.CLAUDE_CONFIG_DIR
  if (plain) return `Claude Code${oauthSuffix(env)}-credentials`
  const dir = (secure !== undefined ? secure : (env.CLAUDE_CONFIG_DIR as string)).normalize('NFC')
  const hash = createHash('sha256').update(dir).digest('hex').substring(0, 8)
  return `Claude Code${oauthSuffix(env)}-credentials-${hash}`
}

/* ----------------------------------------------------------------- where */

/** `~/.stoke/accounts`, for a given home. */
export function accountsRoot(userHome: string): string {
  return join(userHome, '.stoke', 'accounts')
}

/* ------------------------------------------------------------ link plan */

/** Claude Code dirs every account shares with the default tree, as directory links. */
export const CLAUDE_SHARED_DIRS = ['projects', 'sessions', 'skills', 'agents', 'commands', 'plugins', 'output-styles'] as const

/**
 * Made in the default tree when missing, so the link has somewhere to point:
 * these two ARE the one tree (transcripts; the registry), and an account that
 * got its own because the default had none yet would split it for good.
 */
export const CLAUDE_ENSURED_DIRS: readonly string[] = ['projects', 'sessions']

/** Copied once into a new Claude account, then its own. */
export const CLAUDE_COPIED_FILES = ['settings.json', 'CLAUDE.md'] as const

export const CODEX_SHARED_DIRS = ['skills'] as const
export const CODEX_COPIED_FILES = ['config.toml'] as const

/**
 * Never linked, copied or created in an account home: each is a sign-in or
 * the file that holds one (gotcha 38's `.claude.json` among them). The plan is
 * checked against this list before anything is written.
 */
export const NEVER_SHARED: readonly string[] = [
  '.claude.json',
  '.config.json',
  '.credentials.json',
  'auth.json',
  'oauth_creds.json',
  'credentials'
]

export interface AccountLink {
  /** The shared thing's name, e.g. `projects`. */
  name: string
  /** What it points at: the default tree's copy. Absolute. */
  target: string
  /** The link itself, inside the account home. */
  link: string
  /** Create `target` when it is missing, rather than skipping the link. */
  ensure: boolean
}

export interface AccountCopy {
  from: string
  to: string
}

export interface AccountHomePlan {
  home: string
  links: AccountLink[]
  copies: AccountCopy[]
}

/** The default trees an account's links point into. */
export interface DefaultTrees {
  /** Claude Code's config dir: `CLAUDE_CONFIG_DIR` as Stoke inherited it, else ~/.claude. */
  claude: string
  /** Codex's: `CODEX_HOME` as inherited, else ~/.codex. */
  codex: string
}

export function defaultTrees(env: Record<string, string | undefined>, userHome: string): DefaultTrees {
  return {
    claude: env.CLAUDE_CONFIG_DIR || join(userHome, '.claude'),
    codex: env.CODEX_HOME || join(userHome, '.codex')
  }
}

/** What making `home` for an account of `cli` would do. Pure. */
export function planAccountHome(cli: CodingCliId, home: string, trees: DefaultTrees): AccountHomePlan {
  const plan: AccountHomePlan = { home, links: [], copies: [] }
  if (cli === 'claude') {
    for (const name of CLAUDE_SHARED_DIRS) {
      plan.links.push({ name, target: join(trees.claude, name), link: join(home, name), ensure: CLAUDE_ENSURED_DIRS.includes(name) })
    }
    for (const name of CLAUDE_COPIED_FILES) plan.copies.push({ from: join(trees.claude, name), to: join(home, name) })
  } else if (cli === 'codex') {
    for (const name of CODEX_SHARED_DIRS) plan.links.push({ name, target: join(trees.codex, name), link: join(home, name), ensure: false })
    for (const name of CODEX_COPIED_FILES) plan.copies.push({ from: join(trees.codex, name), to: join(home, name) })
  }
  return plan
}

/** What `prepareAccountHome` did, per thing. */
export interface PrepareReport {
  linked: string[]
  /** Already the right link, from an earlier run. */
  kept: string[]
  /** Something else is there — a real folder the agent made, a foreign link. Left alone. */
  foreign: string[]
  /** No source to point at, and not one of the ensured dirs. */
  skipped: string[]
  copied: string[]
}

function samePath(a: string, b: string, platform: string): boolean {
  return platform === 'win32' || platform === 'darwin' ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Carry a plan out. Idempotent: run again on an existing home it links only
 * what is missing, and it never replaces, deletes or rewrites anything —
 * a real folder where a link would go is the agent's own and stays.
 */
export async function prepareAccountHome(plan: AccountHomePlan, platform: string = process.platform): Promise<PrepareReport> {
  for (const p of [...plan.links.map((l) => l.link), ...plan.copies.map((c) => c.to)]) {
    if (NEVER_SHARED.includes(basename(p))) throw new Error(`Refusing to share ${basename(p)}: it holds a sign-in.`)
    if (dirname(p) !== plan.home) throw new Error(`Refusing to write outside the account folder: ${p}`)
  }
  const report: PrepareReport = { linked: [], kept: [], foreign: [], skipped: [], copied: [] }
  await mkdir(plan.home, { recursive: true, mode: 0o700 })

  for (const l of plan.links) {
    const there = await lstat(l.link).catch(() => null)
    if (there) {
      if (there.isSymbolicLink()) {
        const cur = await readlink(l.link).catch(() => '')
        const at = resolve(dirname(l.link), cur)
        if (samePath(at.replace(/[\\/]+$/, ''), l.target.replace(/[\\/]+$/, ''), platform)) report.kept.push(l.name)
        else report.foreign.push(l.name)
      } else {
        report.foreign.push(l.name)
      }
      continue
    }
    const source = await stat(l.target).catch(() => null)
    if (source && !source.isDirectory()) {
      report.skipped.push(l.name)
      continue
    }
    if (!source) {
      if (!l.ensure) {
        report.skipped.push(l.name)
        continue
      }
      await mkdir(l.target, { recursive: true })
    }
    // A junction on Windows: a directory symlink there needs Developer Mode or
    // an elevated process, and a junction needs neither.
    await symlink(l.target, l.link, platform === 'win32' ? 'junction' : 'dir')
    report.linked.push(l.name)
  }

  for (const c of plan.copies) {
    const name = basename(c.to)
    if (await lstat(c.to).catch(() => null)) {
      report.kept.push(name)
      continue
    }
    const source = await stat(c.from).catch(() => null)
    if (!source?.isFile()) {
      report.skipped.push(name)
      continue
    }
    // EXCL: an account's own copy, once made, is never written over.
    await copyFile(c.from, c.to, fsConstants.COPYFILE_EXCL).catch(() => {})
    report.copied.push(name)
  }
  return report
}

/**
 * Make (or repair) an account's home under `root` and return its realpath —
 * the string every launch then hands the agent (gotcha 91; Claude's Keychain
 * item is named after it, and Grok refuses a home with a symlink in it).
 */
export async function makeAccountHome(opts: {
  root: string
  id: string
  cli: CodingCliId
  trees: DefaultTrees
  platform?: string
}): Promise<{ home: string; report: PrepareReport }> {
  await mkdir(opts.root, { recursive: true, mode: 0o700 })
  const realRoot = await realpath(opts.root)
  const plan = planAccountHome(opts.cli, join(realRoot, opts.id), opts.trees)
  const report = await prepareAccountHome(plan, opts.platform)
  return { home: await realpath(plan.home), report }
}

/**
 * Make sure an EXISTING account's home is still there and linked, before a
 * launch or a sign-in: the user may have deleted the folder, and a Claude
 * launch into an empty dir would quietly be a machine with no history.
 * Only ever the stored home — never a new path.
 */
export async function repairAccountHome(account: AgentAccount, trees: DefaultTrees, platform?: string): Promise<PrepareReport> {
  return prepareAccountHome(planAccountHome(account.cli, account.home, trees), platform)
}

/* ------------------------------------------------------------- the index */

/**
 * Write `<root>/index.json` for the `stoke` command: temp file and rename, so
 * a shell reading it mid-write sees the old one or the new one, never half.
 */
export async function writeAccountIndex(root: string, accounts: readonly AgentAccount[]): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const file = join(root, ACCOUNT_INDEX_NAME)
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, accountIndexText(accounts), { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
  return file
}

/* ----------------------------------------------------------------- label */

/**
 * The email a Claude login account is signed in as, read — never written —
 * from its own global config (`<home>/.claude.json`, or the `.config.json`
 * override the CLI prefers when present; claudePaths.ts). Null when it is not
 * signed in yet, or the file does not parse. `oauthAccount.emailAddress` is
 * the only field touched.
 */
export async function readClaudeAccountEmail(home: string, env: Record<string, string | undefined> = {}): Promise<string | null> {
  const candidates = [join(home, '.config.json'), join(home, `.claude${oauthSuffix(env)}.json`)]
  for (const file of candidates) {
    const raw = await readFile(file, 'utf8').catch(() => null)
    if (raw === null) continue
    try {
      const email = (JSON.parse(raw) as { oauthAccount?: { emailAddress?: unknown } } | null)?.oauthAccount?.emailAddress
      return typeof email === 'string' && email.includes('@') && email.length <= 200 ? email : null
    } catch {
      return null
    }
  }
  return null
}
