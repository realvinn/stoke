import { spawn } from 'node:child_process'
import { constants, type Stats } from 'node:fs'
import { lstat, open, realpath, stat, type FileHandle } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { Writable } from 'node:stream'
import type { SshHost } from '@shared/types'
// Relative with the extension: verify:ssh runs this under strip-types (gotcha 78).
import {
  MAX_FILE_BYTES,
  UPLOAD_IDLE_MS,
  fileUploadTimeoutMs,
  formatBytes,
  parseUploadPath,
  uploadExitMessage,
  uploadFailureKind,
  uploadTimeoutMs,
  type UploadFailureKind,
  type UploadNoun
} from '../shared/imageUpload.ts'
import { buildUploadArgs, sshExecutable } from './ssh.ts'

/**
 * Sending an image or a file to an SSH host: the bytes go over a SECOND ssh
 * connection, on stdin, to the `sh` body `buildUploadBody` writes (ssh.ts),
 * and the far path comes back on stdout. The tab's own connection is never
 * touched.
 *
 * No electron import, like sshSessions.ts: main reads the clipboard and the
 * thumbnail (sshImages.ts); this half takes bytes or a path and a host, so
 * verify:ssh drives it with a real `sh` standing in for ssh and real files.
 */

export interface InputRunResult {
  stdout: string
  stderr: string
  /** Null when the child was killed (a timeout, a stall, a cancel, a failed read) or never started. */
  code: number | null
  /** Why it did not run to an exit, in a sentence, or ''. */
  error: string
  /** The caller's signal ended it. */
  cancelled: boolean
}

/** What goes on the child's stdin: bytes in hand, or a file read as it is sent. */
export type UploadInput = Uint8Array | (() => AsyncIterable<Uint8Array>)

export interface InputRunOpts {
  /** The whole run, from spawn to exit. */
  timeoutMs: number
  /**
   * Give up when the child has taken no input for this long while there is
   * input left to give it (a stalled link). Off when unset.
   */
  idleMs?: number
  signal?: AbortSignal
  /** How many bytes the child's stdin has taken, after each chunk. */
  onProgress?: (sent: number) => void
}

export type InputRunner = (args: string[], input: UploadInput, opts: InputRunOpts) => Promise<InputRunResult>

/** stdout is one line and stderr a few; anything past this is noise from an rc file. */
const MAX_CAPTURE = 64 * 1024
/** One write to the child: small enough that progress moves, big enough to be cheap. */
const CHUNK = 256 * 1024

function* slices(bytes: Uint8Array): Generator<Uint8Array> {
  for (let at = 0; at < bytes.byteLength; at += CHUNK) yield bytes.subarray(at, Math.min(bytes.byteLength, at + CHUNK))
}

