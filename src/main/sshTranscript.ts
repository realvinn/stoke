import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  MAX_REMOTE_TRANSCRIPT_BYTES,
  buildTranscriptArgs,
  splitTranscriptOutput,
  sshExecutable
} from './ssh.ts'
import type { SshHost } from '@shared/types'

/**
 * Fetching a remote session's transcript, so the features that read one work on
 * the far side of an SSH connection too.
 *
 * An SSH session spawns `ssh -t <alias> <command>`, so the `claude` process runs
 * on the remote machine and writes its JSONL there. Everything Stoke does with a
 * transcript — the context meter, the worklog scan — reads a local file, so all
 * of it has silently never worked for a remote session.
 *
 * The alternative considered and rejected was scraping the PTY stream, which
 * Stoke does retain (`pty.ts` keeps 512KB per session). That stream is a
 * recording of a *screen*: Claude Code's TUI repaints as it streams, so the same
 * sentence arrives dozens of times interleaved with box drawing, and none of the
 * things that matter — which tools ran, which subagents were spawned, how many
 * tokens — are in it at all. The real JSONL has every one of them, and this
 * copies it back for the price of one SSH round trip.
 *
 * What lands on disk is a cache, not a record: it is rewritten on every fetch
 * and is only ever read straight back by this process.
 */

/** Where fetched transcripts are cached, one file per session. */
export const REMOTE_TRANSCRIPT_DIR = 'ssh-transcripts'

/**
 * A fetch is a network round trip on a background timer, so it gets a short
 * leash. Failing fast and trying again in two minutes beats holding a handle
 * open against a machine that has gone to sleep.
 */
const DEFAULT_TIMEOUT_MS = 20_000

/**
 * execFile buffers stdout in memory and defaults to 1 MB, which the transcript
 * blows past immediately — and the failure loses the answer that was already
 * transferred. Sized off the remote cap, with room for the path line.
 */
const MAX_BUFFER = MAX_REMOTE_TRANSCRIPT_BYTES + 1_000_000

export interface RemoteTranscript {
  /** Local cache file, ready for readTranscript/parseSession. */
  file: string
  /** Where it came from on the remote machine, for the user to check. */
  remotePath: string
  bytes: number
  /** False when the remote content was identical to the last fetch. */
  changed: boolean
}

export interface FetchOptions {
  timeoutMs?: number
  /**
   * Override the transport, so the parse and cache paths can be tested without
   * a live host. Resolves with the raw stdout of the remote command.
   */
  run?: (host: SshHost, sessionId: string | null) => Promise<string>
}

function runSsh(host: SshHost, sessionId: string | null, timeoutMs: number): Promise<string> {
  /*
   * `execFile` with an args array, never a shell string.
   *
   * The remote command carries `$`, `"`, `|` and `*`, all of which are for the
   * *remote* login shell to interpret. Nothing local may touch them — and
   * nothing does, because ssh is a real executable rather than one of the `.cmd`
   * shims that get routed through `cmd.exe /c` (see spawnSpec in cli.ts).
   */
  return new Promise((resolve, reject) => {
    execFile(
      sshExecutable(),
      buildTranscriptArgs(host, sessionId),
      { timeout: timeoutMs, maxBuffer: MAX_BUFFER, encoding: 'utf8', windowsHide: true },
      (err, stdout) => {
        // A non-zero exit with usable output still answers the question: the
        // remote `if` prints nothing and exits 0 when there is no transcript, so
        // anything that did arrive is real.
        if (err && !stdout) reject(err)
        else resolve(stdout)
      }
    )
  })
}

/**
 * Pull a remote session's transcript back and cache it locally.
 *
 * Returns null rather than throwing for every "not this time" — no transcript
 * on the far machine yet, the host asleep, the key needing a passphrase. All of
 * those are ordinary for a background poll, and a throw would turn each into an
 * error the user has to dismiss.
 */
export async function fetchRemoteTranscript(
  host: SshHost,
  sessionId: string,
  userDataDir: string,
  opts: FetchOptions = {}
): Promise<RemoteTranscript | null> {
  let stdout: string
  try {
    stdout = opts.run
      ? await opts.run(host, null)
      : await runSsh(host, null, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  } catch {
    return null
  }

  const split = splitTranscriptOutput(stdout)
  if (!split || !split.jsonl.trim()) return null

  try {
    const dir = join(userDataDir, REMOTE_TRANSCRIPT_DIR)
    mkdirSync(dir, { recursive: true })
    // Named for the *local* session id, because that is what every caller has.
    // The remote path is reported separately rather than encoded here: it is a
    // POSIX path and would not survive being used as a Windows filename.
    const file = join(dir, `${sessionId}.jsonl`)

    /*
     * Do not rewrite the cache when nothing changed, and this is load-bearing.
     *
     * Everything that reads a transcript decides "has anything happened?" from
     * the file's mtime — the context meter re-parses on it, and the auto-scan
     * trigger measures how long a session has been *quiet* from it. Rewriting an
     * identical file on every poll moves that mtime forward every 30 seconds
     * forever, so a remote session would never once look idle and would never be
     * scanned. The feature would appear to work and silently do nothing.
     *
     * Skipping the write makes the cache's mtime mean what it is read as: when
     * the far machine's transcript was last observed to change.
     */
    let previous: string | null = null
    try {
      previous = readFileSync(file, 'utf8')
    } catch {
      /* first fetch for this session */
    }
    const changed = previous !== split.jsonl
    if (changed) writeFileSync(file, split.jsonl, 'utf8')

    return { file, remotePath: split.path, bytes: split.jsonl.length, changed }
  } catch {
    return null
  }
}
