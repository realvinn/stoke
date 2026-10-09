import { useEffect, useRef, useState } from 'react'
import { WORK_DRAFT_BUDGET_USD } from '@shared/workDrafts'
import type { WorkDraftKind, WorkDraftResult, WorkDraftView, WorkSessionNotes } from '@shared/workDrafts'
import type { WorkView } from '@shared/workPlugin'

interface Props { work: WorkView; selection: { kind: 'task' | 'daily'; id: string } | null; day: string; session?: { id: string; title: string; notesPtyId?: string } }
export function WorkDrafts({ work, selection, day, session }: Props): React.JSX.Element {
  const [view, setView] = useState<WorkDraftView | null>(null)
  const [kind, setKind] = useState<WorkDraftKind>('brief')
  const [notes, setNotes] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{ context: string; notes: WorkSessionNotes; title: string } | null>(null)
  const claimed = useRef(false)
  const mounted = useRef(false)
  const receive = (next: WorkDraftView): void => setView((old) => old && old.revision > next.revision ? old : next)
  useEffect(() => {
    mounted.current = true
    const off = window.stoke.work.onDraftsChange(receive)
    void window.stoke.work.draftsRead().then((next) => { if (mounted.current) receive(next) }, () => { if (mounted.current) setError('Saved drafts could not be opened. Reopen this panel before retrying.') })
    return () => { mounted.current = false; off() }
  }, [])
  const task = selection?.kind === 'task' ? work.tasks.find((r) => r.id === selection.id) : undefined
  const daily = selection?.kind === 'daily' ? work.daily.find((r) => r.id === selection.id) : undefined
  const row = task ?? daily
  const notesContext = `${session?.notesPtyId ?? ''}:${session?.id ?? ''}:${selection?.kind ?? ''}:${selection?.id ?? ''}:${row?.revision ?? ''}:${day}`
  const contextRef = useRef(notesContext); contextRef.current = notesContext
  const currentPreview = preview?.context === notesContext ? preview : null
  const available: WorkDraftKind[] = task ? [...(task.status === 'Idea' ? ['brief' as const] : []), ...(task.status === 'Working' ? ['complete' as const] : [])] : daily ? ['summary', ...(daily.status !== 'Completed' ? ['complete' as const] : [])] : []
  const chosen = available.includes(kind) ? kind : available[0]
  const locked = busy || !!view?.running
  const run = async (fn: () => Promise<WorkDraftResult>): Promise<void> => {
    if (claimed.current || view?.running) return
    claimed.current = true; setBusy(true); setError('')
    try { const result = await fn(); if (mounted.current) { if (result.ok) receive(result.view); else setError(result.message) } }
    catch { if (mounted.current) setError('The draft action could not answer. Check its saved state before retrying.') }
    finally { claimed.current = false; if (mounted.current) setBusy(false) }
  }
  const readNotes = async (): Promise<void> => {
    if (claimed.current || view?.running || !session?.notesPtyId || !session.id) return
    claimed.current = true; setBusy(true); setError(''); setPreview(null)
    const context = notesContext; const captured = { ...session }
    try {
      const result = await window.stoke.work.sessionNotes(captured.notesPtyId!, captured.id)
      if (!mounted.current || contextRef.current !== context) return
      if (result.ok && result.notes.ptyId === captured.notesPtyId && result.notes.sessionId === captured.id) setPreview({ context, notes: result.notes, title: captured.title })
      else setError(result.ok ? 'The session changed. Read its current notes again.' : result.message)
    } catch { if (mounted.current && contextRef.current === context) setError('The session notes could not answer. Your source notes are unchanged.') }
    finally { claimed.current = false; if (mounted.current) setBusy(false) }
  }
  return <details className="work-drafts" data-setting="worklog.drafts" aria-busy={locked}>
    <summary>Sonnet drafts</summary>
    <p className="work-note">Uses your configured Claude provider and default Claude sign-in. Sends this saved record and your source notes. Tools and MCP are disabled. CLI budget: ${WORK_DRAFT_BUDGET_USD} per run; a final turn can exceed it.</p>
    {error && <p className="work-error" role="alert">{error}</p>}
    <form className="work-editor" onSubmit={(e) => {
      e.preventDefault()
      if (!selection || !row || !chosen) return
      const related = task ? work.daily.find((r) => r.taskId === task.id && r.day === day) : undefined
      void run(() => window.stoke.work.draft({ kind: chosen, target: selection.kind, id: row.id, revision: row.revision, day, relatedRevision: related?.revision, notes }))
    }}>
      <p className="work-note">{row ? `Saved record: ${row.title}` : 'Select a task or daily entry first.'}</p>
      <label>Draft purpose<select className="input" disabled={locked || !available.length} value={chosen ?? ''} onChange={(e) => setKind(e.target.value as WorkDraftKind)}>
        {!available.length && <option value="">Select an idea, working task or daily entry</option>}
        {available.map((k) => <option key={k} value={k}>{k === 'brief' ? 'Idea brief' : k === 'summary' ? 'Daily summary' : 'Completion evidence'}</option>)}
      </select></label>
      <label>Source notes<textarea className="input" rows={4} maxLength={6000} value={notes} disabled={locked} placeholder="Observed changes, session notes, checks and results…" onChange={(e) => setNotes(e.target.value)} /></label>
      <button className="btn" data-variant="ghost" type="button" disabled={locked || !row || !session?.notesPtyId || !session.id} onClick={() => void readNotes()}>Read current session notes</button>
      <p className="work-note">Local Claude sessions only. Reads recent conversation excerpts for review; it sends nothing to Sonnet. Tool output is excluded, and conversation claims still need verification.</p>
      {currentPreview && <div className="work-publish-row">
        <strong>{currentPreview.title} · {new Date(currentPreview.notes.capturedAt).toLocaleString()}</strong>
        <p className="work-note">{currentPreview.notes.turns} conversation turns{currentPreview.notes.truncated ? ' · Excerpt shortened; earlier content may be missing' : ''}. Review before using these as source notes.</p>
        <textarea className="input" rows={6} readOnly aria-label="Session notes preview" value={currentPreview.notes.text} />
        <button className="btn" type="button" disabled={locked} onClick={() => {
          setNotes(`Conversation excerpts from session ${currentPreview.notes.sessionId}, captured ${new Date(currentPreview.notes.capturedAt).toISOString()}. Claims need review.\n\n${currentPreview.notes.text}`)
          setPreview(null)
        }}>{notes.trim() ? 'Replace source notes with this excerpt' : 'Use this excerpt as source notes'}</button>
        <button className="btn" data-variant="ghost" type="button" disabled={locked} onClick={() => setPreview(null)}>Discard excerpt</button>
      </div>}
      <button className="btn" disabled={locked || !row || !chosen || chosen === 'complete' && !notes.trim() && !row.evidence.trim()} type="submit">Draft with Sonnet</button>
    </form>
    {view?.running && <button className="btn" onClick={() => void window.stoke.work.draftCancel().catch(() => setError('The cancel request could not answer.'))}>Cancel draft</button>}
    {view?.drafts.slice().reverse().map((draft) => <article className="work-journal-entry" key={draft.id}>
      <strong>{draft.source.title} · {draft.state}</strong>
      <p className="work-note" role={draft.state === 'drafting' ? 'status' : undefined}>{draft.message || 'Drafting a proposal…'}{draft.costUsd !== null && <> · Reported cost ${draft.costUsd.toFixed(3)}</>}</p>
      {draft.proposal && <div className="work-publish-row">
        <strong>{draft.proposal.title}</strong>
        <dl><dt>{draft.request.kind === 'brief' ? 'Brief' : 'Summary'}</dt><dd>{draft.proposal.body}</dd>{draft.request.kind === 'complete' && <><dt>Completion evidence</dt><dd>{draft.proposal.evidence}</dd><dt>Transition</dt><dd>{draft.source.status} → Completed · {draft.request.day}</dd></>}</dl>
      </div>}
      {['ready', 'accepting'].includes(draft.state) && <button className="btn" disabled={locked} onClick={() => void run(() => window.stoke.work.draftAccept(draft.id))}>{draft.state === 'accepting' ? 'Check saved acceptance' : draft.request.kind === 'complete' ? 'Accept and mark Completed' : 'Accept local draft'}</button>}
      {['ready', 'failed'].includes(draft.state) && <button className="btn" disabled={locked} onClick={() => void run(() => window.stoke.work.draftReject(draft.id))}>Discard draft</button>}
    </article>)}
  </details>
}
