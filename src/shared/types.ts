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
  }
  sidebarWidth: number
  /** Explicit path to the claude executable; null means auto-detect. */
  claudePath: string | null
  /** Warn before launching a session with permissions bypassed. */
  confirmBypass: boolean
}

/* --------------------------------------------------------------- browser */

export interface BrowserState {
  url: string
  title: string
  canGoBack: boolean
  canGoForward: boolean
  loading: boolean
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
