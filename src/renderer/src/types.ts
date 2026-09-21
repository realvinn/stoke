import type { CodingCliId } from '@shared/codingClis'
import type { EffortLevel, PermissionMode } from '@shared/types'
import type { LaunchOverride } from '@shared/launch'
import type { HookActivity } from '@shared/activityView'

/**
 * Where a session is right now, from its hook events.
 *
 * `working` from the moment a prompt goes in until the assistant stops;
 * `done` from then on; `attention` when the CLI has asked for something (a
 * permission prompt). Looking at the tab marks a `done` or `attention` `seen`
 * rather than removing it (`afterLooking`), so it still weighs against a
 * lagging registry `busy`; absent means nothing has been heard. A `done` also
 * keeps the background work its Stop listed (`background`).
 *
 * This is the HOOK half only. What a tab actually shows is `activityView`
 * (src/shared/activityView.ts), which reads this beside the CLI's registry —
 * a Stop can end a turn while a workflow keeps the session busy.
 */
export type SessionActivity = HookActivity

/** A New Project tab has no PTY yet; every session tab does. */
export type TabKind = 'session' | 'new'

/** A live terminal tab. Distinct from Claude's own session record. */
export interface Tab {
  id: string
  kind: TabKind
  /**
   * Which coding CLI this tab is running.
   *
   * Read by everything that draws beside the terminal — the context slot, the
   * plan chip, the version item, the relaunch pill — through `capsFor`, so that
   * a tab running another binary shows nothing there rather than Claude's
   * numbers. Never optional: a tab always knows what it is.
   */
  cliId: CodingCliId
  /**
   * Set on a tab that is installing these agents rather than running one. It is
   * never saved for restore (`toStored` drops it) — an install cannot be
   * resumed, and a restored one would come back as a paused session of the
   * first agent in the list.
   */
  installing?: CodingCliId[]
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
   * Whether this session was launched with ultracode. Kept on the tab, like
   * `model` and `effort`, so a relaunch or a Resume brings back the session
   * that was there — it used to fall back to whatever the launcher's global
   * default said at the moment of the relaunch.
   */
  ultracode: boolean
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
  /**
   * A New tab's launch chips moved for THIS launch only (QA L10). Absent means
   * every value is the Stoke default. They used to patch `settings.defaults`,
   * so trying Sonnet once changed every later launch — the sidebar's +, the
   * palette, `stoke DIR` and restored tabs. "Make default" is the explicit
   * route to that now. Never persisted: `toStored` names its fields.
   */
  launch?: LaunchOverride
}
