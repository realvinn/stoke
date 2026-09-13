import { useEffect } from 'react'
import type { SshAuthPromptEvent, SshEnrollEvent, SshHost } from '@shared/types'
import { IconClose } from './Icons'

interface Props {
  /** The password prompt that raised this offer. */
  prompt: SshAuthPromptEvent
  /** The machine it belongs to, from settings. Subject is `label || alias`. */
  host: SshHost
  /** The latest enrollment progress for this host, or null before a press. */
  progress: SshEnrollEvent | null
  /** An enrollment is running. Everything that could start a second one is off. */
  busy: boolean
  /**
   * Whether Escape belongs to this strip right now.
   *
   * App owns Escape for every overlay and this is not one — it is a row in the
   * flow. Without the gate, Escape pressed to close the settings sheet would
   * also throw this offer away, silently and from behind a modal.
   */
  escapeDismisses: boolean
  /** Press Add a key. The only route to `window.stoke.ssh.enroll`. */
  onEnroll: () => void
  /** Not now, the close button, and Escape. Dismisses for this session only. */
  onDismiss: () => void
  /** Never for this host. One press — see the comment on the button. */
  onNever: () => void
}

/**
 * How much of the remote's `user@host` is ever painted.
 *
 * It is text the far end sent (`SshAuthPrompt` says so), so it is display-only
 * and it is not trusted to be short. The detector bounds the line it came from
 * at `SSH_AUTH_TAIL_BYTES` — 512 characters, which is a `title` nobody can read
 * and a `textContent` worth keeping out of the layout even though the CSS
 * truncates. What identifies a machine is the front of the string.
 */
const MAX_FROM = 80

/** The stage, in words, for the one line the strip has. */
const STAGE: Record<SshEnrollEvent['stage'], string> = {
  starting: 'Starting',
  generating: 'Making a key',
  installing: 'Installing the key',
  verifying: 'Checking it works',
  done: 'Done',
  failed: 'Could not add a key'
}

function stageLabel(p: SshEnrollEvent): string {
  // `ok: false` on 'done' is the case worth spelling out: the key IS installed
  // and the server still asks, which "Done" would report as a success.
  if (p.stage === 'done' && p.ok === false) return 'Added, and it still asks for a password'
  return STAGE[p.stage]
}

/**
 * The offer to install an SSH key on a machine that just asked for a password.
 *
 * A row in `.main-col`, above the terminal, exactly like `WorklogPrompt` and
 * for the reason that component's own comment gives: the docked browser is a
 * native `WebContentsView` painting over every pixel of renderer DOM (gotcha
 * 14), so a modal, an overlay or a popover would be invisible precisely when
 * the browser is open. A question nobody can see is worse than no question.
 *
 * Three things this deliberately does differently from `WorklogPrompt`:
 *
 * - **"Never for this host" is one press, not two.** That component asks twice
 *   because rejecting a proposal tombstones it irrecoverably. This writes one
 *   boolean that Settings shows as a checkbox and can turn back on, and putting
 *   friction on the *decline* of a feature that writes to someone's server is
 *   backwards.
 * - **Escape works**, mapped to Not now.
 * - **Every button carries an aria-label naming the machine.** "Add a key" read
 *   out of context says nothing about which machine is about to be written to.
 *
 * What `offer: 'auto'` does here is change the wording and nothing else. It does
 * NOT press the button: `api.ts` states the invariant as "the only caller is the
 * Add-a-key button... so nothing can be installed without a press", and a
 * renderer that called `enroll` off an event would be exactly the path from the
 * detector to the install that the invariant denies. The setting is still worth
 * having and still honest — it says the offer arrives ready to go and that the
 * password is typed either way — but if the intent is truly to start without a
 * press, that is a deliberate change to the invariant, made here and in api.ts
 * together, not a line quietly added to this component.
 */
