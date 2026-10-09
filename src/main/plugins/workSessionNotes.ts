import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { cleanText, emptyFold, foldClaudeLine } from '../chatIndex/parse.ts'
import type { WorkSessionNotes } from '../../shared/workDrafts.ts'

const TAIL_BYTES = 512 * 1024
const NOTES_BYTES = 4096
interface Deps {
  enabled: () => Promise<boolean>
  /** Null for private, SSH, ended, setup and unsupported sessions. Main owns this admission. */
  owner: (ptyId: string) => { sessionId: string } | null
  file: (sessionId: string) => Promise<string | null>
  timeoutMs?: number
}

/** Read complete recent JSONL records only; no history index, settings or board writes. */
export async function recentWorkNotes(file: string, sessionId: string): Promise<Pick<WorkSessionNotes, 'text' | 'turns' | 'truncated'>> {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('This session has no readable transcript file.')
    const start = Math.max(0, stat.size - TAIL_BYTES)
    const buffer = Buffer.alloc(Math.min(stat.size, TAIL_BYTES))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start)
    const bytes = buffer.subarray(0, bytesRead)
    // Cut fragments BEFORE decoding: a tail may start inside a UTF-8 character.
    const first = start ? bytes.indexOf(10) + 1 : 0
    const last = bytes.lastIndexOf(10)
    const fold = emptyFold()
    if (last >= first && (!start || first > 0)) for (const line of bytes.subarray(first, last).toString('utf8').split('\n')) {
      // Some CLIs/restores leave neighbouring records in a file. An explicit
      // different identity cannot supply evidence for this session.
      let record: { sessionId?: unknown; session_id?: unknown }
      try { record = JSON.parse(line) } catch { continue }
      if (!record || typeof record !== 'object' || (typeof record.sessionId === 'string' && record.sessionId !== sessionId) || (typeof record.session_id === 'string' && record.session_id !== sessionId)) continue
      foldClaudeLine(fold, line, true)
    }
    const messages = fold.messages.slice(-24)
    let content = ''; let turns = 0
    for (const message of messages.slice().reverse()) {
      const excerpt = `${message.role === 'user' ? 'User' : 'Assistant'}: ${cleanText(message.text, { redact: true, maxBytes: 1500 })}`
      if (content && Buffer.byteLength(`${excerpt}\n\n${content}`, 'utf8') > NOTES_BYTES) break
      content = content ? `${excerpt}\n\n${content}` : excerpt
      turns++
    }
    if (!content) throw new Error('No recent conversation text is available yet. Add source notes yourself or try after a turn finishes.')
    const text = cleanText(content, { redact: true, maxBytes: NOTES_BYTES })
    return { text, turns, truncated: start > 0 || bytesRead !== buffer.length || last < bytes.length - 1 || turns < fold.messages.length || text !== content || messages.some(m => Buffer.byteLength(m.text, 'utf8') > 1500) }
  } finally { await handle.close() }
}

/** Keeps its claim through real I/O even when the caller's deadline expires. */
export class WorkSessionNotesReader {
  private deps: Deps
  private running = false
  constructor(deps: Deps) { this.deps = deps }
  read(ptyId: unknown, expectedId: unknown): Promise<WorkSessionNotes> {
    if (this.running) return Promise.reject(new Error('A session read is already running. Wait before retrying.'))
    if (typeof ptyId !== 'string' || !ptyId || ptyId.length > 128 || typeof expectedId !== 'string' || !expectedId || expectedId.length > 128) return Promise.reject(new Error('Choose a live local Claude session.'))
    this.running = true
    const run = (async () => {
      const checkOwner = (): void => { if (this.deps.owner(ptyId)?.sessionId !== expectedId) throw new Error('This session changed or is no longer available. Choose the current local Claude session.') }
      checkOwner()
      if (!await this.deps.enabled()) throw new Error('Enable Work before using session notes.')
      const file = await this.deps.file(expectedId)
      checkOwner()
      if (!file) throw new Error('This session has no saved conversation yet. Add source notes yourself or try after a turn finishes.')
      const notes = await recentWorkNotes(file, expectedId).catch((err: unknown) => {
        // Filesystem diagnostics include private transcript paths. Keep those
        // in main; the editor needs only an actionable read failure.
        if (err && typeof err === 'object' && 'code' in err) throw new Error('The saved conversation could not be read. Add source notes yourself or try after a turn finishes.')
        throw err
      })
      checkOwner()
      if (!await this.deps.enabled()) throw new Error('Work was disabled. No session notes were added.')
      checkOwner()
      return { ptyId, sessionId: expectedId, capturedAt: Date.now(), ...notes }
    })().finally(() => { this.running = false })
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([run, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Session notes could not be read within the deadline. No notes were added.')), this.deps.timeoutMs ?? 2000) })]).finally(() => clearTimeout(timer))
  }
}
