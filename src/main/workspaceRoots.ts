/**
 * Where a session that is not tied to a saved project should run.
 *
 * Split out of workspace.ts, which imports electron for `app.getPath`, so this
 * can be driven by `node scripts/verify-folders.mts` with no app running. The
 * platform and the home folder are arguments for the same reason: the failure
 * this fixes is a list of folders that exist on one machine and no other, and a
 * function that reads `process.platform` can only ever be tested on the machine
 * it is already right for.
 */
import { existsSync } from 'node:fs'

/**
 * Most preferred first, always ending in `home` so there is always an answer.
 *
 * `~/Developer` leads on macOS because it is Apple's own convention and Xcode
 * gives it a folder icon; `~/dev`, `~/src` and `~/repos` are here because the
 * original list had none of them and this machine keeps everything in `~/dev`,
 * so every session with no project started in the home folder.
 *
 * Paths are joined with a separator taken from `platform`, NOT with
 * `node:path`'s `join`, which uses the separator of the machine it is running
 * on. Otherwise asking for the Windows list from a Mac returns
 * `C:\Users\v/Code`, and the one thing worth testing here — that a list written
 * for one machine is right on another — could not be tested at all.
 */
export function defaultCwdCandidates(platform: string, home: string): string[] {
  const sep = platform === 'win32' ? '\\' : '/'
  const root = home.replace(/[\\/]+$/, '') || home
  const under = (...parts: string[]): string => [root, ...parts].join(sep)
  const out: string[] =
    platform === 'win32'
      ? // This machine keeps everything under G:\Code. Harmless when absent.
        ['G:\\Code', under('Code'), under('source', 'repos'), under('dev')]
      : [
          under('Developer'),
          under('Code'),
          under('code'),
          under('dev'),
          under('Projects'),
          under('src'),
          under('repos')
        ]
  out.push(root)
  // On a case-insensitive filesystem `~/Code` and `~/code` are one folder, and
  // offering it twice would have the first hit answer for both.
  return [...new Set(out)]
}

/** An explicit setting always wins, provided it is still there. */
export function resolveDefaultCwd(
  configured: string | null,
  platform: string,
  home: string
): string {
  if (configured && existsSync(configured)) return configured
  for (const dir of defaultCwdCandidates(platform, home)) {
    if (existsSync(dir)) return dir
  }
  return home
}
