import type { ContextSnapshot, PermissionMode } from '@shared/types'
import { ContextRing, RING_R } from './ContextMeter'
import type { TabKind } from '../types'

interface Props {
  kind: TabKind
  /** Undefined until the context watcher has reported for this session. */
  context: ContextSnapshot | undefined
  status: 'running' | 'exited' | 'paused'
  /**
   * The mode the transcript last recorded, not the one the tab launched with.
   * See the ContextSnapshot.permissionMode work in this workstream.
   */
  permissionMode: PermissionMode
  /** The worklog agent is watching this session: the dot in the ring's centre. */
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
 * Three things share the slot, and each says itself with a different shape:
 *
 *  - The ARC is context used, in traffic-light colours — green to 30%, orange
 *    to 60%, red from 61%, and from 81% a solid red disc (ContextMeter.tsx,
 *    shared/contextLevel.ts). So red in the strip is context pressure again:
 *    it used to be kept off the ring, amber at 90%, so that red could mean
 *    only the worklog dot. The arc is solid with round ends from 12 o'clock.
 *  - The DOT in the middle is the worklog agent watching this session. Still
 *    --danger, and a filled centre rather than an arc, so the two reds cannot
 *    be read for each other; over a full ring's red disc it is inverted to the
 *    page colour rather than lost.
 *  - In bypass mode the TRACK is a ring of slate beads — a setting, not an
 *    alarm. It was a red dot once, then an amber dashed track, and on a machine
 *    whose default mode is bypass that put the loudest colour on screen on every
 *    tab all the time. It is the theme's own neutral now (--ring-bypass), and
 *    the beads rather than the colour carry "the guard rails are off". They
 *    are drawn by ContextRing, which leaves out any bead the arc would touch.
 *
 * The dot is drawn by ContextRing, inside the ring's own <svg>, rather than
 * laid over it as a second child of this slot. Two boxes centred in one grid
 * cell agree in layout and disagree by half a pixel once painted; one circle
 * sharing the ring's coordinate system cannot. See WATCH_R in ContextMeter.tsx.
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
