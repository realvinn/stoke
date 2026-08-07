import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import { resolveTheme } from '@shared/themes'
import type { LaunchOptions, Rect, Settings, SshHost, StatusLineSnapshot } from '@shared/types'
import { EmbeddedBrowser } from './browser.ts'
import { probeClaude } from './cli.ts'
import { ContextWatcher } from './context.ts'
import { findSessionFile, listProjects, listSessions } from './projects.ts'
import { parseSession, readTranscript } from './sessionFile.ts'
import { fetchRemoteTranscript } from './sshTranscript.ts'
import { PtyManager, type StartResult } from './pty.ts'
import { checkMicrophone } from './audio/defaultDevice.ts'
import { createProfile, planProfile } from './profiles.ts'
import { readSshConfigHosts } from './ssh.ts'
import { getWorklogQueue } from './worklog/queue.ts'
import {
  applyProposal,
  scanSession,
  CLICKUP_LIST_ID,
  NOTION_DATA_SOURCE
} from './worklog/runner.ts'
import { groupForCwd, shouldWatch } from './worklog/gate.ts'
import { AutoScanner } from './worklog/autoscan.ts'
import { invalidateRecall, recall } from './worklog/recall.ts'
import type { CreateProfileInput } from '@shared/profiles'
import { getSettings, setSettings } from './store.ts'
import {
  readStatusLine,
  sweepStaleSessionFiles,
  userStatusLineCommand,
  windowFor,
  writeSessionSettingsFile
} from './statusLine.ts'
import { createScratchDir, resolveDefaultCwd } from './workspace.ts'
import { BrowserMcpServer } from './mcp/server.ts'
import { connectUrl, generateToken, RemoteServer, type RemoteDeps } from './remote/server.ts'
import { TunnelManager } from './remote/tunnel.ts'
import { checkForUpdate, runDoctor, runUpdate } from './updates.ts'
import { fetchUsage, type UsageSnapshot } from './usage.ts'
import {
  checkSelfUpdate,
  downloadSelfUpdate,
  initSelfUpdate,
  installSelfUpdate,
  selfUpdateState
} from './selfUpdate.ts'
import QRCode from 'qrcode'

const isMac = process.platform === 'darwin'
const isWindows = process.platform === 'win32'
/** Must match --titlebar-h in app.css, or the overlay and the bar disagree. */
const TITLEBAR_H = 44

let win: BrowserWindow | null = null
let browser: EmbeddedBrowser | null = null
let ptys: PtyManager | null = null
let watcher: ContextWatcher | null = null
let autoscan: AutoScanner | null = null
let mcp: BrowserMcpServer | null = null
/** Path of the generated --mcp-config file; null until the server is up. */
let mcpConfigPath: string | null = null
let remote: RemoteServer | null = null
let usageCache: UsageSnapshot | null = null
/**
 * The newest statusLine reading seen this run, whichever session produced it.
 *
 * The rate limits in it are account-wide, so any open session's payload
 * answers for all of them — and keeping one means the usage chip still has
 * figures once every tab is closed, which is the whole "as of HH:MM" case.
 */
let lastStatusLine: StatusLineSnapshot | null = null
/** receivedAt of the last payload pushed per session, so nothing is sent twice. */
const statusLineSeen = new Map<string, number>()

/**
 * Push a session's payload at the renderer, if it has actually changed.
 *
 * The file is rewritten on every frame the CLI renders, so the mtime guard is
 * load-bearing rather than tidy: without it this is several IPC messages a
 * second per open session, carrying identical objects.
 */
function pushStatusLine(sessionId: string): void {
  const snap = readStatusLine(sessionId)
  if (!snap) return
  if (statusLineSeen.get(sessionId) === snap.receivedAt) return
  statusLineSeen.set(sessionId, snap.receivedAt)
  lastStatusLine = snap
  send(CH.statusLineUpdate, snap)
}

/**
 * Bring `lastStatusLine` up to date from every live session's payload file.
 *
 * `pushStatusLine` above only runs for sessions the context watcher watches,
 * which is every session Stoke minted an id for — but not a `--continue`,
 * whose id the CLI chooses after launch and which is therefore watched by
 * nothing. Its payload exists all the same, under its launch key.
 *
 * That matters because the rate limits in a payload are ACCOUNT-wide: any open
 * session answers for all of them. Without this, the one launch path we cannot
 * predict is also the one that contributes no usage figures at all.
 *
 * Called from the `statusline:last` invoke, not on a timer: the chip asks when
 * it opens, and a handful of small reads on demand is cheaper than polling
 * files that are rewritten three times a second anyway.
 */
