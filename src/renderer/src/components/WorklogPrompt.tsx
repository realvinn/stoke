import type { WorklogProposal, WorklogTarget } from '@shared/types'
import { IconClose } from './Icons'
import { baseName } from '../lib/format'

interface Props {
  /** Pending proposals from the last automatic scan, newest first. */
  proposals: WorklogProposal[]
  /** A write is in flight. Everything that mutates the queue goes dead. */
  busy: boolean
  onAccept: (id: string) => void
  /** Leave it in the queue, stop asking about it here. */
  onSkip: (id: string) => void
  onReviewAll: () => void
  onDismiss: () => void
}

const TARGET_LABEL: Record<WorklogTarget, string> = {
  notion: 'Notion',
  clickup: 'ClickUp'
}

/** "Notion", or "Notion and ClickUp" — never a count, never an abbreviation. */
function where(targets: WorklogTarget[]): string {
  const labels = (['notion', 'clickup'] as WorklogTarget[])
    .filter((t) => targets.includes(t))
    .map((t) => TARGET_LABEL[t])
  if (labels.length === 0) return 'nowhere'
  if (labels.length === 1) return labels[0]
  return `${labels[0]} and ${labels[1]}`
}

/**
 * The question, in the words the user asked for: "should I add this task or
 * update the status for this task".
 *
 * It names the actual consequence — which record, which board, which status —
 * because this control writes to a real workspace and the person pressing it is
 * mid-thought about something else.
 */
function question(p: WorklogProposal): { lead: string; subject: string; tail: string } {
  if (p.kind === 'update') {
    const target = p.targets[0]
    const existing = target ? p.existing?.[target] : undefined
    const status = target ? p.newStatus?.[target] : undefined
    const board = target ? TARGET_LABEL[target] : 'the board'
    if (status) {
      return { lead: 'Mark', subject: existing?.title ?? p.title, tail: `as ${status} in ${board}?` }
    }
    return { lead: 'Add a note to', subject: existing?.title ?? p.title, tail: `in ${board}?` }
  }
  return { lead: 'Add', subject: p.title, tail: `to ${where(p.targets)}?` }
}

/**
 * The automatic scan's pop-up.
 *
 * A row between the title bar and `.body-row`, deliberately NOT an overlay: the
 * docked browser is a native WebContentsView that paints above every pixel of
 * renderer DOM, so a floating prompt would be invisible exactly when the browser
 * is open — which is a large share of the time this app is used.
 *
 * One question at a time. A list of six things to decide is a panel, and there
 * already is one; the point of this strip is that answering it costs a single
 * glance and a single click. Anything more considered has a Review all.
 */
export function WorklogPrompt({
  proposals,
  busy,
  onAccept,
  onSkip,
  onReviewAll,
  onDismiss
}: Props): React.JSX.Element | null {
  const current = proposals[0]
  if (!current) return null

  const { lead, subject, tail } = question(current)
  const more = proposals.length - 1

  return (
    <div className="worklog-prompt" role="status" aria-live="polite">
      <span className="worklog-prompt-kind" data-kind={current.kind === 'update' ? 'update' : 'create'}>
        {current.kind === 'update' ? 'Update' : 'New'}
      </span>

      {/*
        One line that truncates as a whole, rather than a flex row that truncates
        the title inside it. The nested version made a long title widen the entire
        app past its window — see .worklog-prompt-text in app.css. The full text is
        on the element, so a clipped question is still readable on hover.
      */}
      <p className="worklog-prompt-text" title={`${lead} ${subject} ${tail}`}>
        {lead} <strong>{subject}</strong> {tail}
      </p>

      {current.cwd && (
        <span className="worklog-prompt-meta truncate" title={current.cwd}>
          {baseName(current.cwd)}
        </span>
      )}

      <button
        className="btn"
        data-variant="primary"
        data-size="sm"
        disabled={busy}
        onClick={() => onAccept(current.id)}
      >
        {busy ? 'Writing…' : current.kind === 'update' ? 'Update it' : 'Add it'}
      </button>
      {/* Not "Reject". Skipping leaves the proposal in the queue to decide on
          later; rejecting it is permanent, and that decision belongs somewhere
          the whole entry is visible. */}
      <button className="btn" data-size="sm" disabled={busy} onClick={() => onSkip(current.id)}>
        Not now
      </button>
      <button className="btn" data-variant="ghost" data-size="sm" onClick={onReviewAll}>
        {more > 0 ? `Review all (${proposals.length})` : 'Review'}
      </button>
      <button className="icon-btn" onClick={onDismiss} title="Dismiss until the next scan">
        <IconClose />
        <span className="sr-only">Dismiss</span>
      </button>
    </div>
  )
}
