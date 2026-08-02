import { BrowserWindow, session, shell, WebContentsView } from 'electron'
import type { WebContents } from 'electron'
import type { BrowserState, Rect } from '@shared/types'

/** Recent console output, exposed to the agent through the MCP tools. */
export interface ConsoleEntry {
  level: string
  message: string
  source: string
  at: number
}

/** Recent network activity, kept mainly so failures can be asked about. */
export interface NetEntry {
  url: string
  method: string
  status: number | null
  type: string
  error?: string
  at: number
}

/** Ring buffer size for each log. Enough for a page load, cheap to keep. */
const LOG_LIMIT = 300

/**
 * A dedicated persistent partition. Logins survive restarts, and browsing stays
 * separate from the app's own session. Shared with the agent by design: this is
 * what lets Claude read dashboards and internal tools you are already signed
 * into, which a cold headless browser cannot do.
 */
const PARTITION = 'persist:stoke-browser'

/**
 * Size the page gets whenever it is not showing in the panel. It must be a real
 * rect: Chromium only lays a document out if its view has a non-zero viewport,
 * and the agent reads layout-dependent things (visibility, geometry, innerText).
 */
const DEFAULT_VIEWPORT = { x: 0, y: 0, width: 1280, height: 900 }

/**
 * A real Chromium view docked inside the window, so Claude's links and docs open
 * in the app instead of pulling you out to another program.
 *
 * It is a native child view rather than a <webview> tag: <webview> is deprecated
 * and janky, whereas WebContentsView gets a full renderer with proper devtools.
 */
