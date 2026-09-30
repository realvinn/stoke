/**
 * The chat sources' reading half: where each tool keeps its chats, how to list
 * them newest first, and how to read one. Runs only in the chat-index worker
 * (and `verify:chat-sources`), so it uses SYNCHRONOUS fs on purpose: libuv's
 * thread pool is process-wide and shared with every worker, and `threadPool.ts`
 * says every pty keystroke write runs on it — a worker issuing thousands of
 * async reads could make typing wait. `readSync` blocks only this thread.
 *
 * Named roots only (research §4.1): Stoke never walks the disk looking for
 * chats, never touches `~/Library/Containers` or a Group Container (either
 * raises macOS's "access data from other apps" prompt), and never decrypts
 * anything. Each root honours the tool's own override (`CLAUDE_CONFIG_DIR`,
 * `CODEX_HOME`, `XDG_DATA_HOME`).
 *
 * Detection (`detectSource`) is names and sizes only — it opens no file's
 * content and no database — because it runs before the user has said yes.
 */
import { closeSync, existsSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync, type Dirent, type Stats } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { DatabaseSync } from 'node:sqlite'
import { isInside, pathRulesFor } from '../../shared/paths.ts'
import type { ChatSourceEstimate, ChatSourceId } from '../../shared/chatIndex.ts'
import {
  clineMeta,
  coworkMeta,
  emptyFold,
  foldClaudeLine,
  foldClineMessages,
  foldCodexLine,
  foldOpencodeRows,
  foldZedThread,
  zedFolder,
  type ChatMeta,
  type Fold
} from './parse.ts'
import type { FileRow } from './store.ts'

export interface SourceEnv {
  home: string
  env: Record<string, string | undefined>
  platform: string
}

/** Discovery's own cap: this many directory entries, or this long, per source. */
export const DISCOVERY_MAX_ENTRIES = 50_000
export const DISCOVERY_MAX_MS = 5_000

export interface Discovery {
  entries: number
  deadline: number
  stopped: boolean
}

export function discovery(now: number, maxMs = DISCOVERY_MAX_MS): Discovery {
  return { entries: 0, deadline: now + maxMs, stopped: false }
}

let discoveryLimit = DISCOVERY_MAX_ENTRIES
/** A suite shrinks the entry cap to prove "at least N" is said. */
export function setDiscoveryLimitForTest(n: number): void {
  discoveryLimit = n
}

function tick(d: Discovery): boolean {
  if (d.stopped) return false
  d.entries++
  if (d.entries > discoveryLimit || Date.now() > d.deadline) {
    d.stopped = true
    return false
  }
  return true
}

function dirents(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
}

