import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Bounded, serialized plugin persistence. An expired operation cannot commit later. */
export class PluginFile<T> {
  private file: string
  private limit: number
  private chain: Promise<unknown> = Promise.resolve()
  private pending = 0
  constructor(file: string, limit = 3 * 1024 * 1024) {
    this.file = file
    this.limit = limit
  }
  transaction<R>(operation: (signal: AbortSignal) => Promise<R>): Promise<R> {
    if (this.pending >= 16) return Promise.reject(new Error('The plugin is busy. Wait before retrying.'))
    this.pending++
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const run = this.chain.then(() => {
      signal.throwIfAborted()
      return operation(signal)
    }).finally(() => { this.pending-- })
    const signal = controller.signal
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('The plugin store took too long. Refresh before retrying.'))
      }, 8000)
    })
    this.chain = run.catch(() => {})
    return Promise.race([run, deadline]).finally(() => {
      clearTimeout(timer)
    })
  }
  async read(signal: AbortSignal): Promise<unknown | null> {
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(this.file, 'r')
      signal.throwIfAborted()
      const stat = await handle.stat()
      signal.throwIfAborted()
      if (!stat.isFile() || stat.size > this.limit)
        throw new Error('The plugin store cannot be read. Keep the file for recovery.')
      return JSON.parse(await handle.readFile({ encoding: 'utf8', signal }))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    } finally {
      await handle?.close()
    }
  }
  async write(value: T, signal: AbortSignal): Promise<void> {
    const serialized = JSON.stringify(value, null, 2)
    if (Buffer.byteLength(serialized) > this.limit) throw new Error('The plugin store is full.')
    const temp = `${this.file}.${randomUUID()}.tmp`
    try {
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 })
      signal.throwIfAborted()
      await writeFile(temp, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx', signal })
      signal.throwIfAborted()
      await rename(temp, this.file)
    } finally {
      await rm(temp, { force: true }).catch(() => {})
    }
  }
}
