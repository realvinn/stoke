import { randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdtemp, open, opendir, realpath, rename, rm, type FileHandle } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { basename, isAbsolute, join, relative, sep } from 'node:path'
import type { SshHost } from '../../shared/types.ts'
import { droppedFileName } from '../../shared/imageUpload.ts'
import { MAX_FILE_BYTES, phoneFileNameProblem, phoneFileSize, phoneRelativePath, type PhoneFileListing, type PhoneFileSent } from '../../shared/remoteFiles.ts'
import { sendUpload, type SendOpts, type SendImageResult, type UploadInput } from '../sshUpload.ts'
import { SshFiles, SshFileError } from '../sshFiles.ts'

export interface PhoneFileTarget { cwd: string; host: SshHost | null }
export class PhoneFileError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
function fail(status: number, message: string): never { throw new PhoneFileError(status, message) }
const cancelled = (signal: AbortSignal): void => { if (signal.aborted) fail(408, 'The transfer was cancelled or timed out. Retry to send the file again.') }
async function disk<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PhoneFileError(504, 'The folder did not respond in time. Check its disk and retry.')), 5000) })]) }
  finally { clearTimeout(timer) }
}
function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`))
}
async function confined(cwd: string, path: string): Promise<{ root: string; path: string }> {
  if (!phoneRelativePath(path)) fail(400, 'Choose a path inside this session’s working folder.')
  try {
    const root = await disk(realpath(cwd))
    const found = await disk(realpath(join(root, path)))
    if (!inside(root, found)) fail(403, 'That path leaves this session’s working folder.')
    return { root, path: found }
  } catch (error) {
    if (error instanceof PhoneFileError) throw error
    return fail(404, 'That file or folder could not be found.')
  }
}

/** Bytes stay a stream, with an exact size and cancellation checked between chunks. */
export async function* exactPhoneFile(input: AsyncIterable<Uint8Array>, size: number, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let read = 0
  for await (const chunk of input) {
    cancelled(signal)
    read += chunk.byteLength
    if (read > size || read > MAX_FILE_BYTES) fail(413, 'The file exceeded its declared size or the 100 MB limit.')
    yield chunk
  }
  cancelled(signal)
  if (read !== size) fail(400, 'The file stopped before all its bytes arrived. Retry the transfer.')
}

type Send = (host: SshHost, name: string, up: { noun: 'file'; size: number; input: UploadInput }, opts: SendOpts) => Promise<SendImageResult>
export class PhoneFiles {
  private jobs = new Map<string, object>()
  private ssh: SshFiles
  constructor(ssh = new SshFiles()) { this.ssh = ssh }
  /** Global and per-session limits are claimed before any disk or SSH await. */
  claim(id: string): () => void {
    if (this.jobs.has(id) || this.jobs.size >= 2) fail(409, 'Another file operation is running. Wait for it to finish, then retry.')
    const mine = {}
    this.jobs.set(id, mine)
    return () => { if (this.jobs.get(id) === mine) this.jobs.delete(id) }
  }
  async upload(target: PhoneFileTarget, name: unknown, size: unknown, input: AsyncIterable<Uint8Array>, signal: AbortSignal, send: Send = sendUpload): Promise<PhoneFileSent> {
    const problem = phoneFileNameProblem(name)
    if (problem) fail(400, problem)
    if (!phoneFileSize(size)) fail(413, 'Choose a file of 100 MB or less.')
    const safeName = droppedFileName(name as string, randomBytes(3).toString('hex'))
    const bytes = exactPhoneFile(input, size, signal)
    if (target.host) {
      if (target.host.noUploads) fail(403, 'File sending is disabled for this SSH host in Stoke’s settings.')
      const sent = await send(target.host, safeName, { noun: 'file', size, input: () => bytes }, { signal })
      cancelled(signal)
      if (!sent.ok) fail(502, sent.message)
      return { path: sent.path, name: safeName, size, destination: 'ssh' }
    }
    let folder: string | null = null
    let fd: FileHandle | null = null
    let completed = false
    try {
      const root = await disk(realpath(target.cwd))
      cancelled(signal)
      // A unique owner-only folder avoids overwriting any project file.
      folder = await mkdtemp(join(root, '.stoke-upload-'))
      cancelled(signal)
      fd = await open(join(folder, `${safeName}.part`), 'wx', 0o600)
      for await (const chunk of bytes) {
        let offset = 0
        while (offset < chunk.byteLength) {
          cancelled(signal)
          const written = await fd.write(chunk, offset, chunk.byteLength - offset)
          if (!written.bytesWritten) fail(500, 'The file could not be written. Check available disk space.')
          offset += written.bytesWritten
        }
      }
      await fd.close(); fd = null
      cancelled(signal)
      const canonicalFolder = await disk(realpath(folder))
      if (!inside(root, canonicalFolder)) fail(403, 'The destination changed during the transfer. Retry in a stable folder.')
      const path = join(canonicalFolder, safeName)
      await rename(join(folder, `${safeName}.part`), path)
      cancelled(signal)
      completed = true
      return { path, name: safeName, size, destination: 'local' }
    } finally {
      await fd?.close().catch(() => {})
      if (folder && !completed) await rm(folder, { recursive: true, force: true }).catch(() => {})
    }
  }
  async list(target: PhoneFileTarget, path: unknown, signal = new AbortController().signal): Promise<PhoneFileListing> {
    if (target.host) return this.ssh.list(target.host, path, signal).catch(sshError)
    if (!phoneRelativePath(path)) fail(400, 'Choose a relative folder path.')
    const folder = await confined(target.cwd, path)
    const items: Dirent[] = []
    const dir = await opendir(folder.path)
    let scanned = 0
    let truncated = false
    try {
      for await (const item of dir) {
        scanned++
        if (!item.name.startsWith('.') && !item.isSymbolicLink() && (item.isFile() || item.isDirectory()) && phoneRelativePath(path ? `${path}/${item.name}` : item.name)) items.push(item)
        if (items.length > 200 || scanned >= 2000) { truncated = true; break }
      }
    } finally { await dir.close().catch(() => {}) }
    const visible = items.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
    const entries = await Promise.all(visible.slice(0, 200).map(async (item) => {
      const size = item.isFile() ? await disk(lstat(join(folder.path, item.name))).then((st) => st.size, () => null) : null
      return { name: item.name, path: path ? `${path}/${item.name}` : item.name, kind: item.isDirectory() ? 'folder' as const : 'file' as const, size }
    }))
    return { path, entries, truncated }
  }
  async download(target: PhoneFileTarget, path: unknown, signal = new AbortController().signal): Promise<{ file: FileHandle; size: number; name: string; dispose: () => Promise<void> }> {
    if (target.host) return this.ssh.download(target.host, path, signal).catch(sshError)
    if (!phoneRelativePath(path) || !path) fail(400, 'Choose one file inside the working folder.')
    const found = await confined(target.cwd, path)
    let file: FileHandle | null = null
    try {
      file = await open(found.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      const st = await file.stat()
      if (!st.isFile()) fail(400, 'Choose a regular file. Zip folders before downloading them.')
      if (!phoneFileSize(st.size)) fail(413, 'This file exceeds the 100 MB download limit.')
      const again = await confined(target.cwd, path)
      const now = await lstat(again.path)
      if (again.path !== found.path || now.ino !== st.ino || now.dev !== st.dev) fail(409, 'The file changed while opening it. Choose it again.')
      const owned = file
      return { file, size: st.size, name: basename(found.path), dispose: () => owned.close().catch(() => {}) }
    } catch (error) { await file?.close().catch(() => {}); throw error }
  }
}

function sshError(error: unknown): never {
  if (error instanceof SshFileError) throw new PhoneFileError(error.status, error.message)
  throw error
}