function statOrNull(p: string): Stats | null {
  try {
    return statSync(p)
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- roots */

function xdgData(e: SourceEnv): string {
  return e.env.XDG_DATA_HOME || join(e.home, '.local', 'share')
}

/** An app's own data folder: `~/Library/Application Support/<app>` on macOS. */
function appData(e: SourceEnv, app: string): string {
  if (e.platform === 'darwin') return join(e.home, 'Library', 'Application Support', app)
  if (e.platform === 'win32') return join(e.env.APPDATA || join(e.home, 'AppData', 'Roaming'), app)
  return join(e.env.XDG_CONFIG_HOME || join(e.home, '.config'), app)
}

export function claudeRoots(e: SourceEnv): string[] {
  const roots = [join(e.home, '.claude', 'projects')]
  const cfg = e.env.CLAUDE_CONFIG_DIR
  if (cfg && !roots.includes(join(cfg, 'projects'))) roots.unshift(join(cfg, 'projects'))
  return roots
}

export function codexHome(e: SourceEnv): string {
  return e.env.CODEX_HOME || join(e.home, '.codex')
}

export function opencodeDbPath(e: SourceEnv): string {
  return join(xdgData(e), 'opencode', 'opencode.db')
}

/** Claude desktop's Cowork ("local agent mode") sessions. Windows and Linux: unverified. */
export function coworkRoot(e: SourceEnv): string {
  return join(appData(e, 'Claude'), 'local-agent-mode-sessions')
}

/** Zed's agent threads. macOS measured; Linux and Windows are Zed's usual data folders, unverified. */
export function zedDbPath(e: SourceEnv): string {
  if (e.platform === 'darwin') return join(e.home, 'Library', 'Application Support', 'Zed', 'threads', 'threads.db')
  if (e.platform === 'win32') return join(e.env.LOCALAPPDATA || join(e.home, 'AppData', 'Local'), 'Zed', 'threads', 'threads.db')
  return join(xdgData(e), 'zed', 'threads', 'threads.db')
}

export function clineRoot(e: SourceEnv): string {
  return join(e.home, '.cline', 'data', 'sessions')
}

/* ------------------------------------------------------------ candidates */

export type CandidateKind = 'jsonl-claude' | 'jsonl-codex' | 'cline' | 'opencode' | 'zed'

/** One chat a source listed: enough to decide whether it changed, and where to read it. */
export interface Candidate {
  source: ChatSourceId
  nativeId: string
  /** The read-position key: a file path, or `<db path>#<id>` for a database row. */
  locator: string
  kind: CandidateKind
  /** The file to read, or the database the row is in. */
  path: string
  /** Newest-first key, and (with `size`) the "has it changed" test. A row's is its own updated stamp. */
  mtimeMs: number
  size: number
  subagent: boolean
  /** What the listing already knows (Codex's threads table, a Cowork session's metadata). */
  meta: Partial<ChatMeta>
  /** `codex:<id>` for Cline's imported copy of another tool's chat. */
  dedupeKey: string | null
}

export interface Listing {
  candidates: Candidate[]
  /**
   * Ids the source HAS but this pass does not index — subagent threads while
   * those are off, archived ones. Never read; they exist only so Cline's
   * imported copy of one is known for a copy, not indexed in its place.
   */
  withheld?: string[]
  /** Everything at the source was listed — pruning what is gone is safe only then. */
  complete: boolean
  atLeast: boolean
  error: string | null
}

function newestFirst(list: Candidate[]): Candidate[] {
  return list.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.locator < b.locator ? -1 : 1))
}

/* ------------------------------------------------------------ Claude Code */

function claudeTopLevel(root: string, d: Discovery, subagents: boolean, source: ChatSourceId, meta: Partial<ChatMeta> = {}): Candidate[] {
  const out: Candidate[] = []
  for (const proj of dirents(root)) {
    if (!proj.isDirectory() || !tick(d)) continue
    const dir = join(root, proj.name)
    for (const f of dirents(dir)) {
      if (!tick(d)) break
      if (f.isFile() && f.name.endsWith('.jsonl')) {
        const path = join(dir, f.name)
        const st = statOrNull(path)
        if (!st) continue
        out.push({
          source,
          nativeId: f.name.slice(0, -'.jsonl'.length),
          locator: path,
          kind: 'jsonl-claude',
          path,
          mtimeMs: Math.round(st.mtimeMs),
          size: st.size,
          subagent: false,
          meta,
          dedupeKey: null
        })
      } else if (subagents && f.isDirectory()) {
        // `<dir>/<session>/subagents/*.jsonl`: only when asked for.
        const sub = join(dir, f.name, 'subagents')
        for (const a of dirents(sub)) {
          if (!tick(d)) break
          if (!a.isFile() || !a.name.endsWith('.jsonl')) continue
          const path = join(sub, a.name)
          const st = statOrNull(path)
          if (!st) continue
          out.push({
            source,
            nativeId: `${f.name}/${a.name.slice(0, -'.jsonl'.length)}`,
            locator: path,
            kind: 'jsonl-claude',
            path,
            mtimeMs: Math.round(st.mtimeMs),
            size: st.size,
            subagent: true,
            meta,
            dedupeKey: null
          })
        }
      }
    }
  }
  return out
}

function listClaude(e: SourceEnv, subagents: boolean, d: Discovery): Listing {
  const byId = new Map<string, Candidate>()
  for (const root of claudeRoots(e)) {
    for (const c of claudeTopLevel(root, d, subagents, 'claude')) {
      const prev = byId.get(c.nativeId)
      if (!prev || c.mtimeMs > prev.mtimeMs) byId.set(c.nativeId, c)
    }
  }
  return { candidates: newestFirst([...byId.values()]), complete: !d.stopped, atLeast: d.stopped, error: null }
}

/* ------------------------------------------------------------------ Codex */

const ROLLOUT_ID = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

