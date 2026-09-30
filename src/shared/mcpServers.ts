/*
 * One model of an MCP server, and an adapter per agent that hands it over AT
 * LAUNCH.
 *
 * Within one agent, MCP servers were never tied to a model: Claude Code keeps
 * every server when Settings › Providers points it at OpenRouter, and so does
 * every agent on its own endpoint. The gap was BETWEEN agents. The servers the
 * user set up in Claude Code (`~/.claude.json`, a project's `.mcp.json`) never
 * reached Codex, OpenCode or the rest, and the only server any of them got was
 * Stoke's own browser server, hard-coded as one `{url, token}`.
 *
 * So:
 *
 *   - The LIST is Claude Code's own, read again at every launch
 *     (`claudeMcpServers`): user scope, the launch folder's local scope and its
 *     `.mcp.json`, minus what the folder turned off. Never copied into Stoke's
 *     settings — a copy would be a second writer that goes stale (gotcha 57) —
 *     and never written back (gotcha 38).
 *   - Stoke stores only which servers each agent gets (`AgentMcpSettings
 *     .perAgent`, by name) plus servers Stoke itself holds (`extra`), whose
 *     secrets live in the vault (shared/secrets.ts). By default an agent gets
 *     only Stoke's browser server: every server's tool list costs context in
 *     every turn (gotcha 41 measured 427 tools across 30 servers), so the rest
 *     are ticked per agent.
 *   - Each agent is handed its servers the way it takes them at launch — flags
 *     (`codexMcp`), a config in the environment (`opencodeMcp`, `vibeMcpEnv`,
 *     `piMcp` through a constant extension), or a 0600 file whose path is a
 *     flag (`qwenMcpFile`, `copilotMcpFile`, `kimiMcpFile`,
 *     `claudeMcpConfigs`). Never a write into the agent's own config; a name
 *     the agent's own config already uses — its user file or the launch
 *     folder's (main's `agentOwnMcp`, per agent) — is skipped, never replaced
 *     or merged into. Pi alone needs no list: its own `mcp.json` outranks a
 *     registered server of the same name. Agents
 *     with no such route (`CLI_CAPS[id].mcp === 'none'`, each with its reason
 *     in codingClis.ts) are handed nothing, and Settings greys their list.
 *
 * Secrets — an env value, a header, a bearer — travel only in the environment
 * or in an owner-only file, never in argv, where `ps` shows them to every
 * process on the machine. A stdio server's command and arguments are not a
 * secret channel: the server process carries them in ITS argv whoever starts
 * it, so they may appear in Codex's `-c` flags too. An http server's URL IS
 * one — hosted servers take their key in it (`?tavilyApiKey=…`,
 * `?exaApiKey=…`) and no local process ever shows it — so Codex, the one agent
 * whose only route for a URL is argv, is refused any URL that may carry one
 * (`urlInArgvProblem`).
 *
 * Claude's OAuth sign-ins to its servers (`mcpOAuth` in its credentials) are
 * never read or copied (gotcha 36). An http server with no headers is passed as
 * its URL alone, and each agent signs in to it itself.
 *
 * Pure, compiled by both tsconfigs, no `node:` import (gotcha 27); suites load
 * it under strip-types, so imports are relative with `.ts` (gotcha 78).
 */
import type { CodingCliId } from './codingClis.ts'

export type McpTransport = 'stdio' | 'http'

export interface McpServerSpec {
  /** The key the agent knows it by. Only ever a name `isSafeServerName` accepts. */
  name: string
  transport: McpTransport
  /** stdio: the program, and its arguments (visible in the process table — not a secret channel). */
  command: string
  args: string[]
  /** stdio: the server's environment. Values may be secrets. */
  env: Record<string, string>
  /** http: the streamable-HTTP endpoint. May carry a credential (`urlInArgvProblem`). */
  url: string
  /**
   * http: the URL was filled in from a `${VAR}` Claude Code expands — which is
   * how a key gets into one — so it is treated as secret wherever it would
   * reach argv. Set only by `specFromClaudeEntry`, and only when true.
   */
  urlFromEnv?: true
  /** http: request headers. Values may be secrets. */
  headers: Record<string, string>
  /**
   * http: a bearer token Stoke holds for this server — its own browser
   * server's, or one typed into a Stoke-held server. Never Claude's OAuth.
   */
  bearer?: string
}

/** Why a server was left out of a list or a launch, in the user's terms. */
export interface McpRefusal {
  name: string
  reason: string
}

/** What Stoke stores (`settings.agents.mcp`). */
export interface AgentMcpSettings {
  /**
   * The server names each agent is handed, by agent. Absent means the default
   * (`DEFAULT_MCP_TICKS`); an empty list means none, Stoke's browser included.
   */
  perAgent: Partial<Record<CodingCliId, string[]>>
  /**
   * Servers Stoke itself holds, by name — for a server the user wants in
   * other agents but not in Claude Code's own config. A record rather than a
   * list so the vault can name each secret by a stable path
   * (`agents.mcp.extra.<name>.env.<VAR>`), which an index would not be.
   */
  extra: Record<string, McpServerSpec>
}

/** Stoke's own browser server's name — in `mcp-browser.json` and every adapter. */
export const STOKE_BROWSER_SERVER = 'stoke'

/** What an agent is handed until the user ticks something else. */
export const DEFAULT_MCP_TICKS: readonly string[] = [STOKE_BROWSER_SERVER]

export const DEFAULT_AGENT_MCP: AgentMcpSettings = { perAgent: {}, extra: {} }

/** The env var Codex reads Stoke's browser bearer from (unchanged since 2026-09-19). */
export const ENV_MCP_TOKEN = 'STOKE_MCP_TOKEN'

export const MCP_NAME_MAX = 64
/** Far past any real setup; a hand-edited file of thousands is junk, not a choice. */
const TICKS_MAX = 256
const EXTRA_MAX = 64

/*
 * Keys that would walk into an object's prototype when used as one — a JSON
 * file can hold them as ordinary keys, and the secrets vault refuses a path
 * through them (shared/secrets.ts), so a value under one could never be sealed.
 */
const PROTO_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

/*
 * A server name becomes a TOML key (`-c mcp_servers.<name>.url=…`), a JSON key
 * and, where an agent is a `.cmd` shim, part of a `cmd.exe /c` line (gotcha
 * 13). So it is a whitelist, not an escape: letters, digits, `_` and `-`,
 * starting with a letter or digit — a TOML bare key, harmless to cmd.exe, and
 * never mistaken for an option. Every name in the machine's real
 * `~/.claude.json` fitted it (23 of 23, 2026-09-30).
 */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/

export function isSafeServerName(name: unknown): name is string {
  return typeof name === 'string' && name.length <= MCP_NAME_MAX && SAFE_NAME.test(name) && !PROTO_KEYS.has(name)
}

/** A POSIX-portable variable name; Windows accepts the same set. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export function isEnvName(k: string): boolean {
  return k.length <= 128 && ENV_NAME.test(k) && !PROTO_KEYS.has(k)
}

/** An HTTP header name (RFC 9110 token). */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/
function isHeaderName(k: string): boolean {
  return k.length <= 128 && HEADER_NAME.test(k) && !PROTO_KEYS.has(k)
}

