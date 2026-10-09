import { randomUUID } from 'node:crypto'
import { mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { WORK_PLUGIN, type BuiltinStokePlugin } from '../../shared/plugins.ts'
import { DAILY_STATES, TASK_STATES, validWorkDay } from '../../shared/workPlugin.ts'
import type { WorkCommand, WorkDaily, WorkState, WorkTask, WorkView } from '../../shared/workPlugin.ts'

const MAX_RECORDS = 5000
const MAX_BYTES = 16 * 1024 * 1024
const DEADLINE_MS = 5000
const blank = (): WorkState => ({ schema: 1, revision: 0, enabled: false, tasks: [], daily: [] })

function text(value: unknown, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max || /\u0000/.test(value)) throw new Error('That field is missing or too long.')
  const result = value.trim()
  if (required && !result) throw new Error('Add a title or completion evidence first.')
  return result
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function numeric(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}
/** Refuse malformed stores without overwriting them or losing unknown versions. */
export function readWorkState(value: unknown): WorkState {
  if (!record(value) || value.schema !== 1 || !numeric(value.revision) || typeof value.enabled !== 'boolean' || !Array.isArray(value.tasks) || !Array.isArray(value.daily)) throw new Error('The saved Work boards cannot be read. Keep the file for recovery.')
  if (value.tasks.length > MAX_RECORDS || value.daily.length > MAX_RECORDS) throw new Error('The Work boards exceed their record limit.')
  const ids = new Set<string>()
  const identity = (r: Record<string, unknown>): void => {
    text(r.id, 100, true)
    if (ids.has(r.id as string) || !numeric(r.revision) || !numeric(r.createdAt) || !numeric(r.updatedAt)) throw new Error('The saved Work record has an invalid identity.')
    ids.add(r.id as string)
    if (r.sessionId !== null) text(r.sessionId, 100, true)
    text(r.title, 240, true); text(r.evidence, 8000)
  }
  for (const r of value.tasks) {
    if (!record(r)) throw new Error('The saved task cannot be read.')
    identity(r); text(r.brief, 16000); text(r.project, 2048)
    if (!TASK_STATES.includes(r.status as WorkTask['status'])) throw new Error('The saved task status cannot be read.')
    if (r.status === 'Completed') text(r.evidence, 8000, true)
  }
  const pairs = new Set<string>()
  const taskIds = new Set(value.tasks.map((r) => r.id))
  for (const r of value.daily) {
    if (!record(r)) throw new Error('The saved daily entry cannot be read.')
    identity(r); text(r.notes, 16000); text(r.timezone, 100, true)
    if (!validWorkDay(r.day) || !DAILY_STATES.includes(r.status as WorkDaily['status'])) throw new Error('The saved daily entry has an invalid date or status.')
    if (r.status === 'Completed') text(r.evidence, 8000, true)
    if (r.taskId !== null) {
      if (!taskIds.has(r.taskId)) throw new Error('The saved daily entry names a missing task.')
      const key = `${r.taskId}:${r.day}`
      if (pairs.has(key)) throw new Error('The saved daily entry is duplicated.')
      pairs.add(key)
    }
  }
  return structuredClone(value) as unknown as WorkState
}

/** Deterministic transitions. Approval never launches an agent or publishes a row. */
export function changeWork(state: WorkState, raw: unknown, now: number, makeId: () => string, timezone: string): WorkState {
  if (!record(raw) || typeof raw.kind !== 'string') throw new Error('Choose a Work action first.')
  const command = raw as unknown as WorkCommand
  const next = structuredClone(state)
  if (command.kind === 'enable') {
    if (typeof command.enabled !== 'boolean') throw new Error('Choose whether Work is enabled.')
    next.enabled = command.enabled
  } else {
    if (!state.enabled) throw new Error('Enable the Work plugin first. Your records are still saved.')
    if (command.kind === 'idea') {
      if (next.tasks.length >= MAX_RECORDS) throw new Error('The task board is full.')
      next.tasks.push({ id: makeId(), revision: 1, title: text(command.title, 240, true), brief: text(command.brief, 16000), project: text(command.project, 2048), status: 'Idea', sessionId: null, evidence: '', createdAt: now, updatedAt: now })
    } else if (command.kind === 'daily') {
      if (!validWorkDay(command.day)) throw new Error('Choose a valid local date.')
      if (next.daily.length >= MAX_RECORDS) throw new Error('The daily board is full.')
      next.daily.push({ id: makeId(), revision: 1, title: text(command.title, 240, true), notes: text(command.notes, 16000), day: command.day, timezone, taskId: null, status: 'To-Do', evidence: '', sessionId: null, createdAt: now, updatedAt: now })
    } else if (command.kind === 'daily-edit') {
      const entry = next.daily.find((r) => r.id === command.id)
      if (!entry || entry.revision !== command.revision) throw new Error('This daily entry changed. Refresh it before saving.')
      if (!DAILY_STATES.includes(command.status)) throw new Error('Choose a daily status.')
      if (entry.taskId && command.status === 'Working on' && !['Working', 'Completed'].includes(next.tasks.find((r) => r.id === entry.taskId)?.status ?? '')) throw new Error('Approve and start this task before logging work on it.')
      entry.status = command.status; entry.notes = text(command.notes, 16000); entry.evidence = text(command.evidence, 8000, command.status === 'Completed')
      entry.revision++; entry.updatedAt = now
    } else {
      const task = next.tasks.find((r) => r.id === command.id)
      if (!task || task.revision !== command.revision) throw new Error('This task changed. Refresh it before saving.')
      if (command.kind === 'edit') {
        if (task.status !== 'Idea') throw new Error('Only ideas can be edited before approval.')
        task.title = text(command.title, 240, true); task.brief = text(command.brief, 16000); task.project = text(command.project, 2048)
        for (const entry of next.daily.filter((r) => r.taskId === task.id && r.status === 'To-Do')) {
          entry.title = task.title; entry.revision++; entry.updatedAt = now
        }
      } else {
        if (!validWorkDay(command.day)) throw new Error('Choose a valid local date.')
        if (command.kind === 'approve') {
          if (task.status !== 'Idea') throw new Error('Only an idea can be approved.')
          task.status = 'Approved'
        } else if (command.kind === 'start') {
          if (task.status !== 'Approved') throw new Error('Approve this task before starting it.')
          task.status = 'Working'; task.sessionId = command.sessionId ? text(command.sessionId, 100, true) : null
        } else if (command.kind === 'complete') {
          if (task.status !== 'Working') throw new Error('Start this task before completing it.')
          task.evidence = text(command.evidence, 8000, true); task.status = 'Completed'
        } else if (command.kind === 'plan') {
          if (task.status === 'Completed') throw new Error('This task is already completed.')
        } else throw new Error('That Work action is unavailable.')
        if (command.kind !== 'approve') {
          let entry = next.daily.find((r) => r.taskId === task.id && r.day === command.day)
          if (!entry) {
            if (next.daily.length >= MAX_RECORDS) throw new Error('The daily board is full.')
            entry = { id: makeId(), revision: 0, taskId: task.id, day: command.day, timezone, title: task.title, status: 'To-Do', notes: '', evidence: '', sessionId: null, createdAt: now, updatedAt: now }
            next.daily.push(entry)
          }
          if (command.kind === 'start') { entry.status = 'Working on'; entry.sessionId = task.sessionId }
          if (command.kind === 'complete') { entry.status = 'Completed'; entry.evidence = task.evidence; entry.sessionId = task.sessionId }
          entry.revision++; entry.updatedAt = now
        }
      }
      task.revision++; task.updatedAt = now
    }
  }
  next.revision++
  return next
}

/** Local, durable module storage. Each mutation claims the serial queue before any await. */
export class WorkPlugin implements BuiltinStokePlugin<WorkView, unknown, WorkView> {
  readonly manifest = WORK_PLUGIN
  readonly file: string
  private state: WorkState | null = null
  private chain: Promise<unknown> = Promise.resolve()
  private stopped = false
  private controllers = new Set<AbortController>()
  constructor(userData: string) { this.file = join(userData, 'plugins', 'work.json') }

  private enqueue<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.stopped) return Promise.reject(new Error('The Work plugin has stopped.'))
    if (this.controllers.size >= 8) return Promise.reject(new Error('Work storage is busy. Wait before retrying.'))
    const controller = new AbortController()
    this.controllers.add(controller)
    const expired = new Promise<T>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Work storage took too long. Refresh the boards before retrying; a save may have finished.')), { once: true }))
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS)
    const run = this.chain.then(async () => {
      try {
        if (this.stopped) throw new Error('The Work plugin has stopped.')
        controller.signal.throwIfAborted(); return await fn(controller.signal)
      } finally { clearTimeout(timer); this.controllers.delete(controller) }
    })
    // Keep ownership until even an uninterruptible rename settles.
    this.chain = run.catch(() => {})
    return Promise.race([run, expired])
  }
  private async load(signal: AbortSignal): Promise<WorkState> {
    if (this.state) return this.state
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      handle = await open(this.file, 'r'); signal.throwIfAborted()
      if ((await handle.stat()).size > MAX_BYTES) throw new Error('The saved Work boards are too large.')
      const body = await handle.readFile({ encoding: 'utf8', signal })
      let parsed: unknown
      try { parsed = JSON.parse(body) } catch { throw new Error('The saved Work boards contain invalid JSON. Keep the file for recovery.') }
      this.state = readWorkState(parsed)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      signal.throwIfAborted()
      this.state = blank()
    } finally { await handle?.close() }
    return this.state
  }
  read(): Promise<WorkView> {
    return this.enqueue(async (signal) => ({ ...structuredClone(await this.load(signal)), manifest: WORK_PLUGIN }))
  }
  change(command: unknown): Promise<WorkView> {
    return this.enqueue(async (signal) => {
      const previous = await this.load(signal)
      const next = changeWork(previous, command, Date.now(), randomUUID, Intl.DateTimeFormat().resolvedOptions().timeZone)
      const body = JSON.stringify(next)
      if (Buffer.byteLength(body) > MAX_BYTES) throw new Error('The Work boards exceed their storage limit.')
      const folder = dirname(this.file)
      await mkdir(folder, { recursive: true, mode: 0o700 }); signal.throwIfAborted()
      const temporary = `${this.file}.${randomUUID()}.tmp`
      let handle: Awaited<ReturnType<typeof open>> | null = null
      try {
        handle = await open(temporary, 'wx', 0o600); signal.throwIfAborted()
        await handle.writeFile(body, { encoding: 'utf8', signal }); await handle.sync(); await handle.close(); handle = null
        signal.throwIfAborted(); await rename(temporary, this.file)
        this.state = next
      } finally { await handle?.close(); await rm(temporary, { force: true }) }
      return { ...structuredClone(next), manifest: WORK_PLUGIN }
    })
  }
  /** No timers or external writes in the local board; queued requests stop on quit. */
  stop(): void { this.stopped = true; for (const controller of this.controllers) controller.abort(); this.controllers.clear() }
}
