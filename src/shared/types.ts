/**
 * Types shared by the main process, the preload bridge and the renderer.
 * This file must stay free of any Node or DOM imports.
 */

/* ------------------------------------------------------------------ launch */

/**
 * Maps onto `claude --permission-mode <mode>`, except:
 *  - `default` sends no flag at all
 *  - `bypassPermissions` sends `--dangerously-skip-permissions`, which is the
 *    flag that actually works without prior opt-in.
 */
export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'auto'
  | 'bypassPermissions'

export type EffortLevel = 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface LaunchOptions {
  cwd: string
  /** Explicit session id. New sessions get one generated so we can find the JSONL. */
  sessionId?: string
  /** Resume an existing session id (`--resume`). */
  resume?: boolean
  /** Continue the most recent session in cwd (`--continue`). */
  continueLast?: boolean
  /** With resume/continue, branch to a new session id instead of reusing. */
  forkSession?: boolean
  permissionMode: PermissionMode
  /** Model alias or full id. Empty string means "use the configured default". */
  model: string
  effort: EffortLevel
  /**
   * Ultracode: xhigh effort plus standing dynamic-workflow orchestration.
   *
   * Not an effort level - `--effort` takes only low/medium/high/xhigh/max - but
   * a boolean the CLI reads from its settings, so it is passed through
   * `--settings` at launch rather than typed into the session afterwards.
   * Requires workflows enabled and an xhigh-capable model.
   */
  ultracode?: boolean
  /**
   * Open an SSH session on this host instead of running Claude Code locally.
   *
   * The PTY machinery is identical - only the argv differs - but the context
   * meter and session resume do not apply, because both read transcript files
   * that live on the far machine.
   */
  host?: SshHost
  /** `--name`, shown in Claude Code's own prompt box and /resume picker. */
  name?: string
  addDirs?: string[]
  extraArgs?: string[]
  cols: number
  rows: number
}

export interface TabDescriptor {
  /** Stoke's own tab id. Not the Claude session id. */
  id: string
  ptyId: string
  sessionId: string
  cwd: string
  title: string
  permissionMode: PermissionMode
  model: string
  effort: EffortLevel
  createdAt: number
  /** SshHost.id when this session runs on another machine. */
  hostId?: string
}

/* ---------------------------------------------------------------- projects */

/**
 * What the user has said about one folder, over and above what Claude's own
 * files record. Keyed by `Project.path`.
 *
 * Deliberately **not** the home of `pinned` or `hidden`. Those are already
 * persisted as path arrays on real machines, and folding them in here would make
 * "hidden" and "has an emoji" the same record — so clearing an emoji could
 * resurrect a project the user hid. `addedManually` is the only key that affects
 * membership, and it only ever adds.
 */
export interface ProjectMeta {
  /** One emoji shown before the name. Absent means none. */
  emoji?: string
  /** Replaces the folder's basename in the sidebar. Absent means use the basename. */
  label?: string
  /**
   * The user picked this folder themselves, so `listProjects` must emit it even
   * with no Claude history and no scan root covering it. Spec §2.5: there was no
   * source that could represent a single explicitly added folder.
   */
  addedManually?: boolean
}

export interface Project {
  /** Absolute path in the OS's native separator form. */
  path: string
  /** Basename, used as the display name. */
  name: string
  /** Parent directory, used to group the sidebar (e.g. `personal`, `school`). */
  group: string
  /** Directory name under ~/.claude/projects, when the project has history. */
  encodedDir: string | null
  sessionCount: number
  lastModified: number | null
  lastCost: number | null
  lastPrompt: string | null
  /** False when the folder has been moved or deleted since Claude last saw it. */
  exists: boolean
  pinned: boolean
  /** ProjectMeta.emoji for this path, or null. */
  emoji: string | null
  /** ProjectMeta.label, or null when the basename is in use. */
  label: string | null
  /** True when this project exists only because the user added the folder. */
  addedManually: boolean
}

export interface SessionMeta {
  id: string
  file: string
  projectPath: string
  /** Claude Code's own generated `ai-title`, when it has produced one. */
  title: string | null
  firstPrompt: string | null
  modified: number
  sizeBytes: number
  messageCount: number
  model: string | null
  contextTokens: number
  contextLimit: number
  gitBranch: string | null
}

/* ----------------------------------------------------------------- context */

