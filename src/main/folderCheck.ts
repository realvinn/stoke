/**
 * Asking the disk about a folder someone named, under a deadline.
 *
 * Moved out of index.ts unchanged so the phone's folder routes
 * (`remote/folders.ts`) and `verify:folders` run the very functions `stoke .`
 * and the Open-folder dialogs use. No `electron` import: a suite loads this
 * under node's strip-types.
 */
import { realpath, stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { FolderProblem } from '../shared/stokeArgs.ts'

/** The same deadline `projects.ts` gives a folder check, for the same reason (gotcha 40). */
export const LAUNCH_FOLDER_DEADLINE_MS = 1500

/** Why `path` cannot be opened as a folder, or null when it can. Async, with a deadline. */
export async function launchFolderProblem(path: string): Promise<FolderProblem | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const st = await Promise.race([
      stat(path),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
          LAUNCH_FOLDER_DEADLINE_MS
        )
        timer.unref?.()
      })
    ])
    return st.isDirectory() ? null : 'not-a-folder'
  } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing'
    if (code === 'EACCES' || code === 'EPERM') return 'denied'
    return 'unreachable'
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/**
 * Why the file manager will NOT be asked to show `path`, as a sentence for the
 * user, or null to go ahead — `projects:reveal`, behind the tab menu's folder
 * item and the status bar's path.
 *
 * `shell.openPath` takes any string: a relative one (an SSH tab's host alias,
 * which the status bar used to send, gotcha 18) resolves against main's own
 * cwd, and a FILE is launched with its default app rather than shown. The
 * renderer already refuses both (`openableFolder`); this is the second lock,
 * asked under the same deadline as every other folder check (gotcha 40).
 */
export async function revealProblem(path: unknown): Promise<string | null> {
  if (typeof path !== 'string' || !path || !isAbsolute(path)) return 'That is not a folder on this computer.'
  switch (await launchFolderProblem(path)) {
    case null:
      return null
    case 'missing':
      return `There is no folder at ${path} any more.`
    case 'not-a-folder':
      return `${path} is a file, not a folder.`
    case 'denied':
      return `Stoke is not allowed to read ${path}.`
    case 'unreachable':
      return `${path} did not answer in time — a sleeping or disconnected disk, most likely. Try again.`
  }
}

/**
 * `path` through symlinks, or `path` unchanged when it cannot be resolved
 * inside the same deadline `launchFolderProblem` gives the stat before this
 * (gotcha 40) — a folder that just answered `stat` a moment ago failing THIS
 * call is rare enough that falling back to the typed string, rather than
 * failing the whole launch, is the right trade.
 *
 * This is the fix for gotcha 91: `stoke .` from `/tmp` (a symlink to
 * `/private/tmp` on macOS) used to store the typed path while the `claude` it
 * spawned recorded `process.cwd()`'s OS-resolved one (`pty.ts`'s `realCwd`),
 * so the sidebar carried two rows for the same folder — one live, one not.
 * Resolving here, before the folder is ever remembered or handed to the
 * renderer, means every later consumer (the sidebar, the launcher, the pty
 * itself) agrees on one path from the start.
 */
export async function realpathFolder(path: string): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      realpath(path),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })),
          LAUNCH_FOLDER_DEADLINE_MS
        )
        timer.unref?.()
      })
    ])
  } catch {
    return path
  } finally {
    if (timer) clearTimeout(timer)
  }
}
