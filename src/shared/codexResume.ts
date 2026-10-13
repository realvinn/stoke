export interface CodexResumeSettings {
  enabled: boolean
  checkMinutes: number
  recheckHours: number
  message: string
}

export const DEFAULT_CODEX_RESUME: CodexResumeSettings = {
  enabled: false, checkMinutes: 5, recheckHours: 5, message: 'Continue'
}

export function hydrateCodexResume(raw: unknown): CodexResumeSettings {
  const r = raw && typeof raw === 'object' ? raw as Partial<CodexResumeSettings> : {}
  const number = (v: unknown, fallback: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, v)) : fallback
  const message = typeof r.message === 'string' ? r.message.trim() : ''
  return {
    enabled: r.enabled === true,
    checkMinutes: number(r.checkMinutes, 5, 1, 1440),
    recheckHours: number(r.recheckHours, 5, 1 / 60, 168),
    // A terminal message must never contain escape sequences or embedded Enter keys.
    message: message && message.length <= 2000 && !/[\x00-\x1f\x7f]/.test(message) ? message : 'Continue'
  }
}

/** Only the CLI's limit error immediately above its composer, never the whole scrollback. */
export function codexLimitReset(text: string, observedAt: number): { signature: string; resetAt: number | null } | null {
  if (/esc to (?:interrupt|cancel)|working\s*\(/i.test(text)) return null
  const lines = text.split('\n')
  const prompt = lines.findLastIndex(line => /^\s*›/.test(line))
  if (prompt < 0) return null
  const above = lines.slice(Math.max(0, prompt - 12), prompt)
  const block = above.findLastIndex(line => /^\s*[■●×✕!•›]/.test(line))
  const body = above.slice(Math.max(0, block)).join(' ').replace(/\s+/g, ' ')
  const error = /(?:^|\s)[■●×✕!]\s*((?:you(?:'|’)ve hit your usage limit|you have hit your usage limit|you(?:'|’)ve reached your usage limit|usage limit (?:reached|exceeded))\b.*)/i.exec(body)
  if (!error) return null
  const signature = error[1].trim()
  const retry = /try again (?:at|after)\s+(.+?)(?:\.(?:\s|$)|$)/i.exec(signature)?.[1]?.trim()
  let resetAt: number | null = null
  if (retry) {
    // Codex's local timestamp format: Oct 14, 2026 1:30 AM. Also accept explicit ISO timestamps.
    const date = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d{1,2}),?\s+(\d{4})\s+(\d{1,2}):(\d{2})\s*(AM|PM)\b/i.exec(retry)
    if (date) {
      const month = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'].indexOf(date[1].toLowerCase())
      const day = Number(date[2]), year = Number(date[3]), hour = Number(date[4]), minute = Number(date[5])
      const local = new Date(year, month, day, hour % 12 + (date[6].toUpperCase() === 'PM' ? 12 : 0), minute)
      if (hour >= 1 && hour <= 12 && minute < 60 && local.getFullYear() === year && local.getMonth() === month && local.getDate() === day) resetAt = local.getTime()
    } else {
      const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})\b/.exec(retry)
      if (iso) {
        const year = Number(iso[1]), month = Number(iso[2]) - 1, day = Number(iso[3])
        const calendar = new Date(Date.UTC(year, month, day)), parsed = Date.parse(iso[0])
        if (calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month && calendar.getUTCDate() === day && Number(iso[4]) < 24 && Number(iso[5]) < 60 && Number(iso[6] ?? 0) < 60 && Number.isFinite(parsed)) resetAt = parsed
      }
    }
  }
  const relative = /try again in\s+(\d+)\s*(minutes?|hours?|seconds?)\b/i.exec(signature)
  if (resetAt === null && relative) resetAt = observedAt + Number(relative[1]) * (/hour/i.test(relative[2]) ? 3600000 : /minute/i.test(relative[2]) ? 60000 : 1000)
  return { signature, resetAt }
}

export interface CodexResumeObservation {
  text: string
  ready: boolean
  lastInputAt: number | null
  lastOutputAt: number
}
