import type { EffortLevel, PermissionMode } from '@shared/types'

/** A live terminal tab. Distinct from Claude's own session record. */
export interface Tab {
  id: string
  ptyId: string
  /** Claude Code session id — the key the context meter watches. */
  sessionId: string
  cwd: string
  projectName: string
  /** Falls back to the project name until Claude generates an ai-title. */
  title: string
  permissionMode: PermissionMode
  model: string
  effort: EffortLevel
  status: 'running' | 'exited'
  exitCode: number | null
}
