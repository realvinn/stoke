import { spawn } from 'node:child_process'
import type { SshHost } from '@shared/types'
// Relative with the extension: verify:ssh runs this under strip-types (gotcha 78).
import {
  parseUploadPath,
  uploadExitMessage,
  uploadFailureKind,
  uploadTimeoutMs,
  type UploadFailureKind
} from '../shared/imageUpload.ts'
import { buildUploadArgs, sshExecutable } from './ssh.ts'

/**
 * Sending an image to an SSH host: the bytes go over a SECOND ssh connection,
 * on stdin, to the `sh` body `buildUploadBody` writes (ssh.ts), and the far
 * path comes back on stdout. The tab's own connection is never touched.
 *
 * No electron import, like sshSessions.ts: main reads the clipboard and the
 * thumbnail (index.ts); this half takes bytes and a host, so verify:ssh drives
 * it with a real `sh` standing in for ssh.
 */

export interface InputRunResult {
  stdout: string
  stderr: string
  /** Null when the child was killed (a timeout or a cancel) or never started. */
  code: number | null
  /** Why it did not run to an exit, in a sentence, or ''. */
  error: string
  /** The caller's signal ended it. */
  cancelled: boolean
}

export type InputRunner = (
  args: string[],
  input: Uint8Array,
  opts: { timeoutMs: number; signal?: AbortSignal }
) => Promise<InputRunResult>

/** stdout is one line and stderr a few; anything past this is noise from an rc file. */
const MAX_CAPTURE = 64 * 1024

/**
 * Run `exe` with `args`, `input` on stdin, never through a shell. Never
 * throws: a spawn failure, a timeout and a cancel are all results.
 *
 * Three things a plain `execFile` would get wrong here. The child's stdin can
 * close before all the bytes are written — ssh refusing to log in exits at
 * once — and an `EPIPE` on a stream with no error listener is an uncaught
 * exception in main, so stdin's errors are listened for and dropped (the exit
 * code says what happened). A timeout is decided here, before any code is
 * read (gotcha 25's order). And Cancel is the caller's AbortSignal.
 */
export function spawnWithInput(
  exe: string,
  args: string[],
  input: Uint8Array,
  opts: { timeoutMs: number; signal?: AbortSignal }
): Promise<InputRunResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let cancelled = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
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
    const finish = (r: Omit<InputRunResult, 'stdout' | 'stderr' | 'cancelled'>): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
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
      else if (timedOut) finish({ code: null, error: `No answer within ${Math.round(opts.timeoutMs / 1000)} s.` })
      else finish({ code: typeof code === 'number' ? code : null, error: typeof code === 'number' ? '' : 'ssh was stopped.' })
    })
    proc.stdin?.end(Buffer.from(input.buffer, input.byteOffset, input.byteLength))
  })
}

export const runSshWithInput: InputRunner = (args, input, opts) => spawnWithInput(sshExecutable(), args, input, opts)

export type SendImageResult =
  | { ok: true; path: string }
  | { ok: false; reason: UploadFailureKind | 'cancelled' | 'not-allowed'; message: string; detail: string }

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

/**
 * Send `bytes` to `host` as `name` and return where they landed.
 *
 * `name` must already be one of Stoke's own (`isSafeUploadName`); the argv
 * builder refuses anything else. The failure carries ssh's own last stderr
 * line as `detail`, and is sorted only by what ssh said (`uploadFailureKind`).
 */
export async function sendImage(
  host: SshHost,
  name: string,
  bytes: Uint8Array,
  opts: { signal?: AbortSignal; run?: InputRunner } = {}
): Promise<SendImageResult> {
  const args = buildUploadArgs(host, name, bytes.byteLength)
  if (!args) {
    return { ok: false, reason: 'not-allowed', message: 'Stoke will not hand this alias or file name to ssh as it is.', detail: '' }
  }
  const run = opts.run ?? runSshWithInput
  const r = await run(args, bytes, { timeoutMs: uploadTimeoutMs(bytes.byteLength), signal: opts.signal })
  if (r.cancelled) return { ok: false, reason: 'cancelled', message: 'Cancelled.', detail: '' }
  if (r.code === 0) {
    const path = parseUploadPath(r.stdout, name)
    if (path) return { ok: true, path }
    return {
      ok: false,
      reason: 'failed',
      message: 'The machine did not say where it saved the image.',
      detail: lastLine(r.stderr)
    }
  }
  const detail = r.error || lastLine(r.stderr) || (r.code !== null ? `ssh exited with ${r.code}.` : '')
  const kind = r.code === null ? 'failed' : uploadFailureKind(r.code, r.stderr)
  const message =
    kind === 'needs-login'
      ? 'Stoke sends images over a second connection, which cannot type a password.'
      : kind === 'unreachable'
        ? 'The machine could not be reached.'
        : (uploadExitMessage(r.code) ?? 'The image was not sent.')
  return { ok: false, reason: kind, message, detail }
}
