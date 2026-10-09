import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdtemp, open, rm, type FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SshHost } from '../shared/types.ts'
import { MAX_FILE_BYTES, phoneRelativePath, phoneFileSize, sshDownloadFolder, type PhoneFileListing } from '../shared/remoteFiles.ts'
import { buildUploadArgs, sshChildEnv, sshExecutable } from './ssh.ts'
import { SSH_FILE_READER } from './sshFileReader.ts'

export class SshFileError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
function fail(status: number, message: string): never { throw new SshFileError(status, message) }
// 200 paths of 2,048 UTF-16 units, escaped by Python's ASCII JSON encoder.
const MAX_HEADER = 4 * 1024 * 1024
export interface SshFileDownload { file: FileHandle; size: number; name: string; dispose: () => Promise<void> }
type Start = (args: string[]) => ChildProcessWithoutNullStreams
interface Options { start?: Start; tempRoot?: string; timeoutMs?: number; idleMs?: number }
export interface SshFileProgress { received: number; size: number }

/** Static, base64-encoded source is the only shell argument; paths are JSON on stdin.
 * Reuse the file-copy SSH options (no PTY, forwarding or LocalCommand).
 * https://man.openbsd.org/ssh.1 */
export function sshFileArgs(host: SshHost): string[] | null {
  const args = buildUploadArgs(host, 'unused.txt', 0)
  if (!args) return null
  args[args.length - 1] = `python3 -I -c "import base64;exec(base64.b64decode('${Buffer.from(SSH_FILE_READER).toString('base64')}'))"`
  return args
}

function headerOf(bytes: Buffer): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail(502, 'The SSH file reply could not be verified. Keep login-shell output off this connection and retry.') }
  if (!value || typeof value !== 'object' || (value as Record<string, unknown>).protocol !== 'stoke-files-1') fail(502, 'The SSH file reply could not be verified.')
  const header = value as Record<string, unknown>
  if (typeof header.error === 'string') {
    const errors: Record<string, [number, string]> = {
      'unsupported': [400, 'SSH downloads need a macOS or Linux host with Python 3.'],
      'invalid': [400, 'Choose a relative path inside the configured download folder.'],
      'not-found': [404, 'That remote file or folder could not be found.'],
      'denied': [403, 'The remote path is denied or contains a symbolic link. Choose a regular file inside the download folder.'],
      'not-file': [400, 'Choose a regular file. Zip folders before downloading them.'],
      'too-large': [413, 'This file exceeds the 100 MB download limit.']
    }
    const [status, message] = errors[header.error] ?? [502, 'The remote file could not be read. Check its permissions and retry.']
    fail(status, message)
  }
  return header
}
function listingOf(header: Record<string, unknown>, path: string): PhoneFileListing {
  if (header.path !== path || !Array.isArray(header.entries) || header.entries.length > 200 || typeof header.truncated !== 'boolean') fail(502, 'The remote folder listing could not be verified.')
  const names = new Set<string>()
  for (const entry of header.entries) {
    if (!entry || typeof entry !== 'object' || typeof entry.name !== 'string' || entry.name.startsWith('.') || entry.name.length > 255 || !phoneRelativePath(entry.name) || entry.name.includes('/') || names.has(entry.name) || entry.path !== (path ? `${path}/${entry.name}` : entry.name) || !phoneRelativePath(entry.path) || !['file', 'folder'].includes(entry.kind) || (entry.kind === 'folder' ? entry.size !== null : !Number.isSafeInteger(entry.size) || entry.size < 0)) fail(502, 'The remote folder listing could not be verified.')
    names.add(entry.name)
  }
  return { path, entries: header.entries as PhoneFileListing['entries'], truncated: header.truncated }
}

/** A completed download is spooled privately before it is offered to a browser
 * or save dialog. A partial SSH stream or unsuccessful exit is never a file.
 * The caller holds its transfer claim through dispose and actual child close. */