function refreshLastStatusLine(): void {
  for (const key of ptys?.statusKeys() ?? []) {
    const snap = readStatusLine(key)
    if (!snap) continue
    if (!lastStatusLine || snap.receivedAt > lastStatusLine.receivedAt) lastStatusLine = snap
  }
}
const tunnel = new TunnelManager()

/**
 * Where each session was started, kept past the life of its PTY.
 *
 * `ptys.list()` is the live answer and is gone the moment a tab closes — but
 * closing a tab is when a work block usually ends, and the worklog gate needs a
 * folder to resolve the group from. Without this, finishing and closing means
 * the session can never be placed and so is never logged. Bounded by the
 * sessions started in one run, which is a handful of strings.
 */
const sessionCwds = new Map<string, string>()

/**
 * Which sessions are running on another machine, and on which host.
 *
 * An SSH session spawns `ssh -t <alias> <command>`, so `claude` runs over there
 * and its transcript is written over there. Nothing in `SessionInfo` records
 * that, and every transcript reader needs to know — a remote session looked up
 * locally simply never resolves, which is why the context meter has always been
 * blank for one.
 */
const sessionHosts = new Map<string, SshHost>()

/**
 * How often a remote session's transcript is pulled back.
 *
 * The local cadence is 1.5s, which is a `stat` on this disk. This is an SSH
 * round trip and a file transfer, so it gets a cadence that suits a network:
 * slow enough to be unnoticeable on the link, fast enough that the meter is not
 * telling the user something untrue.
 */
const REMOTE_POLL_MS = 30_000


/** The folder a session ran in, live or remembered. */
function cwdForSession(sessionId: string): string {
  return (
    ptys?.list().find((s) => s.sessionId === sessionId)?.cwd || sessionCwds.get(sessionId) || ''
  )
}

/** The host a session is running on, or null when it is local. */
function hostForSession(sessionId: string): SshHost | null {
  const remembered = sessionHosts.get(sessionId)
  if (!remembered) return null
  // Re-read from settings rather than trusting the copy taken at launch: the
  // worklog switch can be turned off while the session is still open, and that
  // has to take effect at once.
  return getSettings().hosts.find((h) => h.id === remembered.id) ?? remembered
}

/**
 * The transcript for a session, wherever it lives.
 *
 * For a local session this is the file Claude wrote. For a remote one it is a
 * local cache of the file Claude wrote on the far machine, pulled back over the
 * same connection the session is already using. Both are plain JSONL, so every
 * caller downstream is unchanged.
 */
async function transcriptFor(sessionId: string): Promise<string | null> {
  const host = hostForSession(sessionId)
  if (!host) return findSessionFile(sessionId)
  /*
   * The per-host switch gates the *copy*, not just the write-up.
   *
   * Fetching pulls a conversation off somebody's machine and puts it on this
   * one. Doing that for the context meter alone — a nicety — while the user has
   * said no to the worklog would be taking the opt-in for one thing as consent
   * for another. So an unticked host is never read at all, and its meter stays
   * blank exactly as it always has.
   */
  if (host.worklog !== true) return null
  const fetched = await fetchRemoteTranscript(host, sessionId, app.getPath('userData'))
  return fetched?.file ?? null
}

/** Starting a session, shared by the renderer's IPC and the remote server. */
async function launchSession(opts: LaunchOptions): Promise<StartResult> {
  if (!ptys) throw new Error('Window is not ready')
  const settings = getSettings()
  // `statusKey` is what the files are named after, not necessarily a session
  // id: a --continue session has no id until the CLI picks one. See pty.ts.
  const result = await ptys.start(opts, settings.claudePath, mcpConfigPath, (statusKey) =>
    writeSessionSettingsFile({
      sessionId: statusKey,
      ultracode: opts.ultracode === true,
      hideStatusLine: settings.hideStatusLine,
      // Read now rather than cached: it is the user's own settings.json and
      // they can edit it between one session and the next.
      passthroughCommand: settings.hideStatusLine ? '' : userStatusLineCommand()
    })
  )
  // Empty for a --continue, and `watch('')` is a no-op by design (context.ts:99).
  // Such a session has never had a context meter; see this task's header for
  // why closing that gap belongs to a later change and not to this one.
  watcher?.watch(result.sessionId)
  const cwd = ptys.list().find((s) => s.sessionId === result.sessionId)?.cwd
  if (cwd) sessionCwds.set(result.sessionId, cwd)
  if (opts.host) sessionHosts.set(result.sessionId, opts.host)
  return result
}

