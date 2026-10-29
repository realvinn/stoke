/** Runs only in the chat-index worker: synchronous filesystem calls stay off the UI thread. */
import { closeSync, createReadStream, openSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'
import { dayStartMs } from '../../shared/localDay.ts'
import { isInside, pathRulesFor } from '../../shared/paths.ts'
import { encodeProjectDir, isPrivateProjectDir } from '../../shared/privateChat.ts'
import type { StatsPassResult } from '../../shared/stats.ts'
import { claudeRoots, codexHome, type SourceEnv } from '../chatIndex/sources.ts'
import { LINE_HEAD_BYTES, emptyFileState, foldClaudeLine, foldCodexLine, wantedClaude, wantedCodex, type Booker, type Role } from './rules.ts'
import { BUSY_BITS, StatsStore, type FileBatch, type FileRow } from './store.ts'

export const READ_CHUNK_BYTES = 1 << 20
export const COMMIT_EVERY_BYTES = 32 << 20
export interface StatsPlan { ledger: string; countFromMs: number; timeBeforeMs: number; env: SourceEnv; codexHomes: string[]; reportAll: boolean; budgetMs: number }
export interface StatsCandidate { key: string; agent: 'claude' | 'codex'; role: Role; path: string; form: 'jsonl' | 'zst'; size: number; mtimeMs: number; dev: number; ino: number }
export interface PassHooks { yieldTurn(): Promise<void>; cancelled(): boolean; now(): number; commitEveryBytes?: number }

/** Named roots only; the listing never walks outside Claude's and Codex's trees. */
export function listStatsFiles(plan: StatsPlan): { files: StatsCandidate[]; errors: number } {
  const found = new Map<string, StatsCandidate>()
  const roots = new Set<string>()
  let errors = 0, entries = 0
  const list = (dir: string) => { try { const all = readdirSync(dir, { withFileTypes: true }); const remaining = Math.max(0, 50_000 - entries); if (all.length > remaining) errors++; return all.slice(0, remaining) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors++; return [] } }
  const root = (dir: string): string | null => { try { const p = realpathSync(dir); if (roots.has(p)) return null; roots.add(p); return p } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') errors++; return null } }
  const add = (path: string, key: string, agent: StatsCandidate['agent'], role: Role, form: StatsCandidate['form']): void => {
    try {
      const s = statSync(path)
      if (!s.isFile()) return
      const old = found.get(key)
      if (old && (old.form === 'jsonl' || form === 'zst')) return
      found.set(key, { key, agent, role, path, form, size: s.size, mtimeMs: s.mtimeMs, dev: s.dev, ino: s.ino })
    } catch { errors++ }
  }
  for (const name of claudeRoots(plan.env)) {
    const base = root(name); if (!base) continue
    for (const project of list(base)) {
      entries++; if (!project.isDirectory() || isPrivateProjectDir(project.name, plan.env.privateRoots ?? [])) continue
      const projectDir = join(base, project.name)
      for (const entry of list(projectDir)) {
        entries++
        if (entry.isFile() && /^[0-9a-f-]+\.jsonl$/i.test(entry.name)) { const path = join(projectDir, entry.name); add(path, `c:${path}`, 'claude', 'top', 'jsonl') }
        if (!entry.isDirectory()) continue
        const sub = join(projectDir, entry.name, 'subagents')
        for (const agent of list(sub)) {
          entries++
          if (agent.isFile() && /^agent-.*\.jsonl$/.test(agent.name)) { const path = join(sub, agent.name); add(path, `c:${path}`, 'claude', 'sub', 'jsonl') }
          if (agent.isDirectory() && agent.name === 'workflows') for (const run of list(join(sub, 'workflows'))) {
            entries++; if (!run.isDirectory()) continue
            for (const file of list(join(sub, 'workflows', run.name))) { entries++; if (file.isFile() && /^agent-.*\.jsonl$/.test(file.name)) { const path = join(sub, 'workflows', run.name, file.name); add(path, `c:${path}`, 'claude', 'wf', 'jsonl') } }
          }
        }
      }
    }
  }
  for (const name of [codexHome(plan.env), ...plan.codexHomes]) {
    const base = root(join(name, 'sessions')); if (!base) continue
    for (const year of list(base)) { entries++; if (!year.isDirectory() || !/^\d{4}$/.test(year.name)) continue
      for (const month of list(join(base, year.name))) { entries++; if (!month.isDirectory() || !/^\d{2}$/.test(month.name)) continue
        for (const day of list(join(base, year.name, month.name))) { entries++; if (!day.isDirectory() || !/^\d{2}$/.test(day.name)) continue
          const folder = join(base, year.name, month.name, day.name)
          for (const file of list(folder)) { entries++; if (!file.isFile()) continue
            const match = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(\.zst)?$/i.exec(file.name)
            if (match) add(join(folder, file.name), `x:${match[1].toLowerCase()}`, 'codex', 'thread', match[2] ? 'zst' : 'jsonl')
          }
        }
      }
    }
  }
  return { files: [...found.values()].sort((a, b) => b.mtimeMs - a.mtimeMs), errors }
}

const newBatch = (): FileBatch => ({ counters: new Map(), busy: new Map(), models: new Map(), seen: new Map() })
function booker(batch: FileBatch, store: StatsStore, row: FileRow, fromZero: () => boolean): Booker {
  return {
    add(day, counter, n) { if (!n) return; const values = batch.counters.get(day) ?? {}; values[counter] = (values[counter] ?? 0) + n; batch.counters.set(day, values) },
    turn(start, end) {
      for (let at = start; at < end;) {
        const day = new Date(at), key = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
        const minute = Math.floor((at - dayStartMs(key)) / 60_000), bits = batch.busy.get(key) ?? new Uint8Array(Math.ceil(BUSY_BITS / 8))
        if (minute >= 0 && minute < BUSY_BITS) bits[minute >> 3] |= 1 << (minute & 7)
        batch.busy.set(key, bits); at = Math.min(end, dayStartMs(key) + (minute + 1) * 60_000)
      }
    },
    model(day, model, replies, out) { const models = batch.models.get(day) ?? new Map(); const previous = models.get(model) ?? [0, 0]; models.set(model, [previous[0] + replies, previous[1] + out]); batch.models.set(day, models) },
    seen(id) { return batch.seen.has(id) || (fromZero() ? store.seenElsewhere(id, row.key) : store.seen(id)) },
    see(id, day) { batch.seen.set(id, day) }
  }
}

function foldLine(line: Buffer, candidate: StatsCandidate, row: FileRow, batch: FileBatch, store: StatsStore, fromZero: () => boolean, plan: StatsPlan): void {
  const head = line.subarray(0, LINE_HEAD_BYTES)
  const wants = candidate.agent === 'claude' ? wantedClaude(head, row.state, row.role) : wantedCodex(head)
  if (!wants) return
  const book = booker(batch, store, row, fromZero)
  if (candidate.agent === 'claude') foldClaudeLine(line.toString('utf8'), row.state, { role: row.role, countFromMs: plan.countFromMs, timeBeforeMs: plan.timeBeforeMs }, book)
  else {
    if (!row.state.cwd && !/"session_meta"/.test(head.toString('utf8'))) throw new Error('Codex transcript has no verified workspace')
    foldCodexLine(line.toString('utf8'), row.state, { role: row.role, countFromMs: plan.countFromMs, timeBeforeMs: plan.timeBeforeMs }, book)
    if (!row.state.cwd) throw new Error('Codex transcript has no verified workspace')
    if ((plan.env.privateRoots ?? []).some(root => isInside(root, row.state.cwd!, pathRulesFor(plan.env.platform)))) throw new Error('Private transcript is not indexed')
    if (isPrivateProjectDir(encodeProjectDir(row.state.cwd), plan.env.privateRoots ?? [])) throw new Error('Private transcript is not indexed')
    if (row.state.source === 'subagent') row.role = 'subthread'
  }
}

async function readCompressed(candidate: StatsCandidate, old: FileRow | null, plan: StatsPlan, store: StatsStore, hooks: PassHooks, start: number): Promise<{ changed: string[]; bytes: number; stopped: 'time' | 'cancel' | null }> {
  let useOld = !!old && (old.form === 'jsonl' || (old.dev === candidate.dev && old.ino === candidate.ino && candidate.size >= old.size))
  for (let attempt = 0; attempt < 2; attempt++) {
    let fromZero = !useOld
    const row: FileRow = { ...candidate, offset: useOld ? old!.offset : 0, state: useOld ? structuredClone(old!.state) : emptyFileState(), project: useOld ? old!.project : null, goneMs: null }
    row.state.zstdComplete = false
    let skip = row.offset, lastSkipped = -1, cursor = row.offset, bytes = 0, sinceCommit = 0, carry = Buffer.alloc(0)
    let batch = newBatch(), changed = new Set<string>(), invalidResume = false
    const commit = (): void => { row.offset = cursor; row.project = row.state.cwd ?? row.project; for (const m of store.commit(row, batch, fromZero)) changed.add(m); fromZero = false; batch = newBatch(); sinceCommit = 0 }
    const input = createReadStream(candidate.path)
    const decoder = createZstdDecompress()
    input.on('error', error => decoder.destroy(error))
    input.pipe(decoder)
    try {
      for await (const raw of decoder) {
        let chunk = Buffer.from(raw as Uint8Array)
        if (skip) {
          const amount = Math.min(skip, chunk.length)
          if (amount) lastSkipped = chunk[amount - 1]
          skip -= amount; chunk = chunk.subarray(amount)
          if (skip) {
            await hooks.yieldTurn()
            if (hooks.cancelled() || hooks.now() - start >= plan.budgetMs) return { changed: [], bytes: 0, stopped: hooks.cancelled() ? 'cancel' : 'time' }
            continue
          }
          if (lastSkipped !== 10) { invalidResume = true; break }
        }
        const data = carry.length ? Buffer.concat([carry, chunk]) : chunk
        let offset = 0
        for (let i = 0; i < data.length; i++) if (data[i] === 10) {
          const line = data.subarray(offset, i)
          foldLine(line, candidate, row, batch, store, () => fromZero, plan)
          const length = i + 1 - offset
          cursor += length; bytes += length; sinceCommit += length; offset = i + 1
        }
        carry = Buffer.from(data.subarray(offset))
        if (carry.length > 16 * 1024 * 1024) throw new Error('Transcript line exceeds limit')
        if (sinceCommit >= (hooks.commitEveryBytes ?? COMMIT_EVERY_BYTES)) commit()
        await hooks.yieldTurn()
        if (hooks.cancelled() || hooks.now() - start >= plan.budgetMs) { commit(); return { changed: [...changed], bytes, stopped: hooks.cancelled() ? 'cancel' : 'time' } }
      }
      if (skip) invalidResume = true
      if (!invalidResume) { row.state.zstdComplete = true; commit(); return { changed: [...changed], bytes, stopped: null } }
    } finally { input.destroy(); decoder.destroy() }
    useOld = false
  }
  throw new Error('Compressed transcript could not resume')
}

export async function runStatsPass(plan: StatsPlan, store: StatsStore, hooks: PassHooks): Promise<StatsPassResult> {
  const start = hooks.now(), rebuilt = store.adopt(plan), listing = listStatsFiles(plan), found = new Set(listing.files.map(f => f.key))
  // An incomplete listing must never mark unseen files gone.
  if (!listing.errors) for (const old of store.files()) if (!found.has(old.key)) store.markGone(old.key, start)
  let bytesRead = 0, skipped = listing.errors, pending = 0, stoppedBy: 'time' | 'cancel' | null = null
  const changed = new Set<string>()
  for (let index = 0; index < listing.files.length; index++) {
    const candidate = listing.files[index], old = store.file(candidate.key)
    if (hooks.cancelled() || hooks.now() - start >= plan.budgetMs) { stoppedBy = hooks.cancelled() ? 'cancel' : 'time'; pending += listing.files.length - index; break }
    if (old && old.dev === candidate.dev && old.ino === candidate.ino && old.size === candidate.size && old.mtimeMs === candidate.mtimeMs && !old.goneMs && (candidate.form === 'zst' ? old.state.zstdComplete : old.state.scanComplete)) continue
    if (candidate.form === 'zst') {
      try {
        const result = await readCompressed(candidate, old, plan, store, hooks, start)
        for (const month of result.changed) changed.add(month)
        bytesRead += result.bytes
        if (result.stopped) { stoppedBy = result.stopped; pending += listing.files.length - index; break }
      } catch { skipped++ }
      continue
    }
    let fd = -1
    try {
      fd = openSync(candidate.path, 'r')
      let fromZero = !old || old.dev !== candidate.dev || old.ino !== candidate.ino || candidate.size < old.offset || old.form !== candidate.form || (candidate.size === old.size && candidate.mtimeMs !== old.mtimeMs)
      if (!fromZero && old!.offset > 0) { const b = Buffer.alloc(1); fromZero = readSync(fd, b, 0, 1, old!.offset - 1) !== 1 || b[0] !== 10 }
      let row: FileRow = { ...candidate, offset: fromZero ? 0 : old!.offset, state: fromZero ? emptyFileState() : old!.state, project: fromZero ? null : old!.project, goneMs: null }
      row.state.scanComplete = false
      let batch = newBatch(), sinceCommit = 0, cursor = row.offset, carry = Buffer.alloc(0)
      const commit = (): void => { row = { ...row, offset: cursor, project: row.state.cwd ?? row.project }; for (const month of store.commit(row, batch, fromZero)) changed.add(month); fromZero = false; batch = newBatch(); sinceCommit = 0 }
      while (cursor < candidate.size) {
        const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, candidate.size - cursor))
        const got = readSync(fd, buffer, 0, buffer.length, cursor)
        if (!got) break
        const data = carry.length ? Buffer.concat([carry, buffer.subarray(0, got)]) : buffer.subarray(0, got)
        const end = data.lastIndexOf(10)
        if (end < 0) { carry = Buffer.from(data); if (carry.length > 16 * 1024 * 1024) throw new Error('Transcript line exceeds limit'); cursor += got; continue }
        const consumed = end + 1, startOffset = cursor - carry.length
        let at = 0
        for (let i = 0; i < consumed; i++) if (data[i] === 10) {
          const line = data.subarray(at, i); at = i + 1
          foldLine(line, candidate, row, batch, store, () => fromZero, plan)
        }
        cursor = startOffset + consumed; bytesRead += consumed; sinceCommit += consumed; carry = Buffer.alloc(0)
        if (sinceCommit >= (hooks.commitEveryBytes ?? COMMIT_EVERY_BYTES)) commit()
        await hooks.yieldTurn()
        if (hooks.cancelled() || hooks.now() - start >= plan.budgetMs) { commit(); stoppedBy = hooks.cancelled() ? 'cancel' : 'time'; pending += listing.files.length - index; break }
      }
      if (!stoppedBy) { cursor -= carry.length; row.state.scanComplete = true; commit() }
      if (stoppedBy) break
    } catch { skipped++ } finally { if (fd >= 0) closeSync(fd) }
  }
  return { ledger: plan.ledger, storeId: store.storeId, months: store.months(plan.reportAll || rebuilt ? 'all' : [...changed]), filesTotal: listing.files.length, filesPending: pending, skipped, bytesRead, stoppedBy, ms: Math.max(0, hooks.now() - start) }
}