/**
 * A header name a STORED server may use: no `.`, because the vault names each
 * secret by a dotted path (`agents.mcp.extra.<name>.headers.<header>`) and a
 * dotted key could never be sealed — its value would stay in settings.json in
 * plain text. No real header needs one.
 */
function isStoredHeaderName(k: string): boolean {
  return isHeaderName(k) && !k.includes('.')
}

/** No value may carry a line break or NUL: a header would split, a TOML/JSON line could be forged. */
function isPlainValue(v: string): boolean {
  return !/[\r\n\0]/.test(v)
}

function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/* ------------------------------------------------------ Claude's own list */

/**
 * Claude Code's `${VAR}` / `${VAR:-default}` expansion, which it applies to a
 * server's command, args, env, url and headers. An unset variable with no
 * default makes the CLI refuse that server's config; `missing` says which, and
 * the caller refuses it too rather than hand an agent the literal text.
 */
export function expandEnvRefs(
  value: string,
  env: Readonly<Record<string, string | undefined>>,
  missing: string[] = []
): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (whole, name: string, fallback?: string) => {
    const v = env[name]
    if (v !== undefined && v !== '') return v
    if (fallback !== undefined) return fallback
    missing.push(name)
    return whole
  })
}

type Parsed = { ok: true; spec: McpServerSpec } | { ok: false; reason: string }

/**
 * One entry of Claude Code's `mcpServers`, as a spec — or why not.
 *
 * `type` absent with a `command` is stdio, as the CLI reads it. `sse` and `ws`
 * are refused rather than passed as http: none of the adapters speak them
 * (Codex has streamable HTTP only, and Qwen's plain `url` IS sse), and a wrong
 * transport is a server that silently never connects. An `oauth` block is not
 * read: the URL goes alone, and each agent signs in itself.
 */
export function specFromClaudeEntry(
  name: string,
  raw: unknown,
  env: Readonly<Record<string, string | undefined>> = {}
): Parsed {
  if (!isSafeServerName(name)) return { ok: false, reason: 'its name has characters Stoke will not pass to another agent' }
  if (name === STOKE_BROWSER_SERVER) return { ok: false, reason: 'Stoke’s own browser tools use this name' }
  if (!isRecord(raw)) return { ok: false, reason: 'its entry is not an object' }
  const type = typeof raw.type === 'string' ? raw.type : typeof raw.command === 'string' ? 'stdio' : ''
  const missing: string[] = []
  const x = (v: string): string => expandEnvRefs(v, env, missing)
  const strings = (v: unknown): string[] | null =>
    v === undefined ? [] : Array.isArray(v) && v.every((a) => typeof a === 'string') ? (v as string[]) : null
  const pairs = (v: unknown, keyOk: (k: string) => boolean): Record<string, string> | null => {
    if (v === undefined) return {}
    if (!isRecord(v)) return null
    const out: Record<string, string> = {}
    for (const [k, val] of Object.entries(v)) {
      if (typeof val !== 'string' || !keyOk(k)) return null
      const e = x(val)
      if (!isPlainValue(e)) return null
      out[k] = e
    }
    return out
  }
  if (type === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) return { ok: false, reason: 'it names no command' }
    const args = strings(raw.args)
    const envs = pairs(raw.env, isEnvName)
    if (!args) return { ok: false, reason: 'its arguments are not a list of strings' }
    if (!envs) return { ok: false, reason: 'its environment has a name or value Stoke will not pass on' }
    const command = x(raw.command)
    const expanded = args.map(x)
    if (missing.length) return { ok: false, reason: `it needs \${${missing[0]}}, which is not set` }
    if (![command, ...expanded].every(isPlainValue)) return { ok: false, reason: 'its command has a line break in it' }
    return { ok: true, spec: { name, transport: 'stdio', command, args: expanded, env: envs, url: '', headers: {} } }
  }
  if (type === 'http' || type === 'streamable-http') {
    if (typeof raw.url !== 'string') return { ok: false, reason: 'it names no URL' }
    const url = x(raw.url)
    const headers = pairs(raw.headers, isHeaderName)
    if (missing.length) return { ok: false, reason: `it needs \${${missing[0]}}, which is not set` }
    if (!isHttpUrl(url)) return { ok: false, reason: 'its URL is not http(s)' }
    if (!headers) return { ok: false, reason: 'its headers have a name or value Stoke will not pass on' }
    const spec: McpServerSpec = { name, transport: 'http', command: '', args: [], env: {}, url, headers }
    if (url !== raw.url) spec.urlFromEnv = true
    return { ok: true, spec }
  }
  if (type === 'sse') return { ok: false, reason: 'it uses the older SSE transport, which the other agents are not handed' }
  return { ok: false, reason: type ? `its transport “${type}” is not one Stoke passes on` : 'it names neither a command nor a URL' }
}

/**
 * Which of a folder's `.mcp.json` servers Claude Code has been allowed to run,
 * from its settings layers and `~/.claude.json`. A repository's `.mcp.json` is
 * code the user did not necessarily write, and the CLI asks before it runs one;
 * without this gate, an agent ticked for "github" would run whatever a cloned
 * repo called "github".
 */
export interface McpJsonApprovals {
  enableAll: boolean
  enabled: string[]
  disabled: string[]
}

export const NO_APPROVALS: McpJsonApprovals = { enableAll: false, enabled: [], disabled: [] }

/** Fold one settings object's approval keys over what the lower layers said. */
export function foldApprovals(base: McpJsonApprovals, layer: unknown): McpJsonApprovals {
  if (!isRecord(layer)) return base
  const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : [])
  return {
    enableAll: typeof layer.enableAllProjectMcpServers === 'boolean' ? layer.enableAllProjectMcpServers : base.enableAll,
    enabled: [...new Set([...base.enabled, ...names(layer.enabledMcpjsonServers)])],
    disabled: [...new Set([...base.disabled, ...names(layer.disabledMcpjsonServers)])]
  }
}

export interface ClaudeMcpList {
  /** What Claude Code would load in this folder and Stoke can hand on, in its order. */
  servers: McpServerSpec[]
  /** Loaded by Claude, but not passable (a transport, a name, an unset variable). */
  refused: McpRefusal[]
  /** Every name Claude Code knows in this folder, whatever became of it. */
  names: string[]
}

/**
 * The `.mcp.json` files Claude Code reads for a session, merged as it merges
 * them: EVERY folder from the filesystem's top down to the cwd (the top itself
 * excluded), each file's servers assigned over the last, so the nearest wins
 * (2.1.285's project scope, read out of the binary on 2026-09-30, gotcha 129).
 * `files` is that chain, outermost first; a missing or junk file is null.
 */
export function mergeMcpJsons(files: readonly unknown[]): { mcpServers: Record<string, unknown> } {
  const mcpServers: Record<string, unknown> = {}
  for (const f of files) {
    if (isRecord(f) && isRecord(f.mcpServers)) Object.assign(mcpServers, f.mcpServers)
  }
  return { mcpServers }
}

/**
 * Whether Claude Code trusts a folder: `hasTrustDialogAccepted` on any of
 * `folders` — main's `trustKeys`, the project key and the folders above the
 * cwd, stopping at a repository's own top as the CLI's walk does, so a
 * trusted home folder never trusts a repo cloned under it. A repository's committed
 * `.claude/settings.json` can approve its own `.mcp.json` servers
 * (`enableAllProjectMcpServers`), and the CLI honours that only once the user
 * has trusted the folder — so Stoke does too.
 */
