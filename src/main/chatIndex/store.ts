/**
 * The chat index's store: one SQLite file in userData with FTS5, written by one
 * writer — the chat-index worker (`worker.ts`), never the main process.
 *
 * `node:sqlite` is imported statically HERE on purpose: this module is loaded
 * only inside the worker (and by `verify:chat-sources`), so the main process
 * never evaluates it (gotcha 40). No native npm module — the runtime's own
 * SQLite (3.53.1 in Electron 43, with FTS5) is the only one, so nothing here
 * needs a per-arch build (gotcha 67).
 *
 * Private by construction: the directory is 0700, and the database, its WAL
 * and its shared-memory file are chmodded 0600 after every open and every pass
 * (a worker thread cannot set a umask). It holds the text of the user's chats,
 * and Claude Code's own transcripts are 0600 in 0700 folders — the copy must
 * be no easier to read than the original.
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  CHAT_IMPORT_KINDS,
  CHAT_SOURCE_IDS,
  emptyChatStatus,
  ftsQuery,
  isChatImportKind,
  isChatOrigin,
  isChatSourceId,
  parseMarked,
  HIT_CLOSE,
  HIT_OPEN,
  type ChatCap,
  type ChatImportKind,
  type ChatImportRecord,
  type ChatIndexStatus,
  type ChatOrigin,
  type ChatPassSummary,
  type ChatSearchHit,
  type ChatSourceId,
  type ChatSourceStatus
} from '../../shared/chatIndex.ts'
import { isInside, pathRulesFor } from '../../shared/paths.ts'
import { clampChatSearchFilters, hasChatSearchFilters, type ChatSearchFilters } from '../../shared/chatSearch.ts'
import { cleanText, CUT_MARK, FIRST_PROMPT_MAX, planTrim, REDACTION_VERSION, redactCutTail, redactMarkedCut, redactSecrets, redactToolCut, type ChatMessage, type ChatMeta } from './parse.ts'

export const STORE_FILE = 'index.sqlite'

/**
 * `search`'s `skip` for the owner's hidden folders (`hiddenProjects`), by
 * `platform`'s path rules — the same `isInside` test as `chatIndexForGuests`'s
 * `hidden` (index.ts). Undefined when nothing is hidden, so the search keeps
 * its SQL limit.
 */
export function skipFolders(folders: readonly unknown[], platform: string): ((cwd: string) => boolean) | undefined {
  const hidden = folders.filter((f): f is string => typeof f === 'string' && f !== '')
  if (hidden.length === 0) return undefined
  const rules = pathRulesFor(platform)
  return (cwd) => hidden.some((f) => isInside(f, cwd, rules))
}
/*
 * 2: imports — the `import_file` table and `chat.import_id`. A version-1 store
 * gains the column in place (`migrate`); nothing in it is rewritten.
 * 3: `chat.redact_level` — which redaction rules a chat's stored text was
 * cleaned with (`REDACTION_VERSION`, 0 for none). An older store gains it at
 * 0, so every chat in it counts as not cleaned until a pass with redaction on
 * cleans it again (`recleanStale`): its text was cleaned, if at all, by fewer
 * rules than the ones in force now.
 */
const SCHEMA_VERSION = '5'

/** Where a source's file (or row) was read up to, so the next pass reads only what is new. */
export interface FileRow {
  locator: string
  source: ChatSourceId
  chatId: number | null
  dev: number
  ino: number
  size: number
  mtimeMs: number
  /** Bytes folded so far; the byte before it was a newline. 0 for whole-document sources. */
  offset: number
}

export interface SourceStateRow {
  found: number | null
  foundAtLeast: boolean
  target: number | null
  duplicates: number
  bytesRead: number
  cappedBy: ChatCap | null
  lastPassMs: number | null
  error: string | null
}

export interface ChatRow {
  id: number
  source: ChatSourceId
  nativeId: string
  updatedMs: number | null
}

/** One chat as the viewer needs it from the store: its row, where it was read from, and the index's copy of its text. */
export interface StoredChat {
  id: number
  source: ChatOrigin
  nativeId: string
  title: string | null
  cwd: string | null
  createdMs: number | null
  updatedMs: number | null
  subagent: boolean
  truncated: boolean
  /** The file (or `<db>#<id>` row) it was read from; null for an import. */
  locator: string | null
  /** Which redaction rules its stored text was cleaned with (`REDACTION_VERSION`; 0 for none). */
  redactLevel: number
}