/** Ensure a remote key exists before the server or a QR link needs one. */
function remoteConfig(): Settings['remote'] {
  const s = getSettings()
  if (!s.remote.token) {
    const next = setSettings({ remote: { ...s.remote, token: generateToken() } })
    return next.remote
  }
  return s.remote
}

/**
 * One definition of what the remote server can reach into, used by both places
 * a RemoteServer is constructed. They had drifted apart before as separate
 * literals, which is the kind of divergence that shows up as a feature working
 * only when the app happens to have started with remote access already on.
 */
function remoteDeps(): RemoteDeps {
  return {
    ptys: () => ptys,
    watcher: () => watcher,
    listProjects: () => listProjects(getSettings()),
    startSession: (opts) => launchSession(opts),
    defaultCwd: () => resolveDefaultCwd(getSettings().defaultCwd),
    listSessions: (projectPath) => listSessions(projectPath),
    readTranscript: async (sessionId) => {
      const file = await findSessionFile(sessionId)
      return file ? readTranscript(file) : null
    }
  }
}

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
}

/* --------------------------------------------------------------- worklog */

/** The process-wide review queue. */
function worklogQueue(): ReturnType<typeof getWorklogQueue> {
  return getWorklogQueue(app.getPath('userData'))
}

/**
 * One worklog scan, however it was asked for.
 *
 * Shared by the Scan button and the automatic trigger deliberately: the two
 * differ only in who asked, and every other behaviour — reading the boards
 * first, resolving the group, folding the result into the queue — has to stay
 * identical or the automatic path becomes a second, less-tested feature.
 *
 * Throws. Both callers want to report the failure differently.
 */
async function runWorklogScan(sessionId: string, auto: boolean): Promise<number> {
  const host = hostForSession(sessionId)
  const file = await transcriptFor(sessionId)
  if (!file) {
    throw new Error(
      host
        ? `could not read a transcript on ${host.label || host.alias} — the session may not have started Claude yet`
        : 'no transcript found for that session yet'
    )
  }

  const settings = getSettings()
  const projects = await listProjects(settings)

  /*
   * A remote session is placed by the machine it runs on, not by a folder.
   * `SessionInfo.cwd` for one is wherever Stoke happened to be pointed locally,
   * so resolving a project group from it would name the wrong project. The real
   * working directory is recorded in the transcript itself, which by this point
   * has been fetched — so the proposal names the remote path, and the host takes
   * the place of the project group.
   */
  const cwd = host ? ((await parseSession(file)).cwd ?? '') : cwdForSession(sessionId)
  const group = host ? host.label || host.alias : (groupForCwd(cwd, projects, settings.projectRoots) ?? '')

  // Cached and single-flighted, so a scan of two sessions a second apart reads
  // the boards once. A failure here is reported to the scan rather than thrown:
  // proposing creates with no idea what exists is degraded, not broken.
  const snapshot = await recall({
    clickupListId: CLICKUP_LIST_ID,
    notionDataSource: NOTION_DATA_SOURCE,
    // The same directory the write would use, so both runs see the same MCP
    // servers. runHeadless falls back to a scratch dir if it has been deleted.
    cwd,
    claudePath: settings.claudePath
  })
  if (snapshot.error) console.warn('[stoke] worklog recall failed:', snapshot.error)

  const outcome = await scanSession({
    sessionId,
    transcriptFile: file,
    cwd,
    group,
    recall: snapshot,
    auto,
    claudePath: settings.claudePath
  })
  if (outcome.demoted > 0) {
    // Not silent: a steady count means recall is truncating or the model is
    // inventing ids, and both look exactly like the feature working.
    console.warn(
      `[stoke] worklog: ${outcome.demoted} update(s) named a record that is not on the boards, filed as new instead`
    )
  }

  const added = worklogQueue().add(outcome.proposals)
  send(CH.worklogChanged, worklogQueue().list())
  if (auto && added.length) {
    // Reversed to match `list()`, which is newest first — so the prompt walks
    // them in the same order the panel shows them.
    send(CH.worklogProposed, { sessionId, ids: added.map((p) => p.id).reverse() })
  }
  return added.length
}

