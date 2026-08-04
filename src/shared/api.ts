import type { CreateProfileInput, ProfilePlan } from './profiles'
import type {
  BrowserState,
  CliInfo,
  ContextSnapshot,
  LaunchOptions,
  Project,
  Rect,
  SessionMeta,
  Settings,
  UsageSnapshot,
  WorklogProposal,
  WorklogProposedEvent
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
}

export interface UpdateInfo {
  current: string | null
  latest: string | null
  updateAvailable: boolean
  checkedAt: number
  error: string | null
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
    run(): Promise<string>
    doctor(): Promise<string>
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
  }

  audio: {
    /** What voice dictation will record from, and whether it looks like a virtual cable. */
    micCheck(): Promise<MicrophoneCheck>
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
}