function walkRollouts(home: string, d: Discovery, visit: (path: string, name: string) => void): void {
  const sessions = join(home, 'sessions')
  // YYYY/MM/DD, newest first, so a discovery cap keeps the newest.
  const desc = (dir: string): Dirent[] => dirents(dir).filter((x) => x.isDirectory()).sort((a, b) => (a.name < b.name ? 1 : -1))
  for (const y of desc(sessions)) {
    for (const m of desc(join(sessions, y.name))) {
      for (const day of desc(join(sessions, y.name, m.name))) {
        const dir = join(sessions, y.name, m.name, day.name)
        for (const f of dirents(dir)) {
          if (!tick(d)) return
          if (f.isFile() && f.name.startsWith('rollout-') && f.name.endsWith('.jsonl')) visit(join(dir, f.name), f.name)
        }
      }
    }
  }
}

function isSubagentSource(v: unknown): boolean {
  return typeof v === 'string' && v.trim().startsWith('{') && v.includes('subagent')
}

function listCodex(e: SourceEnv, subagents: boolean, d: Discovery): Listing {
  const home = codexHome(e)
  const rules = pathRulesFor(e.platform)
  const stateDb = join(home, 'state_5.sqlite')
  if (existsSync(stateDb)) {
    let db: DatabaseSync | null = null
    try {
      db = openReadOnly(stateDb)
      // `SELECT *`: the table grows columns across releases; only named ones are read.
      const rows = db.prepare('SELECT * FROM threads').all() as Record<string, unknown>[]
      const out: Candidate[] = []
      const withheld: string[] = []
      for (const r of rows) {
        if (!tick(d)) break
        const sub = isSubagentSource(r.source)
        if (r.archived || (sub && !subagents)) {
          if (typeof r.id === 'string') withheld.push(r.id)
          continue
        }
        const id = typeof r.id === 'string' ? r.id : ''
        const path = typeof r.rollout_path === 'string' ? r.rollout_path : ''
        // A path out of another program's database is read only inside that program's own folder.
        if (!id || !path || !isInside(home, path, rules)) continue
        const st = statOrNull(path)
        if (!st) continue
        const updated = typeof r.updated_at_ms === 'number' ? r.updated_at_ms : typeof r.updated_at === 'number' ? r.updated_at * 1000 : null
        const created = typeof r.created_at_ms === 'number' ? r.created_at_ms : typeof r.created_at === 'number' ? r.created_at * 1000 : null
        /*
         * `name` first: the thread's name as Codex shows it (48 of 51 user
         * threads here have one). `title` is often the first message verbatim,
         * and the desktop app opens that with context of its own ("# Files
         * mentioned by the user", 16 of 51 here), which is no title.
         */
        const title = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : typeof r.title === 'string' && r.title.trim() ? r.title.trim() : null
        out.push({
          source: 'codex',
          nativeId: id,
          locator: path,
          kind: 'jsonl-codex',
          path,
          mtimeMs: Math.round(st.mtimeMs),
          size: st.size,
          subagent: sub,
          meta: {
            title,
            firstPrompt: typeof r.first_user_message === 'string' && r.first_user_message.trim() ? r.first_user_message.replace(/\s+/g, ' ').trim().slice(0, 300) : null,
            cwd: typeof r.cwd === 'string' && r.cwd ? r.cwd : null,
            gitBranch: typeof r.git_branch === 'string' && r.git_branch ? r.git_branch : null,
            model: typeof r.model === 'string' && r.model ? r.model : null,
            createdMs: created,
            updatedMs: updated
          },
          dedupeKey: null
        })
      }
      return { candidates: newestFirst(out), withheld, complete: !d.stopped, atLeast: d.stopped, error: null }
    } catch {
      // Fall through to the rollout files: the threads table is an index, the rollouts are canonical.
    } finally {
      db?.close()
    }
  }
  const out: Candidate[] = []
  walkRollouts(home, d, (path, name) => {
    const m = ROLLOUT_ID.exec(name)
    const st = statOrNull(path)
    if (!m || !st) return
    out.push({
      source: 'codex',
      nativeId: m[1],
      locator: path,
      kind: 'jsonl-codex',
      path,
      mtimeMs: Math.round(st.mtimeMs),
      size: st.size,
      subagent: false,
      meta: {},
      dedupeKey: null
    })
  })
  return { candidates: newestFirst(out), complete: !d.stopped, atLeast: d.stopped, error: null }
}

/* --------------------------------------------------------------- SQLite */

