import type { CodingCliId } from './codingClis.ts'
import { isModelId } from './modelId.ts'

export type AccountProvider = 'anthropic' | 'openai' | 'openrouter' | 'nanogpt' | 'custom'
export interface AccountApiProfile {
  provider: AccountProvider
  /** Only Custom can change this. Built-in provider addresses are pinned. */
  baseUrl: string
  /** Empty uses the agent's selected/default model for first-party APIs. */
  model: string
}
export const ACCOUNT_PROVIDER_LABELS: Record<AccountProvider, string> = {
  anthropic: 'Anthropic API', openai: 'OpenAI API', openrouter: 'OpenRouter', nanogpt: 'NanoGPT', custom: 'Custom API'
}
export function accountProvidersFor(cli: CodingCliId): AccountProvider[] {
  return cli === 'claude' ? ['anthropic', 'nanogpt', 'openrouter', 'custom']
    : cli === 'codex' ? ['openai', 'nanogpt', 'openrouter', 'custom'] : []
}
export function accountProviderBase(cli: CodingCliId, provider: AccountProvider): string {
  switch (provider) {
    case 'anthropic': return 'https://api.anthropic.com'
    case 'openai': return 'https://api.openai.com/v1'
    case 'nanogpt': return 'https://nano-gpt.com/api/v1'
    case 'openrouter': return cli === 'claude' ? 'https://openrouter.ai/api' : 'https://openrouter.ai/api/v1'
    case 'custom': return ''
  }
}
export function defaultAccountApiProfile(cli: CodingCliId, provider = accountProvidersFor(cli)[0]): AccountApiProfile | null {
  return provider && accountProvidersFor(cli).includes(provider) ? { provider, baseUrl: accountProviderBase(cli, provider), model: '' } : null
}
/** Preserve incomplete drafts for explicit validation; never repair a wrong vendor into another. */
export function hydrateAccountApiProfile(cli: CodingCliId, raw: unknown): AccountApiProfile | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  if (!accountProvidersFor(cli).includes(v.provider as AccountProvider)) return null
  const provider = v.provider as AccountProvider
  return {
    provider,
    baseUrl: provider === 'custom' ? typeof v.baseUrl === 'string' ? v.baseUrl.trim() : '' : accountProviderBase(cli, provider),
    model: typeof v.model === 'string' ? v.model.trim().slice(0, 201) : ''
  }
}
export function accountApiProfileProblem(cli: CodingCliId, raw: unknown): string | null {
  const p = hydrateAccountApiProfile(cli, raw)
  if (!p) return 'Choose an API provider supported by this agent.'
  if (p.model && !isModelId(p.model)) return 'Enter a model ID without spaces or shell characters.'
  if (!p.model && p.provider !== 'anthropic' && p.provider !== 'openai') return 'Enter the model ID this provider should run.'
  if (cli === 'codex' && /[&|<>^%!()\r\n"']/.test(p.baseUrl)) return 'This Codex API URL contains characters unsupported by Windows CLI launchers.'
  try {
    if (p.baseUrl.length > 2048) throw new Error()
    const url = new URL(p.baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) throw new Error()
  } catch { return 'Enter an HTTP(S) API base URL without a key, query or fragment.' }
  return null
}
/** Keys travel in the child's environment, never argv or native auth files. */
export function accountApiEnv(cli: CodingCliId, key: string, p: AccountApiProfile): Record<string, string> {
  if (cli !== 'claude') return { STOKE_ACCOUNT_API_KEY: key }
  return {
    ANTHROPIC_BASE_URL: p.baseUrl,
    ANTHROPIC_API_KEY: p.provider === 'anthropic' ? key : '',
    ANTHROPIC_AUTH_TOKEN: p.provider === 'anthropic' ? '' : key,
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: ''
  }
}