function createWindow(): void {
  const settings = getSettings()
  const theme = resolveTheme(settings.themeId, settings.customThemes)

  win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 940,
    minHeight: 580,
    show: false,
    backgroundColor: theme.colors.bg,
    /*
     * macOS keeps its native frame so the traffic lights stay put. Windows now
     * uses a native overlay rather than buttons drawn in the renderer: those
     * looked close but never right, and more importantly a hand-drawn maximise
     * button loses Windows 11's Snap Layouts, which appear on hover over the
     * real one. Linux has no overlay and keeps the custom row.
     */
    frame: isMac || !isWindows,
    titleBarStyle: isMac ? 'hiddenInset' : isWindows ? 'hidden' : 'default',
    titleBarOverlay: isWindows
      ? {
          color: theme.colors.bgSunken,
          symbolColor: theme.colors.textMuted,
          height: TITLEBAR_H
        }
      : undefined,
    trafficLightPosition: isMac ? { x: 16, y: 18 } : undefined,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false
    }
  })

  win.once('ready-to-show', () => win?.show())

  const pushMaximized = (): void => send(CH.winMaximizedChanged, win?.isMaximized() ?? false)
  win.on('maximize', pushMaximized)
  win.on('unmaximize', pushMaximized)
  win.on('enter-full-screen', pushMaximized)
  win.on('leave-full-screen', pushMaximized)

  // Anything the app UI itself tries to open goes to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  browser = new EmbeddedBrowser(
    win,
    (state) => send(CH.browserState, state),
    () => send(CH.browserFindRequested)
  )
  browser.setBookmarks(settings.browser.bookmarks)

  // Self-update: report progress to the UI, and check once shortly after launch
  // so the check never competes with startup work.
  initSelfUpdate((s) => send(CH.selfState, s))
  setTimeout(() => void checkSelfUpdate(), 8000)

  // Expose the docked browser to Claude Code. Started eagerly so the config
  // file exists before the first session is launched.
  mcp = new BrowserMcpServer(browser)
  void mcp
    .start()
    .then((path) => {
      mcpConfigPath = path
    })
    .catch((err) => console.error('[stoke] browser MCP server failed to start', err))

  ptys = new PtyManager(
    (ptyId, data) => send(CH.ptyData, ptyId, data),
    (ptyId, code, signal) => send(CH.ptyExit, ptyId, code, signal)
  )
  /*
   * The worklog's automatic trigger.
   *
   * Built before the watcher because the watcher feeds it: every context
   * reading is also an activity reading, so noticing that a work block finished
   * costs no new polling, no new file handles and no new IPC. See
   * worklog/autoscan.ts for why the transcript is the right signal.
   */
  autoscan = new AutoScanner({
    enabled: () => getSettings().worklogAuto && getSettings().worklogGroups.length > 0,
    watched: async (sessionId) => {
      const settings = getSettings()
      if (!settings.worklogAuto) return false
      /*
       * A remote session is gated by the machine it runs on, not by a folder.
       * Its local cwd is whatever Stoke was pointed at when the connection was
       * opened, so the folder gate would either match by accident — filing a
       * remote box's work under a local project — or never match at all. Both
       * are silent, so SSH gets its own explicit switch.
       */
      const host = hostForSession(sessionId)
      if (host) return host.worklog === true
      // A current project list, not one cached at boot: a repository cloned
      // during this run is a project the gate has to be able to see.
      return shouldWatch(
        cwdForSession(sessionId),
        await listProjects(settings),
        settings.worklogGroups,
        settings.projectRoots
      )
    },
    scan: async (sessionId) => {
      try {
        return await runWorklogScan(sessionId, true)
      } catch (err) {
        // Swallowed here on purpose: an unattended scan that failed is a log
        // line, not a dialog over whatever the user is doing.
        console.warn('[stoke] automatic worklog scan failed', err)
        return 0
      }
    }
  })
  autoscan.start()

  // The window size comes from the statusLine payload first and the CLI's own
  // startup banner second; see windowFor. The banner used to be the only
  // source and 2.1.221 stopped printing it.
  watcher = new ContextWatcher(
    (snap) => {
      send(CH.ctxUpdate, snap)
      pushStatusLine(snap.sessionId)
      // `ready` is false for the placeholder emitted while a brand-new session
      // has no transcript yet; its counts are zeroes and would set a baseline
      // the real first reading then blows straight past.
      if (snap.ready) autoscan?.observe(snap.sessionId, snap.messageCount, snap.updatedAt)
    },
    (sessionId) => windowFor(sessionId, ptys?.bannerWindowFor(sessionId) ?? null),
    {
      /*
       * One poller, both kinds of session.
       *
       * A remote transcript is fetched back over the same connection rather
       * than read off this disk, and routing it through the watcher rather
       * than beside it is what makes everything downstream work unchanged:
       * the context meter starts reading for SSH sessions, and the auto-scan
       * trigger — which is fed from these very snapshots — starts firing for
       * them too. Without it the worklog over SSH would only ever run from the
       * Scan button.
       */
      resolve: (sessionId) => transcriptFor(sessionId),
      volatile: (sessionId) => hostForSession(sessionId) !== null,
      // A network round trip cannot run at the local 1.5s. Slow enough to be
      // unnoticeable on the link, fast enough that the meter is not a lie.
      pollMs: (sessionId) => (hostForSession(sessionId) ? REMOTE_POLL_MS : null)
    }
  )

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  // Bring remote access back up if it was left on.
  if (getSettings().remote.enabled) {
    const cfg = remoteConfig()
    remote = new RemoteServer(remoteDeps())
    void remote.start(cfg).then(() => {
      if (cfg.autoStartTunnel && cfg.hostname) {
        tunnel.start('named', { port: cfg.port, tunnelName: cfg.tunnelName, hostname: cfg.hostname })
      }
    })
  }

  win.on('closed', () => {
    ptys?.killAll()
    watcher?.disposeAll()
    autoscan?.dispose()
    autoscan = null
    mcp?.stop()
    void remote?.stop()
    tunnel.stop()
    remote = null
    browser = null
    ptys = null
    watcher = null
    mcp = null
    mcpConfigPath = null
    win = null
  })
}