export class SshFiles {
  private options: Options
  constructor(options: Options = {}) { this.options = options }
  async list(host: SshHost, path: unknown, signal: AbortSignal): Promise<PhoneFileListing> {
    const result = await this.run(host, 'list', path, signal)
    return listingOf(result.header, path as string)
  }
  async download(host: SshHost, path: unknown, signal: AbortSignal, progress?: (value: SshFileProgress) => void): Promise<SshFileDownload> {
    const result = await this.run(host, 'download', path, signal, progress)
    if (!result.download) fail(502, 'The remote file did not finish downloading.')
    return result.download
  }
  private async run(host: SshHost, operation: 'list' | 'download', path: unknown, signal: AbortSignal, progress?: (value: SshFileProgress) => void): Promise<{ header: Record<string, unknown>; download?: SshFileDownload }> {
    const root = sshDownloadFolder(host.downloadFolder)
    if (!root) fail(403, 'SSH downloads are off. Set a download folder for this host in Stoke’s SSH settings.')
    if (!phoneRelativePath(path) || (operation === 'download' && !path)) fail(400, 'Choose a relative path inside the configured download folder.')
    const args = sshFileArgs(host)
    if (!args) fail(400, 'This SSH host has no usable alias. Check its settings.')
    let folder: string | null = null
    let file: FileHandle | null = null
    let child: ChildProcessWithoutNullStreams | null = null
    let close: Promise<number | null> | null = null
    let exited = false
    let reason = ''
    let spawnError = false
    let force: ReturnType<typeof setTimeout> | undefined
    let idle: ReturnType<typeof setTimeout> | undefined
    let kept = false
    const stop = (message: string): void => {
      reason ||= message
      if (!child || exited) return
      child.kill('SIGTERM')
      force ??= setTimeout(() => { if (!exited) child?.kill('SIGKILL') }, 2000)
    }
    const abort = (): void => stop('The SSH transfer was cancelled. Retry when ready.')
    const check = (): void => { if (signal.aborted) abort(); if (reason) fail(signal.aborted ? 408 : 504, reason) }
    const armIdle = (): void => {
      clearTimeout(idle)
      idle = setTimeout(() => stop('The SSH connection stopped sending bytes. Reconnect and retry.'), this.options.idleMs ?? 60_000)
    }
    const timer = setTimeout(() => stop('The SSH file operation timed out. Reconnect and retry.'), this.options.timeoutMs ?? 180_000)
    signal.addEventListener('abort', abort, { once: true })
    try {
      check()
      if (operation === 'download') {
        folder = await mkdtemp(join(this.options.tempRoot ?? tmpdir(), 'stoke-ssh-download-'))
        check()
        file = await open(join(folder, 'file.part'), 'wx+', 0o600)
        check()
      }
      child = this.options.start ? this.options.start(args) : spawn(sshExecutable(), args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: sshChildEnv() })
      const proc = child
      close = new Promise((resolve) => {
        proc.once('error', () => { spawnError = true })
        proc.once('close', (code) => { exited = true; clearTimeout(force); resolve(code) })
      })
      proc.stdin.on('error', () => {})
      // Do not expose stderr: ssh/login diagnostics can contain private paths.
      proc.stderr.resume()
      proc.stdin.end(JSON.stringify({ root, path, operation }))
      armIdle()
      let pending = Buffer.alloc(0)
      let header: Record<string, unknown> | null = null
      let received = 0
      for await (const value of proc.stdout) {
        check(); armIdle()
        let chunk = Buffer.from(value as Uint8Array)
        if (!header) {
          const joined = Buffer.concat([pending, chunk])
          const newline = joined.indexOf(10)
          if ((newline < 0 ? joined.length : newline) > MAX_HEADER) fail(502, 'The remote file reply exceeded its limit.')
          if (newline < 0) { pending = joined; continue }
          header = headerOf(joined.subarray(0, newline))
          if (operation === 'download' && !phoneFileSize(header.size)) fail(502, 'The remote file size could not be verified.')
          if (operation === 'download') progress?.({ received: 0, size: header.size as number })
          chunk = joined.subarray(newline + 1)
          pending = Buffer.alloc(0)
        }
        received += chunk.length
        if (operation === 'list' && received) fail(502, 'The remote folder reply contained unexpected bytes.')
        if (operation === 'download') {
          if (received > (header.size as number) || received > MAX_FILE_BYTES) fail(502, 'The remote file exceeded its declared size.')
          let offset = 0
          while (offset < chunk.length) {
            check()
            const written = await file!.write(chunk, offset, chunk.length - offset)
            if (!written.bytesWritten) fail(500, 'The download could not be saved. Check available disk space.')
            offset += written.bytesWritten
          }
          progress?.({ received, size: header.size as number })
        }
      }
      const code = await close
      check()
      if (spawnError || code !== 0 || !header) fail(502, 'The SSH file operation did not complete. Check key login, Python 3 and the connection, then retry.')
      if (operation === 'list') return { header }
      if (received !== header.size) fail(502, 'The SSH download stopped before all its bytes arrived. Retry the file.')
      await file!.close(); file = null
      check()
      file = await open(join(folder!, 'file.part'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0))
      check()
      const ownedFile = file!
      const ownedFolder = folder!
      kept = true
      return { header, download: { file: ownedFile, size: received, name: path.split('/').at(-1)!, dispose: async () => {
        await ownedFile.close().catch(() => {})
        await rm(ownedFolder, { recursive: true, force: true })
      } } }
    } catch (error) {
      if (error instanceof SshFileError) throw error
      check()
      return fail(502, 'The SSH file operation failed. Check the connection and available disk space, then retry.')
    } finally {
      if (child && !exited) { stop('The SSH file operation ended.'); child.stdout.destroy(); await close }
      clearTimeout(timer); clearTimeout(idle); clearTimeout(force)
      signal.removeEventListener('abort', abort)
      if (!kept) { await file?.close().catch(() => {}); if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {}) }
    }
  }
}
