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
  /** Saved native logins can exist before a gateway connection is exported. */
  nativeLogin?: boolean
  current?: boolean
  connection?: 'saved' | 'missing' | 'expired'
}
/** Local desktop profile selection. Folder paths and protection keys stay in main. */
export interface GrokBotDesktopProfile {
  id: string
  label: string
  sources: GrokBotSource[]
}
/** In-memory tab binding and draft; credentials remain in the plugin's vault. */
export interface GrokBotTabBinding {
  accountId: string
  accountLabel: string
  targetId: string
  targetLabel: string
  draft: string
  /** Per-account/bot drafts, kept in memory and carried with a detached tab. */
  drafts?: Record<string, { draft: string; delivery?: 'accepted' | 'unknown' | 'rejected'; sendError?: string }>
  sending?: boolean
  delivery?: 'accepted' | 'unknown' | 'rejected'
  sendError?: string
}
export type GrokBotAccountCommand =
  | { kind: 'import'; label: string; sourceSlot?: string; profileId?: string; replace?: string }
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
  kind: 'list' | 'thread' | 'send' | 'create' | 'delete' | 'get' | 'update' | 'members-set' | 'skills' | 'skill-add' | 'skill-remove' | 'approvals' | 'approval-respond' | 'desktop'
  target?: string
  targetKind?: 'bot' | 'group'
  message?: string
  name?: string
  description?: string
  title?: string
  notify?: boolean
  hidden?: boolean
  members?: string[]
  markdown?: string
  entryId?: string
  requestId?: string
  decision?: 'accept' | 'decline'
  limit?: number
}
export interface GrokBotResult {
  ok: boolean
  data: unknown
  message?: string
  code?: 'busy'
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