/** Resolves once `s` can take more, or will never take any (closed, failed). */
function drained(s: Writable): Promise<void> {
  if (s.destroyed || !s.writableNeedDrain) return Promise.resolve()
  return new Promise((resolve) => {
    const done = (): void => {
      s.off('drain', done)
      s.off('close', done)
      s.off('error', done)
      resolve()
    }
    s.on('drain', done)
    s.on('close', done)
    s.on('error', done)
  })
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/**
 * Run `exe` with `args`, `input` on stdin, never through a shell. Never
 * throws: a spawn failure, a timeout, a stall, a cancel and a failed read are
 * all results.
 *
 * What a plain `execFile` would get wrong here. The child's stdin can close
 * before all the bytes are written — ssh refusing to log in exits at once —
 * and an `EPIPE` on a stream with no error listener is an uncaught exception
 * in main, so stdin's errors are listened for and dropped (the exit code says
 * what happened), and a write waiting for room stops waiting when stdin
 * closes. A timeout is decided here, before any code is read (gotcha 25's
 * order). Cancel is the caller's AbortSignal. And the input goes in chunks,
 * each written only once the last was taken, which is what `onProgress`
 * counts and what lets a 100 MB file be read from disk as it is sent rather
 * than held whole.
 */
export function spawnWithInput(exe: string, args: string[], input: UploadInput, opts: InputRunOpts): Promise<InputRunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let stalled = false
    let cancelled = false
    let readError = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let idle: ReturnType<typeof setTimeout> | undefined
    let child: ReturnType<typeof spawn> | null = null
    const stop = (): void => {
      try {
        child?.kill('SIGTERM')
      } catch {
        /* already gone */
      }
    }
    const onAbort = (): void => {
      cancelled = true
      stop()
    }
    const disarm = (): void => {
      if (idle) clearTimeout(idle)
      idle = undefined
    }
    const arm = (): void => {
      disarm()
      if (!opts.idleMs) return
      idle = setTimeout(() => {
        stalled = true
        stop()
      }, opts.idleMs)
    }
    const finish = (r: Omit<InputRunResult, 'stdout' | 'stderr' | 'cancelled'>): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      disarm()
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ stdout, stderr, cancelled, ...r })
    }
    if (opts.signal?.aborted) {
      cancelled = true
      finish({ code: null, error: 'Cancelled.' })
      return
    }
    let proc: ReturnType<typeof spawn>
    try {
      proc = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      finish({ code: null, error: e instanceof Error ? e.message : 'ssh could not be started.' })
      return
    }
    child = proc
    timer = setTimeout(() => {
      timedOut = true
      stop()
    }, opts.timeoutMs)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (d: string) => {
      if (stdout.length < MAX_CAPTURE) stdout += d
    })
    proc.stderr?.on('data', (d: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += d
    })
    proc.stdin?.on('error', () => {
      /* EPIPE: the far end stopped reading. The exit code says why. */
    })
    proc.on('error', (e) => finish({ code: null, error: e.message || 'ssh could not be started.' }))
    proc.on('close', (code) => {
      if (cancelled) finish({ code: null, error: 'Cancelled.' })
      else if (readError) finish({ code: null, error: readError })
      else if (stalled) finish({ code: null, error: `Nothing was taken for ${Math.round((opts.idleMs ?? 0) / 1000)} s.` })
      else if (timedOut) finish({ code: null, error: `No answer within ${Math.round(opts.timeoutMs / 1000)} s.` })
      else finish({ code: typeof code === 'number' ? code : null, error: typeof code === 'number' ? '' : 'ssh was stopped.' })
    })

    const stdin = proc.stdin
    if (!stdin) return
    void (async () => {
      let sent = 0
      arm()
      try {
        const source = input instanceof Uint8Array ? slices(input) : input()
        for await (const chunk of source) {
          if (settled || stdin.destroyed || stdin.writableEnded) break
          stdin.write(chunk)
          await drained(stdin)
          if (stdin.destroyed) break
          sent += chunk.byteLength
          arm()
          opts.onProgress?.(sent)
        }
      } catch (e) {
        // The far side then sees EOF short of the size it was told, and keeps nothing.
        readError = errText(e) || 'Reading it failed.'
        stop()
      } finally {
        disarm()
        if (!stdin.destroyed && !stdin.writableEnded) stdin.end()
      }
    })()
  })
}

export const runSshWithInput: InputRunner = (args, input, opts) => spawnWithInput(sshExecutable(), args, input, opts)

export type SendImageResult =
  | { ok: true; path: string }
  | { ok: false; reason: UploadFailureKind | 'cancelled' | 'not-allowed' | 'not-file'; message: string; detail: string }

/** ssh's own last line of complaint, which is the useful one. */
function lastLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .pop() ?? ''
  )
}

export interface SendOpts {
  signal?: AbortSignal
  run?: InputRunner
  onProgress?: (sent: number) => void
}

/**
 * Send `size` bytes from `input` to `host` as `name` and return where they
 * landed.
 *
 * `name` must already be one of Stoke's own (`isSafeFarName`); the argv
 * builder refuses anything else. The failure carries ssh's own last stderr
 * line as `detail`, and is sorted only by what ssh said (`uploadFailureKind`).
 * An image keeps its two-minute limit; a file gets `fileUploadTimeoutMs` and
 * the stall limit, since it may be a hundred times bigger.
 */
