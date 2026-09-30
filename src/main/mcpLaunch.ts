import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { claudeConfigDir } from './claudePaths.ts'
import { canonicalRootOf, gitRootOf, localSettingsFiles, readJsonUnder, realOr } from './skillsProject.ts'
import {
  accountMcpMirror,
  claudeMcpServers,
  codexConfiguredServers,
  NO_ACCOUNT_MIRROR,
  type AccountMcpMirror,
  foldApprovals,
  isTrustedFolder,
  jsonConfiguredServers,
  mcpCatalog,
  MCP_FILE_NAME,
  mcpTicksFor,
  mergeMcpJsons,
  NO_APPROVALS,
  serversForLaunch,
  STOKE_BROWSER_SERVER,
  vibeConfiguredServers,
  type AgentMcpSettings,
  type McpCatalog,
  type McpServerSpec,
  type PlanFile,
  type ProjectMcpRead
} from '../shared/mcpServers.ts'
import { isClaudeCode, type CodingCliId } from '../shared/codingClis.ts'

/*
 * The main-process half of mcpServers.ts: read Claude Code's own MCP list for
 * one launch, read which names each agent's own config already defines
 * (`ownMcpSources`), and write the owner-only files the file-taking agents are
 * pointed at.
 *
 * Everything here READS the agents' config — `~/.claude.json` (never through
 * claudeGlobalConfig.ts's sync reader, gotcha 40; never written, gotcha 38),
 * the folder's `.mcp.json` and settings layers, each agent's own files — and
 * writes only inside `<userData>/agents/mcp/`. Every read is async and under a
 * deadline: a launch never waits on a slow disk past it, and a miss reads as
 * "nothing there", which hands the agent fewer servers, never a wrong one.
 */

const READ_DEADLINE_MS = 1500

/** A text file under a deadline, or null. */
async function readTextUnder(path: string, deadlineMs = READ_DEADLINE_MS): Promise<string | null> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deadlineMs)
  })
  const v = await Promise.race([readFile(path, 'utf8').catch(() => null), late])
  clearTimeout(timer)
  return v
}

/**
 * `~/.claude.json` as the CLI resolves it (`claudeGlobalConfigPath`, done
 * async here): `<config dir>/.config.json` wins outright when it exists.
 */
async function globalConfigPath(env: NodeJS.ProcessEnv, home: string): Promise<string> {
  const override = join(claudeConfigDir(env, home), '.config.json')
  if (await stat(override).then(() => true, () => false)) return override
  const url = env.CLAUDE_CODE_CUSTOM_OAUTH_URL
  const suffix = !url
    ? ''
    : url.includes('localhost') || url.includes('127.0.0.1')
      ? '-local-oauth'
      : url.includes('staging')
        ? '-staging-oauth'
        : '-custom-oauth'
  return join(env.CLAUDE_CONFIG_DIR || home, `.claude${suffix}.json`)
}

/**
 * Only the MCP keys of a parsed `~/.claude.json` — the rest (history, tips,
 * caches) is not kept. Every project KEY is kept, even with none of those
 * keys: Settings scans each known folder's `.mcp.json` (`projectMcpReads`),
 * and a folder must not vanish from that just because its entry is bare.
 */
function mcpPart(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const projects: Record<string, unknown> = {}
  if (r.projects && typeof r.projects === 'object' && !Array.isArray(r.projects)) {
    for (const [folder, p] of Object.entries(r.projects as Record<string, unknown>)) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      const pr = p as Record<string, unknown>
      const keep: Record<string, unknown> = {}
      for (const k of [
        'mcpServers',
        'disabledMcpServers',
        'enabledMcpjsonServers',
        'disabledMcpjsonServers',
        'enableAllProjectMcpServers',
        'hasTrustDialogAccepted'
      ]) {
        if (pr[k] !== undefined) keep[k] = pr[k]
      }
      projects[folder] = keep
    }
  }
  return { mcpServers: r.mcpServers, projects }
}

