/*
 * The coding agents a user has chosen, how each one is pointed at a model, and
 * what Stoke runs to install one.
 *
 * Every override here happens AT LAUNCH — arguments and environment for one
 * process — and never as a write to the CLI's own config file. That is the same
 * rule gotcha 38 makes for `~/.claude.json`, for the same reason: those files
 * belong to tools that rewrite them, and a Stoke setting that lived there would
 * outlive Stoke and surprise the user the next time they ran the tool alone.
 * Each mechanism below was checked against the real CLI on 2026-09-19:
 *
 *   codex     `-c model_provider=… -c model_providers.<id>.{name,base_url,
 *             env_key}` and `-m`. `codex doctor` reported the provider and its
 *             key env var as present, and probed the route (HTTP 200). Codex
 *             speaks only the Responses API (`wire_api` has one value left).
 *             MCP likewise: `-c mcp_servers.<id>.*`, listed by `codex mcp get`
 *             with nothing written to config.toml (mcpServers.ts `codexMcp`).
 *   opencode  OpenRouter is built in and wants `OPENROUTER_API_KEY` plus
 *             `-m openrouter/<model>`. Anything else rides in
 *             `OPENCODE_CONFIG_CONTENT`, an inline config the CLI layers on top
 *             of the user's own — providers and MCP servers alike.
 *   grok      `GROK_MODELS_BASE_URL` + `XAI_API_KEY` switch Grok Build to API-key
 *             auth against that endpoint; `-m` is REQUIRED there, because without
 *             it the default became the first model OpenRouter listed.
 *   pi        `--provider openrouter --model <m>` with `OPENROUTER_API_KEY`. A
 *             custom endpoint needs a provider registered by an extension file,
 *             loaded with `-e`; Stoke writes that file under its own userData
 *             and the endpoint itself arrives through the environment.
 *
 * On an agent's own sign-in the one thing Stoke adds is its Default model,
 * through the flag `CodingCli.modelArgs` names — each read out of the vendor's
 * own artefact or docs on 2026-09-30 (codingClis.ts says which).
 *
 * Keys only ever travel in the environment, never in argv, where any other
 * process on the machine could read them from the process table.
 *
 * Pure, and compiled by both tsconfigs, so no `node:` import (gotcha 27);
 * `scripts/verify-agents.mts` runs it under strip-types, so shared imports are
 * relative with `.ts` (gotcha 78).
 */
import {
  capsFor,
  CODING_CLIS,
  cliFor,
  cliIdOf,
  DEFAULT_CLI,
  isClaudeCode,
  isCodingCliId,
  isSafeResumeId,
  type CodingCliId,
  type InstallPlatform
} from './codingClis.ts'
import { hydrateAgentColors, type AgentColors } from './agentColors.ts'
import { accountEnv, accountProblem, hydrateDefaultAccounts, type AgentAccount } from './accounts.ts'
import {
  codexMcp,
  copilotMcpFile,
  DEFAULT_AGENT_MCP,
  ENV_VIBE_MCP,
  hydrateAgentMcp,
  kimiMcpFile,
  mcpFileName,
  opencodeMcp,
  piMcp,
  qwenMcpFile,
  vibeMcpEnv,
  type AgentMcpSettings,
  type McpRefusal,
  type McpServerSpec,
  type PlanFile
} from './mcpServers.ts'

export const OPENROUTER_OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'

export type EndpointMode = 'default' | 'openrouter' | 'custom'

export interface AgentEndpoint {
  mode: EndpointMode
  /**
   * The model to ask for. Required off `default`: Grok Build picks the FIRST
   * model an endpoint lists when it is not told, which on OpenRouter was an
   * obscure 27B model, and the others refuse to start without one.
   *
   * On `default` — the agent's own sign-in — it is the "Default model" in
   * Settings › Agents, optional, and passed only through the agent's own
   * confirmed flag (`CodingCli.modelArgs`); blank lets the agent choose. One
   * field for both, never a second "default model" beside it (gotcha 57), so a
   * mode change clears it: an id means something only to the endpoint it was
   * chosen for — and a file from before format 2 has its default-mode models
   * cleared on the first read (`AGENTS_FORMAT`, `upgradeEndpoint`), because
   * those were exactly such leftovers. Only ever an id `isModelId` accepts,
   * since it reaches argv.
   */
  model: string
  /** A custom endpoint's base URL — the `/v1` root of an OpenAI-style API. */
  baseUrl: string
  /**
   * A custom endpoint's key. OpenRouter uses the one key in Settings ›
   * Providers, shared with Claude Code, rather than a copy per agent.
   */
  apiKey: string
}

export interface AgentSettings {
  /**
   * The agents the user said they use. `null` until the picker has been
   * answered once, which is what shows it — on a fresh install AND on the first
   * launch after an update that introduced it, since both are "never asked".
   */
  chosen: CodingCliId[] | null
  /** Per-agent endpoint. An absent entry is `default`: the CLI's own sign-in. */
  endpoints: Partial<Record<CodingCliId, AgentEndpoint>>
  /**
   * The agent a NEW session starts when nothing names one: the launcher's
   * Start, the sidebar's new-session action, Start on launch, scratch, a bare
   * `stoke .` and the phone's New session sheet. Never read as it is stored —
   * always through `resolveDefaultAgent`, so an agent uninstalled or unticked
   * since it was picked can never leave Start pointing at nothing.
   *
   * Only new sessions. A resume, a relaunch and `--continue` name a Claude Code
   * transcript and stay Claude's (gotcha 81), and an SSH host's remote command
   * is always `claude` (gotcha 19).
   */
  defaultCli: CodingCliId
  /**
   * Hand Claude Code the skills in `~/.agents/skills` it would not otherwise
   * see, as a plugin for each local session (`--plugin-dir`, skillsProject.ts).
   * On by default: it adds only skills every other agent already reads, links
   * rather than copies, and writes nothing into Claude's own folders. Off is
   * the way out on a machine whose policy refuses the flag.
   */
  shareSkillsToClaude: boolean
  /**
   * Which MCP servers each agent is handed at launch, by name, and the servers
   * Stoke itself holds (mcpServers.ts). Claude Code's own list is never stored
   * here — it is read from `~/.claude.json` at every launch.
   */
  mcp: AgentMcpSettings
  /**
   * The small tag on a tab whose agent is not the default one (`tabLabel`):
   * whether it is drawn, and what it says per agent. With it off, the agent's
   * colour and the tab's tooltip still tell a Codex tab from a Claude tab in
   * the same folder (QA L16).
   */
  tag: AgentTag
  /** The user's colour per agent, over `AGENT_SEEDS` (agentColors.ts). */
  colors: AgentColors
  /**
   * Per agent, the account a launch that names none starts on (accounts.ts).
   * Absent is the implicit Default account: the agent's own sign-in, no
   * variable set — exactly what every launch was before accounts. Read only
   * through `resolveLaunchAccount`, which falls back to Default when the
   * account has since been removed.
   */
  defaultAccount: Partial<Record<CodingCliId, string>>
  /**
   * The shape this block was written in (`AGENTS_FORMAT`). Absent in every
   * file from before it existed, which reads as 1. Always this build's number
   * once hydrated, so the upgrade it keys runs once per file.
   */
  format: number
}

