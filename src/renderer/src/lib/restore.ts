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
  // An install tab is not a session and cannot come back as one. Nor can an
  // "Add key to …" tab: restoring it would reopen an ssh-copy-id asking for a
  // password nobody is there to type, on a host that may have its key by now.
  // An account's sign-in tab neither: a login reopened at the next start
  // would ask nobody for a sign-in.
  // Nor another machine's session: a relay does not survive a restart, and that machine asks again.
  // Nor a private chat, above all: its whole promise is that nothing of it is
  // kept, and `screen` is its raw terminal text (main drops one too).
  const kept = tabs.filter(
    (t): t is Tab & { kind: 'session' | 'new' } =>
      t.kind !== 'remote' && !t.installing?.length && !t.enrollHostId && !t.accountLogin && !t.private
  )
  const stored: StoredTab[] = kept.map((t) => {
    const snap = t.sessionId ? contexts[t.sessionId] : undefined
    return {
      kind: t.kind,
      cliId: t.cliId,
      sessionId: t.sessionId,
      cwd: t.cwd,
      projectName: t.projectName,
      title: t.title,
      // Only when the tab was renamed — keeps a never-renamed tab's stored form
      // byte-for-byte what it always was.
      ...(t.customTitle ? { customTitle: t.customTitle } : {}),
      permissionMode: t.permissionMode,
      ...(t.agentAccess ? { agentAccess: t.agentAccess } : {}),
      model: t.model,
      effort: t.effort,
      ultracode: t.ultracode,
      hostId: t.hostId,
      // Only on a kept SSH tab, so every other tab's stored form is unchanged.
      // The name is what makes a restore a REATTACH to the shell that kept
      // running on the machine while Stoke was closed.
      ...(t.hostId && t.remoteSession ? { remoteSession: t.remoteSession } : {}),
      // Only when it was not the agent's own sign-in, so a Default tab's
      // stored form is byte-for-byte what it always was.
      ...(t.kind === 'session' && t.accountId && t.accountId !== 'default' ? { accountId: t.accountId } : {}),
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
  const at = kept.findIndex((t) => t.id === activeTabId)
  return { version: 1, savedAt: now, activeIndex: at < 0 ? 0 : at, tabs: stored }
}

export function fromStored(state: StoredTabs): { tabs: Tab[]; activeId: string | null } {
  const tabs: Tab[] = state.tabs.map((s, i) => ({
    id: restoredId(i),
    kind: s.kind,
    // Already hydrated by `tabStore.tabOf`, so this is a known-good id rather
    // than whatever was on disk.
    cliId: s.cliId,
    ptyId: '',
    sessionId: s.sessionId,
    cwd: s.cwd,
    projectName: s.projectName,
    title: s.title,
    ...(s.customTitle ? { customTitle: s.customTitle } : {}),
    permissionMode: s.permissionMode,
    ...(s.cliId !== 'claude' ? { agentAccess: s.agentAccess ?? 'default' } : {}),
    /*
     * Another agent's paused tab comes back with no model. Its Resume asks
     * main's launch plan again, from today's settings, and the tab takes the
     * model that plan reports — and a tab saved before other agents carried
     * their own model holds Claude Code's default instead, which the status
     * bar would now name beside a Codex tab. The literal id because this
     * module imports types only (verify:restore runs it, gotcha 78).
     */
    model: s.cliId === 'claude' ? s.model : '',
    effort: s.effort,
    ultracode: s.ultracode,
    /*
     * Only a session tab is paused. A New tab has no session to resume, so
     * marking it paused would put a Resume card over a launcher.
     */
    status: s.kind === 'session' ? 'paused' : 'running',
    exitCode: null,
    hostId: s.hostId,
    ...(s.hostId && s.remoteSession ? { remoteSession: s.remoteSession } : {}),
    /*
     * The account it ran on. Absent in the file means the agent's own
     * sign-in — every tab from before accounts, and every Default tab — and
     * is restored as `'default'` explicitly, never as "whatever the default
     * account is now": a conversation must not move to another account's plan
     * because the default changed while Stoke was closed. An SSH tab has none.
     */
    ...(s.kind === 'session' && !s.hostId ? { accountId: s.accountId ?? 'default' } : {}),
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