/** Live context-window reading for one session, derived from its JSONL. */
export interface ContextSnapshot {
  sessionId: string
  /** input + cache_read + cache_creation on the most recent assistant turn. */
  contextTokens: number
  contextLimit: number
  inputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  outputTokens: number
  model: string | null
  messageCount: number
  title: string | null
  /** Epoch ms of the underlying file's last change. */
  updatedAt: number
  /** False until the session file exists on disk. */
  ready: boolean
  /** Newest `permission-mode` record in the transcript, or null when none. */
  permissionMode: PermissionMode | null
}

/* -------------------------------------------------------------- statusline */

/**
 * The JSON Claude Code pipes to a `statusLine` command on stdin, as captured
 * from 2.1.221. Every field is optional because this is somebody else's wire
 * format: a CLI that drops one must degrade to the older inference, never throw.
 */
export interface StatusLinePayload {
  session_id?: string
  transcript_path?: string
  cwd?: string
  version?: string
  model?: StatusLineModel
  context_window?: StatusLineContextWindow
  /** True once the session is past the 200k tier boundary. Billing-adjacent. */
  exceeds_200k_tokens?: boolean
  rate_limits?: StatusLineRateLimits
}

export interface StatusLineModel {
  id?: string
  display_name?: string
}

export interface StatusLineContextWindow {
  /**
   * The window this session actually has, stated by the CLI rather than
   * inferred. 1000000 for Opus 5, 200000 for Haiku — per model, and correct
   * from token zero, which is the whole reason this channel exists.
   */
  context_window_size?: number
  used_percentage?: number
  current_usage?: StatusLineUsage
}

export interface StatusLineUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

/** `resets_at` is epoch **seconds**, not ms. Convert once, at the edge. */
export interface StatusLineRateLimit {
  used_percentage?: number
  resets_at?: number
}

export interface StatusLineRateLimits {
  five_hour?: StatusLineRateLimit
  seven_day?: StatusLineRateLimit
}

/** One rate-limit window, in Stoke's own units. */
export interface StatusLineWindowReading {
  /** 0-100. */
  percent: number
  /** Epoch **ms**, converted from the payload's seconds. Null when absent. */
  resetsAt: number | null
}

/**
 * What the main process hands the renderer, once. Flat, camelCase, and in ms —
 * so no component ever has to know the wire shape or the seconds/ms boundary.
 */
export interface StatusLineSnapshot {
  sessionId: string
  /** context_window_size, or null when this CLI did not state one. */
  contextWindowSize: number | null
  /** 0-100, as the CLI computed it. Null when absent. */
  usedPercentage: number | null
  modelId: string | null
  modelName: string | null
  exceeds200k: boolean
  fiveHour: StatusLineWindowReading | null
  sevenDay: StatusLineWindowReading | null
  /** Epoch ms the payload file was written. Drives the "as of HH:MM" tooltip. */
  receivedAt: number
}

/* ------------------------------------------------------------------ themes */

export interface ThemeColors {
  bg: string
  bgSunken: string
  bgElevated: string
  surface: string
  surfaceHover: string
  border: string
  borderStrong: string
  text: string
  textMuted: string
  textFaint: string
  accent: string
  accentHover: string
  accentSoft: string
  accentContrast: string
  success: string
  warning: string
  danger: string
  info: string
}

