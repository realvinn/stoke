import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/** Bounded async state for built-in modules; a timeout retains disk-write ownership. */
export class PluginStorage<T> {
  readonly file: string
  private parse: (raw: unknown) => T
  private empty: () => T
  private value: T | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private controllers = new Set<AbortController>()
  private stopped = false
  constructor(file: string, parse: (raw: unknown) => T, empty: () => T) {
    this.file = file; this.parse = parse; this.empty = empty
  }
  private serial<R>(fn: (signal: AbortSignal) => Promise<R>): Promise<R> {
    if (this.stopped || this.controllers.size >= 8) return Promise.reject(new Error('Plugin storage is stopped or busy. Reopen the panel before retrying.'))
    const controller = new AbortController(); this.controllers.add(controller)
    const expired = new Promise<R>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Plugin storage took too long. Reopen the panel before retrying; a save may have finished.')), { once: true }))
    const timer = setTimeout(() => controller.abort(), 5000)
    const run = this.chain.then(async () => {
      try { controller.signal.throwIfAborted(); return await fn(controller.signal) }
      finally { clearTimeout(timer); this.controllers.delete(controller) }
    })
    this.chain = run.catch(() => {})
    return Promise.race([run, expired])
  }
  private async load(signal: AbortSignal): Promise<T> {
    if (this.value !== null) return this.value
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(this.file, 'r'); signal.throwIfAborted()
      const info = await handle.stat()
      if (!info.isFile() || info.size > 16 * 1024 * 1024) throw new Error('The saved plugin data cannot be opened. Keep the file for recovery.')
      const text = await handle.readFile({ encoding: 'utf8', signal })
      let raw: unknown
      try { raw = JSON.parse(text) } catch { throw new Error('The saved plugin data is unreadable. Keep the file for recovery.') }
      this.value = this.parse(raw)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      signal.throwIfAborted(); this.value = this.empty()
    } finally { await handle?.close() }
    return this.value!
  }
  read(): Promise<T> { return this.serial(async (signal) => structuredClone(await this.load(signal))) }
  change(edit: (state: T) => T): Promise<T> {
    return this.serial(async (signal) => {
      const next = this.parse(edit(structuredClone(await this.load(signal))))
      const text = JSON.stringify(next)
      if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw new Error('Plugin data exceeds its storage limit.')
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 }); signal.throwIfAborted()
      const temporary = `${this.file}.${randomUUID()}.tmp`
      let handle: Awaited<ReturnType<typeof open>> | null = null
      try {
        handle = await open(temporary, 'wx', 0o600)
        await handle.writeFile(text, { encoding: 'utf8', signal }); await handle.sync(); await handle.close(); handle = null
        signal.throwIfAborted(); await rename(temporary, this.file); this.value = next
      } finally { await handle?.close(); await rm(temporary, { force: true }) }
      return structuredClone(next)
    })
  }
  stop(): void { this.stopped = true; for (const c of this.controllers) c.abort(); this.controllers.clear() }
}
