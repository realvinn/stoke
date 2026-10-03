import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { CH } from '@shared/ipc'
import type { ClipboardPeek, ImagePrepared, StokeApi, UploadProgress } from '@shared/api'
import type { ChatIndexStatus } from '@shared/chatIndex'
import type { TranscriptFindRequest } from '@shared/transcriptFind'
import type { SttConfig } from '@shared/speechProviders'
import type {
  Rect,
  LaunchOptions,
  ProjectMeta,
  Settings,
  SshAuthPromptEvent,
  SshEnrollEvent,
  StoredTabs,
  UsageReadReason,
  UsageTarget
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
    revealInfo: () => ipcRenderer.invoke(CH.winRevealInfo),
    focus: () => ipcRenderer.send(CH.winFocus),
    systemDark: () => ipcRenderer.invoke(CH.systemDark),
    onSystemDarkChanged: (cb) => on<[boolean]>(CH.systemDarkChanged, cb)
  },

  cli: {
    info: () => ipcRenderer.invoke(CH.cliInfo),
    detect: (opts?: { fresh?: boolean }) => ipcRenderer.invoke(CH.cliDetect, opts),
    skills: () => ipcRenderer.invoke(CH.skillsScan),
    mcpServers: () => ipcRenderer.invoke(CH.mcpCatalog)
  },

  accounts: {
    create: (input) => ipcRenderer.invoke(CH.accountsCreate, input),
    remove: (id) => ipcRenderer.invoke(CH.accountsRemove, id),
    identify: () => ipcRenderer.invoke(CH.accountsIdentify),
    mcp: () => ipcRenderer.invoke(CH.accountsMcp)
  },

  usage: {
    read: (reason?: UsageReadReason, target?: UsageTarget | null) => ipcRenderer.invoke(CH.usageRead, reason, target ?? null),
    all: (reason?: UsageReadReason, target?: UsageTarget | null) => ipcRenderer.invoke(CH.usageAll, reason, target ?? null)
  },

  projects: {
    list: () => ipcRenderer.invoke(CH.projectsList),
    sessions: (projectPath: string) => ipcRenderer.invoke(CH.sessionsList, projectPath),
    sessionIndex: () => ipcRenderer.invoke(CH.sessionsIndex),
    addRoot: () => ipcRenderer.invoke(CH.projectsAddRoot),
    open: () => ipcRenderer.invoke(CH.projectsAdd),
    hide: (path: string, hidden: boolean) => ipcRenderer.invoke(CH.projectsHide, path, hidden),
    pin: (path: string, pinned: boolean) => ipcRenderer.invoke(CH.projectsPin, path, pinned),
    setMeta: (path: string, meta: ProjectMeta | null) =>
      ipcRenderer.invoke(CH.projectsMeta, path, meta),
    reveal: (path: string) => ipcRenderer.invoke(CH.projectsReveal, path)
  },

  git: {
    status: (path: string, fresh?: boolean) => ipcRenderer.invoke(CH.gitStatus, path, fresh === true)
  },

  chats: {
    detect: () => ipcRenderer.invoke(CH.chatsDetect),
    status: () => ipcRenderer.invoke(CH.chatsStatus),
    onStatus: (cb) => on<[ChatIndexStatus]>(CH.chatsStatus, cb),
    search: (query: string) => ipcRenderer.invoke(CH.chatsSearch, query),
    indexNow: () => ipcRenderer.invoke(CH.chatsIndexNow),
    rebuild: () => ipcRenderer.invoke(CH.chatsRebuild),
    deleteIndex: () => ipcRenderer.invoke(CH.chatsDelete),
    importExport: (path?: string | null) => ipcRenderer.invoke(CH.chatsImport, path ?? null),
    removeImport: (importId: number) => ipcRenderer.invoke(CH.chatsRemoveImport, importId),
    open: (chatId: number) => ipcRenderer.invoke(CH.chatsOpen, chatId)
  },

  transcript: {
    find: (req: TranscriptFindRequest) => ipcRenderer.invoke(CH.transcriptFind, req)
  },

  workspace: {
    defaultCwd: () => ipcRenderer.invoke(CH.workspaceDefault),
    createScratch: () => ipcRenderer.invoke(CH.workspaceScratch)
  },

  private: {
    inspect: (ptyId: string) => ipcRenderer.invoke(CH.privateInspect, ptyId),
    states: () => ipcRenderer.invoke(CH.privateStates),
    onState: (cb) => on<[Parameters<typeof cb>[0]]>(CH.privateState, cb)
  },

  pty: {
    start: (opts: LaunchOptions) => ipcRenderer.invoke(CH.ptyStart, opts),
    write: (ptyId: string, data: string) => ipcRenderer.send(CH.ptyWrite, ptyId, data),
    resize: (ptyId: string, cols: number, rows: number) =>
      ipcRenderer.send(CH.ptyResize, ptyId, cols, rows),
    onSized: (cb) => on<Parameters<typeof cb>>(CH.ptySized, cb),
    kill: (ptyId: string) => ipcRenderer.send(CH.ptyKill, ptyId),
    stop: (ptyId: string, capMs?: number) => ipcRenderer.invoke(CH.ptyStop, ptyId, capMs),
    type: (ptyId: string, text: string, enter: boolean) => ipcRenderer.invoke(CH.ptyType, ptyId, text, enter),
    onData: (cb) => on<[string, string]>(CH.ptyData, cb),
    onExit: (cb) => on<[string, number, number | undefined, boolean | null | undefined]>(CH.ptyExit, cb)
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
    onEvent: (cb) => on<[Parameters<typeof cb>[0]]>(CH.sessionEvent, cb),
    onRebind: (cb) => on<[Parameters<typeof cb>[0]]>(CH.sessionRebind, cb),
    onState: (cb) => on<[Parameters<typeof cb>[0]]>(CH.sessionState, cb),
    states: () => ipcRenderer.invoke(CH.sessionState)
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
    snapshot: () => ipcRenderer.invoke(CH.browserSnapshot) as Promise<string | null>,
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
    profileMenu: (x, y) => ipcRenderer.invoke(CH.browserProfileMenu, x, y),
    addProfile: () => ipcRenderer.invoke(CH.browserAddProfile),
    removeProfile: (id) => ipcRenderer.invoke(CH.browserRemoveProfile, id),
    importScan: () => ipcRenderer.invoke(CH.browserImportScan),
    importRun: (keys, what) => ipcRenderer.invoke(CH.browserImportRun, keys, what),
    openFullDiskAccess: () => ipcRenderer.send(CH.browserOpenFullDiskAccess),
    renameProfile: (id, label) => ipcRenderer.invoke(CH.browserRenameProfile, id, label),
    useProfile: (id) => ipcRenderer.invoke(CH.browserUseProfile, id),
    dismissImportOffer: () => ipcRenderer.invoke(CH.browserDismissImportOffer),
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
    cloudflareStep: (step, opts) => ipcRenderer.invoke(CH.cloudflareStep, step, opts),
    onSessionStarted: (cb) => on<[Parameters<typeof cb>[0]]>(CH.remoteSessionStarted, cb),
    lookupAccess: () => ipcRenderer.invoke(CH.remoteLookupAccess)
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

  backup: {
    status: () => ipcRenderer.invoke(CH.secretsStatus),
    exportSetup: (req) => ipcRenderer.invoke(CH.setupExport, req),
    pickImport: () => ipcRenderer.invoke(CH.setupImportPick),
    previewImport: (passphrase: string) => ipcRenderer.invoke(CH.setupImportPreview, passphrase),
    applyImport: (opts) => ipcRenderer.invoke(CH.setupImportApply, opts),
    cancelImport: () => ipcRenderer.invoke(CH.setupImportCancel)
  },

  hub: {
    view: () => ipcRenderer.invoke(CH.hubView),
    onChange: (cb) => on<[Parameters<typeof cb>[0]]>(CH.hubChanged, cb),
    setUrl: (url) => ipcRenderer.invoke(CH.hubSetUrl, url),
    checkUrl: (url) => ipcRenderer.invoke(CH.hubCheckUrl, url),
    signIn: (req) => ipcRenderer.invoke(CH.hubSignIn, req),
    signOut: () => ipcRenderer.invoke(CH.hubSignOut),
    createVault: () => ipcRenderer.invoke(CH.hubCreateVault),
    kit: () => ipcRenderer.invoke(CH.hubKit),
    confirmKit: (group) => ipcRenderer.invoke(CH.hubKitConfirm, group),
    cancelKit: () => ipcRenderer.invoke(CH.hubKitCancel),
    saveKit: () => ipcRenderer.invoke(CH.hubKitSave),
    printKit: () => ipcRenderer.invoke(CH.hubKitPrint),
    newKit: () => ipcRenderer.invoke(CH.hubNewKit),
    joinStart: () => ipcRenderer.invoke(CH.hubJoinStart),
    joinCancel: () => ipcRenderer.invoke(CH.hubJoinCancel),
    joinConfirm: (match) => ipcRenderer.invoke(CH.hubJoinConfirm, match),
    recover: (kit) => ipcRenderer.invoke(CH.hubRecover, kit),
    approveStart: (pair) => ipcRenderer.invoke(CH.hubApproveStart, pair),
    approveConfirm: (pair) => ipcRenderer.invoke(CH.hubApproveConfirm, pair),
    refuse: (pair) => ipcRenderer.invoke(CH.hubRefuse, pair),
    syncNow: () => ipcRenderer.invoke(CH.hubSyncNow),
    setScope: (patch) => ipcRenderer.invoke(CH.hubSetScope, patch),
    setAccountKeys: (on) => ipcRenderer.invoke(CH.hubSetAccountKeys, on),
    rename: (deviceId, name) => ipcRenderer.invoke(CH.hubRename, deviceId, name),
    revoke: (deviceId, how) => ipcRenderer.invoke(CH.hubRevoke, deviceId, how),
    dismissNotes: () => ipcRenderer.invoke(CH.hubDismissNotes),
    republish: () => ipcRenderer.invoke(CH.hubRepublish),
    applyHeld: (group) => ipcRenderer.invoke(CH.hubApplyHeld, group),
    keepHeld: (group) => ipcRenderer.invoke(CH.hubKeepHeld, group),
    localKeys: () => ipcRenderer.invoke(CH.hubLocalKeys),
    shareKey: (name) => ipcRenderer.invoke(CH.hubShareKey, name),
    unshareKey: (keyId) => ipcRenderer.invoke(CH.hubUnshareKey, keyId),
    installKey: (keyId) => ipcRenderer.invoke(CH.hubInstallKey, keyId),
    remote: {
      view: () => ipcRenderer.invoke(CH.hubRemoteView),
      onChange: (cb) => on<[Parameters<typeof cb>[0]]>(CH.hubRemoteChanged, cb),
      onFrame: (cb) => on<Parameters<typeof cb>>(CH.hubRemoteFrame, cb),
      open: (deviceId, ptyId) => ipcRenderer.invoke(CH.hubRemoteOpen, deviceId, ptyId),
      input: (tabId, data) => ipcRenderer.send(CH.hubRemoteInput, tabId, data),
      resize: (tabId, cols, rows) => ipcRenderer.send(CH.hubRemoteResize, tabId, cols, rows),
      close: (tabId) => ipcRenderer.invoke(CH.hubRemoteClose, tabId),
      retry: (tabId) => ipcRenderer.invoke(CH.hubRemoteRetry, tabId),
      answer: (askId, answer) => ipcRenderer.invoke(CH.hubRemoteAnswer, askId, answer),
      dropGuests: () => ipcRenderer.invoke(CH.hubRemoteDrop),
      setSharing: (share) => ipcRenderer.invoke(CH.hubSetSharing, share),
      revokeGrant: (deviceId) => ipcRenderer.invoke(CH.hubRevokeGrant, deviceId),
      searchChats: (query) => ipcRenderer.invoke(CH.hubSearchChats, query),
      openChat: (deviceId, source, nativeId) => ipcRenderer.invoke(CH.hubOpenRemoteChat, deviceId, source, nativeId),
      endChatSearch: () => ipcRenderer.send(CH.hubEndChatSearch),
      setShareChats: (on, deviceIds) => ipcRenderer.invoke(CH.hubSetShareChats, on, deviceIds),
      chatGrants: () => ipcRenderer.invoke(CH.hubChatGrants),
      removeChatGrant: (deviceId) => ipcRenderer.invoke(CH.hubRemoveChatGrant, deviceId)
    }
  },

  claudeConfig: {
    read: () => ipcRenderer.invoke(CH.claudeConfigRead),
    set: (key: string, value: boolean | string | number | undefined) =>
      ipcRenderer.invoke(CH.claudeConfigSet, key, value),
    setWorkflowSize: (value: string | undefined) =>
      ipcRenderer.invoke(CH.claudeWorkflowSize, value),
    launchDefaults: (cwd: string | null) => ipcRenderer.invoke(CH.claudeLaunchDefaults, cwd)
  },

  profiles: {
    plan: (folder: string, name: string) => ipcRenderer.invoke(CH.profilesPlan, folder, name),
    create: (input) => ipcRenderer.invoke(CH.profilesCreate, input)
  },

  ssh: {
    configHosts: () => ipcRenderer.invoke(CH.sshHosts),
    awaitingPassword: (ptyId: string) => ipcRenderer.invoke(CH.sshAwaitingPassword, ptyId),
    onPasswordPrompt: (cb) => on<[SshAuthPromptEvent]>(CH.sshAuthPrompt, cb),
    onEnrollEvent: (cb) => on<[SshEnrollEvent]>(CH.sshEnrollEvent, cb),
    remoteSessions: (hostId: string) => ipcRenderer.invoke(CH.sshRemoteSessions, hostId),
    endRemoteSession: (hostId: string, name: string) => ipcRenderer.invoke(CH.sshEndRemoteSession, hostId, name),
    prepareImage: (hostId, source) => ipcRenderer.invoke(CH.sshImagePrepare, hostId, source),
    /*
     * The path is read HERE, off the File the drop handed the page — the one
     * place holding both halves (see `pathForFile` below) — so the page names
     * a File and never a path. A File with no path behind it (a drag out of a
     * browser) is answered without asking main.
     */
    prepareFile: async (hostId: string, file: File): Promise<ImagePrepared> => {
      let path = ''
      try {
        path = webUtils.getPathForFile(file)
      } catch {
        path = ''
      }
      if (!path) return { ok: false, reason: 'not-file', message: `${file.name || 'That file'} is not a file on this computer.` }
      return ipcRenderer.invoke(CH.sshFilePrepare, hostId, path)
    },
    prepareClipboardFiles: (hostId: string) => ipcRenderer.invoke(CH.sshClipboardFilesPrepare, hostId),
    sendImage: (uploadId: string) => ipcRenderer.invoke(CH.sshImageSend, uploadId),
    cancelImage: (uploadId: string) => ipcRenderer.invoke(CH.sshImageCancel, uploadId),
    onUploadProgress: (cb) => on<[UploadProgress]>(CH.sshUploadProgress, cb)
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
    voiceState: () => ipcRenderer.invoke(CH.voiceState),
    requestMic: () => ipcRenderer.invoke(CH.micRequest),
    openMicPrivacy: () => ipcRenderer.send(CH.micPrivacy),
    sttStatus: () => ipcRenderer.invoke(CH.sttStatus),
    voiceTest: (cfg: SttConfig) => ipcRenderer.invoke(CH.voiceTest, cfg),
    // The ArrayBuffer crosses as a structured clone, so the audio never becomes
    // a string on the way — no base64 round trip, and no copy of the clip
    // sitting in a JS string for the GC to get to eventually.
    transcribe: (wav: ArrayBuffer) => ipcRenderer.invoke(CH.transcribe, wav)
  },

  clipboard: {
    readSync: () => ipcRenderer.sendSync(CH.clipboardRead) as ClipboardPeek,
    writeText: (text: string) => ipcRenderer.send(CH.clipboardWrite, text)
  },

  launch: {
    pending: () => ipcRenderer.invoke(CH.cliPending),
    onRequest: (cb) => on<[Parameters<typeof cb>[0]]>(CH.cliRequest, cb)
  },

  command: {
    state: () => ipcRenderer.invoke(CH.commandState),
    install: () => ipcRenderer.invoke(CH.commandInstall),
    remove: () => ipcRenderer.invoke(CH.commandRemove)
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
