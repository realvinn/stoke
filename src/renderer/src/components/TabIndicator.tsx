import type { ContextSnapshot, PermissionMode } from '@shared/types'
import { ContextRing, RING_R } from './ContextMeter'
import type { TabKind } from '../types'

interface Props {
  kind: TabKind
  /** Undefined until the context watcher has reported for this session. */
  context: Pick<ContextSnapshot, 'ready' | 'contextTokens' | 'contextLimit'> | undefined
  status: 'running' | 'exited' | 'paused'
  /**
   * The mode the transcript last recorded, not the one the tab launched with.
   * See the ContextSnapshot.permissionMode work in this workstream.
   */
  permissionMode: PermissionMode
  /** The worklog agent is watching this session: the dot in the ring's centre. */
  watched: boolean
}

/** A live remote link gets its own dot, leaving the context meter intact. */
export function RemoteConnectionDot({ connected = true }: { connected?: boolean }): React.JSX.Element {
  return <span className="tab-remote-dot" data-connected={connected || undefined} aria-hidden="true" />
}

export function TabIndicator({
  kind,
  context,
  status,
  permissionMode,
  watched
}: Props): React.JSX.Element {
  if (kind === 'grok-bot') return (
    <span className="tab-indicator" data-kind="grok-bot">
      <svg className="ring" viewBox="0 0 16 16" aria-hidden="true">
        <path className="ring-track" d="M3 3.5h10v7H7l-3 2v-2H3z" />
      </svg>
      <span className="sr-only">Grok Bot conversation</span>
    </span>
  )
  if (kind === 'new') {
    /*
     * A New Project tab has no session, so there is nothing to measure. The
     * plus is drawn inline rather than pulled from Icons.tsx so it inherits
     * the ring's exact geometry and cannot drift out of the slot.
     *
     * `data-level="empty"` just mirrors what ContextRing sets for its own
     * not-ready state (see ContextMeter.tsx), so the two ways a ring can
     * appear in the strip describe themselves the same way in the DOM. It has
     * no effect on the track's stroke — `.ring .ring-track` in app.css sets
     * --border-strong unconditionally, for every level — a `[data-level=
     * 'empty']` variant of that same rule was proven inert and removed
     * (Task 51), rather than left standing as if it did something.
     */
    return (
      <span className="tab-indicator" data-kind="new">
        <svg className="ring" viewBox="0 0 16 16" data-level="empty" aria-hidden="true">
          <circle className="ring-track" cx="8" cy="8" r={RING_R} />
          <path className="ring-plus" d="M8 5.4v5.2M5.4 8h5.2" />
        </svg>
        <span className="sr-only">New session, not started</span>
      </span>
    )
  }

  const ready = context?.ready === true
  const bypass = permissionMode === 'bypassPermissions'

  return (
    <span
      className="tab-indicator"
      data-status={status}
      data-mode={bypass ? 'bypass' : undefined}
    >
      <ContextRing
        used={context?.contextTokens ?? 0}
        limit={context?.contextLimit ?? 0}
        ready={ready}
        watched={watched}
        paused={status === 'paused'}
        bypass={bypass}
      />
      <span className="sr-only">
        {watched ? 'Worklog is watching this session. ' : ''}
        {status === 'exited' ? 'Session ended. ' : ''}
        {status === 'paused' ? 'Paused, restored from the last run. ' : ''}
        {bypass ? 'Permissions bypassed.' : ''}
      </span>
    </span>
  )
}
