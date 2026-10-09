import { mkdtemp, rename, rm } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { SshHost } from '../shared/types.ts'
import { phoneRelativePath, sshDownloadFolder } from '../shared/remoteFiles.ts'
import type { SshFilesListResult, SshFilesProgress, SshFilesRequest, SshFilesSaveResult } from '../shared/sshFiles.ts'
import { SshFiles, SshFileError } from './sshFiles.ts'

interface Deps {
  hosts: () => readonly SshHost[]
  /** Only a native save dialog may name the local destination. */
  chooseSave: (name: string, host: SshHost) => Promise<string | null>
  progress: (event: SshFilesProgress) => void
  reader?: SshFiles
}
interface Job { abort: AbortController; host: SshHost }

/** Desktop and phone use the same remote reader. Desktop saving is separately
 * owned: claim before the picker, keep it through child close and temp cleanup. */
export class DesktopSshFiles {
  private deps: Deps
  private reader: SshFiles
  private jobs = new Map<string, Job>()
  constructor(deps: Deps) { this.deps = deps; this.reader = deps.reader ?? new SshFiles() }
  cancel(requestId: unknown): void { if (typeof requestId === 'string') this.jobs.get(requestId)?.abort.abort() }
  cancelAll(): void { for (const job of this.jobs.values()) job.abort.abort() }
  list(request: unknown): Promise<SshFilesListResult> {
    return this.run(request, async (input, job) => {
      const listing = await this.reader.list(job.host, input.path, job.abort.signal)
      this.check(job)
      return { ok: true as const, listing }
    })
  }
  save(request: unknown): Promise<SshFilesSaveResult> {
    return this.run(request, async (input, job) => {
      if (!input.path) throw new SshFileError(400, 'Choose a regular file to download.')
      const destination = await this.deps.chooseSave(input.path.split('/').at(-1)!, job.host)
      this.check(job)
      if (!destination) return { ok: true as const, saved: false }
      const opened = await this.reader.download(job.host, input.path, job.abort.signal, (p) => this.deps.progress({ requestId: input.requestId, ...p }))
      let folder: string | null = null
      try {
        this.check(job)
        // Same-volume rename makes the chosen destination complete in one
        // step. Cancellation never truncates a file the user already had.
        folder = await mkdtemp(join(dirname(destination), '.stoke-download-'))
        this.check(job)
        const partial = join(folder, 'file.part')
        const input = opened.size ? opened.file.createReadStream({ start: 0, end: opened.size - 1, autoClose: true }) : Readable.from([])
        await pipeline(input, createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal: job.abort.signal })
        this.check(job)
        await rename(partial, destination)
        // The completed rename is the commit. A cancel after this point does
        // not undo a successful save or claim that the destination is partial.
        return { ok: true as const, saved: true }
      } finally {
        await opened.dispose()
        if (folder) await rm(folder, { recursive: true, force: true })
      }
    })
  }
  private check(job: Job): void {
    const current = this.deps.hosts().find((h) => h.id === job.host.id)
    if (!current || current.alias !== job.host.alias || sshDownloadFolder(current.downloadFolder) !== sshDownloadFolder(job.host.downloadFolder)) job.abort.abort()
    if (job.abort.signal.aborted) throw new SshFileError(408, 'The download was cancelled or its host permission changed. Retry when ready.')
  }
  private async run<T extends { ok: true }>(request: unknown, work: (input: SshFilesRequest, job: Job) => Promise<T>): Promise<T | { ok: false; message: string }> {
    if (!request || typeof request !== 'object') return { ok: false, message: 'Choose a configured SSH host.' }
    const supplied = request as SshFilesRequest
    const input = { requestId: supplied.requestId, hostId: supplied.hostId, path: supplied.path }
    if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(input.requestId) || typeof input.hostId !== 'string' || input.hostId.length > 200 || !phoneRelativePath(input.path)) return { ok: false, message: 'Choose a relative path inside a configured SSH folder.' }
    const host = this.deps.hosts().find((h) => h.id === input.hostId)
    if (!host || !sshDownloadFolder(host.downloadFolder)) return { ok: false, message: 'Set a download folder for this host in Stoke’s SSH settings first.' }
    if (this.jobs.has(input.requestId) || this.jobs.size >= 2 || [...this.jobs.values()].some((j) => j.host.id === host.id)) return { ok: false, message: 'Another file operation is running. Wait for it to finish, then retry.' }
    const job: Job = { abort: new AbortController(), host: { ...host } }
    this.jobs.set(input.requestId, job)
    const watch = setInterval(() => { try { this.check(job) } catch { job.abort.abort() } }, 100)
    try { this.check(job); return await work(input, job) }
    catch (error) { return { ok: false, message: error instanceof SshFileError ? error.message : `The file could not be saved. Check the connection and destination, then retry.` } }
    finally { clearInterval(watch); if (this.jobs.get(input.requestId) === job) this.jobs.delete(input.requestId) }
  }
}