export interface ClaudeConfigRead {
  json: Record<string, unknown> | null
  error: string | null
}

/**
 * Reads of `~/.claude.json`, cached on path, mtime and size — the CLI rewrites
 * it constantly, so the cache is a stat per launch and a parse only when it
 * moved. Read-only, in every sense: nothing here opens it for writing.
 */
export class ClaudeConfigReader {
  private cache: { path: string; mtimeMs: number; size: number; read: ClaudeConfigRead } | null = null
  private readonly env: NodeJS.ProcessEnv
  private readonly home: string

  constructor(env: NodeJS.ProcessEnv = process.env, home: string = homedir()) {
    this.env = env
    this.home = home
  }

  async read(): Promise<ClaudeConfigRead> {
    const path = await globalConfigPath(this.env, this.home)
    const st = await stat(path).catch(() => null)
    if (!st) return { json: null, error: null }
    const c = this.cache
    if (c && c.path === path && c.mtimeMs === st.mtimeMs && c.size === st.size) return c.read
    const text = await readTextUnder(path)
    let read: ClaudeConfigRead
    if (text === null) read = { json: null, error: `Could not read ${path} in time.` }
    else {
      try {
        read = { json: mcpPart(JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)), error: null }
      } catch {
        read = { json: null, error: `${path} is not valid JSON right now.` }
      }
    }
    // A failed read is not cached: the next launch tries again.
    if (!read.error) this.cache = { path, mtimeMs: st.mtimeMs, size: st.size, read }
    return read
  }
}

/** Codex's config.toml — `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. */
export function codexConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.CODEX_HOME || join(home, '.codex'), 'config.toml')
}

/** Kimi's own MCP file — `$KIMI_SHARE_DIR/mcp.json`, else `~/.kimi/mcp.json` (kimi-cli `get_share_dir`). */
export function kimiMcpPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.KIMI_SHARE_DIR || join(home, '.kimi'), 'mcp.json')
}

/** Mistral Vibe's user config — `$VIBE_HOME/config.toml`, else `~/.vibe/config.toml`. */
export function vibeConfigPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(env.VIBE_HOME || join(home, '.vibe'), 'config.toml')
}

export interface AgentOwnMcp {
  /** Server names the agent's own config defines: Stoke never replaces or merges into one. */
  own: string[]
  /** The agent's own MCP files to name beside Stoke's (`LaunchPlanInput.mcpKeep`). */
  keep: string[]
}

/** The launch folder, for the agents' folder-level config: its realpath and its nearest git top. */
export interface OwnFolder {
  real: string
  /** The nearest folder holding a `.git` (a linked worktree's own top), or null outside a repo. */
  gitRoot: string | null
}

/** One file an agent reads servers from, and how to read its names. */
export interface OwnMcpSource {
  path: string
  format: 'codex-toml' | 'vibe-toml' | 'mcpServers' | 'mcp'
  /** Of the sources carrying this flag, only the first that exists counts (Vibe's nearest project file). */
  nearestOnly?: true
}

/** The folders from `dir` up to `stop` (inclusive), nearest first; to the top when `stop` is null. */
export function foldersUpTo(dir: string, stop: string | null): string[] {
  const out: string[] = []
  let d = resolve(dir)
  for (;;) {
    out.push(d)
    const up = dirname(d)
    if (d === stop || up === d) break
    d = up
  }
  return out
}

/** `~/…` and relative, as Qwen's `Storage.resolvePath` takes `QWEN_HOME`. */
function homePath(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') || p.startsWith('~\\') ? join(home, p.slice(2)) : resolve(p)
}

