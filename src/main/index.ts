import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import { CH } from '@shared/ipc'
import { resolveTheme } from '@shared/themes'
import type { LaunchOptions, Rect, Settings } from '@shared/types'
import { EmbeddedBrowser } from './browser.ts'
import { probeClaude } from './cli.ts'
import { ContextWatcher } from './context.ts'
import { listProjects, listSessions } from './projects.ts'
import { PtyManager } from './pty.ts'
import { getSettings, setSettings } from './store.ts'
import { createScratchDir, resolveDefaultCwd } from './workspace.ts'
import { BrowserMcpServer } from './mcp/server.ts'

const isMac = process.platform === 'darwin'

let win: BrowserWindow | null = null
let browser: EmbeddedBrowser | null = null
let ptys: PtyManager | null = null
let watcher: ContextWatcher | null = null
let mcp: BrowserMcpServer | null = null
/** Path of the generated --mcp-config file; null until the server is up. */
let mcpConfigPath: string | null = null

function send(channel: string, ...args: unknown[]): void {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, ...args)
  }
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
    // macOS keeps its native frame so the traffic lights stay in the right
    // place; Windows and Linux get a fully custom title bar.
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : 'default',
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

  browser = new EmbeddedBrowser(win, (state) => send(CH.browserState, state))
  browser.setBookmarks(settings.browser.bookmarks)

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
  watcher = new ContextWatcher((snap) => send(CH.ctxUpdate, snap))

  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devUrl) {
    void win.loadURL(devUrl)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  win.on('closed', () => {
    ptys?.killAll()
    watcher?.disposeAll()
    mcp?.stop()
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
  ipcMain.handle(CH.ptyStart, async (_e, opts: LaunchOptions) => {
    if (!ptys) throw new Error('Window is not ready')
    const result = await ptys.start(opts, getSettings().claudePath, mcpConfigPath)
    watcher?.watch(result.sessionId)
    return result
  })

  ipcMain.on(CH.ptyWrite, (_e, ptyId: string, data: string) => ptys?.write(ptyId, data))
  ipcMain.on(CH.ptyResize, (_e, ptyId: string, cols: number, rows: number) =>
    ptys?.resize(ptyId, cols, rows)
  )
  ipcMain.on(CH.ptyKill, (_e, ptyId: string) => {
    const sessionId = ptys?.sessionIdFor(ptyId)
    ptys?.kill(ptyId)
    if (sessionId) watcher?.unwatch(sessionId)
  })

  /* --------------------------------------------------------------- context */
  ipcMain.on(CH.ctxWatch, (_e, sessionId: string) => watcher?.watch(sessionId))
  ipcMain.on(CH.ctxUnwatch, (_e, sessionId: string) => watcher?.unwatch(sessionId))

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

  /* -------------------------------------------------------------- settings */
  ipcMain.handle(CH.settingsGet, () => getSettings())
  ipcMain.handle(CH.settingsSet, (_e, patch: Partial<Settings>) => {
    const next = setSettings(patch)
    send(CH.settingsChanged, next)
    return next
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
  })
}
