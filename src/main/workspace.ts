import { app } from 'electron'
import { homedir } from 'node:os'
import { resolveDefaultCwd as resolveCwd } from './workspaceRoots.ts'
import { createScratch, scratchRoot } from './scratch.ts'
import { getSettings } from './store.ts'

/**
 * Working directories for sessions that are not tied to a saved project.
 *
 * Two ways in:
 *  - the default folder, for "just start Claude Code somewhere sensible"
 *  - a scratch folder, for throwaway work that should not litter a real project
 */

/** Where a no-project session should run. An explicit setting always wins. */
export function resolveDefaultCwd(configured: string | null): string {
  return resolveCwd(configured, process.platform, homedir())
}

export function resolveScratchRoot(): string {
  return scratchRoot(getSettings().scratch, homedir(), app.getPath('userData'))
}

/**
 * Create a dated throwaway folder in the user's configured scratch root.
 *
 * Deliberately not the OS temp directory: temp gets swept without warning, and
 * anything Claude writes during a scratch session would vanish with it. These
 * persist until deleted by hand. Existing folders stay where they were made.
 */
export async function createScratchDir(): Promise<string> {
  return createScratch(resolveScratchRoot())
}
