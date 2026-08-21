import type { CreateProfileInput, ProfilePlan } from './profiles'
import type {
  BrowserState,
  CliInfo,
  ContextSnapshot,
  LaunchOptions,
  Project,
  ProjectMeta,
  Rect,
  SessionMeta,
  Settings,
  StatusLineSnapshot,
  StoredTabs,
  UsageSnapshot,
  WorklogProposal,
  WorklogProposedEvent,
  WorklogScanReport,
  WorklogWatchState
} from './types'

export interface AudioDevice {
  /** Endpoint id in the form {0.0.1.00000000}.{guid}. */
  id: string
  name: string
}

/** Whether voice dictation is pointed at something that can actually hear you. */
export interface MicrophoneCheck {
  /** Null when the platform is not Windows, or nothing could be read. */
  device: AudioDevice | null
  /** True when the default looks like a virtual cable, so dictation records silence. */
  suspect: boolean
  /** Real microphones that could be selected instead. */
  alternatives: AudioDevice[]
}

/** What is on the OS clipboard right now, read in one synchronous hop. */
export interface ClipboardPeek {
  text: string
  hasImage: boolean
}

export interface StartResult {
  ptyId: string
  sessionId: string
  command: string
  args: string[]
}

/**
 * Claude Code's own configuration, as Stoke found it.
 *
 * Deliberately not merged into one map: the two files behave differently and a
 * reader has to be able to tell which one a value came from. `values` is
 * ~/.claude/settings.json; `workflowSize` is the one key Stoke touches in
 * ~/.claude.json.
 */
export interface ClaudeConfigState {
  settingsPath: string
  globalConfigPath: string
  /** Allowlisted keys and their current values. A key that is unset is absent. */
  values: Record<string, boolean | string | number>
  /** Keys the file carries that Stoke draws no control for, named not hidden. */
  untouched: string[]
  /** The dynamic-workflow size guideline, or undefined when unset (= medium). */
  workflowSize: string | undefined
  /**
   * True when settings.json also defines workflowSizeGuideline. That value wins
   * over the global config AND hides the /config row, so Stoke's own control
   * would be writing to a file nothing reads — the panel says so rather than
   * drawing a switch that does nothing.
   */
  workflowSizeShadowed: boolean
  /** Why the settings file could not be read, if it could not. */
  error: string | null
}

/** The outcome of one write, including whether it had to be retried. */
export interface ClaudeConfigWriteResult {
  ok: boolean
  error: string | null
  state: ClaudeConfigState
  /**
   * True when the write to ~/.claude.json went ahead without holding the CLI's
   * lock, because the lock could not be taken.
   *
   * Worth surfacing rather than swallowing. The lock is what keeps a live
   * `claude` from reading the file, being rewritten underneath, and putting
   * back what it read — and gotcha 38 is the record of what that file losing
   * keys costs: the CLI backs it up and resets to defaults, taking
   * `oauthAccount`, `userID` and every project entry with it. The write still
   * verifies and retries, so an unlocked write is a warning and not a failure,
   * but the user should be able to see that it happened. `writeGlobalConfigKey`
   * has always computed this; the IPC handler used to drop it on the floor, so
   * nothing could ever report it.
   */
  wroteUnlocked?: boolean
  /** How many verify-and-retry passes the write needed. 1 is the quiet case. */
  attempts?: number
}

/** Combined remote-access state: local server, tunnel, and the phone link. */
export interface RemoteState {
  server: {
    running: boolean
    port: number
    error: string | null
    clients: number
    /** Addresses actually bound, e.g. 127.0.0.1 and the tailnet address. */
    addresses: string[]
  }
  tunnel: {
    installed: boolean
    path: string | null
    running: boolean
    mode: 'named' | 'quick' | null
    url: string | null
    log: string[]
    error: string | null
  }
  url: string
  /** Data URL of a QR code for `url`, or null if generation failed. */
  qr: string | null
  /** One-time cloudflared commands the user runs themselves. */
  setup: string[]
}

export interface SelfUpdateState {
  /** False in development, where there is no installed app to replace. */
  supported: boolean
  currentVersion: string
  availableVersion: string | null
  downloaded: boolean
  downloading: boolean
  progress: number
  error: string | null
  checkedAt: number | null
  /**
   * Why this build cannot install an update even though the machinery is
   * present, or null when nothing stands in the way.
   *
   * Distinct from `error`, which is what went wrong on the last attempt. This is
   * known *before* an attempt, so the UI can say so instead of offering a button
   * that downloads ~120 MB and then fails at the last step. The one case today
   * is an ad-hoc signed macOS build: Squirrel.Mac verifies the downloaded app
   * against the running one's designated requirement, and an ad-hoc requirement
   * pins the exact binary hash, so no other build can ever satisfy it.
   */
  blocked: string | null
}

export interface UpdateInfo {
  current: string | null
  latest: string | null
  updateAvailable: boolean
  checkedAt: number
  error: string | null
}