export function isTrustedFolder(claudeJson: unknown, folders: readonly string[]): boolean {
  const root = isRecord(claudeJson) ? claudeJson : {}
  const projects = isRecord(root.projects) ? root.projects : {}
  return folders.some((f) => {
    const p = projects[f]
    return isRecord(p) && p.hasTrustDialogAccepted === true
  })
}

/**
 * Claude Code's MCP servers for a session, as the CLI resolves them: user
 * scope (`mcpServers`), the folder's `.mcp.json` chain (only what was
 * approved, `mergeMcpJsons`), then local scope (`projects[key].mcpServers`) —
 * a later scope's entry replacing an earlier one of the same name, local
 * winning — minus `projects[key].disabledMcpServers`, which is what `/mcp`
 * disable writes.
 *
 * `projectKey` is the folder's key in `projects` AS THE CLI COMPUTES IT (main's
 * `claudeProjectKey`): the cwd's canonical git root — the repo's top, and for a
 * linked worktree the MAIN worktree's — else the cwd itself. Never simply the
 * cwd: a tab in a subfolder or a worktree would miss the folder's own servers
 * and every one it turned off (gotcha 129).
 *
 * `claudeJson` is the parsed `~/.claude.json`, `projectMcpJson` the merged
 * `.mcp.json` chain; either may be null. Read-only: nothing here, or anywhere
 * in Stoke, writes either file for MCP (gotcha 38).
 */
export function claudeMcpServers(
  claudeJson: unknown,
  projectMcpJson: unknown,
  projectKey: string,
  opts: { approvals?: McpJsonApprovals; env?: Readonly<Record<string, string | undefined>> } = {}
): ClaudeMcpList {
  const root = isRecord(claudeJson) ? claudeJson : {}
  const projects = isRecord(root.projects) ? root.projects : {}
  const project = isRecord(projects[projectKey]) ? (projects[projectKey] as Record<string, unknown>) : {}
  const approvals = foldApprovals(opts.approvals ?? NO_APPROVALS, project)
  const disabled = new Set(
    Array.isArray(project.disabledMcpServers) ? project.disabledMcpServers.filter((n) => typeof n === 'string') : []
  )
  const entries = new Map<string, unknown>()
  const add = (servers: unknown, keep: (name: string) => boolean = () => true): void => {
    if (!isRecord(servers)) return
    for (const [name, raw] of Object.entries(servers)) if (keep(name)) entries.set(name, raw)
  }
  add(root.mcpServers)
  const mcpJson = isRecord(projectMcpJson) ? projectMcpJson.mcpServers : undefined
  add(
    mcpJson,
    (name) => !approvals.disabled.includes(name) && (approvals.enableAll || approvals.enabled.includes(name))
  )
  add(project.mcpServers)
  const servers: McpServerSpec[] = []
  const refused: McpRefusal[] = []
  for (const [name, raw] of entries) {
    if (disabled.has(name)) continue
    const parsed = specFromClaudeEntry(name, raw, opts.env)
    if (parsed.ok) servers.push(parsed.spec)
    else refused.push({ name, reason: parsed.reason })
  }
  const all = new Set<string>(entries.keys())
  if (isRecord(mcpJson)) for (const n of Object.keys(mcpJson)) all.add(n)
  return { servers, refused, names: [...all] }
}

/* ------------------------------------------------------------- storage */

/**
 * A stored Stoke-held server, or null. Rebuilt from named keys like every
 * other hydrate, so a field this does not name does not survive. An env value
 * or header that is `''` is KEPT: the vault empties every secret in
 * settings.json, and a value it could not open this run stays `''` until the
 * user types it again (shared/secrets.ts).
 */
export function hydrateServerSpec(raw: unknown, name: string): McpServerSpec | null {
  if (!isSafeServerName(name) || name === STOKE_BROWSER_SERVER || !isRecord(raw)) return null
  const transport: McpTransport = raw.transport === 'http' ? 'http' : 'stdio'
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
  const pairs = (v: unknown, keyOk: (k: string) => boolean): Record<string, string> => {
    const out: Record<string, string> = {}
    if (!isRecord(v)) return out
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === 'string' && keyOk(k) && isPlainValue(val)) out[k] = val
    }
    return out
  }
  const command = str(raw.command)
  const url = str(raw.url)
  const args = Array.isArray(raw.args) ? raw.args.filter((a): a is string => typeof a === 'string' && isPlainValue(a)) : []
  if (transport === 'stdio' && (!command || !isPlainValue(command))) return null
  if (transport === 'http' && !isHttpUrl(url)) return null
  const spec: McpServerSpec = {
    name,
    transport,
    command: transport === 'stdio' ? command : '',
    args: transport === 'stdio' ? args : [],
    env: transport === 'stdio' ? pairs(raw.env, isEnvName) : {},
    url: transport === 'http' ? url : '',
    headers: transport === 'http' ? pairs(raw.headers, isStoredHeaderName) : {}
  }
  if (transport === 'http' && typeof raw.bearer === 'string' && isPlainValue(raw.bearer)) spec.bearer = raw.bearer.trim()
  return spec
}

/**
 * Repair `settings.agents.mcp`. Ticks survive only for agents this build
 * knows and names `isSafeServerName` accepts, deduplicated; an explicit empty
 * list is kept (it means "nothing, not even the browser"). A Stoke-held server
 * that is not whole is dropped rather than half-kept.
 */
export function hydrateAgentMcp(raw: unknown, isAgent: (id: string) => id is CodingCliId): AgentMcpSettings {
  const r = isRecord(raw) ? raw : {}
  const perAgent: Partial<Record<CodingCliId, string[]>> = {}
  if (isRecord(r.perAgent)) {
    for (const [id, names] of Object.entries(r.perAgent)) {
      if (!isAgent(id) || !Array.isArray(names)) continue
      perAgent[id] = [...new Set(names.filter(isSafeServerName))].slice(0, TICKS_MAX)
    }
  }
  const extra: Record<string, McpServerSpec> = {}
  if (isRecord(r.extra)) {
    for (const [name, spec] of Object.entries(r.extra).slice(0, EXTRA_MAX)) {
      const h = hydrateServerSpec(spec, name)
      if (h) extra[name] = h
    }
  }
  return { perAgent, extra }
}

/** The names an agent is handed. */
export function mcpTicksFor(mcp: AgentMcpSettings, id: CodingCliId): readonly string[] {
  return mcp.perAgent[id] ?? DEFAULT_MCP_TICKS
}

/** `mcp` with one name ticked or unticked for one agent. */
export function withMcpTick(mcp: AgentMcpSettings, id: CodingCliId, name: string, on: boolean): AgentMcpSettings {
  const cur = mcpTicksFor(mcp, id)
  const next = on ? [...new Set([...cur, name])] : cur.filter((n) => n !== name)
  return { ...mcp, perAgent: { ...mcp.perAgent, [id]: next } }
}

/* ------------------------------------------------------- one launch's set */