export interface TerminalColors {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  /**
   * The colour selected text is drawn in.
   *
   * Required, not optional. Without it xterm replaces only the background of a
   * selected cell and the text keeps whatever colour the CLI gave it, on a
   * ground it was never checked against - and `minimumContrastRatio: 1` in
   * TerminalView means nothing corrects the pair afterwards. Every value here
   * is asserted against its own selection background composited over
   * `background` in scripts/verify-color.mts.
   */
  selectionForeground: string
  /**
   * The selection background when the terminal does not have focus.
   *
   * Required for the same reason: xterm falls back to `selectionBackground`
   * when it is absent, so a selection in an unfocused terminal is drawn exactly
   * like the live one.
   */
  selectionInactiveBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface Theme {
  id: string
  name: string
  appearance: 'dark' | 'light'
  /** Shown as the swatch in the theme picker. */
  colors: ThemeColors
  terminal: TerminalColors
  builtIn?: boolean
}

/* --------------------------------------------------------------------- ssh */

/**
 * A remote machine Stoke can open a session on.
 *
 * Connection details are deliberately NOT stored here. `alias` names a Host
 * entry in the user's own `~/.ssh/config`, so keys, ports, usernames and jump
 * hosts stay in the one file that already works and that every other tool on
 * the machine reads. Stoke keeps only what is Stoke's: a label and what to run.
 */
export interface SshHost {
  id: string
  label: string
  /** A Host alias from ~/.ssh/config, or a bare user@host. */
  alias: string
  /**
   * Run this instead of a login shell.
   *
   * `byobu` or `tmux new -A -s stoke` is the useful answer: a remote session
   * cannot use Stoke's own resume, because the transcript lives on the far
   * machine, so a multiplexer is the only thing that survives a dropped link.
   * Empty means a plain login shell.
   */
  command: string
  /**
   * Let the worklog agent write up sessions on this machine.
   *
   * Per host rather than per project group, because a remote session has no
   * local project to key on: `SessionInfo.cwd` for an SSH session is the folder
   * Stoke was pointed at locally, not the directory the remote shell is in. The
   * folder gate would therefore match by accident or not at all, and both are
   * silent. Off unless asked, like `worklogGroups`.
   */
  worklog?: boolean
}

/* ----------------------------------------------------------------- worklog */

export type WorklogTarget = 'notion' | 'clickup'

/** Why a session is, or is not, the worklog agent's business. */
export type WorklogWatchReason =
  /** Its folder's group is in Settings.worklogGroups. */
  | 'watched-group'
  /** It runs over SSH on a host with `worklog: true`. */
  | 'watched-host'
  /**
   * This session is local (not SSH) and `worklogGroups` is empty, so there is
   * nothing to match against. Says nothing about SSH hosts — a remote session
   * is judged by 'watched-host' / 'unwatched-host' instead, so a local 'off'
   * can coexist with a ticked host elsewhere. If a person reads this reason,
   * say the folder groups are empty, not that "the feature" is off.
   */
  | 'off'
  /** A group resolved, but the user does not watch it. */
  | 'unwatched-group'
  /** No project and no scan root contains the cwd, so there is no group to check. */
  | 'unknown-folder'
  /** An SSH session on a host the user has not ticked. */
  | 'unwatched-host'

/**
 * Whether the worklog may look at one session, and why.
 *
 * The `reason` is not decoration: spec §2.4.4 records that "working but nothing
 * to report" and "never ran" were indistinguishable, and this is the field that
 * separates them. Every surface that says anything about watching reads it.
 */
export interface WorklogWatchState {
  sessionId: string
  watched: boolean
  reason: WorklogWatchReason
  /** The resolved project group, or the SSH host's label. Null when neither. */
  group: string | null
  /** True when the session runs on another machine, where the switch is per host. */
  remote: boolean
  /** Epoch ms this was decided. */
  decidedAt: number
}

/** How a scan ended. `budget` is separate from `error` on purpose (spec §4 C.3). */
export type WorklogScanOutcome = 'proposed' | 'nothing' | 'budget' | 'error'

/**
 * The last thing a scan did, so an empty panel can say which of the four it was.
 */
export interface WorklogScanReport {
  sessionId: string
  at: number
  /** True when nobody pressed anything. */
  auto: boolean
  outcome: WorklogScanOutcome
  /** Proposals added. Always 0 unless outcome is 'proposed'. */
  added: number
  /**
   * Non-null for 'budget' and 'error'. Also non-null for 'proposed' when the
   * drafts were written without a look at the boards first — the scan still
   * ran and still produced proposals, so the outcome stays 'proposed' rather
   * than getting recast as a failure, but the user is owed the same warning
   * either way (H5, .superpowers/sdd/plan-resolutions.md). Shown to the user
   * verbatim.
   */
  message: string | null
}

/**
 * Where the worklog files things, and which board in each.
 *
 * Replaces the compiled-in ids at runner.ts:37-38. An id belongs in settings
 * because it is one person's board: shipping it in the binary meant nobody else
 * could use the feature and this machine could not narrow to one destination.
 */
export interface WorklogBoards {
  /** Destinations, in canonical order. Empty means the worklog writes nowhere. */
  targets: WorklogTarget[]
  /** Notion data source URI, e.g. `collection://<uuid>`. */
  notionDataSource: string
  /** ClickUp list id, as digits. */
  clickupListId: string
}

/**
 * Create a new record, or change one that already exists.
 *
 * The second kind is why the scan is given a list of what is already tracked:
 * finishing a task the user filed last week should move that task, not file a
 * near-duplicate beside it.
 */
export type WorklogKind = 'create' | 'update'

/**
 * A record that already exists in a destination, as the recall run read it.
 *
 * `status` is the destination's *own* word for the state — "in progress",
 * "Complete" — never a normalised one. A status this app invented would be
 * rejected by ClickUp's API with an error the user cannot act on, so the only
 * statuses ever written back are ones that were read out first.
 */
export interface WorklogExistingItem {
  /** The destination's identifier, which is what the write is addressed to. */
  id: string
  title: string
  status?: string
  url?: string
}

/**
 * One proposed entry, awaiting review. Nothing reaches Notion or ClickUp until
 * the user accepts it, so this is the whole product of a scan.
 */
export interface WorklogProposal {
  id: string
  /** The session it was derived from, and the folder that session ran in. */
  sessionId: string
  cwd: string
  /** `Project.group`, which is what the watch list is keyed on. */
  group: string
  title: string
  body: string
  targets: WorklogTarget[]
  /**
   * Absent on records written before updates existed, which is why every reader
   * treats a missing value as `'create'` rather than requiring it.
   */
  kind?: WorklogKind
  /** For an update: the record being changed, per destination. */
  existing?: Partial<Record<WorklogTarget, WorklogExistingItem>>
  /**
   * For an update: the state to move it to, per destination, in that
   * destination's own vocabulary. Only ever a status recall actually saw.
   */
  newStatus?: Partial<Record<WorklogTarget, string>>
  status: 'pending' | 'accepted' | 'rejected' | 'failed'
  createdAt: number
  /** True when a scan the user did not ask for produced it. */
  auto?: boolean
  /** Set once accepted, so a half-succeeded write is visible rather than lost. */
  urls?: Partial<Record<WorklogTarget, string>>
  error?: string
}

/**
 * What an auto-scan produced, pushed at the renderer so it can ask about it.
 *
 * Carries the ids rather than the proposals themselves: the queue is already
 * broadcast in full on every change, and two copies of the same records drift.
 */
export interface WorklogProposedEvent {
  sessionId: string
  /** Ids of the proposals this scan added, newest first. */
  ids: string[]
}

/* ---------------------------------------------------------------- profiles */

/**
 * A stored profile. Seeded from the folders on this machine, then overridden by
 * whatever the user changes.
 *
 * Lives here rather than in profiles.ts so Settings can reference it without the
 * two modules importing each other.
 */
export interface ProfileConfig {
  /** Stable id. For a derived record this is the folder group name. */
  id: string
  /** Project.group values this profile covers, compared case-folded. */
  groups: string[]
  label: string
  accent: string
  accentHover: string
  accentSoft: string
  accentContrast: string
  /** Marks records the user made, so a derived seed never overwrites one. */
  createdByUser?: boolean
}

/* ---------------------------------------------------------------- settings */

export interface Settings {
  themeId: string
  customThemes: Theme[]
  fontFamily: string
  fontSize: number
  uiScale: number
  defaults: {
    permissionMode: PermissionMode
    model: string
    effort: EffortLevel
    /** Start sessions with ultracode on. See LaunchOptions.ultracode. */
    ultracode: boolean
  }
  /** Extra folders to scan one level deep for projects (e.g. G:\Code\personal). */
  projectRoots: string[]
  /**
   * Working directory for a session started without picking a project.
   * null means auto-detect — see main/workspace.ts.
   */
  defaultCwd: string | null
  /** Open a session in the default folder as soon as the app starts. */
  startOnLaunch: boolean
  pinnedProjects: string[]
  hiddenProjects: string[]
  browser: {
    homepage: string
    lastUrl: string
    width: number
    bookmarks: string[]
  }
  /** Serving Stoke's sessions to a phone, normally behind a Cloudflare Tunnel. */
  remote: {
    enabled: boolean
    port: number
    /** Bearer key; generated on first use. Also carried in the QR link. */
    token: string
    /** Public hostname the tunnel points at, e.g. code.vinn.dev. */
    hostname: string
    /** Listen on the LAN as well as loopback. Off by default. */
    bindLan: boolean
    /**
     * Listen on the Tailscale address as well as loopback, so a phone on the
     * tailnet connects directly without the tunnel. Narrower than `bindLan`:
     * it exposes the port to the tailnet only, never to the local network.
     */
    bindTailscale: boolean
    /** Refuse requests that did not arrive through Cloudflare Access. */
    requireAccessHeader: boolean
    /** Start the named cloudflared tunnel when the remote server starts. */
    autoStartTunnel: boolean
    /** Name of the pre-created cloudflared tunnel to run. */
    tunnelName: string
    /**
     * Speech-to-text sidecar used for dictation from the phone, for example
     * `http://127.0.0.1:17890`. Stoke proxies to it so the sidecar itself never
     * has to face the internet.
     *
     * Empty does NOT hide the microphone: the button is gated on browser
     * capability alone (`voiceSupported()`), so an empty value instead fails at
     * press time with a 503 from `/api/transcribe`. Settings repairs an emptied
     * box both on blur and on close, so the UI will not persist one - but
     * `hydrate` keeps an empty string written by hand, since own properties
     * override the defaults.
     */
    sttUrl: string
  }
  /**
   * Which profile's projects to show, by `Project.group`. Null shows all.
   *
   * Never an access control: every profile can reach every file, and a chat can
   * be started or resumed in any directory regardless of what is selected here.
   */
  activeProfile: string | null
  /**
   * Stored overrides for the profiles derived from folder names. Empty means
   * "derive everything", which is how an untouched machine behaves.
   *
   * A profile is only ever two things: a colour, so projects are tellable
   * apart at a glance, and a switch for the worklog agent. It carries no
   * defaults and grants no access.
   */
  profiles: ProfileConfig[]
  /** Remote machines offered in the launcher. See SshHost. */
  hosts: SshHost[]
  /**
   * Project groups the worklog agent watches. Keyed on the group rather than
   * the active sidebar chip, because the chip is a view filter and a work
   * session can be running while a different profile is being browsed.
   */
  worklogGroups: string[]
  /**
   * Scan a watched session on its own, once it goes quiet, instead of waiting
   * for the button.
   *
   * On by default, because `worklogGroups` is the real switch: with no group
   * watched this changes nothing at all, and with one watched the whole point
   * of the feature is that it keeps up without being asked.
   */
  worklogAuto: boolean
  /**
   * Offer beta releases as updates.
   *
   * `allowPrerelease` for electron-updater, and off by default on purpose: a
   * beta is by definition a build whose risky paths have not been exercised, and
   * one that turns out to be broken must not be able to push itself at everyone.
   *
   * Note what this cannot do — the updater ships *inside* the app, so turning it
   * on affects what the *current* build is offered next. It can never make an
   * older build see a beta it already declined.
   */
  betaUpdates: boolean
  sidebarWidth: number
  /** Explicit path to the claude executable; null means auto-detect. */
  claudePath: string | null
  /** Warn before launching a session with permissions bypassed. */
  confirmBypass: boolean
  /** Per-folder metadata, keyed by `Project.path`. See ProjectMeta. */
  projectMeta: Record<string, ProjectMeta>
  /** Which boards the worklog writes to, and their ids. See WorklogBoards. */
  worklogBoards: WorklogBoards
  /**
   * Replace Claude's own status line with Stoke's silent wrapper.
   *
   * On by default: the wrapper is how the context window and the plan limits
   * reach the app at all, and the line it suppresses is a duplicate of chrome
   * Stoke already draws. Off passes the user's own command through unchanged.
   */
  hideStatusLine: boolean
}

/* --------------------------------------------------------------- browser */

export interface BrowserTabState {
  id: string
  title: string
  url: string
  loading: boolean
}

export interface BrowserState {
  /** Active tab. Kept flat because most of the UI only cares about this one. */
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
  tabs: BrowserTabState[]
  activeId: string | null
  /** Chromium zoom level (logarithmic; 0 is 100%). */
  zoom: number
  findTotal: number
  findActive: number
  bookmarked: boolean
}

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/* --------------------------------------------------------------- runtime */

export interface CliInfo {
  path: string
  version: string | null
  ok: boolean
  error: string | null
}

/* ----------------------------------------------------------- plan limits */

export interface UsageWindow {
  kind: 'session' | 'weekly' | 'weekly_scoped'
  /** "5 hours", "Weekly", or the model name for a scoped window. */
  label: string
  /** 0-100. */
  percent: number
  severity: string
  resetsAt: number | null
  /**
   * How far through the window we are, 0-1, or null when the reset time is
   * unknown. This is the pace marker: 2.5 hours into a 5-hour window puts it at
   * 0.5, so usage sitting to the right of it means burning faster than the
   * window refills.
   */
  elapsed: number | null
  active: boolean
}

export interface UsageSnapshot {
  windows: UsageWindow[]
  /** Paid overage, when the account has it switched on. */
  extraCredits: { percent: number; enabled: boolean } | null
  fetchedAt: number
  /** Non-null means the numbers are unavailable, not that usage is zero. */
  error: string | null
  /**
   * How long to wait before asking again, in ms. Set when the endpoint has
   * rate-limited or failed; absent means the normal poll interval applies.
   */
  retryAfter?: number
}
