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
  CHAT_SOURCE_IDS,
  emptyChatStatus,
  ftsQuery,
  isChatSourceId,
  parseMarked,
  HIT_CLOSE,
  HIT_OPEN,
  type ChatCap,
  type ChatIndexStatus,
  type ChatPassSummary,
  type ChatSearchHit,
  type ChatSourceId,
  type ChatSourceStatus
} from '../../shared/chatIndex.ts'
import { planTrim, type ChatMessage, type ChatMeta } from './parse.ts'

export const STORE_FILE = 'index.sqlite'
const SCHEMA_VERSION = '1'

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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS chat (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  native_id TEXT NOT NULL,
  title TEXT, first_prompt TEXT, cwd TEXT, git_branch TEXT, model TEXT,
  created_ms INTEGER, updated_ms INTEGER,
  message_count INTEGER NOT NULL DEFAULT 0,
  text_bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  subagent INTEGER NOT NULL DEFAULT 0,
  dedupe_key TEXT,
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
    this.q('INSERT OR IGNORE INTO meta(key, value) VALUES (?, ?)').run('schema', SCHEMA_VERSION)
    this.lockDown()
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

  chatId(source: ChatSourceId, nativeId: string): number | null {
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
   */
  upsertChat(
    source: ChatSourceId,
    nativeId: string,
    meta: ChatMeta,
    flags: { subagent: boolean; dedupeKey: string | null; whole: boolean }
  ): number {
    const first = (col: string): string => (flags.whole ? `COALESCE(excluded.${col}, chat.${col})` : `COALESCE(chat.${col}, excluded.${col})`)
    this.q(
      `INSERT INTO chat(source, native_id, title, first_prompt, cwd, git_branch, model, created_ms, updated_ms, subagent, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, native_id) DO UPDATE SET
         title = COALESCE(excluded.title, chat.title),
         first_prompt = ${first('first_prompt')},
         cwd = ${first('cwd')},
         git_branch = COALESCE(excluded.git_branch, chat.git_branch),
         model = COALESCE(excluded.model, chat.model),
         created_ms = MIN(COALESCE(chat.created_ms, excluded.created_ms), COALESCE(excluded.created_ms, chat.created_ms)),
         updated_ms = MAX(COALESCE(chat.updated_ms, 0), COALESCE(excluded.updated_ms, 0)),
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
      flags.dedupeKey
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
   */
  evictToText(maxTextBytes: number): { sources: Set<ChatSourceId>; newestMs: number | null } {
    const sources = new Set<ChatSourceId>()
    let newestMs: number | null = null
    const over = this.textBytes() - maxTextBytes
    if (over <= 0) return { sources, newestMs }
    const oldest = this.q(
      `SELECT c.id AS id, c.source AS source, c.text_bytes AS bytes, COALESCE(MAX(f.mtime_ms), 0) AS m
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
      lastPass: this.lastPass()
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
   */
  search(query: string, limit = 50): ChatSearchHit[] {
    const match = ftsQuery(query)
    if (!match) return []
    const best = this.q(
      // MATERIALIZED: flattened into the aggregate, bm25() has no FTS context and errors.
      `WITH h AS MATERIALIZED (SELECT rowid AS mid, bm25(message_fts) AS r FROM message_fts WHERE message_fts MATCH ?)
       SELECT m.chat_id AS chat_id, h.mid AS mid, m.role AS role, MIN(h.r) AS best
       FROM h JOIN message m ON m.id = h.mid
       GROUP BY m.chat_id
       ORDER BY best
       LIMIT ?`
    ).all(match, limit) as { chat_id: unknown; mid: unknown; role: unknown }[]
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
    const chatQ = this.q('SELECT source, native_id, title, first_prompt, cwd, updated_ms, subagent FROM chat WHERE id = ?')
    const out: ChatSearchHit[] = []
    for (const r of best) {
      const chatId = num(r.chat_id)
      const c = chatQ.get(chatId) as Record<string, unknown> | undefined
      if (!c || !isChatSourceId(c.source)) continue
      const snip = snipQ.get(match, num(r.mid)) as { snip?: unknown } | undefined
      const role = r.role === 'user' || r.role === 'assistant' || r.role === 'title' ? r.role : 'assistant'
      out.push({
        chatId,
        source: c.source,
        nativeId: String(c.native_id),
        title: strOrNull(c.title),
        firstPrompt: strOrNull(c.first_prompt),
        cwd: strOrNull(c.cwd),
        updatedMs: numOrNull(c.updated_ms),
        subagent: num(c.subagent) === 1,
        role,
        snippet: parseMarked(typeof snip?.snip === 'string' ? snip.snip : '')
      })
    }
    return out
  }

  /** Every message of a chat, in order — for a suite, and the read-only viewer to come. */
  messages(chatId: number): { ord: number; role: string; text: string }[] {
    return (this.q('SELECT ord, role, text FROM message WHERE chat_id = ? AND ord >= 0 ORDER BY ord').all(chatId) as Record<string, unknown>[]).map(
      (r) => ({ ord: num(r.ord), role: String(r.role), text: String(r.text) })
    )
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
