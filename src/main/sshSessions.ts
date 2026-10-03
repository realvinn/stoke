import { execFile } from 'node:child_process'
import type { RemoteSessionList, SshHost } from '@shared/types'
import {
  buildRemoteSessionKillArgs,
  buildRemoteSessionListArgs,
  parseRemoteSessionList,
  sshChildEnv,
  sshExecutable
} from './ssh.ts'

/**
 * Asking a host about its Stoke-managed sessions, and ending one.
 *
 * Both are one-shot BatchMode ssh calls (`buildRemoteSessionListArgs`,
 * `buildRemoteSessionKillArgs`): a host that wants a password answers in
 * seconds with "cannot say", never with a prompt nobody will see, and a host
 * that is asleep costs `TIMEOUT_MS` at most. Neither ever throws — the
 * launcher's list and the close dialog each have a sentence for failure.
 *
 * No electron import, like ssh.ts, so a suite can drive it with a fake `run`.
 */

/** ConnectTimeout is 10 s inside the argv; this bounds the whole round trip. */
const TIMEOUT_MS = 20_000

/** A list of sessions is a few hundred bytes; this only has to beat execFile's 1 MB default (gotcha 13). */
const MAX_BUFFER = 4 * 1024 * 1024

export interface RunResult {
  stdout: string
  stderr: string
  /** Null when the child was killed (a timeout) or never started. */
  code: number | null
  /** Why it did not run to an exit, in a sentence, or ''. */
  error: string
}

export type SshRunner = (args: string[]) => Promise<RunResult>

/**
 * Run ssh with an argv, never through a shell: the remote command carries `#`,
 * `"` and tabs that are for the far machine's `sh`, and nothing local may read
 * them. `killed` is tested before any numeric code (gotcha 25): a timeout is
 * `killed: true, code: null`. `sshChildEnv`, or a Stoke started inside a
 * Windows ssh login hands ssh.exe a stdio description that hangs it (gotcha 153).
 */
export const runSsh: SshRunner = (args) =>
  new Promise((resolve) => {
    execFile(
      sshExecutable(),
      args,
      { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true, env: sshChildEnv() },
      (err, stdout, stderr) => {
        if (!err) {
          resolve({ stdout, stderr, code: 0, error: '' })
          return
        }
        const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: string | number }
        if (e.killed) {
          resolve({ stdout, stderr, code: null, error: `No answer within ${Math.round(TIMEOUT_MS / 1000)} s.` })
          return
        }
        if (typeof e.code === 'number') {
          resolve({ stdout, stderr, code: e.code, error: '' })
          return
        }
        resolve({ stdout, stderr, code: null, error: e.message || 'ssh could not be started.' })
      }
    )
  })

/** ssh's own last line of complaint, which is the useful one ("Permission denied (publickey…)"). */
function sshReason(r: RunResult): string {
  if (r.error) return r.error
  const line = r.stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .pop()
  return line || `ssh exited with ${r.code}.`
}

/**
 * The managed sessions running on `host`, newest first.
 *
 * Exit 0 with nothing printed is "none running" — the remote side swallows a
 * missing tmux and an empty server (`2>/dev/null; true`). Exit 255 is ssh's
 * own failure: unreachable, or BatchMode refusing to ask for a password, which
 * on a host with no key is every time.
 */
export async function listRemoteSessions(host: SshHost, run: SshRunner = runSsh): Promise<RemoteSessionList> {
  const args = buildRemoteSessionListArgs(host)
  if (!args) return { ok: false, message: 'Stoke will not hand this alias to ssh as it is.' }
  const r = await run(args)
  if (r.code !== 0) return { ok: false, message: sshReason(r) }
  return { ok: true, sessions: parseRemoteSessionList(r.stdout) }
}

/**
 * End one managed session. A session that has already gone (tmux: "can't find
 * session") is a success: what the user asked for is true.
 */
export async function endRemoteSession(
  host: SshHost,
  name: string,
  run: SshRunner = runSsh
): Promise<{ ok: boolean; message: string }> {
  const args = buildRemoteSessionKillArgs(host, name)
  if (!args) return { ok: false, message: 'That is not a session name Stoke will send to a remote shell.' }
  const r = await run(args)
  if (r.code === 0) return { ok: true, message: '' }
  if (/can't find session|no server running|session not found/i.test(r.stderr)) return { ok: true, message: '' }
  return { ok: false, message: sshReason(r) }
}