/**
 * A live database, read-only, briefly. `readOnly` rather than `immutable=1`,
 * which would ignore the WAL and miss the newest rows; a 2 s busy timeout, and
 * the source is skipped for this pass if it stays busy.
 */
export function openReadOnly(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true, timeout: 2000 })
}

function listOpencode(e: SourceEnv, subagents: boolean, d: Discovery): Listing {
  const path = opencodeDbPath(e)
  if (!existsSync(path)) return { candidates: [], complete: true, atLeast: false, error: null }
  const db = openReadOnly(path)
  try {
    const rows = db
      .prepare('SELECT id, title, directory, time_created, time_updated, parent_id, time_archived FROM session ORDER BY time_updated DESC')
      .all() as Record<string, unknown>[]
    const out: Candidate[] = []
    const withheld: string[] = []
    for (const r of rows) {
      if (!tick(d)) break
      const id = typeof r.id === 'string' ? r.id : ''
      if (!id) continue
      const sub = r.parent_id !== null && r.parent_id !== undefined && r.parent_id !== ''
      if ((r.time_archived !== null && r.time_archived !== undefined) || (sub && !subagents)) {
        withheld.push(id)
        continue
      }
      const updated = typeof r.time_updated === 'number' ? r.time_updated : 0
      out.push({
        source: 'opencode',
        nativeId: id,
        locator: `${path}#${id}`,
        kind: 'opencode',
        path,
        mtimeMs: updated,
        size: 0,
        subagent: sub,
        meta: {
          title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : null,
          cwd: typeof r.directory === 'string' && r.directory ? r.directory : null,
          createdMs: typeof r.time_created === 'number' ? r.time_created : null,
          updatedMs: updated || null
        },
        dedupeKey: null
      })
    }
    return { candidates: newestFirst(out), withheld, complete: !d.stopped, atLeast: d.stopped, error: null }
  } finally {
    db.close()
  }
}

function listZed(e: SourceEnv, subagents: boolean, d: Discovery): Listing {
  const path = zedDbPath(e)
  if (!existsSync(path)) return { candidates: [], complete: true, atLeast: false, error: null }
  const db = openReadOnly(path)
  try {
    const rows = db.prepare('SELECT id, summary, updated_at, created_at, parent_id, folder_paths FROM threads').all() as Record<string, unknown>[]
    const out: Candidate[] = []
    for (const r of rows) {
      if (!tick(d)) break
      const sub = r.parent_id !== null && r.parent_id !== undefined && r.parent_id !== ''
      if (sub && !subagents) continue
      const id = typeof r.id === 'string' ? r.id : ''
      if (!id) continue
      const updated = typeof r.updated_at === 'string' ? Date.parse(r.updated_at) : NaN
      const created = typeof r.created_at === 'string' ? Date.parse(r.created_at) : NaN
      out.push({
        source: 'zed',
        nativeId: id,
        locator: `${path}#${id}`,
        kind: 'zed',
        path,
        mtimeMs: Number.isNaN(updated) ? 0 : updated,
        size: 0,
        subagent: sub,
        meta: {
          title: typeof r.summary === 'string' && r.summary.trim() ? r.summary.trim() : null,
          cwd: zedFolder(r.folder_paths),
          createdMs: Number.isNaN(created) ? null : created,
          updatedMs: Number.isNaN(updated) ? null : updated
        },
        dedupeKey: null
      })
    }
    return { candidates: newestFirst(out), complete: !d.stopped, atLeast: d.stopped, error: null }
  } finally {
    db.close()
  }
}

/* ----------------------------------------------------------------- Cowork */

function listCowork(e: SourceEnv, subagents: boolean, d: Discovery): Listing {
  const root = coworkRoot(e)
  const out: Candidate[] = []
  for (const org of dirents(root)) {
    if (!org.isDirectory() || !tick(d)) continue
    for (const acct of dirents(join(root, org.name))) {
      if (!acct.isDirectory() || !tick(d)) continue
      const base = join(root, org.name, acct.name)
      for (const f of dirents(base)) {
        if (!tick(d)) break
        if (!f.isFile() || !/^local_[\w-]+\.json$/.test(f.name)) continue
        let meta: ReturnType<typeof coworkMeta>
        try {
          meta = coworkMeta(JSON.parse(readFileSync(join(base, f.name), 'utf8')))
        } catch {
          continue
        }
        if (meta.archived) continue
        const projects = join(base, f.name.slice(0, -'.json'.length), '.claude', 'projects')
        for (const c of claudeTopLevel(projects, d, subagents, 'claude-cowork', {
          title: meta.title,
          cwd: meta.cwd,
          createdMs: meta.createdMs,
          updatedMs: meta.updatedMs
        })) {
          out.push(c)
        }
      }
    }
  }
  return { candidates: newestFirst(out), complete: !d.stopped, atLeast: d.stopped, error: null }
}

