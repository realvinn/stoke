import { DatabaseSync } from 'node:sqlite'
import { chmodSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { monthOf } from '../../shared/localDay.ts'
import type { StatsAgentDay, StatsAgentMonth } from '../../shared/stats.ts'
import { RULES_VERSION, emptyFileState, type Counter, type FileState, type Role } from './rules.ts'

export const STATS_STORE_FILE = 'agents.sqlite'
export const BUSY_BITS = 1500
export interface FileRow { key: string; agent: 'claude' | 'codex'; role: Role; path: string; form: 'jsonl' | 'zst'; dev: number; ino: number; size: number; mtimeMs: number; offset: number; state: FileState; project: string | null; goneMs: number | null }
export interface FileBatch { counters: Map<string, Partial<Record<Counter, number>>>; busy: Map<string, Uint8Array>; models: Map<string, Map<string, [number, number]>>; seen: Map<string, string> }
const counters: Counter[] = ['added', 'removed', 'edits', 'prompts', 'sessions', 'replies', 'tokUncached', 'tokCacheRead', 'tokCacheWrite', 'tokOut', 'tcUncached', 'tcCacheRead', 'tcCacheWrite', 'tcOut', 'turnMs']
type SqlRow = Record<string, string | number | Uint8Array | null>
const blankAgent = (): StatsAgentDay => ({ estBusyMs: 0, estAgentMs: 0, added: 0, removed: 0, prompts: 0, sessions: 0, tokensIn: 0, tokensOut: 0 })
const n = (x: unknown): number => typeof x === 'number' && Number.isFinite(x) ? x : 0

export class StatsStore {
  private db: DatabaseSync
  private filePath: string
  private constructor(db: DatabaseSync, filePath: string) { this.db = db; this.filePath = filePath }
  static open(dir: string): StatsStore {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    if (process.platform !== 'win32') chmodSync(dir, 0o700)
    const file = join(dir, STATS_STORE_FILE)
    const setup = (): DatabaseSync => {
      const db = new DatabaseSync(file, { timeout: 2000 })
      try { db.exec(`PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS file(key TEXT PRIMARY KEY, agent TEXT NOT NULL, role TEXT NOT NULL, path TEXT NOT NULL, form TEXT NOT NULL, dev INTEGER, ino INTEGER, size INTEGER, mtime INTEGER, offset INTEGER NOT NULL, state TEXT, project TEXT, gone INTEGER);
        CREATE TABLE IF NOT EXISTS file_day(key TEXT NOT NULL, day TEXT NOT NULL, counters TEXT NOT NULL, busy BLOB, PRIMARY KEY(key, day));
        CREATE TABLE IF NOT EXISTS file_day_model(key TEXT NOT NULL, day TEXT NOT NULL, model TEXT NOT NULL, replies INTEGER NOT NULL, tok_out INTEGER NOT NULL, PRIMARY KEY(key, day, model));
        CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY, key TEXT NOT NULL, day TEXT NOT NULL); CREATE INDEX IF NOT EXISTS stats_seen_key ON seen(key);`)
        return db
      } catch (error) { db.close(); throw error }
    }
    let db: DatabaseSync
    try { db = setup() } catch (error) {
      const code = (error as { code?: string; errcode?: number }).code
      const errcode = (error as { errcode?: number }).errcode
      if (!existsSync(file) || !(code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || errcode === 11 || errcode === 26)) throw error
      renameSync(file, `${file}.bad-${Date.now()}-${randomUUID()}`)
      // WAL sidecars may contain recovered pages; preserve rather than discard them.
      for (const suffix of ['-wal', '-shm']) if (existsSync(file + suffix)) renameSync(file + suffix, `${file}${suffix}.bad-${Date.now()}-${randomUUID()}`)
      db = setup()
    }
    const store = new StatsStore(db, file)
    if (!store.get('storeId')) store.set('storeId', randomUUID())
    store.lockDown()
    return store
  }
  private lockDown(): void { for (const name of [this.filePath, `${this.filePath}-wal`, `${this.filePath}-shm`]) try { chmodSync(name, 0o600) } catch { /* file not created yet */ } }
  private get(key: string): string | null { const row = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as SqlRow | undefined; return typeof row?.value === 'string' ? row.value : null }
  private set(key: string, value: string): void { this.db.prepare('INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value) }
  get storeId(): string { return this.get('storeId')! }
  meta(): { ledger: string | null; countFromMs: number; timeBeforeMs: number; rules: number } { return { ledger: this.get('ledger'), countFromMs: Number(this.get('countFromMs') ?? 0), timeBeforeMs: Number(this.get('timeBeforeMs') ?? 0), rules: Number(this.get('rules') ?? 0) } }
  adopt(plan: { ledger: string; countFromMs: number; timeBeforeMs: number }): boolean {
    const old = this.meta(), rebuild = old.ledger !== plan.ledger || old.rules !== RULES_VERSION || old.countFromMs !== plan.countFromMs || old.timeBeforeMs !== plan.timeBeforeMs
    if (!rebuild) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db.exec('DELETE FROM file; DELETE FROM file_day; DELETE FROM file_day_model; DELETE FROM seen')
      this.set('ledger', plan.ledger); this.set('rules', String(RULES_VERSION)); this.set('countFromMs', String(plan.countFromMs)); this.set('timeBeforeMs', String(plan.timeBeforeMs)); this.set('storeId', randomUUID())
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.lockDown(); return true
  }
  file(key: string): FileRow | null {
    const r = this.db.prepare('SELECT * FROM file WHERE key=?').get(key) as SqlRow | undefined
    if (!r) return null
    let state: FileState
    try { state = JSON.parse(String(r.state)) as FileState } catch { state = emptyFileState() }
    return { key: String(r.key), agent: r.agent as FileRow['agent'], role: r.role as Role, path: String(r.path), form: r.form as FileRow['form'], dev: n(r.dev), ino: n(r.ino), size: n(r.size), mtimeMs: n(r.mtime), offset: n(r.offset), state, project: typeof r.project === 'string' ? r.project : null, goneMs: typeof r.gone === 'number' ? r.gone : null }
  }
  files(): FileRow[] { return (this.db.prepare('SELECT key FROM file').all() as SqlRow[]).map(r => this.file(String(r.key))!).filter(Boolean) }
  seen(id: string): boolean { return !!this.db.prepare('SELECT 1 FROM seen WHERE id=?').get(id) }
  seenElsewhere(id: string, key: string): boolean { return !!this.db.prepare('SELECT 1 FROM seen WHERE id=? AND key<>?').get(id, key) }
  commit(row: FileRow, batch: FileBatch, fromZero: boolean): string[] {
    const changed = new Set<string>()
    this.db.exec('BEGIN IMMEDIATE')
    try {
      if (fromZero) {
        for (const r of this.db.prepare('SELECT day FROM file_day WHERE key=?').all(row.key) as SqlRow[]) changed.add(monthOf(String(r.day)))
        for (const table of ['file_day', 'file_day_model', 'seen']) this.db.prepare(`DELETE FROM ${table} WHERE key=?`).run(row.key)
      }
      this.db.prepare(`INSERT INTO file(key,agent,role,path,form,dev,ino,size,mtime,offset,state,project,gone) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(key) DO UPDATE SET agent=excluded.agent,role=excluded.role,path=excluded.path,form=excluded.form,dev=excluded.dev,ino=excluded.ino,size=excluded.size,mtime=excluded.mtime,offset=excluded.offset,state=excluded.state,project=excluded.project,gone=excluded.gone`).run(row.key, row.agent, row.role, row.path, row.form, row.dev, row.ino, row.size, row.mtimeMs, row.offset, JSON.stringify(row.state), row.project, row.goneMs)
      for (const day of new Set([...batch.counters.keys(), ...batch.busy.keys(), ...batch.models.keys()])) {
        const old = this.db.prepare('SELECT counters,busy FROM file_day WHERE key=? AND day=?').get(row.key, day) as SqlRow | undefined
        let totals: Partial<Record<Counter, number>> = {}
        try { if (old?.counters) totals = JSON.parse(String(old.counters)) as typeof totals } catch { /* malformed row becomes empty */ }
        for (const field of counters) totals[field] = n(totals[field]) + n(batch.counters.get(day)?.[field])
        const before = old?.busy instanceof Uint8Array ? old.busy : new Uint8Array(Math.ceil(BUSY_BITS / 8))
        const incoming = batch.busy.get(day), busy = new Uint8Array(Math.ceil(BUSY_BITS / 8)); busy.set(before.subarray(0, busy.length))
        if (incoming) for (let i = 0; i < Math.min(incoming.length, busy.length); i++) busy[i] |= incoming[i]
        this.db.prepare('INSERT INTO file_day(key,day,counters,busy) VALUES (?,?,?,?) ON CONFLICT(key,day) DO UPDATE SET counters=excluded.counters,busy=excluded.busy').run(row.key, day, JSON.stringify(totals), busy)
        for (const [model, [replies, output]] of batch.models.get(day) ?? []) this.db.prepare('INSERT INTO file_day_model(key,day,model,replies,tok_out) VALUES (?,?,?,?,?) ON CONFLICT(key,day,model) DO UPDATE SET replies=replies+excluded.replies,tok_out=tok_out+excluded.tok_out').run(row.key, day, model, replies, output)
        changed.add(monthOf(day))
      }
      for (const [id, day] of batch.seen) this.db.prepare('INSERT OR IGNORE INTO seen(id,key,day) VALUES (?,?,?)').run(id, row.key, day)
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
    this.lockDown(); return [...changed].sort()
  }
  markGone(key: string, now: number): void { this.db.prepare('UPDATE file SET gone=? WHERE key=?').run(now, key) }
  months(which: 'all' | readonly string[]): StatsAgentMonth[] {
    const rows = this.db.prepare('SELECT d.day,d.counters,d.busy,f.agent FROM file_day d JOIN file f ON f.key=d.key').all() as SqlRow[]
    const days = new Map<string, { totals: StatsAgentDay; busy: Uint8Array }>()
    for (const row of rows) {
      const day = String(row.day), month = monthOf(day)
      if (which !== 'all' && !which.includes(month)) continue
      const entry = days.get(day) ?? { totals: blankAgent(), busy: new Uint8Array(Math.ceil(BUSY_BITS / 8)) }
      let values: Partial<Record<Counter, number>> = {}
      try { values = JSON.parse(String(row.counters)) as typeof values } catch { continue }
      for (const field of ['added', 'removed', 'prompts', 'sessions'] as const) entry.totals[field] += n(values[field])
      entry.totals.estAgentMs += n(values.turnMs)
      const prefix = row.agent === 'codex' && !n(values.replies) && !n(values.tokUncached) && !n(values.tokCacheRead) && !n(values.tokCacheWrite) && !n(values.tokOut) ? 'tc' : 'tok'
      entry.totals.tokensIn += n(values[`${prefix}Uncached` as Counter]) + n(values[`${prefix}CacheRead` as Counter]) + n(values[`${prefix}CacheWrite` as Counter])
      entry.totals.tokensOut += n(values[`${prefix}Out` as Counter])
      if (row.busy instanceof Uint8Array) for (let i = 0; i < Math.min(row.busy.length, entry.busy.length); i++) entry.busy[i] |= row.busy[i]
      days.set(day, entry)
    }
    // A changed month may now have no rows (for example, after truncation).
    // Return it anyway so the ledger can clear the old contribution.
    const months = new Map<string, StatsAgentMonth>(which === 'all' ? [] : which.map(month => [month, { month, days: {} }]))
    for (const [day, entry] of days) {
      for (const byte of entry.busy) { let bits = byte; while (bits) { entry.totals.estBusyMs += 60_000; bits &= bits - 1 } }
      const key = monthOf(day), month = months.get(key) ?? { month: key, days: {} }
      month.days[day] = entry.totals; months.set(key, month)
    }
    return [...months.values()].sort((a, b) => a.month.localeCompare(b.month))
  }
  close(): void { this.lockDown(); this.db.close() }
}