/**
 * Every file an agent reads MCP servers from that a launch-time server of the
 * same name would replace or merge into — its user config, and with `folder`
 * the launch folder's own layers too. Read out of each vendor's package on
 * 2026-09-30 (read, never run):
 *
 *   codex    `$CODEX_HOME/config.toml`; and `.codex/config.toml` in each folder
 *            from the repo's top (`project_root_markers = [".git"]`) down to the
 *            cwd — 0.153.1's strings: "Failed to read project config file",
 *            "Overridden by project config". `-c` merges into either.
 *   opencode `$XDG_CONFIG_HOME/opencode/{config,opencode}.json` +
 *            `opencode.jsonc` (else `~/.config`), `OPENCODE_CONFIG`,
 *            `OPENCODE_CONFIG_DIR`, `~/.opencode/`, and `opencode.json(c)` plus
 *            `.opencode/opencode.json(c)` in every folder from the cwd up to the
 *            worktree's top (the filesystem's, outside a repo). 1.18.31
 *            (Homebrew) `Config.loadInstanceState`: each layer is folded in with
 *            remeda's `mergeDeep`, `OPENCODE_CONFIG_CONTENT` last but for managed
 *            config — so a same-named `mcp.<n>` was MERGED into the user's.
 *   kilo     the same shape under `kilo/` (`config.json`, `kilo.json(c)`,
 *            `opencode.json(c)`), `KILO_CONFIG`, `KILO_CONFIG_DIR`, `~/.kilo/`,
 *            `~/.kilocode/`, and per folder `kilo.json(c)`, `opencode.json(c)`,
 *            `.kilo/` and `.kilocode/` (`ALL_CONFIG_FILES`). @kilocode/cli
 *            7.8.1; `KILO_CONFIG_CONTENT` is layered last the same way.
 *   qwen     `$QWEN_HOME/settings.json` (else `~/.qwen`), the system
 *            settings and system-defaults, and the cwd's `.qwen/settings.json`
 *            and `.mcp.json`. @qwen-code/qwen-code 0.24.7 `assembleMcpServers`:
 *            `{...user, ...project .mcp.json, ...workspace/system,
 *            ...cliMcpServers}` — `--mcp-config` REPLACES a same-named server.
 *   copilot  `$COPILOT_HOME/mcp-config.json` (else `~/.copilot`), and the
 *            workspace `.mcp.json` / `.github/mcp.json` at the cwd and the repo's
 *            top. @github/copilot 1.0.89's help: `--additional-mcp-config`
 *            "augments config from ~/.copilot/mcp-config.json"; the merge itself
 *            is native code, not readable, so a same name is skipped either way.
 *   vibe     `$VIBE_HOME/config.toml`, and the NEAREST `.vibe/config.toml`
 *            from the cwd up to (not including) `$VIBE_HOME`'s parent
 *            (mistral-vibe 2.25.8 `ProjectConfigLayer`), which
 *            `VIBE_MCP_SERVERS`' environment layer sits above.
 *
 * Kimi reads only its `mcp.json` (`agentOwnMcp` keeps it), Pi's own
 * `mcp.json` outranks a registered server, and Claude Code's own list is read
 * by `resolveLaunchMcp` — none of those is here. A path missed here means the
 * session's copy wins over the user's; a false hit only skips a server.
 */
