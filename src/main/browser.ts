import { randomUUID } from 'node:crypto'
import { BrowserWindow, session, shell, WebContentsView } from 'electron'
import type { WebContents } from 'electron'
import type { BrowserState, BrowserTabState, Rect } from '@shared/types'

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
  fromCache?: boolean
  /**
   * Response headers, kept only for documents. Every passive security check
   * worth running reads them — CSP, HSTS, framing, cross-origin isolation —
   * and holding them for three hundred subresources as well would cost far
   * more memory than it could ever answer.
   */
  headers?: Record<string, string[]>
}

/** Ring buffer size per tab for each log. Enough for a page load, cheap to keep. */
const LOG_LIMIT = 300

/**
 * A dedicated persistent partition. Logins survive restarts, and browsing stays
 * separate from the app's own session. Shared with the agent by design: this is
 * what lets Claude read dashboards and internal tools you are already signed
 * into, which a cold headless browser cannot do.
 */
const PARTITION = 'persist:stoke-browser'

/**
 * Size a page gets whenever it is not showing in the panel. It must be a real
 * rect: Chromium only lays a document out if its view has a non-zero viewport,
 * and the agent reads layout-dependent things (visibility, geometry, innerText).
 */
const DEFAULT_VIEWPORT = { x: 0, y: 0, width: 1280, height: 900 }

interface Tab {
  id: string
  view: WebContentsView
  consoleLog: ConsoleEntry[]
  netLog: NetEntry[]
  findTotal: number
  findActive: number
}

/**
 * The docked browser: a set of real Chromium views inside the window.
 *
 * Native child views rather than <webview> tags — <webview> is deprecated and
 * janky, whereas WebContentsView gets a full renderer with working devtools.
 */
export class EmbeddedBrowser {
  private tabs: Tab[] = []
  private activeId: string | null = null
  /** True only while the panel is open in the UI. */
  private userVisible = false
  private bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
  private netHooked = false

  private readonly win: BrowserWindow
  private readonly emit: (state: BrowserState) => void
  private readonly onFindRequested: () => void
  /** Bookmarks live in settings; this reads them for the `bookmarked` flag. */
  private bookmarks: string[] = []

  constructor(
    win: BrowserWindow,
    emit: (state: BrowserState) => void,
    onFindRequested: () => void = () => {}
  ) {
    this.win = win
    this.emit = emit
    this.onFindRequested = onFindRequested
  }

  /* ------------------------------------------------------------------ tabs */