/** What an import did, written when it ends — stopped part-way too, when `added + updated + empty` is short of `admitted`. */
export interface ImportTally {
  admitted: number
  added: number
  updated: number
  empty: number
  truncated: number
  cappedBy: 'perSource' | 'total' | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  native_id TEXT NOT NULL,
  title TEXT, first_prompt TEXT, cwd TEXT, git_branch TEXT, model TEXT,
  created_ms INTEGER, updated_ms INTEGER,
  context_tokens INTEGER, context_at_ms INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  text_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  subagent INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT,
  import_id INTEGER,
  redact_level INTEGER NOT NULL DEFAULT 0,
  UNIQUE(source, native_id)
);
CREATE INDEX IF NOT EXISTS chat_updated ON chat(updated_ms);
CREATE TABLE IF NOT EXISTS message (
  id INTEGER PRIMARY KEY,
  chat_id INTEGER NOT NULL REFERENCES chat(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  role TEXT NOT NULL,
  at_ms INTEGER,
  bytes INTEGER NOT NULL,
  text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS message_chat ON message(chat_id, ord);
CREATE VIRTUAL TABLE IF NOT EXISTS message_fts USING fts5(
  text, content='message', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS message_ai AFTER INSERT ON message BEGIN
  INSERT INTO message_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS message_ad AFTER DELETE ON message BEGIN
  INSERT INTO message_fts(message_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS message_au AFTER UPDATE OF text ON message BEGIN
  INSERT INTO message_fts(message_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO message_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TABLE IF NOT EXISTS source_file (
  locator TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  chat_id INTEGER,
  dev INTEGER NOT NULL DEFAULT 0, ino INTEGER NOT NULL DEFAULT 0,
  size INTEGER NOT NULL DEFAULT 0, mtime_ms INTEGER NOT NULL DEFAULT 0,
  offset INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS source_file_chat ON source_file(chat_id);
CREATE TABLE IF NOT EXISTS source_state (
  source TEXT PRIMARY KEY,
  found INTEGER, found_at_least INTEGER NOT NULL DEFAULT 0, target INTEGER,
  duplicates INTEGER NOT NULL DEFAULT 0,
  bytes_read INTEGER NOT NULL DEFAULT 0,
  capped_by TEXT, last_pass_ms INTEGER, error TEXT
);
CREATE TABLE IF NOT EXISTS import_file (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  file_name TEXT NOT NULL,
  bytes INTEGER NOT NULL DEFAULT 0,
  imported_ms INTEGER NOT NULL,
  found INTEGER NOT NULL DEFAULT 0,
  admitted INTEGER NOT NULL DEFAULT 0,
  added INTEGER NOT NULL DEFAULT 0,
  updated INTEGER NOT NULL DEFAULT 0,
  empty INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  capped_by TEXT
);
`

const CAPS: readonly ChatCap[] = ['perSource', 'total', 'bytes', 'time', 'discovery', 'store']
function capOf(v: unknown): ChatCap | null {
  return typeof v === 'string' && (CAPS as readonly string[]).includes(v) ? (v as ChatCap) : null
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : 0
}

function numOrNull(v: unknown): number | null {
  return typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : null
}

function strOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

export class ChatStore {
  readonly dir: string
  readonly file: string
  private db: DatabaseSync
  private stmts = new Map<string, StatementSync>()

  /** Whether a store exists in `dir` — asked before opening, so a status read never creates one. */
  static exists(dir: string): boolean {
    return existsSync(join(dir, STORE_FILE))
  }

  static open(dir: string): ChatStore {
    return new ChatStore(dir)
  }

  private constructor(dir: string) {
    this.dir = dir
    this.file = join(dir, STORE_FILE)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    chmodSync(dir, 0o700)
    this.db = new DatabaseSync(this.file, { timeout: 2000 })
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA synchronous = NORMAL;')
    this.db.exec(SCHEMA)
    this.migrate()
    this.lockDown()
  }

  /*
   * A store written before imports existed has no `chat.import_id`: `CREATE
   * TABLE IF NOT EXISTS` leaves an existing table as it is, so the column is
   * added here. Its index can only be made once the column exists.
   */
  private migrate(): void {
    const cols = (this.db.prepare('PRAGMA table_info(chat)').all() as { name?: unknown }[]).map((c) => c.name)
    if (!cols.includes('import_id')) this.db.exec('ALTER TABLE chat ADD COLUMN import_id INTEGER')
    if (!cols.includes('redact_level')) this.db.exec('ALTER TABLE chat ADD COLUMN redact_level INTEGER NOT NULL DEFAULT 0')
    if (!cols.includes('context_tokens')) this.db.exec('ALTER TABLE chat ADD COLUMN context_tokens INTEGER')
    if (!cols.includes('context_at_ms')) this.db.exec('ALTER TABLE chat ADD COLUMN context_at_ms INTEGER')
    this.db.exec('CREATE INDEX IF NOT EXISTS chat_import ON chat(import_id)')
    this.db.exec('CREATE INDEX IF NOT EXISTS chat_redact ON chat(redact_level)')
    const prior = this.q('SELECT value FROM meta WHERE key = ?').get('schema') as { value?: unknown } | undefined
    if (prior && Number(prior.value) < 5) {
      // Old Codex snapshots used the cumulative field. Unknown until the next native reading or index rebuild.
      this.db.exec("UPDATE chat SET context_tokens = NULL, context_at_ms = NULL WHERE source = 'codex'")
    }
    this.q('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('schema', SCHEMA_VERSION)
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmts.set(sql, s)
    }
    return s
  }

  /** 0600 on the database and whichever of its WAL and shared-memory files exist now. */
  lockDown(): void {
    for (const f of [this.file, `${this.file}-wal`, `${this.file}-shm`]) {
      try {
        chmodSync(f, 0o600)
      } catch {
        /* not created yet; the next lockDown gets it */
      }
    }
  }

  /** Run `fn` in one transaction: a chat's messages land together or not at all. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /* ------------------------------------------------------------ files */

  getFile(locator: string): FileRow | null {
    const r = this.q('SELECT * FROM source_file WHERE locator = ?').get(locator) as Record<string, unknown> | undefined
    if (!r || !isChatSourceId(r.source)) return null
    return {
      locator,
      source: r.source,
      chatId: numOrNull(r.chat_id),
      dev: num(r.dev),
      ino: num(r.ino),
      size: num(r.size),
      mtimeMs: num(r.mtime_ms),
      offset: num(r.offset)
    }
  }

  putFile(f: FileRow): void {
    this.q(
      `INSERT INTO source_file(locator, source, chat_id, dev, ino, size, mtime_ms, offset) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(locator) DO UPDATE SET source = excluded.source, chat_id = excluded.chat_id, dev = excluded.dev,
       ino = excluded.ino, size = excluded.size, mtime_ms = excluded.mtime_ms, offset = excluded.offset`
    ).run(f.locator, f.source, f.chatId, f.dev, f.ino, f.size, Math.round(f.mtimeMs), f.offset)
  }

  /* ------------------------------------------------------------ chats */

  chatId(source: ChatOrigin, nativeId: string): number | null {
    const r = this.q('SELECT id FROM chat WHERE source = ? AND native_id = ?').get(source, nativeId) as { id?: unknown } | undefined
    return r ? numOrNull(r.id) : null
  }

  hasChat(source: ChatSourceId, nativeId: string): boolean {
    return this.chatId(source, nativeId) !== null
  }

  /**
   * Create or update a chat's row. A field the new read does not know (an
   * append that carried no title) keeps what the store had: `COALESCE` with the
   * old value, never a blank over a good one.
   *
   * The first prompt and the folder are the chat's FIRST ones, so an append
   * never moves them: an appended run's first user record is only the newest
   * turn's, and its cwd is wherever a `cd` left the session, not the folder the
   * session was started in and is resumed from (`foldClaudeLine`). A `whole`
   * read — the file from byte 0, or a whole document or row — says what the
   * chat's first ones are, so it wins.
   *
   * `redact` says whether this write's text was cleaned with redaction on.
   * The chat's level only ever goes DOWN here (`MIN`): a field this write does
   * not replace (an append's messages before it, a title the read did not
   * carry) keeps whatever it was stored with. Only `recleanChat` raises it.
   */
  upsertChat(
    source: ChatOrigin,
    nativeId: string,
    meta: ChatMeta,
    flags: { subagent: boolean; dedupeKey: string | null; whole: boolean; redact: boolean }
  ): number {
    const first = (col: string): string => (flags.whole ? `COALESCE(excluded.${col}, chat.${col})` : `COALESCE(chat.${col}, excluded.${col})`)
    this.q(
      `INSERT INTO chat(source, native_id, title, first_prompt, cwd, git_branch, model, created_ms, updated_ms, subagent, dedupe_key, redact_level, context_tokens, context_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, native_id) DO UPDATE SET
         redact_level = MIN(chat.redact_level, excluded.redact_level),
         title = COALESCE(excluded.title, chat.title),
         first_prompt = ${first('first_prompt')},
         cwd = ${first('cwd')},
         git_branch = COALESCE(excluded.git_branch, chat.git_branch),
         model = COALESCE(excluded.model, chat.model),
         created_ms = MIN(COALESCE(chat.created_ms, excluded.created_ms), COALESCE(excluded.created_ms, chat.created_ms)),
         updated_ms = MAX(COALESCE(chat.updated_ms, 0), COALESCE(excluded.updated_ms, 0)),
         context_tokens = CASE WHEN excluded.context_at_ms IS NOT NULL AND
           (chat.context_at_ms IS NULL OR excluded.context_at_ms >= chat.context_at_ms)
           THEN excluded.context_tokens ELSE chat.context_tokens END,
         context_at_ms = MAX(COALESCE(chat.context_at_ms, excluded.context_at_ms), COALESCE(excluded.context_at_ms, chat.context_at_ms)),
         subagent = excluded.subagent,
         dedupe_key = excluded.dedupe_key`
    ).run(
      source,
      nativeId,
      meta.title,
      meta.firstPrompt,
      meta.cwd,
      meta.gitBranch,
      meta.model,
      meta.createdMs === null ? null : Math.round(meta.createdMs),
      meta.updatedMs === null ? null : Math.round(meta.updatedMs),
      flags.subagent ? 1 : 0,
      flags.dedupeKey,
      flags.redact ? REDACTION_VERSION : 0,
      meta.contextTokens ?? null,
      meta.contextAtMs ?? null
    )
    const id = this.chatId(source, nativeId)
    if (id === null) throw new Error('chat row vanished after upsert')
    this.setTitleRow(id)
    return id
  }

  /*
   * The title is indexed as its own row (ord -1, role `title`), so a Codex
   * thread's name or a Cowork session's title is searchable even when no
   * message says it. Rewritten only when it changed, so the FTS row is not
   * churned on every append.
   */
  private setTitleRow(chatId: number): void {
    const c = this.q('SELECT title FROM chat WHERE id = ?').get(chatId) as { title?: unknown } | undefined
    const title = strOrNull(c?.title)
    const cur = this.q('SELECT id, text FROM message WHERE chat_id = ? AND ord = -1').get(chatId) as { id?: unknown; text?: unknown } | undefined
    if (cur && strOrNull(cur.text) === title) return
    if (cur) this.q('DELETE FROM message WHERE id = ?').run(num(cur.id))
    if (title) {
      this.q('INSERT INTO message(chat_id, ord, role, at_ms, bytes, text) VALUES (?, -1, ?, NULL, ?, ?)').run(
        chatId,
        'title',
        Buffer.byteLength(title, 'utf8'),
        title
      )
    }
  }

  /** Drop every message of a chat (its title row too) — a whole-document re-read. */
  clearMessages(chatId: number): void {
    this.q('DELETE FROM message WHERE chat_id = ? AND ord >= 0').run(chatId)
    this.q('UPDATE chat SET message_count = 0, text_bytes = 0, truncated = 0 WHERE id = ?').run(chatId)
  }

  /** Append messages after the chat's last one. */
  appendMessages(chatId: number, messages: readonly ChatMessage[]): void {
    if (messages.length === 0) return
    const last = this.q('SELECT MAX(ord) AS o FROM message WHERE chat_id = ?').get(chatId) as { o?: unknown } | undefined
    let ord = (numOrNull(last?.o) ?? -1) + 1
    if (ord < 0) ord = 0
    const ins = this.q('INSERT INTO message(chat_id, ord, role, at_ms, bytes, text) VALUES (?, ?, ?, ?, ?, ?)')
    let bytes = 0
    for (const m of messages) {
      const b = Buffer.byteLength(m.text, 'utf8')
      bytes += b
      ins.run(chatId, ord++, m.role, m.atMs === null ? null : Math.round(m.atMs), b, m.text)
    }
    this.q('UPDATE chat SET message_count = message_count + ?, text_bytes = text_bytes + ? WHERE id = ?').run(
      messages.length,
      bytes,
      chatId
    )
  }

  /**
   * Hold a chat to `capBytes` of text: its opening and its newest messages,
   * the middle dropped (`planTrim`). Returns whether anything was dropped.
   */
  trimChat(chatId: number, capBytes: number): boolean {
    const c = this.q('SELECT text_bytes FROM chat WHERE id = ?').get(chatId) as { text_bytes?: unknown } | undefined
    if (num(c?.text_bytes) <= capBytes) return false
    const rows = this.q('SELECT id, bytes FROM message WHERE chat_id = ? AND ord >= 0 ORDER BY ord').all(chatId) as { id: unknown; bytes: unknown }[]
    const drop = planTrim(
      rows.map((r) => num(r.bytes)),
      capBytes
    )
    if (drop.length === 0) return false
    const del = this.q('DELETE FROM message WHERE id = ?')
    let bytes = 0
    for (const i of drop) {
      del.run(num(rows[i].id))
      bytes += num(rows[i].bytes)
    }
    this.q('UPDATE chat SET message_count = message_count - ?, text_bytes = text_bytes - ?, truncated = 1 WHERE id = ?').run(
      drop.length,
      bytes,
      chatId
    )
    return true
  }

  markTruncated(chatId: number): void {
    this.q('UPDATE chat SET truncated = 1 WHERE id = ?').run(chatId)
  }

  /* -------------------------------------------------------- redaction */

  /**
   * Chats whose stored text was not cleaned with the rules in force now
   * (`REDACTION_VERSION`): written while redaction was off, or by an older
   * rule set. Oldest id first, so a pass that stops part-way carries on.
   */
  staleChatIds(limit: number): number[] {
    return (this.q('SELECT id FROM chat WHERE redact_level < ? ORDER BY id LIMIT CAST(? AS INTEGER)').all(REDACTION_VERSION, limit) as { id: unknown }[]).map((r) =>
      num(r.id)
    )
  }

  /** How many chats `staleChatIds` would name: what a cleaned-only search leaves out. */
  staleCount(): number {
    const r = this.q('SELECT COUNT(*) AS n FROM chat WHERE redact_level < ?').get(REDACTION_VERSION) as { n?: unknown } | undefined
    return num(r?.n)
  }

  /**
   * Clean one chat's stored text again with redaction on and the rules in
   * force now — every message, its title (and the title's search row) and its
   * first prompt — and mark it cleaned. In one transaction: a chat is cleaned
   * whole or not at all, so its level never claims more than its text holds.
   *
   * The text is cleaned in place, not re-read from its tool: an import has no
   * tool to re-read, and a chat its tool has since deleted is still here.
   * `cleanText` is idempotent on stored text with no byte cap (the cap's
   * ` …` would be added again), and a message `[redacted]` made longer stays
   * longer — the chat's text cap is the pass's to keep, not this.
   *
   * Text stored raw was cut at its cap BEFORE anything judged it, so a key
   * straddling the cap left its first part, which no pattern knows for a key
   * (`ghp_Ab1Cd2Ef3Gh4Ij5Kl …`): a message or title that ends in the cap's
   * mark, and a first prompt at its length cap (`FIRST_PROMPT_MAX`, cut with
   * no mark by a raw pass's `firstPromptOf`), has a token-shaped last word
   * made `[redacted]` before the chat is raised (`redactMarkedCut`,
   * `redactCutTail`; re-review of 62b4ae6). So does a title with no mark at
   * that length or past it: a Cline chat with no title of its own took its
   * RAW prompt's first 300 characters as one, cut inside a word by the
   * `firstPromptOf` before 62b4ae6's and cleaned only after, so a key the cut
   * ran through kept 39 of an npm token's 40 characters through every rule
   * set (review of 166e84f). A cleaning that lengthened it (`password=x` →
   * `password=[redacted]`) leaves it past the cap; one that shortened it
   * (a key before it taken) leaves it under, and is not caught. And a Cline
   * chat's own title that ends in `…` (rule set 6): Cline cuts it at 119
   * characters inside a word, and the raw prompt `toolCutTitle` checks it
   * against at a pass is not at hand here, so its last word is judged as a
   * cut one whatever (`redactToolCut`).
   */
  recleanChat(chatId: number): boolean {
    const clean = (t: string): string => redactMarkedCut(cleanText(t, { redact: true, maxBytes: Infinity }))
    const atCap = (t: string, c: string): string => (t.length >= FIRST_PROMPT_MAX ? redactCutTail(c) : c)
    const cleanFirst = (t: string): string => atCap(t, cleanText(t, { redact: true, maxBytes: Infinity }))
    const cleanTitle = (t: string): string => (t.endsWith(CUT_MARK) ? clean(t) : atCap(t, clean(t)))
    return this.tx(() => {
      const c = this.q('SELECT source, title, first_prompt FROM chat WHERE id = CAST(? AS INTEGER)').get(chatId) as
        | { source?: unknown; title?: unknown; first_prompt?: unknown }
        | undefined
      if (!c) return false
      // Cline's own title, cut inside a word with a `…` and stored as it was before rule set 6 (`toolCutTitle`): the raw prompt is gone, so every one ending so.
      const titleOf = (t: string): string => (c.source === 'cline' ? redactToolCut(cleanTitle(t)) : cleanTitle(t))
      const rows = this.q('SELECT id, text, bytes FROM message WHERE chat_id = ? AND ord >= 0').all(chatId) as { id: unknown; text: unknown; bytes: unknown }[]
      const upd = this.q('UPDATE message SET text = ?, bytes = ? WHERE id = CAST(? AS INTEGER)')
      let delta = 0
      for (const r of rows) {
        const text = String(r.text)
        const next = clean(text)
        if (next === text) continue
        const b = Buffer.byteLength(next, 'utf8')
        delta += b - num(r.bytes)
        upd.run(next, b, num(r.id))
      }
      const title = strOrNull(c.title)
      const first = strOrNull(c.first_prompt)
      this.q('UPDATE chat SET title = ?, first_prompt = ?, text_bytes = text_bytes + ?, redact_level = ? WHERE id = CAST(? AS INTEGER)').run(
        title === null ? null : titleOf(title) || null,
        first === null ? null : cleanFirst(first) || null,
        delta,
        REDACTION_VERSION,
        chatId
      )
      this.setTitleRow(chatId)
      return true
    })
  }

  deleteChat(chatId: number): void {
    this.q('DELETE FROM message WHERE chat_id = ?').run(chatId)
    this.q('DELETE FROM source_file WHERE chat_id = ?').run(chatId)
    this.q('DELETE FROM chat WHERE id = ?').run(chatId)
  }

  chatsOf(source: ChatSourceId): ChatRow[] {
    return (this.q('SELECT id, native_id, updated_ms FROM chat WHERE source = ?').all(source) as Record<string, unknown>[]).map((r) => ({
      id: num(r.id),
      source,
      nativeId: String(r.native_id),
      updatedMs: numOrNull(r.updated_ms)
    }))
  }

  /** Every chat of a source gone, with its read positions — the source was switched off. */
  removeSource(source: ChatSourceId): number {
    const rows = this.chatsOf(source)
    this.tx(() => {
      for (const r of rows) this.deleteChat(r.id)
      this.q('DELETE FROM source_file WHERE source = ?').run(source)
      this.q('DELETE FROM source_state WHERE source = ?').run(source)
    })
    return rows.length
  }

  count(source?: ChatSourceId): number {
    const r = (source
      ? this.q('SELECT COUNT(*) AS n FROM chat WHERE source = ?').get(source)
      : this.q('SELECT COUNT(*) AS n FROM chat').get()) as { n?: unknown } | undefined
    return num(r?.n)
  }

  /** The chat text the store holds, in bytes — what its ceiling is measured in (`evictToText`). */
  textBytes(): number {
    const r = this.q('SELECT COALESCE(SUM(text_bytes), 0) AS n FROM chat').get() as { n?: unknown } | undefined
    return num(r?.n)
  }

  /** Bytes on disk: the database and its WAL. */
  sizeOnDisk(): number {
    let n = 0
    for (const f of [this.file, `${this.file}-wal`]) {
      try {
        n += statSync(f).size
      } catch {
        /* none */
      }
    }
    return n
  }

  /**
   * Hold the store to `maxTextBytes` of chat text: evict the oldest chats until
   * what is left fits, in one transaction.
   *
   * Measured in TEXT, not in the database's used pages, which is what this
   * first did. FTS5 with external content does not free a deleted row's
   * postings — the delete writes a tombstone beside them, and only a segment
   * merge reclaims either. Measured with 200 synthetic chats: deleting half of
   * them (text 11.22 → 5.86 MB) moved used pages 20.64 → 18.19 MB, and only an
   * `optimize` brought them to 10.92; with a Zipf vocabulary, 7.77 → 5.54, and
   * 3.89 after. So "evict until the pages fit" evicted two to four times what
   * it needed to — in `verify:chat-sources`, 11 of 12 chats to shed 30% of the
   * pages — and could evict EVERY chat with the pages still over, which, with
   * the cut below remembered, would have left the index admitting nothing.
   * Text is exactly each chat's share, and it is what the pages follow once
   * merged.
   *
   * Oldest by the key the pass ADMITS on — the file's (or row's) mtime, kept on
   * its `source_file` row — never by the chat's own last-message stamp: the two
   * orders differ, and the cut is only a clean line through the listing if what
   * went is exactly the listing's oldest. Returns which sources lost chats and
   * the newest admission key that went, which the caller must remember as the
   * cut (`setStoreCutMs`): `deleteChat` takes the read positions with the chat,
   * so without it the next pass admits the same chats again, reads them whole
   * and evicts them again.
   *
   * An imported chat has no file, so its own last stamp is its key: the line
   * runs through imports and local chats alike, oldest first. One that goes is
   * gone until its file is imported again — its import's disclosure counts it.
   */
  evictToText(maxTextBytes: number): { sources: Set<ChatSourceId>; newestMs: number | null } {
    const sources = new Set<ChatSourceId>()
    let newestMs: number | null = null
    const over = this.textBytes() - maxTextBytes
    if (over <= 0) return { sources, newestMs }
    const oldest = this.q(
      // An imported chat has no file: its own last stamp is its place in the line.
      `SELECT c.id AS id, c.source AS source, c.text_bytes AS bytes, COALESCE(MAX(f.mtime_ms), c.updated_ms, 0) AS m
       FROM chat c LEFT JOIN source_file f ON f.chat_id = c.id
       GROUP BY c.id ORDER BY m ASC, c.id ASC`
    )
    const doomed: number[] = []
    let freed = 0
    for (const r of oldest.iterate() as Iterable<{ id: unknown; source: unknown; bytes: unknown; m: unknown }>) {
      if (freed >= over) break
      doomed.push(num(r.id))
      freed += num(r.bytes)
      if (isChatSourceId(r.source)) sources.add(r.source)
      newestMs = Math.max(newestMs ?? -Infinity, num(r.m))
    }
    this.tx(() => doomed.forEach((id) => this.deleteChat(id)))
    return { sources, newestMs }
  }

  /* ------------------------------------------------------------- meta */

  private getMeta(key: string): string | null {
    const r = this.q('SELECT value FROM meta WHERE key = ?').get(key) as { value?: unknown } | undefined
    return strOrNull(r?.value)
  }

  private putMeta(key: string, value: string | null): void {
    if (value === null) this.q('DELETE FROM meta WHERE key = ?').run(key)
    else this.q('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  /**
   * The store's byte ceiling as a line through the listing: the newest
   * admission key (file or row mtime) it has evicted. A pass admits nothing at
   * or below it, so what the ceiling evicted stays out until it changes — a
   * chat with new activity has a newer mtime and comes back in as the newest.
   */
  storeCutMs(): number | null {
    const raw = this.getMeta('storeCutMs')
    const v = raw === null ? NaN : Number(raw)
    return Number.isFinite(v) ? v : null
  }

  setStoreCutMs(ms: number | null): void {
    this.putMeta('storeCutMs', ms === null ? null : String(Math.round(ms)))
  }

  /** What the last pass was asked for (its options and ceiling), so a change can be told apart. */
  passKey(): string | null {
    return this.getMeta('passKey')
  }

  setPassKey(key: string): void {
    this.putMeta('passKey', key)
  }

  /**
   * Forget every file remembered as holding no chat (a subagent's while those
   * were off, or nothing to index). They are read again on the next pass —
   * what the options changed may have changed the answer.
   */
  forgetEmptyFiles(): void {
    this.q('DELETE FROM source_file WHERE chat_id IS NULL').run()
  }

  /* ------------------------------------------------------------ state */

  putSourceState(source: ChatSourceId, s: SourceStateRow): void {
    this.q(
      `INSERT INTO source_state(source, found, found_at_least, target, duplicates, bytes_read, capped_by, last_pass_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source) DO UPDATE SET found = excluded.found, found_at_least = excluded.found_at_least,
       target = excluded.target, duplicates = excluded.duplicates, bytes_read = excluded.bytes_read,
       capped_by = excluded.capped_by, last_pass_ms = excluded.last_pass_ms, error = excluded.error`
    ).run(source, s.found, s.foundAtLeast ? 1 : 0, s.target, s.duplicates, s.bytesRead, s.cappedBy, s.lastPassMs, s.error)
  }

  getSourceState(source: ChatSourceId): SourceStateRow | null {
    const r = this.q('SELECT * FROM source_state WHERE source = ?').get(source) as Record<string, unknown> | undefined
    if (!r) return null
    return {
      found: numOrNull(r.found),
      foundAtLeast: num(r.found_at_least) === 1,
      target: numOrNull(r.target),
      duplicates: num(r.duplicates),
      bytesRead: num(r.bytes_read),
      cappedBy: capOf(r.capped_by),
      lastPassMs: numOrNull(r.last_pass_ms),
      error: strOrNull(r.error)
    }
  }

  setCappedBy(source: ChatSourceId, cap: ChatCap): void {
    this.q('UPDATE source_state SET capped_by = ? WHERE source = ?').run(cap, source)
  }

  putLastPass(p: ChatPassSummary): void {
    this.q('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('lastPass', JSON.stringify(p))
  }

  lastPass(): ChatPassSummary | null {
    const r = this.q('SELECT value FROM meta WHERE key = ?').get('lastPass') as { value?: unknown } | undefined
    if (!r || typeof r.value !== 'string') return null
    try {
      return JSON.parse(r.value) as ChatPassSummary
    } catch {
      return null
    }
  }

  status(state: ChatIndexStatus['state'], progress: ChatIndexStatus['progress'] = null): ChatIndexStatus {
    const base = emptyChatStatus(this.file, state)
    const truncated = new Map<string, number>()
    for (const r of this.q('SELECT source, COUNT(*) AS n FROM chat WHERE truncated = 1 GROUP BY source').all() as Record<string, unknown>[]) {
      truncated.set(String(r.source), num(r.n))
    }
    const counts = new Map<string, number>()
    for (const r of this.q('SELECT source, COUNT(*) AS n FROM chat GROUP BY source').all() as Record<string, unknown>[]) {
      counts.set(String(r.source), num(r.n))
    }
    const sources: ChatSourceStatus[] = CHAT_SOURCE_IDS.map((id) => {
      const st = this.getSourceState(id)
      return {
        id,
        found: st?.found ?? null,
        foundAtLeast: st?.foundAtLeast ?? false,
        target: st?.target ?? null,
        indexed: counts.get(id) ?? 0,
        duplicates: st?.duplicates ?? 0,
        truncated: truncated.get(id) ?? 0,
        bytesRead: st?.bytesRead ?? 0,
        cappedBy: st?.cappedBy ?? null,
        lastPassMs: st?.lastPassMs ?? null,
        error: st?.error ?? null
      }
    })
    const msgs = this.q('SELECT COUNT(*) AS n FROM message WHERE ord >= 0').get() as { n?: unknown } | undefined
    return {
      ...base,
      progress,
      sources,
      chats: this.count(),
      messages: num(msgs?.n),
      storeBytes: this.sizeOnDisk(),
      lastPass: this.lastPass(),
      imports: this.imports()
    }
  }

  /* ----------------------------------------------------------- search */

  /**
   * Body search: every word as a prefix, all required (`ftsQuery`), one hit
   * per chat — its best message by bm25 — ranked by that message, with a
   * snippet whose hits are marked by `HIT_OPEN`/`HIT_CLOSE` and handed back as
   * ranges.
   *
   * Grouped per chat BEFORE the limit, in SQL. The first cut ranked messages
   * and took the first 400 rows, so one long conversation that says the word
   * more often than that could fill every row and hide every other chat;
   * `verify:chat-sources` holds it with 600 matching messages in one chat and
   * one in another. The snippet is then asked for only each chat's winner.
   *
   * `redact: 'force'` is for what leaves this computer (another computer
   * searching it, spec 2026-10-03 §1): only chats whose stored text was
   * cleaned with the rules in force now are searched at all, whatever the
   * local setting says — a chat stored while redaction was off is left out,
   * not cleaned on the way out. A snippet is a window of 20 tokens that can
   * start inside a key (`live_51H…` with no `sk_` before it), so redacting the
   * window would miss what the stored text's own cleaning catches; and a raw
   * row that merely MATCHED would answer "is `sk_live_51H` in a chat here?"
   * one prefix at a time. The filter is inside the grouping, before the
   * limit, so stale chats cannot take a cleaned one's place. Titles and first
   * prompts are cleaned once more on the way out, which costs nothing.
   *
   * `skip` leaves a chat out by its folder (another computer never sees a
   * hidden project's chats) BEFORE the limit, for the same reason: a hidden
   * chat that took a place and was dropped afterwards would make the answer
   * one short, and how many hits a limit returns would say whether a hidden
   * chat matched and how it ranked. With it the ranked rows are walked until
   * `limit` pass, rather than cut by SQL.
   */
  search(query: string, limit = 50, opts: { redact?: 'force'; skip?: (cwd: string) => boolean; filters?: ChatSearchFilters } = {}): ChatSearchHit[] {
    const match = ftsQuery(query)
    const filters = clampChatSearchFilters(opts.filters)
    if (!match && (query.trim() !== '' || !hasChatSearchFilters(filters))) return []
    limit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Math.floor(limit))) : 50
    const force = opts.redact === 'force'
    const skip = opts.skip
    type Best = { chat_id: unknown; mid: unknown; role: unknown; cwd: unknown }
    const where = ['c.redact_level >= ?']
    const params: (string | number)[] = [force ? REDACTION_VERSION : -1]
    const add = (sql: string, value: string | number | undefined): void => {
      if (value !== undefined) { where.push(sql); params.push(value) }
    }
    add('c.updated_ms >= ?', filters.afterMs)
    add('c.updated_ms < ?', filters.beforeMs)
    add('c.source = ?', filters.source)
    add("instr(lower(COALESCE(c.model, '')), lower(?)) > 0", filters.model)
    add("instr(lower(COALESCE(c.cwd, '')), lower(?)) > 0", filters.folder)
    // Nulls are excluded by comparisons; a missing measurement is never zero.
    add('c.updated_ms >= c.created_ms AND c.updated_ms - c.created_ms >= ?', filters.minSpanMs)
    add('c.updated_ms >= c.created_ms AND c.updated_ms - c.created_ms <= ?', filters.maxSpanMs)
    add('c.context_tokens >= ?', filters.minContextTokens)
    add('c.context_tokens <= ?', filters.maxContextTokens)
    const predicate = where.join(' AND ')
    const bestQ = this.q(
      // MATERIALIZED: flattened into the aggregate, bm25() has no FTS context and errors.
      match ? `WITH h AS MATERIALIZED (SELECT rowid AS mid, bm25(message_fts) AS r FROM message_fts WHERE message_fts MATCH ?)
       SELECT m.chat_id AS chat_id, h.mid AS mid, m.role AS role, c.cwd AS cwd, MIN(h.r) AS best
       FROM h JOIN message m ON m.id = h.mid JOIN chat c ON c.id = m.chat_id
       WHERE ${predicate}
       GROUP BY m.chat_id
       ORDER BY best, c.updated_ms DESC, m.chat_id
       LIMIT ?` :
      `SELECT c.id AS chat_id, 0 AS mid, 'title' AS role, c.cwd AS cwd FROM chat c
       WHERE ${predicate} ORDER BY c.updated_ms DESC, c.id DESC LIMIT ?`
    )
    const bound = match ? [match, ...params] : params
    let best: Best[]
    if (!skip) best = bestQ.all(...bound, limit) as Best[]
    else {
      best = []
      // LIMIT -1 is no limit: the walk stops itself once `limit` chats are kept.
      for (const r of bestQ.iterate(...bound, -1) as Iterable<Best>) {
        if (typeof r.cwd === 'string' && r.cwd !== '' && skip(r.cwd)) continue
        best.push(r)
        if (best.length >= limit) break
      }
    }
    /*
     * `CAST(? AS INTEGER)`, and it is load-bearing (gotcha 125): node:sqlite
     * binds every JS number as a REAL, and FTS5 silently ignores `rowid = <a
     * real>` — this returned the FIRST match's snippet for every chat, 20
     * hits with one snippet, measured on a real index. A BigInt binds as an
     * integer too; the cast keeps the call sites plain.
     */
    const snipQ = this.q(
      `SELECT snippet(message_fts, 0, '${HIT_OPEN}', '${HIT_CLOSE}', '…', 20) AS snip
       FROM message_fts WHERE message_fts MATCH ? AND rowid = CAST(? AS INTEGER)`
    )
    const chatQ = this.q('SELECT source, native_id, title, first_prompt, cwd, created_ms, updated_ms, model, context_tokens, subagent FROM chat WHERE id = ?')
    const out: ChatSearchHit[] = []
    for (const r of best) {
      const chatId = num(r.chat_id)
      const c = chatQ.get(chatId) as Record<string, unknown> | undefined
      if (!c || !isChatOrigin(c.source)) continue
      const snip = match ? snipQ.get(match, num(r.mid)) as { snip?: unknown } | undefined : undefined
      const role = r.role === 'user' || r.role === 'assistant' || r.role === 'title' ? r.role : 'assistant'
      const rawTitle = strOrNull(c.title)
      const rawPrompt = strOrNull(c.first_prompt)
      const title = force && rawTitle !== null ? redactSecrets(rawTitle) : rawTitle
      const firstPrompt = force && rawPrompt !== null ? redactSecrets(rawPrompt) : rawPrompt
      out.push({
        chatId,
        source: c.source,
        nativeId: String(c.native_id),
        title,
        firstPrompt,
        cwd: strOrNull(c.cwd),
        updatedMs: numOrNull(c.updated_ms),
        createdMs: numOrNull(c.created_ms),
        model: strOrNull(c.model),
        contextTokens: numOrNull(c.context_tokens),
        subagent: num(c.subagent) === 1,
        role,
        snippet: parseMarked(typeof snip?.snip === 'string' ? snip.snip : (firstPrompt ?? title ?? '').slice(0, 200))
      })
    }
    return out
  }

  /** Every message of a chat, in order — the viewer's copy for an import, and a suite's. */
  messages(chatId: number): { ord: number; role: string; text: string; atMs: number | null }[] {
    return (this.q('SELECT ord, role, at_ms, text FROM message WHERE chat_id = ? AND ord >= 0 ORDER BY ord').all(chatId) as Record<string, unknown>[]).map(
      (r) => ({ ord: num(r.ord), role: String(r.role), text: String(r.text), atMs: numOrNull(r.at_ms) })
    )
  }

  /** One chat's row and where it was read from, for the viewer. Null when it is not in the store. */
  chat(chatId: number): StoredChat | null {
    const r = this.q(
      `SELECT c.id AS id, c.source AS source, c.native_id AS native_id, c.title AS title, c.cwd AS cwd, c.created_ms AS created_ms,
              c.updated_ms AS updated_ms, c.subagent AS subagent, c.truncated AS truncated, c.redact_level AS redact_level,
              (SELECT f.locator FROM source_file f WHERE f.chat_id = c.id ORDER BY f.mtime_ms DESC LIMIT 1) AS locator
       FROM chat c WHERE c.id = CAST(? AS INTEGER)`
    ).get(chatId) as Record<string, unknown> | undefined
    if (!r || !isChatOrigin(r.source)) return null
    return {
      id: num(r.id),
      source: r.source,
      nativeId: String(r.native_id),
      title: strOrNull(r.title),
      cwd: strOrNull(r.cwd),
      createdMs: numOrNull(r.created_ms),
      updatedMs: numOrNull(r.updated_ms),
      subagent: num(r.subagent) === 1,
      truncated: num(r.truncated) === 1,
      locator: strOrNull(r.locator),
      redactLevel: num(r.redact_level)
    }
  }

  /* ---------------------------------------------------------- imports */

  /** A new import's record, before any of its conversations is written. */
  addImport(kind: ChatImportKind, fileName: string, bytes: number, importedMs: number, found: number): number {
    this.q('INSERT INTO import_file(kind, file_name, bytes, imported_ms, found) VALUES (?, ?, ?, ?, ?)').run(
      kind,
      fileName,
      bytes,
      Math.round(importedMs),
      found
    )
    const r = this.q('SELECT last_insert_rowid() AS id').get() as { id?: unknown } | undefined
    return num(r?.id)
  }

  finishImport(id: number, t: ImportTally): void {
    this.q('UPDATE import_file SET admitted = ?, added = ?, updated = ?, empty = ?, truncated = ?, capped_by = ? WHERE id = CAST(? AS INTEGER)').run(
      t.admitted,
      t.added,
      t.updated,
      t.empty,
      t.truncated,
      t.cappedBy,
      id
    )
  }

  /** Which import a chat's text last came from: a re-import of the same conversation takes it over. */
  setImportId(chatId: number, importId: number): void {
    this.q('UPDATE chat SET import_id = ? WHERE id = CAST(? AS INTEGER)').run(importId, chatId)
  }

  /** Every import, newest first, each with how many of its chats are in the store NOW. */
  imports(): ChatImportRecord[] {
    const rows = this.q(
      `SELECT i.*, (SELECT COUNT(*) FROM chat c WHERE c.import_id = i.id) AS indexed
       FROM import_file i ORDER BY i.imported_ms DESC, i.id DESC`
    ).all() as Record<string, unknown>[]
    const out: ChatImportRecord[] = []
    for (const r of rows) {
      if (!isChatImportKind(r.kind)) continue
      const cap = r.capped_by === 'perSource' || r.capped_by === 'total' ? r.capped_by : null
      out.push({
        id: num(r.id),
        kind: r.kind,
        fileName: String(r.file_name),
        bytes: num(r.bytes),
        importedMs: num(r.imported_ms),
        found: num(r.found),
        admitted: num(r.admitted),
        added: num(r.added),
        updated: num(r.updated),
        empty: num(r.empty),
        truncated: num(r.truncated),
        cappedBy: cap,
        indexed: num(r.indexed)
      })
    }
    return out
  }

  importRecord(id: number): ChatImportRecord | null {
    return this.imports().find((r) => r.id === id) ?? null
  }

  /** Chats that came from an export, of one kind or all. */
  importedCount(kind?: ChatImportKind): number {
    const r = (kind
      ? this.q('SELECT COUNT(*) AS n FROM chat WHERE source = ?').get(kind)
      : this.q(`SELECT COUNT(*) AS n FROM chat WHERE source IN (${CHAT_IMPORT_KINDS.map(() => '?').join(', ')})`).get(...CHAT_IMPORT_KINDS)) as
      | { n?: unknown }
      | undefined
    return num(r?.n)
  }

  /**
   * Hold imported chats to the caps: the newest `perKind` of each kind, and the
   * newest `total` of every import together — oldest by the conversation's own
   * last stamp. Returns how many went.
   */
  capImports(perKind: number, total: number): number {
    const doomed = new Set<number>()
    for (const kind of CHAT_IMPORT_KINDS) {
      const rows = this.q('SELECT id FROM chat WHERE source = ? ORDER BY COALESCE(updated_ms, 0) DESC, id DESC LIMIT -1 OFFSET CAST(? AS INTEGER)').all(kind, perKind) as {
        id: unknown
      }[]
      for (const r of rows) doomed.add(num(r.id))
    }
    const all = this.q(
      `SELECT id FROM chat WHERE source IN (${CHAT_IMPORT_KINDS.map(() => '?').join(', ')}) ORDER BY COALESCE(updated_ms, 0) DESC, id DESC LIMIT -1 OFFSET CAST(? AS INTEGER)`
    ).all(...CHAT_IMPORT_KINDS, total) as { id: unknown }[]
    for (const r of all) doomed.add(num(r.id))
    if (doomed.size) this.tx(() => doomed.forEach((id) => this.deleteChat(id)))
    return doomed.size
  }

  /** An import's chats and its record gone — "Remove" beside it in Settings. */
  removeImport(id: number): number {
    const rows = this.q('SELECT id FROM chat WHERE import_id = CAST(? AS INTEGER)').all(id) as { id: unknown }[]
    this.tx(() => {
      for (const r of rows) this.deleteChat(num(r.id))
      this.q('DELETE FROM import_file WHERE id = CAST(? AS INTEGER)').run(id)
    })
    return rows.length
  }

  /**
   * Forget the records of older imports of `kind` that no longer hold a single
   * chat — every one of their conversations was brought up to date by a later
   * file. Kept, they would only say "N have since left the index".
   */
  dropSupersededImports(kind: ChatImportKind, keepId: number): void {
    this.q(
      `DELETE FROM import_file WHERE kind = ? AND id <> CAST(? AS INTEGER)
       AND NOT EXISTS (SELECT 1 FROM chat c WHERE c.import_id = import_file.id)`
    ).run(kind, keepId)
  }

  /**
   * Every chat a pass reads, and every read position and cut — "Rebuild". What
   * came from an export stays: a pass could never bring it back, and the user
   * asked to read their tools again, not to lose their imports.
   */
  clearLocal(): void {
    this.tx(() => {
      for (const id of CHAT_SOURCE_IDS) {
        for (const r of this.chatsOf(id)) this.deleteChat(r.id)
        this.q('DELETE FROM source_state WHERE source = ?').run(id)
      }
      this.q('DELETE FROM source_file').run()
      this.putMeta('storeCutMs', null)
      this.putMeta('passKey', null)
      this.putMeta('lastPass', null)
    })
  }

  /** Fold the WAL back and merge FTS segments after a big pass; cheap when there is nothing to do. */
  tidy(optimize: boolean): void {
    try {
      if (optimize) this.db.exec("INSERT INTO message_fts(message_fts) VALUES ('optimize')")
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      /* a reader holding the WAL; the next pass tries again */
    }
    this.lockDown()
  }

  close(): void {
    this.stmts.clear()
    try {
      this.db.close()
    } catch {
      /* already closed */
    }
  }

  /** Close and remove the whole store directory: "Delete index". */
  destroy(): void {
    this.close()
    rmSync(this.dir, { recursive: true, force: true })
  }
}
