import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { CH } from '@shared/ipc'
import type { ClipboardPeek, StokeApi } from '@shared/api'
import type {
  Rect,
  LaunchOptions,
  ProjectMeta,
  Settings,
  StoredTabs,
  UsageReadReason
} from '@shared/types'

/** Subscribe helper that hands back an unsubscribe function. */
function on<A extends unknown[]>(
  channel: string,
  cb: (...args: A) => void
): () => void {
  const handler = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: StokeApi = {
  platform: process.platform,

  window: {
    minimize: () => ipcRenderer.send(CH.winMinimize),
    maximize: () => ipcRenderer.send(CH.winMaximize),
    close: () => ipcRenderer.send(CH.winClose),
    isMaximized: () => ipcRenderer.invoke(CH.winIsMaximized),
    onMaximizedChanged: (cb) => on<[boolean]>(CH.winMaximizedChanged, cb),
    isFullScreen: () => ipcRenderer.invoke(CH.winIsFullScreen),
    onFullScreenChanged: (cb) => on<[boolean]>(CH.winFullScreenChanged, cb),
    focus: () => ipcRenderer.send(CH.winFocus),
    systemDark: () => ipcRenderer.invoke(CH.systemDark),
    onSystemDarkChanged: (cb) => on<[boolean]>(CH.systemDarkChanged, cb)
  },

  cli: {
    info: () => ipcRenderer.invoke(CH.cliInfo)
  },

  usage: {
    read: (reason?: UsageReadReason) => ipcRenderer.invoke(CH.usageRead, reason)
  },

  projects: {
    list: () => ipcRenderer.invoke(CH.projectsList),
    sessions: (projectPath: string) => ipcRenderer.invoke(CH.sessionsList, projectPath),
    addRoot: () => ipcRenderer.invoke(CH.projectsAddRoot),
    open: () => ipcRenderer.invoke(CH.projectsAdd),
    hide: (path: string, hidden: boolean) => ipcRenderer.invoke(CH.projectsHide, path, hidden),
    pin: (path: string, pinned: boolean) => ipcRenderer.invoke(CH.projectsPin, path, pinned),
    setMeta: (path: string, meta: ProjectMeta | null) =>
      ipcRenderer.invoke(CH.projectsMeta, path, meta),
    reveal: (path: string) => ipcRenderer.invoke(CH.projectsReveal, path)
  },

  workspace: {
    defaultCwd: () => ipcRenderer.invoke(CH.workspaceDefault),
    createScratch: () => ipcRenderer.invoke(CH.workspaceScratch)
  },

  pty: {
    start: (opts: LaunchOptions) => ipcRenderer.invoke(CH.ptyStart, opts),
    write: (ptyId: string, data: string) => ipcRenderer.send(CH.ptyWrite, ptyId, data),
    resize: (ptyId: string, cols: number, rows: number) =>
      ipcRenderer.send(CH.ptyResize, ptyId, cols, rows),
    kill: (ptyId: string) => ipcRenderer.send(CH.ptyKill, ptyId),
    onData: (cb) => on<[string, string]>(CH.ptyData, cb),
    onExit: (cb) => on<[string, number, number | undefined]>(CH.ptyExit, cb)
  },

  context: {
    watch: (sessionId: string) => ipcRenderer.send(CH.ctxWatch, sessionId),
    unwatch: (sessionId: string) => ipcRenderer.send(CH.ctxUnwatch, sessionId),
    onUpdate: (cb) => on<[Parameters<typeof cb>[0]]>(CH.ctxUpdate, cb)
  },

  statusLine: {
    last: () => ipcRenderer.invoke(CH.statusLineLast),
    onUpdate: (cb) => on<[Parameters<typeof cb>[0]]>(CH.statusLineUpdate, cb)
  },

  session: {
    onEvent: (cb) => on<[Parameters<typeof cb>[0]]>(CH.sessionEvent, cb)
  },

  wallpaper: {
    pick: () => ipcRenderer.invoke(CH.wallpaperPick),
    clear: () => ipcRenderer.invoke(CH.wallpaperClear),
    // The custom scheme main registers for the one directory wallpapers live
    // in; only the file name crosses, never a path.
    url: (path: string) => `stoke-asset://wallpaper/${encodeURIComponent(path.split(/[\\/]/).pop() ?? '')}`
  },

  browser: {
    onFindRequested: (cb) => on<[]>(CH.browserFindRequested, cb),
    setBounds: (rect: Rect) => ipcRenderer.send(CH.browserSetBounds, rect),
    show: (url?: string) => ipcRenderer.send(CH.browserShow, url),
    hide: () => ipcRenderer.send(CH.browserHide),
    navigate: (url: string) => ipcRenderer.send(CH.browserNavigate, url),
    back: () => ipcRenderer.send(CH.browserBack),
    forward: () => ipcRenderer.send(CH.browserForward),
    reload: () => ipcRenderer.send(CH.browserReload),
    stop: () => ipcRenderer.send(CH.browserStop),
    openExternal: () => ipcRenderer.send(CH.browserOpenExternal),
    devtools: () => ipcRenderer.send(CH.browserDevtools),
    newTab: (url?: string) => ipcRenderer.send(CH.browserNewTab, url),
    closeTab: (id: string) => ipcRenderer.send(CH.browserCloseTab, id),
    selectTab: (id: string) => ipcRenderer.send(CH.browserSelectTab, id),
    find: (text: string, forward?: boolean, findNext?: boolean) =>
      ipcRenderer.send(CH.browserFind, text, forward, findNext),
    stopFind: () => ipcRenderer.send(CH.browserStopFind),
    zoom: (level: number) => ipcRenderer.send(CH.browserZoom, level),
    bookmark: () => ipcRenderer.send(CH.browserBookmark),
    onState: (cb) => on<[Parameters<typeof cb>[0]]>(CH.browserState, cb)
  },

  remote: {
    status: () => ipcRenderer.invoke(CH.remoteStatus),
    start: () => ipcRenderer.invoke(CH.remoteStart),
    stop: () => ipcRenderer.invoke(CH.remoteStop),
    newToken: () => ipcRenderer.invoke(CH.remoteNewToken),
    openOnPhone: () => ipcRenderer.invoke(CH.remoteOpenOnPhone),
    onChange: (cb) => on<[Parameters<typeof cb>[0]]>(CH.remoteChanged, cb),
    tunnelStart: (mode: 'named' | 'quick') => ipcRenderer.invoke(CH.tunnelStart, mode),
    tunnelStop: () => ipcRenderer.invoke(CH.tunnelStop),
    tunnelLocate: () => ipcRenderer.invoke(CH.tunnelLocate),
    cloudflareSetup: () => ipcRenderer.invoke(CH.cloudflareSetup),
    cloudflareStep: (step, opts) => ipcRenderer.invoke(CH.cloudflareStep, step, opts)
  },

  updates: {
    check: () => ipcRenderer.invoke(CH.updateCheck),
    run: () => ipcRenderer.invoke(CH.updateRun),
    doctor: () => ipcRenderer.invoke(CH.updateDoctor),
    state: () => ipcRenderer.invoke(CH.updateState),
    onState: (cb) => on<[Parameters<typeof cb>[0]]>(CH.updateState, cb)
  },

  self: {
    state: () => ipcRenderer.invoke(CH.selfState),
    check: () => ipcRenderer.invoke(CH.selfCheck),
    download: () => ipcRenderer.invoke(CH.selfDownload),
    install: () => ipcRenderer.invoke(CH.selfInstall),
    onState: (cb) => on<[Parameters<typeof cb>[0]]>(CH.selfState, cb)
  },

  settings: {
    get: () => ipcRenderer.invoke(CH.settingsGet),
    set: (patch: Partial<Settings>) => ipcRenderer.invoke(CH.settingsSet, patch),
    onChange: (cb) => on<[Settings]>(CH.settingsChanged, cb)
  },

  claudeConfig: {
    read: () => ipcRenderer.invoke(CH.claudeConfigRead),
    set: (key: string, value: boolean | string | number | undefined) =>
      ipcRenderer.invoke(CH.claudeConfigSet, key, value),
    setWorkflowSize: (value: string | undefined) =>
      ipcRenderer.invoke(CH.claudeWorkflowSize, value)
  },

  profiles: {
    plan: (folder: string, name: string) => ipcRenderer.invoke(CH.profilesPlan, folder, name),
    create: (input) => ipcRenderer.invoke(CH.profilesCreate, input)
  },

  ssh: {
    configHosts: () => ipcRenderer.invoke(CH.sshHosts)
  },

  activity: {
    read: (from: number, to: number) => ipcRenderer.invoke(CH.activityRead, from, to)
  },
  worklog: {
    queue: () => ipcRenderer.invoke(CH.worklogQueue),
    scan: (sessionId: string) => ipcRenderer.invoke(CH.worklogScan, sessionId),
    accept: (id: string) => ipcRenderer.invoke(CH.worklogAccept, id),
    reject: (id: string) => ipcRenderer.invoke(CH.worklogReject, id),
    onChange: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogChanged, cb),
    onProposed: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogProposed, cb),
    lastScan: () => ipcRenderer.invoke(CH.worklogLastScan),
    onScanned: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogScanned, cb),
    watch: () => ipcRenderer.invoke(CH.worklogWatch),
    onWatchChanged: (cb) => on<[Parameters<typeof cb>[0]]>(CH.worklogWatchChanged, cb)
  },

  tabs: {
    save: (state: StoredTabs) => ipcRenderer.send(CH.tabsSave, state),
    restore: () => ipcRenderer.invoke(CH.tabsRestore)
  },

  audio: {
    micCheck: () => ipcRenderer.invoke(CH.micCheck),
    // The ArrayBuffer crosses as a structured clone, so the audio never becomes
    // a string on the way — no base64 round trip, and no copy of the clip
    // sitting in a JS string for the GC to get to eventually.
    transcribe: (wav: ArrayBuffer) => ipcRenderer.invoke(CH.transcribe, wav)
  },

  clipboard: {
    readSync: () => ipcRenderer.sendSync(CH.clipboardRead) as ClipboardPeek,
    writeText: (text: string) => ipcRenderer.send(CH.clipboardWrite, text)
  },

  openExternal: (url: string) => ipcRenderer.send(CH.openExternal, url),

  pickFolder: () => ipcRenderer.invoke(CH.pickFolder),

  /*
   * Has to live here, and only here. Electron 32 removed the `path` property
   * Chromium used to hang off a dropped `File`, and `webUtils.getPathForFile`
   * is the replacement — it is a renderer-side API (`electron.d.ts:19628`),
   * so main cannot answer it, and the renderer has no `electron` import to
   * call it with. A File crosses the contextBridge as itself, so the preload
   * is the one place that holds both halves.
   *
   * Returns null rather than throwing for anything that is not a real file on
   * disk: a drag from a browser, or a directory entry Chromium declines to
   * resolve, both arrive as Files with no path.
   */
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file) || null
    } catch {
      return null
    }
  }
}

contextBridge.exposeInMainWorld('stoke', api)