export interface LaunchServersInput {
  /** The agent's ticks (`mcpTicksFor`). */
  ticks: readonly string[]
  /** Stoke's browser server with its bearer, or null while it is not up. */
  browser: McpServerSpec | null
  /** Claude Code's list for the launch folder (`claudeMcpServers().servers`). */
  mirrored: readonly McpServerSpec[]
  /** Stoke-held servers. */
  extra: Readonly<Record<string, McpServerSpec>>
  /**
   * Claude Code itself: it loads its own servers, so it is handed only the
   * browser and Stoke-held servers — and not one whose name its own config
   * already uses (`claudeOwn`), which would shadow the user's.
   */
  forClaude?: { claudeOwn: readonly string[] }
}

/**
 * The servers one launch hands its agent, in a stable order: Stoke's browser
 * first (spec 0, the one every agent had before this), then the ticked names
 * as Claude Code's list orders them, then Stoke-held ones. A Stoke-held server
 * replaces a mirrored one of the same name — the user added it to Stoke on
 * purpose. A tick naming nothing in this folder (a local-scope server of
 * another project) is simply absent.
 */
export function serversForLaunch(input: LaunchServersInput): McpServerSpec[] {
  const want = new Set(input.ticks)
  const out: McpServerSpec[] = []
  if (want.has(STOKE_BROWSER_SERVER) && input.browser) out.push(input.browser)
  if (input.forClaude) {
    const own = new Set(input.forClaude.claudeOwn)
    for (const [name, spec] of Object.entries(input.extra)) if (want.has(name) && !own.has(name)) out.push(spec)
    return out
  }
  for (const spec of input.mirrored) {
    if (want.has(spec.name) && !input.extra[spec.name]) out.push(spec)
  }
  for (const [name, spec] of Object.entries(input.extra)) if (want.has(name)) out.push(spec)
  return out
}

/* ------------------------------------------------------------- adapters */

/** A TOML basic string; JSON's escapes are a subset of TOML's. */
function toml(s: string): string {
  return JSON.stringify(s)
}

/** A TOML array of basic strings (also valid JSON). */
function tomlArray(items: readonly string[]): string {
  return `[${items.map(toml).join(', ')}]`
}

/** A header's Authorization, from the spec's bearer. */
function withBearer(spec: McpServerSpec): Record<string, string> {
  return spec.bearer ? { ...spec.headers, Authorization: `Bearer ${spec.bearer}` } : { ...spec.headers }
}

/**
 * Variables no server's environment may replace in an agent's OWN process —
 * which is what forwarding through the agent's environment does. PATH and HOME
 * are the agent's to run on; a server's `OPENAI_API_KEY` would become Codex's
 * own key; `STOKE_*` are Stoke's. Upper-cased before the test: Windows
 * compares variable names without case.
 */
const AGENT_OWN_ENV = /^(PATH|HOME|USER|LOGNAME|SHELL|TERM|TMPDIR|TEMP|TMP|LANG|PWD|USERPROFILE|APPDATA|LOCALAPPDATA|SYSTEMROOT|COMSPEC|PATHEXT|CODEX_.*|OPENAI_.*|STOKE_.*)$/

/**
 * What `cmd.exe /c` reads as syntax. Codex's `-c` flags are the one route
 * where a server's command, arguments, URL and header names become argv, and
 * a Codex installed by npm is a `.cmd` shim that `spawnSpec` runs through
 * cmd.exe (gotcha 13) — where an `&` in a mirrored URL would start a second
 * command. Refused rather than escaped, like `isModelId`; every other adapter
 * carries these in the environment or a file.
 */
