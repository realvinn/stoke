/**
 * The native right-click menu: Stoke's own window (text fields, the chat viewer,
 * any selection) and every docked-browser page.
 *
 * Electron draws no context menu unless the app builds one, and nothing did: a
 * right-click on a field or a page did nothing at all. On Windows the window is
 * frameless with no menu bar, so a mouse-only user had no way to paste into a
 * field, and on every platform a docked page offered no way to copy a link's
 * address or an image.
 *
 * Native rather than drawn in the renderer because the docked browser is a
 * `WebContentsView` that paints over all DOM (gotcha 14): a DOM menu over a page
 * would be hidden behind it. A native menu is its own OS window, above both.
 *
 * Never over a terminal. Every terminal host `preventDefault`s its DOM
 * `contextmenu` in the capture phase and draws its own menu — TerminalView's
 * `onContextMenu`, QuickTerminal's `context`, and the hub remote tab through
 * `installTerminalClipboard`'s `context`, which cancels only when it is handed a
 * `menu` — and Chromium raises `context-menu` only for a contextmenu event
 * nobody cancelled, so this handler never sees a right-click there. The params
 * cannot tell a terminal apart (xterm's helper textarea reads as an editable
 * field), which is why the renderer's own `preventDefault` is the line, why
 * verify:browser-url pins all three, and why a new terminal surface must keep it.
 *
 * The edit items are not Electron roles. A role runs against whichever web
 * contents has FOCUS (off macOS `webContents.getFocusedWebContents()`, on macOS
 * the first responder), not the one that was right-clicked — so with the
 * terminal focused, Paste on a docked page's field could land in Claude's
 * prompt. Whether a right mouse-down moves OS focus between the window's own
 * view and a `WebContentsView` is unmeasured; calling the method on the
 * contents that raised the menu makes it not matter.
 *
 * The template is pure (`contextMenuTemplate`) and this module imports nothing
 * from electron at run time — `Menu` and `clipboard` arrive as arguments — so
 * `verify:browser-url` loads it under `node --experimental-strip-types`.
 */

/** The edit section's commands, each named for the `WebContents` method that runs it on the contents that raised the menu. */
export type EditCommand = 'undo' | 'redo' | 'cut' | 'copy' | 'paste' | 'pasteAndMatchStyle' | 'selectAll'

/** The other items; like the edit section, each runs against the web contents that raised the menu. */
export type MenuAction = 'openLinkInNewTab' | 'copyLink' | 'copyImage' | 'copyImageAddress' | 'inspect'

export type MenuEntry =
  | { type: 'edit'; command: EditCommand; label: string; enabled: boolean }
  | { type: 'action'; action: MenuAction; label: string }
  | { type: 'separator' }

/** What the template reads off Electron's `ContextMenuParams`, so a suite can hand it plain objects. */
export interface MenuParams {
  isEditable: boolean
  selectionText: string
  linkURL: string
  srcURL: string
  mediaType: string
  hasImageContents: boolean
  editFlags: {
    canUndo: boolean
    canRedo: boolean
    canCut: boolean
    canCopy: boolean
    canPaste: boolean
    canSelectAll: boolean
    canEditRichly: boolean
  }
}

export interface MenuContext {
  /** Unpackaged: offer Inspect Element. */
  dev: boolean
  /** The surface can open a link in a tab of its own (the docked browser). */
  canOpenTab: boolean
}

const EDIT_LABELS: Record<EditCommand, string> = {
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  pasteAndMatchStyle: 'Paste and Match Style',
  selectAll: 'Select All'
}

const LABELS: Record<MenuAction, string> = {
  openLinkInNewTab: 'Open Link in New Tab',
  copyLink: 'Copy Link Address',
  copyImage: 'Copy Image',
  copyImageAddress: 'Copy Image Address',
  inspect: 'Inspect Element'
}