/**
 * The outcome of running one `claude` subcommand.
 *
 * `ok` is the exit status and nothing more. Whether an *update* happened is a
 * separate question that exit status cannot answer — `claude update` exits 0
 * when it is already current, and an npm-global install that cannot write to its
 * own prefix can also exit 0 having changed nothing. `from` and `to` are read
 * either side of the run so the caller can state which of those it was rather
 * than infer it.
 */
export interface CliRunResult {
  /** The command exited zero. Not the same as "something changed". */
  ok: boolean
  /** stdout + stderr, ANSI stripped. Present on both paths; may be empty. */
  output: string
  /** One sentence naming what went wrong. Null when `ok`. */
  error: string | null
  /** CLI version before the command ran. Null if it could not be read. */
  from: string | null
  /** CLI version after. Equal to `from` when nothing was installed. */
  to: string | null
}

/** The surface exposed to the renderer as `window.stoke`. */
export interface StokeApi {
  platform: string

  window: {
    minimize(): void
    maximize(): void
    close(): void
    isMaximized(): Promise<boolean>
    onMaximizedChanged(cb: (maximized: boolean) => void): () => void
    /**
     * Distinct from `isMaximized`, which is false on macOS while full screen.
     * Full screen hides the traffic lights, so the title bar's clearance for
     * them has to collapse with it.
     */
    isFullScreen(): Promise<boolean>
    onFullScreenChanged(cb: (fullScreen: boolean) => void): () => void
  }

  cli: {
    info(): Promise<CliInfo>
  }

  usage: {
    /** Plan limits: the 5-hour window, the weekly window, and any model-scoped one. */
    read(): Promise<UsageSnapshot>
  }

  projects: {
    list(): Promise<Project[]>
    sessions(projectPath: string): Promise<SessionMeta[]>
    /** Pick a folder to add as a scan root; returns the chosen path. */
    addRoot(): Promise<string | null>
    /** Pick a one-off folder to open a session in. */
    open(): Promise<string | null>
    hide(path: string, hidden: boolean): Promise<Settings>
    pin(path: string, pinned: boolean): Promise<Settings>
    /** Set or clear one folder's metadata. `null` deletes the record, which is
     *  also how a folder that exists only because it was added leaves the list. */
    setMeta(path: string, meta: ProjectMeta | null): Promise<Settings>
    reveal(path: string): Promise<string>
  }

  workspace: {
    /** Resolved working directory for a session started without a project. */
    defaultCwd(): Promise<string>
    /** Create a fresh throwaway folder and return its path. */
    createScratch(): Promise<string>
  }

  pty: {
    start(opts: LaunchOptions): Promise<StartResult>
    write(ptyId: string, data: string): void
    resize(ptyId: string, cols: number, rows: number): void
    kill(ptyId: string): void
    onData(cb: (ptyId: string, data: string) => void): () => void
    onExit(cb: (ptyId: string, code: number, signal?: number) => void): () => void
  }

  context: {
    watch(sessionId: string): void
    unwatch(sessionId: string): void
    onUpdate(cb: (snapshot: ContextSnapshot) => void): () => void
  }

  /**
   * The CLI's own statusLine payload: the context window and the plan limits.
   *
   * Only arrives while a session is open and rendering, which is the accepted
   * trade-off for not bundling a Keychain binding — see `last()`.
   */
  statusLine: {
    /**
     * The newest reading seen this run, from whichever session produced it.
     * Rate limits are account-wide, so any session answers for all of them,
     * and this is what lets the usage chip show figures with an "as of HH:MM"
     * when no session is open. Null before the first payload of the run.
     */
    last(): Promise<StatusLineSnapshot | null>
    onUpdate(cb: (snapshot: StatusLineSnapshot) => void): () => void
  }

  browser: {
    /** Ctrl/Cmd+F pressed inside the page view, which owns keyboard focus. */
    onFindRequested(cb: () => void): () => void
    setBounds(rect: Rect): void
    show(url?: string): void
    hide(): void
    navigate(url: string): void
    back(): void
    forward(): void
    reload(): void
    stop(): void
    openExternal(): void
    devtools(): void
    newTab(url?: string): void
    closeTab(id: string): void
    selectTab(id: string): void
    /** findNext advances through matches instead of restarting the search. */
    find(text: string, forward?: boolean, findNext?: boolean): void
    stopFind(): void
    zoom(level: number): void
    /** Toggle the bookmark for the active tab's URL. */
    bookmark(): void
    onState(cb: (state: BrowserState) => void): () => void
  }

  remote: {
    status(): Promise<RemoteState>
    start(): Promise<RemoteState>
    stop(): Promise<RemoteState>
    newToken(): Promise<RemoteState>
    tunnelStart(mode: 'named' | 'quick'): Promise<RemoteState>
    tunnelStop(): Promise<RemoteState>
  }

