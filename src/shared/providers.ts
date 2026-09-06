/**
 * Provider credentials and how they reach a spawned Claude Code session.
 *
 * Stoke does not call Anthropic, OpenAI, or xAI itself. It spawns the real
 * `claude` CLI in a PTY and inherits (or overrides) that process's environment.
 * A GUI app launched from the Start menu / Dock does not see shell-profile
 * exports, which is exactly why these live in Settings rather than "set them
 * in ~/.zshrc".
 *
 * Verified mappings (Claude Code auth docs + OpenRouter cookbook):
 *
 *   - Anthropic console key  -> ANTHROPIC_API_KEY (X-Api-Key)
 *   - OpenRouter / gateways  -> ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN
 *                              (Bearer), with ANTHROPIC_API_KEY explicitly ""
 *   - OpenAI / Codex         -> OPENAI_API_KEY (Codex CLI reads this; Claude
 *                              Code does not speak OpenAI wire format)
 *   - xAI / Grok             -> XAI_API_KEY (bridges / MCP / Codex custom
 *                              providers). Direct Anthropic-skin on api.x.ai
 *                              is deprecated; use a bridge URL via Custom.
 *
 * Pure module: no electron, no fs. Asserted by scripts/verify-providers.mts.
 */

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api'

/**
 * How Claude Code authenticates for a new *local* session.
 *
 * Remote (SSH) sessions are untouched: env does not cross ssh without
 * SendEnv/AcceptEnv, and the far machine has its own credentials.
 */
export type ClaudeAuthMode = 'default' | 'anthropic' | 'openrouter' | 'custom'

export interface ProviderSettings {
  /** Auth path for local Claude Code sessions. */
  claudeAuth: ClaudeAuthMode
  /** Anthropic console API key. Used when claudeAuth === 'anthropic'. */
  anthropicApiKey: string
  /** OpenRouter key (typically sk-or-...). Used when claudeAuth === 'openrouter'. */
  openrouterApiKey: string
  /**
   * Anthropic-compatible gateway base URL for claudeAuth === 'custom'.
   * Example: http://127.0.0.1:8080 or a vendor Anthropic skin.
   */
  customBaseUrl: string
  /** Bearer token for the custom gateway. Sent as ANTHROPIC_AUTH_TOKEN. */
  customAuthToken: string
  /**
   * When on OpenRouter, opt into Claude Code's gateway model picker.
   * Off by default: the picker includes non-Anthropic models that are not
   * guaranteed to work with Claude Code's tool use.
   */
  openrouterModelDiscovery: boolean
  /**
   * OpenAI / Codex API key. Always injected as OPENAI_API_KEY when non-empty,
   * regardless of claudeAuth. Does not drive Claude Code by itself.
   */
  openaiApiKey: string
  /**
   * xAI / Grok API key. Always injected as XAI_API_KEY when non-empty.
   * Point Claude Code at a local Anthropic-compatible bridge via Custom.
   */
  xaiApiKey: string
}

export const DEFAULT_PROVIDERS: ProviderSettings = {
  claudeAuth: 'default',
  anthropicApiKey: '',
  openrouterApiKey: '',
  customBaseUrl: '',
  customAuthToken: '',
  openrouterModelDiscovery: false,
  openaiApiKey: '',
  xaiApiKey: ''
}

const AUTH_MODES: readonly ClaudeAuthMode[] = ['default', 'anthropic', 'openrouter', 'custom']

export function isClaudeAuthMode(v: unknown): v is ClaudeAuthMode {
  return typeof v === 'string' && (AUTH_MODES as readonly string[]).includes(v)
}

/** Trim; never invent a value. Empty string stays empty. */
function tidyKey(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * Repair a stored `providers` blob. Unknown modes fall back to default so a
 * typo cannot leave sessions in an undefined auth state.
 */
export function hydrateProviders(raw: unknown): ProviderSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...DEFAULT_PROVIDERS }
  }
  const r = raw as Partial<ProviderSettings>
  return {
    claudeAuth: isClaudeAuthMode(r.claudeAuth) ? r.claudeAuth : DEFAULT_PROVIDERS.claudeAuth,
    anthropicApiKey: tidyKey(r.anthropicApiKey),
    openrouterApiKey: tidyKey(r.openrouterApiKey),
    customBaseUrl: tidyKey(r.customBaseUrl).replace(/\/+$/, ''),
    customAuthToken: tidyKey(r.customAuthToken),
    openrouterModelDiscovery: r.openrouterModelDiscovery === true,
    openaiApiKey: tidyKey(r.openaiApiKey),
    xaiApiKey: tidyKey(r.xaiApiKey)
  }
}

export type ProviderEnvIssue =
  | { ok: true }
  | { ok: false; message: string }

/**
 * Whether the chosen Claude auth mode has enough to start a session.
 * Soft checks only: we do not call any network from here.
 */