export interface AgentTag {
  show: boolean
  /** Per agent; absent means the executable name (`agentTagText`). */
  labels: Partial<Record<CodingCliId, string>>
}

/** A tag is a label on a 12rem tab, not a title: longer is cut, not wrapped. */
export const AGENT_TAG_MAX = 16

/**
 * The shape `agents` is stored in, written into the block (`format`) so that
 * a file from an earlier build can be told apart on its first read here.
 *
 *   1  (no number) A model on an agent's OWN sign-in did nothing. Settings
 *      never drew the field there, and switching an endpoint from OpenRouter
 *      or a custom endpoint back to "Its own sign-in" kept the model it had.
 *   2  That model is the agent's Default model, passed at launch through the
 *      agent's own flag (`CodingCli.modelArgs`) and named in the status bar.
 *
 * So a format-1 default-mode model is a leftover nobody could see, not a
 * choice: kept, a Codex once tried on OpenRouter would launch on its ChatGPT
 * sign-in as `codex -m anthropic/claude-sonnet-5`. `upgradeEndpoint` clears it.
 * A file an older build rewrote loses the number (its hydrate names no such
 * key) and is upgraded again, which is right: that build's mode switch keeps
 * the model too.
 */
export const AGENTS_FORMAT = 2

/** The format a stored `agents.format` names; anything but a whole number ≥ 1 is 1. */
export function agentsFormatOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 1
}

/**
 * One hydrated endpoint, brought from format `from` up to `AGENTS_FORMAT`.
 *
 * Only the model: a default-mode endpoint's base URL and key reach neither
 * argv nor the environment (every `agentLaunchPlan` case is gated on the
 * mode), and Settings keeps them across a mode switch on purpose, so "custom,
 * then own sign-in, then custom" does not make the user retype a key.
 */
export function upgradeEndpoint(ep: AgentEndpoint, from: number): AgentEndpoint {
  if (from < 2 && ep.mode === 'default' && ep.model) return { ...ep, model: '' }
  return ep
}

export const DEFAULT_AGENTS: AgentSettings = {
  chosen: null,
  endpoints: {},
  defaultCli: DEFAULT_CLI,
  shareSkillsToClaude: true,
  mcp: DEFAULT_AGENT_MCP,
  tag: { show: true, labels: {} },
  colors: {},
  defaultAccount: {},
  format: AGENTS_FORMAT
}

export const DEFAULT_ENDPOINT: AgentEndpoint = { mode: 'default', model: '', baseUrl: '', apiKey: '' }

function isEndpointMode(v: unknown): v is EndpointMode {
  return v === 'default' || v === 'openrouter' || v === 'custom'
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/** Longer than any real model id; a pasted paragraph is not one. */
export const MODEL_ID_MAX = 200

/**
 * What a model id may be before it goes anywhere near argv.
 *
 * The model is an argument to someone else's binary, and on Windows an npm
 * agent is a `.cmd` shim that `spawnSpec` runs through `cmd.exe /c`, which
 * reads `& | ^ < > ( ) % !` and quotes as its own syntax (gotcha 13) — so a
 * model of `x & calc` would be two commands. Every real id seen here fits this
 * set: `gpt-6.1-sol`, `anthropic/claude-sonnet-5`, `qwen3-coder:30b`,
 * `claude-opus-5[1m]`, `@cf/meta/llama-4`, `provider/id:high`. It must also
 * start with a letter, digit, `_` or `@`: an id beginning `-` would be read by
 * the agent's option parser as a flag of its own (`-m --yolo`).
 */
const MODEL_ID = /^[A-Za-z0-9_@][A-Za-z0-9._:/@+[\]-]*$/

export function isModelId(v: string): boolean {
  return v.length <= MODEL_ID_MAX && MODEL_ID.test(v)
}

/**
 * Repair a stored endpoint. Rebuilt from named keys, like `hydrateProviders`
 * and the ui.ts clamps: a field this does not name does not survive, so a new
 * field needs a line here in the same change.
 *
 * A model that is not a model id is dropped rather than kept: `setSettings`
 * hydrates every write, so nothing that would reach argv unchecked is ever
 * stored — a hand-edited file included. Off `default` that leaves no model,
 * and `endpointProblem` refuses the launch with a sentence saying so.
 */
export function hydrateEndpoint(raw: unknown): AgentEndpoint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_ENDPOINT }
  const r = raw as Partial<AgentEndpoint>
  const model = str(r.model)
  return {
    mode: isEndpointMode(r.mode) ? r.mode : 'default',
    model: isModelId(model) ? model : '',
    baseUrl: str(r.baseUrl).replace(/\/+$/, ''),
    apiKey: str(r.apiKey)
  }
}

/**
 * One stored tag label, or '' for none: whitespace runs folded to a space,
 * trimmed, and cut to `AGENT_TAG_MAX` characters (by code point, so an emoji
 * is never split in half).
 */
export function cleanTagLabel(v: unknown): string {
  if (typeof v !== 'string') return ''
  return Array.from(v.replace(/\s+/g, ' ').trim()).slice(0, AGENT_TAG_MAX).join('').trim()
}

