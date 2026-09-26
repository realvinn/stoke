import { randomUUID } from 'node:crypto'
import { BrowserWindow, session, shell, WebContentsView } from 'electron'
import type { WebContents } from 'electron'
import type { BrowserState, BrowserTabState, Rect } from '@shared/types'
// Relative and with the extension, so this module still runs under
// `node --experimental-strip-types` (no path aliases there).
import { normalizeUrl } from '../shared/url.ts'
import { DEFAULT_BROWSER_PROFILE_ID, partitionFor } from '../shared/browserProfiles.ts'
import type { BrowserProfile } from '../shared/browserProfiles.ts'

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

/*
 * Each browser profile is a dedicated persistent partition (`partitionFor`).
 * Logins survive restarts, and browsing stays separate from the app's own
 * session. Shared with the agent by design: this is what lets Claude read
 * dashboards and internal tools you are already signed into, which a cold
 * headless browser cannot do — and the agent acts in the ACTIVE profile only.
 * The Default profile keeps the partition the single browser always had.
 */

/**
 * The only permissions a browsed page may have, out of the twenty-odd Electron
 * routes through the two handlers.
 *
 * Both are pure viewport affordances: they reach nothing on the machine, they
 * need a user gesture, and the user can always press Escape. Denying them would
 * make the docked browser visibly worse than a browser — no full-screen video,
 * no canvas or map that captures the pointer — for no gain, and a security
 * measure that degrades daily use is one that gets turned off.
 *
 * Everything else is refused: `media` (microphone and camera), `geolocation`,
 * `clipboard-read`, `notifications`, `display-capture`, `midi`, `serial`,
 * `hid`, `usb`, `idle-detection`, `openExternal` and the rest. None of them has
 * a use in a pane that exists to read documentation and dashboards, and each is
 * a way for a page — or for whatever talked the agent into opening one — to
 * reach past it.
 */
const HARMLESS_PERMISSIONS = new Set(['fullscreen', 'pointerLock'])

/**
 * Size a page gets whenever it is not showing in the panel. It must be a real
 * rect: Chromium only lays a document out if its view has a non-zero viewport,
 * and the agent reads layout-dependent things (visibility, geometry, innerText).
 */
const DEFAULT_VIEWPORT = { x: 0, y: 0, width: 1280, height: 900 }

interface Tab {
  id: string
  /** The browser profile, and so the partition, this tab lives in. */
  profileId: string
  view: WebContentsView
  consoleLog: ConsoleEntry[]
  netLog: NetEntry[]
  findTotal: number
  findActive: number
  /**
   * The URL this tab has already been recovered from once after a renderer
   * crash. Null when it has not crashed, or has since navigated elsewhere.
   *
   * One retry per address, so a page that crashes reproducibly is not reloaded
   * in a loop — the second crash on the same URL is left alone and logged.
   */
  recoveredFrom: string | null
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
  /** Partitions whose session hooks are installed: once each, since a second webRequest listener replaces the first. */
  private hookedPartitions = new Set<string>()
  private currentProfile = DEFAULT_BROWSER_PROFILE_ID
  /** Each profile's last active tab, so switching back returns to it. */
  private lastActive = new Map<string, string>()
  /** Where a profile's first tab opens when it is switched to with none. */
  private homepage = ''

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

  /** The active profile's tabs, in strip order. */
  private shownTabs(): Tab[] {
    return this.tabs.filter((t) => t.profileId === this.currentProfile)
  }

  /** Create the first tab lazily so an unopened panel costs nothing. */
  private ensure(): Tab {
    const current = this.active()
    if (current) return current
    return this.newTab()
  }