export function SshKeyPrompt({
  prompt,
  host,
  progress,
  busy,
  escapeDismisses,
  onEnroll,
  onDismiss,
  onNever
}: Props): React.JSX.Element {
  useEffect(() => {
    if (!escapeDismisses) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [escapeDismisses, onDismiss])

  const subject = host.label.trim() || host.alias.trim() || 'That machine'

  /*
   * WHICH machine, in the remote's own words.
   *
   * Not decoration: through a ProxyJump, or a `Host` alias that fronts several
   * boxes, the alias in settings and the box actually asking can differ — and
   * the thing being offered is an append to a file on the box that is asking.
   * Nothing is ever built from it; enrollment uses `host.alias`.
   */
  const from = [prompt.user, prompt.host].filter((s) => s !== '').join('@').slice(0, MAX_FROM)

  const enrolled = host.keyEnrolled === true
  const finishedOk = progress?.stage === 'done' && progress.ok !== false

  /*
   * The line, in three pieces, so the painted text and the `title` are the same
   * words rather than two copies that can drift. `strong` is the middle piece.
   */
  const { lead, strong, tail } = progress
    ? {
        lead: '',
        strong: stageLabel(progress),
        tail: progress.message.trim() === '' ? '' : ` — ${progress.message.trim()}`
      }
    : enrolled
      ? {
          lead: 'Stoke already added a key to',
          strong: subject,
          tail: ', and it is asking for a password again. Try again?'
        }
      : prompt.offer === 'auto'
        ? {
            lead: '',
            strong: subject,
            tail: ' asked for a password. Stoke is set to add a key here — you still type the password once.'
          }
        : { lead: '', strong: subject, tail: ' asked for a password. Add a key so it stops?' }

  // The user@host always ends the title: a clipped line still says which
  // machine when the pointer rests on it.
  const title = [`${lead} ${strong}${tail}`.trim(), from].filter((s) => s !== '').join(' — ')

  return (
    <div className="ssh-prompt" role="status" aria-live="polite">
      <span className="ssh-prompt-kind">SSH</span>

      {/*
        One line that truncates as a whole, for the reason .worklog-prompt-text
        records: a nowrap flex item's min-content width propagates up through
        `.main-col` and widens the entire app rather than clipping itself
        (gotcha 14). The full text is on the element, so a clipped line is still
        readable on hover — and it always ends with the user@host, which is the
        part that says which machine.
      */}
      <p className="ssh-prompt-text" title={title}>
        {lead !== '' && `${lead} `}
        <strong>{strong}</strong>
        {tail}
      </p>

      {from !== '' && (
        <span className="ssh-prompt-meta truncate mono" title={from}>
          {from}
        </span>
      )}

      {/*
        Hidden once the key is in and verified: there is nothing left to press,
        and an enabled "Try again" over a working key is an invitation to
        authenticate again for no reason.
      */}
      {!finishedOk && (
        <button
          className="btn"
          data-variant="primary"
          disabled={busy}
          aria-label={`${enrolled || progress ? 'Try adding a key to' : 'Add a key to'} ${subject}`}
          onClick={onEnroll}
        >
          {busy ? 'Adding…' : enrolled || progress ? 'Try again' : 'Add a key'}
        </button>
      )}

      {/*
        Identical to the close button, and both persist nothing: the offer comes
        back the next time this machine asks for a password. A dismissal is not
        an answer, and a control that quietly recorded one would be the reason
        nobody could work out why they were never asked again.
      */}
      <button className="btn" aria-label={`Do not add a key to ${subject} now`} onClick={onDismiss}>
        Not now
      </button>

      {/*
        ONE press. `WorklogPrompt`'s two-press Reject is right there and is the
        wrong model: it guards an irreversible tombstone, while this writes
        `keyEnrollRefused` on the host — one checkbox in Settings away from being
        undone, and shown per host there so it can be found. Asking twice before
        letting someone decline a feature that appends to a file on their own
        server is friction pointed at the safe answer.

        Off while an enrollment runs: refusing a host Stoke is mid-install on
        would leave the two states disagreeing about what just happened.
      */}
      <button
        className="btn"
        data-variant="ghost"
        disabled={busy}
        aria-label={`Never offer to add a key to ${subject}`}
        title="Stop offering for this machine. Settings can turn it back on."
        onClick={onNever}
      >
        Never for this host
      </button>

      <button className="icon-btn" onClick={onDismiss} title="Dismiss">
        <IconClose />
        <span className="sr-only">Dismiss the key offer for {subject}</span>
      </button>
    </div>
  )
}
