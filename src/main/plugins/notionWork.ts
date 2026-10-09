import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mergeNotionFields } from '../../shared/workNotion.ts'
import { validWorkDay } from '../../shared/workPlugin.ts'
import type { NotionFields, NotionPage, NotionSource, WorkNotionConfig, WorkNotionLink, WorkNotionOperation, WorkNotionPublishRequest, WorkNotionStep, WorkNotionView } from '../../shared/workNotion.ts'
import type { WorkDaily, WorkTask, WorkView } from '../../shared/workPlugin.ts'
import { NotionClient, NotionError, validateNotionMapping } from './notion.ts'
import { emptyNotionState, readNotionState } from './notionJournal.ts'
import { PluginStorage } from './storage.ts'
import type { WorkCredentials } from './workCredentials.ts'
import type { WorkPlugin } from './work.ts'

interface Deps {
  work: WorkPlugin
  credentials: WorkCredentials
  fetch?: typeof fetch
  onWork?: (view: WorkView) => void
  onChange?: (view: WorkNotionView) => void
}
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const sameFields = (a: NotionFields, b: NotionFields): boolean => ['title', 'body', 'status', 'identity', 'evidence', 'project', 'day', 'taskPageId'].every((key) => a[key as keyof NotionFields] === b[key as keyof NotionFields])
class NotionImportConflict extends Error {}

function savedFields(row: WorkTask | WorkDaily, config: WorkNotionConfig, links: WorkNotionLink[]): NotionFields {
  const fields: NotionFields = { identity: row.id, title: row.title, body: 'brief' in row ? row.brief : row.notes, status: 'brief' in row ? config.task.states[row.status] : config.daily.states[row.status], evidence: row.evidence }
  if ('brief' in row) fields.project = row.project
  else { fields.day = row.day; fields.taskPageId = row.taskId ? links.find(l => l.recordId === row.taskId && l.connectionId === config.connectionId)?.id ?? null : null }
  return fields
}