/**
 * Repair the tag block. `show` is on unless it is literally `false`, so an
 * older file (no block) and junk both keep the tag the app always drew; labels
 * survive only for ids this build knows, and an empty one is not stored.
 */
export function hydrateAgentTag(raw: unknown): AgentTag {
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as { show?: unknown; labels?: unknown }) : {}
  const labels: Partial<Record<CodingCliId, string>> = {}
  if (r.labels && typeof r.labels === 'object' && !Array.isArray(r.labels)) {
    for (const [id, v] of Object.entries(r.labels)) {
      const label = cleanTagLabel(v)
      if (isCodingCliId(id) && label) labels[id] = label
    }
  }
  return { show: r.show !== false, labels }
}

/** What an agent's tag says: the user's label, else its executable's name. */
export function agentTagText(id: CodingCliId, labels: Partial<Record<CodingCliId, string>>): string {
  return labels[id]?.trim() || cliFor(id).bins.posix[0]
}

export function hydrateAgents(raw: unknown): AgentSettings {
  // No block at all is a fresh install or a file from before agents: no
  // endpoint to upgrade, so it is simply this build's format.
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      ...DEFAULT_AGENTS,
      endpoints: {},
      mcp: hydrateAgentMcp(undefined, isCodingCliId),
      tag: hydrateAgentTag(undefined),
      colors: {},
      defaultAccount: {}
    }
  }
  const r = raw as {
    chosen?: unknown
    endpoints?: unknown
    defaultCli?: unknown
    shareSkillsToClaude?: unknown
    mcp?: unknown
    tag?: unknown
    colors?: unknown
    defaultAccount?: unknown
    format?: unknown
  }
  const from = agentsFormatOf(r.format)
  // An array, deduplicated and filtered to ids this build knows. Anything else
  // — a string, an object, junk — is "never asked", which re-shows the picker
  // rather than hiding every agent on the strength of a bad value.
  const chosen = Array.isArray(r.chosen)
    ? [...new Set(r.chosen.filter(isCodingCliId))]
    : null
  const endpoints: Partial<Record<CodingCliId, AgentEndpoint>> = {}
  if (r.endpoints && typeof r.endpoints === 'object' && !Array.isArray(r.endpoints)) {
    for (const [id, ep] of Object.entries(r.endpoints)) {
      // Claude's endpoint is Settings › Providers; an entry here would be a
      // second writer for the same thing (gotcha 57).
      if (!isCodingCliId(id) || isClaudeCode(id)) continue
      const h = upgradeEndpoint(hydrateEndpoint(ep), from)
      if (h.mode !== 'default' || h.model || h.baseUrl || h.apiKey) endpoints[id] = h
    }
  }
  // An id this build does not know — a newer build's agent, junk — is Claude
  // Code, the same answer `cliIdOf` gives a restored tab (codingClis.ts).
  return {
    chosen,
    endpoints,
    defaultCli: cliIdOf(r.defaultCli),
    // Only an explicit false turns it off: every file written before the
    // setting existed has no key, and reads as the default.
    shareSkillsToClaude: r.shareSkillsToClaude !== false,
    mcp: hydrateAgentMcp(r.mcp, isCodingCliId),
    tag: hydrateAgentTag(r.tag),
    colors: hydrateAgentColors(r.colors),
    defaultAccount: hydrateDefaultAccounts(r.defaultAccount),
    // Upgraded above, so this build's number whatever was read — a newer
    // build's included, since only this build's fields survived the hydrate.
    format: AGENTS_FORMAT
  }
}

/**
 * Who shows in the launcher: what was chosen, in table order. Before the
 * picker has been answered, everything installed — the behaviour this setting
 * replaced, so an update changes nothing until the user makes a choice.
 */
export function visibleAgents(chosen: CodingCliId[] | null, installed: ReadonlySet<CodingCliId>): CodingCliId[] {
  return CODING_CLIS.map((c) => c.id).filter((id) =>
    chosen === null ? installed.has(id) : chosen.includes(id) && installed.has(id)
  )
}

/**
 * Which agents count as installed: what the PATH lookup found, plus Claude
 * Code whenever its own probe answered — `probeClaude` honours the explicit
 * path in Settings, which the table-wide lookup does not, so a `claude` known
 * only through that override would otherwise read as missing and hand Start
 * to some other agent.
 */
export function installedAgents(
  found: readonly { id: CodingCliId; path: string | null }[],
  claudeRunnable: boolean
): Set<CodingCliId> {
  const out = new Set(found.filter((c) => c.path).map((c) => c.id))
  if (claudeRunnable) out.add('claude')
  return out
}

/**
 * The agent a new session actually starts, from the stored default and what
 * the launcher can offer (`visibleAgents`: installed AND chosen).
 *
 * The stored value wins when it is on offer. Otherwise Claude Code, when it is;
 * otherwise the first agent on offer; otherwise Claude Code, whose own
 * not-runnable message is the honest one to show. So a default whose agent was
 * uninstalled or unticked never breaks Start — it falls back instead.
 *
 * `visible` null means "not known yet" (detection or Claude's probe has not
 * answered): the stored value is trusted until it can be checked, rather than
 * flashing Claude Code on the button for the first second of every launch.
 */
export function resolveDefaultAgent(defaultCli: CodingCliId, visible: readonly CodingCliId[] | null): CodingCliId {
  if (visible === null) return defaultCli
  if (visible.includes(defaultCli)) return defaultCli
  if (visible.includes(DEFAULT_CLI)) return DEFAULT_CLI
  return visible[0] ?? DEFAULT_CLI
}

/* ------------------------------------------------------------ launching */

export interface LaunchPlan {
  /** Appended to the CLI's argv. */
  args: string[]
  /** Merged over the inherited environment. Where every key travels. */
  env: Record<string, string>
  /**
   * The model this launch asks for (`launchModel`), '' when the agent picks.
   * Reported back to the renderer as the tab's model, so the status bar names
   * exactly what the argv or environment carried.
   */
  model: string
  /**
   * Files this launch needs on disk before the spawn, written owner-only
   * (0600) by main: an MCP config for an agent that takes only a path. Absent
   * when there are none.
   */
  files?: PlanFile[]
  /** MCP servers this launch could not hand the agent, and why. Absent when none were. */
  mcpSkipped?: McpRefusal[]
}

