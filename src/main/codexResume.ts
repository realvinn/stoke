import { codexLimitReset, hydrateCodexResume, type CodexResumeObservation, type CodexResumeSettings } from '../shared/codexResume.ts'

interface Watch {
  due: number
  stopped: boolean
  limit: { signature: string; resetAt: number | null } | null
  inputAt: number | null
  attemptedOutputAt: number | null
}

/** Independent of the model and its usage budget. The owner supplies live terminal observations. */
export class CodexResumeWatcher {
  private settings = hydrateCodexResume(null)
  private watches = new Map<string, Watch>()
  get enabled(): boolean { return this.settings.enabled }

  configure(raw: CodexResumeSettings): void {
    const next = hydrateCodexResume(raw)
    if (next.enabled !== this.settings.enabled) this.watches.clear()
    this.settings = next
  }

  forget(id: string): void { this.watches.delete(id) }
  cancel(id: string): void {
    if (!this.settings.enabled) return
    const watch = this.watches.get(id)
    if (watch && (watch.limit || watch.attemptedOutputAt !== null)) watch.stopped = true
  }
  dispose(): void { this.watches.clear() }

  tick(ids: readonly string[], read: (id: string) => CodexResumeObservation | null, submit: (id: string, message: string, limit: { signature: string; resetAt: number | null }) => boolean, now = Date.now()): void {
    if (!this.settings.enabled) return
    const live = new Set(ids)
    for (const id of this.watches.keys()) if (!live.has(id)) this.forget(id)
    for (const id of ids) {
      let watch = this.watches.get(id)
      if (!watch) {
        watch = { due: now + this.settings.checkMinutes * 60000, stopped: false, limit: null, inputAt: null, attemptedOutputAt: null }
        this.watches.set(id, watch)
      }
      if (watch.stopped || now < watch.due) continue
      const observation = read(id)
      if (!observation) { watch.due = now + this.settings.checkMinutes * 60000; continue }
      if (/esc to (?:interrupt|cancel)|working\s*\(/i.test(observation.text)) { watch.stopped = true; continue }
      // Wait for xterm's queued writes and the CLI's current repaint to settle.
      if (now - observation.lastOutputAt < 2000) { watch.due = now + 2000; continue }
      const limit = codexLimitReset(observation.text, now)
      if (!limit || !observation.ready || (watch.limit && observation.lastInputAt !== watch.inputAt)) {
        watch.stopped = true
        continue
      }
      // Relative reset times are anchored to the first observation, never moved by each poll.
      if (watch.limit?.signature !== limit.signature) watch.limit = limit
      watch.inputAt = observation.lastInputAt
      const resetAt = watch.limit!.resetAt
      if (resetAt === null || now < resetAt + 1000) {
        watch.due = now + this.settings.checkMinutes * 60000
        continue
      }
      // No output since our last attempt means that the old error cannot authorize another message.
      if (watch.attemptedOutputAt !== null && observation.lastOutputAt <= watch.attemptedOutputAt) {
        watch.stopped = true
        continue
      }
      if (!submit(id, this.settings.message, watch.limit!)) { watch.stopped = true; continue }
      watch.attemptedOutputAt = observation.lastOutputAt
      watch.limit = null
      // submit types asynchronously: its input timestamp is owned by the next observation.
      watch.due = now + this.settings.recheckHours * 3600000
    }
  }
}