export async function sendUpload(
  host: SshHost,
  name: string,
  up: { noun: UploadNoun; size: number; input: UploadInput },
  opts: SendOpts = {}
): Promise<SendImageResult> {
  const { noun, size } = up
  const args = buildUploadArgs(host, name, size)
  if (!args) {
    return { ok: false, reason: 'not-allowed', message: 'Stoke will not hand this alias or file name to ssh as it is.', detail: '' }
  }
  const run = opts.run ?? runSshWithInput
  const limits = noun === 'file' ? { timeoutMs: fileUploadTimeoutMs(size), idleMs: UPLOAD_IDLE_MS } : { timeoutMs: uploadTimeoutMs(size) }
  const r = await run(args, up.input, { ...limits, signal: opts.signal, onProgress: opts.onProgress })
  if (r.cancelled) return { ok: false, reason: 'cancelled', message: 'Cancelled.', detail: '' }
  if (r.code === 0) {
    const path = parseUploadPath(r.stdout, name)
    if (path) return { ok: true, path }
    return {
      ok: false,
      reason: 'failed',
      message: `The machine did not say where it saved the ${noun}.`,
      detail: lastLine(r.stderr)
    }
  }
  const detail = r.error || lastLine(r.stderr) || (r.code !== null ? `ssh exited with ${r.code}.` : '')
  const kind = r.code === null ? 'failed' : uploadFailureKind(r.code, r.stderr)
  const message =
    kind === 'needs-login'
      ? `Stoke sends ${noun}s over a second connection, which cannot type a password.`
      : kind === 'unreachable'
        ? 'The machine could not be reached.'
        : (uploadExitMessage(r.code, noun) ?? `The ${noun} was not sent.`)
  return { ok: false, reason: kind, message, detail }
}

/** An image held in main as bytes: `sendUpload` with its rules. */
export function sendImage(
  host: SshHost,
  name: string,
  bytes: Uint8Array,
  opts: SendOpts = {}
): Promise<SendImageResult> {
  return sendUpload(host, name, { noun: 'image', size: bytes.byteLength, input: bytes }, opts)
}

/* ------------------------------------------------------------- a file on disk */

/*
 * A dropped or pasted file is read HERE, from the path the preload took off
 * the File (`webUtils.getPathForFile`) or main took off the clipboard — never
 * from a path the renderer wrote. Two checks, because a path is checked once
 * and read later:
 *
 * - `inspectUploadFile`, when it is dropped: through every link to what it
 *   names (`realpath`), and only a regular file within `MAX_FILE_BYTES`. A
 *   folder, a device, a pipe, a socket and a link to nothing each get a
 *   sentence; nothing is tarred or walked.
 * - `openUploadFile`, when its turn to send comes: the resolved path opened
 *   with `O_NOFOLLOW` (a link swapped in since is refused) and `O_NONBLOCK`
 *   (a pipe swapped in cannot hang main on its open), then the size and type
 *   from `fstat` of THAT descriptor, which is what is read. A file that grows
 *   meanwhile is sent as it was at that moment (a growing log: the first
 *   `size` bytes); one that shrinks is stopped and the far side keeps nothing.
 */

export type FileCheck =
  | { ok: true; path: string; size: number }
  | { ok: false; reason: 'not-file' | 'too-large'; message: string }

/** What `label` is when it is not a regular file, in a sentence, or null when it is one. */
export function notRegularFile(label: string, st: Stats): string | null {
  if (st.isFile()) return null
  if (st.isDirectory()) return `${label} is a folder. Stoke sends files, not folders: drop the files inside it, or zip it first.`
  if (st.isCharacterDevice() || st.isBlockDevice()) return `${label} is a device, not a file.`
  if (st.isFIFO()) return `${label} is a pipe, not a file.`
  if (st.isSocket()) return `${label} is a socket, not a file.`
  return `${label} is not a regular file.`
}

