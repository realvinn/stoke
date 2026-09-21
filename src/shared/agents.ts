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
 *             MCP likewise: `-c mcp_servers.<id>.{url,bearer_token_env_var}`,
 *             listed by `codex mcp get` with nothing written to config.toml.
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
 * Keys only ever travel in the environment, never in argv, where any other
 * process on the machine could read them from the process table.
 *
 * Pure, and compiled by both tsconfigs, so no `node:` import (gotcha 27);
 * `scripts/verify-agents.mts` runs it under strip-types, so shared imports are
 * relative with `.ts` (gotcha 78).
 */
import {
  CODING_CLIS,
  cliFor,
  isClaudeCode,
  isCodingCliId,
  type CodingCliId,
  type InstallPlatform
} from './codingClis.ts'

export const OPENROUTER_OPENAI_BASE_URL = 'https://openrouter.ai/api/v1'

export type EndpointMode = 'default' | 'openrouter' | 'custom'

export interface AgentEndpoint {
  mode: EndpointMode
  /**
   * The model to ask for. Required off `default`: Grok Build picks the FIRST
   * model an endpoint lists when it is not told, which on OpenRouter was an
   * obscure 27B model, and the others refuse to start without one.
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
}

export const DEFAULT_AGENTS: AgentSettings = { chosen: null, endpoints: {} }

export const DEFAULT_ENDPOINT: AgentEndpoint = { mode: 'default', model: '', baseUrl: '', apiKey: '' }

function isEndpointMode(v: unknown): v is EndpointMode {
  return v === 'default' || v === 'openrouter' || v === 'custom'
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')

/**
 * Repair a stored endpoint. Rebuilt from named keys, like `hydrateProviders`
 * and the ui.ts clamps: a field this does not name does not survive, so a new
 * field needs a line here in the same change.
 */
export function hydrateEndpoint(raw: unknown): AgentEndpoint {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_ENDPOINT }
  const r = raw as Partial<AgentEndpoint>
  return {
    mode: isEndpointMode(r.mode) ? r.mode : 'default',
    model: str(r.model),
    baseUrl: str(r.baseUrl).replace(/\/+$/, ''),
    apiKey: str(r.apiKey)
  }
}

export function hydrateAgents(raw: unknown): AgentSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { chosen: null, endpoints: {} }
  const r = raw as { chosen?: unknown; endpoints?: unknown }
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
      const h = hydrateEndpoint(ep)
      if (h.mode !== 'default' || h.model || h.baseUrl || h.apiKey) endpoints[id] = h
    }
  }
  return { chosen, endpoints }
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

/* ------------------------------------------------------------ launching */

export interface LaunchPlan {
  /** Appended to the CLI's argv. */
  args: string[]
  /** Merged over the inherited environment. Where every key travels. */
  env: Record<string, string>
}

export type LaunchPlanResult = { ok: true; plan: LaunchPlan } | { ok: false; message: string }

export interface LaunchPlanInput {
  id: CodingCliId
  endpoint: AgentEndpoint | undefined
  /** Settings › Providers' OpenRouter key, shared with Claude Code. */
  openrouterKey: string
  /** Continue the latest session in the folder, where the CLI can. */
  continueLast: boolean
  /** Stoke's browser MCP server, when it is up, for the CLIs that take one per launch. */
  mcp: { url: string; token: string } | null
  /**
   * The same server as config FILES, for the CLIs that take a path rather than
   * flags or an env var — so the bearer token never lands in argv. `claude` is
   * Stoke's existing `mcp-browser.json` (Claude Code's own format, which Copilot
   * accepts unchanged); `httpUrl` is the Gemini-family form Qwen needs, where a
   * plain `url` means SSE and never connects. Both checked against a server
   * that logged every request: Copilot and Qwen each sent initialize and
   * tools/list with the bearer.
   */
  mcpFiles?: { claude: string | null; httpUrl: string | null }
  /** Where Stoke keeps Pi's provider extension, for a custom endpoint. */
  piExtensionPath: string | null
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
export const ENV_MCP_TOKEN = 'STOKE_MCP_TOKEN'

/** What is wrong with an endpoint before anything is spawned, or null. */
export function endpointProblem(id: CodingCliId, ep: AgentEndpoint, openrouterKey: string): string | null {
  const cli = cliFor(id)
  if (ep.mode === 'default') return null
  if (ep.mode === 'openrouter') {
    if (!cli.endpoints.openrouter) return `${cli.label} cannot be pointed at OpenRouter from Stoke.`
    if (!openrouterKey) return `${cli.label} is set to use OpenRouter, but there is no OpenRouter key. Add one in Settings › Providers.`
    if (!ep.model) return `${cli.label} is set to use OpenRouter, but no model is chosen. Set one in Settings › Coding agents.`
    return null
  }
  if (!cli.endpoints.custom) return `${cli.label} cannot be pointed at a custom endpoint from Stoke.`
  if (!isEndpointUrl(ep.baseUrl)) return `${cli.label}’s custom endpoint needs an http(s) base URL. Set it in Settings › Coding agents.`
  if (!ep.model) return `${cli.label}’s custom endpoint needs a model. Set it in Settings › Coding agents.`
  return null
}

/**
 * The arguments and environment one launch of a non-Claude CLI gets.
 *
 * Refuses rather than guesses: a launch that would 401 on its first turn, or
 * silently fall back to the CLI's own sign-in while the user believes it is on
 * OpenRouter, is worse than a message saying which field is empty.
 */
export function agentLaunchPlan(input: LaunchPlanInput): LaunchPlanResult {
  const { id, openrouterKey, continueLast, mcp, piExtensionPath } = input
  const cli = cliFor(id)
  const ep = input.endpoint ?? DEFAULT_ENDPOINT
  if (isClaudeCode(id)) return { ok: true, plan: { args: [], env: {} } }

  const problem = endpointProblem(id, ep, openrouterKey)
  if (problem) return { ok: false, message: problem }

  const args: string[] = []
  const env: Record<string, string> = {}
  const customKey = ep.apiKey || NO_KEY

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
      if (mcp) {
        args.push(
          '-c', `mcp_servers.stoke.url=${tomlString(mcp.url)}`,
          '-c', `mcp_servers.stoke.bearer_token_env_var=${tomlString(ENV_MCP_TOKEN)}`
        )
        env[ENV_MCP_TOKEN] = mcp.token
      }
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
      if (mcp) {
        // The token inline rather than as `{env:…}`: substitution inside MCP
        // headers was the one part of this path nobody saw work, and the value
        // is already confined to this process's environment either way.
        config.mcp = {
          stoke: { type: 'remote', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` }, enabled: true }
        }
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
      if (input.mcpFiles?.httpUrl) args.push('--mcp-config', input.mcpFiles.httpUrl)
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
      if (input.mcpFiles?.claude) args.push('--additional-mcp-config', `@${input.mcpFiles.claude}`)
      break
    }
  }

  if (continueLast && cli.continueArgs) args.push(...cli.continueArgs)
  return { ok: true, plan: { args, env } }
}

/**
 * Stoke's browser MCP server in the Gemini-family config shape, for Qwen's
 * `--mcp-config <path>`: `httpUrl` is streamable HTTP there, and a bare `url`
 * would be read as SSE (measured: a GET and a HEAD, then "failed to start").
 */
export function httpUrlMcpConfig(mcp: { url: string; token: string }): string {
  return JSON.stringify(
    { mcpServers: { stoke: { httpUrl: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } },
    null,
    2
  )
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