/* ------------------------------------------------------------------ Cline */

function listCline(e: SourceEnv, _subagents: boolean, d: Discovery): Listing {
  const root = clineRoot(e)
  const out: Candidate[] = []
  for (const s of dirents(root)) {
    if (!s.isDirectory() || !tick(d)) continue
    const dir = join(root, s.name)
    const messages = join(dir, `${s.name}.messages.json`)
    const st = statOrNull(messages)
    if (!st) continue
    let meta: ReturnType<typeof clineMeta>
    try {
      meta = clineMeta(JSON.parse(readFileSync(join(dir, `${s.name}.json`), 'utf8')))
    } catch {
      meta = clineMeta(null)
    }
    out.push({
      source: 'cline',
      nativeId: s.name,
      locator: messages,
      kind: 'cline',
      path: messages,
      mtimeMs: Math.round(st.mtimeMs),
      size: st.size,
      subagent: false,
      meta: { title: meta.title, cwd: meta.cwd, gitBranch: meta.gitBranch, model: meta.model, createdMs: meta.createdMs, updatedMs: meta.updatedMs },
      dedupeKey: meta.dedupeKey
    })
  }
  return { candidates: newestFirst(out), complete: !d.stopped, atLeast: d.stopped, error: null }
}

/* ----------------------------------------------------------------- facade */

export function listSource(id: ChatSourceId, e: SourceEnv, subagents: boolean, d: Discovery): Listing {
  try {
    switch (id) {
      case 'claude':
        return listClaude(e, subagents, d)
      case 'codex':
        return listCodex(e, subagents, d)
      case 'opencode':
        return listOpencode(e, subagents, d)
      case 'claude-cowork':
        return listCowork(e, subagents, d)
      case 'zed':
        return listZed(e, subagents, d)
      case 'cline':
        return listCline(e, subagents, d)
    }
  } catch (err) {
    return { candidates: [], complete: false, atLeast: false, error: readError(err) }
  }
}

export function readError(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown }
  if (e?.code === 'EACCES' || e?.code === 'EPERM') return 'Stoke is not allowed to read it.'
  const msg = typeof e?.message === 'string' ? e.message : String(err)
  if (/database is locked|SQLITE_BUSY/i.test(msg)) return 'Its database was busy; the next pass tries again.'
  if (/file is not a database|malformed/i.test(msg)) return 'Its database could not be read.'
  return `It could not be read (${msg.slice(0, 120)}).`
}

/**
 * Names and sizes only, before consent: no file is opened for its content and
 * no database is opened at all — a database source reports its file's size and
 * no count. What the offer card and Settings show before the first pass.
 */