export function ownMcpSources(
  cliId: CodingCliId,
  env: NodeJS.ProcessEnv,
  home: string,
  folder: OwnFolder | null,
  platform: string = process.platform
): OwnMcpSource[] {
  const xdg = env.XDG_CONFIG_HOME || join(home, '.config')
  const files = (dir: string, names: readonly string[], format: OwnMcpSource['format']): OwnMcpSource[] =>
    names.map((n) => ({ path: join(dir, n), format }))
  const up = folder ? foldersUpTo(folder.real, folder.gitRoot) : []
  switch (cliId) {
    case 'codex': {
      const out: OwnMcpSource[] = [{ path: codexConfigPath(env, home), format: 'codex-toml' }]
      if (folder) {
        for (const d of folder.gitRoot ? up : [folder.real]) out.push({ path: join(d, '.codex', 'config.toml'), format: 'codex-toml' })
      }
      return out
    }
    case 'opencode': {
      const pair = ['opencode.json', 'opencode.jsonc']
      const out = files(join(xdg, 'opencode'), ['config.json', ...pair], 'mcp')
      if (env.OPENCODE_CONFIG) out.push({ path: env.OPENCODE_CONFIG, format: 'mcp' })
      if (env.OPENCODE_CONFIG_DIR) out.push(...files(env.OPENCODE_CONFIG_DIR, pair, 'mcp'))
      out.push(...files(join(home, '.opencode'), pair, 'mcp'))
      for (const d of up) out.push(...files(d, pair, 'mcp'), ...files(join(d, '.opencode'), pair, 'mcp'))
      return out
    }
    case 'kilo': {
      const all = ['kilo.jsonc', 'kilo.json', 'opencode.jsonc', 'opencode.json']
      const out = files(join(xdg, 'kilo'), ['config.json', 'kilo.json', 'kilo.jsonc', 'opencode.json', 'opencode.jsonc'], 'mcp')
      if (env.KILO_CONFIG) out.push({ path: env.KILO_CONFIG, format: 'mcp' })
      if (env.KILO_CONFIG_DIR) out.push(...files(env.KILO_CONFIG_DIR, all, 'mcp'))
      out.push(...files(join(home, '.kilo'), all, 'mcp'), ...files(join(home, '.kilocode'), all, 'mcp'))
      for (const d of up) {
        out.push(...files(d, all, 'mcp'), ...files(join(d, '.kilo'), all, 'mcp'), ...files(join(d, '.kilocode'), all, 'mcp'))
      }
      return out
    }
    case 'qwen': {
      const system =
        env.QWEN_CODE_SYSTEM_SETTINGS_PATH ||
        (platform === 'darwin'
          ? '/Library/Application Support/QwenCode/settings.json'
          : platform === 'win32'
            ? 'C:\\ProgramData\\qwen-code\\settings.json'
            : '/etc/qwen-code/settings.json')
      const defaults = env.QWEN_CODE_SYSTEM_DEFAULTS_PATH || join(dirname(system), 'system-defaults.json')
      const user = join(env.QWEN_HOME ? homePath(env.QWEN_HOME, home) : join(home, '.qwen'), 'settings.json')
      const out: OwnMcpSource[] = [user, system, defaults].map((path) => ({ path, format: 'mcpServers' }))
      if (folder) out.push(...[join(folder.real, '.qwen', 'settings.json'), join(folder.real, '.mcp.json')].map((path) => ({ path, format: 'mcpServers' as const })))
      return out
    }
    case 'copilot': {
      const out: OwnMcpSource[] = [{ path: join(env.COPILOT_HOME || join(home, '.copilot'), 'mcp-config.json'), format: 'mcpServers' }]
      const roots = folder ? [...new Set([folder.real, ...(folder.gitRoot ? [folder.gitRoot] : [])])] : []
      for (const d of roots) out.push(...[join(d, '.mcp.json'), join(d, '.github', 'mcp.json')].map((path) => ({ path, format: 'mcpServers' as const })))
      return out
    }
    case 'vibe': {
      const out: OwnMcpSource[] = [{ path: vibeConfigPath(env, home), format: 'vibe-toml' }]
      if (folder) {
        const stop = dirname(resolve(env.VIBE_HOME || join(home, '.vibe')))
        for (const d of foldersUpTo(folder.real, null)) {
          if (d === stop) break
          out.push({ path: join(d, '.vibe', 'config.toml'), format: 'vibe-toml', nearestOnly: true })
        }
      }
      return out
    }
    default:
      return []
  }
}

function namesIn(format: OwnMcpSource['format'], text: string): string[] {
  if (format === 'codex-toml') return codexConfiguredServers(text)
  if (format === 'vibe-toml') return vibeConfiguredServers(text)
  return jsonConfiguredServers(text, format)
}

/**
 * What the agent's OWN MCP config says, read-only (`ownMcpSources`), every
 * file at once under the deadline. Kimi's file is kept whenever it EXISTS,
 * even if it could not be read in time: dropping the user's own servers for a
 * session is the direction never to fail in.
 */