function registerIpc(): void {
  /* ---------------------------------------------------------- window chrome */
  ipcMain.on(CH.winMinimize, () => win?.minimize())
  ipcMain.on(CH.winMaximize, () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on(CH.winClose, () => win?.close())
  ipcMain.handle(CH.winIsMaximized, () => win?.isMaximized() ?? false)

  /* ------------------------------------------------------------------- cli */
  ipcMain.handle(CH.cliInfo, () => probeClaude(getSettings().claudePath))

  /* ---------------------------------------------------------- plan limits */
  /*
   * Cached for a minute. The renderer polls so the countdown stays honest, but
   * the endpoint is undocumented and the numbers move in whole percentage
   * points, so there is nothing to gain from hammering it.
   */
  ipcMain.handle(CH.usageRead, async () => {
    const now = Date.now()
    // A rate-limited or failing endpoint asks for a longer wait than the
    // ordinary poll; honour it rather than knocking every minute regardless.
    const wait = usageCache?.retryAfter ?? 60_000
    if (usageCache && now - usageCache.fetchedAt < wait) return usageCache
    usageCache = await fetchUsage(now)
    return usageCache
  })

  /* -------------------------------------------------------------- projects */
  ipcMain.handle(CH.projectsList, () => listProjects(getSettings()))
  ipcMain.handle(CH.sessionsList, (_e, projectPath: string) => listSessions(projectPath))

  ipcMain.handle(CH.projectsAddRoot, async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Add a folder to scan for projects',
      properties: ['openDirectory', 'createDirectory']
    })
    if (res.canceled || !res.filePaths[0]) return null
    const dir = res.filePaths[0]
    const s = getSettings()
    if (!s.projectRoots.includes(dir)) {
      setSettings({ projectRoots: [...s.projectRoots, dir] })
    }
    return dir
  })

  ipcMain.handle(CH.projectsAdd, async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Open a project folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })

  /* ------------------------------------------------------------- workspaces */
  ipcMain.handle(CH.workspaceDefault, () => resolveDefaultCwd(getSettings().defaultCwd))
  ipcMain.handle(CH.workspaceScratch, () => createScratchDir())

  ipcMain.handle(CH.projectsHide, (_e, path: string, hidden: boolean) => {
    const s = getSettings()
    const next = hidden
      ? [...new Set([...s.hiddenProjects, path])]
      : s.hiddenProjects.filter((p) => p !== path)
    return setSettings({ hiddenProjects: next })
  })

  ipcMain.handle(CH.projectsPin, (_e, path: string, pinned: boolean) => {
    const s = getSettings()
    const next = pinned
      ? [...new Set([...s.pinnedProjects, path])]
      : s.pinnedProjects.filter((p) => p !== path)
    return setSettings({ pinnedProjects: next })
  })

  ipcMain.handle(CH.projectsReveal, (_e, path: string) => shell.openPath(path))

  /* ------------------------------------------------------------------- pty */
  ipcMain.handle(CH.ptyStart, (_e, opts: LaunchOptions) => launchSession(opts))

  ipcMain.on(CH.ptyWrite, (_e, ptyId: string, data: string) => ptys?.write(ptyId, data))
  ipcMain.on(CH.ptyResize, (_e, ptyId: string, cols: number, rows: number) =>
    ptys?.resize(ptyId, cols, rows)
  )
  ipcMain.on(CH.ptyKill, (_e, ptyId: string) => {
    const sessionId = ptys?.sessionIdFor(ptyId)
    ptys?.kill(ptyId)
    if (sessionId) {
      watcher?.unwatch(sessionId)
      statusLineSeen.delete(sessionId)
    }
  })

  /* --------------------------------------------------------------- context */
  ipcMain.on(CH.ctxWatch, (_e, sessionId: string) => watcher?.watch(sessionId))
  ipcMain.on(CH.ctxUnwatch, (_e, sessionId: string) => watcher?.unwatch(sessionId))
  ipcMain.handle(CH.statusLineLast, () => {
    // Sweep first, so a session nothing watches — a --continue — still
    // contributes its account-wide rate limits. See refreshLastStatusLine.
    refreshLastStatusLine()
    return lastStatusLine
  })

  /* --------------------------------------------------------------- browser */
  ipcMain.on(CH.browserSetBounds, (_e, rect: Rect) => browser?.setBounds(rect))
  ipcMain.on(CH.browserShow, (_e, url?: string) => browser?.show(url))
  ipcMain.on(CH.browserHide, () => browser?.hide())
  ipcMain.on(CH.browserNavigate, (_e, url: string) => browser?.navigate(url))
  ipcMain.on(CH.browserBack, () => browser?.back())
  ipcMain.on(CH.browserForward, () => browser?.forward())
  ipcMain.on(CH.browserReload, () => browser?.reload())
  ipcMain.on(CH.browserStop, () => browser?.stop())
  ipcMain.on(CH.browserOpenExternal, () => browser?.openExternal())
  ipcMain.on(CH.browserDevtools, () => browser?.toggleDevtools())
  ipcMain.on(CH.browserNewTab, (_e, url?: string) => browser?.newTab(url))
  ipcMain.on(CH.browserCloseTab, (_e, id: string) => browser?.closeTab(id))
  ipcMain.on(CH.browserSelectTab, (_e, id: string) => browser?.selectTab(id))
  ipcMain.on(CH.browserFind, (_e, t: string, fwd?: boolean, next?: boolean) =>
    browser?.find(t, fwd ?? true, next ?? false)
  )
  ipcMain.on(CH.browserStopFind, () => browser?.stopFind())
  ipcMain.on(CH.browserZoom, (_e, level: number) => browser?.setZoom(level))

  ipcMain.on(CH.browserBookmark, () => {
    const url = browser?.currentState().url
    if (!url || url === 'about:blank') return
    const s = getSettings()
    const list = s.browser.bookmarks.includes(url)
      ? s.browser.bookmarks.filter((b) => b !== url)
      : [...s.browser.bookmarks, url]
    const next = setSettings({ browser: { ...s.browser, bookmarks: list } })
    browser?.setBookmarks(list)
    send(CH.settingsChanged, next)
  })

  /* ---------------------------------------------------------------- remote */

  const remoteState = async (): Promise<unknown> => {
    const cfg = remoteConfig()
    const url = connectUrl(cfg)
    let qr: string | null = null
    try {
      qr = await QRCode.toDataURL(url, { margin: 1, width: 320, color: { dark: '#14110f', light: '#f2e9e1' } })
    } catch {
      qr = null
    }
    return {
      server: remote?.status() ?? {
        running: false,
        port: cfg.port,
        error: null,
        clients: 0,
        addresses: []
      },
      tunnel: tunnel.status(),
      url,
      qr,
      setup: tunnel.setupCommands(cfg.tunnelName, cfg.hostname, cfg.port)
    }
  }

  ipcMain.handle(CH.remoteStatus, () => remoteState())

  ipcMain.handle(CH.remoteStart, async () => {
    const cfg = remoteConfig()
    if (!remote) {
      remote = new RemoteServer(remoteDeps())
    }
    await remote.start(cfg)
    if (cfg.autoStartTunnel && cfg.hostname) {
      tunnel.start('named', { port: cfg.port, tunnelName: cfg.tunnelName, hostname: cfg.hostname })
    }
    setSettings({ remote: { ...cfg, enabled: true } })
    return remoteState()
  })

  ipcMain.handle(CH.remoteStop, async () => {
    await remote?.stop()
    tunnel.stop()
    const s = getSettings()
    setSettings({ remote: { ...s.remote, enabled: false } })
    return remoteState()
  })

  ipcMain.handle(CH.remoteNewToken, async () => {
    const s = getSettings()
    const next = setSettings({ remote: { ...s.remote, token: generateToken() } })
    // Existing phones must re-open the link; restart so the old key stops working.
    if (remote?.status().running) await remote.start(next.remote)
    send(CH.settingsChanged, next)
    return remoteState()
  })

  ipcMain.handle(CH.tunnelStart, (_e, mode: 'named' | 'quick') => {
    const cfg = remoteConfig()
    tunnel.start(mode, { port: cfg.port, tunnelName: cfg.tunnelName, hostname: cfg.hostname })
    return remoteState()
  })

  ipcMain.handle(CH.tunnelStop, () => {
    tunnel.stop()
    return remoteState()
  })

  /* ---------------------------------------------------------- self update */
  ipcMain.handle(CH.selfState, () => selfUpdateState())
  ipcMain.handle(CH.selfCheck, () => checkSelfUpdate())
  ipcMain.handle(CH.selfDownload, () => downloadSelfUpdate())
  ipcMain.handle(CH.selfInstall, () => {
    installSelfUpdate()
    return true
  })

  /* --------------------------------------------------------------- updates */
  ipcMain.handle(CH.updateCheck, () => checkForUpdate(getSettings().claudePath))
  ipcMain.handle(CH.updateRun, () => runUpdate(getSettings().claudePath))
  ipcMain.handle(CH.updateDoctor, () => runDoctor(getSettings().claudePath))

  /* -------------------------------------------------------------- settings */
  ipcMain.handle(CH.settingsGet, () => getSettings())
  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => {
    const next = setSettings(patch)
    /*
     * The Windows overlay is painted by the OS, not the page, so a theme change
     * leaves the buttons on the old colour until it is told. Profiles repaint
     * the accent only, which the overlay does not use, so the theme is the
     * trigger that matters.
     */
    if (isWindows && win && !win.isDestroyed()) {
      const theme = resolveTheme(next.themeId, next.customThemes)
      win.setTitleBarOverlay({
        color: theme.colors.bgSunken,
        symbolColor: theme.colors.textMuted,
        height: TITLEBAR_H
      })
    }
    send(CH.settingsChanged, next)
    return next
  })

  /* -------------------------------------------------------------- profiles */
  /*
   * Creating a profile writes a folder and a scan root, so it happens here and
   * the renderer only ever sees the plan and the resulting settings. `plan` is
   * a dry run: the UI shows what will happen before anything is written.
   */
  ipcMain.handle(CH.profilesPlan, (_e, folder: string, name: string) => planProfile(folder, name))
  ipcMain.handle(CH.profilesCreate, async (_e, input: CreateProfileInput) => {
    const { patch } = await createProfile(getSettings(), input)
    const next = setSettings(patch)
    send(CH.settingsChanged, next)
    // The new root only becomes visible once its children have been scanned.
    send(CH.sessionsChanged)
    return next
  })

  /* ------------------------------------------------------------------- ssh */
  ipcMain.handle(CH.sshHosts, () => readSshConfigHosts())

  /* --------------------------------------------------------------- worklog */
  /*
   * Both runs cost money and can fail, so every handler returns a result object
   * rather than throwing across the bridge - a rejected invoke in the renderer
   * arrives as an opaque Error string and the panel could not tell "nothing to
   * propose" from "the run broke".
   */
  const queue = worklogQueue

  ipcMain.handle(CH.worklogQueue, () => queue().list())

  ipcMain.handle(CH.worklogScan, async (_e, sessionId: string) => {
    try {
      return { added: await runWorklogScan(sessionId, false), error: null }
    } catch (err) {
      return { added: 0, error: err instanceof Error ? err.message : String(err) }
    }
  })

  /*
   * Accepts in flight, by proposal id.
   *
   * The renderer disables its buttons while one runs, but there are now two
   * independent controls that can accept the same proposal — the panel and the
   * auto-scan prompt — and a renderer flag is not a lock anyway. Two invokes
   * arriving together would each read a proposal with no urls yet and each run
   * the write, creating the record twice in a live workspace. Nothing else in
   * this file can undo that, so the guard belongs here.
   */
  const accepting = new Set<string>()

  ipcMain.handle(CH.worklogAccept, async (_e, id: string) => {
    const q = queue()
    const item = q.list().find((p) => p.id === id)
    if (!item) return { ok: false, error: 'that proposal is no longer in the queue' }
    if (item.status === 'accepted') return { ok: true, error: null }
    if (item.status === 'rejected') return { ok: false, error: 'that proposal was rejected' }
    if (accepting.has(id)) return { ok: false, error: 'that proposal is already being written' }
    accepting.add(id)
    try {
      const outcome = await applyProposal(item, {
        // Persist each URL the moment its write returns, so a failure on the
        // second destination cannot lose the first - and so a retry can tell
        // what has already been written and skip it.
        onWritten: async (target, url) => {
          if (!url) return
          const current = q.list().find((p) => p.id === id)
          q.update(id, { urls: { ...(current?.urls ?? {}), [target]: url } })
          send(CH.worklogChanged, q.list())
        }
      })
      const errors = Object.values(outcome.errors)
      q.update(id, {
        status: outcome.ok ? 'accepted' : 'failed',
        urls: { ...(q.list().find((p) => p.id === id)?.urls ?? {}), ...outcome.urls },
        error: errors.join('; ')
      })
      /*
       * The boards have moved, so the cached reading of them is stale.
       *
       * This matters more than it looks: the record just written is the one the
       * next scan most needs to know about. Left cached, that record stays
       * invisible for the rest of the TTL and the next scan of the same session
       * proposes creating it all over again - which is the exact duplication
       * recall was added to prevent.
       */
      if (Object.keys(outcome.urls).length) invalidateRecall()
      send(CH.worklogChanged, q.list())
      return { ok: outcome.ok, error: errors.join('; ') || null }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      q.update(id, { status: 'failed', error: message })
      send(CH.worklogChanged, q.list())
      return { ok: false, error: message }
    } finally {
      accepting.delete(id)
    }
  })

  ipcMain.handle(CH.worklogReject, (_e, id: string) => {
    queue().reject(id)
    send(CH.worklogChanged, queue().list())
  })

  /* ----------------------------------------------------------------- audio */
  ipcMain.handle(CH.micCheck, () => checkMicrophone())

  /* ------------------------------------------------------------- clipboard */
  /*
   * Read synchronously. xterm's key handler must decide whether to swallow a
   * paste before it returns, so an async round trip would always land a
   * keystroke too late. Reading the clipboard is microseconds, so blocking the
   * renderer for it is cheaper than the alternative of caching and going stale.
   *
   * hasImage is what lets plain Ctrl+V fall through to Claude Code's own image
   * handler: the CLI reads the image off the OS clipboard itself, so no image
   * bytes ever have to cross the PTY.
   */
  ipcMain.on(CH.clipboardRead, (e) => {
    e.returnValue = {
      text: clipboard.readText(),
      hasImage: !clipboard.readImage().isEmpty()
    }
  })
  ipcMain.on(CH.clipboardWrite, (_e, text: string) => {
    if (typeof text === 'string' && text) clipboard.writeText(text)
  })

  /* ------------------------------------------------------------------ misc */
  ipcMain.on(CH.openExternal, (_e, url: string) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  ipcMain.handle(CH.pickFolder, async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return res.canceled ? null : (res.filePaths[0] ?? null)
  })
}

