/** Main-only credentials never enter these conversation views. */
export interface GrokBotMessage {
  id: string
  role: 'user' | 'assistant' | 'activity'
  text: string
  atMs: number | null
}
export interface GrokBotThread {
  id: string
  name: string
  kind: 'Bot' | 'Group'
  hidden?: boolean
}
const record = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw)
const text = (raw: unknown): string => typeof raw === 'string' ? raw : ''

export function grokBotThreads(raw: unknown): GrokBotThread[] {
  if (!record(raw)) return []
  const rows: GrokBotThread[] = [], seen = new Set<string>()
  for (const category of ['bots', 'groups'] as const) {
    if (!Array.isArray(raw[category])) continue
    for (const row of raw[category].slice(0, 200)) {
      if (!record(row) || typeof row.id !== 'string' || !row.id || row.id.length > 256 || seen.has(row.id)) continue
      seen.add(row.id)
      rows.push({ id: row.id, name: text(row.name).slice(0, 256) || row.id, kind: category === 'bots' ? 'Bot' : 'Group', ...(row.hiddenFromSidebar === true ? { hidden: true } : {}) })
    }
  }
  return rows
}

/** Shapes follow the pinned CLI's transcript reader, including nested bot replies. */
export function grokBotMessages(raw: unknown): GrokBotMessage[] {
  if (!record(raw)) return []
  const body = record(raw.transcript) ? raw.transcript : record(raw.thread) ? raw.thread : raw
  if (!Array.isArray(body.entries)) return []
  const messages: GrokBotMessage[] = []
  for (const [index, entry] of body.entries.slice(-200).entries()) {
    if (!record(entry)) continue
    let content = text(entry.text) || text(entry.prompt) || text(entry.message) || text(entry.content)
    if (!content && Array.isArray(entry.content))
      content = entry.content.slice(0, 200).map(part => text(part) || (record(part) ? text(part.text) || text(part.content) : '')).filter(Boolean).join('\n')
    if (!content && record(entry.content)) content = text(entry.content.text)
    if (!content && record(entry.message)) content = text(entry.message.content)
    content ||= text(entry.preview)
    if (!content.trim()) continue
    const kind = text(entry.kind)
    const role = entry.role === 'user' || ['user-message', 'user', 'prompt', 'human-message'].includes(kind) || !!text(entry.prompt)
      ? 'user' : entry.role === 'assistant' || ['send-message', 'assistant-message', 'assistant', 'bot-message'].includes(kind)
        ? 'assistant' : 'activity'
    const at = entry.atMs ?? entry.timestamp ?? entry.createdAtMs
    messages.push({
      id: text(entry.id).slice(0, 256) || `entry-${index}`,
      role,
      text: content.slice(0, 128 * 1024).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ''),
      atMs: typeof at === 'number' && Number.isFinite(at) && at >= 0 && at <= 8.64e15 ? at : null
    })
  }
  return messages
}

export interface GrokBotProfile { name: string; title: string; description: string; notify: boolean; hidden: boolean; members: string[] }
export function grokBotProfile(raw: unknown): GrokBotProfile | null {
  if (!record(raw) || !text(raw.id) || !text(raw.name)) return null
  return { name: text(raw.name).slice(0, 100), title: text(raw.title).slice(0, 256), description: text(raw.description).slice(0, 16384), notify: raw.notifyOnAgentUpdates === true, hidden: raw.hiddenFromSidebar === true, members: Array.isArray(raw.members) ? raw.members.filter((id): id is string => typeof id === 'string' && id.length <= 256).slice(0, 6) : [] }
}
export interface GrokBotSkill { id: string; name: string; description: string; source: string }
export function grokBotSkills(raw: unknown): GrokBotSkill[] {
  if (!Array.isArray(raw)) return []
  return raw.slice(0, 200).flatMap(row => record(row) && text(row.id) ? [{ id: text(row.id).slice(0, 256), name: text(row.name).slice(0, 256), description: text(row.description).slice(0, 2048), source: text(row.source).slice(0, 100) }] : [])
}
export interface GrokBotApproval { entryId: string; requestId: string; type: string; details: string; truncated: boolean }
export function grokBotApprovals(raw: unknown): GrokBotApproval[] {
  if (!record(raw) || !Array.isArray(raw.approvals)) return []
  return raw.approvals.slice(0, 200).flatMap(row => {
    if (!record(row) || !text(row.entryId) || !text(row.requestId) || !['auto-review-approval', 'local-tool-permission'].includes(text(row.type))) return []
    const details = ['summary', 'reason', 'action', 'command', 'description', 'target', 'machineId', 'surface', 'workingDirectory'].flatMap(key => text(row[key]) ? [`${key}: ${text(row[key]).slice(0, 2048)}`] : []).join('\n')
    return [{ entryId: text(row.entryId).slice(0, 256), requestId: text(row.requestId).slice(0, 256), type: text(row.type), details, truncated: row.truncated === true }]
  })
}

/** Switching bots/accounts retains bounded drafts without writing chat contents to disk. */
export function grokBotSwitch(binding: import('./grokBot.ts').GrokBotTabBinding, account: { id: string; label: string }, thread?: GrokBotThread): Partial<import('./grokBot.ts').GrokBotTabBinding> {
  const drafts = { ...binding.drafts }
  if (binding.accountId && binding.targetId) {
    const old = `${binding.accountId}:${binding.targetId}`
    delete drafts[old]
    if (binding.draft) drafts[old] = { draft: binding.draft.slice(0, 32 * 1024), delivery: binding.delivery, sendError: binding.sendError }
  }
  const targetId = thread?.id || ''
  const next = `${account.id}:${targetId}`
  const saved = targetId ? drafts[next] : undefined
  delete drafts[next]
  return { accountId: account.id, accountLabel: account.label, targetId, targetLabel: thread?.name || '', draft: saved?.draft || '', drafts: Object.fromEntries(Object.entries(drafts).slice(-16)), delivery: saved?.delivery, sendError: saved?.sendError || '' }
}
