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
      rows.push({ id: row.id, name: text(row.name).slice(0, 256) || row.id, kind: category === 'bots' ? 'Bot' : 'Group' })
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
    const role = entry.role === 'user' || ['user-message', 'user', 'prompt', 'human-message'].includes(kind) || typeof entry.prompt === 'string'
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
