import type { ContextSnapshot, PermissionMode } from '@shared/types'
import { ContextRing, RING_R } from './ContextMeter'
import type { TabKind } from '../types'

interface Props {
  kind: TabKind
  /** Undefined until the context watcher has reported for this session. */
  context: ContextSnapshot | undefined
  status: 'running' | 'exited'
  /**
   * The mode the transcript last recorded, not the one the tab launched with.
   * See the ContextSnapshot.permissionMode work in this workstream.
   */
  permissionMode: PermissionMode
  /** The worklog agent is watching this session. The only red in the strip. */
  watched: boolean
}

/**
 * Everything one tab has to say about its session, in a slot of fixed width.
 *
 * The slot is fixed because the strip used to swap a 7px dot for a 14px ring
 * the moment the context watcher became ready, and the label and the close
 * button jumped 7px with it. It is also the reason the ring is drawn even with
 * no reading: an empty circle occupies the slot honestly, where a blank space
 * would read as a rendering failure.
 *
 * The red dot in the middle means exactly one thing — the worklog agent is
 * watching this session. Bypass mode and a nearly-full ring both used to be
 * red as well, so red meant three unrelated things at once and therefore
 * nothing; both now have their own treatment.
 */
export function TabIndicator({
  kind,
  context,
  status,
  permissionMode,
  watched
}: Props): React.JSX.Element {
  if (kind === 'new') {
    /*
     * A New Project tab has no session, so there is nothing to measure. The
     * plus is drawn inline rather than pulled from Icons.tsx so it inherits
     * the ring's exact geometry and cannot drift out of the slot.
     *
     * `data-level="empty"` is what makes the .ring[data-level='empty']
     * .ring-track rule below apply here too. Without it the plus-in-a-circle
     * inherits the default track stroke rather than --border-strong, and the
     * one tab in the strip that has nothing to report is the one drawn as
     * though it did.
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
      />
      {watched && <span className="tab-watch" aria-hidden="true" />}
      <span className="sr-only">
        {watched ? 'Worklog is watching this session. ' : ''}
        {status === 'exited' ? 'Session ended. ' : ''}
        {bypass ? 'Permissions bypassed.' : ''}
      </span>
    </span>
  )
}