export async function agentOwnMcp(
  cliId: CodingCliId,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  folder: OwnFolder | null = null
): Promise<AgentOwnMcp> {
  if (cliId === 'kimi') {
    const path = kimiMcpPath(env, home)
    const exists = await stat(path).then((st) => st.isFile(), () => false)
    if (!exists) return { own: [], keep: [] }
    const text = await readTextUnder(path)
    return { own: text === null ? [] : jsonConfiguredServers(text), keep: [path] }
  }
  const sources = ownMcpSources(cliId, env, home, folder)
  if (!sources.length) return { own: [], keep: [] }
  const texts = await Promise.all(sources.map((s) => readTextUnder(s.path)))
  const own = new Set<string>()
  let nearestSeen = false
  sources.forEach((s, i) => {
    const text = texts[i]
    if (text === null) return
    if (s.nearestOnly) {
      if (nearestSeen) return
      nearestSeen = true
    }
    for (const n of namesIn(s.format, text)) own.add(n)
  })
  return { own: [...own], keep: [] }
}

/** A key the way the CLI writes it into `projects`: forward slashes on Windows (its `_9`). */
function asProjectKey(path: string, platform: string): string {
  return platform === 'win32' ? path.replaceAll('\\', '/') : path
}

/**
 * The folders from the filesystem's top down to `dir`, outermost first, the
 * top itself excluded — the chain the CLI reads `.mcp.json` along.
 */
export function foldersDownTo(dir: string): string[] {
  const out: string[] = []
  let d = resolve(dir)
  for (;;) {
    const up = dirname(d)
    if (up === d) break
    out.push(d)
    d = up
  }
  return out.reverse()
}

/**
 * Where Claude Code files a folder in `~/.claude.json`'s `projects`, and the
 * folder it walks `.mcp.json` from (gotcha 129): 2.1.285 keys a project by the
 * cwd's CANONICAL git root — the repo's top, and for a linked worktree the
 * MAIN worktree's top (`canonicalRootOf`, the same resolution gotcha 117's
 * local layer uses) — else by the cwd itself. Read out of the binary
 * (`xRe`/`ms`) on 2026-09-30, and it matches the owner's real file: seven live
 * worktrees under one repo, and not one of them has a key of its own.
 *
 * Under a deadline (gotcha 40): a folder on a sleeping disk answers its own
 * path, which misses its local servers for that launch rather than stalling it.
 */
export async function claudeProjectKey(
  cwd: string,
  platform: string = process.platform
): Promise<{ key: string; real: string; gitRoot: string | null }> {
  const fallback = { key: asProjectKey(resolve(cwd), platform), real: resolve(cwd), gitRoot: null }
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<typeof fallback>((done) => {
    timer = setTimeout(() => done(fallback), READ_DEADLINE_MS)
  })
  const work = (async () => {
    const real = await realOr(cwd)
    const found = await gitRootOf(real)
    const key = found ? await realOr(await canonicalRootOf(found)) : real
    return { key: asProjectKey(key, platform), real, gitRoot: found }
  })().catch(() => fallback)
  const out = await Promise.race([work, late])
  clearTimeout(timer)
  return out
}

/**
 * The `projects` keys whose `hasTrustDialogAccepted` makes Claude Code trust a
 * session in `real` (2.1.285's `x5n` → `GS` → `WS`, read 2026-09-30): the
 * project key itself, then the cwd and each folder above it — but inside a
 * repository only up to that repository's own top (the non-canonical git
 * root), never past it. Outside a repository the walk goes to the top. So a
 * trusted `~` trusts a loose folder under it and never a repo cloned there.
 */
export function trustKeys(key: string, real: string, gitRoot: string | null, platform: string = process.platform): string[] {
  const chain = foldersDownTo(real)
  const bounded = gitRoot ? chain.filter((d) => d === gitRoot || d.startsWith(gitRoot.endsWith(sep) ? gitRoot : gitRoot + sep)) : chain
  return [key, ...bounded.map((d) => asProjectKey(d, platform))]
}