export type LaunchPlanResult = { ok: true; plan: LaunchPlan } | { ok: false; message: string }

export interface LaunchPlanInput {
  id: CodingCliId
  endpoint: AgentEndpoint | undefined
  /** Settings › Providers' OpenRouter key, shared with Claude Code. */
  openrouterKey: string
  /** Continue the latest session in the folder, where the CLI can. */
  continueLast: boolean
  /**
   * Reopen this one session, where the CLI can be handed an id (`resumeArgs`)
   * — a chat found by search. Wins over `continueLast`. An id `isSafeResumeId`
   * refuses, or a CLI with no `resumeArgs`, refuses the launch rather than
   * starting something the user did not pick.
   */
  resumeId?: string | null
  /**
   * The MCP servers this launch hands the agent, already resolved
   * (`serversForLaunch`): Stoke's browser server first, with its bearer, when
   * it is ticked and up, then the user's ticks. Ignored for an agent whose
   * `CLI_CAPS.mcp` is `none`.
   */
  mcp: readonly McpServerSpec[]
  /**
   * Where a file-taking agent's MCP config goes, given the file's name — main's
   * owner-only folder. Null when it cannot be written, and then Qwen and
   * Copilot get no MCP rather than a flag naming nothing.
   */
  mcpFileFor?: ((name: string) => string) | null
  /**
   * Server names the agent's own config already defines — its user config and
   * the launch folder's layers (main's `ownMcpSources`: Codex, OpenCode, Kilo,
   * Qwen, Copilot, Kimi, Vibe): skipped, never merged into or replaced for the
   * session.
   */
  mcpOwn?: readonly string[]
  /**
   * The agent's OWN MCP files to name beside Stoke's, because naming any file
   * stops it reading its default (Kimi: `--mcp-config-file` given means
   * `~/.kimi/mcp.json` is not loaded). Only files that exist; main checks.
   */
  mcpKeep?: readonly string[]
  /** Where Stoke keeps Pi's provider extension, for a custom endpoint. */
  piExtensionPath: string | null
  /**
   * The account this launch runs on (`resolveLaunchAccount`), or null/absent
   * for the Default account — the agent's own sign-in, nothing added. Its
   * environment is merged LAST, over the endpoint's, and a key account is
   * refused beside an endpoint that brings a key of its own (`accountProblem`).
   */
  account?: AgentAccount | null
  /** Where Stoke keeps Pi's MCP extension (`PI_MCP_EXTENSION`); null when it could not be written. */
  piMcpExtensionPath?: string | null
}

/**
 * A TOML basic string for a `codex -c key=value`. Codex parses the value as
 * TOML and falls back to the raw text, so an unquoted URL would silently be a
 * string anyway — but a value with a `#` or a `=` in it would not. JSON's
 * string escapes are a subset of TOML's basic-string escapes.
 */
export function tomlString(s: string): string {
  return JSON.stringify(s)
}

/** A custom endpoint's URL must be http(s) and have a host; nothing else is sent anywhere. */
export function isEndpointUrl(s: string): boolean {
  try {
    const u = new URL(s)
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname
  } catch {
    return false
  }
}

/**
 * Local servers (Ollama, LM Studio, llama.cpp) take no key, and several CLIs
 * refuse to start with an EMPTY key variable. They ignore the value; this is
 * what they receive.
 */
export const NO_KEY = 'none'

/** Stoke's own names, so nothing it sets can collide with the user's config. */
const PROVIDER_OPENROUTER = 'stoke_openrouter'
const PROVIDER_CUSTOM = 'stoke_custom'
export const ENV_OPENROUTER_KEY = 'STOKE_OPENROUTER_API_KEY'
export const ENV_CUSTOM_KEY = 'STOKE_CUSTOM_API_KEY'
export const ENV_CUSTOM_BASE_URL = 'STOKE_CUSTOM_BASE_URL'
export const ENV_CUSTOM_MODEL = 'STOKE_CUSTOM_MODEL'
export { ENV_MCP_TOKEN } from './mcpServers.ts'

/**
 * What `endpointProblem` says about a model that is not a model id — shared so
 * the settings field can say it while the id is being typed, before the store
 * would drop it.
 */
export function modelIdProblem(label: string): string {
  return `${label}’s model is not a model id. Use letters, digits and . _ : / @ + [ ] -, starting with a letter or digit, and no spaces. Set it in Settings › Agents.`
}

/**
 * What is wrong with an endpoint before anything is spawned, or null.
 *
 * The model is checked first and in every mode: it reaches argv, where
 * `cmd.exe` would read a metacharacter as syntax (`isModelId`). A stored
 * endpoint has been through `hydrateEndpoint` already; this is the second lock,
 * for a value that did not come from the store (a settings draft, a suite).
 */
export function endpointProblem(id: CodingCliId, ep: AgentEndpoint, openrouterKey: string): string | null {
  const cli = cliFor(id)
  if (ep.model && !isModelId(ep.model)) return modelIdProblem(cli.label)
  if (ep.mode === 'default') return null
  if (ep.mode === 'openrouter') {
    if (!cli.endpoints.openrouter) return `${cli.label} cannot be pointed at OpenRouter from Stoke.`
    if (!openrouterKey) return `${cli.label} is set to use OpenRouter, but there is no OpenRouter key. Add one in Settings › Agents › Claude Code › Provider & keys.`
    if (!ep.model) return `${cli.label} is set to use OpenRouter, but no model is chosen. Set one in Settings › Agents.`
    return null
  }
  if (!cli.endpoints.custom) return `${cli.label} cannot be pointed at a custom endpoint from Stoke.`
  if (!isEndpointUrl(ep.baseUrl)) return `${cli.label}’s custom endpoint needs an http(s) base URL. Set it in Settings › Agents.`
  if (!ep.model) return `${cli.label}’s custom endpoint needs a model. Set it in Settings › Agents.`
  return null
}

