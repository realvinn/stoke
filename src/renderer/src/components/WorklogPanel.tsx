import { useEffect, useState } from 'react'
import type { WorklogProposal, WorklogTarget } from '@shared/types'
import { IconClose, IconRefresh } from './Icons'
import { baseName, relativeTime } from '../lib/format'

interface Props {
  proposals: WorklogProposal[]
  /** A scan or a write is in flight. Everything that mutates the queue goes dead. */
  busy: boolean
  onAccept: (id: string) => void
  onReject: (id: string) => void
  onAcceptAll: () => void
  onScan: () => void
  onClose: () => void
}

/** Fixed order so the "Notion and ClickUp" sentence never shuffles between renders. */
const TARGET_ORDER: WorklogTarget[] = ['notion', 'clickup']

const TARGET_LABEL: Record<WorklogTarget, string> = {
  notion: 'Notion',
  clickup: 'ClickUp'
}

/**
 * Bodies vary from a sentence to a page, and measuring every card to decide
 * whether it overflows costs a layout pass per render. The clamp is four lines,
 * so this asks the only question that matters: could it plausibly exceed four?
 * Being generous here is harmless - a toggle on a body that did not need one
 * simply does nothing visible.
 */
function isLong(body: string): boolean {
  return body.length > 220 || body.split('\n').length > 4
}

