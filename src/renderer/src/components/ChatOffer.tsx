import { capsSentence, formatBytes, offerFound, type ChatDetection, type ChatIndexCaps, type ChatSourceId } from '@shared/chatIndex'
import { isActivationKey } from '@shared/launcher'
import { launcherActivationAllowed } from '../lib/pressBurst'

interface Props {
  /** Names and sizes only, from `chats.detect`. Null while it is being taken. */
  detection: ChatDetection | null
  enabled: Record<ChatSourceId, boolean>
  caps: ChatIndexCaps
  /** When the splash or the agent picker last went away (`pressClock()`), or null. */
  armedAt: number | null
  onIndex: () => void
  onNotNow: () => void
  onChoose: () => void
}

/**
 * "Make your AI chats searchable?" — the one-time offer, as a CARD in the
 * launcher's column, never a modal.
 *
 * A modal here would be a third in the first-run chain (splash, agent picker),
 * and every one of those has had an Enter meant for the one before it land on
 * it (gotchas 88, 93). So: it is shown only once the picker has settled, it is
 * never focused, it sits in the page rather than over the docked browser
 * (gotcha 14), and its buttons take an Enter or Space only on the same terms
 * the launcher's do (`launcherActivationAllowed`): a tapped-through Enter
 * presses nothing here. What it states is detection's — names and sizes; no
 * chat has been opened when it asks.
 */
export function ChatOffer({ detection, enabled, caps, armedAt, onIndex, onNotNow, onChoose }: Props): React.JSX.Element | null {
  const found = detection ? offerFound(detection, enabled) : null
  // Nothing on this machine to index: no card. Settings › Chat history still has the switch.
  if (found && !found.any) return null
  return (
    <section
      className="chat-offer"
      aria-labelledby="chat-offer-title"
      onKeyDownCapture={(e) => {
        if (isActivationKey(e.key) && !launcherActivationAllowed(armedAt)) {
          e.preventDefault()
          e.stopPropagation()
        }
      }}
    >
      <div className="chat-offer-text">
        <b id="chat-offer-title">Make your AI chats searchable?</b>
        <span>
          {found ? (
            <>
              Found {found.text} — about {formatBytes(found.bytes)} to read. Stoke keeps a private copy of the text on
              this computer, so the sidebar&apos;s search can look inside your conversations.
            </>
          ) : (
            'Looking for chats on this computer…'
          )}
        </span>
        <span className="chat-offer-caps">{capsSentence(caps)} Only what you and the model wrote; never tool output or keys.</span>
      </div>
      <div className="btn-row">
        <button className="btn" data-variant="primary" disabled={!found} onClick={onIndex}>
          Index now
        </button>
        <button className="btn" data-variant="ghost" onClick={onNotNow}>
          Not now
        </button>
        <button className="btn" data-variant="ghost" onClick={onChoose} title="Settings › Chat history: which tools, and how much">
          Choose…
        </button>
      </div>
    </section>
  )
}
