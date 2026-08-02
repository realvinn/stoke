import { app } from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Working directories for sessions that are not tied to a saved project.
 *
 * Two ways in:
 *  - the default folder, for "just start Claude Code somewhere sensible"
 *  - a scratch folder, for throwaway work that should not litter a real project
 */

/**
 * Candidate default directories, most preferred first. The first one that
 * exists wins, so a machine without any of them still lands on the home folder
 * rather than failing.
 */
function candidates(): string[] {
  const home = homedir()
  const out: string[] = []

  if (process.platform === 'win32') {
    // This machine keeps everything under G:\Code. Harmless when absent.
    out.push('G:\\Code', join(home, 'Code'), join(home, 'source', 'repos'))
  } else {
    out.push(join(home, 'Code'), join(home, 'code'), join(home, 'Developer'), join(home, 'Projects'))
  }

  out.push(home)
  return out
}

/** Where a no-project session should run. An explicit setting always wins. */
export function resolveDefaultCwd(configured: string | null): string {
  if (configured && existsSync(configured)) return configured
  for (const dir of candidates()) {
    if (existsSync(dir)) return dir
  }
  return homedir()
}

function stamp(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}`
  )
}

/**
 * Create a dated throwaway folder under the app's data directory.
 *
 * Deliberately not the OS temp directory: temp gets swept without warning, and
 * anything Claude writes during a scratch session would vanish with it. These
 * persist until deleted, and Settings offers a way to open the folder.
 */
export function createScratchDir(): string {
  const root = join(app.getPath('userData'), 'scratch')
  const base = stamp()

  let dir = join(root, base)
  let n = 2
  while (existsSync(dir)) {
    dir = join(root, `${base}-${n}`)
    n++
  }

  mkdirSync(dir, { recursive: true })
  return dir
}

export function scratchRoot(): string {
  return join(app.getPath('userData'), 'scratch')
}
