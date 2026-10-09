import type { TerminalSettings, Theme } from './types'

export type QuickTerminalMode = 'hidden' | 'panel' | 'popout'
export type QuickTerminalSurface = Exclude<QuickTerminalMode, 'hidden'>
export interface QuickTerminalState {
  enabled: boolean
  revision: number
  id: string | null
  phase: 'idle' | 'starting' | 'running' | 'stopping' | 'exited'
  mode: QuickTerminalMode
  cwd: string
  shell: string
  cols: number
  rows: number
  exitCode: number | null
}
export interface QuickTerminalFrame { id: string; sequence: number; data: string }
export interface QuickTerminalSnapshot { state: QuickTerminalState; sequence: number; data: string }
export interface QuickTerminalAppearance {
  theme: Theme
  fontFamily: string
  fontSize: number
  uiScale: number
  terminal: TerminalSettings
}
export type QuickTerminalResult = { ok: true; state: QuickTerminalState } | { ok: false; message: string }
/** The pop-out gets this bridge alone; no agent, settings or credential APIs. */
export interface QuickTerminalApi {
  platform: string
  read(): Promise<QuickTerminalSnapshot>
  open(mode: QuickTerminalSurface, cwd?: string): Promise<QuickTerminalResult>
  move(mode: QuickTerminalMode): Promise<QuickTerminalResult>
  restart(): Promise<QuickTerminalResult>
  end(): Promise<QuickTerminalResult>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  onState(cb: (state: QuickTerminalState) => void): () => void
  onData(cb: (frame: QuickTerminalFrame) => void): () => void
  appearance(): Promise<QuickTerminalAppearance>
  onAppearance(cb: (appearance: QuickTerminalAppearance) => void): () => void
  copy(text: string): void
  paste(): Promise<string>
}

/** Subscribe before reading a snapshot; frames covered by that snapshot must not replay twice. */
export class QuickTerminalReplay {
  private sequence: number | null = null
  private pending: QuickTerminalFrame[] = []
  private id: string
  private write: (data: string) => void
  constructor(id: string, write: (data: string) => void) { this.id = id; this.write = write }
  frame(frame: QuickTerminalFrame): void {
    if (frame.id !== this.id) return
    if (this.sequence === null) { this.pending.push(frame); return }
    if (frame.sequence <= this.sequence) return
    this.sequence = frame.sequence
    this.write(frame.data)
  }
  snapshot(snapshot: QuickTerminalSnapshot): void {
    if (snapshot.state.id !== this.id || this.sequence !== null) return
    this.sequence = snapshot.sequence
    this.write(snapshot.data)
    for (const frame of this.pending) this.frame(frame)
    this.pending = []
  }
}