/** "Notion", or "Notion and ClickUp" - never a count, never an abbreviation. */
function targetNames(items: WorklogProposal[]): string {
  const labels = TARGET_ORDER.filter((t) => items.some((p) => p.targets.includes(t))).map(
    (t) => TARGET_LABEL[t]
  )
  if (labels.length === 0) return 'nothing'
  if (labels.length === 1) return labels[0]
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`
}

function entryCount(n: number): string {
  return `${n} ${n === 1 ? 'entry' : 'entries'}`
}

/**
 * The worklog review queue.
 *
 * A sibling column in `.body-row`, deliberately NOT an overlay: the docked
 * browser is a native WebContentsView that paints above every pixel of renderer
 * DOM, so a floating panel would vanish the moment the browser opened. It is
 * laid out exactly like `BrowserPanel` - the parent owns the width, this owns
 * the chrome.
 *
 * Nothing here writes anywhere. The panel proposes; the main process writes,
 * and only for an id the user has explicitly accepted.
 */
export function WorklogPanel({
  proposals,
  busy,
  onAccept,
  onReject,
  onAcceptAll,
  onScan,
  onClose
}: Props): React.JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [confirming, setConfirming] = useState(false)

  const pending = proposals.filter((p) => p.status === 'pending')

  // A confirm names a specific number of writes to specific services. If the
  // queue moves underneath it - a scan lands, or one item is accepted on its
  // own - that sentence is no longer what the button would do, so the confirm
  // is withdrawn rather than silently repriced.
  useEffect(() => {
    setConfirming(false)
  }, [pending.length])

  const toggle = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return (
    <section className="worklog" style={{ width: '100%' }} aria-label="Worklog review queue">
      <div className="worklog-head">
        <span className="worklog-title">Worklog</span>
        {pending.length > 0 && (
          <span className="pill" data-tone="accent" aria-live="polite">
            {pending.length} to review
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button
          className="icon-btn"
          onClick={onScan}
          disabled={busy}
          title="Look for new work to log"
        >
          <IconRefresh />
          <span className="sr-only">Scan for new entries</span>
        </button>
        <button className="icon-btn" onClick={onClose} title="Close worklog panel">
          <IconClose />
          <span className="sr-only">Close worklog panel</span>
        </button>
      </div>

      {proposals.length > 0 && (
        <p className="worklog-note">Nothing is written until you accept it.</p>
      )}

      {pending.length > 0 && (
        <div className="worklog-bar">
          {confirming ? (
            <>
              {/*
                The one control that writes to two external services at once, so
                it states the whole consequence - how many, and where - before it
                can be pressed. The count and the destinations are read off the
                pending items themselves, not assumed.
              */}
              <span className="worklog-confirm">
                Write {entryCount(pending.length)} to {targetNames(pending)}?
              </span>
              <button
                className="btn"
                data-variant="primary"
                disabled={busy}
                onClick={() => {
                  setConfirming(false)
                  onAcceptAll()
                }}
              >
                {busy ? 'Writing…' : `Write ${pending.length}`}
              </button>
              <button className="btn" data-variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <span className="worklog-confirm">
                {entryCount(pending.length)} waiting for {targetNames(pending)}
              </span>
              <button
                className="btn"
                data-variant="primary"
                disabled={busy}
                onClick={() => setConfirming(true)}
              >
                Accept all
              </button>
            </>
          )}
        </div>
      )}

      <div className="worklog-list">
        {proposals.length === 0 && (
          <div className="empty">
            <h3>Nothing to review</h3>
            <p>
              The worklog agent reads finished sessions in the project groups you have it
              watching and drafts an entry for each: a summary for Notion, a task for
              ClickUp. Drafts land here first — nothing reaches either service until you
              accept it.
            </p>
            <button className="btn" data-variant="primary" onClick={onScan} disabled={busy}>
              {busy ? 'Scanning…' : 'Scan now'}
            </button>
          </div>
        )}

        {proposals.map((p) => {
          // Anything already written is shown as links, whether the write fully
          // succeeded or only half did. A partial write that is invisible is a
          // duplicate waiting to happen on the next accept.
          const written = TARGET_ORDER.filter((t) => p.urls?.[t])
          const open = expanded.has(p.id)

          if (p.status === 'rejected') {
            return (
              <article key={p.id} className="worklog-item" data-status="rejected">
                <div className="worklog-item-head">
                  <h4 className="worklog-item-title truncate" title={p.title}>
                    {p.title}
                  </h4>
                  <span className="pill">Rejected</span>
                </div>
                <p className="field-hint">Not written anywhere.</p>
              </article>
            )
          }

          return (
            <article key={p.id} className="worklog-item" data-status={p.status}>
              <div className="worklog-item-head">
                <h4 className="worklog-item-title" title={p.title}>
                  {p.title}
                </h4>
                {p.status === 'accepted' && (
                  <span className="pill" data-tone="success">
                    Written
                  </span>
                )}
                {p.status === 'failed' && (
                  <span className="pill" data-tone="danger">
                    Failed
                  </span>
                )}
              </div>

              <div className="worklog-meta">
                <span className="truncate" title={p.cwd}>
                  {baseName(p.cwd)}
                </span>
                <span aria-hidden="true">·</span>
                <span>{relativeTime(p.createdAt)}</span>
              </div>

              <p className="worklog-body" data-clamped={isLong(p.body) && !open}>
                {p.body}
              </p>
              {isLong(p.body) && (
                <button
                  className="btn"
                  data-variant="ghost"
                  data-size="sm"
                  aria-expanded={open}
                  onClick={() => toggle(p.id)}
                >
                  {open ? 'Show less' : 'Show more'}
                </button>
              )}

              {p.status === 'failed' && p.error && (
                <p className="field-hint" data-tone="warning">
                  {p.error}
                </p>
              )}

              {written.length > 0 ? (
                <div className="worklog-targets">
                  <span className="worklog-targets-label">Written to</span>
                  {written.map((t) => (
                    <a
                      key={t}
                      className="worklog-link"
                      href={p.urls?.[t]}
                      target="_blank"
                      rel="noreferrer"
                      title={p.urls?.[t]}
                    >
                      {TARGET_LABEL[t]}
                    </a>
                  ))}
                </div>
              ) : (
                <div className="worklog-targets">
                  <span className="worklog-targets-label">
                    {p.status === 'failed' ? 'Was to write to' : 'Will write to'}
                  </span>
                  {p.targets.map((t) => (
                    <span key={t} className="pill">
                      {TARGET_LABEL[t]}
                    </span>
                  ))}
                </div>
              )}

              {p.status !== 'accepted' && (
                <div className="worklog-actions">
                  <button
                    className="btn"
                    data-variant="primary"
                    data-size="sm"
                    disabled={busy}
                    onClick={() => onAccept(p.id)}
                  >
                    {p.status === 'failed' ? 'Try again' : 'Accept'}
                  </button>
                  <button
                    className="btn"
                    data-size="sm"
                    disabled={busy}
                    onClick={() => onReject(p.id)}
                  >
                    Reject
                  </button>
                </div>
              )}
            </article>
          )
        })}
      </div>
    </section>
  )
}
