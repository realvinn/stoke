import { hydrateServerSpec, isEnvName, isSafeServerName, isStoredHeaderName, STOKE_BROWSER_SERVER, urlInArgvProblem, type AgentMcpSettings, type McpServerSpec } from './mcpServers.ts'

export type McpSetupResult = { ok: true; spec: McpServerSpec } | { ok: false; message: string }
export type McpProbeResult =
  | { ok: true; server: string; version: string; tools: number; moreTools: boolean }
  | { ok: false; message: string }

/** Reject malformed fields rather than silently dropping a credential on save. */
export function validateMcpSetup(value: unknown): McpSetupResult {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  if (!isSafeServerName(raw.name) || raw.name === STOKE_BROWSER_SERVER) return { ok: false, message: 'Choose a unique name using letters, numbers, underscores or hyphens. “stoke” is reserved.' }
  if (raw.transport !== 'stdio' && raw.transport !== 'http') return { ok: false, message: 'Choose a local command or an HTTP endpoint.' }
  const plain = (v: unknown): v is string => typeof v === 'string' && v.length <= 16_384 && !/[\r\n\0]/.test(v)
  const pairsOk = (v: unknown, validKey: (key: string) => boolean): boolean => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false
    const entries = Object.entries(v)
    return entries.length <= 64 && entries.every(([key, value]) => validKey(key) && plain(value))
  }
  if (raw.transport === 'stdio') {
    if (!plain(raw.command) || !raw.command.trim()) return { ok: false, message: 'Enter the executable name or path, without shell quotes.' }
    if (!Array.isArray(raw.args) || raw.args.length > 256 || !raw.args.every(plain)) return { ok: false, message: 'Arguments must be a JSON array of plain strings. Enter keys in environment variables.' }
    if (!pairsOk(raw.env, isEnvName)) return { ok: false, message: 'Environment variable names must use letters, numbers and underscores. Values must fit on one line.' }
  } else {
    if (!plain(raw.url) || !pairsOk(raw.headers, isStoredHeaderName) || (raw.bearer !== undefined && !plain(raw.bearer))) return { ok: false, message: 'Use valid header names without dots, and keep credentials on one line.' }
    if (raw.bearer && Object.keys(raw.headers as object).some((key) => key.toLowerCase() === 'authorization')) return { ok: false, message: 'Use either Bearer token or an Authorization header, so the server receives one authentication value.' }
  }
  const spec = hydrateServerSpec(raw, raw.name)
  if (!spec) return { ok: false, message: 'Enter a valid HTTP(S) endpoint or local executable.' }
  if (spec.transport === 'http' && urlInArgvProblem(spec)) return { ok: false, message: 'Use an endpoint without query parameters or embedded credentials. Enter tokens in Bearer token or Headers.' }
  return { ok: true, spec }
}

/** Removing a Stoke-held server removes its stale ticks from every agent. */
export function removeMcpServer(mcp: AgentMcpSettings, name: string): AgentMcpSettings {
  const extra = { ...mcp.extra }
  delete extra[name]
  const perAgent = { ...mcp.perAgent }
  for (const [id, names] of Object.entries(perAgent)) {
    perAgent[id as keyof typeof perAgent] = names?.filter((entry) => entry !== name)
  }
  return { extra, perAgent }
}
