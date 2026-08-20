import type { CliInfo, ContextSnapshot } from '@shared/types'
import { ContextBar } from './ContextMeter'
import { modelLabel, shortPath } from '../lib/format'
import { PERMISSION_LABELS } from '../lib/permissions'
import type { Tab } from '../types'

interface Props {
  tab: Tab | null
  context: ContextSnapshot | null
  cli: CliInfo | null
  /** Newer CLI version found at launch, or null when up to date. */
  updateAvailable: string | null
  /**
   * The profile the sidebar is filtered to, or null for All.
   *
   * Named, not merely coloured, and here rather than only on the sidebar chip:
   * the profile follows the active tab now, so it changes without anyone
   * pressing anything, and the sidebar can be closed. Colour cannot carry it —
   * verify:profiles measures Ember's accent as identical to Personal's and
   * Moss's as 0.049 from Work's, inside the palette's own 0.083 "same colour"
   * band.
   */
  profileLabel: string | null
  onRevealProject: (path: string) => void
  onOpenSettings: () => void
}

export function StatusBar({
  tab,
  context,
  cli,
  updateAvailable,
  profileLabel,
  onRevealProject,
  onOpenSettings
}: Props): React.JSX.Element {
  const updatePill = updateAvailable ? (
    <button
      className="status-btn"
      onClick={onOpenSettings}
      title={`Claude Code ${updateAvailable} is available — open Settings to update`}
    >
      <span className="pill" data-tone="accent">
        {updateAvailable} available
      </span>
    </button>
  ) : null

  /*
   * No colour of its own: `applyAppearance` writes the active profile's accent
   * over --accent and --accent-soft, so data-tone="accent" is already this
   * profile's colour, and stays right when there is no profile to override it.
   */
  const profilePill = profileLabel ? (
    <span
      className="pill"
      data-tone="accent"
      title={`Profile: ${profileLabel} — follows the folder of the tab in front`}
    >
      {profileLabel}
    </span>
  ) : null

  if (!tab) {
    return (
      <footer className="statusbar">
        <span className="status-item">No active session</span>
        {profilePill}
        <span className="status-spacer" />
        {updatePill}
        {cli?.version && <span className="status-item mono">{cli.version}</span>}
      </footer>
    )
  }

  const bypass = tab.permissionMode === 'bypassPermissions'
  const model = context?.model ?? (tab.model || null)
  /*
   * A paused tab's `context` is seeded at restore with a real saved reading
   * but a zeroed message-count breakdown (`toStored` never persisted one) —
   * see the boot-restore effect in App.tsx. `tab.status` is the single field
   * that carries "paused" (TabIndicator reads the same field the same way);
   * this derives a local boolean from it once rather than repeating the
   * `=== 'paused'` comparison at each render site below.
   */
  const paused = tab.status === 'paused'

  return (
    <footer className="statusbar">
      <button
        className="status-btn status-item mono"
        onClick={() => onRevealProject(tab.cwd)}
        title={`Open ${tab.cwd}`}
      >
        {shortPath(tab.cwd, 52)}
      </button>

      {profilePill}

      <span className="pill" data-tone={bypass ? 'danger' : undefined}>
        {PERMISSION_LABELS[tab.permissionMode]}
      </span>

      <span className="status-item">{modelLabel(model)}</span>

      {tab.effort !== 'default' && <span className="status-item">effort: {tab.effort}</span>}

      <span className="status-spacer" />

      {updatePill}

      {context?.ready ? (
        <>
          {/*
           * A restored snapshot's messageCount is always 0 — genuinely
           * unrestorable, not a real count of zero — so stating it here
           * would read as "this session had no turns," which is false for
           * every paused tab that ever ran. Suppressed rather than guessed.
           */}
          {!paused && <span className="status-item">{context.messageCount} msgs</span>}
          <span
            className="status-item"
            title={paused ? 'Context window used when last active' : 'Context window in use'}
          >
            <ContextBar used={context.contextTokens} limit={context.contextLimit} paused={paused} />
          </span>
        </>
      ) : (
        <span className="status-item">waiting for first turn…</span>
      )}
    </footer>
  )
}