/**
 * The model a launch of this agent asks for, or '' when the agent chooses:
 * off `default` the endpoint's (required there), on its own sign-in the
 * Default model — but only where the table has a flag to pass it with
 * (`modelArgs`). What the tab carries and the status bar names, and what
 * `agentLaunchPlan` reports in `LaunchPlan.model`, so the two cannot differ.
 */
export function launchModel(id: CodingCliId, ep: AgentEndpoint | undefined): string {
  if (isClaudeCode(id) || !ep?.model || !isModelId(ep.model)) return ''
  if (ep.mode !== 'default') return ep.model
  return cliFor(id).modelArgs ? ep.model : ''
}

/**
 * The arguments and environment one launch of a non-Claude CLI gets.
 *
 * Refuses rather than guesses: a launch that would 401 on its first turn, or
 * silently fall back to the CLI's own sign-in while the user believes it is on
 * OpenRouter, is worse than a message saying which field is empty.
 */
export function agentLaunchPlan(input: LaunchPlanInput): LaunchPlanResult {
  const { id, openrouterKey, continueLast, piExtensionPath } = input
  const cli = cliFor(id)
  const ep = input.endpoint ?? DEFAULT_ENDPOINT
  if (isClaudeCode(id)) return { ok: true, plan: { args: [], env: {}, model: '' } }
  // An agent with no confirmed route takes nothing, and Settings greys it.
  const files: PlanFile[] = []
  const skipped: McpRefusal[] = []
  // A name the agent's own config already uses is its own server: never
  // replaced or merged into for a session. (Codex says so per name below.)
  const ownSet = new Set(id === 'codex' ? [] : (input.mcpOwn ?? []))
  const mcp = (capsFor(id).mcp === 'none' ? [] : input.mcp).filter((s) => {
    if (!ownSet.has(s.name)) return true
    skipped.push({ name: s.name, reason: `${cli.label}’s own configuration defines a server with this name` })
    return false
  })
  /** One owner-only file for an agent that takes a path, or null when none can be written. */
  const mcpFile = (content: string): string | null => {
    if (!input.mcpFileFor) {
      skipped.push(...mcp.map((s) => ({ name: s.name, reason: 'Stoke could not write the file this agent reads servers from' })))
      return null
    }
    const path = input.mcpFileFor(mcpFileName(id, content))
    files.push({ path, content })
    return path
  }

  const problem = endpointProblem(id, ep, openrouterKey)
  if (problem) return { ok: false, message: problem }

  const args: string[] = []
  const env: Record<string, string> = {}
  const customKey = ep.apiKey || NO_KEY

  /*
   * On the agent's own sign-in, the Default model through its own confirmed
   * flag, first — ahead of the MCP flags and well ahead of `continueArgs`,
   * since Codex's `resume --last` is a subcommand and its global flags go
   * before it (the order the endpoint `-m` below has always used). Off
   * `default` each case passes the endpoint's model in its own shape instead.
   */
  const model = launchModel(id, ep)
  if (ep.mode === 'default' && model && cli.modelArgs) args.push(...cli.modelArgs(model))

  switch (id) {
    case 'codex': {
      if (ep.mode !== 'default') {
        const pid = ep.mode === 'openrouter' ? PROVIDER_OPENROUTER : PROVIDER_CUSTOM
        const base = ep.mode === 'openrouter' ? OPENROUTER_OPENAI_BASE_URL : ep.baseUrl
        const keyVar = ep.mode === 'openrouter' ? ENV_OPENROUTER_KEY : ENV_CUSTOM_KEY
        args.push(
          '-c', `model_provider=${tomlString(pid)}`,
          '-c', `model_providers.${pid}.name=${tomlString(ep.mode === 'openrouter' ? 'OpenRouter' : 'Custom endpoint')}`,
          '-c', `model_providers.${pid}.base_url=${tomlString(base)}`,
          '-c', `model_providers.${pid}.env_key=${tomlString(keyVar)}`,
          '-m', ep.model
        )
        env[keyVar] = ep.mode === 'openrouter' ? openrouterKey : customKey
      }
      // After the endpoint, so a server can never take a variable it set.
      const out = codexMcp(mcp, input.mcpOwn ?? [], env)
      args.push(...out.args)
      Object.assign(env, out.env)
      skipped.push(...out.skipped)
      break
    }
    // Kilo is built on OpenCode and reads the same inline config under its own
    // name — endpoint and MCP both seen working through KILO_CONFIG_CONTENT.
    case 'kilo':
    case 'opencode': {
      const configVar = id === 'kilo' ? 'KILO_CONFIG_CONTENT' : 'OPENCODE_CONFIG_CONTENT'
      const config: Record<string, unknown> = {}
      if (ep.mode === 'openrouter') {
        env.OPENROUTER_API_KEY = openrouterKey
        args.push('-m', `openrouter/${ep.model}`)
      } else if (ep.mode === 'custom') {
        config.provider = {
          [PROVIDER_CUSTOM]: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Custom endpoint',
            options: { baseURL: ep.baseUrl, apiKey: `{env:${ENV_CUSTOM_KEY}}` },
            models: { [ep.model]: { name: ep.model } }
          }
        }
        env[ENV_CUSTOM_KEY] = customKey
        args.push('-m', `${PROVIDER_CUSTOM}/${ep.model}`)
      }
      if (mcp.length) {
        // Secrets inline rather than as `{env:…}`: substitution inside MCP
        // headers was the one part of this path nobody saw work, and the value
        // is already confined to this process's environment either way.
        config.mcp = opencodeMcp(mcp)
      }
      if (Object.keys(config).length) env[configVar] = JSON.stringify(config)
      break
    }
    case 'aider': {
      // LiteLLM model prefixes: `openrouter/<model>` reads OPENROUTER_API_KEY,
      // `openai/<model>` reads OPENAI_API_BASE and OPENAI_API_KEY.
      if (ep.mode === 'openrouter') {
        env.OPENROUTER_API_KEY = openrouterKey
        args.push('--model', `openrouter/${ep.model}`)
      } else if (ep.mode === 'custom') {
        env.OPENAI_API_BASE = ep.baseUrl
        env.OPENAI_API_KEY = customKey
        args.push('--model', `openai/${ep.model}`)
      }
      break
    }
    case 'grok': {
      if (ep.mode !== 'default') {
        const base = ep.mode === 'openrouter' ? OPENROUTER_OPENAI_BASE_URL : ep.baseUrl
        /*
         * Three variables, not two. With only the models URL and the key, Grok
         * Build probes the key against `{xai_api_base_url}/api-key` — api.x.ai —
         * which answers 400 to a non-xAI key, so the key is treated as unusable
         * and anyone not signed in to grok.com gets "Not signed in" (measured by
         * the fact-check pass, and read in api_key_probe.rs). Pointing the xAI
         * base at the same endpoint turns that probe into a 404, which it treats
         * as "unknown" and lets through. It also sends Grok's other first-party
         * calls there, which is the price of choosing an endpoint by env.
         */
        env.GROK_MODELS_BASE_URL = base
        env.GROK_XAI_API_BASE_URL = base
        env.XAI_API_KEY = ep.mode === 'openrouter' ? openrouterKey : customKey
        args.push('-m', ep.model)
      }
      break
    }
    case 'pi': {
      if (ep.mode === 'openrouter') {
        env.OPENROUTER_API_KEY = openrouterKey
        args.push('--provider', 'openrouter', '--model', ep.model)
      } else if (ep.mode === 'custom') {
        if (!piExtensionPath) return { ok: false, message: 'Stoke could not write Pi’s provider file, so a custom endpoint cannot be used.' }
        env[ENV_CUSTOM_BASE_URL] = ep.baseUrl
        env[ENV_CUSTOM_KEY] = customKey
        env[ENV_CUSTOM_MODEL] = ep.model
        args.push('-e', piExtensionPath, '--provider', PROVIDER_CUSTOM, '--model', ep.model)
      }
      if (mcp.length) {
        if (input.piMcpExtensionPath) {
          args.push('-e', input.piMcpExtensionPath)
          Object.assign(env, piMcp(mcp).env)
        } else {
          skipped.push(...mcp.map((s) => ({ name: s.name, reason: 'Stoke could not write the extension Pi takes servers through' })))
        }
      }
      break
    }
    case 'qwen': {
      // Key in the environment; `--openai-api-key` would put it in argv. The
      // flag for the auth type, because `OPENROUTER_API_KEY` alone is not read
      // ("Missing API key for OpenAI-compatible auth").
      if (ep.mode !== 'default') {
        env.OPENAI_BASE_URL = ep.mode === 'openrouter' ? OPENROUTER_OPENAI_BASE_URL : ep.baseUrl
        env.OPENAI_API_KEY = ep.mode === 'openrouter' ? openrouterKey : customKey
        args.push('--auth-type', 'openai', '-m', ep.model)
      }
      const file = mcp.length ? mcpFile(qwenMcpFile(mcp)) : null
      if (file) args.push('--mcp-config', file)
      break
    }
    case 'kimi': {
      // Kimi Code "synthesizes a temporary provider in memory" from these and
      // writes no config.toml — checked. The type defaults to `kimi`, so it is
      // set to `openai` explicitly.
      if (ep.mode !== 'default') {
        env.KIMI_MODEL_NAME = ep.model
        env.KIMI_MODEL_API_KEY = ep.mode === 'openrouter' ? openrouterKey : customKey
        env.KIMI_MODEL_PROVIDER_TYPE = 'openai'
        env.KIMI_MODEL_BASE_URL = ep.mode === 'openrouter' ? OPENROUTER_OPENAI_BASE_URL : ep.baseUrl
      }
      // Any `--mcp-config-file` stops Kimi reading its own mcp.json, so that
      // file is named too, after Stoke's (`mcpKeep`).
      const file = mcp.length ? mcpFile(kimiMcpFile(mcp)) : null
      if (file) {
        args.push('--mcp-config-file', file)
        for (const keep of input.mcpKeep ?? []) args.push('--mcp-config-file', keep)
      }
      break
    }
    case 'vibe': {
      if (mcp.length) env[ENV_VIBE_MCP] = vibeMcpEnv(mcp)
      break
    }
    case 'copilot': {
      // Copilot's own bring-your-own-provider variables (`copilot help
      // providers`); with them set it needs no GitHub sign-in, and a model is
      // required.
      if (ep.mode !== 'default') {
        env.COPILOT_PROVIDER_BASE_URL = ep.mode === 'openrouter' ? OPENROUTER_OPENAI_BASE_URL : ep.baseUrl
        env.COPILOT_PROVIDER_API_KEY = ep.mode === 'openrouter' ? openrouterKey : customKey
        env.COPILOT_MODEL = ep.model
      }
      const file = mcp.length ? mcpFile(copilotMcpFile(mcp)) : null
      if (file) args.push('--additional-mcp-config', `@${file}`)
      break
    }
  }

  if (input.resumeId) {
    if (!cli.resumeArgs) return { ok: false, message: `${cli.label} cannot reopen a chat by its id.` }
    if (!isSafeResumeId(input.resumeId)) return { ok: false, message: `That ${cli.label} chat id is not one Stoke will pass on.` }
    args.push(...cli.resumeArgs(input.resumeId))
  } else if (continueLast && cli.continueArgs) args.push(...cli.continueArgs)

  const account = input.account ?? null
  if (account) {
    // Main resolves the account against the launch's own agent first; this is
    // the second lock, for a plan built from anything else (a suite, a draft).
    if (account.cli !== id) return { ok: false, message: `${account.label} is not a ${cli.label} account.` }
    const trouble = accountProblem(account, ep.mode)
    if (trouble) return { ok: false, message: trouble }
    Object.assign(env, accountEnv(account))
  }
  const plan: LaunchPlan = { args, env, model }
  if (files.length) plan.files = files
  if (skipped.length) plan.mcpSkipped = skipped
  return { ok: true, plan }
}

