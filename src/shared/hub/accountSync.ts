/** Portable account records. Local folders, CLI configuration and OS keychain blobs never travel. */
import { accountKindsFor, ACCOUNT_LABEL_MAX, type AccountKind } from '../accounts.ts'
import { accountApiProfileProblem, accountProvidersFor, type AccountApiProfile } from '../accountProviders.ts'
import { isCodingCliId, type CodingCliId } from '../codingClis.ts'
import { grokBotGateway } from '../grokBot.ts'
import { isRecord } from './codec.ts'

export const MAX_SYNC_ACCOUNTS = 128
export const MAX_ACCOUNT_PAYLOAD_BYTES = 96 * 1024
export function isSyncAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^sa-[0-9a-f]{32}$/.test(value)
}

export interface SyncedAgentAccount {
  v: 1
  kind: 'agent'
  cli: CodingCliId
  accountKind: AccountKind
  label: string
  apiProfile?: AccountApiProfile
  credential: { format: 'api-key' | 'codex-file'; value: string } | null
}
export interface SyncedGrokBotAccount {
  v: 1
  kind: 'grok-bot'
  label: string
  credential: { gatewayUrl: string; token: string; headers: Record<string, string> }
}
export type SyncedAccount = SyncedAgentAccount | SyncedGrokBotAccount

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !/[\u0000]/.test(v)
const sizeProblem = (raw: SyncedAccount): string | null => new TextEncoder().encode(JSON.stringify(raw)).length > MAX_ACCOUNT_PAYLOAD_BYTES ? 'The account is too large to sync.' : null
/** Validate the portable Codex cache without returning any secret in an error. */
export function codexAuthProblem(value: unknown): string | null {
  if (!text(value, 64 * 1024) || new TextEncoder().encode(value).length > 64 * 1024) return 'The Codex login cache is too large.'
  let raw: unknown
  try { raw = JSON.parse(value) } catch { return 'The Codex login cache is not JSON.' }
  if (!isRecord(raw)) return 'The Codex login cache is not an object.'
  if (Object.keys(raw).some(k => !['auth_mode', 'OPENAI_API_KEY', 'last_refresh', 'tokens'].includes(k)) ||
    ['auth_mode', 'last_refresh'].some(k => raw[k] !== undefined && raw[k] !== null && !text(raw[k], 1024)) ||
    (raw.OPENAI_API_KEY !== undefined && raw.OPENAI_API_KEY !== null && !text(raw.OPENAI_API_KEY, 32 * 1024))) return 'The Codex login cache has unsupported fields.'
  const tokens = raw.tokens
  if (tokens !== undefined && tokens !== null && (!isRecord(tokens) || Object.keys(tokens).some(k => !['id_token', 'access_token', 'refresh_token', 'account_id'].includes(k)) ||
    Object.values(tokens).some(v => v !== null && !text(v, 32 * 1024)))) return 'The Codex login cache has unsupported token fields.'
  if (typeof raw.OPENAI_API_KEY === 'string' && raw.OPENAI_API_KEY.trim()) return null
  if (!isRecord(tokens) || !['id_token', 'access_token', 'refresh_token'].every(k => text(tokens[k], 32 * 1024) && !!tokens[k])) return 'The Codex login cache has no complete reusable login.'
  return null
}

export function syncedAccountProblem(raw: unknown): string | null {
  if (!isRecord(raw) || raw.v !== 1 || !text(raw.label, raw.kind === 'agent' ? ACCOUNT_LABEL_MAX * 2 : 100) || !raw.label.trim() || /[\u0000-\u001f]/.test(raw.label)) return 'The account details are invalid.'
  const allowed = raw.kind === 'agent' ? ['v', 'kind', 'cli', 'accountKind', 'label', 'apiProfile', 'credential'] : ['v', 'kind', 'label', 'credential']
  if (Object.keys(raw).some(k => !allowed.includes(k))) return 'The account contains device-specific or unsupported fields.'
  if (raw.kind === 'agent') {
    if (!isCodingCliId(raw.cli) || (raw.accountKind !== 'login' && raw.accountKind !== 'key') || !accountKindsFor(raw.cli).includes(raw.accountKind)) return 'This agent cannot use that account type.'
    if (raw.apiProfile !== undefined && (raw.accountKind !== 'key' || !accountProvidersFor(raw.cli).length || !isRecord(raw.apiProfile) || Object.keys(raw.apiProfile).some(k => !['provider', 'baseUrl', 'model'].includes(k)) || !text(raw.apiProfile.baseUrl, 2048) || !text(raw.apiProfile.model, 201))) return 'The API account settings are invalid.'
    if (raw.accountKind === 'key' && accountProvidersFor(raw.cli).length && accountApiProfileProblem(raw.cli, raw.apiProfile)) return 'The API account needs valid provider settings.'
    if (raw.credential === null) return sizeProblem(raw as unknown as SyncedAccount)
    if (!isRecord(raw.credential) || !text(raw.credential.value, 64 * 1024) || Object.keys(raw.credential).some(k => !['format', 'value'].includes(k))) return 'The credential format is invalid.'
    if (raw.accountKind === 'key' && raw.credential.format === 'api-key') return sizeProblem(raw as unknown as SyncedAccount)
    if (raw.cli === 'codex' && raw.accountKind === 'login' && raw.credential.format === 'codex-file') return codexAuthProblem(raw.credential.value) ?? sizeProblem(raw as unknown as SyncedAccount)
    return 'This sign-in needs to be completed on each device.'
  }
  if (raw.kind === 'grok-bot') {
    const c = raw.credential
    if (!isRecord(c) || !text(c.token, 16_384) || !c.token.trim() || /[\u0000-\u0020\u007f]/.test(c.token.trim()) || !isRecord(c.headers) || Object.keys(c).some(k => !['gatewayUrl', 'token', 'headers'].includes(k))) return 'The Grok Bot credential is invalid.'
    try { grokBotGateway(c.gatewayUrl) } catch { return 'The Grok Bot gateway cannot be synced.' }
    if (Object.entries(c.headers).length > 24 || Object.entries(c.headers).some(([k, v]) => !/^[A-Za-z0-9-]{1,80}$/.test(k) || ['authorization', 'cookie', 'host', 'content-length', 'content-type', 'connection'].includes(k.toLowerCase()) || !text(v, 8192) || /[\u0000-\u001f\u007f]/.test(v))) return 'The Grok Bot routing headers are invalid.'
    return sizeProblem(raw as unknown as SyncedAccount)
  }
  return 'This account type is unsupported.'
}