export function validateClaudeAuth(p: ProviderSettings): ProviderEnvIssue {
  switch (p.claudeAuth) {
    case 'default':
      return { ok: true }
    case 'anthropic':
      return p.anthropicApiKey
        ? { ok: true }
        : {
            ok: false,
            message:
              'Anthropic API key is empty. Paste a key from console.anthropic.com, or switch auth back to Default (Claude.ai login).'
          }
    case 'openrouter':
      return p.openrouterApiKey
        ? { ok: true }
        : {
            ok: false,
            message:
              'OpenRouter API key is empty. Paste a key from openrouter.ai/settings/keys, or switch auth back to Default.'
          }
    case 'custom': {
      if (!p.customBaseUrl) {
        return {
          ok: false,
          message:
            'Custom gateway needs a base URL (for example http://127.0.0.1:8080 or an Anthropic-compatible vendor URL).'
        }
      }
      if (!/^https?:\/\//i.test(p.customBaseUrl)) {
        return {
          ok: false,
          message: 'Custom gateway base URL must start with http:// or https://.'
        }
      }
      if (!p.customAuthToken) {
        return {
          ok: false,
          message:
            'Custom gateway needs a bearer token. For a local bridge that ignores auth, any non-empty placeholder works.'
        }
      }
      return { ok: true }
    }
  }
}

/**
 * Soft format hints shown in the UI. Never block a save on these — vendors
 * rotate prefixes — but do warn when a known-wrong prefix is pasted into the
 * wrong box (OpenRouter key into Anthropic, etc.).
 */
export function keyFormatHint(kind: 'anthropic' | 'openrouter' | 'openai' | 'xai', value: string): string | null {
  const v = value.trim()
  if (!v) return null
  if (kind === 'openrouter' && !v.startsWith('sk-or-') && v.startsWith('sk-')) {
    return 'OpenRouter keys usually start with sk-or-. This looks like an OpenAI or Anthropic key.'
  }
  if (kind === 'anthropic' && v.startsWith('sk-or-')) {
    return 'That looks like an OpenRouter key. Use the OpenRouter auth mode instead of Anthropic API key.'
  }
  if (kind === 'openai' && v.startsWith('sk-or-')) {
    return 'That looks like an OpenRouter key. Put it under OpenRouter, not OpenAI / Codex.'
  }
  if (kind === 'xai' && (v.startsWith('sk-or-') || v.startsWith('sk-ant-'))) {
    return 'That does not look like an xAI key. Use the matching provider box instead.'
  }
  return null
}

/**
 * Mutate `env` so a local Claude Code spawn uses the chosen provider.
 *
 * Empty-string assignments are intentional and load-bearing for OpenRouter:
 * an unset ANTHROPIC_API_KEY is not the same as "", and Claude Code may fall
 * back to a cached Anthropic login or a parent-process key when the variable
 * is merely absent.
 *
 * OPENAI_API_KEY / XAI_API_KEY are applied whenever set, so Codex and Grok
 * tooling see them even when Claude auth stays on Default.
 *
 * Returns the same object for chaining / tests.
 */
export function applyProviderEnv(
  env: Record<string, string>,
  providers: ProviderSettings
): Record<string, string> {
  const p = hydrateProviders(providers)

  if (p.openaiApiKey) env.OPENAI_API_KEY = p.openaiApiKey
  if (p.xaiApiKey) env.XAI_API_KEY = p.xaiApiKey

  switch (p.claudeAuth) {
    case 'default':
      // Leave ANTHROPIC_* alone — OAuth / inherited shell env / Claude login.
      break
    case 'anthropic':
      env.ANTHROPIC_API_KEY = p.anthropicApiKey
      // A leftover gateway base URL from a previous mode would still route
      // every request away from api.anthropic.com. Clear both.
      delete env.ANTHROPIC_BASE_URL
      delete env.ANTHROPIC_AUTH_TOKEN
      delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
      break
    case 'openrouter':
      env.ANTHROPIC_BASE_URL = OPENROUTER_BASE_URL
      env.ANTHROPIC_AUTH_TOKEN = p.openrouterApiKey
      env.ANTHROPIC_API_KEY = ''
      if (p.openrouterModelDiscovery) {
        env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = '1'
      } else {
        delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
      }
      break
    case 'custom':
      env.ANTHROPIC_BASE_URL = p.customBaseUrl
      env.ANTHROPIC_AUTH_TOKEN = p.customAuthToken
      env.ANTHROPIC_API_KEY = ''
      delete env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY
      break
  }

  return env
}

/** One-line summary for the settings sheet, never containing the key itself. */
export function providersSummary(p: ProviderSettings): string {
  const keys: string[] = []
  if (p.anthropicApiKey) keys.push('Anthropic')
  if (p.openrouterApiKey) keys.push('OpenRouter')
  if (p.openaiApiKey) keys.push('OpenAI/Codex')
  if (p.xaiApiKey) keys.push('xAI/Grok')
  const auth =
    p.claudeAuth === 'default'
      ? 'Claude auth: default (login / inherited env)'
      : p.claudeAuth === 'anthropic'
        ? 'Claude auth: Anthropic API key'
        : p.claudeAuth === 'openrouter'
          ? 'Claude auth: OpenRouter'
          : 'Claude auth: custom gateway'
  return keys.length ? `${auth}. Keys saved: ${keys.join(', ')}.` : `${auth}. No keys saved yet.`
}