/**
 * Pi's provider extension for a custom endpoint. Constant text — the endpoint,
 * model and key all arrive through the environment — so writing it once is
 * enough and nothing secret is ever on disk. Shape proven against Pi 0.85.1:
 * `pi -e <this> --list-models` listed the registered model.
 */
export const PI_PROVIDER_EXTENSION = [
  '// Written by Stoke. Registers the custom endpoint chosen in Stoke’s settings;',
  '// the URL, model and key come from the environment Stoke launches Pi with.',
  'export default function (pi: any) {',
  `  const model = process.env.${ENV_CUSTOM_MODEL}`,
  `  const baseUrl = process.env.${ENV_CUSTOM_BASE_URL}`,
  '  if (!model || !baseUrl) return',
  `  pi.registerProvider('${PROVIDER_CUSTOM}', {`,
  '    baseUrl,',
  `    apiKey: '$${ENV_CUSTOM_KEY}',`,
  "    api: 'openai-completions',",
  '    models: [{ id: model, name: model, reasoning: false, input: [\'text\'],',
  '      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 8192 }]',
  '  })',
  '}',
  ''
].join('\n')

/* ------------------------------------------------------------ installing */

export interface InstallStep {
  id: CodingCliId
  label: string
  command: string
  needs?: string
  note?: string
}

