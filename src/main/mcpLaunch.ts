import { chmod, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { claudeConfigDir } from './claudePaths.ts'
import { canonicalRootOf, gitRootOf, localSettingsFiles, readJsonUnder, realOr } from './skillsProject.ts'
import {
  claudeMcpServers,
  codexConfiguredServers,
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
  type PlanFile
} from '../shared/mcpServers.ts'
import { isClaudeCode, type CodingCliId } from '../shared/codingClis.ts'

/*
 * The main-process half of mcpServers.ts: read Claude Code's own MCP list for
 * one launch, read which names Codex already defines, and write the owner-only
 * files the file-taking agents are pointed at.
 *
 * Everything here READS the agents' config — `~/.claude.json` (never through
 * claudeGlobalConfig.ts's sync reader, gotcha 40; never written, gotcha 38),
 * the folder's `.mcp.json` and settings layers, Codex's config.toml — and
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

/** Only the MCP keys of a parsed `~/.claude.json` — the rest (history, tips, caches) is not kept. */
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
      if (Object.keys(keep).length) projects[folder] = keep
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

/** The server names Codex's own config defines; none when it cannot be read. */
export async function codexOwnServers(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): Promise<string[]> {
  const text = await readTextUnder(codexConfigPath(env, home))
  return text === null ? [] : codexConfiguredServers(text)
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

/**
 * What the agent's OWN MCP config says, read-only, for the agents where a
 * launch-time server could collide with one of the user's or where naming a
 * file hides theirs. Kimi's file is kept whenever it EXISTS, even if it could
 * not be read in time: dropping the user's own servers for a session is the
 * direction never to fail in.
 */
export async function agentOwnMcp(
  cliId: CodingCliId,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): Promise<AgentOwnMcp> {
  if (cliId === 'codex') return { own: await codexOwnServers(env, home), keep: [] }
  if (cliId === 'kimi') {
    const path = kimiMcpPath(env, home)
    const exists = await stat(path).then((st) => st.isFile(), () => false)
    if (!exists) return { own: [], keep: [] }
    const text = await readTextUnder(path)
    return { own: text === null ? [] : jsonConfiguredServers(text), keep: [path] }
  }
  if (cliId === 'vibe') {
    const text = await readTextUnder(vibeConfigPath(env, home))
    return { own: text === null ? [] : vibeConfiguredServers(text), keep: [] }
  }
  return { own: [], keep: [] }
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
  if (isClaudeCode(input.cliId)) {
    const wanted = others.filter((n) => extra[n])
    let claudeOwn: string[] = []
    if (wanted.length) {
      const { key, real } = await claudeProjectKey(input.cwd)
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
    const { key, real, gitRoot } = await claudeProjectKey(input.cwd)
    const [read, projectMcp] = await Promise.all([input.reader.read(), mcpJsonChain(real)])
    const trusted = isTrustedFolder(read.json, trustKeys(key, real, gitRoot))
    const approvals = await mcpJsonApprovals(real, env, home, trusted)
    mirrored = claudeMcpServers(read.json, projectMcp, key, { approvals, env }).servers
  }
  const servers = serversForLaunch({ ticks, browser: input.browser, mirrored, extra })
  const mine = servers.length ? await agentOwnMcp(input.cliId, env, home) : { own: [], keep: [] }
  return { servers, ...mine }
}

/** What Settings › Agents lists: names and kinds only, never a value (`mcpCatalog`). */
export async function readMcpCatalog(
  reader: ClaudeConfigReader,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): Promise<McpCatalog> {
  const agents: CodingCliId[] = ['codex', 'kimi', 'vibe']
  const [read, ...owns] = await Promise.all([reader.read(), ...agents.map((id) => agentOwnMcp(id, env, home))])
  const own: Partial<Record<CodingCliId, string[]>> = {}
  agents.forEach((id, i) => {
    if (owns[i].own.length) own[id] = owns[i].own
  })
  return mcpCatalog(read.json, own, read.error, env)
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
