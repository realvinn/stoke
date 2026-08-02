import type {
  BrowserState,
  CliInfo,
  ContextSnapshot,
  LaunchOptions,
  Project,
  Rect,
  SessionMeta,
  Settings
} from './types'

export interface StartResult {
  ptyId: string
  sessionId: string
  command: string
  args: string[]
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
    onState(cb: (state: BrowserState) => void): () => void
  }

  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    onChange(cb: (settings: Settings) => void): () => void
  }

  openExternal(url: string): void
}
