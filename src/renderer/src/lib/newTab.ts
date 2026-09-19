import { DEFAULT_CLI } from '@shared/codingClis'
import type { Tab } from '../types'

/**
 * A New Project tab: a strip entry with no process behind it.
 *
 * The launcher was always this tab's content; it just was not a tab, so the
 * "about to start something" state had no place in the strip and `+` could
 * only clear the selection. Everything a session tab needs and this one has no
 * answer for is an empty string, never a fake — `ptyId` and `sessionId` are
 * empty because there is no process and no transcript, and `status` reads
 * `running` only because a tab with no process cannot have exited. Nothing
 * reads `status` for a `new` tab; the indicator branches on `kind` first.
 */
export function newTab(
  selectedPath: string | null = null,
  expandedPath: string | null = null
): Tab {
  return {
    id: `new-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'new',
    // A launcher is not running anything yet. It carries the default so the
    // field is never absent; the CLI a launch actually uses is chosen on the
    // launcher itself and reaches the session tab that replaces this one.
    cliId: DEFAULT_CLI,
    ptyId: '',
    sessionId: '',
    cwd: '',
    projectName: '',
    title: 'New session',
    permissionMode: 'default',
    model: '',
    effort: 'default',
    ultracode: false,
    status: 'running',
    exitCode: null,
    hostId: null,
    selectedPath,
    expandedPath
  }
}