/**
 * The folder's `.mcp.json` servers, merged along the chain the CLI reads
 * (`mergeMcpJsons`): every folder from the top down to the cwd, nearest wins.
 * Each file under the deadline, all at once.
 */
async function mcpJsonChain(real: string): Promise<{ mcpServers: Record<string, unknown> }> {
  const files = await Promise.all(foldersDownTo(real).map((d) => readJsonUnder(join(d, '.mcp.json'), READ_DEADLINE_MS)))
  return mergeMcpJsons(files)
}

/**
 * Which of the folder's `.mcp.json` servers Claude Code may run here: the
 * `enableAllProjectMcpServers` / `enabledMcpjsonServers` /
 * `disabledMcpjsonServers` keys across its settings layers, user < project <
 * local (the local layer where the CLI reads it, `localSettingsFiles`).
 * `~/.claude.json`'s own `projects[key]` copy is folded in by
 * `claudeMcpServers`.
 *
 * The project and local layers sit INSIDE the folder, where a cloned repo can
 * commit them, and the CLI takes their approvals only once the folder is
 * trusted (its `uZe` skips the project layer otherwise, and a git-tracked local
 * one always). So untrusted, only the user's own layer counts: a repo cannot
 * approve its own `.mcp.json` server into an agent under a name the user ticked.
 */
async function mcpJsonApprovals(cwd: string, env: NodeJS.ProcessEnv, home: string, trusted: boolean) {
  const uid = typeof process.geteuid === 'function' ? process.geteuid() : null
  const user = join(claudeConfigDir(env, home), 'settings.json')
  const inFolder = trusted ? [join(cwd, '.claude', 'settings.json'), ...(await localSettingsFiles(cwd, home, uid))] : []
  const layers = await Promise.all([user, ...inFolder].map((f) => readJsonUnder(f, READ_DEADLINE_MS)))
  return layers.reduce(foldApprovals, NO_APPROVALS)
}

export interface LaunchMcp extends AgentOwnMcp {
  /** What this launch hands its agent (`serversForLaunch`). */
  servers: McpServerSpec[]
}

/**
 * One launch's MCP set. The fast path reads nothing: an agent on the default
 * ticks (only Stoke's browser) never waits on `~/.claude.json`. Claude Code
 * reads its own list only to know which names a Stoke-held server must not
 * shadow, and only when one is ticked for it.
 */
export async function resolveLaunchMcp(input: {
  cliId: CodingCliId
  cwd: string
  mcp: AgentMcpSettings
  browser: McpServerSpec | null
  reader: ClaudeConfigReader
  env?: NodeJS.ProcessEnv
  home?: string
}): Promise<LaunchMcp> {
  const env = input.env ?? process.env
  const home = input.home ?? homedir()
  const ticks = mcpTicksFor(input.mcp, input.cliId)
  const others = ticks.filter((n) => n !== STOKE_BROWSER_SERVER)
  const extra = input.mcp.extra
  // The folder, resolved once and only when something needs it.
  let where: Promise<{ key: string; real: string; gitRoot: string | null }> | null = null
  const place = (): Promise<{ key: string; real: string; gitRoot: string | null }> => (where ??= claudeProjectKey(input.cwd))
  if (isClaudeCode(input.cliId)) {
    const wanted = others.filter((n) => extra[n])
    let claudeOwn: string[] = []
    if (wanted.length) {
      const { key, real } = await place()
      const [read, projectMcp] = await Promise.all([input.reader.read(), mcpJsonChain(real)])
      // Every name Claude could know here, approved or not: a Stoke-held
      // server must never shadow one of the user's.
      claudeOwn = claudeMcpServers(read.json, projectMcp, key, { approvals: { enableAll: true, enabled: [], disabled: [] } }).names
    }
    return {
      servers: serversForLaunch({ ticks, browser: input.browser, mirrored: [], extra, forClaude: { claudeOwn } }),
      own: [],
      keep: []
    }
  }
  const needMirror = others.some((n) => !extra[n])
  let mirrored: McpServerSpec[] = []
  if (needMirror) {
    const { key, real, gitRoot } = await place()
    const [read, projectMcp] = await Promise.all([input.reader.read(), mcpJsonChain(real)])
    const trusted = isTrustedFolder(read.json, trustKeys(key, real, gitRoot))
    const approvals = await mcpJsonApprovals(real, env, home, trusted)
    mirrored = claudeMcpServers(read.json, projectMcp, key, { approvals, env }).servers
  }
  const servers = serversForLaunch({ ticks, browser: input.browser, mirrored, extra })
  if (!servers.length) return { servers, own: [], keep: [] }
  const { real, gitRoot } = await place()
  return { servers, ...(await agentOwnMcp(input.cliId, env, home, { real, gitRoot })) }
}

