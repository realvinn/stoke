/**
 * Types shared by the main process, the preload bridge and the renderer.
 * This file must stay free of any Node or DOM imports.
 */
import type { ZoomTarget } from './ui.ts'

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
  /**
   * Which way round this window's colours are, for `COLORFGBG`.
   *
   * A backstop, not the mechanism. Claude Code follows the terminal on its own
   * when its `theme` is `auto`: it asks with OSC 11 and xterm.js answers from
   * the background Stoke gives it. `COLORFGBG` is only what the CLI falls back
   * to when that query goes unanswered, and it costs one env var to set.
   *
   * It does not reach an SSH session — env does not cross ssh without SendEnv
   * and AcceptEnv on both ends — which is fine, because OSC 11 does.
   */
  appearance?: 'light' | 'dark'
  /** `--name`, shown in Claude Code's own prompt box and /resume picker. */
  name?: string
  addDirs?: string[]
  extraArgs?: string[]
  cols: number
  rows: number
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
  /**
   * The turn this render belongs to. It changes exactly once per user message,
   * which makes it the only message boundary anything outside the CLI can see:
   * the payload file itself is rewritten roughly three times a second *within*
   * a turn, so its mtime says "the CLI drew something" and never "a message
   * happened". The usage chip refreshes the account reading on a change here.
   */
  prompt_id?: string
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
  /**
   * The turn this reading was taken during, or null from a CLI that states
   * none. See `StatusLinePayload.prompt_id`: this is the message boundary, and
   * `receivedAt` deliberately is not one.
   */
  promptId: string | null
  /** context_window_size, or null when this CLI did not state one. */
  contextWindowSize: number | null
  /** 0-100, as the CLI computed it. Null when absent. */
  usedPercentage: number | null
  modelId: string | null
  modelName: string | null
  exceeds200k: boolean
  /**
   * The CLI version this session is actually running, as the running process
   * states it.
   *
   * The only trustworthy answer to "what binary is this chat on", and the
   * reason the relaunch offer needs no bookkeeping. A session holds whichever
   * `claude` it spawned with for its whole life, so updating the CLI on disk
   * leaves every open session behind — and stamping the version onto a tab at
   * launch would record what Stoke *believed* was installed, which is a cache
   * that can be stale in exactly the situation that matters. This is the
   * process's own statement, rewritten about three times a second.
   */
  cliVersion: string | null
  fiveHour: StatusLineWindowReading | null
  sevenDay: StatusLineWindowReading | null
  /** Epoch ms the payload file was written. Drives the "as of HH:MM" tooltip. */
  receivedAt: number
}

/* ---------------------------------------------------------- session events */

/**
 * Where a session is, as the CLI itself reports it through its hooks.
 *
 * Three events, because three states matter to someone with several tabs
 * open: a prompt went in (Claude is working), the assistant stopped (done,
 * waiting for you), and the CLI asked for attention (a permission prompt, or
 * an idle nudge). The transcript watcher cannot say any of this promptly —
 * it polls a file that is appended mid-turn — and the PTY bytes could only
 * say it by parsing a TUI. A hook is the CLI stating it in so many words.
 */
export type SessionEventKind = 'stop' | 'notification' | 'prompt'

export interface SessionEvent {
  sessionId: string
  kind: SessionEventKind
  /** Epoch ms the event was read, not when the CLI wrote it. */
  at: number
  /**
   * Stop: the last assistant message, clipped. Notification: the CLI's own
   * message. Prompt: the prompt text, clipped. Null when the payload had none.
   */
  message: string | null
  /** Notification only, e.g. `permission_prompt` or `idle_prompt`. */
  notificationType: string | null
  cwd: string | null
}

/**
 * When a finished turn or a permission prompt raises an OS notification.
 *
 * `background` is the default and the useful one: a notification for the tab
 * you are looking at is noise, and one for a tab you are not — or a window
 * behind another app — is the whole point.
 */
export type NotificationMode = 'off' | 'background' | 'always'

/* ------------------------------------------------------------------ themes */

