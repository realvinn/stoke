import { useEffect, useRef, useState } from 'react'
import { DAILY_STATES, TASK_STATES } from '@shared/workPlugin'
import type { WorkView } from '@shared/workPlugin'
import type { NotionDailyMap, NotionSource, NotionTaskMap, WorkNotionPublishRequest, WorkNotionResult, WorkNotionView } from '@shared/workNotion'

const fold = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '')
const blankTask = (source = ''): NotionTaskMap => ({ source, title: '', body: '', status: '', identity: '', evidence: '', project: '', states: { Idea: '', Approved: '', Working: '', Completed: '' } })
const blankDaily = (source = ''): NotionDailyMap => ({ source, title: '', body: '', status: '', identity: '', evidence: '', day: '', task: '', states: { 'To-Do': '', 'Working on': '', Completed: '' } })
type Field = { key: string; label: string; types: string[]; names: string[] }
const commonFields: Field[] = [
  { key: 'title', label: 'Title', types: ['title'], names: ['Name', 'Title'] },
  { key: 'status', label: 'Status', types: ['status', 'select'], names: ['Status'] },
  { key: 'identity', label: 'Stoke ID', types: ['rich_text'], names: ['Stoke ID'] },
  { key: 'evidence', label: 'Completion evidence', types: ['rich_text'], names: ['Evidence', 'Completion evidence'] }
]
function fields(daily: boolean): Field[] {
  return [...commonFields,
    { key: 'body', label: daily ? 'Notes' : 'Brief', types: ['rich_text'], names: daily ? ['Notes'] : ['Brief'] },
    ...(daily ? [{ key: 'day', label: 'Day', types: ['date'], names: ['Day', 'Date'] }, { key: 'task', label: 'Task relation', types: ['relation'], names: ['Task', 'Tasks'] }] : [{ key: 'project', label: 'Project', types: ['rich_text'], names: ['Project'] }])
  ]
}
function suggested<T extends NotionTaskMap | NotionDailyMap>(map: T, schema: NotionSource, daily: boolean): T {
  const next = { ...map, source: schema.id, states: { ...map.states } } as T
  for (const field of fields(daily)) {
    const candidates = schema.properties.filter((p) => field.types.includes(p.type))
    const found = candidates.find((p) => field.names.some((name) => fold(name) === fold(p.name))) ?? (field.key === 'title' && candidates.length === 1 ? candidates[0] : null)
    if (found) Object.assign(next, { [field.key]: found.id })
  }
  const status = schema.properties.find((p) => p.id === next.status)
  for (const state of daily ? DAILY_STATES : TASK_STATES) {
    const name = status?.options.find((option) => fold(option) === fold(state))
    if (name) Object.assign(next.states, { [state]: name })
  }
  return next
}
function Mapping<T extends NotionTaskMap | NotionDailyMap>({ map, source, daily, disabled, onChange }: { map: T; source: NotionSource; daily: boolean; disabled: boolean; onChange: (map: T) => void }): React.JSX.Element {
  const status = source.properties.find((p) => p.id === map.status)
  return <fieldset className="work-mapping">
    <legend>{daily ? 'Daily work' : 'Tasks'} · {source.name}</legend>
    {fields(daily).map((field) => <label key={field.key}>{field.label}
      <select className="input" disabled={disabled} value={(map as unknown as Record<string, string>)[field.key] ?? ''} onChange={(e) => onChange({ ...map, [field.key]: e.target.value })}>
        <option value="">Choose a {field.types.join(' or ')} property</option>
        {source.properties.filter((p) => field.types.includes(p.type)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>)}
    {(daily ? DAILY_STATES : TASK_STATES).map((state) => <label key={state}>{state} in Notion
      <select className="input" disabled={disabled || !status} value={(map.states as Record<string, string>)[state]} onChange={(e) => onChange(Object.assign({}, map, { states: { ...map.states, [state]: e.target.value } }))}>
        <option value="">Choose an existing status</option>
        {status?.options.map((name) => <option key={name}>{name}</option>)}
      </select>
    </label>)}
  </fieldset>
}

interface Props { work: WorkView; selection: { kind: 'task' | 'daily'; id: string } | null; day: string }
interface Review { request: WorkNotionPublishRequest; rows: { title: string; body: string; status: string; evidence: string; destination: string; project?: string; task?: string }[] }

/** Connection setup and publish review are independent from approval to start work. */
export function WorkNotion({ work, selection, day }: Props): React.JSX.Element {
  const [notion, setNotion] = useState<WorkNotionView | null>(null)
  const [token, setToken] = useState('')
  const [taskSource, setTaskSource] = useState('')
  const [dailySource, setDailySource] = useState('')
  const [taskMap, setTaskMap] = useState(blankTask)
  const [dailyMap, setDailyMap] = useState(blankDaily)
  const [schemas, setSchemas] = useState<{ task: NotionSource; daily: NotionSource } | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [review, setReview] = useState<Review | null>(null)
  const claim = useRef(false)
  const mounted = useRef(false)
  const draftVersion = useRef(0)
  const initialized = useRef(false)
  const receive = (view: WorkNotionView): void => {
    setNotion((old) => old && old.revision > view.revision ? old : view)
    if (!initialized.current) {
      initialized.current = true
      if (view.config) { setTaskSource(view.config.task.source); setDailySource(view.config.daily.source); setTaskMap(view.config.task); setDailyMap(view.config.daily) }
    }
  }
  useEffect(() => {
    mounted.current = true
    const off = window.stoke.work.onNotionChange(receive)
    void window.stoke.work.notionRead().then((view) => { if (mounted.current) receive(view) }, () => { if (mounted.current) setError('The Notion journal could not be opened. Reopen this panel before retrying.') })
    return () => { mounted.current = false; off() }
  }, [])
  const locked = busy || !!notion?.running
  const run = async (fn: () => Promise<WorkNotionResult>): Promise<void> => {
    if (claim.current || notion?.running) return
    claim.current = true; setBusy(true); setError('')
    try {
      const result = await fn()
      if (!mounted.current) return
      if (result.ok) { receive(result.view); setToken(''); setReview(null) }
      else { if (result.view) receive(result.view); setError(result.message) }
    } catch { if (mounted.current) setError('Notion could not answer. Check the saved operation before retrying.') }
    finally { claim.current = false; if (mounted.current) setBusy(false) }
  }
  const inspect = async (): Promise<void> => {
    if (claim.current || notion?.running) return
    claim.current = true; setBusy(true); setError('')
    const version = draftVersion.current
    try {
      const result = await window.stoke.work.notionInspect(taskSource, dailySource, token || undefined)
      if (!mounted.current || version !== draftVersion.current) return
      if (!result.ok) { setError(result.message); return }
      setSchemas({ task: result.task, daily: result.daily })
      if (notion?.config?.task.source !== result.task.id) setTaskMap(suggested(blankTask(result.task.id), result.task, false))
      if (notion?.config?.daily.source !== result.daily.id) setDailyMap(suggested(blankDaily(result.daily.id), result.daily, true))
    } catch { if (mounted.current) setError('Notion could not inspect these tables. Check the token and table sharing.') }
    finally { claim.current = false; if (mounted.current) setBusy(false) }
  }
  const changeInput = (fn: () => void): void => { draftVersion.current++; setSchemas(null); setError(''); fn() }
  const prepare = (): void => {
    if (!selection || !notion?.config) return
    const config = notion.config
    const rows: Review['rows'] = []
    const addTask = (id: string): void => {
      const task = work.tasks.find((r) => r.id === id)
      if (task) rows.push({ title: task.title, body: task.brief, status: config.task.states[task.status], evidence: task.evidence, destination: config.taskLabel ?? config.task.source, project: task.project })
    }
    const addDaily = (id: string): void => {
      const daily = work.daily.find((r) => r.id === id)
      if (daily) rows.push({ title: daily.title, body: daily.notes, status: config.daily.states[daily.status], evidence: daily.evidence, destination: config.dailyLabel ?? config.daily.source, task: daily.taskId ? work.tasks.find((r) => r.id === daily.taskId)?.title ?? 'Missing linked task' : 'Unplanned work' })
    }
    let revision = 0; let relatedRevision: number | undefined
    if (selection.kind === 'task') {
      const task = work.tasks.find((r) => r.id === selection.id)
      const daily = work.daily.find((r) => r.taskId === selection.id && r.day === day)
      if (!task) return
      revision = task.revision; relatedRevision = daily?.revision; addTask(task.id); if (daily) addDaily(daily.id)
    } else {
      const daily = work.daily.find((r) => r.id === selection.id)
      const task = daily?.taskId ? work.tasks.find((r) => r.id === daily.taskId) : undefined
      if (!daily || daily.day !== day) return
      revision = daily.revision; relatedRevision = task?.revision; if (task) addTask(task.id); addDaily(daily.id)
    }
    setReview({ request: { ...selection, revision, relatedRevision, day, connectionId: config.connectionId }, rows }); setError('')
  }
  return <section className="work-notion" aria-label="Notion connection" aria-busy={locked}>
    {error && <p className="work-error" role="alert">{error}</p>}
    <details data-setting="worklog.connection">
      <summary><span>Notion connection</span> · {notion?.config && notion.tokenPresent ? 'Configured' : 'Set up'}</summary>
      <form className="work-editor" onSubmit={(e) => { e.preventDefault(); if (schemas) void run(() => window.stoke.work.notionConfigure({ task: taskMap, daily: dailyMap }, token || undefined)) }}>
        <p className="work-note">Share both databases with your internal Notion connection. Each table needs its own text property for Stoke ID and completion evidence. Daily work needs a date and a relation to the task table.</p>
        <label>Integration token<input className="input" type="password" autoComplete="off" spellCheck={false} maxLength={8192} value={token} disabled={locked} placeholder={notion?.tokenPresent ? 'Token saved · enter a replacement' : 'Paste the connection token'} onChange={(e) => changeInput(() => setToken(e.target.value))} /></label>
        <p className="work-note">The token is sealed by your system key store and used only for this connection.</p>
        <label>Task data source ID<input className="input mono" maxLength={100} value={taskSource} disabled={locked} onChange={(e) => changeInput(() => setTaskSource(e.target.value))} /></label>
        <label>Daily data source ID<input className="input mono" maxLength={100} value={dailySource} disabled={locked} onChange={(e) => changeInput(() => setDailySource(e.target.value))} /></label>
        <div className="work-actions"><button className="btn" type="button" disabled={locked || !taskSource || !dailySource || !token && !notion?.tokenPresent} onClick={() => void inspect()}>{busy ? 'Checking…' : 'Inspect table properties'}</button></div>
        {schemas && <>
          <Mapping map={taskMap} source={schemas.task} daily={false} disabled={locked} onChange={setTaskMap} />
          <Mapping map={dailyMap} source={schemas.daily} daily disabled={locked} onChange={setDailyMap} />
          <button className="btn" type="submit" data-variant="primary" disabled={locked}>Save connection</button>
        </>}
        {notion?.tokenPresent && <button className="btn" type="button" disabled={locked} onClick={() => void run(() => window.stoke.work.notionDisconnect())}>Disconnect and remove token</button>}
      </form>
    </details>
    {notion?.config && notion.tokenPresent && <div data-setting="worklog.publish">
      <p className="work-note">Publishing is a separate decision from approving or starting a task. Only the mapped fields in the reviewed rows are written.</p>
      <button className="btn" disabled={locked || !selection} onClick={prepare}>Review saved fields for Notion</button>
      {review && <div className="work-publish-review">
        <h4>Publish these saved records?</h4>
        {review.rows.map((row, index) => <div className="work-publish-row" key={index}>
          <p className="work-note">{row.destination} · {review.request.day}</p><strong>{row.title}</strong>
          <dl><dt>Status</dt><dd>{row.status}</dd>{row.project !== undefined && <><dt>Project</dt><dd>{row.project || 'Empty'}</dd></>}{row.task !== undefined && <><dt>Task relation</dt><dd>{row.task}</dd></>}<dt>Brief or notes</dt><dd>{row.body || 'Empty'}</dd><dt>Evidence</dt><dd>{row.evidence || 'Empty'}</dd></dl>
        </div>)}
        <div className="work-actions"><button className="btn" data-variant="primary" disabled={locked} onClick={() => void run(() => window.stoke.work.notionPublish(review.request))}>Publish to Notion</button><button className="btn" disabled={locked} onClick={() => setReview(null)}>Cancel</button></div>
      </div>}
    </div>}
    {notion && notion.operations.length > 0 && <details className="work-journal" open={notion.operations.some((o) => o.state !== 'completed')}>
      <summary><span>Notion publish history</span> · {notion.operations.filter((o) => o.state !== 'completed').length} pending</summary>
      {notion.operations.slice().reverse().map((operation) => <div className="work-journal-entry" key={operation.id}>
        <strong>{operation.steps[0]?.local.title} · {operation.state}</strong>
        <p className="work-note" role={operation.state === 'completed' ? undefined : 'status'}>{operation.message || 'Preparing the saved operation…'}</p>
        {operation.steps.map((step) => <p className="work-note" key={step.recordId}>{step.kind === 'task' ? 'Task' : 'Daily work'}: {step.state}{step.page && <> · <a href={step.page.url} target="_blank" rel="noreferrer">Open in Notion</a></>}</p>)}
        {operation.state !== 'completed' && <button className="btn" disabled={locked || !notion.config || !notion.tokenPresent} onClick={() => void run(() => window.stoke.work.notionRetry(operation.id))}>{operation.state === 'unknown' ? 'Retry lookup' : 'Retry saved operation'}</button>}
        {operation.steps.filter((s) => s.state === 'conflict' && s.page).map((step) => <div className="work-conflict" key={step.recordId}>
          <table><thead><tr><th>Field</th><th>Proposed in Stoke</th><th>Current in Notion</th></tr></thead><tbody>
            {(['title', 'body', 'status', 'evidence', 'project', 'day', 'taskPageId'] as const).filter((key) => step.local[key] !== undefined || step.page!.fields[key] !== undefined).map((key) => <tr key={key}><th>{key === 'taskPageId' ? 'Task relation' : key}</th><td>{step.local[key] || 'Empty'}</td><td>{step.page!.fields[key] || 'Empty'}</td></tr>)}
          </tbody></table>
          <div className="work-actions"><button className="btn" disabled={locked || !notion.tokenPresent} onClick={() => void run(() => window.stoke.work.notionResolve(operation.id, 'notion'))}>Use reviewed Notion fields</button><button className="btn" disabled={locked || !notion.tokenPresent} onClick={() => void run(() => window.stoke.work.notionResolve(operation.id, 'stoke'))}>Publish reviewed Stoke fields</button></div>
        </div>)}
      </div>)}
    </details>}
  </section>
}
