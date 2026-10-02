import { PRIVATE_FOREIGN_TEXT, PRIVATE_LEAK_TEXT, PRIVATE_STRIP_TEXT } from '@shared/privateChat'
import type { PrivateTabState } from '@shared/api'
import { IconGhost } from './Icons'

/*
 * Above a private chat's terminal: what it is, in one line — nothing saved
 * here, closing deletes it, and Anthropic still receives what is sent (the
 * one copy Stoke can neither see nor delete). A strip in `.main-col` like the
 * SSH key offer, never an overlay: the docked browser paints over anything
 * floating (gotcha 14). No animation (gotcha 72): it is on screen or not.
 *
 * It turns into a warning when main says the promise broke — a transcript
 * the CLI wrote anyway (the watchdog), or a `/resume` into a conversation
 * that was saved before — and says which.
 */
export function PrivateChatStrip({ state }: { state: PrivateTabState | null }): React.JSX.Element {
  const warn = state?.foreign ? 'foreign' : state?.leak ? 'leak' : null
  const text = warn === 'foreign' ? PRIVATE_FOREIGN_TEXT : warn === 'leak' ? PRIVATE_LEAK_TEXT : PRIVATE_STRIP_TEXT
  return (
    <div
      className="ssh-prompt private-strip"
      role="status"
      aria-live={warn ? 'assertive' : 'polite'}
      data-private-strip={warn ?? 'ok'}
    >
      <span className="ssh-prompt-kind private-strip-kind">
        <IconGhost />
        Private
      </span>
      <p className="ssh-prompt-text" title={text}>
        {text}
      </p>
    </div>
  )
}