const CMD_SYNTAX = /[&|^<>%!"\r\n]/

/** A path segment that reads as a key or a capability id: long, and both letters and digits. */
function looksLikeKey(segment: string): boolean {
  let s = segment
  try {
    s = decodeURIComponent(segment)
  } catch {
    // Keep the raw text: a malformed escape is still judged by its length.
  }
  return s.length >= 24 && /[0-9]/.test(s) && /[A-Za-z]/.test(s)
}

/**
 * Why an http server's URL may carry a credential, or null — for the route
 * that would put it in argv (Codex's `-c …url=`, which has no variable form
 * for a URL, unlike its bearer and headers).
 *
 * Hosted servers take their key in the URL: in the query (Tavily
 * `https://mcp.tavily.com/mcp/?tavilyApiKey=<key>`, Exa
 * `https://mcp.exa.ai/mcp?exaApiKey=<key>`), in userinfo, or as a long opaque
 * path segment; and Claude Code documents `${VAR}` in `url`, which is how a key
 * from the environment gets there (`urlFromEnv`). None of those holds a
 * character `CMD_SYNTAX` refuses, so that check alone let them through.
 * A false hit costs one server in Codex, said in the skip reason; a miss puts
 * a key in the process table. Every http URL in the owner's real
 * `~/.claude.json` (11, 2026-09-30) passes.
 */
export function urlInArgvProblem(spec: McpServerSpec): string | null {
  if (spec.transport !== 'http') return null
  if (spec.urlFromEnv) return 'its URL is filled in from a ${…} variable, which is how a key gets into one'
  let u: URL
  try {
    u = new URL(spec.url)
  } catch {
    return 'its URL cannot be read'
  }
  if (u.username || u.password) return 'its URL carries a user name or password'
  if (u.search || u.hash) return 'its URL has a query string, where hosted servers take their API key'
  if (u.pathname.split('/').some(looksLikeKey)) return 'its URL path holds what looks like a key'
  return null
}

export interface McpEmit {
  args: string[]
  env: Record<string, string>
  skipped: McpRefusal[]
}

/**
 * Codex: `-c mcp_servers.<name>.*` overrides, which `codex mcp get` lists with
 * nothing written to config.toml (2026-09-19). Every secret by NAME in argv and
 * by value in the environment:
 *
 *   stdio  `command`, `args`, and `env_vars = [<names>]`, which forwards those
 *          variables from Codex's own environment to the server — so the
 *          values are set in Codex's environment. (Codex 0.153's
 *          `McpServerEnvVar` is a name or `{name, source}`; read out of the
 *          binary, 2026-09-30.) Two servers wanting one variable with
 *          different values, or a server wanting one Codex itself runs on
 *          (`AGENT_OWN_ENV`, or one the endpoint plan set), cannot both be
 *          honoured, so the later server is skipped and said.
 *   http   `url`, `bearer_token_env_var`, and `env_http_headers = {<header> =
 *          <var>}` — each value in a Stoke-named variable. The URL itself has
 *          no variable form, so one that may carry a key is refused
 *          (`urlInArgvProblem`) and the user is pointed at Codex's own config.
 *
 * A name Codex's own config already defines (`own`: its config.toml and the
 * folder's `.codex/config.toml`) is skipped: `-c` on it would MERGE into the
 * user's entry, not replace it.
 */
export function codexMcp(
  servers: readonly McpServerSpec[],
  own: readonly string[],
  taken: Readonly<Record<string, string>> = {}
): McpEmit {
  const args: string[] = []
  const env: Record<string, string> = {}
  const skipped: McpRefusal[] = []
  const ownSet = new Set(own)
  servers.forEach((spec, i) => {
    if (ownSet.has(spec.name)) {
      skipped.push({ name: spec.name, reason: 'Codex’s own configuration defines a server with this name' })
      return
    }
    const urlProblem = urlInArgvProblem(spec)
    if (urlProblem) {
      skipped.push({
        name: spec.name,
        reason: `${urlProblem}, and Codex takes a URL only as a launch argument, which every process on this machine can read. Add it to Codex’s own config.toml instead`
      })
      return
    }
    const inArgv = [spec.command, ...spec.args, spec.url, ...Object.keys(spec.headers)]
    if (inArgv.some((t) => CMD_SYNTAX.test(t))) {
      skipped.push({ name: spec.name, reason: 'its command, URL or a header name has a character cmd.exe reads as syntax (& | ^ < > % ! ")' })
      return
    }
    const key = `mcp_servers.${spec.name}`
    if (spec.transport === 'stdio') {
      const names = Object.keys(spec.env)
      const clash = names.find((k) => {
        if (AGENT_OWN_ENV.test(k.toUpperCase())) return true
        const have = env[k] ?? taken[k]
        return have !== undefined && have !== spec.env[k]
      })
      if (clash) {
        skipped.push({
          name: spec.name,
          reason: `it sets ${clash}, which Codex would share with ${AGENT_OWN_ENV.test(clash.toUpperCase()) ? 'its own process' : 'another server'}`
        })
        return
      }
      args.push('-c', `${key}.command=${toml(spec.command)}`, '-c', `${key}.args=${tomlArray(spec.args)}`)
      if (names.length) {
        args.push('-c', `${key}.env_vars=${tomlArray(names)}`)
        for (const k of names) env[k] = spec.env[k]
      }
      return
    }
    args.push('-c', `${key}.url=${toml(spec.url)}`)
    if (spec.bearer) {
      const v = spec.name === STOKE_BROWSER_SERVER ? ENV_MCP_TOKEN : `STOKE_MCP_${i}_TOKEN`
      args.push('-c', `${key}.bearer_token_env_var=${toml(v)}`)
      env[v] = spec.bearer
    }
    const headers = Object.entries(spec.headers)
    if (headers.length) {
      const table = headers.map(([h], j) => `${toml(h)} = ${toml(`STOKE_MCP_${i}_H${j}`)}`).join(', ')
      args.push('-c', `${key}.env_http_headers={ ${table} }`)
      headers.forEach(([, value], j) => {
        env[`STOKE_MCP_${i}_H${j}`] = value
      })
    }
  })
  return { args, env, skipped }
}

/**
 * OpenCode (and Kilo, built on it): the `mcp` block of the inline config the
 * CLI layers over the user's own (`OPENCODE_CONFIG_CONTENT`), secrets inline —
 * the whole config travels in the environment. `local` is a command line as
 * one array; `remote` carries its headers, the bearer as Authorization (the
 * shape Stoke's browser server has used since 2026-09-19).
 */
export function opencodeMcp(servers: readonly McpServerSpec[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const spec of servers) {
    if (spec.transport === 'stdio') {
      out[spec.name] = {
        type: 'local',
        command: [spec.command, ...spec.args],
        ...(Object.keys(spec.env).length ? { environment: { ...spec.env } } : {}),
        enabled: true
      }
    } else {
      const headers = withBearer(spec)
      out[spec.name] = { type: 'remote', url: spec.url, ...(Object.keys(headers).length ? { headers } : {}), enabled: true }
    }
  }
  return out
}

/**
 * Qwen Code's `--mcp-config <file>`, in the Gemini-family shape: `httpUrl` is
 * streamable HTTP there, and a bare `url` would be read as SSE (measured: a GET
 * and a HEAD, then "failed to start"). Holds secrets, so written 0600.
 */
export function qwenMcpFile(servers: readonly McpServerSpec[]): string {
  const mcpServers: Record<string, unknown> = {}
  for (const spec of servers) {
    if (spec.transport === 'stdio') {
      mcpServers[spec.name] = {
        command: spec.command,
        args: [...spec.args],
        ...(Object.keys(spec.env).length ? { env: { ...spec.env } } : {})
      }
    } else {
      const headers = withBearer(spec)
      mcpServers[spec.name] = { httpUrl: spec.url, ...(Object.keys(headers).length ? { headers } : {}) }
    }
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`
}

/**
 * Copilot CLI's `--additional-mcp-config @<file>`, in its own mcp-config.json
 * shape — docs.github.com "Adding MCP servers for GitHub Copilot CLI", read
 * 2026-09-30: `type` `local` (or `stdio`) with command/args/env, or `http`
 * with url/headers, and `tools: ["*"]` for every tool (the default when
 * omitted; written out as the docs do). The http form without `tools` is
 * Claude's shape, which Copilot was measured taking (initialize and tools/list
 * with the bearer) for e00c95a. 0600, like every file here.
 */
export function copilotMcpFile(servers: readonly McpServerSpec[]): string {
  const mcpServers: Record<string, unknown> = {}
  for (const spec of servers) {
    if (spec.transport === 'stdio') {
      mcpServers[spec.name] = { type: 'local', command: spec.command, args: [...spec.args], env: { ...spec.env }, tools: ['*'] }
    } else {
      mcpServers[spec.name] = { type: 'http', url: spec.url, headers: withBearer(spec), tools: ['*'] }
    }
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`
}

/**
 * Kimi Code's `--mcp-config-file <file>` (kimi-cli 1.52.0, `cli/__init__.py`,
 * read 2026-09-30; the flag since 0.27): fastmcp's `MCPConfig`, stdio as
 * command/args/env and remote as url/headers with `transport: "http"`
 * (streamable HTTP). Holds secrets, so written 0600.
 */
export function kimiMcpFile(servers: readonly McpServerSpec[]): string {
  const mcpServers: Record<string, unknown> = {}
  for (const spec of servers) {
    if (spec.transport === 'stdio') {
      mcpServers[spec.name] = {
        command: spec.command,
        args: [...spec.args],
        ...(Object.keys(spec.env).length ? { env: { ...spec.env } } : {})
      }
    } else {
      const headers = withBearer(spec)
      mcpServers[spec.name] = { url: spec.url, transport: 'http', ...(Object.keys(headers).length ? { headers } : {}) }
    }
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`
}

/** The variable Mistral Vibe's environment layer reads `mcp_servers` from. */
export const ENV_VIBE_MCP = 'VIBE_MCP_SERVERS'

/**
 * Mistral Vibe: its configuration has an ENVIRONMENT layer — every schema
 * field as `VIBE_<FIELD>`, parsed by pydantic-settings, JSON for a list — and
 * `mcp_servers` merges across layers as a union by name (mistral-vibe 2.25.8,
 * `core/config/layers/environment.py`, `vibe_schema.py`
 * `WithUnionMerge(merge_key="name")`, read 2026-09-30). The environment layer
 * sits above the user's and the project's config files, so a same-named
 * server there would be REPLACED for the session: names its own config.toml
 * defines are skipped by the caller. `/mcp add` persists only the user layer,
 * so nothing here is ever written back. Stdio `command` as a one-item list, so
 * a path with a space is not `shlex`-split; http as `streamable-http` with
 * static headers. The whole value travels in the environment.
 */
export function vibeMcpEnv(servers: readonly McpServerSpec[]): string {
  return JSON.stringify(
    servers.map((spec) =>
      spec.transport === 'stdio'
        ? { name: spec.name, transport: 'stdio', command: [spec.command], args: [...spec.args], env: { ...spec.env } }
        : { name: spec.name, transport: 'streamable-http', url: spec.url, auth: { type: 'static', headers: withBearer(spec) } }
    )
  )
}

/** The variable Stoke's Pi extension reads the server list from (`PI_MCP_EXTENSION`). */
export const ENV_PI_MCP = 'STOKE_PI_MCP'

/**
 * Pi (0.99.1): no flag or variable names an MCP file, but an extension can
 * call `pi.registerMcpServer(name, config)`, "for the current session …
 * Registrations are not saved", and a server in the user's own `mcp.json` of
 * the same name takes precedence (docs/extensions.md, `dist/core/mcp-servers
 * .d.ts`, read 2026-09-30). So Pi gets a constant extension (`-e`, as its
 * custom endpoint already does) and the list in `STOKE_PI_MCP`.
 *
 * Pi resolves `${NAME}` AND `!command` in every env and header value, so a
 * value is never inlined — a token starting with `!` would be run as a
 * command. Each is a `${STOKE_MCP_<i>_…}` reference, and the value rides in its
 * own variable; the list itself holds no secret.
 */
export function piMcp(servers: readonly McpServerSpec[]): { env: Record<string, string> } {
  const env: Record<string, string> = {}
  const list: Record<string, unknown> = {}
  servers.forEach((spec, i) => {
    if (spec.transport === 'stdio') {
      const e: Record<string, string> = {}
      Object.entries(spec.env).forEach(([k, v], j) => {
        const name = `STOKE_MCP_${i}_E${j}`
        env[name] = v
        e[k] = `\${${name}}`
      })
      list[spec.name] = { command: spec.command, args: [...spec.args], ...(Object.keys(e).length ? { env: e } : {}) }
      return
    }
    const h: Record<string, string> = {}
    Object.entries(withBearer(spec)).forEach(([k, v], j) => {
      const name = `STOKE_MCP_${i}_H${j}`
      env[name] = v
      h[k] = `\${${name}}`
    })
    list[spec.name] = { url: spec.url, ...(Object.keys(h).length ? { headers: h } : {}) }
  })
  env[ENV_PI_MCP] = JSON.stringify(list)
  return { env }
}

/**
 * Pi's MCP extension. Constant text — the list and every value arrive through
 * the environment — so it holds nothing secret and is written once. Does
 * nothing on a Pi too old to have `registerMcpServer`, rather than failing to
 * load; a server Pi refuses is left out and the rest still register.
 */
export const PI_MCP_EXTENSION = [
  '// Written by Stoke. Hands this Pi session the MCP servers ticked for Pi in',
  '// Stoke’s settings, for this process only: nothing is written to ~/.pi, and',
  '// a server your own mcp.json names wins. The list comes from the environment',
  '// Stoke launches Pi with; every secret in it is a ${VAR} Pi resolves there.',
  'export default function (pi: any) {',
  `  const raw = process.env.${ENV_PI_MCP}`,
  "  if (!raw || typeof pi.registerMcpServer !== 'function') return",
  '  let servers: Record<string, unknown>',
  '  try {',
  '    servers = JSON.parse(raw)',
  '  } catch {',
  '    return',
  '  }',
  '  for (const [name, config] of Object.entries(servers)) {',
  '    try {',
  '      pi.registerMcpServer(name, config)',
  '    } catch {}',
  '  }',
  '}',
  ''
].join('\n')

/**
 * The server names Mistral Vibe's config.toml defines: a `name = "…"` line in
 * each `[[mcp_servers]]` block. Not a TOML parser — a miss means the session's
 * copy replaces theirs, a false hit only skips a server.
 */
export function vibeConfiguredServers(toml: string): string[] {
  const names = new Set<string>()
  let inServer = false
  for (const line of toml.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    if (t.startsWith('[')) {
      inServer = /^\[\[\s*mcp_servers\s*\]\]$/.test(t)
      continue
    }
    if (!inServer) continue
    const m = /^name\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(t)
    if (m) names.add(m[1] ?? m[2])
  }
  return [...names]
}

/**
 * JSON with comments and trailing commas, as OpenCode, Kilo and Qwen read
 * their config files (`opencode.jsonc`; Qwen strips comments from
 * settings.json) — or null. Comments are removed outside strings only, then a
 * comma before a closing bracket, then a BOM; anything still not JSON is null.
 */
export function parseJsonc(text: string): unknown {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  // One pass, string-aware: a `//`, `/*` or `,}` inside a string is left alone.
  let out = ''
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '"') {
      const start = i++
      while (i < src.length && src[i] !== '"') i += src[i] === '\\' ? 2 : 1
      out += src.slice(start, ++i)
    } else if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      i = end < 0 ? src.length : end + 2
      out += ' '
    } else if (c === '}' || c === ']') {
      // Drop a trailing comma: the last non-space character written so far.
      let j = out.length - 1
      while (j >= 0 && /\s/.test(out[j])) j--
      if (j >= 0 && out[j] === ',') out = out.slice(0, j) + out.slice(j + 1)
      out += c
      i++
    } else {
      out += c
      i++
    }
  }
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

/**
 * The server names a JSON (or JSONC) config defines under `key`: `mcpServers`
 * for Kimi's mcp.json, Qwen's settings.json, Copilot's mcp-config.json and any
 * `.mcp.json`; `mcp` for OpenCode's and Kilo's config. None for junk.
 */
export function jsonConfiguredServers(text: string, key: 'mcpServers' | 'mcp' = 'mcpServers'): string[] {
  const v = parseJsonc(text)
  return isRecord(v) && isRecord(v[key]) ? Object.keys(v[key] as Record<string, unknown>) : []
}

/** Claude Code's own `--mcp-config` shape. */
export function claudeShapeMcpFile(servers: readonly McpServerSpec[]): string {
  const mcpServers: Record<string, unknown> = {}
  for (const spec of servers) {
    mcpServers[spec.name] =
      spec.transport === 'stdio'
        ? { type: 'stdio', command: spec.command, args: [...spec.args], env: { ...spec.env } }
        : { type: 'http', url: spec.url, headers: withBearer(spec) }
  }
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`
}

/** A file one launch needs on disk, owner-only, before its agent starts. */
export interface PlanFile {
  path: string
  content: string
}

/**
 * The name of a generated MCP file: the agent and a hash of the content. Two
 * launches with the same set share a file and a changed set never rewrites
 * one a running agent may re-read; main sweeps the folder at startup
 * (`sweepMcpFiles`). Not a secret and not security: a filename.
 */
export function mcpFileName(agent: CodingCliId, content: string): string {
  const fnv = (seed: number): string => {
    let h = seed >>> 0
    for (let i = 0; i < content.length; i++) {
      h ^= content.charCodeAt(i)
      h = Math.imul(h, 0x01000193) >>> 0
    }
    return h.toString(16).padStart(8, '0')
  }
  return `${agent}-${fnv(0x811c9dc5)}${fnv(0x050c5d1f)}.json`
}

/** What a generated file's name looks like, for the sweep: nothing else in the folder is touched. */
export const MCP_FILE_NAME = /^[a-z]+-[0-9a-f]{16}\.json$/

/**
 * Claude Code's `--mcp-config` list: Stoke's browser file when ticked (the
 * existing `mcp-browser.json`), then ONE generated file of the Stoke-held
 * servers ticked for it. Claude loads its own servers itself, so none of them
 * is ever in here. The flag takes several files, space-separated
 * (`--mcp-config <configs...>`, 2.1.285's own help).
 */
export function claudeMcpConfigs(
  servers: readonly McpServerSpec[],
  browserFile: string | null,
  fileFor: ((name: string) => string) | null
): { configs: string[]; files: PlanFile[] } {
  const configs: string[] = []
  const files: PlanFile[] = []
  if (browserFile && servers.some((s) => s.name === STOKE_BROWSER_SERVER)) configs.push(browserFile)
  const extras = servers.filter((s) => s.name !== STOKE_BROWSER_SERVER)
  if (extras.length && fileFor) {
    const content = claudeShapeMcpFile(extras)
    const path = fileFor(mcpFileName('claude', content))
    files.push({ path, content })
    configs.push(path)
  }
  return { configs, files }
}

/* ------------------------------------------ a second Claude account's view */

/*
 * A second Claude Code account runs with `CLAUDE_CONFIG_DIR` set to its own
 * home (shared/accounts.ts), so the CLI reads ITS `~/.claude.json` — which
 * holds that account's sign-in and nothing the user set up under Default. So
 * every user-scope server of the Default account (`claude mcp add -s user`)
 * vanished on the second account. It is handed them at launch instead, the way
 * Claude takes Stoke's own servers: one generated owner-only `--mcp-config`
 * file (`claudeMcpConfigs`), never a write into either `.claude.json` (gotcha
 * 38). A name the account's own config already defines is its own and is never
 * shadowed; an http server goes as its URL and its configured headers alone —
 * an `oauth` block is not read and Claude's `mcpOAuth` sign-ins are never read
 * or copied (gotcha 36), so the second account signs in to it itself.
 */

export interface AccountMcpMirror {
  /** The Default account's user-scope servers this account is handed, in their order. */
  servers: McpServerSpec[]
  /** Default user-scope names this account's own config already defines: its own wins. */
  own: string[]
  /** Default user-scope servers that cannot be passed on, and why. */
  refused: McpRefusal[]
  /** Every server name this account knows here — its own user and local scope, the folder's `.mcp.json` chain, what it turned off. */
  accountNames: string[]
}

export const NO_ACCOUNT_MIRROR: AccountMcpMirror = { servers: [], own: [], refused: [], accountNames: [] }

/**
 * What a non-default Claude account is handed of the Default account's
 * user-scope servers, for one launch folder (`projectKey`, main's
 * `claudeProjectKey`) or for none (the account row, user scope only).
 *
 * Skipped: a name the ACCOUNT knows here — its `~/.claude.json` user scope, its
 * local scope for this folder and the names it turned off there, and the
 * folder's `.mcp.json` chain (which both accounts read) — so nothing of its own
 * is ever shadowed; and a name the Default account turned off in this folder,
 * which it would not load here either. Everything else goes through
 * `specFromClaudeEntry`, which is what keeps an http server to its URL and its
 * configured headers.
 */
export function accountMcpMirror(input: {
  defaultJson: unknown
  accountJson: unknown
  projectKey?: string | null
  projectMcpJson?: unknown
  env?: Readonly<Record<string, string | undefined>>
}): AccountMcpMirror {
  const key = input.projectKey ?? null
  const projectOf = (json: unknown): Record<string, unknown> => {
    if (!key || !isRecord(json) || !isRecord(json.projects)) return {}
    const p = json.projects[key]
    return isRecord(p) ? p : {}
  }
  const names = (v: unknown): string[] =>
    isRecord(v) ? Object.keys(v) : Array.isArray(v) ? v.filter((n): n is string => typeof n === 'string') : []
  const account = isRecord(input.accountJson) ? input.accountJson : {}
  const accountProject = projectOf(account)
  const accountNames = new Set<string>([
    ...names(account.mcpServers),
    ...names(accountProject.mcpServers),
    ...names(accountProject.disabledMcpServers),
    ...(isRecord(input.projectMcpJson) ? names(input.projectMcpJson.mcpServers) : [])
  ])
  const defaultOff = new Set(names(projectOf(input.defaultJson).disabledMcpServers))
  const user = isRecord(input.defaultJson) && isRecord(input.defaultJson.mcpServers) ? input.defaultJson.mcpServers : {}
  const out: AccountMcpMirror = { servers: [], own: [], refused: [], accountNames: [...accountNames] }
  for (const [name, raw] of Object.entries(user)) {
    if (defaultOff.has(name)) continue
    if (accountNames.has(name)) {
      out.own.push(name)
      continue
    }
    const parsed = specFromClaudeEntry(name, raw, input.env)
    if (parsed.ok) out.servers.push(parsed.spec)
    else out.refused.push({ name, reason: parsed.reason })
  }
  return out
}

/**
 * One Claude launch's `--mcp-config` servers on a non-default account: the
 * browser and Stoke-held servers it was already getting (minus a Stoke-held one
 * whose name the account's own config uses), then the Default account's
 * user-scope servers (`accountMcpMirror`). A name already on the list is not
 * added twice.
 */
export function claudeAccountServers(launch: readonly McpServerSpec[], mirror: AccountMcpMirror): McpServerSpec[] {
  const own = new Set(mirror.accountNames)
  const out = launch.filter((s) => s.name === STOKE_BROWSER_SERVER || !own.has(s.name))
  const have = new Set(out.map((s) => s.name))
  for (const s of mirror.servers) {
    if (have.has(s.name)) continue
    have.add(s.name)
    out.push(s)
  }
  return out
}

/** What Settings says on a Claude account's row: names and reasons only, never a value. */
export interface AccountMcpSummary {
  /** Default user-scope servers this account is handed at launch. */
  passed: string[]
  /** Default names its own config defines, which it keeps. */
  own: string[]
  refused: McpRefusal[]
  /** Why nothing could be worked out (a config that could not be read), or null. */
  error: string | null
}

export function accountMcpSummary(mirror: AccountMcpMirror, error: string | null = null): AccountMcpSummary {
  return { passed: mirror.servers.map((s) => s.name), own: [...mirror.own], refused: mirror.refused.map((r) => ({ ...r })), error }
}

/** The row's lines, in the order they read. Empty when Default has no user-scope server at all. */
export function accountMcpLines(s: AccountMcpSummary): string[] {
  if (s.error) return [s.error]
  const list = (xs: readonly string[]): string => (xs.length > 4 ? `${xs.slice(0, 4).join(', ')} and ${xs.length - 4} more` : xs.join(', '))
  const lines: string[] = []
  if (s.passed.length) {
    lines.push(`Also gets your Default account’s MCP ${s.passed.length === 1 ? 'server' : 'servers'}: ${list(s.passed)}`)
  }
  if (s.own.length) lines.push(`Keeps its own ${list(s.own)}, which Default has too`)
  for (const r of s.refused) lines.push(`Not passed on: ${r.name} — ${r.reason}`)
  return lines
}

/**
 * The names Codex's own config.toml defines under `mcp_servers`, from its
 * text — `[mcp_servers.x]`, `[mcp_servers."x"]`, `[mcp_servers.x.env]`, and
 * `x = …` / `x.command = …` lines inside `[mcp_servers]` or dotted at the top
 * level. Not a TOML parser: a name it misses is merged into by `-c`, which is
 * what happened to every name before this existed, and a false hit only skips
 * a server.
 */
export function codexConfiguredServers(toml: string): string[] {
  const names = new Set<string>()
  const key = String.raw`(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))`
  const header = new RegExp(String.raw`^\s*\[\s*mcp_servers\s*\.\s*${key}`)
  const dotted = new RegExp(String.raw`^\s*mcp_servers\s*\.\s*${key}`)
  const inTable = new RegExp(String.raw`^\s*${key}\s*[.=]`)
  let section = ''
  for (const line of toml.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    if (t.startsWith('[')) {
      section = t
      const m = header.exec(t)
      if (m) names.add(m[1] ?? m[2] ?? m[3])
      continue
    }
    if (section === '') {
      const m = dotted.exec(t)
      if (m) names.add(m[1] ?? m[2] ?? m[3])
    } else if (/^\[\s*mcp_servers\s*\]$/.test(section)) {
      const m = inTable.exec(t)
      if (m) names.add(m[1] ?? m[2] ?? m[3])
    }
  }
  return [...names]
}

/* ------------------------------------------------------ what Settings shows */

/** One server as Settings lists it: never a value, argument or header — only what it is. */
export interface McpServerSummary {
  name: string
  transport: McpTransport
  /** The command's program, or the URL's origin: enough to recognise, nothing secret. */
  detail: string
  /** Why its URL may carry a key (`urlInArgvProblem`) — so Codex, which could take it only in argv, is never handed it. */
  urlProblem?: string
}

export interface McpCatalog {
  /** Claude Code's user-scope servers, in its order. */
  user: McpServerSummary[]
  /** Local-scope servers, each with the folders that define it. */
  local: (McpServerSummary & { folders: string[] })[]
  /**
   * Project-scope servers — a known folder's `.mcp.json` chain — that Claude
   * Code has been allowed to run there, each with those folders. A tick is a
   * name, so one is handed only where the launch folder's chain defines it.
   */
  project: (McpServerSummary & { folders: string[] })[]
  /** `.mcp.json` servers Claude Code has not been allowed to run in any folder that defines them. */
  unapproved: { name: string; folders: string[] }[]
  /** Loaded by Claude, not passable, and why. */
  refused: McpRefusal[]
  /**
   * Per agent, the names its OWN user-level config defines (Codex's
   * config.toml, Kimi's mcp.json, Vibe's config.toml, OpenCode's and Kilo's
   * config, Qwen's settings.json, Copilot's mcp-config.json): Stoke never hands
   * it a server of that name. A launch also skips the names the FOLDER's own
   * config defines (main's `agentOwnMcp`), which Settings cannot know.
   */
  own: Partial<Record<CodingCliId, string[]>>
  /** Why `~/.claude.json`, or some folder's `.mcp.json`, could not be read — or null. */
  error: string | null
}

/**
 * One known folder's project scope, as main read it: the merged `.mcp.json`
 * chain (`mergeMcpJsons`) and the approvals its settings layers give
 * (trust-gated, as at launch). `~/.claude.json`'s own `projects[key]` copy is
 * folded in by `mcpCatalog`.
 */
export interface ProjectMcpRead {
  mcpJson: unknown
  approvals: McpJsonApprovals
}

export function summarize(spec: McpServerSpec): McpServerSummary {
  let detail = ''
  if (spec.transport === 'stdio') detail = spec.command.split(/[\\/]/).pop() ?? spec.command
  else {
    try {
      detail = new URL(spec.url).origin
    } catch {
      detail = ''
    }
  }
  const urlProblem = urlInArgvProblem(spec)
  return { name: spec.name, transport: spec.transport, detail, ...(urlProblem ? { urlProblem } : {}) }
}

/**
 * Settings' view of Claude Code's servers: the user scope, every project's
 * local-scope servers, and every known folder's project scope (`projectMcp`,
 * keyed like `projects`), each folded by name — a name listed in an earlier
 * scope is not listed again, since a tick is a name. A project server counts
 * only where Claude Code may run it (approved, not turned off), the same
 * test a launch applies. No env value, argument or header ever leaves main.
 */
export function mcpCatalog(
  claudeJson: unknown,
  own: Partial<Record<CodingCliId, string[]>>,
  error: string | null,
  env: Readonly<Record<string, string | undefined>> = {},
  projectMcp: Readonly<Record<string, ProjectMcpRead>> = {}
): McpCatalog {
  const root = isRecord(claudeJson) ? claudeJson : {}
  const user: McpServerSummary[] = []
  const refused: McpRefusal[] = []
  if (isRecord(root.mcpServers)) {
    for (const [name, raw] of Object.entries(root.mcpServers)) {
      const p = specFromClaudeEntry(name, raw, env)
      if (p.ok) user.push(summarize(p.spec))
      else refused.push({ name, reason: p.reason })
    }
  }
  const local = new Map<string, McpServerSummary & { folders: string[] }>()
  if (isRecord(root.projects)) {
    for (const [folder, proj] of Object.entries(root.projects)) {
      if (!isRecord(proj) || !isRecord(proj.mcpServers)) continue
      for (const [name, raw] of Object.entries(proj.mcpServers)) {
        const p = specFromClaudeEntry(name, raw, env)
        if (!p.ok) continue
        const have = local.get(name)
        if (have) have.folders.push(folder)
        else local.set(name, { ...summarize(p.spec), folders: [folder] })
      }
    }
  }
  const userNames = new Set(user.map((s) => s.name))
  const localRows = [...local.values()].filter((s) => !userNames.has(s.name))

  const project = new Map<string, McpServerSummary & { folders: string[] }>()
  const unapproved = new Map<string, string[]>()
  const projects = isRecord(root.projects) ? root.projects : {}
  for (const [folder, read] of Object.entries(projectMcp)) {
    const servers = isRecord(read.mcpJson) && isRecord(read.mcpJson.mcpServers) ? read.mcpJson.mcpServers : {}
    const entry = isRecord(projects[folder]) ? (projects[folder] as Record<string, unknown>) : {}
    const approvals = foldApprovals(read.approvals, entry)
    const off = new Set(Array.isArray(entry.disabledMcpServers) ? entry.disabledMcpServers : [])
    for (const [name, raw] of Object.entries(servers)) {
      // Turned off in /mcp, or refused at Claude's own prompt: not offered.
      if (off.has(name) || approvals.disabled.includes(name)) continue
      if (!approvals.enableAll && !approvals.enabled.includes(name)) {
        unapproved.set(name, [...(unapproved.get(name) ?? []), folder])
        continue
      }
      const p = specFromClaudeEntry(name, raw, env)
      if (!p.ok) {
        if (!refused.some((r) => r.name === name)) refused.push({ name, reason: p.reason })
        continue
      }
      const have = project.get(name)
      if (have) have.folders.push(folder)
      else project.set(name, { ...summarize(p.spec), folders: [folder] })
    }
  }
  const listed = new Set([...userNames, ...localRows.map((s) => s.name)])
  const projectRows = [...project.values()].filter((s) => !listed.has(s.name))
  for (const s of projectRows) listed.add(s.name)
  return {
    user,
    local: localRows,
    project: projectRows,
    unapproved: [...unapproved.entries()].filter(([name]) => !listed.has(name)).map(([name, folders]) => ({ name, folders })),
    refused,
    own,
    error
  }
}
