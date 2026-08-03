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
}

/* ---------------------------------------------------------------- projects */

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
  /**
   * Project groups the worklog agent watches. Keyed on the group rather than
   * the active sidebar chip, because the chip is a view filter and a work
   * session can be running while a different profile is being browsed.
   */
  worklogGroups: string[]
  sidebarWidth: number
  /** Explicit path to the claude executable; null means auto-detect. */
  claudePath: string | null
  /** Warn before launching a session with permissions bypassed. */
  confirmBypass: boolean
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
