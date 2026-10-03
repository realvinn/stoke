/**
 * One chat for the read-only viewer, read in the chat-index worker.
 *
 * A local chat is read AGAIN from its own tool's file or database, read-only,
 * at the moment it is opened: the index's copy is held to `chatKb` and may be
 * a pass old, and the source is the truth (research §4.1). The same readers
 * and text rules a pass uses (`readJsonl` + `lineFolder`, `readOpencode`,
 * `readZed`, `readCline`), so what the viewer shows and what search matched
 * follow one rule — a subagent's transcript read as its own thread
 * (`foldClaudeLine`'s `subagentFile`), redaction as the setting says, or
 * always with `redact: 'force'` (what leaves this computer, spec 2026-10-03
 * §1).
 *
 * The path is the one the store remembered, and it is only read if it is
 * still inside that tool's own named root (`isInside`) — the store is 0600,
 * but a remembered path is not a licence to read anywhere. Where the original
 * is gone, unreadable or outside its root, the index's copy is shown and the
 * viewer says so. An import has no original: its copy IS the chat.
 */
import type { DatabaseSync } from 'node:sqlite'
import { isInside, pathRulesFor } from '../../shared/paths.ts'
import {
  CHAT_VIEW_MAX_BYTES,
  chatSourceInfo,
  isChatImportKind,
  type ChatOrigin,
  type ChatTranscript,
  type ChatTranscriptMessage
} from '../../shared/chatIndex.ts'
import { planTrim, REDACTION_VERSION, redactSecrets } from './parse.ts'
import {
  claudeRoots,
  clineRoot,
  codexHome,
  coworkRoot,
  lineFolder,
  opencodeDbPath,
  openReadOnly,
  readCline,
  readJsonl,
  readOpencode,
  readZed,
  zedDbPath,
  type Extracted,
  type SourceEnv
} from './sources.ts'
import type { ChatStore, StoredChat } from './store.ts'

export interface ViewOptions {
  /**
   * `true`/`false` is the local setting. `'force'` is for another computer:
   * the original is re-read with redaction on, and the index's copy is shown
   * only if it was cleaned with the rules in force now — never cleaned on the
   * way out from a copy stored while redaction was off (a message cut at the
   * text cap may have lost the END of a key with it). Not cleaned means null:
   * nothing, rather than something less clean than the search that found it.
   */
  redact: boolean | 'force'
  /** Bytes read from one file, as the pass reads it (`fileMb`): past it, a head and a tail. */
  fileBytes: number
  /** A suite shrinks it. */
  maxBytes?: number
}

/** The opening and the newest of a long chat, the middle left out — `planTrim`'s split. */
function bounded(messages: ChatTranscriptMessage[], maxBytes: number): { messages: ChatTranscriptMessage[]; cut: boolean } {
  const drop = new Set(planTrim(messages.map((m) => Buffer.byteLength(m.text, 'utf8')), maxBytes))
  return drop.size ? { messages: messages.filter((_, i) => !drop.has(i)), cut: true } : { messages, cut: false }
}

type Read = { ok: true; ex: Extracted } | { ok: false; why: string }

