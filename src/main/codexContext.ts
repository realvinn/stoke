import { open, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { newestRollouts } from './codexUsage.ts'
import { codexRolloutMeta, emptyCodexContext, foldCodexContext, codexContextSnapshot, type CodexContextState } from '../shared/codexContext.ts'
import type { ContextSnapshot } from '../shared/types.ts'

export interface CodexContextTarget { sessionId: string; home: string; cwd: string; startedAt: number; resumeId?: string | null; continueLast?: boolean }
interface Watch { target: CodexContextTarget; file: string | null; nativeId?: string; offset: number; partial: string; skipping: boolean; decoder: StringDecoder; state: CodexContextState; busy: boolean; stopped: boolean; timer?: ReturnType<typeof setTimeout>; stamp: string }
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const samePath = (a: string, b: string): boolean => process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(b).toLowerCase() : resolve(a) === resolve(b)

/** Read only the metadata line; never expose instructions or message text. */
async function metadata(file: string) {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(256 * 1024), { bytesRead } = await fh.read(buf, 0, buf.length, 0)
    const body = buf.subarray(0, bytesRead), end = body.indexOf(10)
    return end < 0 ? null : codexRolloutMeta(body.subarray(0, end).toString('utf8'))
  } finally { await fh.close() }
}

/** Explicit resume can refer to an old day. No recursive traversal outside the account's sessions tree. */
async function resumeFile(home: string, id: string): Promise<string | null> {
  if (!UUID.test(id)) return null
  const root = join(home, 'sessions')
  let visited = 0
  for (const y of await readdir(root).catch(() => [])) if (/^\d{4}$/.test(y)) {
    for (const m of await readdir(join(root, y)).catch(() => [])) if (/^\d{2}$/.test(m)) {
      for (const d of await readdir(join(root, y, m)).catch(() => [])) if (/^\d{2}$/.test(d)) {
        if (++visited > 4000) return null
        const dir = join(root, y, m, d)
        const name = (await readdir(dir).catch(() => [])).find(n => n.startsWith('rollout-') && n.endsWith(`-${id}.jsonl`))
        if (name) return join(dir, name)
      }
    }
  }
  return null
}

/** Per-launch, per-account reader. An ambiguous same-folder launch stays unknown instead of stealing another tab's meter. */
export class CodexContextWatcher {
  private watches = new Map<string, Watch>()
  private latest = new Map<string, ContextSnapshot>()
  private emit: (snap: ContextSnapshot) => void
  constructor(emit: (snap: ContextSnapshot) => void) { this.emit = emit }
  has(id: string): boolean { return this.watches.has(id) }
  snapshot(id: string): ContextSnapshot | null { return this.latest.get(id) ?? null }
  watch(target: CodexContextTarget): void {
    if (this.has(target.sessionId)) return
    const w: Watch = { target, file: null, offset: 0, partial: '', skipping: false, decoder: new StringDecoder('utf8'), state: emptyCodexContext(), busy: false, stopped: false, stamp: '' }
    this.watches.set(target.sessionId, w)
    void this.tick(w)
  }
  unwatch(id: string): void {
    const w = this.watches.get(id)
    if (w) { w.stopped = true; clearTimeout(w.timer) }
    this.watches.delete(id)
  }
  disposeAll(): void { for (const id of this.watches.keys()) this.unwatch(id) }
  refresh(id: string): void { const w = this.watches.get(id); if (w && !w.busy) { clearTimeout(w.timer); w.stamp = ''; void this.tick(w) } }
  private async discover(w: Watch): Promise<string | null> {
    const t = w.target
    if (t.resumeId) {
      const file = await resumeFile(t.home, t.resumeId)
      return file && (await metadata(file).catch(() => null))?.id === t.resumeId ? file : null
    }
    // Native "continue last" has no stable thread id at launch. Do not guess by account-wide newest usage.
    if (t.continueLast) return null
    if ([...this.watches.values()].some(other => other !== w && samePath(other.target.home, t.home) && samePath(other.target.cwd, t.cwd) && Math.abs(other.target.startedAt - t.startedAt) < 20_000)) return null
    const candidates: string[] = []
    for (const f of await newestRollouts(join(t.home, 'sessions'), 128)) {
      if (f.mtimeMs < t.startedAt - 1000) continue
      const meta = await metadata(f.path).catch(() => null)
      if (meta?.cli && samePath(meta.cwd, t.cwd) && meta.startedAt >= t.startedAt - 1000 && meta.startedAt <= t.startedAt + 20_000) candidates.push(f.path)
    }
    return candidates.length === 1 ? candidates[0] : null
  }
  private async tick(w: Watch): Promise<void> {
    if (w.stopped || w.busy) return
    w.busy = true
    let delay = 1500
    try {
      w.file ??= await this.discover(w)
      if (w.stopped) return
      if (!w.file) {
        const snap = codexContextSnapshot(w.state, w.target.sessionId, 0)
        snap.readingNote = w.target.continueLast ? 'Codex continue-last: context unavailable until a specific chat is resumed.' : 'Codex rollout not confirmed yet; context is unknown.'
        this.publish(w, snap)
        return
      }
      if (!w.nativeId) {
        const meta = await metadata(w.file)
        if (meta && UUID.test(meta.id)) w.nativeId = meta.id
      }
      const fh = await open(w.file, 'r')
      let mtime: number
      try {
        const st = await fh.stat(); mtime = st.mtimeMs
        if (st.size < w.offset) { w.offset = 0; w.partial = ''; w.skipping = false; w.decoder = new StringDecoder('utf8'); w.state = emptyCodexContext() }
        const buf = Buffer.alloc(Math.min(1024 * 1024, st.size - w.offset))
        const { bytesRead } = await fh.read(buf, 0, buf.length, w.offset)
        w.offset += bytesRead
        const text = w.decoder.write(buf.subarray(0, bytesRead))
        for (const part of text.split(/(?<=\n)/)) {
          if (!w.skipping) w.partial += part
          if (w.partial.length > 2 * 1024 * 1024) { w.partial = ''; w.skipping = true }
          if (part.endsWith('\n')) { if (!w.skipping) foldCodexContext(w.state, w.partial); w.partial = ''; w.skipping = false }
        }
        if (w.offset < st.size) { delay = 0; return }
      } finally { await fh.close() }
      if (w.stopped) return
      const snap = codexContextSnapshot(w.state, w.target.sessionId, mtime)
      if (w.nativeId) snap.agentResumeId = w.nativeId
      this.publish(w, snap)
    } catch { /* A temporarily unavailable account folder leaves its last reading intact. */ }
    finally { w.busy = false; if (!w.stopped) w.timer = setTimeout(() => void this.tick(w), delay) }
  }
  private publish(w: Watch, snap: ContextSnapshot): void {
    const stamp = JSON.stringify(snap)
    if (stamp !== w.stamp) { w.stamp = stamp; this.latest.set(snap.sessionId, snap); this.emit(snap) }
  }
}
