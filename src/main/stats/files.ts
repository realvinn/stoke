import * as fs from 'node:fs/promises'
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isId } from '../../shared/hub/codec.ts'
import { parseStatsMonth, type StatsMonth } from '../../shared/stats.ts'

export interface StatsLedgerMeta { v: 1; id: string; createdAt: number; countingSince: number; countFrom: number; agentStore: string | null }
export type StatsFs = Pick<typeof fs, 'mkdir' | 'readdir' | 'readFile' | 'open' | 'rename' | 'rm' | 'chmod'> & { writeFileSync: typeof writeFileSync; renameSync: typeof renameSync; mkdirSync: typeof mkdirSync; rmSync: typeof rmSync }
export interface StatsLoad { meta: StatsLedgerMeta | null; months: StatsMonth[]; setAside: string[] }
const nativeFs: StatsFs = { ...fs, writeFileSync, renameSync, mkdirSync, rmSync }

export function parseLedgerMeta(raw: unknown): StatsLedgerMeta | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>
  const time = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0
  if (v.v !== 1 || typeof v.id !== 'string' || !isId('stats', v.id) || !time(v.createdAt) || !time(v.countingSince) || !time(v.countFrom) || !(v.agentStore === null || (typeof v.agentStore === 'string' && v.agentStore.length <= 128))) return null
  return { v: 1, id: v.id, createdAt: v.createdAt, countingSince: v.countingSince, countFrom: v.countFrom, agentStore: v.agentStore }
}

/** Serial atomic writes; no operation follows a symbolic-link temp name. */
export class StatsFiles {
  private dir: string
  private io: StatsFs
  private pending = new Map<string, string>()
  private writing: Promise<void> | null = null
  private active: [string, string] | null = null
  private failure: unknown = null
  private generation = 0
  constructor(dir: string, io: StatsFs = nativeFs) { this.dir = dir; this.io = io }
  private async ensure(): Promise<void> { await this.io.mkdir(this.dir, { recursive: true, mode: 0o700 }); await this.io.chmod(this.dir, 0o700) }
  async load(opts: { readOnly?: boolean } = {}): Promise<StatsLoad> {
    await this.idle()
    const out: StatsLoad = { meta: null, months: [], setAside: [] }
    let names: string[]
    try { names = await this.io.readdir(this.dir) as string[] }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return out; throw error }
    // A synchronous quit snapshot remains authoritative if an earlier async
    // rename completed after it. Consume it before reading the ordinary files.
    if (!opts.readOnly) {
      for (const name of names.filter(n => /^(?:ledger|\d{4}-(?:0[1-9]|1[0-2]))\.json\.recover$/.test(n))) {
        const data = JSON.parse(await this.io.readFile(join(this.dir, name), 'utf8')) as unknown
        const valid = name === 'ledger.json.recover' ? parseLedgerMeta(data) : parseStatsMonth(data)
        if (!valid || (name !== 'ledger.json.recover' && `${(valid as StatsMonth).month}.json.recover` !== name)) throw new Error(`Invalid Stats recovery snapshot: ${name}`)
        await this.io.rename(join(this.dir, name), join(this.dir, name.slice(0, -8)))
      }
      names = await this.io.readdir(this.dir) as string[]
    }
    for (const name of names.sort()) {
      if (name !== 'ledger.json' && !/^\d{4}-(0[1-9]|1[0-2])\.json$/.test(name)) continue
      let text: string
      try { text = await this.io.readFile(join(this.dir, name), 'utf8') }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
      try {
        const raw = JSON.parse(text) as unknown
        if (name === 'ledger.json') {
          out.meta = parseLedgerMeta(raw)
          if (!out.meta) throw new Error('Invalid ledger')
        } else {
          const month = parseStatsMonth(raw)
          if (!month || `${month.month}.json` !== name) throw new Error('Invalid month')
          out.months.push(month)
        }
      } catch {
        if (!opts.readOnly) {
          await this.io.rename(join(this.dir, name), join(this.dir, `${name}.bad-${Date.now()}-${randomUUID()}`))
          out.setAside.push(name)
        }
      }
    }
    return out
  }
  private queue(name: string, value: unknown): void {
    this.pending.set(name, JSON.stringify(value))
    if (!this.writing) this.writing = this.drain().catch(error => { this.failure = error })
  }
  private async drain(): Promise<void> {
    try {
      while (this.pending.size) {
        const entry = this.pending.entries().next().value as [string, string]
        this.pending.delete(entry[0])
        this.active = entry
        const [name, contents] = entry, generation = this.generation
        let tmp = ''
        try {
          await this.ensure()
          tmp = join(this.dir, `${name}.${randomUUID()}.tmp`)
          const handle = await this.io.open(tmp, 'wx', 0o600)
          try { await handle.writeFile(contents); await handle.sync() } finally { await handle.close() }
          if (generation === this.generation) {
            await this.io.rename(tmp, join(this.dir, name))
            if (generation === this.generation) await this.io.rm(join(this.dir, `${name}.recover`), { force: true })
          }
        } catch (error) {
          if (!this.pending.has(name) && generation === this.generation) this.pending.set(name, contents)
          throw error
        } finally { this.active = null; if (tmp) await this.io.rm(tmp, { force: true }).catch(() => {}) }
      }
    } finally { this.writing = null }
  }
  save(month: StatsMonth): void { this.queue(`${month.month}.json`, month) }
  async saveMeta(meta: StatsLedgerMeta): Promise<void> { this.queue('ledger.json', meta); await this.idle() }
  async idle(): Promise<void> { while (this.writing) await this.writing; if (this.failure) { const error = this.failure; this.failure = null; throw error } }
  flushSync(): void {
    // Invalidate async snapshots before publishing queued snapshots at quit.
    this.generation++
    this.io.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    if (this.active && !this.pending.has(this.active[0])) this.pending.set(this.active[0], this.active[1])
    for (const [name, contents] of this.pending) {
      const tmp = join(this.dir, `${name}.${randomUUID()}.tmp`)
      try { this.io.writeFileSync(tmp, contents, { mode: 0o600, flag: 'wx' }); this.io.renameSync(tmp, join(this.dir, `${name}.recover`)) }
      finally { this.io.rmSync(tmp, { force: true }) }
    }
    this.pending.clear()
  }
  async removeMonthsNotOf(id: string): Promise<number> {
    const loaded = await this.load({ readOnly: true })
    let removed = 0
    for (const month of loaded.months) if (month.computer !== id) { await this.io.rm(join(this.dir, `${month.month}.json`), { force: true }); removed++ }
    return removed
  }
}
