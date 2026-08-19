import type { ContextSnapshot, StoredTab, StoredTabs } from '@shared/types'
import type { Tab } from '../types'

/**
 * Between the live tab list and the snapshot that outlives the process.
 *
 * Pure, and in its own module rather than inline in App.tsx, because it is the
 * one part of this feature a suite can check — everything else is a side effect
 * inside a closure or a paint (CLAUDE.md gotcha 31).
 */

/** Ids are regenerated on restore, so they only have to be unique in this run. */
function restoredId(i: number): string {
  return `restored-${Date.now().toString(36)}-${i}`
}

export function toStored(
  tabs: Tab[],
  activeTabId: string | null,
  contexts: Record<string, ContextSnapshot>,
  screenOf: (tab: Tab) => string,
  now = Date.now()
): StoredTabs {
  const stored: StoredTab[] = tabs.map((t) => {
    const snap = t.sessionId ? contexts[t.sessionId] : undefined
    return {
      kind: t.kind,
      sessionId: t.sessionId,
      cwd: t.cwd,
      projectName: t.projectName,
      title: t.title,
      permissionMode: t.permissionMode,
      model: t.model,
      effort: t.effort,
      hostId: t.hostId,
      selectedPath: t.selectedPath,
      expandedPath: t.expandedPath,
      lastActiveAt: now,
      context:
        snap && snap.ready && snap.contextLimit > 0
          ? { tokens: snap.contextTokens, limit: snap.contextLimit }
          : null,
      /*
       * The whole tab, not its ptyId: a paused tab has no process and therefore
       * no buffer, and must keep the screen it was restored with. Only the
       * caller knows that, so only the caller can resolve it.
       */
      screen: screenOf(t)
    }
  })
  const at = tabs.findIndex((t) => t.id === activeTabId)
  return { version: 1, savedAt: now, activeIndex: at < 0 ? 0 : at, tabs: stored }
}

export function fromStored(state: StoredTabs): { tabs: Tab[]; activeId: string | null } {
  const tabs: Tab[] = state.tabs.map((s, i) => ({
    id: restoredId(i),
    kind: s.kind,
    ptyId: '',
    sessionId: s.sessionId,
    cwd: s.cwd,
    projectName: s.projectName,
    title: s.title,
    permissionMode: s.permissionMode,
    model: s.model,
    effort: s.effort,
    /*
     * Only a session tab is paused. A New tab has no session to resume, so
     * marking it paused would put a Resume card over a launcher.
     */
    status: s.kind === 'session' ? 'paused' : 'running',
    exitCode: null,
    hostId: s.hostId,
    selectedPath: s.selectedPath,
    expandedPath: s.expandedPath
  }))
  return { tabs, activeId: tabs[state.activeIndex]?.id ?? tabs[0]?.id ?? null }
}

/** The screen a paused tab was restored with, keyed by tab id. */
export function screensFrom(state: StoredTabs, tabs: Tab[]): Record<string, string> {
  const out: Record<string, string> = {}
  state.tabs.forEach((s, i) => {
    const id = tabs[i]?.id
    if (id) out[id] = s.screen
  })
  return out
}
