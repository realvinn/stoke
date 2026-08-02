import type { CliInfo, ContextSnapshot } from '@shared/types'
import { ContextBar } from './ContextMeter'
import { modelLabel, shortPath } from '../lib/format'
import { PERMISSION_LABELS } from '../lib/permissions'
import type { Tab } from '../types'

interface Props {
  tab: Tab | null
  context: ContextSnapshot | null
  cli: CliInfo | null
  onRevealProject: (path: string) => void
}

export function StatusBar({ tab, context, cli, onRevealProject }: Props): React.JSX.Element {
  if (!tab) {
    return (
      <footer className="statusbar">
        <span className="status-item">No active session</span>
        <span className="status-spacer" />
        {cli?.version && <span className="status-item mono">{cli.version}</span>}
      </footer>
    )
  }

  const bypass = tab.permissionMode === 'bypassPermissions'
  const model = context?.model ?? (tab.model || null)

  return (
    <footer className="statusbar">
      <button
        className="status-btn status-item mono"
        onClick={() => onRevealProject(tab.cwd)}
        title={`Open ${tab.cwd}`}
      >
        {shortPath(tab.cwd, 52)}
      </button>

      <span className="pill" data-tone={bypass ? 'danger' : undefined}>
        {PERMISSION_LABELS[tab.permissionMode]}
      </span>

      <span className="status-item">{modelLabel(model)}</span>

      {tab.effort !== 'default' && <span className="status-item">effort: {tab.effort}</span>}

      <span className="status-spacer" />

      {context?.ready ? (
        <>
          <span className="status-item">{context.messageCount} msgs</span>
          <span className="status-item" title="Context window in use">
            <ContextBar used={context.contextTokens} limit={context.contextLimit} />
          </span>
        </>
      ) : (
        <span className="status-item">waiting for first turn…</span>
      )}
    </footer>
  )
}