/** All external writes are explicit and journaled; there is no sync timer. */
export class NotionWork {
  private deps: Deps
  private store: PluginStorage<ReturnType<typeof emptyNotionState>>
  private running = false
  private stopped = false
  private active: AbortController | null = null
  constructor(userData: string, deps: Deps) {
    this.deps = deps
    this.store = new PluginStorage(join(userData, 'plugins', 'work-notion.json'), readNotionState, emptyNotionState)
  }
  async view(): Promise<WorkNotionView> {
    const [state, tokenPresent] = await Promise.all([this.store.read(), this.deps.credentials.present()])
    if (!this.running) for (const operation of state.operations) {
      if (operation.steps.some((s) => s.state === 'creating' || s.state === 'updating')) {
        operation.state = 'unknown'; operation.message = 'A previous write was interrupted. Retry its lookup before publishing again.'
      }
    }
    return { ...state, tokenPresent, running: this.running }
  }
  private async emit(): Promise<void> { this.deps.onChange?.(await this.view()) }
  private claim<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.running || this.stopped) return Promise.reject(new Error('A Notion operation is running or stopped. Wait before retrying.'))
    this.running = true; const controller = new AbortController(); this.active = controller
    const timer = setTimeout(() => controller.abort(), 180_000)
    return fn(controller.signal).finally(() => { clearTimeout(timer); this.running = false; this.active = null; void this.emit().catch(() => {}) })
  }
  private async client(token?: unknown): Promise<NotionClient> {
    if (token !== undefined && typeof token !== 'string') throw new Error('Enter a valid Notion token.')
    const actual = typeof token === 'string' && token.trim() ? token.trim() : await this.deps.credentials.read()
    if (!actual) throw new Error('Add a Notion integration token first.')
    return new NotionClient(actual, { fetch: this.deps.fetch })
  }
  inspect(taskSource: string, dailySource: string, token?: string): Promise<{ task: NotionSource; daily: NotionSource }> {
    return this.claim(async (signal) => {
      if (!(await this.deps.work.read()).enabled) throw new Error('Enable Work before connecting Notion.')
      const client = await this.client(token)
      const [task, daily] = await Promise.all([client.source(taskSource, signal), client.source(dailySource, signal)])
      return { task, daily }
    })
  }
  configure(mapping: unknown, token?: string): Promise<WorkNotionView> {
    return this.claim(async (signal) => {
      if (!(await this.deps.work.read()).enabled) throw new Error('Enable Work before connecting Notion.')
      if (!record(mapping) || !record(mapping.task) || !record(mapping.daily) || typeof mapping.task.source !== 'string' || typeof mapping.daily.source !== 'string') throw new Error('Map both Notion tables first.')
      const client = await this.client(token)
      const [task, daily] = await Promise.all([client.source(mapping.task.source, signal), client.source(mapping.daily.source, signal)])
      const maps = validateNotionMapping(mapping, task, daily)
      const connectionId = createHash('sha256').update(JSON.stringify(maps)).digest('hex')
      const before = await this.store.read()
      if (before.operations.some((o) => o.state !== 'completed' && o.connectionId !== connectionId)) throw new Error('Finish the pending Notion operations before changing tables or mappings.')
      signal.throwIfAborted()
      if (!(await this.deps.work.read()).enabled) throw new Error('Work was disabled while checking the connection.')
      if (token?.trim()) await this.deps.credentials.write(token.trim())
      await this.store.change((s) => { s.config = { ...maps, connectionId, taskLabel: task.name, dailyLabel: daily.name }; s.revision++; return s })
      await this.emit(); return this.view()
    })
  }
  disconnect(): Promise<WorkNotionView> {
    return this.claim(async () => {
      await this.deps.credentials.write('')
      await this.store.change((s) => { s.config = null; s.revision++; return s })
      await this.emit(); return this.view()
    })
  }
  private async guard(connection: string, signal: AbortSignal): Promise<WorkNotionConfig> {
    signal.throwIfAborted()
    const [work, state] = await Promise.all([this.deps.work.read(), this.store.read()])
    if (!work.enabled || this.stopped) throw new Error('Work is disabled. The saved Notion operation can be checked after enabling it.')
    if (!state.config || state.config.connectionId !== connection) throw new Error('This operation belongs to another Notion connection. Restore its mapping before retrying.')
    return state.config
  }
  publish(raw: WorkNotionPublishRequest): Promise<WorkNotionView> {
    return this.prepare(raw, 'publish')
  }
  refresh(raw: WorkNotionPublishRequest): Promise<WorkNotionView> {
    return this.prepare(raw, 'refresh')
  }
  private prepare(raw: WorkNotionPublishRequest, mode: 'publish' | 'refresh'): Promise<WorkNotionView> {
    return this.claim(async (signal) => {
      if (!record(raw) || !['task', 'daily'].includes(raw.kind as string) || typeof raw.id !== 'string' || !validWorkDay(raw.day) || typeof raw.revision !== 'number' || typeof raw.connectionId !== 'string') throw new Error('Review the saved Work record before publishing it.')
      const config = await this.guard(raw.connectionId, signal)
      const work = await this.deps.work.read()
      const state = await this.store.read()
      const steps: WorkNotionStep[] = []
      const add = (row: WorkTask | WorkDaily): void => {
        const kind = 'brief' in row ? 'task' : 'daily'
        const base = state.links.find(l => l.recordId === row.id && l.connectionId === config.connectionId) ?? null
        if (mode === 'refresh' && !base) {
          if (row.id === raw.id) throw new Error('Publish this record once before reading its linked Notion fields.')
          return
        }
        const desired = savedFields(row, config, state.links)
        steps.push({ kind, recordId: row.id, revision: row.revision, desired, local: structuredClone(desired), ...(kind === 'daily' ? { taskId: (row as WorkDaily).taskId } : {}), base, state: 'pending', page: null })
      }
      if (raw.kind === 'task') {
        const task = work.tasks.find((r) => r.id === raw.id)
        const daily = work.daily.find((r) => r.taskId === raw.id && r.day === raw.day)
        if (!task || task.revision !== raw.revision || daily?.revision !== raw.relatedRevision) throw new Error('The task or its daily entry changed. Review the current fields before publishing.')
        add(task); if (daily) add(daily)
      } else {
        const daily = work.daily.find((r) => r.id === raw.id)
        const task = daily?.taskId ? work.tasks.find((r) => r.id === daily.taskId) : undefined
        if (!daily || daily.day !== raw.day || daily.revision !== raw.revision || task?.revision !== raw.relatedRevision) throw new Error('The daily entry or its task changed. Review the current fields before publishing.')
        if (task) add(task); add(daily)
      }
      if (state.operations.some((o) => o.state !== 'completed' && o.steps.some((s) => steps.some((p) => p.recordId === s.recordId)))) throw new Error('A saved operation already owns this record. Retry or resolve that operation first.')
      const operation: WorkNotionOperation = { id: randomUUID(), connectionId: config.connectionId, createdAt: Date.now(), state: 'pending', message: '', steps, mode }
      await this.store.change((s) => {
        if (s.operations.length >= 200) {
          const finished = s.operations.findIndex((o) => o.state === 'completed')
          if (finished < 0) throw new Error('The Notion journal is full. Resolve pending operations first.')
          s.operations.splice(finished, 1)
        }
        s.operations.push(operation); s.revision++; return s
      })
      await this.run(operation.id, signal)
      return this.view()
    })
  }
  retry(id: string): Promise<WorkNotionView> { return this.claim(async (signal) => { await this.run(id, signal); return this.view() }) }
  resolve(id: string, choice: 'stoke' | 'notion'): Promise<WorkNotionView> {
    return this.claim(async (signal) => {
      if (!['stoke', 'notion'].includes(choice)) throw new Error('Choose which reviewed fields to keep.')
      const operation = (await this.store.read()).operations.find((o) => o.id === id)
      const index = operation?.steps.findIndex((s) => s.state === 'conflict') ?? -1
      const step = operation?.steps[index]
      if (!operation || !step?.page) throw new Error('This operation has no conflict to review.')
      const config = await this.guard(operation.connectionId, signal)
      const client = await this.client()
      const map = step.kind === 'task' ? config.task : config.daily
      const current = await client.page(step.page.id, map, signal)
      if (current.fields.identity !== step.recordId) throw new Error('This Notion row now has another Stoke ID. Resolve its identity first.')
      if (!sameFields(current.fields, step.page.fields)) {
        await this.updateOperation(id, (o) => { o.steps[index].page = current; o.message = 'Notion changed again. Review the refreshed fields before choosing a version.' })
        return this.view()
      }
      if (operation.mode === 'refresh') {
        if (choice === 'notion') {
          const work = await this.deps.work.read()
          const row = (step.kind === 'task' ? work.tasks : work.daily).find(r => r.id === step.recordId)
          if (!row || row.revision !== step.revision) {
            await this.updateOperation(id, o => { o.message = 'Stoke changed after this read. Retry the saved read to review its current fields.' })
            return this.view()
          }
          if (step.kind === 'daily' && (current.fields.day !== step.local.day || current.fields.taskPageId !== step.local.taskPageId)) throw new Error('Restore the daily date and task relation in Notion before adopting its fields.')
          await this.updateOperation(id, o => { o.steps[index].refreshChoice = 'notion' })
          await this.confirm(id, index, current, config)
        } else {
          // Keep the board. A later explicit publish may propose these local
          // differences against the newly acknowledged remote baseline.
          await this.acknowledgeRefresh(id, index, current, config)
        }
        await this.run(id, signal)
        return this.view()
      }
      if (choice === 'notion') {
        // Date and task-relation changes require restoring the intended link first.
        if (step.kind === 'daily' && (current.fields.day !== step.local.day || current.fields.taskPageId !== step.local.taskPageId)) throw new Error('Restore the daily date and task relation in Notion before adopting its fields.')
        await this.confirm(id, index, current, config)
      } else {
        await this.updateOperation(id, (o) => {
          o.steps[index].base = { ...current, recordId: step.recordId, connectionId: config.connectionId, localBase: structuredClone(current.fields) }
          o.steps[index].desired = structuredClone(step.local)
          o.steps[index].state = 'pending'; o.state = 'pending'; o.message = ''
        })
      }
      await this.run(id, signal)
      return this.view()
    })
  }
  private async acknowledgeRefresh(id: string, index: number, page: NotionPage, config: WorkNotionConfig): Promise<void> {
    await this.store.change(state => {
      const operation = state.operations.find(o => o.id === id)!
      const step = operation.steps[index]
      state.links = state.links.filter(l => l.recordId !== step.recordId || l.connectionId !== config.connectionId)
      state.links.push({ ...page, connectionId: config.connectionId, recordId: step.recordId, localBase: structuredClone(page.fields) })
      step.page = page; step.state = 'confirmed'; step.refreshChoice = 'stoke'
      state.revision++; return state
    })
    await this.emit()
  }
  private async runRefresh(id: string, signal: AbortSignal): Promise<void> {
    try {
      const operation = (await this.store.read()).operations.find(o => o.id === id)!
      const config = await this.guard(operation.connectionId, signal)
      const client = await this.client()
      const [task, daily] = await Promise.all([client.source(config.task.source, signal), client.source(config.daily.source, signal)])
      validateNotionMapping(config, task, daily)
      for (let index = 0; index < operation.steps.length; index++) {
        await this.guard(operation.connectionId, signal)
        const step = operation.steps[index]
        if (step.state === 'confirmed' && step.page) {
          if (step.refreshChoice === 'notion') await this.finishLocal(id, index, step, config, step.page)
          continue
        }
        if (!step.base) throw new Error('This read has no linked Notion page. Publish the record before reading it.')
        const work = await this.deps.work.read(), state = await this.store.read()
        const row = (step.kind === 'task' ? work.tasks : work.daily).find(r => r.id === step.recordId)
        if (!row) throw new Error('The local Work record is missing.')
        const fields = savedFields(row, config, state.links)
        const page = await client.page(step.base.id, step.kind === 'task' ? config.task : config.daily, signal)
        await this.guard(operation.connectionId, signal)
        if (page.fields.identity !== step.recordId) throw new Error('This Notion row now has another Stoke ID. No local fields were changed.')
        await this.updateOperation(id, o => {
          o.steps[index].local = fields; o.steps[index].desired = structuredClone(fields); o.steps[index].revision = row.revision; o.steps[index].page = page
        })
        if (!sameFields(fields, page.fields)) {
          await this.updateOperation(id, o => { o.steps[index].state = 'conflict'; o.state = 'conflict'; o.message = 'Read from Notion. Review both versions before applying its fields; this read makes no changes in Notion.' })
          return
        }
        await this.acknowledgeRefresh(id, index, page, config)
      }
      await this.updateOperation(id, o => { o.state = 'completed'; o.message = 'Notion read reviewed. Publish separately to send local changes.' })
    } catch (error) {
      await this.updateOperation(id, o => { o.state = o.steps.some(s => s.state === 'conflict') ? 'conflict' : 'pending'; o.message = (error instanceof Error ? error.message : 'Notion could not finish this read.').slice(0, 2048) })
    }
  }
  private async updateOperation(id: string, edit: (op: WorkNotionOperation) => void): Promise<WorkNotionOperation> {
    const next = await this.store.change((state) => {
      const op = state.operations.find((o) => o.id === id)
      if (!op) throw new Error('The saved Notion operation is missing.')
      edit(op); state.revision++; return state
    })
    await this.emit(); return next.operations.find((o) => o.id === id)!
  }
  private async confirmLocal(operationId: string, index: number, step: WorkNotionStep, config: WorkNotionConfig, page: NotionPage): Promise<boolean> {
    const states = step.kind === 'task' ? config.task.states : config.daily.states
    const status = Object.entries(states).find(([, label]) => label === page.fields.status)?.[0]
    if (!status) throw new NotionImportConflict('Notion changed the row to an unmapped status. Review its status before continuing.')
    if (status === 'Completed' && !page.fields.evidence.trim()) throw new NotionImportConflict('The Notion row is completed without evidence. Add evidence in Notion before adopting it.')
    if (step.kind === 'daily' && (page.fields.day !== step.desired.day || page.fields.taskPageId !== step.desired.taskPageId)) throw new NotionImportConflict('Notion changed the daily date or task relation. Review those fields before continuing.')
    const receipt = `${operationId}:${index}:${createHash('sha256').update(JSON.stringify(page.fields)).digest('hex').slice(0, 24)}`
    const result = await this.deps.work.confirmNotion(step.kind, step.recordId, step.revision, page.fields, status as WorkTask['status'] | WorkDaily['status'], receipt)
    this.deps.onWork?.(result.view)
    return result.applied
  }
  private async confirm(id: string, index: number, page: NotionPage, config: WorkNotionConfig): Promise<void> {
    const operation = (await this.store.read()).operations.find((o) => o.id === id)
    const step = operation?.steps[index]
    if (!step) throw new Error('The saved Notion operation is missing.')
    const states = step.kind === 'task' ? config.task.states : config.daily.states
    if (!Object.values(states).includes(page.fields.status) || page.fields.status === states.Completed && !page.fields.evidence.trim()) throw new NotionImportConflict('The Notion status is unmapped or completed without evidence. Correct it in Notion before adopting it.')
    const state = await this.store.change((s) => {
      const op = s.operations.find((o) => o.id === id)!
      const step = op.steps[index]
      if (page.fields.identity !== step.recordId) throw new Error('The Notion row has another Stoke ID. No local link was changed.')
      const link = { ...page, recordId: step.recordId, connectionId: config.connectionId, localBase: structuredClone(step.local) }
      s.links = s.links.filter((l) => l.recordId !== step.recordId || l.connectionId !== config.connectionId)
      s.links.push(link); step.page = page; step.state = 'confirmed'; s.revision++; return s
    })
    await this.emit()
    await this.finishLocal(id, index, state.operations.find((o) => o.id === id)!.steps[index], config, page)
  }
  private async finishLocal(id: string, index: number, step: WorkNotionStep, config: WorkNotionConfig, page: NotionPage): Promise<void> {
    if (await this.confirmLocal(id, index, step, config, page)) {
      await this.store.change((s) => {
        const link = s.links.find((l) => l.recordId === step.recordId && l.connectionId === config.connectionId)
        if (link) link.localBase = structuredClone(page.fields)
        s.revision++; return s
      })
    }
  }
  private async run(id: string, signal: AbortSignal): Promise<void> {
    let operation = (await this.store.read()).operations.find((o) => o.id === id)
    if (!operation) throw new Error('The saved Notion operation is missing.')
    if (operation.mode === 'refresh') return this.runRefresh(id, signal)
    let index = 0
    try {
      const config = await this.guard(operation.connectionId, signal)
      const client = await this.client()
      const [taskSchema, dailySchema] = await Promise.all([client.source(config.task.source, signal), client.source(config.daily.source, signal)])
      validateNotionMapping(config, taskSchema, dailySchema)
      for (index = 0; index < operation.steps.length; index++) {
        await this.guard(operation.connectionId, signal)
        let step = operation.steps[index]
        const map = step.kind === 'task' ? config.task : config.daily
        const schema = step.kind === 'task' ? taskSchema : dailySchema
        if (step.state === 'confirmed' && step.page) { await this.finishLocal(id, index, step, config, step.page); continue }
        if (step.taskId) {
          const link = (await this.store.read()).links.find((l) => l.recordId === step.taskId && l.connectionId === config.connectionId)
          if (!link) throw new Error('The related task has no confirmed Notion page yet.')
          operation = await this.updateOperation(id, (o) => { o.steps[index].desired.taskPageId = link.id; o.steps[index].local.taskPageId = link.id })
          step = operation.steps[index]
        }
        const unknown = ['creating', 'updating', 'unknown'].includes(step.state)
        const linked = step.page ?? step.base
        let remote = linked ? await client.page(linked.id, map, signal) : await client.find(map, step.recordId, signal)
        if (!remote && unknown) {
          await this.updateOperation(id, (o) => { o.steps[index].state = 'unknown'; o.state = 'unknown'; o.message = 'No matching row is visible yet. Retry the lookup later; Stoke will not repeat an uncertain create.' })
          return
        }
        if (remote) {
          if (remote.fields.identity !== step.recordId) throw new Error('The linked Notion row has another Stoke ID. Resolve the identity before retrying.')
          const base = step.base?.fields
          const merged = base ? mergeNotionFields(base, step.desired, remote.fields, step.base?.localBase ?? base) : { fields: step.desired, conflicts: sameFields(step.desired, remote.fields) ? [] : ['existing row'] }
          if (step.kind === 'daily' && (remote.fields.day !== step.desired.day || remote.fields.taskPageId !== step.desired.taskPageId)) merged.conflicts.push('date or task relation')
          if (merged.conflicts.length) {
            await this.updateOperation(id, (o) => { o.steps[index].state = 'conflict'; o.steps[index].page = remote; o.state = 'conflict'; o.message = `Notion and Stoke differ: ${merged.conflicts.join(', ')}. Review both versions before continuing.` })
            return
          }
          // Validate adoption before any PATCH, including externally completed rows.
          const mapped = Object.values(step.kind === 'task' ? config.task.states : config.daily.states)
          if (!mapped.includes(merged.fields.status) || merged.fields.status === (step.kind === 'task' ? config.task.states.Completed : config.daily.states.Completed) && !merged.fields.evidence.trim()) {
            await this.updateOperation(id, (o) => { o.steps[index].state = 'conflict'; o.steps[index].page = remote; o.state = 'conflict'; o.message = 'Notion has an unmapped or evidence-free completed status. Correct it in Notion before adopting it.' })
            return
          }
          if (!sameFields(merged.fields, remote.fields)) {
            operation = await this.updateOperation(id, (o) => { o.steps[index].state = 'updating'; o.steps[index].page = remote; o.steps[index].desired = merged.fields })
            await this.guard(operation.connectionId, signal)
            remote = await client.update(remote.id, map, merged.fields, schema, signal)
          }
          await this.confirm(id, index, remote, config)
        } else {
          operation = await this.updateOperation(id, (o) => { o.steps[index].state = 'creating' })
          await this.guard(operation.connectionId, signal)
          remote = await client.create(map, step.desired, schema, signal)
          await this.confirm(id, index, remote, config)
        }
        operation = (await this.store.read()).operations.find((o) => o.id === id)!
      }
      await this.updateOperation(id, (o) => { o.state = 'completed'; o.message = 'Published. Any newer local edits remain pending for a separate review.' })
    } catch (err) {
      const message = (err instanceof Error ? err.message : 'Notion could not finish the operation.').slice(0, 2048)
      await this.updateOperation(id, (o) => {
        const step = o.steps[index]
        if (step && err instanceof NotionImportConflict) step.state = 'conflict'
        if (step && step.state !== 'confirmed' && ['creating', 'updating'].includes(step.state)) step.state = err instanceof NotionError && !err.uncertain ? 'pending' : 'unknown'
        o.state = step?.state === 'conflict' ? 'conflict' : step?.state === 'unknown' ? 'unknown' : o.steps.some((s) => s.state === 'confirmed') ? 'partial' : 'pending'
        o.message = message
      })
    }
  }
  pause(): void { this.active?.abort() }
  stop(): void { this.stopped = true; this.pause(); this.store.stop() }
}
