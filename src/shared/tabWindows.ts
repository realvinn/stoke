import type { CodingCliId } from './codingClis.ts'
import type { EffortLevel, PermissionMode } from './types.ts'
import type { LaunchOverride } from './launch.ts'
import type { HookActivity } from './activityView.ts'

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

/**
 * A New Project tab has no PTY yet; every session tab does. A `remote` tab is
 * another of the owner's machines' session, streamed through the hub relay
 * (src/main/hub/remote.ts): no pty here, no transcript here, never restored.
 */
export type TabKind = 'session' | 'new' | 'remote'

/** A live terminal tab. Distinct from Claude's own session record. */
export interface Tab {
  agentAccess?: import('./agentAccess.ts').AgentAccessMode
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
  /**
   * Set on an "Add key to …" tab: it runs `ssh-copy-id` for this host
   * (`SshHost.id`) so the user can type the password once, and it is never
   * saved for restore (`toStored` drops it) — a restart must not bring back an
   * install that asks for a password. `hostId` is set too, so everything that
   * treats `cwd` as an alias rather than a folder (gotcha 18) still does.
   */
  enrollHostId?: string
  /**
   * The account this tab's session runs on (shared/accounts.ts): an account
   * id, or `'default'` for the agent's own sign-in. Main's answer
   * (`StartResult.accountId`), never the renderer's guess, so a relaunch, a
   * Resume and Start again ask for exactly the account the session was on —
   * and a tab restored from before accounts reads `'default'`, which is what
   * it ran on. Absent on a New tab, an install, an SSH tab and a key enrollment.
   */
  accountId?: string
  /**
   * Set on a sign-in tab: it runs the agent's own login for this account
   * (`LaunchOptions.accountLogin`), and like an install it is never saved for
   * restore — a restart must not reopen a login nobody is there to answer.
   */
  accountLogin?: string
  /**
   * A private chat (shared/privateChat.ts): Claude Code in a folder main made,
   * saving nothing, deleted with everything it left when the tab closes. Never
   * saved for restore (`toStored`), never relaunched or resumed (`relaunchPlan`,
   * `restartPlan`), and its OS notifications never carry its text.
   */
  private?: true
  /** Empty string on a `new` tab, which has no process. */
  ptyId: string
  /** Claude Code session id — the key the context meter watches. Empty on `new`. */
  sessionId: string
  /** Confirmed native Codex thread id; distinct from Stoke's live-session key. */
  agentResumeId?: string
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
   * A name the user gave this tab (double-click the tab, or right-click →
   * Rename). When set it wins over `title` everywhere the label is drawn
   * (`tabLabel`); cleared to blank, the tab falls back to Claude's ai-title.
   * Persisted across restart (`StoredTab.customTitle`).
   */
  customTitle?: string
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
   * The Stoke-managed tmux session this SSH tab lives in, on a host that keeps
   * its shells (`SshHost.persist`). Minted once when the tab is first opened
   * (`startHostSession`) and carried through every reconnect, Resume, Start
   * again and restart restore, so each one reattaches to the same shell.
   * Persisted (`StoredTab.remoteSession`). Absent on every other tab.
   */
  remoteSession?: string
  /**
   * Set while a kept SSH tab whose link dropped (ssh exit 255) is waiting to
   * reconnect by itself: which attempt is next and when it fires. Cleared by a
   * successful reconnect, a manual Start again or Close, or giving up. Never
   * persisted — a restore reattaches paused, as every other tab restores.
   */
  reconnect?: { attempt: number; at: number }
  /**
   * Set on a `remote` tab only: main's handle for it (`tabId`) and whose
   * session it is. Never saved for restore (`toStored` drops the tab): a
   * relay is two live sockets, and the other machine asks again.
   */
  remote?: { tabId: string; device: string; deviceLabel: string; platform: string; ptyId: string }
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


/** Live, in-memory handoff. Private sessions never enter the disk restore snapshot. */
export interface TabWindowPacket {
  tabs: Tab[]
  activeId: string | null
  screens: Record<string, string>
  contexts: Record<string, import('./types.ts').ContextSnapshot>
  drafts: Record<string, boolean>
  stored: { state: import('./types.ts').StoredTabs; ids: string[] }
}
export interface TabWindowTransfer { id: string; packet: TabWindowPacket }

export function canMoveTab(tab: Tab): boolean {
  return tab.kind !== 'remote' && !tab.installing?.length && !tab.enrollHostId && !tab.accountLogin && !tab.reconnect
}

/** Release well beyond the title strip; an ordinary reorder or click never tears off. */
export function tabDragLeavesStrip(y: number, top: number, bottom: number): boolean {
  return Number.isFinite(y) && (y < top - 36 || y > bottom + 36)
}
