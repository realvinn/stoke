import { BrowserWindow, shell, WebContentsView } from 'electron'
import type { BrowserState, Rect } from '@shared/types'

/**
 * A real Chromium view docked inside the window, so Claude's links and docs open
 * in the app instead of pulling you out to another program.
 *
 * It is a native child view rather than a <webview> tag: <webview> is deprecated
 * and janky, whereas WebContentsView gets a full renderer with proper devtools.
 */
export class EmbeddedBrowser {
  private view: WebContentsView | null = null
  private attached = false
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }

  private readonly win: BrowserWindow
  private readonly emit: (state: BrowserState) => void

  constructor(win: BrowserWindow, emit: (state: BrowserState) => void) {
    this.win = win
    this.emit = emit
  }

  private ensure(): WebContentsView {
    if (this.view) return this.view

    const view = new WebContentsView({
      webPreferences: {
        // Nothing from Hearth is exposed to browsed pages.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
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

    // Popups become navigations in the same view; anything explicitly external
    // goes to the system browser.
    wc.setWindowOpenHandler(({ url }) => {
      void wc.loadURL(url)
      return { action: 'deny' }
    })

    view.setBackgroundColor('#00000000')
    return view
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
    if (this.attached && this.view) {
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
    if (!this.attached) {
      this.win.contentView.addChildView(view)
      this.attached = true
      this.setBounds(this.bounds)
    }
    if (url) this.navigate(url)
    else if (!view.webContents.getURL()) this.navigate('about:blank')
    this.emit(this.state())
  }

  hide(): void {
    if (this.view && this.attached) {
      // Detach rather than destroy: the page keeps its state and history while
      // the panel is closed.
      this.win.contentView.removeChildView(this.view)
      this.attached = false
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
