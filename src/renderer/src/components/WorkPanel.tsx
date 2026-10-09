import { useEffect, useRef, useState } from 'react'
import { DAILY_STATES, TASK_STATES, localWorkDay } from '@shared/workPlugin'
import type { WorkCommand, WorkDaily, WorkDailyStatus, WorkTask, WorkView } from '@shared/workPlugin'

interface Props {
  session?: { id: string; title: string }
}

export function WorkPanel({ session }: Props): React.JSX.Element {
  const [view, setView] = useState<WorkView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'tasks' | 'daily'>('daily')
  const [day, setDay] = useState(localWorkDay)
  const [adding, setAdding] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [editorRevision, setEditorRevision] = useState(0)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [project, setProject] = useState('')
  const [evidence, setEvidence] = useState('')
  const [status, setStatus] = useState<WorkDailyStatus>('To-Do')
  const [link, setLink] = useState(true)
  const claimed = useRef(false)
  const mounted = useRef(false)

  const receive = (next: WorkView): void => setView((previous) => previous && previous.revision > next.revision ? previous : next)
  useEffect(() => {
    mounted.current = true
    const off = window.stoke.work.onChange(receive)
    void window.stoke.work.read().then((next) => { if (mounted.current) receive(next) }, () => { if (mounted.current) setError('The Work boards could not be opened. Reopen this panel to retry.') })
    return () => { mounted.current = false; off() }
  }, [])

  const change = async (command: WorkCommand): Promise<void> => {
    if (claimed.current) return
    claimed.current = true; setBusy(true); setError('')
    try {
      const result = await window.stoke.work.change(command)
      if (!mounted.current) return
      if (result.ok) { receive(result.view); setAdding(false); setSelected(null) }
      else setError(result.message)
    } catch { if (mounted.current) setError('Work could not save. Reopen the panel to check before retrying.') }
    finally { claimed.current = false; if (mounted.current) setBusy(false) }
  }
  const pick = (entry: WorkTask | WorkDaily): void => {
    setAdding(false); setSelected(entry.id); setEditorRevision(entry.revision); setTitle(entry.title); setEvidence(entry.evidence); setError('')
    if ('brief' in entry) { setBody(entry.brief); setProject(entry.project) }
    else { setBody(entry.notes); setStatus(entry.status) }
  }
  const begin = (): void => {
    setAdding(true); setSelected(null); setTitle(''); setBody(''); setProject(''); setEvidence(''); setError('')
  }
  const task = mode === 'tasks' ? view?.tasks.find((r) => r.id === selected) : undefined
  const entry = mode === 'daily' ? view?.daily.find((r) => r.id === selected) : undefined
  const unsavedIdea = task?.status === 'Idea' && (title !== task.title || body !== task.brief || project !== task.project)
  const changedElsewhere = !!(task || entry) && (task?.revision ?? entry?.revision) !== editorRevision
  const closeEditor = (): void => { setSelected(null); setAdding(false); setError('') }
  const taskAction = (kind: 'approve' | 'start' | 'complete' | 'plan'): void => {
    if (!task) return
    if (changedElsewhere) { setError('This entry changed. Reload it before saving.'); return }
    if (kind === 'complete') void change({ kind, id: task.id, revision: editorRevision, day, evidence })
    else if (kind === 'start') void change({ kind, id: task.id, revision: editorRevision, day, ...(link && session ? { sessionId: session.id } : {}) })
    else void change({ kind, id: task.id, revision: editorRevision, day })
  }

  return <section className="work-panel" aria-label="Work boards" aria-busy={busy}>
    <div className="work-header" data-setting="worklog.plugin">
      <div className="work-header-text"><h3>Work plugin</h3><p>Keep ideas and approvals in a task board, with a separate plan for each day.</p></div>
      <label className="work-enable"><input type="checkbox" checked={view?.enabled ?? false} disabled={!view || busy} onChange={(e) => void change({ kind: 'enable', enabled: e.target.checked })} /> Enabled</label>
    </div>
    {error && <p className="work-error" role="alert">{error}</p>}
    {!view ? <p className="work-note" role="status">Opening your boards…</p> : !view.enabled ? <p className="work-note">Enable Work to plan your day. Saved tasks and daily entries stay here when it is disabled. Session reviews below have their own settings.</p> : <>
      <div className="work-controls" data-setting="worklog.boards">
        <div className="work-switch" aria-label="Work board">
          <button className="btn" aria-pressed={mode === 'daily'} disabled={busy} onClick={() => { setMode('daily'); closeEditor() }}>Daily work</button>
          <button className="btn" aria-pressed={mode === 'tasks'} disabled={busy} onClick={() => { setMode('tasks'); closeEditor() }}>Tasks</button>
        </div>
        <label className="work-date">Day <input className="input" type="date" value={day} onChange={(e) => { setDay(e.target.value); closeEditor() }} disabled={busy} /></label>
        <button className="btn" onClick={begin} disabled={busy}>{mode === 'tasks' ? 'Add an idea' : 'Add unplanned work'}</button>
      </div>
      <p className="work-note">{mode === 'tasks' ? 'Approve an idea, then start it when you begin. Completion keeps the evidence and updates the selected day.' : 'Tasks can appear on several days. Completing a daily entry records that day’s work; the durable task keeps its own status.'}</p>
      {(adding || task || entry) && <form className="work-editor" onSubmit={(e) => {
        e.preventDefault()
        if (changedElsewhere) { setError('This entry changed. Reload it before saving.'); return }
        if (adding) void change(mode === 'tasks' ? { kind: 'idea', title, brief: body, project } : { kind: 'daily', day, title, notes: body })
        else if (task?.status === 'Idea') void change({ kind: 'edit', id: task.id, revision: editorRevision, title, brief: body, project })
        else if (entry) void change({ kind: 'daily-edit', id: entry.id, revision: editorRevision, notes: body, status, evidence })
      }}>
        <label>Title<input className="input" required maxLength={240} value={title} disabled={busy || !!task && task.status !== 'Idea' || !!entry} onChange={(e) => setTitle(e.target.value)} /></label>
        {mode === 'tasks' && <label>Project name<input className="input" maxLength={2048} value={project} disabled={busy || !!task && task.status !== 'Idea'} onChange={(e) => setProject(e.target.value)} /></label>}
        <label>{mode === 'tasks' ? 'Brief' : 'Notes'}<textarea className="input" rows={4} maxLength={16000} value={body} disabled={busy || !!task && task.status !== 'Idea'} onChange={(e) => setBody(e.target.value)} /></label>
        {entry && <label>Daily status<select className="input" value={status} disabled={busy} onChange={(e) => setStatus(e.target.value as WorkDailyStatus)}>{DAILY_STATES.map((s) => <option key={s}>{s}</option>)}</select></label>}
        {(entry || task?.status === 'Working' || task?.status === 'Completed') && <label>Completion evidence<textarea className="input" rows={3} maxLength={8000} placeholder="What changed, checks passed, commit or session links…" value={evidence} disabled={busy || task?.status === 'Completed'} onChange={(e) => setEvidence(e.target.value)} /></label>}
        {task?.status === 'Approved' && <>
          {session && <label className="work-enable"><input type="checkbox" checked={link} onChange={(e) => setLink(e.target.checked)} disabled={busy} /> Link this session: {session.title}</label>}
          <p className="work-note">Start work records progress. Send your task brief to the agent when you are ready.</p>
        </>}
        {task?.sessionId && <p className="work-note">Assigned session: <code>{task.sessionId}</code></p>}
        <div className="work-actions">
          {(adding || entry || task?.status === 'Idea') && <button className="btn" data-variant="primary" disabled={busy || !title.trim() || !!entry && status === 'Completed' && !evidence.trim()} type="submit">{busy ? 'Saving…' : adding ? 'Save' : 'Save changes'}</button>}
          {task?.status === 'Idea' && <button type="button" className="btn" disabled={busy || unsavedIdea} onClick={() => taskAction('approve')}>Approve saved idea</button>}
          {task?.status === 'Approved' && <button type="button" className="btn" data-variant="primary" disabled={busy} onClick={() => taskAction('start')}>Start work</button>}
          {task?.status === 'Working' && <button type="button" className="btn" data-variant="primary" disabled={busy || !evidence.trim()} onClick={() => taskAction('complete')}>Complete task and day</button>}
          {task && task.status !== 'Completed' && <button type="button" className="btn" disabled={busy || unsavedIdea} onClick={() => taskAction('plan')}>Plan for {day}</button>}
          <button className="btn" type="button" disabled={busy} onClick={closeEditor}>Close</button>
        </div>
        {unsavedIdea && <p className="work-note">Save your changes before approving or planning this idea.</p>}
        {changedElsewhere && <p className="work-error" role="status">This entry changed. <button className="btn" type="button" disabled={busy} onClick={() => { const current = task ?? entry; if (current) pick(current) }}>Reload entry</button></p>}
      </form>}
      <div className="work-ledger">
        {(mode === 'tasks' ? TASK_STATES : DAILY_STATES).map((state) => {
          const rows = mode === 'tasks' ? view.tasks.filter((r) => r.status === state) : view.daily.filter((r) => r.day === day && r.status === state)
          return <section className="work-lane" key={state} aria-label={state}>
            <h4>{state}<span>{rows.length}</span></h4>
            {rows.length === 0 ? <p className="work-empty">{mode === 'tasks' && state === 'Idea' ? 'Add the next thing you want to build.' : 'No entries.'}</p> : rows.slice().reverse().map((row) => <button key={row.id} className="work-item" disabled={busy} onClick={() => pick(row)} aria-pressed={selected === row.id}>
              <span>{row.title}</span><small>{'project' in row ? row.project || 'No project' : row.taskId ? 'Linked task' : 'Unplanned work'}</small>
            </button>)}
          </section>
        })}
      </div>
    </>}
  </section>
}
