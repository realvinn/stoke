import type { Tab } from '../types'

interface Props {
  tab: Tab
  active: boolean
  /** The screen this tab had when Stoke last quit. May be ''. */
  screen: string
  /** Null when this tab cannot be resumed — see the card's copy. */
  onResume: (() => void) | null
  onClose: (tabId: string) => void
}

/**
 * A tab restored from the last run, waiting to be resumed.
 *
 * The stored screen is drawn behind the card rather than an empty pane, because
 * three paused tabs are otherwise indistinguishable apart from their titles —
 * and the screen is the thing that tells you which one you wanted.
 *
 * Plain text in a <pre>, not a terminal: the snapshot is text (the raw PTY
 * replay buffer cannot be safely resumed mid-repaint), and mounting a second
 * xterm per paused tab to render it would cost a WebGL context each.
 */
export function PausedSession({ tab, active, screen, onResume, onClose }: Props): React.JSX.Element {
  return (
    <div className="term-pane" hidden={!active}>
      <pre className="paused-screen" aria-hidden="true">
        {screen}
      </pre>
      <div className="paused-card" role="status">
        <span className="paused-title">{tab.title || tab.projectName}</span>
        <span className="paused-note">
          {onResume
            ? tab.hostId
              ? 'Paused when Stoke quit. Resuming reconnects to this host.'
              : tab.sessionId
                ? 'Paused when Stoke quit.'
                : 'Paused when Stoke quit. Resuming opens the most recent session in this folder.'
            : 'This host is no longer in Settings, so there is nothing to reconnect to.'}
        </span>
        <div className="paused-actions">
          {onResume && (
            <button className="btn" data-variant="primary" onClick={onResume}>
              Resume session
            </button>
          )}
          <button className="btn" data-variant="ghost" onClick={() => onClose(tab.id)}>
            Close tab
          </button>
        </div>
      </div>
    </div>
  )
}
