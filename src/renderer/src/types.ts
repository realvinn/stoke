import type { EffortLevel, PermissionMode } from '@shared/types'

/**
 * Where a session is right now, from its hook events.
 *
 * `working` from the moment a prompt goes in until the assistant stops;
 * `done` from then until the tab is looked at; `attention` when the CLI has
 * asked for something (a permission prompt, an idle nudge). Absent means
 * idle-and-seen, which is what a tab you are looking at should read as.
 */
export interface SessionActivity {
  state: 'working' | 'done' | 'attention'
  /** Epoch ms of the event that put it in this state. */
  at: number
  /** The last reply, or the CLI's message, clipped. */
  message: string | null
}

/** A New Project tab has no PTY yet; every session tab does. */
export type TabKind = 'session' | 'new'

/** A live terminal tab. Distinct from Claude's own session record. */
export interface Tab {
  id: string
  kind: TabKind
  /** Empty string on a `new` tab, which has no process. */
  ptyId: string
  /** Claude Code session id — the key the context meter watches. Empty on `new`. */
  sessionId: string
  /**
   * The session's working directory; `''` on a `new` tab.
   *
   * For an SSH tab this is the host alias, not a folder — see `hostId`, and
   * CLAUDE.md gotcha 18.
   */
  cwd: string
  projectName: string
  /** Falls back to the project name until Claude generates an ai-title. */
  title: string
  /**
   * Kept live from `ContextSnapshot.permissionMode` rather than frozen at
   * launch, so Shift+Tab inside the session reaches the indicator. Written by
   * A Task 53; before it, no writer ever updated this field.
   */
  permissionMode: PermissionMode
  model: string
  effort: EffortLevel
  /**
   * `paused` is a tab restored from the last run: it has a session to resume but
   * no process yet, so `ptyId` is ''. It is not `exited` — that means the
   * process ended, this means it has not started.
   */
  status: 'running' | 'exited' | 'paused'
  exitCode: number | null
  /**
   * `SshHost.id` when this session runs on another machine, else null.
   *
   * The only reliable signal that `cwd` is an alias rather than a folder, which
   * is what stops profile-follows-tab from mapping an SSH session to whatever
   * project happens to share its alias's name.
   */
  hostId: string | null
  /**
   * Per-tab launcher selection, so several New Project tabs can be open at once
   * without both pointing at whatever was clicked last. Null on a session tab.
   */
  selectedPath: string | null
  /** The project row expanded in this tab's launcher, or null. */
  expandedPath: string | null
}