export function detectSource(id: ChatSourceId, e: SourceEnv, subagents: boolean, d: Discovery): ChatSourceEstimate {
  let chats = 0
  let bytes = 0
  let present = false
  const count = (path: string): void => {
    const st = statOrNull(path)
    if (!st) return
    chats++
    bytes += st.size
  }
  switch (id) {
    case 'claude': {
      for (const root of claudeRoots(e)) {
        if (!existsSync(root)) continue
        present = true
        for (const proj of dirents(root)) {
          if (!proj.isDirectory() || !tick(d)) continue
          for (const f of dirents(join(root, proj.name))) {
            if (!tick(d)) break
            if (f.isFile() && f.name.endsWith('.jsonl')) count(join(root, proj.name, f.name))
            else if (subagents && f.isDirectory()) {
              for (const a of dirents(join(root, proj.name, f.name, 'subagents'))) {
                if (tick(d) && a.isFile() && a.name.endsWith('.jsonl')) count(join(root, proj.name, f.name, 'subagents', a.name))
              }
            }
          }
        }
      }
      break
    }
    case 'codex': {
      const home = codexHome(e)
      if (!existsSync(join(home, 'sessions'))) break
      present = true
      walkRollouts(home, d, (path) => count(path))
      break
    }
    case 'opencode':
    case 'zed': {
      const st = statOrNull(id === 'opencode' ? opencodeDbPath(e) : zedDbPath(e))
      if (!st) break
      return { id, present: true, chats: null, atLeast: false, bytes: st.size }
    }
    case 'claude-cowork': {
      const root = coworkRoot(e)
      if (!existsSync(root)) break
      present = true
      for (const org of dirents(root)) {
        if (!org.isDirectory() || !tick(d)) continue
        for (const acct of dirents(join(root, org.name))) {
          if (!acct.isDirectory() || !tick(d)) continue
          const base = join(root, org.name, acct.name)
          for (const f of dirents(base)) {
            if (!tick(d) || !f.isFile() || !/^local_[\w-]+\.json$/.test(f.name)) continue
            const projects = join(base, f.name.slice(0, -'.json'.length), '.claude', 'projects')
            for (const p of dirents(projects)) {
              if (!p.isDirectory()) continue
              for (const t of dirents(join(projects, p.name))) {
                if (tick(d) && t.isFile() && t.name.endsWith('.jsonl')) count(join(projects, p.name, t.name))
              }
            }
          }
        }
      }
      break
    }
    case 'cline': {
      const root = clineRoot(e)
      if (!existsSync(root)) break
      present = true
      for (const s of dirents(root)) {
        if (s.isDirectory() && tick(d)) count(join(root, s.name, `${s.name}.messages.json`))
      }
      break
    }
  }
  return { id, present, chats, atLeast: d.stopped, bytes }
}

/* ------------------------------------------------------------------ reads */

export interface Extracted {
  fold: Fold
  /** `append`: `fold.messages` follow the chat's stored ones. `replace`: they are all of it. */
  mode: 'append' | 'replace'
  /** Where the next pass starts, and the stat it was taken against. */
  file: Omit<FileRow, 'chatId' | 'locator' | 'source'>
  bytesRead: number
  /** Read as a head and a tail window: the file was over `fileBytes`. */
  truncated: boolean
}

const CHUNK = 1024 * 1024
const NL = 0x0a

/**
 * Fold a JSONL file from where the last pass stopped, one complete line at a
 * time. Appended bytes only when the file is provably the one read before
 * (same device and inode, not shorter, and the byte before the old offset
 * still a newline — `advanceCursor`'s checks, gotcha 103); from byte 0
 * otherwise. Bytes are cut at a newline BEFORE they are decoded, so a read that
 * ends inside a multi-byte character never corrupts it. A span over
 * `fileBytes` is read as its first three quarters and its last quarter.
 */
export function readJsonl(
  path: string,
  prev: FileRow | null,
  fileBytes: number,
  foldLine: (fold: Fold, line: string) => void
): Extracted {
  const fd = openSync(path, 'r')
  try {
    const st = fstatSync(fd)
    let from = 0
    let mode: Extracted['mode'] = 'replace'
    let bytesRead = 0
    if (prev && prev.offset > 0 && prev.dev === st.dev && prev.ino === st.ino && st.size >= prev.offset) {
      const one = Buffer.alloc(1)
      bytesRead += readSync(fd, one, 0, 1, prev.offset - 1)
      if (one[0] === NL) {
        from = prev.offset
        mode = 'append'
      }
    }
    const fold = emptyFold()
    const foldText = (text: string): void => {
      for (const line of text.split('\n')) if (line) foldLine(fold, line)
    }
    let offset = from
    let truncated = false
    const span = st.size - from
    if (span > fileBytes) {
      truncated = true
      const headLen = Math.floor(fileBytes * 0.75)
      const tailLen = fileBytes - headLen
      const head = readWindow(fd, from, headLen)
      bytesRead += head.length
      const hnl = head.lastIndexOf(NL)
      if (hnl >= 0) foldText(head.toString('utf8', 0, hnl))
      const tailStart = st.size - tailLen
      const tail = readWindow(fd, tailStart, tailLen)
      bytesRead += tail.length
      const first = tail.indexOf(NL)
      const last = tail.lastIndexOf(NL)
      if (first >= 0 && last > first) foldText(tail.toString('utf8', first + 1, last))
      offset = last >= 0 ? tailStart + last + 1 : from + (hnl >= 0 ? hnl + 1 : 0)
    } else if (span > 0) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, span))
      let carry: Buffer[] = []
      let carryLen = 0
      let pos = from
      while (pos < st.size) {
        const got = readSync(fd, buf, 0, Math.min(buf.length, st.size - pos), pos)
        if (got === 0) break
        bytesRead += got
        pos += got
        const nl = buf.lastIndexOf(NL, got - 1)
        if (nl < 0) {
          carry.push(Buffer.from(buf.subarray(0, got)))
          carryLen += got
          continue
        }
        const text = carryLen ? Buffer.concat([...carry, buf.subarray(0, nl)], carryLen + nl).toString('utf8') : buf.toString('utf8', 0, nl)
        foldText(text)
        offset = pos - got + nl + 1
        carryLen = got - nl - 1
        carry = carryLen ? [Buffer.from(buf.subarray(nl + 1, got))] : []
      }
    }
    return {
      fold,
      mode,
      file: { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: Math.round(st.mtimeMs), offset },
      bytesRead,
      truncated
    }
  } finally {
    closeSync(fd)
  }
}

