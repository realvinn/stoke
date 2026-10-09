import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { judgeProtection, sealedText, unsealedValue } from '../../shared/secrets.ts'
import type { SecretBackend } from '../secrets.ts'

const REFERENCE = 'plugins.work.notion'
const MAX_BYTES = 32 * 1024
const TIMEOUT_MS = 5000

/** A plugin credential is a sealed reference; the Work view never returns its value. */
export class WorkCredentials {
  readonly file: string
  private backend: SecretBackend
  private platform: string
  private chain: Promise<unknown> = Promise.resolve()
  private pending = 0
  constructor(userData: string, backend: SecretBackend, platform: string) {
    this.file = join(userData, 'plugins', 'work-notion-secret.json')
    this.backend = backend; this.platform = platform
  }
  private async bounded<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController()
    let rejectExpired: (error: Error) => void = () => {}
    const expired = new Promise<T>((_resolve, reject) => { rejectExpired = reject })
    const timer = setTimeout(() => { controller.abort(); rejectExpired(new Error('The Work credential store took too long. Check the connection before retrying.')) }, TIMEOUT_MS)
    try { return await Promise.race([fn(controller.signal), expired]) } finally { clearTimeout(timer) }
  }
  private protected(): void {
    let safe = false
    try { safe = judgeProtection(this.platform, this.backend.isEncryptionAvailable(), this.backend.selectedBackend()).protected } catch { safe = false }
    if (!safe) throw new Error('Notion tokens need the macOS Keychain, Windows DPAPI, or a Linux Secret Service. Local Work boards remain available.')
  }
  async present(): Promise<boolean> {
    return this.bounded(async (signal) => {
      let handle: Awaited<ReturnType<typeof open>> | null = null
      try {
        handle = await open(this.file, 'r'); signal.throwIfAborted()
        const info = await handle.stat(); signal.throwIfAborted()
        if (!info.isFile() || info.size > MAX_BYTES) throw new Error('The saved Notion credential cannot be read. Replace it in connection settings.')
        return info.size > 0
      } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err }
      finally { await handle?.close() }
    })
  }
  async read(): Promise<string | null> {
    return this.bounded(async (signal) => {
      let handle: Awaited<ReturnType<typeof open>> | null = null
      try {
        handle = await open(this.file, 'r'); signal.throwIfAborted()
        const info = await handle.stat()
        if (!info.isFile() || info.size > MAX_BYTES) throw new Error('The saved Notion credential cannot be read. Replace it in connection settings.')
        const text = await handle.readFile({ encoding: 'utf8', signal })
        let raw: unknown
        try { raw = JSON.parse(text) } catch { throw new Error('The saved Notion credential is unreadable. Replace it in connection settings.') }
        if (!raw || typeof raw !== 'object' || !('schema' in raw) || raw.schema !== 1 || !('sealed' in raw) || typeof raw.sealed !== 'string' || !/^[a-z0-9+/]+={0,2}$/i.test(raw.sealed)) throw new Error('The saved Notion credential format is unavailable. Keep it for recovery or replace it.')
        this.protected(); signal.throwIfAborted()
        let plain: string | null
        try { plain = unsealedValue(REFERENCE, this.backend.decrypt(Buffer.from(raw.sealed, 'base64'))) } catch { plain = null }
        if (plain === null || !plain || plain.length > 8192 || /[\r\n\u0000]/.test(plain)) throw new Error('The saved Notion token cannot be opened with this sign-in. Replace it in connection settings.')
        return plain
      } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err }
      finally { await handle?.close() }
    })
  }
  write(token: string): Promise<void> {
    if (typeof token !== 'string' || token.length > 8192 || /[\r\n\u0000]/.test(token)) return Promise.reject(new Error('Enter a valid Notion integration token.'))
    if (this.pending >= 8) return Promise.reject(new Error('The Work credential store is busy. Wait before retrying.'))
    this.pending++
    const controller = new AbortController()
    const signal = controller.signal
    let rejectExpired: (error: Error) => void = () => {}
    const expired = new Promise<void>((_resolve, reject) => { rejectExpired = reject })
    const timer = setTimeout(() => { controller.abort(); rejectExpired(new Error('The Work credential store took too long. Check the connection before retrying.')) }, TIMEOUT_MS)
    const run = this.chain.then(async () => {
      signal.throwIfAborted()
      if (!token) { await rm(this.file, { force: true }); return }
      this.protected()
      let encrypted: Buffer
      try { encrypted = this.backend.encrypt(sealedText(REFERENCE, token)) } catch { throw new Error('The system key store could not seal the Notion token. It was not saved.') }
      signal.throwIfAborted()
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 }); signal.throwIfAborted()
      const temporary = `${this.file}.${randomUUID()}.tmp`
      let handle: Awaited<ReturnType<typeof open>> | null = null
      try {
        handle = await open(temporary, 'wx', 0o600)
        await handle.writeFile(JSON.stringify({ schema: 1, sealed: encrypted.toString('base64') }), { signal })
        await handle.sync(); await handle.close(); handle = null
        signal.throwIfAborted(); await rename(temporary, this.file)
      } finally { await handle?.close(); await rm(temporary, { force: true }) }
    }).finally(() => { clearTimeout(timer); this.pending-- })
    // A timeout cannot release an uninterruptible rename's ownership.
    this.chain = run.catch(() => {})
    return Promise.race([run, expired])
  }
}