export class EmbeddedBrowser {
  private view: WebContentsView | null = null
  /** True only while the panel is open in the UI. */
  private userVisible = false
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }

  private readonly win: BrowserWindow
  private readonly emit: (state: BrowserState) => void

  private consoleLog: ConsoleEntry[] = []
  private netLog: NetEntry[] = []
  private netHooked = false

  constructor(win: BrowserWindow, emit: (state: BrowserState) => void) {
    this.win = win
    this.emit = emit
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view

    const view = new WebContentsView({
      webPreferences: {
        // Nothing from Stoke is exposed to browsed pages.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: PARTITION
      }
    })
    this.view = view

    const wc = view.webContents
    const push = (): void => this.emit(this.state())

    wc.on('did-start-loading', push)
    wc.on('did-stop-loading', push)
    wc.on('did-navigate', push)
    wc.on('did-navigate-in-page', push)
    wc.on('page-title-updated', push)
    wc.on('did-fail-load', push)

    // Reset per page load. This must hook did-start-loading, not did-navigate:
    // did-navigate fires *after* the main document response, so resetting there
    // wiped the very request the agent asks about when a page fails to load.
    wc.on('did-start-loading', () => {
      this.consoleLog = []
      this.netLog = []
    })

    this.hookConsole(wc)
    this.hookNetwork()

    // Popups become navigations in the same view; anything explicitly external
    // goes to the system browser.
    wc.setWindowOpenHandler(({ url }) => {
      void wc.loadURL(url)
      return { action: 'deny' }
    })

    view.setBackgroundColor('#00000000')

    // Mount immediately but hidden. The view must live in the window's tree
    // with a real rect to lay out at all, which is what lets the agent read a
    // page before the user has ever opened the panel.
    this.win.contentView.addChildView(view)
    view.setBounds(DEFAULT_VIEWPORT)
    view.setVisible(false)

    return view
  }

  /**
   * Electron changed this event from positional arguments to a details object.
   * Both shapes are handled so the capture keeps working across versions.
   */
  private hookConsole(wc: WebContents): void {
    wc.on('console-message', (...args: unknown[]) => {
      const first = args[0] as Record<string, unknown> | undefined
      let level = 'log'
      let message = ''
      let source = ''

      if (first && typeof first === 'object' && 'message' in first) {
        level = String(first.level ?? 'log')
        message = String(first.message ?? '')
        source = String(first.sourceId ?? '')
      } else {
        level = String(args[1] ?? 'log')
        message = String(args[2] ?? '')
        source = String(args[4] ?? '')
      }

      this.push(this.consoleLog, { level, message, source, at: Date.now() })
    })
  }

  /**
   * The webRequest API is used rather than attaching a CDP debugger: only one
   * debugger client may be attached at a time, and that slot must stay free for
   * DevTools.
   */
  private hookNetwork(): void {
    if (this.netHooked) return
    this.netHooked = true
    const wr = session.fromPartition(PARTITION).webRequest

    wr.onCompleted((d) => {
      this.push(this.netLog, {
        url: d.url,
        method: d.method,
        status: d.statusCode ?? null,
        type: d.resourceType ?? 'other',
        at: Date.now()
      })
    })

    wr.onErrorOccurred((d) => {
      this.push(this.netLog, {
        url: d.url,
        method: d.method,
        status: null,
        type: d.resourceType ?? 'other',
        error: d.error,
        at: Date.now()
      })
    })
  }

  private push<T>(buf: T[], item: T): void {
    buf.push(item)
    if (buf.length > LOG_LIMIT) buf.splice(0, buf.length - LOG_LIMIT)
  }

  /** Live WebContents, or null when the panel has never been opened. */
  webContents(): WebContents | null {
    return this.view?.webContents ?? null
  }

  /**
   * Ensure the view exists without attaching it to the window, so the agent can
   * drive the browser before the user has opened the panel.
   */
  ensureHeadless(): WebContents {
    return this.ensure().webContents
  }

  consoleEntries(): ConsoleEntry[] {
    return this.consoleLog
  }

  networkEntries(): NetEntry[] {
    return this.netLog
  }

  clearLogs(): void {
    this.consoleLog = []
    this.netLog = []
  }

  isAttached(): boolean {
    return this.userVisible
  }

  private state(): BrowserState {
    const wc = this.view?.webContents
    if (!wc) {
      return { url: '', title: '', canGoBack: false, canGoForward: false, loading: false }
    }
    return {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading()
    }
  }

  setBounds(rect: Rect): void {
    this.bounds = rect
    if (this.userVisible && this.view) {
      this.view.setBounds({
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height))
      })
    }
  }

  show(url?: string): void {
    const view = this.ensure()
    this.userVisible = true
    view.setVisible(true)
    if (this.bounds.width > 0) this.setBounds(this.bounds)
    if (url) this.navigate(url)
    else if (!view.webContents.getURL()) this.navigate('about:blank')
    this.emit(this.state())
  }

  /**
   * Hide from the user without unmounting.
   *
   * The view deliberately stays in the window's view tree at a full-size
   * rect — a WebContentsView that is detached (or sized to nothing) gets a 0x0
   * viewport and never lays out, so `getBoundingClientRect`, `innerText` and
   * every visibility check return empty. That silently gave the agent a blank
   * page whenever the panel was closed.
   */
  hide(): void {
    this.userVisible = false
    if (this.view) {
      this.view.setVisible(false)
      this.view.setBounds(DEFAULT_VIEWPORT)
    }
  }

  navigate(input: string): void {
    const view = this.ensure()
    void view.webContents.loadURL(normalizeUrl(input)).catch(() => {
      /* bad address; did-fail-load already reported it */
    })
  }

  back(): void {
    const wc = this.view?.webContents
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  forward(): void {
    const wc = this.view?.webContents
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(): void {
    this.view?.webContents.reload()
  }

  stop(): void {
    this.view?.webContents.stop()
  }

  toggleDevtools(): void {
    const wc = this.view?.webContents
    if (!wc) return
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  }

  openExternal(): void {
    const url = this.view?.webContents.getURL()
    if (url && /^https?:/i.test(url)) void shell.openExternal(url)
  }

  currentState(): BrowserState {
    return this.state()
  }

  destroy(): void {
    this.hide()
    this.view?.webContents.close()
    this.view = null
  }
}

/** Accepts URLs, bare hostnames, localhost:port and free text (searched). */
export function normalizeUrl(input: string): string {
  const raw = input.trim()
  if (!raw) return 'about:blank'
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return raw
  if (/^localhost(:\d+)?(\/|$)/i.test(raw)) return `http://${raw}`
  if (/^\d{1,3}(\.\d{1,3}){3}(:\d+)?(\/|$)/.test(raw)) return `http://${raw}`
  if (/^[^\s/]+\.[^\s/]{2,}(\/|$|:\d)/.test(raw)) return `https://${raw}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`
}
