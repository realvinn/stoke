import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Commit subjects, to put names to the numbers in the activity report.
 *
 * Corroboration, never a dependency, and the difference is not academic here.
 * Measured across the ten work folders on this machine: two have real history
 * (94 and 54 commits in thirty days), four have one or two, and **three have no
 * repository at all** — one of which is the largest session on the disk, 18.4
 * hours and 5,642 lines. A report that leant on git would omit most of the
 * work and look complete doing it. So the transcript is the spine and this only
 * ever adds detail on top.
 *
 * Electron-free, like `activity.ts`, so `scripts/verify-activity.mts` can run
 * it directly under `node --experimental-strip-types`.
 */

/** Long enough for a cold repository, short enough not to hold up a panel. */
const DEFAULT_TIMEOUT_MS = 3000

/**
 * Subjects for one repository on one local day, newest first.
 *
 * Returns an empty array for every failure there is — no repository, a git that
 * is not installed, a corrupt index, a timeout. None of them is worth failing
 * the report for: the hours and the lines stand perfectly well without the
 * commit messages, and a missing repository is the ordinary case rather than an
 * error worth telling anyone about.
 *
 * `execFile` with an explicit timeout, never a synchronous call. A project can
 * sit on an external disk that has spun down, and a synchronous call there
 * blocks the main process's event loop — which stops every IPC reply and every
 * frame with it. That is CLAUDE.md gotcha 40, measured at 6.4 seconds of blocked
 * main thread in the first six seconds of a boot.
 *
 * The day is passed to git as a local-time range, matching `dayKey`'s local
 * day. Handing git an ISO instant instead would silently shift the boundary by
 * the machine's offset and move the first and last commits of a day onto their
 * neighbours.
 */
export async function commitSubjects(
  repoDir: string,
  day: string,
  opts: { timeoutMs?: number } = {}
): Promise<string[]> {
  if (!repoDir) return []
  // Cheap and synchronous, but on a path we were just handed by the project
  // list rather than one discovered by walking — and it saves spawning a
  // process per non-repository folder, of which there are three here.
  if (!existsSync(join(repoDir, '.git'))) return []

  return new Promise<string[]>((resolve) => {
    execFile(
      'git',
      [
        '-C',
        repoDir,
        'log',
        '--since',
        `${day} 00:00:00`,
        '--until',
        `${day} 23:59:59`,
        '--pretty=format:%s'
      ],
      {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true
      },
      (err, stdout) => {
        if (err) return resolve([])
        resolve(
          stdout
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
        )
      }
    )
  })
}