/**
 * PowerShell's `-EncodedCommand` form: base64 of the UTF-16LE bytes. `btoa`
 * rather than Buffer, because this module is shared with the renderer.
 */
export function powershellEncode(script: string): string {
  let bin = ''
  for (let i = 0; i < script.length; i++) {
    const c = script.charCodeAt(i)
    bin += String.fromCharCode(c & 0xff, c >> 8)
  }
  return btoa(bin)
}

/** The environment variable naming the install tab's script file on Windows. */
export const INSTALL_SCRIPT_ENV = 'STOKE_INSTALL_SCRIPT'

/**
 * powershell.exe's argv for the install tab on Windows: a short, FIXED
 * `-EncodedCommand` that reads the script from the file `INSTALL_SCRIPT_ENV`
 * names and runs it as a script block.
 *
 * Not `-File`: a script file is subject to execution policy, and where Group
 * Policy enforces AllSigned the command-line `-ExecutionPolicy Bypass` is
 * overridden, so the tab would die on an unsigned temp file. A script block
 * built from text is not governed by execution policy. And not the whole
 * script encoded, which is what this was before: every step inside is itself
 * encoded, and "select all" measured 29,640 of Windows' 32,767 command-line
 * characters. The file carries the length; the stub carries no path (the path
 * travels as data, gotcha 101) and never changes.
 *
 * Measured under pwsh 7.6.6: the script's own `exit 3` — at top level or in a
 * function — is the process's exit code, a normal finish is 0, and a `throw` is
 * 1, which is what `-File` gave. The variable is removed before the script
 * runs, so no vendor installer inherits it.
 */
export function windowsInstallerArgs(): string[] {
  const stub = [
    `$f = $env:${INSTALL_SCRIPT_ENV}`,
    `Remove-Item Env:${INSTALL_SCRIPT_ENV}`,
    '& ([scriptblock]::Create([IO.File]::ReadAllText($f, [Text.Encoding]::UTF8)))',
    'exit 0'
  ].join('; ')
  return ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', powershellEncode(stub)]
}

/** What installing these would run on this platform, in table order. Unknown or unscripted ids are left out. */
export function installSteps(ids: readonly string[], platform: string): InstallStep[] {
  const want = new Set(ids.filter(isCodingCliId))
  const plat = platform as InstallPlatform
  return CODING_CLIS.filter((c) => want.has(c.id) && c.install[plat]).map((c) => ({
    id: c.id,
    label: c.label,
    command: c.install[plat] as string,
    needs: c.installNeeds,
    note: c.installNote
  }))
}

/**
 * One script that installs each chosen agent in turn, for a terminal tab.
 *
 * In turn, not in parallel: two npm installs racing on the global prefix fail
 * with ENOTEMPTY, and a person watching the tab can follow one at a time. A
 * failure does not stop the rest — each step's status is kept and printed at
 * the end, and the script exits non-zero if any failed, which is what the tab's
 * exit card reads.
 *
 * Built only from the table above and ids it validates, so nothing the
 * renderer sends can become part of a command.
 */
export function installScript(ids: readonly string[], platform: string): string | null {
  return scriptFor(installSteps(ids, platform), platform)
}

/**
 * The script for a given list of steps. Separate from `installScript` so a
 * suite can EXECUTE the wrapper with a synthetic step — never a table command:
 * a test that once swapped a vendor URL with `String.replace` swapped only its
 * first occurrence (the printed one), ran the real installers, and upgraded
 * the machine's Codex and installed Pi globally.
 */