/** Only a web address opens in a docked tab: a page's link is never a way to `file://` (verify:browser-url). */
export function openableLink(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

/**
 * The menu for one right-click, as groups joined by separators. Empty when
 * nothing applies (a click on blank chrome), and the caller then shows nothing,
 * which is what that click did before.
 */
export function contextMenuTemplate(p: MenuParams, ctx: MenuContext): MenuEntry[] {
  const groups: MenuEntry[][] = []
  const edit = (command: EditCommand, enabled: boolean): MenuEntry => ({ type: 'edit', command, label: EDIT_LABELS[command], enabled })
  const action = (a: MenuAction): MenuEntry => ({ type: 'action', action: a, label: LABELS[a] })
  const f = p.editFlags

  if (p.isEditable) {
    groups.push([edit('undo', f.canUndo), edit('redo', f.canRedo)])
    // Paste and Match Style only where there is a style to drop: a contenteditable.
    // In a plain input or textarea it is Paste again under another name.
    groups.push([
      edit('cut', f.canCut),
      edit('copy', f.canCopy),
      edit('paste', f.canPaste),
      ...(f.canEditRichly ? [edit('pasteAndMatchStyle', f.canPaste)] : []),
      edit('selectAll', f.canSelectAll)
    ])
  } else if (p.selectionText.trim()) {
    groups.push([edit('copy', true)])
  }

  if (p.linkURL) {
    groups.push([
      ...(ctx.canOpenTab && openableLink(p.linkURL) ? [action('openLinkInNewTab')] : []),
      action('copyLink')
    ])
  }

  if (p.mediaType === 'image') {
    const image = [
      ...(p.hasImageContents ? [action('copyImage')] : []),
      ...(p.srcURL ? [action('copyImageAddress')] : [])
    ]
    if (image.length) groups.push(image)
  }

  if (ctx.dev) groups.push([action('inspect')])

  const out: MenuEntry[] = []
  for (const group of groups) {
    if (!group.length) continue
    if (out.length) out.push({ type: 'separator' })
    out.push(...group)
  }
  return out
}

/** The two pieces of electron this needs, handed in so the template above stays loadable without it. */
export interface ContextMenuDeps {
  Menu: { buildFromTemplate(template: Electron.MenuItemConstructorOptions[]): Electron.Menu }
  clipboard: { writeText(text: string): void }
}

export interface ContextMenuOptions {
  /** The window the menu belongs to: the BrowserWindow, for a docked page too. */
  window: Electron.BaseWindow
  dev: boolean
  /** Opens a link in a new docked tab. Absent for Stoke's own window, which has no tabs of pages. */
  openInNewTab?: (url: string) => void
  /** A page's DevTools open detached, as the panel's own toggle does: docked, they would fill its view. */
  detachDevTools?: boolean
}

/** Show the menu `contextMenuTemplate` builds on every right-click `wc` does not handle itself. */
export function attachContextMenu(wc: Electron.WebContents, deps: ContextMenuDeps, opts: ContextMenuOptions): void {
  wc.on('context-menu', (_event, params) => {
    const entries = contextMenuTemplate(params, { dev: opts.dev, canOpenTab: !!opts.openInNewTab })
    if (!entries.length || opts.window.isDestroyed() || wc.isDestroyed()) return
    const run = (a: MenuAction): void => {
      if (wc.isDestroyed()) return
      if (a === 'openLinkInNewTab') opts.openInNewTab?.(params.linkURL)
      else if (a === 'copyLink') deps.clipboard.writeText(params.linkURL)
      else if (a === 'copyImage') wc.copyImageAt(params.x, params.y)
      else if (a === 'copyImageAddress') deps.clipboard.writeText(params.srcURL)
      else {
        if (opts.detachDevTools && !wc.isDevToolsOpened()) wc.openDevTools({ mode: 'detach' })
        wc.inspectElement(params.x, params.y)
      }
    }
    const template = entries.map((entry): Electron.MenuItemConstructorOptions =>
      entry.type === 'separator' ? { type: 'separator' }
        : entry.type === 'edit' ? { label: entry.label, enabled: entry.enabled, click: () => { if (!wc.isDestroyed()) wc[entry.command]() } }
          : { label: entry.label, click: () => run(entry.action) })
    deps.Menu.buildFromTemplate(template).popup({ window: opts.window, ...(params.frame ? { frame: params.frame } : {}) })
  })
}