  newTab(url?: string, profileId: string = this.currentProfile): Tab {
    const partition = partitionFor(profileId)
    const view = new WebContentsView({
      webPreferences: {
        // Nothing from Stoke is exposed to browsed pages.
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        partition
      }
    })

    const tab: Tab = {
      id: randomUUID(),
      profileId,
      view,
      consoleLog: [],
      netLog: [],
      recoveredFrom: null,
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

    /*
     * A crashed renderer, which nothing was listening for.
     *
     * Every other lifecycle event is wired above and this one was not, so a tab
     * whose renderer died stayed in the strip looking ordinary and was dead
     * forever: navigation did nothing, the MCP tools went on targeting it, and
     * `getTitle()`/`getURL()` kept returning the last values it had. Nothing
     * anywhere said the page had gone.
     *
     * Reloaded once rather than surfaced as a new UI state, because for the
     * overwhelmingly common causes — an out-of-memory kill on a heavy page, a
     * GPU process restart — a reload is exactly what the user would do and
     * exactly what Chrome itself offers. The guard is per URL: a page that
     * crashes again at the same address is left alone with a log line, so a
     * reproducible crasher cannot become a reload loop.
     *
     * `reason` distinguishes them: a `clean-exit` is the tab being closed
     * normally and must not be recovered from.
     */
    wc.on('render-process-gone', (_e, details) => {
      const url = wc.getURL()
      if (details.reason === 'clean-exit') return
      if (tab.recoveredFrom === url) {
        console.error(`[stoke] browser tab crashed again at ${url} (${details.reason}); not reloading`)
        push()
        return
      }
      console.error(`[stoke] browser tab renderer gone (${details.reason}) at ${url}; reloading once`)
      tab.recoveredFrom = url
      tab.consoleLog = []
      tab.netLog = []
      push()
      // Deferred a tick: reloading from inside the crash handler races
      // Chromium's own teardown of the dead renderer.
      setTimeout(() => {
        if (!this.tabs.includes(tab) || wc.isDestroyed()) return
        wc.reload()
      }, 0)
    })

    // A tab that navigates somewhere else has spent its one recovery.
    wc.on('did-navigate', () => {
      if (tab.recoveredFrom && tab.recoveredFrom !== wc.getURL()) tab.recoveredFrom = null
    })

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

    // A link that asks for a new window gets a real new tab, like a browser —
    // in the opener's profile, so it carries the same logins.
    wc.setWindowOpenHandler(({ url: target }) => {
      this.newTab(target, tab.profileId)
      return { action: 'deny' }
    })

    this.hookConsole(wc, tab)
    this.hookSession(partition)

    view.setBackgroundColor('#00000000')

    // Mount immediately but hidden. A view outside the window's tree gets a 0x0
    // viewport and never lays out, which silently hands the agent a blank page.
    this.win.contentView.addChildView(view)
    view.setBounds(DEFAULT_VIEWPORT)
    view.setVisible(false)

    // A popup from a background profile's page joins that profile quietly
    // rather than pulling the strip over to it.
    if (profileId === this.currentProfile) this.activeId = tab.id
    else this.lastActive.set(profileId, tab.id)
    this.applyVisibility()

    if (url) this.load(tab, url)
    this.emit(this.state())
    return tab
  }

  closeTab(id: string): void {
    const tab = this.tabs.find((t) => t.id === id)
    if (!tab) return
    // The next tab is picked among the closed one's own profile.
    const siblings = this.tabs.filter((t) => t.profileId === tab.profileId)
    const at = siblings.indexOf(tab)
    const next = siblings[at + 1] ?? siblings[at - 1] ?? null
    this.tabs.splice(this.tabs.indexOf(tab), 1)

    this.win.contentView.removeChildView(tab.view)
    tab.view.webContents.close()

    if (this.activeId === id) this.activeId = next?.id ?? null
    if (this.lastActive.get(tab.profileId) === id) {
      if (next) this.lastActive.set(tab.profileId, next.id)
      else this.lastActive.delete(tab.profileId)
    }
    this.applyVisibility()
    this.emit(this.state())
  }

  selectTab(id: string): void {
    // Only a tab in the strip, which is the active profile's.
    if (!this.shownTabs().some((t) => t.id === id)) return
    this.activeId = id
    this.applyVisibility()
    this.emit(this.state())
  }

  /* -------------------------------------------------------------- profiles */

  /**
   * Follow the profile list and the active profile from settings, which are
   * their only writer (gotcha 57). A profile that is gone takes its tabs with
   * it; its stored data is only cleared by `clearProfileData`, deliberately
   * and separately.
   */
  setProfiles(profiles: BrowserProfile[], active: string, homepage: string): void {
    this.homepage = homepage
    const known = new Set(profiles.map((p) => p.id))
    for (const tab of [...this.tabs]) if (!known.has(tab.profileId)) this.closeTab(tab.id)
    const target = known.has(active) ? active : DEFAULT_BROWSER_PROFILE_ID
    if (target !== this.currentProfile) this.switchProfile(target)
    else this.emit(this.state())
  }

  private switchProfile(id: string): void {
    if (this.activeId) this.lastActive.set(this.currentProfile, this.activeId)
    this.currentProfile = id
    const remembered = this.lastActive.get(id)
    const tabs = this.shownTabs()
    this.activeId = tabs.find((t) => t.id === remembered)?.id ?? tabs[0]?.id ?? null
    // Switched to while showing, with nothing to show: open its homepage.
    if (!this.activeId && this.userVisible) {
      this.newTab(this.homepage || 'about:blank', id)
      return
    }
    this.applyVisibility()
    this.emit(this.state())
  }

  /** Close a profile's tabs and wipe everything its partition stored. */
  async clearProfileData(id: string): Promise<void> {
    for (const tab of this.tabs.filter((t) => t.profileId === id)) this.closeTab(tab.id)
    this.lastActive.delete(id)
    const ses = session.fromPartition(partitionFor(id))
    await ses.clearStorageData()
    await ses.clearCache()
  }

  /** The active profile, for the agent's tools and the panel's chip. */
  currentProfileId(): string {
    return this.currentProfile
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
  /**
   * Deny every device permission in the docked browser's partition.
   *
   * Without a handler this session is not *denied*, it is UNGATED: Electron's
   * default approves, so every page loaded here could take the microphone, the
   * camera, geolocation and clipboard-read for the asking — while the app's own
   * window next door (index.ts, `setPermissionRequestHandler`) allows `media`
   * only, and only to its own renderer. The browsed page was the less trusted
   * of the two and had the larger grant.
   *
   * The check handler matters as much as the request handler: a synchronous
   * `permissions.query()` and several getters consult it without ever raising a
   * request, so a request-only handler still reports "granted".
   */
  private hookSession(partition: string): void {
    if (this.hookedPartitions.has(partition)) return
    this.hookedPartitions.add(partition)
    const ses = session.fromPartition(partition)
    this.hookPermissions(ses)
    this.hookNetwork(ses, partition)
  }

  private hookPermissions(ses: Electron.Session): void {
    const allow = (permission: string): boolean => HARMLESS_PERMISSIONS.has(permission)
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(allow(permission)))
    ses.setPermissionCheckHandler((_wc, permission) => allow(permission))
  }

  private hookNetwork(ses: Electron.Session, partition: string): void {
    const wr = ses.webRequest

    // A request with no webContents falls back to the active tab only when
    // that tab is in this session — never to another profile's log.
    const route = (id: number | undefined): NetEntry[] | null => {
      if (id === undefined) {
        const active = this.active()
        return active && partitionFor(active.profileId) === partition ? active.netLog : null
      }
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
    return this.shownTabs().map((t) => ({
      id: t.id,
      title: t.view.webContents.getTitle() || 'New tab',
      url: t.view.webContents.getURL(),
      loading: t.view.webContents.isLoading(),
      profileId: t.profileId
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
    /*
     * Seed `about:blank` only in the call that CREATED the tab. It used to seed
     * whenever `getURL()` was empty — but that is the last COMMITTED URL, and it
     * stays empty for the whole of a fresh tab's first load. Opening a terminal
     * link sends `show(url)` and then, from BrowserPanel's open effect, a bare
     * `show()`; on the first link of a run the second one found the link still
     * loading, read an empty URL, and navigated to about:blank over it, so the
     * panel opened on a blank page. Reproduced every time over the real IPC pair
     * (the link alone loaded); every later link worked because the tab by then
     * had a page, which is why it read as "sometimes". Gotcha 106.
     */
    const created = !this.active()
    this.ensure()
    this.userVisible = true
    this.applyVisibility()
    if (url) this.navigate(url)
    else if (created) this.navigate('about:blank')
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

  /**
   * The address bar, and only the address bar. `allowLocalFiles` is granted
   * here because the actor is a person who typed the path; the MCP `open` tool
   * calls `normalizeUrl` without it.
   */
  navigate(input: string): void {
    this.load(this.ensure(), input)
  }

  private load(tab: Tab, input: string): void {
    void tab.view.webContents
      .loadURL(normalizeUrl(input, { allowLocalFiles: true }))
      .catch(() => {
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
    /*
     * `win.on('closed')` calls this to close every tab's real WebContents
     * rather than merely dropping the reference (each open tab is a whole
     * Chromium renderer, still holding the shared `persist:stoke-browser`
     * session) — but `'closed'` fires AFTER `win` itself is destroyed, and
     * `closeTab`'s `this.win.contentView.removeChildView` throws on a
     * destroyed window. Uncaught, that throw surfaces as Electron's own
     * uncaught-exception `NSAlert`, which blocks `app.quit()` on `runModal`
     * until dismissed by hand — measured: `sample` during a hung quit with
     * the docked browser open showed `_finishClosingWindow` -> this callback
     * -> `-[NSAlert runModal]`, and a control run with no browser tab open
     * quit on one `SIGTERM`. `closeTab`'s OTHER work (dropping the tab,
     * closing its `webContents`) is still exactly what a destroyed window
     * needs, so this only skips the one call that assumes `win` is alive.
     */
    if (this.win.isDestroyed()) {
      for (const tab of this.tabs.splice(0)) tab.view.webContents.close()
      return
    }
    for (const tab of [...this.tabs]) this.closeTab(tab.id)
  }
}