/**
 * The palette a theme writes onto `:root`, one custom property per key.
 *
 * Every value is generated from the twelve-step ladder in `./ladder.ts`, and
 * the comments there say which rung each of these sits on and why. Hand-editing
 * one is possible but reintroduces the class of defect the ladder exists to
 * prevent -- uneven steps, borders below the discernibility floor, a light
 * ramp that inverts its own direction.
 *
 * `accentHover`, `accentSoft` and `accentContrast` are the exception: they are
 * derived at apply time from `accent` by `./accent.ts`, so the values stored
 * here are only what a theme-preview swatch draws.
 */
export interface ThemeColors {
  bg: string
  bgSunken: string
  bgElevated: string
  surface: string
  surfaceHover: string
  /** Ladder step 5: a selected or pressed control. */
  surfaceActive: string
  /** Ladder step 6: a separator, as opposed to a control's own boundary. */
  borderSubtle: string
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

/**
 * The five fields a whole theme is generated from. See `./themeGen.ts`.
 *
 * Declared here rather than beside `buildTheme` only so `Theme` can carry one
 * without the two modules importing each other.
 */
export interface ThemeSeed {
  id: string
  name: string
  appearance: 'dark' | 'light'
  /** Neutral hue in degrees: what the greys are tinted toward. */
  hue: number
  /** Multiplier on the ladder's neutral chroma. 1 is the historical value. */
  tint: number
  /**
   * A floor on the chroma of the page and its panels, 0 for a grey. The tint
   * alone cannot colour the page (see PAGE_CHROMA_MAX in ladder.ts); this can.
   * Absent means 0, so every seed written before it existed regenerates
   * byte-identically.
   */
  pageChroma?: number
  /** Dark only: start the ladder at true black rather than Stoke's warm floor. */
  black?: boolean
  accent: string
  /** Hand-set values that escape the generated palette. */
  overrides?: Partial<Record<keyof ThemeColors, string>>
}

export interface Theme {
  id: string
  name: string
  appearance: 'dark' | 'light'
  /** Shown as the swatch in the theme picker. */
  colors: ThemeColors
  terminal: TerminalColors
  builtIn?: boolean
  /**
   * What this theme was generated from, when it was.
   *
   * Optional, and its absence is meaningful rather than a gap: a theme written
   * by hand into `customThemes` before the editor existed has no seed, and the
   * editor must open such a theme on its VALUES rather than silently
   * regenerating it from a seed nobody chose. The forty-three colours stay the
   * source of truth for rendering either way -- this is only what lets the
   * editor put the sliders back where they were.
   */
  seed?: ThemeSeed
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
   * either way. And non-null for
   * 'nothing' when the transcript itself held no turns yet — a session that
   * has not started and a session the model read and dismissed both reach
   * `outcome: 'nothing'`, and this is the only field that tells them apart
   * (Task 29 review, routed item 2). Shown to the user verbatim.
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

/**
 * How the terminal pane is drawn, over and above its font and size.
 *
 * These are xterm's own knobs, and until now Stoke set them to constants or
 * left them at xterm's defaults. Line height in particular is what makes the
 * CLI read as a document rather than a console: 1.2 is a terminal, 1.35 is a
 * chat. `frame` draws the pane as a rounded card inset from the page with real
 * padding, which is the other half of the same effect.
 */
export interface TerminalSettings {
  /** xterm `lineHeight`, 1.0–1.6. */
  lineHeight: number
  /** xterm `letterSpacing` in px, -1–3. */
  letterSpacing: number
  cursorStyle: 'bar' | 'block' | 'underline'
  cursorBlink: boolean
  /** The weight SGR bold is drawn at. JetBrains Mono's 700 is heavy at 13px. */
  boldWeight: 600 | 700
  /**
   * xterm `minimumContrastRatio`. 1 leaves the CLI's colours alone; 4.5 and 7
   * recolour dim text until it clears the ratio, which also changes Claude
   * Code's own palette — so it is a choice, not a default.
   */
  contrastBoost: 1 | 4.5 | 7
  smoothScroll: boolean
  /** Draw the pane as a rounded card with inner padding, inset from the page. */
  frame: boolean
  /** Inner padding between the card's edge and the first column, in px, 0–32. */
  padding: number
}

/**
 * An image behind everything, with the surfaces made translucent over it.
 *
 * Every panel, the page and the terminal canvas are ordinarily opaque; with a
 * wallpaper set they are drawn at `opacity` over the image, which is blurred
 * by `blur` px and darkened by `dim`. All three exist because a wallpaper
 * defeats the contrast floors the theme editor promises — the ladder's
 * guarantees stop at the page — and dimming and blurring the image is what
 * gives text something quiet to sit on.
 */
export interface WallpaperSettings {
  /** Stoke's own copy of the image under userData, or null for none. */
  path: string | null
  /** Blur radius in px, 0–40. */
  blur: number
  /** How much the image is darkened, 0–0.9. */
  dim: number
  /** How opaque the page and panels are over it, 0.5–1. */
  opacity: number
}

export interface Settings {
  themeId: string
  customThemes: Theme[]
  /** The image behind the window, if any. See WallpaperSettings. */
  wallpaper: WallpaperSettings
  fontFamily: string
  fontSize: number
  uiScale: number
  /** The pane's drawing options. See TerminalSettings. */
  terminal: TerminalSettings
  /**
   * What the zoom keys move: the interface, the terminal font, or both.
   * A setting because Stoke has two independent size settings and which one
   * "zoom" means depends on whether you came from a terminal or an editor.
   */
  zoomTarget: ZoomTarget
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
    /** Public hostname the tunnel points at, e.g. stoke.example.com. */
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
  /**
   * Install Claude Code CLI updates without asking.
   *
   * Default on, and the reason is that this is not new behaviour so much as a
   * more visible version of it: the CLI already updates itself, and what Stoke
   * adds is doing it on a schedule the user can see, report, and switch off.
   * The switch matters anyway — a `claude` on a shared or pinned install is
   * somebody else's to change, and replacing a program on someone's PATH stays
   * refusable.
   *
   * Independent of `betaUpdates`, which is Stoke's own releases. Nothing here
   * ever installs a Stoke build; the two update paths share a settings section
   * and nothing else.
   */
  cliAutoUpdate: boolean
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
  /** OS notifications when Claude finishes or needs you. See NotificationMode. */
  notifications: NotificationMode
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

/* ------------------------------------------------------- claude cli updates */

/**
 * What the Settings panel needs to describe the CLI's update situation,
 * including anything the automatic checker did while nobody was looking.
 *
 * `note` is the part that could not be derived in the renderer: an automatic
 * run happens with no UI attached, so unless its outcome is carried here it is
 * simply lost, and the panel would show a version that changed with no
 * explanation for why.
 */
export interface CliUpdateState {
  /** Null before the first check has completed. */
  info: CliUpdateInfo | null
  /** Mirrors `Settings.cliAutoUpdate`, so one message answers both questions. */
  auto: boolean
  /** What the last automatic attempt did, or null if none has run. */
  note: string | null
}

/**
 * The CLI follows a channel that is behind `latest`, and by how much.
 *
 * This exists because "up to date" and "up to date *for the stream you are
 * following*" are different sentences, and only the second one is ever true of
 * a pinned install. Measured here on 2026-09-02: `stable` sat at 2.1.236 while
 * `latest` sat at 2.1.258 — twenty-two releases, and a gap that had been
 * growing for weeks. The installed CLI was 2.1.237, i.e. *ahead* of its own
 * channel, so `claude update` correctly declined to do anything and the panel
 * correctly reported nothing to install. Every part of that was working, and
 * the machine still sat three weeks behind with nothing anywhere saying so.
 *
 * Gotcha 46 is the reason this is a separate field rather than a fix to
 * `latest`: `CliUpdateInfo.latest` must keep meaning "what the configured
 * channel would install", because that is the only number `claude update` will
 * act on. Overwriting it with the `latest` channel's version is precisely the
 * bug that entry records. So the second number is carried alongside the first,
 * named for what it is, and the remedy it implies — change the channel — is
 * offered rather than performed.
 */
export interface ChannelLag {
  /**
   * The channel the CLI follows. The same string as `CliUpdateInfo.channel`,
   * repeated so this object can be turned into a sentence on its own.
   */
  channel: string
  /**
   * What that channel would install, or null when the channel publishes no
   * dist-tag at all. Null is not a missing reading: `rc` is offered by Stoke's
   * own control and publishes neither an npm tag nor a GCS object, so pinning
   * to it means never updating again. That case wants the same remedy as a
   * merely stale channel, which is why it is a lag rather than only an error.
   */
  channelVersion: string | null
  /** What the `latest` channel would install. */
  latestVersion: string
}

/** Mirrors `UpdateInfo` in src/main/updates.ts, which the renderer cannot import. */
export interface CliUpdateInfo {
  current: string | null
  latest: string | null
  updateAvailable: boolean
  checkedAt: number
  error: string | null
  /**
   * The release channel `claude update` will actually follow, from the CLI's
   * own `autoUpdatesChannel` setting. `'latest'` when the key is unset, which
   * is the CLI's own default.
   *
   * Here rather than left implicit because `latest` is not the only channel and
   * the difference is not cosmetic: `stable` sat at 2.1.236 while `latest` sat
   * at 2.1.251. Reporting the wrong one's version is how the panel came to
   * advertise an update the updater would always decline. See gotcha 46.
   */
  channel: string
  /**
   * The `latest` channel's version, when the configured channel is something
   * else and is behind it. Null in every other case — including the ordinary
   * one where the channel already IS `latest`, for which no second registry
   * request is made at all.
   *
   * Deliberately independent of `updateAvailable`, which stays a statement
   * about the channel the CLI actually follows. The two are both true at once
   * on a pinned install with nothing to install: `updateAvailable: false` and
   * a lag of twenty-two releases are not in tension, they are the whole point.
   */
  behindLatest: ChannelLag | null
}

/* ----------------------------------------------------------- plan limits */

/**
 * Why the renderer is asking for the account reading, which decides how stale
 * a cached one may be before it is refetched.
 *
 * 'poll' is the idle 30s cadence. 'message' says a new turn has just started —
 * the moment the figures are most likely to have moved and someone is most
 * likely to be looking — and is allowed to pre-empt that interval, subject to
 * a small floor so several sessions starting at once still cost one call.
 */
export type UsageReadReason = 'poll' | 'message'

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

/* ------------------------------------------------------------ tab restore */

/** The last context reading a paused tab had, so its ring is not blank. */
export interface StoredTabContext {
  tokens: number
  limit: number
}

/**
 * One tab as it survives a quit.
 *
 * `id`, `ptyId`, `status` and `exitCode` are deliberately absent: the first two
 * are regenerated on restore and the last two are always "paused" by definition.
 */
export interface StoredTab {
  kind: 'session' | 'new'
  /** '' for a --continue session, which never learns its own id (gotcha 26). */
  sessionId: string
  cwd: string
  projectName: string
  title: string
  permissionMode: PermissionMode
  model: string
  effort: EffortLevel
  /** `SshHost.id` when the session ran on another machine. */
  hostId: string | null
  selectedPath: string | null
  expandedPath: string | null
  lastActiveAt: number
  context: StoredTabContext | null
  /** The visible viewport as plain text. See MAX_SCREEN_BYTES. */
  screen: string
}

export interface StoredTabs {
  version: 1
  savedAt: number
  /** Index into `tabs` of the tab that was selected. Clamped on read. */
  activeIndex: number
  tabs: StoredTab[]
}

/**
 * One project's work on one local day.
 *
 * No `node:` import reaches this file, and must not: both tsconfigs compile
 * `src/shared/**` and the web one carries no node types, so a node import here
 * fails the *web* half of typecheck while the main half stays green — and the
 * error names a file nobody was editing.
 */
export interface ActivitySlice {
  /** Local YYYY-MM-DD. */
  day: string
  project: string
  sessionId: string
  /** Claude Code's own `aiTitle`, when it has written one. */
  title: string | null
  activeMs: number
  /**
   * Lines written or edited — churn, not net repository growth. A rewrite
   * counts the whole file again. Every label that renders this must say so.
   */
  linesWritten: number
  files: string[]
}

export interface ActivityReport {
  slices: ActivitySlice[]
  /** Commit subjects keyed `project|day`. Absent for a folder with no repo. */
  commits: Record<string, string[]>
  /** Transcripts that could not be read; a partial total must say it is partial. */
  skipped: number
  /** Stated in the UI, so the number can be defended rather than merely quoted. */
  idleGapMs: number
}
