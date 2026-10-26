import { isB64u, isId, isRecord, labelled } from './codec.ts'
import type { VaultWrap } from './protocol.ts'
import { isSessionToken } from './auth.ts'

/** Remote-only browser credentials. Never a vault key or a desktop identity. */
export interface BrowserLink {
  v: 1
  hub: string
  account: string
  device: string
  token: string
  signPriv: string
  boxPriv: string
  anchor: { seq: number; link: string }
}
export interface BrowserPresenceKey {
  v: 1
  account: string
  epoch: number
  device: string
  author: string
  wrap: VaultWrap
  sig: string
}
export function browserKeyText(value: Omit<BrowserPresenceKey, 'sig'> | BrowserPresenceKey): string {
  const { sig: _sig, ...bare } = value as BrowserPresenceKey
  return labelled('stoke.browser.presence-key.v1', bare)
}
export function browserWrapInfo(account: string, epoch: number, device: string): string {
  return labelled('stoke.browser.presence-wrap.v1', { account, epoch, device })
}
export function browserLinkOf(value: unknown): BrowserLink | null {
  if (!isRecord(value) || value.v !== 1 || !isId('account', value.account) || !isId('device', value.device) || !isB64u(value.signPriv, 32) || !isB64u(value.boxPriv, 32) || typeof value.hub !== 'string' || value.hub.length > 2048 || !isSessionToken(value.token) || !isRecord(value.anchor) || !Number.isSafeInteger(value.anchor.seq) || (value.anchor.seq as number) < 0 || !isB64u(value.anchor.link, 32)) return null
  return value as unknown as BrowserLink
}
export function browserKeyProblem(value: unknown): string | null {
  if (!isRecord(value) || value.v !== 1 || !isId('account', value.account) || !isId('device', value.device) || !isId('device', value.author) || !Number.isSafeInteger(value.epoch) || (value.epoch as number) < 1 || !isRecord(value.wrap) || value.wrap.v !== 1 || !isB64u(value.wrap.eph, 32) || !isB64u(value.wrap.nonce, 12) || !isB64u(value.wrap.ct, 48) || !isB64u(value.sig, 64)) return 'Invalid remote presence key.'
  return null
}
/** Remote-only devices may discover and open sessions, never fetch vault material. */
export function browserRouteAllowed(method: string, path: string): boolean {
  const p = path.split('?')[0]
  return method === 'GET' && (p === '/v1/chain' || p === '/v1/remote/key' || p === '/v1/ws/presence' || /^\/v1\/ws\/relay\/[a-z0-9]+$/.test(p)) || method === 'POST' && ['/v1/relays', '/v1/remote/socket', '/v1/auth/logout'].includes(p)
}