  private active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null
  }

  /** Create the first tab lazily so an unopened panel costs nothing. */
  private ensure(): Tab {
    const current = this.active()
    if (current) return current
    return this.newTab()
  }

  newTab(url?: string): Tab {
    const view = new WebContentsView({
      webPreferences: {
        // Nothing from Stoke is exposed to browsed pages.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition: PARTITION
      }
    })

    const tab: Tab = {
      id: randomUUID(),
      view,
      consoleLog: [],
      netLog: [],
      findTotal: 0,
      findActive: 0
    }
    this.tabs.push(tab)

    const wc = view.webContents
    const push = (): void => this.emit(this.state())

    /*
     * Discard the logs per navigation, not per loading spinner.
     *
     * did-navigate was the first attempt and fires after the main document
     * response, wiping the very request the agent asks about when a page fails
     * to load. did-start-loading was the second, and it is wrong in a subtler
     * and more damaging way: it fires again every time a client-side router
     * starts fetching, so on any framework that prefetches — which is to say
     * most of them — the whole log is cleared moments after the page finished
     * loading. Measured on tailwindcss.com: the second did-start-loading
     * arrives with 53 completed requests already recorded and takes all of
     * them, which is why the security audit found no headers to read.
     *
     * A real main-frame, cross-document navigation is the only event that
     * should discard anything, and it fires before the document request goes
     * out rather than after it comes back.
     */
    wc.on('did-start-navigation', (...args: unknown[]) => {
      const details = (args[0] ?? {}) as { isMainFrame?: boolean; isSameDocument?: boolean }
      const isMainFrame =
        typeof details.isMainFrame === 'boolean' ? details.isMainFrame : args[3] === true
      const isSameDocument =
        typeof details.isSameDocument === 'boolean' ? details.isSameDocument : args[2] === true
      if (!isMainFrame || isSameDocument) return
      tab.consoleLog = []
      tab.netLog = []
      push()
    })
    wc.on('did-start-loading', push)
    wc.on('did-stop-loading', push)
    wc.on('did-navigate', push)
    wc.on('did-navigate-in-page', push)
    wc.on('page-title-updated', push)
    wc.on('did-fail-load', push)

    wc.on('found-in-page', (_e, result) => {
      tab.findTotal = result.matches ?? 0
      tab.findActive = result.activeMatchOrdinal ?? 0
      push()
    })

    /*
     * Find-on-page has to be caught here rather than in the renderer. The page
     * view is a separate WebContents that owns keyboard focus whenever you are
     * looking at a site, so a keydown listener in the app's DOM never sees
     * Ctrl/Cmd+F at all.
     */
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || typeof input.key !== 'string') return
      const primary = process.platform === 'darwin' ? input.meta : input.control
      if (primary && !input.alt && input.key.toLowerCase() === 'f') {
        event.preventDefault()
        this.onFindRequested()
        return
      }
      // Escape closes an active find, but is left alone otherwise so pages can
      // still use it to dismiss their own dialogs.
      if (input.key === 'Escape' && tab.findTotal > 0) {
        event.preventDefault()
        this.stopFind()
      }
    })

    // A link that asks for a new window gets a real new tab, like a browser.
    wc.setWindowOpenHandler(({ url: target }) => {
      this.newTab(target)
      return { action: 'deny' }
    })

    this.hookConsole(wc, tab)
    this.hookNetwork()

    view.setBackgroundColor('#00000000')

    // Mount immediately but hidden. A view outside the window's tree gets a 0x0
    // viewport and never lays out, which silently hands the agent a blank page.
    this.win.contentView.addChildView(view)
    view.setBounds(DEFAULT_VIEWPORT)
    view.setVisible(false)

    this.activeId = tab.id
    this.applyVisibility()

    if (url) this.navigate(url)
    this.emit(this.state())
    return tab
  }

  closeTab(id: string): void {
    const index = this.tabs.findIndex((t) => t.id === id)
    if (index === -1) return
    const [tab] = this.tabs.splice(index, 1)

    this.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()

    if (this.activeId === id) {
      const next = this.tabs[index] ?? this.tabs[index - 1] ?? null
      this.activeId = next?.id ?? null
    }
    this.applyVisibility()
    this.emit(this.state())
  }

  selectTab(id: string): void {
    if (!this.tabs.some((t) => t.id === id)) return
    this.activeId = id
    this.applyVisibility()
    this.emit(this.state())
  }

  /** Only the active tab is ever visible; the rest keep a viewport but hide. */
  private applyVisibility(): void {
    for (const tab of this.tabs) {
      const isActive = tab.id === this.activeId
      const shown = isActive && this.userVisible
      /*
       * Bounds first, then visibility, and the order is the whole bug.
       *
       * This called `setVisible(false)` before `setBounds(DEFAULT_VIEWPORT)`,
       * and Electron does not propagate a resize to a view that is already
       * hidden — so the size never took. The effect was that once the panel had
       * been opened and closed even once, every page kept the panel's own
       * narrow viewport for the rest of the run: 459x789 rather than the
       * 1280x900 the constant promises. Every `browser_read`, `browser_snapshot`
       * and `browser_design` then saw the site's *mobile* layout, reported the
       * desktop navigation as not existing, and could not click it.
       *
       * It hides from a main-process check, too: `view.getBounds()` goes on
       * reporting 1280x900 while the page inside measures 459 — only
       * `innerWidth` evaluated in the page finds it. Verified by an isolated
       * Electron probe running both orderings: hide-then-setBounds gives
       * 460x800, setBounds-then-hide gives 1280x900.
       */
      tab.view.setBounds(
        shown && this.bounds.width > 0
          ? {
              x: Math.round(this.bounds.x),
              y: Math.round(this.bounds.y),
              width: Math.max(1, Math.round(this.bounds.width)),
              height: Math.max(1, Math.round(this.bounds.height))
            }
          : DEFAULT_VIEWPORT
      )
      tab.view.setVisible(shown)
    }
  }

  /* ------------------------------------------------------------- capture */

  /**
   * Electron changed this event from positional arguments to a details object.
   * Both shapes are handled so capture keeps working across versions.
   */
  private hookConsole(wc: WebContents, tab: Tab): void {
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

      this.push(tab.consoleLog, { level, message, source, at: Date.now() })
    })
  }

  /**
   * The webRequest API rather than CDP's Network domain, because this listens
   * for the life of the session with no attach, no reload and no observer
   * effect — a page's very first request is captured, which a debugger session
   * opened on demand would already have missed.
   *
   * The original reason given here was that only one debugger client may attach
   * at a time and the slot had to stay free for DevTools. That turned out to be
   * false: Chromium allows several protocol clients per target, and mcp/cdp.ts
   * now attaches freely alongside DevTools. This hook stays because it is the
   * better tool for the job, not because CDP is unavailable.
   *
   * Entries are routed back to their tab via webContentsId.
   */
  private hookNetwork(): void {
    if (this.netHooked) return
    this.netHooked = true
    const wr = session.fromPartition(PARTITION).webRequest

    const route = (id: number | undefined): NetEntry[] | null => {
      if (id === undefined) return this.active()?.netLog ?? null
      const tab = this.tabs.find((t) => t.view.webContents.id === id)
      return tab ? tab.netLog : null
    }

    wr.onCompleted((d) => {
      const log = route(d.webContentsId)
      if (!log) return
      const isDocument = d.resourceType === 'mainFrame' || d.resourceType === 'subFrame'
      this.push(log, {
        url: d.url,
        method: d.method,
        status: d.statusCode ?? null,
        type: d.resourceType ?? 'other',
        at: Date.now(),
        fromCache: d.fromCache,
        headers: isDocument ? d.responseHeaders : undefined
      })
    })

    wr.onErrorOccurred((d) => {
      const log = route(d.webContentsId)
      if (!log) return
      this.push(log, {
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

  /* --------------------------------------------------------- agent access */

  webContents(): WebContents | null {
    return this.active()?.view.webContents ?? null
  }

  /** Guarantees a live page for the agent even if the panel was never opened. */
  ensureHeadless(): WebContents {
    return this.ensure().view.webContents
  }

  consoleEntries(): ConsoleEntry[] {
    return this.active()?.consoleLog ?? []
  }

  networkEntries(): NetEntry[] {
    return this.active()?.netLog ?? []
  }

  isAttached(): boolean {
    return this.userVisible
  }

  /* ----------------------------------------------------------------- state */

  setBookmarks(list: string[]): void {
    this.bookmarks = list
    this.emit(this.state())
  }

  private tabState(): BrowserTabState[] {
    return this.tabs.map((t) => ({
      id: t.id,
      title: t.view.webContents.getTitle() || 'New tab',
      url: t.view.webContents.getURL(),
      loading: t.view.webContents.isLoading()
    }))
  }

  private state(): BrowserState {
    const tab = this.active()
    const wc = tab?.view.webContents
    if (!wc) {
      return {
        url: '',
        title: '',
        canGoBack: false,
        canGoForward: false,
        loading: false,
        tabs: [],
        activeId: null,
        zoom: 0,
        findTotal: 0,
        findActive: 0,
        bookmarked: false
      }
    }
    const url = wc.getURL()
    return {
      url,
      title: wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      loading: wc.isLoading(),
      tabs: this.tabState(),
      activeId: this.activeId,
      zoom: wc.getZoomLevel(),
      findTotal: tab.findTotal,
      findActive: tab.findActive,
      bookmarked: this.bookmarks.includes(url)
    }
  }

  currentState(): BrowserState {
    return this.state()
  }

  /* ------------------------------------------------------------- controls */

  setBounds(rect: Rect): void {
    this.bounds = rect
    this.applyVisibility()
  }

  show(url?: string): void {
    const tab = this.ensure()
    this.userVisible = true
    this.applyVisibility()
    if (url) this.navigate(url)
    else if (!tab.view.webContents.getURL()) this.navigate('about:blank')
    this.emit(this.state())
  }

  /**
   * Hide from the user without unmounting, so pages keep their state — and keep
   * a real viewport, which the agent depends on.
   */
  hide(): void {
    this.userVisible = false
    this.applyVisibility()
  }

  navigate(input: string): void {
    const tab = this.ensure()
    void tab.view.webContents.loadURL(normalizeUrl(input)).catch(() => {
      /* bad address; did-fail-load already reported it */
    })
  }

  back(): void {
    const wc = this.webContents()
    if (wc?.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  }

  forward(): void {
    const wc = this.webContents()
    if (wc?.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
  }

  reload(): void {
    this.webContents()?.reload()
  }

  stop(): void {
    this.webContents()?.stop()
  }

  find(text: string, forward = true, findNext = false): void {
    const wc = this.webContents()
    if (!wc) return
    if (!text) {
      this.stopFind()
      return
    }
    wc.findInPage(text, { forward, findNext })
  }

  stopFind(): void {
    this.webContents()?.stopFindInPage('clearSelection')
    const tab = this.active()
    if (tab) {
      tab.findTotal = 0
      tab.findActive = 0
    }
    this.emit(this.state())
  }

  /** Chromium zoom levels are logarithmic; +-0.5 is roughly a 10% step. */
  setZoom(level: number): void {
    const wc = this.webContents()
    if (!wc) return
    wc.setZoomLevel(Math.max(-5, Math.min(5, level)))
    this.emit(this.state())
  }

  toggleDevtools(): void {
    const wc = this.webContents()
    if (!wc) return
    if (wc.isDevToolsOpened()) wc.closeDevTools()
    else wc.openDevTools({ mode: 'detach' })
  }

  openExternal(): void {
    const url = this.webContents()?.getURL()
    if (url && /^https?:/i.test(url)) void shell.openExternal(url)
  }

  destroy(): void {
    for (const tab of [...this.tabs]) this.closeTab(tab.id)
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