/**
 * A second Claude account's share of the Default account's user-scope servers
 * (`accountMcpMirror`): both `~/.claude.json`s read-only, under the deadline,
 * and — for a launch — the folder's key and `.mcp.json` chain, so the account's
 * own servers there are never shadowed. `cwd` null is the account row: user
 * scope only.
 *
 * Either file unreadable means nothing is handed on. Default's, because there
 * is nothing to hand; the account's, because a name it defines could not be
 * told apart from one it does not, and shadowing its own server is the
 * direction never to fail in. A MISSING account file (never signed in) is not
 * an error: it defines nothing.
 */
export async function resolveAccountMirror(input: {
  cwd: string | null
  defaultReader: ClaudeConfigReader
  accountReader: ClaudeConfigReader
  env?: NodeJS.ProcessEnv
}): Promise<{ mirror: AccountMcpMirror; error: string | null }> {
  const [d, a] = await Promise.all([input.defaultReader.read(), input.accountReader.read()])
  if (d.error) return { mirror: NO_ACCOUNT_MIRROR, error: `Default’s servers could not be read: ${d.error}` }
  if (a.error) return { mirror: NO_ACCOUNT_MIRROR, error: `Its own servers could not be read, so none of Default’s are passed on: ${a.error}` }
  let projectKey: string | null = null
  let projectMcpJson: unknown = null
  if (input.cwd) {
    const { key, real } = await claudeProjectKey(input.cwd)
    projectKey = key
    projectMcpJson = await mcpJsonChain(real)
  }
  return {
    mirror: accountMcpMirror({ defaultJson: d.json, accountJson: a.json, projectKey, projectMcpJson, env: input.env ?? process.env }),
    error: null
  }
}

/** The agents whose own user config Settings reads, to grey the names they define (`ownMcpSources`). */
const OWN_MCP_AGENTS: readonly CodingCliId[] = ['codex', 'opencode', 'kilo', 'qwen', 'copilot', 'kimi', 'vibe']

/** How long Settings waits for every known folder's `.mcp.json` before listing without them. */
const CATALOG_PROJECTS_DEADLINE_MS = 3000

/**
 * The project scope of every folder `~/.claude.json` knows (its `projects`
 * keys, each a canonical git root or a loose folder): the `.mcp.json` chain
 * above each, every distinct file read once, and — only for a folder whose
 * chain defines a server — the approvals a launch there would apply
 * (`isTrustedFolder`, `mcpJsonApprovals`). Everything under the read deadline.
 */
async function projectMcpReads(
  json: Record<string, unknown> | null,
  env: NodeJS.ProcessEnv,
  home: string
): Promise<Record<string, ProjectMcpRead>> {
  const projects = json && json.projects && typeof json.projects === 'object' ? Object.keys(json.projects) : []
  const chains = projects.map((k) => foldersDownTo(k))
  const dirs = [...new Set(chains.flat())]
  const files = await Promise.all(dirs.map((d) => readJsonUnder(join(d, '.mcp.json'), READ_DEADLINE_MS)))
  const byDir = new Map(dirs.map((d, i) => [d, files[i]]))
  const out: Record<string, ProjectMcpRead> = {}
  await Promise.all(
    projects.map(async (k, i) => {
      const mcpJson = mergeMcpJsons(chains[i].map((d) => byDir.get(d) ?? null))
      if (!Object.keys(mcpJson.mcpServers).length) return
      const { real, gitRoot } = await claudeProjectKey(k)
      const trusted = isTrustedFolder(json, trustKeys(k, real, gitRoot))
      out[k] = { mcpJson, approvals: await mcpJsonApprovals(real, env, home, trusted) }
    })
  )
  return out
}

