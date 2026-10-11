/** Grok Bot is a remote teammate service, not Grok Build's coding CLI. */
export interface GrokBotAccount {
  id: string
  label: string
  gatewayHost: string
  source: 'desktop' | 'manual'
  sourceSlot: string
  status: 'saved' | 'connected' | 'reconnect'
  checkedAt: number | null
  updatedAt: number
}
export interface GrokBotView {
  revision: number
  accounts: GrokBotAccount[]
  defaultAccount: string | null
  cli: { installed: boolean; version: string }
}
export interface GrokBotSource {
  id: string
  label: string
}
export type GrokBotAccountCommand =
  | { kind: 'import'; label: string; sourceSlot?: string; replace?: string }
  | {
      kind: 'manual'
      label: string
      gatewayUrl: string
      token: string
      headers?: Record<string, string>
      allowLocal?: boolean
    }
  | { kind: 'rename'; id: string; label: string }
  | { kind: 'remove' | 'default'; id: string }
export interface GrokBotOperation {
  accountId: string
  kind: 'list' | 'thread' | 'send' | 'create' | 'delete'
  target?: string
  message?: string
  name?: string
}
export interface GrokBotResult {
  ok: boolean
  data: unknown
  message?: string
  delivery?: 'accepted' | 'unknown' | 'rejected'
}
export const GBOT_VERSION = '0.12.4'
export const GBOT_SOURCE = 'https://github.com/ScriptedAlchemy/grok-bot-cli'
export function isGrokBotAccountId(value: unknown): value is string {
  return typeof value === 'string' && /^gbot-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

/** Never accept an arbitrary credential destination from a descriptor. */
export function grokBotGateway(raw: unknown, allowLocal = false): string {
  if (typeof raw !== 'string' || raw.length > 2048 || /[\u0000-\u0020]/.test(raw))
    throw new Error('Enter a Grok Bot gateway address.')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('Enter a Grok Bot gateway address.')
  }
  const host = url.hostname.toLowerCase()
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(host)
  const trusted =
    host === 'cursor.sh' ||
    host === 'cursor.com' ||
    ['.cursor.sh', '.cursor.com', '.cursorvm.com'].some((suffix) => host.endsWith(suffix))
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (loopback
      ? !allowLocal || !['http:', 'https:'].includes(url.protocol)
      : url.protocol !== 'https:' || !trusted)
  )
    throw new Error(
      'Use the gateway from your Grok Bot desktop session. Local gateways require the development option.'
    )
  return url.href.replace(/\/$/, '')
}
