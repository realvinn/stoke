import { DEFAULT_ACCOUNT_ID, isAccountId } from './accounts.ts'
import { isCodingCliId, type CodingCliId } from './codingClis.ts'

export interface AccountIdentityTarget {
  cli: CodingCliId
  accountId: string
  ptyId?: string
}

/** Public identity only. Credentials and native command output stay in main. */
export interface AccountIdentity {
  target: AccountIdentityTarget
  label: string
  state: 'ready' | 'signed-out' | 'unavailable'
  method: string
  email: string | null
  organization: string | null
  plan: string | null
  detail: string
  checkedAt: number
}

export function accountIdentityTarget(raw: unknown): AccountIdentityTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (!isCodingCliId(v.cli) || (v.accountId !== DEFAULT_ACCOUNT_ID && !isAccountId(v.accountId))) return null
  if (v.ptyId !== undefined && (typeof v.ptyId !== 'string' || !v.ptyId || v.ptyId.length > 128)) return null
  return { cli: v.cli, accountId: v.accountId as string, ...(typeof v.ptyId === 'string' ? { ptyId: v.ptyId } : {}) }
}

export function accountIdentityKey(target: AccountIdentityTarget): string {
  return JSON.stringify([target.cli, target.accountId, target.ptyId ?? null])
}

/** Hide a previous account immediately, before its replacement's effect runs. */
export function identityFor(target: AccountIdentityTarget, value: AccountIdentity | null): AccountIdentity | null {
  return value && accountIdentityKey(value.target) === accountIdentityKey(target) ? value : null
}

export function accountIdentityText(value: AccountIdentity | null): string {
  if (!value) return 'Checking sign-in…'
  if (value.email) return value.email
  if (value.state === 'signed-out') return 'Not signed in'
  if (value.state === 'unavailable') return 'Identity unavailable'
  return value.method
}

export function unavailableAccountIdentity(target: AccountIdentityTarget): AccountIdentity {
  return { target: { ...target }, label: target.accountId === DEFAULT_ACCOUNT_ID ? 'Default' : target.accountId, state: 'unavailable', method: 'Agent sign-in', email: null, organization: null, plan: null, detail: 'Stoke could not read this account’s identity. Try Refresh.', checkedAt: Date.now() }
}

export function identityText(raw: unknown, max = 160): string | null {
  return typeof raw === 'string' && raw.trim() && raw.length <= max && !/[\u0000-\u001f\u007f]/.test(raw) ? raw.trim() : null
}

export function identityEmail(raw: unknown): string | null {
  const text = identityText(raw, 254)
  return text && /^[^\s@]+@[^\s@]+$/.test(text) ? text : null
}

/** Whitelist fields from the vendor's read-only status response. */
export function nativeAccountIdentity(cli: 'claude' | 'codex', raw: unknown): Pick<AccountIdentity, 'state' | 'method' | 'email' | 'organization' | 'plan' | 'detail'> {
  const unavailable = { state: 'unavailable' as const, method: 'Agent sign-in', email: null, organization: null, plan: null, detail: 'The agent could not report its sign-in identity.' }
  if (!raw || typeof raw !== 'object') return unavailable
  const value = raw as Record<string, unknown>
  if (cli === 'claude') {
    if (value.loggedIn === false) return { ...unavailable, state: 'signed-out', detail: 'Claude Code reports that this account is not signed in.' }
    if (value.loggedIn !== true) return unavailable
    const email = identityEmail(value.email)
    return { state: 'ready', method: email ? 'Claude sign-in' : value.authMethod === 'api_key' ? 'API key' : 'Claude sign-in', email, organization: identityText(value.orgName), plan: identityText(value.subscriptionType), detail: 'Reported by Claude Code for this account’s current sign-in.' }
  }
  if (value.account === null) return { ...unavailable, ...(value.requiresOpenaiAuth === true ? { state: 'signed-out' as const, detail: 'Codex reports that this account is not signed in.' } : { method: 'Provider authentication', detail: 'This Codex provider does not require an OpenAI sign-in.' }) }
  if (!value.account || typeof value.account !== 'object') return unavailable
  const account = value.account as Record<string, unknown>
  if (account.type === 'chatgpt') return { state: 'ready', method: 'ChatGPT sign-in', email: identityEmail(account.email), organization: null, plan: identityText(account.planType), detail: 'Reported by Codex for this account’s current sign-in. No token refresh was requested.' }
  if (account.type === 'apiKey') return { ...unavailable, state: 'ready', method: 'API key', detail: 'Codex reports API-key authentication. It does not expose the key owner’s email.' }
  if (account.type === 'amazonBedrock') return { ...unavailable, state: 'ready', method: 'Amazon Bedrock', detail: 'Codex reports Amazon Bedrock authentication.' }
  return unavailable
}