function readWindow(fd: number, start: number, len: number): Buffer {
  const buf = Buffer.allocUnsafe(len)
  let got = 0
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, start + got)
    if (n === 0) break
    got += n
  }
  return buf.subarray(0, got)
}

/** A whole-document source (Cline): read in full when under `fileBytes`, else only its metadata is kept. */
export function readCline(c: Pick<Candidate, 'path'>, fileBytes: number, redact: boolean): Extracted {
  const st = statSync(c.path)
  const file = { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: Math.round(st.mtimeMs), offset: 0 }
  if (st.size > fileBytes) return { fold: emptyFold(), mode: 'replace', file, bytesRead: 0, truncated: true }
  const text = readFileSync(c.path, 'utf8')
  return { fold: foldClineMessages(JSON.parse(text), redact), mode: 'replace', file, bytesRead: Buffer.byteLength(text), truncated: false }
}

export function readOpencode(db: DatabaseSync, c: Pick<Candidate, 'nativeId' | 'mtimeMs'>, redact: boolean): Extracted {
  const rows = db
    .prepare(
      `SELECT m.id AS mid, json_extract(m.data, '$.role') AS role, m.time_created AS t, p.data AS data
       FROM message m JOIN part p ON p.message_id = m.id
       WHERE m.session_id = ? AND json_extract(p.data, '$.type') = 'text'
       ORDER BY m.time_created, m.id, p.id`
    )
    .all(c.nativeId) as Record<string, unknown>[]
  let bytes = 0
  const fold = foldOpencodeRows(
    rows.map((r) => {
      const data = typeof r.data === 'string' ? r.data : ''
      bytes += data.length
      return { messageId: String(r.mid), role: r.role, timeCreated: r.t, data }
    }),
    redact
  )
  return { fold, mode: 'replace', file: { dev: 0, ino: 0, size: 0, mtimeMs: c.mtimeMs, offset: 0 }, bytesRead: bytes, truncated: false }
}

export function readZed(db: DatabaseSync, c: Pick<Candidate, 'nativeId' | 'mtimeMs'>, fileBytes: number, redact: boolean): Extracted {
  const r = db.prepare('SELECT data_type, data FROM threads WHERE id = ?').get(c.nativeId) as Record<string, unknown> | undefined
  const file = { dev: 0, ino: 0, size: 0, mtimeMs: c.mtimeMs, offset: 0 }
  if (!r || !(r.data instanceof Uint8Array)) return { fold: emptyFold(), mode: 'replace', file, bytesRead: 0, truncated: false }
  const raw = Buffer.from(r.data)
  const json = r.data_type === 'zstd' ? zstdDecompressSync(raw, { maxOutputLength: fileBytes }) : raw
  return { fold: foldZedThread(JSON.parse(json.toString('utf8')), redact), mode: 'replace', file, bytesRead: raw.length, truncated: false }
}

/**
 * The line folder for a JSONL kind, with redaction bound. `subagent` is the
 * candidate's own flag: a Claude file listed from `<session>/subagents/` is a
 * subagent's whole thread, so its sidechain records are its text.
 */
export function lineFolder(kind: CandidateKind, redact: boolean, subagent = false): (fold: Fold, line: string) => void {
  return kind === 'jsonl-codex' ? (f, l) => foldCodexLine(f, l, redact) : (f, l) => foldClaudeLine(f, l, redact, subagent)
}