function readFailure(label: string, e: unknown): string {
  const code = (e as { code?: unknown })?.code
  if (code === 'ENOENT' || code === 'ENOTDIR') return `${label} is no longer there.`
  if (code === 'EACCES' || code === 'EPERM') return `${label} could not be read: permission denied.`
  if (code === 'ELOOP') return `${label} changed since it was dropped. Drop it again.`
  if (code === 'EISDIR') return `${label} is a folder. Stoke sends files, not folders: drop the files inside it, or zip it first.`
  return `${label} could not be read (${typeof code === 'string' ? code : errText(e)}).`
}

const tooLarge = (label: string, size: number): string =>
  `${label} is ${formatBytes(size)}; Stoke sends files up to ${formatBytes(MAX_FILE_BYTES)}. Copy it with scp instead.`

/**
 * Whether `path` may be sent, and what it really is: the path every link
 * resolves to and its size. `label` is the name the user knows it by, for the
 * sentence.
 */
export async function inspectUploadFile(path: unknown, label: string): Promise<FileCheck> {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\u0000') || !isAbsolute(path)) {
    return { ok: false, reason: 'not-file', message: `${label} is not a file on this computer.` }
  }
  let real: string
  try {
    real = await realpath(path)
  } catch (e) {
    const code = (e as { code?: unknown })?.code
    // A link whose target is gone: lstat still finds the link itself.
    const link = code === 'ENOENT' ? await lstat(path).then((s) => s.isSymbolicLink(), () => false) : false
    return { ok: false, reason: 'not-file', message: link ? `${label} is a link to something that is not there.` : readFailure(label, e) }
  }
  let st: Stats
  try {
    st = await stat(real)
  } catch (e) {
    return { ok: false, reason: 'not-file', message: readFailure(label, e) }
  }
  const odd = notRegularFile(label, st)
  if (odd) return { ok: false, reason: 'not-file', message: odd }
  if (st.size > MAX_FILE_BYTES) return { ok: false, reason: 'too-large', message: tooLarge(label, st.size) }
  return { ok: true, path: real, size: st.size }
}

export type OpenedUpload =
  | { ok: true; size: number; input: () => AsyncIterable<Uint8Array>; close: () => Promise<void> }
  | { ok: false; message: string }

async function* exactly(src: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, size: number, label: string): AsyncGenerator<Uint8Array> {
  let n = 0
  for await (const chunk of src) {
    n += chunk.byteLength
    yield chunk
  }
  if (n < size) throw new Error(`${label} got shorter while it was being sent.`)
}

/** Open a path `inspectUploadFile` resolved, for one send. The caller closes it. */
export async function openUploadFile(path: string, label: string): Promise<OpenedUpload> {
  // Absent on Windows, where neither a FIFO nor this kind of swap applies.
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  let fh: FileHandle
  try {
    fh = await open(path, flags)
  } catch (e) {
    return { ok: false, message: readFailure(label, e) }
  }
  const close = (): Promise<void> => fh.close().catch(() => {})
  try {
    const st = await fh.stat()
    const odd = notRegularFile(label, st)
    if (odd) {
      await close()
      return { ok: false, message: odd }
    }
    if (st.size > MAX_FILE_BYTES) {
      await close()
      return { ok: false, message: tooLarge(label, st.size) }
    }
    const size = st.size
    const input = (): AsyncIterable<Uint8Array> =>
      size === 0
        ? exactly([], 0, label)
        : exactly(fh.createReadStream({ start: 0, end: size - 1, highWaterMark: CHUNK, autoClose: false }), size, label)
    return { ok: true, size, input, close }
  } catch (e) {
    await close()
    return { ok: false, message: readFailure(label, e) }
  }
}

/**
 * Send the file at `path` (a path `inspectUploadFile` resolved) as `name`.
 * A file that cannot be opened now is a sentence (`not-file`), never a Try
 * again, which would only meet the same thing; the rest of its drop goes on.
 */
export async function sendFile(
  host: SshHost,
  name: string,
  path: string,
  label: string,
  opts: SendOpts = {}
): Promise<SendImageResult> {
  const f = await openUploadFile(path, label)
  if (!f.ok) return { ok: false, reason: 'not-file', message: f.message, detail: '' }
  try {
    return await sendUpload(host, name, { noun: 'file', size: f.size, input: f.input }, opts)
  } finally {
    await f.close()
  }
}