/** Re-read a local chat from where the store says it came from, if that is still inside its tool's root. */
function readSource(c: StoredChat, env: SourceEnv, opts: ViewOptions & { redact: boolean }): Read {
  const label = chatSourceInfo(c.source as never).label
  if (!c.locator) return { ok: false, why: `${label} no longer lists this chat, so this is the index’s copy.` }
  const rules = pathRulesFor(env.platform)
  const hash = c.locator.lastIndexOf('#')
  // A prefix test, so a `..` segment could walk out of a root that it still starts with.
  const inRoot = (roots: string[], p: string): boolean => !p.split(/[/\\]/).includes('..') && roots.some((r) => isInside(r, p, rules))
  const gone = `The original is no longer where ${label} kept it, so this is the index’s copy.`
  let db: DatabaseSync | null = null
  try {
    switch (c.source) {
      case 'claude':
      case 'claude-cowork':
      case 'codex': {
        const roots = c.source === 'claude' ? claudeRoots(env) : c.source === 'codex' ? [codexHome(env)] : [coworkRoot(env)]
        if (!inRoot(roots, c.locator)) return { ok: false, why: gone }
        const kind = c.source === 'codex' ? 'jsonl-codex' : 'jsonl-claude'
        return { ok: true, ex: readJsonl(c.locator, null, opts.fileBytes, lineFolder(kind, opts.redact, c.subagent)) }
      }
      case 'cline': {
        if (!inRoot([clineRoot(env)], c.locator)) return { ok: false, why: gone }
        return { ok: true, ex: readCline({ path: c.locator }, opts.fileBytes, opts.redact) }
      }
      case 'opencode':
      case 'zed': {
        const dbPath = hash > 0 ? c.locator.slice(0, hash) : ''
        const expected = c.source === 'opencode' ? opencodeDbPath(env) : zedDbPath(env)
        // The database is the tool's one named file: exactly it, nothing beside it.
        if (!dbPath || dbPath !== expected) return { ok: false, why: gone }
        db = openReadOnly(dbPath)
        const row = { nativeId: c.nativeId, mtimeMs: c.updatedMs ?? 0 }
        return { ok: true, ex: c.source === 'opencode' ? readOpencode(db, row, opts.redact) : readZed(db, row, opts.fileBytes, opts.redact) }
      }
      default:
        return { ok: false, why: gone }
    }
  } catch (err) {
    const code = (err as { code?: unknown }).code
    return { ok: false, why: code === 'ENOENT' ? gone : `${label}’s copy could not be read just now, so this is the index’s copy.` }
  } finally {
    db?.close()
  }
}

export function openChat(store: ChatStore, chatId: number, env: SourceEnv, opts: ViewOptions): ChatTranscript | null {
  const c = store.chat(chatId)
  if (!c) return null
  const force = opts.redact === 'force'
  const redact = opts.redact === true || force
  // Forced: the index's copy is shown only if it was cleaned with today's rules.
  const storeServable = !force || c.redactLevel >= REDACTION_VERSION
  const maxBytes = opts.maxBytes ?? CHAT_VIEW_MAX_BYTES
  const stored = (): ChatTranscriptMessage[] =>
    store
      .messages(chatId)
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text, atMs: m.atMs }))
  const title = force && c.title !== null ? redactSecrets(c.title) : c.title
  const base = { chatId, source: c.source, title, cwd: c.cwd, createdMs: c.createdMs, updatedMs: c.updatedMs }
  if (isChatImportKind(c.source)) {
    if (!storeServable) return null
    const b = bounded(stored(), maxBytes)
    return { ...base, messages: b.messages, from: 'store', fallback: null, partial: b.cut || c.truncated }
  }
  const read = readSource(c, env, { ...opts, redact })
  if (read.ok && read.ex.fold.messages.length > 0) {
    const b = bounded(read.ex.fold.messages, maxBytes)
    return { ...base, messages: b.messages, from: 'source', fallback: null, partial: b.cut || read.ex.truncated }
  }
  if (!storeServable) return null
  const why = read.ok ? `${chatSourceInfo(c.source as never).label}’s copy of this chat has no text in it now, so this is the index’s copy.` : read.why
  const b = bounded(stored(), maxBytes)
  return { ...base, messages: b.messages, from: 'store', fallback: why, partial: b.cut || c.truncated }
}

/** One chat by its tool's own id, for another computer (`/api/chats/open?source=&id=`): always `redact: 'force'`. */
export function openChatCleaned(store: ChatStore, source: ChatOrigin, nativeId: string, env: SourceEnv, opts: Omit<ViewOptions, 'redact'>): ChatTranscript | null {
  const chatId = store.chatId(source, nativeId)
  return chatId === null ? null : openChat(store, chatId, env, { ...opts, redact: 'force' })
}