export function scriptFor(steps: readonly InstallStep[], platform: string): string | null {
  if (!steps.length) return null
  if (platform === 'win32') {
    const lines = [
      '$failed = @()',
      /*
       * The PATH a NEW process would get, re-read before every step. An
       * installer writes the registry, never this session's $env:Path, so
       * without this a Node.js installed by the step above is invisible to the
       * `npm install -g` below it ("npm is not recognized"), and so is every
       * agent a vendor script just put on PATH. Machine first, then user, as
       * Windows builds it; this session's own entries kept after them.
       */
      // Deduplicated, case-insensitively as Windows compares paths: appended
      // once per step across eighteen agents, an undeduplicated PATH would pass
      // the 32,767-character limit on an environment variable.
      'function Update-StokePath {',
      '  $seen = @{}',
      "  $all = @([Environment]::GetEnvironmentVariable('Path', 'Machine'), [Environment]::GetEnvironmentVariable('Path', 'User'), $env:Path) -join ';'",
      "  $env:Path = @(foreach ($p in ($all -split ';')) { if ($p -and -not $seen.ContainsKey($p.ToLowerInvariant())) { $seen[$p.ToLowerInvariant()] = $true; $p } }) -join ';'",
      '}'
    ]
    const npmSteps = steps.filter((s) => s.command.startsWith('npm '))
    if (npmSteps.length) {
      /*
       * A fresh Windows has no Node.js, and every `npm install -g` agent needs
       * it — so a first-time user picking Gemini CLI got "npm is not
       * recognized" and a red card. Installed here first, once, when missing:
       * winget's Node LTS (an MSI, so Windows asks for permission once — this
       * is an interactive tab, so the person is there to say yes), then PATH
       * re-read so the steps below can see it. Without winget there is no
       * route this script can take on its own, so it says where to get Node
       * and those steps are marked failed rather than run into a wall.
       */
      const who = npmSteps.map((s) => s.label.replace(/'/g, "''")).join(', ')
      lines.push(
        'Update-StokePath',
        '$nodeMissing = $false',
        'if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {',
        `  Write-Host ''`,
        `  Write-Host '==> Installing Node.js, needed by ${who}' -ForegroundColor Cyan`,
        // Which of two things went wrong is said, never guessed: no winget at
        // all, or winget ran and the Node install did not finish (a declined
        // permission prompt, say). The first version said "no winget" for both.
        '  $hadWinget = [bool](Get-Command winget -ErrorAction SilentlyContinue)',
        '  $nodeCode = $null',
        '  if ($hadWinget) {',
        `    Write-Host '    winget install --id OpenJS.NodeJS.LTS -e --source winget'`,
        '    winget install --id OpenJS.NodeJS.LTS -e --source winget --accept-source-agreements --accept-package-agreements',
        '    $nodeCode = $LASTEXITCODE',
        '    Update-StokePath',
        '  }',
        '  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {',
        '    if ($hadWinget) {',
        `      Write-Host ('    The Node.js install did not finish (winget exit code ' + $nodeCode + '). Get it from https://nodejs.org, then run this again.') -ForegroundColor Red`,
        '    } else {',
        `      Write-Host '    Node.js is not installed, and this machine has no winget to install it with. Get it from https://nodejs.org, then run this again.' -ForegroundColor Red`,
        '    }',
        '    $nodeMissing = $true',
        '  }',
        '}'
      )
    }
    for (const s of steps) {
      lines.push(`Write-Host ''`, `Write-Host '==> Installing ${s.label}' -ForegroundColor Cyan`)
      if (s.needs) lines.push(`Write-Host '    needs ${s.needs}'`)
      if (s.note) lines.push(`Write-Host '    ${s.note.replace(/'/g, "''")}'`)
      lines.push(`Write-Host '    ${s.command.replace(/'/g, "''")}'`)
      lines.push('Update-StokePath')
      if (s.command.startsWith('npm ')) {
        lines.push(`if ($nodeMissing) { $failed += '${s.label}' } else {`)
      }
      /*
       * Each step in its own PowerShell, found by review twice over. In one
       * shared session a vendor script's `exit` inside `irm | iex` ends the
       * WHOLE run, so the agents after it never install; and `$LASTEXITCODE`
       * is only set by native programs, so a later pure-PowerShell step read
       * an earlier step's failure as its own. A child process's exit code is
       * its step's and nobody else's. `-EncodedCommand` for the same quoting
       * reason as the outer script (pty.ts installerArgs).
       */
      /*
       * A winget install of something already there exits
       * UPDATE_NOT_APPLICABLE (0x8A15002B) — or PACKAGE_ALREADY_INSTALLED
       * (0x8A150061) with --no-upgrade — and that is "installed", not a red
       * card. Decided inside the step, because the child PowerShell's own exit
       * code is only 0 or 1 unless the step says `exit` itself.
       *
       * And a machine with NO winget must fail the step, loudly. The first
       * version of this ended `exit $LASTEXITCODE`, which is `exit $null` —
       * exit 0 — when the command was never found, so on GitHub's arm64
       * runner (no winget) Copilot and Crush were reported installed and were
       * not (measured, windows workflow run 35559817481). The old bare
       * command had at least failed.
       */
      const body = s.command.startsWith('winget ')
        ? [
            "if (-not (Get-Command winget -ErrorAction SilentlyContinue)) { Write-Host '    This machine has no winget. It comes with App Installer from the Microsoft Store; install that, then run this again.' -ForegroundColor Red; exit 1 }",
            s.command,
            '$code = $LASTEXITCODE',
            'if ($null -eq $code) { exit 1 }',
            'if (@(-1978335189, -1978335135) -contains $code) { exit 0 }',
            'exit $code'
          ].join('; ')
        : s.command
      lines.push(
        `& powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${powershellEncode(body)}`,
        `if ($LASTEXITCODE -ne 0) { $failed += '${s.label}' }`
      )
      if (s.command.startsWith('npm ')) lines.push('}')
    }
    lines.push(
      `Write-Host ''`,
      `if ($failed.Count) { Write-Host ('Did not install: ' + ($failed -join ', ')) -ForegroundColor Red; exit 1 }`,
      `Write-Host 'Done. Close this tab, or start one of them from the launcher.' -ForegroundColor Green`
    )
    return lines.join('\n')
  }
  const q = (t: string): string => `'${t.replace(/'/g, `'\\''`)}'`
  /*
   * pipefail, or a download that fails does not fail its step: `curl … | bash`
   * takes bash's status, and bash reading an empty pipe exits 0 — so a 404 or
   * no network printed "Done." and the exit card said "Installed" (found by
   * review, reproduced). Guarded, because a plain POSIX sh (dash) has no such
   * option; bash, which installerShell prefers, does.
   */
  const lines = ['(set -o pipefail) 2>/dev/null && set -o pipefail', 'failed=""']
  for (const s of steps) {
    lines.push(`printf '\\n\\033[1m==> Installing %s\\033[0m\\n' ${q(s.label)}`)
    if (s.needs) lines.push(`printf '    needs %s\\n' ${q(s.needs)}`)
    if (s.note) lines.push(`printf '    %s\\n' ${q(s.note)}`)
    lines.push(`printf '    %s\\n\\n' ${q(s.command)}`)
    lines.push(`( ${s.command} ) || failed="$failed, ${s.label}"`)
  }
  lines.push(
    `printf '\\n'`,
    'if [ -n "$failed" ]; then printf \'\\033[31mDid not install:%s\\033[0m\\n\' "${failed#,}"; exit 1; fi',
    `printf '\\033[32mDone.\\033[0m Close this tab, or start one of them from the launcher.\\n'`
  )
  return lines.join('\n')
}