/*
 * An unpackaged run gets its own data directory.
 *
 * The single-instance lock and the settings file are both keyed on userData, so
 * a dev build previously fought the installed app for both: launching one while
 * the other ran made the new process quit on the spot, and any dev run that did
 * start wrote through the same settings.json. The workaround was to remember a
 * --user-data-dir flag on every launch, which electron-vite gives no way to pass
 * anyway.
 *
 * Must happen before requestSingleInstanceLock, which reads the path.
 * STOKE_USER_DATA overrides, for running two dev copies side by side.
 *
 * An explicit --user-data-dir always wins. Without that guard this silently
 * ignored the flag and booted a different profile than the one asked for, which
 * is a confusing way to lose an afternoon: the app starts, looks fine, and none
 * of the settings under test are loaded.
 */
if (!app.isPackaged && !app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', process.env.STOKE_USER_DATA || `${app.getPath('userData')} (dev)`)
}

// A second launch should focus the existing window rather than open a rival one
// that fights over the same PTYs and settings file.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(() => {
    // The only sweep for statusLine files that a crash, a SIGKILL or a failed
    // launch left behind on a previous run — see statusLine.ts for why it is
    // age-based rather than a blanket wipe. Once per boot, before any session
    // (and so before any fresh file this run could mistake for stale) exists.
    sweepStaleSessionFiles()
    registerIpc()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (!isMac) app.quit()
  })

  app.on('before-quit', () => {
    ptys?.killAll()
    watcher?.disposeAll()
    mcp?.stop()
    void remote?.stop()
    tunnel.stop()
  })
}