  updates: {
    check(): Promise<UpdateInfo>
    /**
     * Run `claude update`. Never rejects on a failed update — the reason is in
     * the result, because a rejected promise is what made the old version look
     * like nothing had happened at all.
     */
    run(): Promise<CliRunResult>
    doctor(): Promise<CliRunResult>
  }

  /** Stoke updating itself, via electron-updater and GitHub releases. */
  self: {
    state(): Promise<SelfUpdateState>
    check(): Promise<SelfUpdateState>
    download(): Promise<SelfUpdateState>
    install(): Promise<boolean>
    onState(cb: (state: SelfUpdateState) => void): () => void
  }

  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    onChange(cb: (settings: Settings) => void): () => void
  }

  /**
   * Claude Code's settings, which are not Stoke's. Every write is one key, and
   * `undefined` clears it — absent is a distinct state in that schema, not a
   * synonym for false.
   */
  claudeConfig: {
    read(): Promise<ClaudeConfigState>
    set(key: string, value: boolean | string | number | undefined): Promise<ClaudeConfigWriteResult>
    /**
     * The dynamic-workflow size guideline, written to ~/.claude.json under the
     * CLI's own lock. Slower than the others by design: it verifies the write
     * survived before reporting success.
     */
    setWorkflowSize(value: string | undefined): Promise<ClaudeConfigWriteResult>
  }

  /**
   * Profile creation. Both calls touch the disk, so they live in main: working
   * out what a folder and a name would do, and then doing it.
   */
  profiles: {
    plan(folder: string, name: string): Promise<ProfilePlan>
    create(input: CreateProfileInput): Promise<Settings>
  }

  ssh: {
    /** Host aliases read from the user's own ~/.ssh/config, for the picker. */
    configHosts(): Promise<string[]>
  }

  /**
   * The worklog review queue. A scan only ever proposes; nothing reaches Notion
   * or ClickUp until `accept` is called on an item.
   */
  worklog: {
    queue(): Promise<WorklogProposal[]>
    /** Scan a session's transcript for proposals. Read-only. */
    scan(sessionId: string): Promise<{ added: number; error: string | null }>
    /** The only call that writes to an external service. */
    accept(id: string): Promise<{ ok: boolean; error: string | null }>
    reject(id: string): Promise<void>
    onChange(cb: (items: WorklogProposal[]) => void): () => void
    /**
     * A scan the user did not ask for produced something. Distinct from
     * `onChange`, which fires for every queue mutation including their own
     * accepts — only this one means "there is something new to ask about".
     */
    onProposed(cb: (event: WorklogProposedEvent) => void): () => void
    /** The last scan of any session, for the panel's empty state. */
    lastScan(): Promise<WorklogScanReport | null>
    /**
     * Every scan reports, including the ones that proposed nothing. Distinct
     * from `onProposed`, which only fires when there is something to ask about:
     * this is what lets the panel say "it ran, and there was nothing" instead
     * of looking identical to "it has never run".
     */
    onScanned(cb: (report: WorklogScanReport) => void): () => void
    /**
     * Which sessions the agent may look at, and why. The whole list every time,
     * never a delta — two copies of the same records drift.
     */
    watch(): Promise<WorklogWatchState[]>
    onWatchChanged(cb: (states: WorklogWatchState[]) => void): () => void
  }

  /**
   * The tabs that were open when Stoke last quit.
   *
   * `save` is fire-and-forget on purpose: it runs on a debounce while the user
   * works, and a snapshot that is one write behind is worth far more than one
   * that blocks the UI thread to be exact.
   */
  tabs: {
    save(state: StoredTabs): void
    restore(): Promise<StoredTabs>
  }

  audio: {
    /** What voice dictation will record from, and whether it looks like a virtual cable. */
    micCheck(): Promise<MicrophoneCheck>
    /**
     * A finished 16 kHz mono 16-bit PCM WAV in, a transcript out.
     *
     * Never rejects on a speech-server failure: the result carries the sentence
     * to show instead, because a wedged or absent sidecar is an ordinary state
     * the UI has to render, not an exception. `text` may legitimately be `''`
     * when the clip held no speech.
     */
    transcribe(wav: ArrayBuffer): Promise<{ ok: true; text: string } | { ok: false; error: string }>
  }

  clipboard: {
    /*
     * Synchronous by design. xterm's key handler has to decide whether to
     * swallow the event before it returns, so an async read would always be
     * one keystroke too late.
     */
    readSync(): ClipboardPeek
    writeText(text: string): void
  }

  openExternal(url: string): void

  /**
   * Plain folder picker: opens the OS dialog and hands back the chosen path,
   * with no side effect on `projectMeta` or `hiddenProjects`. `null` when the
   * dialog is cancelled or no window is open to anchor it. Callers that want a
   * folder to become a project want `projects.open()` instead.
   */
  pickFolder(): Promise<string | null>
}