/** What Settings › Agents lists: names and kinds only, never a value (`mcpCatalog`). */
export async function readMcpCatalog(
  reader: ClaudeConfigReader,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): Promise<McpCatalog> {
  const [read, ...owns] = await Promise.all([reader.read(), ...OWN_MCP_AGENTS.map((id) => agentOwnMcp(id, env, home))])
  const own: Partial<Record<CodingCliId, string[]>> = {}
  OWN_MCP_AGENTS.forEach((id, i) => {
    if (owns[i].own.length) own[id] = owns[i].own
  })
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), CATALOG_PROJECTS_DEADLINE_MS)
  })
  const projects = await Promise.race([projectMcpReads(read.json, env, home).catch(() => null), late])
  clearTimeout(timer)
  const error =
    [read.error, projects === null ? 'Not every folder’s .mcp.json could be read in time, so some project servers may be missing.' : null]
      .filter(Boolean)
      .join(' ') || null
  return mcpCatalog(read.json, own, error, env, projects ?? {})
}

/**
 * `<userData>/agents/mcp/`: the owner-only files Qwen, Copilot and Claude Code
 * are pointed at. Content-named (`mcpFileName`), so an identical set reuses a
 * file and a changed one never rewrites a file a running agent may re-read.
 *
 * Swept once per run, before the first write: every file an earlier run wrote
 * holds that run's browser bearer (dead) and whatever server secrets it was
 * handed (not dead), and no agent from that run is still alive — quitting
 * kills every pty. Only names this module makes are removed, one `unlink` at a
 * time, never a recursive delete; plus the one file the previous version of
 * this feature wrote beside it (`agents/mcp-httpurl.json`, a bearer).
 */
export class McpFileStore {
  readonly dir: string
  private readonly legacy: string
  private swept: Promise<void> | null = null

  constructor(agentsDir: string) {
    this.dir = join(agentsDir, 'mcp')
    this.legacy = join(agentsDir, 'mcp-httpurl.json')
  }

  fileFor = (name: string): string => join(this.dir, name)

  /** Claimed before its first await, so two launches at once sweep once (gotcha 20). */
  sweep(): Promise<void> {
    this.swept ??= (async () => {
      await unlink(this.legacy).catch(() => {})
      const names = await readdir(this.dir).catch(() => [] as string[])
      await Promise.all(
        names.filter((n) => MCP_FILE_NAME.test(n)).map((n) => unlink(join(this.dir, n)).catch(() => {}))
      )
    })()
    return this.swept
  }

  /**
   * Write each file owner-only, atomically (a temp file renamed over), unless
   * it is already there with this content. False when any could not be
   * written, and the launch then goes without them rather than naming a file
   * that is not there.
   */
  async write(files: readonly PlanFile[]): Promise<boolean> {
    if (!files.length) return true
    await this.sweep()
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 })
      await chmod(this.dir, 0o700).catch(() => {})
      for (const f of files) {
        if ((await readFile(f.path, 'utf8').catch(() => null)) === f.content) {
          await chmod(f.path, 0o600).catch(() => {})
          continue
        }
        const tmp = `${f.path}.${randomBytes(4).toString('hex')}.tmp`
        await writeFile(tmp, f.content, { encoding: 'utf8', mode: 0o600 })
        await chmod(tmp, 0o600).catch(() => {})
        await rename(tmp, f.path)
      }
      return true
    } catch (err) {
      console.error('[stoke] could not write an MCP config for a launch', err)
      return false
    }
  }
}
