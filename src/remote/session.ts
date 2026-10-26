import { openRemoteSocket } from './api'
/*
 * One session: the terminal, its status, the answer tray, the key row and the
 * composer.
 *
 * The chrome is kept to two bars. The header says what the session is doing
 * (its title), then where, its state and its context in one quiet line; Stop
 * is there only while a turn runs, and everything else is behind one "more"
 * menu. The dock is the composer, with the key row out only when it is the
 * vocabulary of the moment (`keyRowShown`) or asked for.
 *
 * The terminal is read-mostly on a phone — text goes in through a <textarea>,
 * because typing into an xterm on a soft keyboard is awful and autocorrect
 * fights the TUI. On a laptop (pointer: fine) the terminal takes keys too, and
 * Enter in the composer sends.
 *
 * Everything this screen adds to window/document is registered with one
 * AbortController's signal and removed on leave (audit PX-23: every visit used
 * to leave another resize handler refitting a disposed terminal).
 */
import { Terminal } from '@xterm/xterm'
import { UnicodeGraphemesAddon } from '@xterm/addon-unicode-graphemes'
import { captureTerminalViewport, restoreTerminalViewport } from '@shared/terminalViewport'
import '@xterm/xterm/css/xterm.css'
import { contextPercent, contextLevel } from '@shared/contextLevel'
import {
  GENERIC_ANSWERS,
  INITIAL_SEND_STATE,
  cancelQueued,
  decideResize,
  desktopFont,
  keyRowShown,
  fontToFit,
  scrollToColumn,
  terminalFollowTop,
  isTerminalReport,
  modeFromScreen,
  parseAnswerOptions,
  phoneTermContrast,
  sendLost,
  sendReady,
  statusPill,
  submitText,
  type ParsedPrompt,
  type SendState,
  type Size,
  type TermLayout
} from '@shared/phoneUi'
import type { PhoneSessionStatus } from '@shared/remotePhone'
import { createRecorder, postTranscription, voiceSupported } from '@shared/voice'
import {
  SPACE_IDLE,
  spaceHold,
  spaceKey,
  type SpaceHoldEvent,
  type SpaceHoldState,
  type SpaceHoldStep
} from '@shared/voiceRoute'
import { DEFAULT_HOLD_MS } from '@shared/voiceSettings'
import { accessRefusalOf, folderName, host, machineName, resumeSession, theme, THEME_EVENT, wsUrl, type SessionRow } from './api'
import { confirmSheet, el, explain, icon, iconButton, openSheet, toast } from './dom'
import { rowTitle, screenLines, sendAnswer } from './list'
import { store } from './store'
import { openSessionFiles } from './files'
import { mountTerminalKeys } from './terminalKeyBar'
import { mountTerminalTouchScroll } from './terminalTouchScroll'
import { DraftJournal, mountDraftCache } from './draftCache'
import { REMOTE_DEVICE_INPUT_MAX, REMOTE_DEVICE_SUBMIT_MAX, type RemoteDeviceState } from '@shared/remoteDevices'

/** Filled by whoever starts a session, so the header is right before the first push. */
export const pendingMeta = new Map<string, { cwd: string; project: string }>()

const LAYOUT_KEY = 'stoke.layout'
const FONT_KEY = 'stoke.termFont'

type DeviceClass = 'phone' | 'tablet' | 'laptop'

function deviceClass(): DeviceClass {
  if (matchMedia('(min-width: 1024px)').matches) return 'laptop'
  if (matchMedia('(min-width: 768px)').matches) return 'tablet'
  return 'phone'
}

const DEFAULT_FONT: Record<DeviceClass, number> = { phone: 12, tablet: 14, laptop: 13 }

function storedFont(cls: DeviceClass): number {
  const n = Number(localStorage.getItem(`${FONT_KEY}.${cls}`))
  return n >= 9 && n <= 20 ? n : DEFAULT_FONT[cls]
}

/** One monospace cell's width per px of font size, measured once per font. */
function cellRatio(fontFamily: string): number {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return 0.6
  ctx.font = `100px ${fontFamily}`
  return ctx.measureText('MMMMMMMMMM').width / 1000 || 0.6
}

const MODE_LABEL: Record<string, string> = {
  default: 'Ask',
  plan: 'Plan',
  acceptEdits: 'Edits',
  auto: 'Auto',
  bypassPermissions: 'Bypass'
}

export interface SessionScreen {
  root: HTMLElement
  destroy: () => void
}

export function mountSession(ptyId: string, opts: { wide: boolean; onBack: () => void; remote?: { device: string } }): SessionScreen {
  const ac = new AbortController()
  const signal = ac.signal
  const cls = deviceClass()
  const coarse = matchMedia('(pointer: coarse)').matches
  const fine = matchMedia('(pointer: fine)').matches

  // PTY ids belong to a computer. A matching local id must never replace a remote row.
  let row: SessionRow | null = opts.remote ? null : store.row(ptyId)
  const pending = opts.remote ? undefined : pendingMeta.get(ptyId)
  let deviceState: RemoteDeviceState | null = null
  const targetName = (): string => opts.remote ? deviceState?.deviceLabel || 'Other device' : machineName()
  const mayType = (): boolean => !opts.remote || (deviceState?.state === 'open' && deviceState.mode === 'full')
  const mayResize = (): boolean => !opts.remote || (mayType() && deviceState?.sizes === true)
  let status: PhoneSessionStatus = row?.status ?? 'unknown'
  let waitingFor: string | null = row?.waitingFor ?? null
  /** The prompt the tray answers; the server refuses any other (`answerVerdict`). */
  let promptId: string | null = row?.promptId ?? null
  /** What the answer tray last drew, so an unchanged screen does not redraw it. */
  let lastTraySig = ''
  let ended = false
  let endReason: string | null = null
  let exitCode: number | null = null

  /* --------------------------------------------------------------- header */

  const back = iconButton('back', 'Back to sessions', { class: 'icon-btn back-btn' })
  back.addEventListener('click', opts.onBack, { signal })
  const titleLine = el('span', { class: 'sbar-project' })
  const where = el('span', { class: 'sbar-where' })
  const statusSlot = el('span', { class: 'sbar-status' })
  const ctxChip = el('span', { class: 'sbar-ctx', hidden: true })
  const subtitle = el('span', { class: 'sbar-sub' }, where, statusSlot, ctxChip)
  const stopBtn = el(
    'button',
    { type: 'button', class: 'stop-btn', hidden: true, 'aria-label': 'Stop: interrupt what the agent is doing' },
    icon('stop', 14),
    el('span', {}, 'Stop')
  )
  const moreBtn = iconButton('more', 'Session options', { 'aria-haspopup': 'dialog' })
  const header = el(
    'header',
    { class: 'sbar' },
    back,
    el('div', { class: 'sbar-title' }, titleLine, subtitle),
    stopBtn,
    moreBtn
  )

  /*
   * A browser never sees a refused handshake's status, so a socket the computer
   * refuses for Cloudflare Access looks like any dropped link. The store's
   * fallback poll does see it (403, `accessRefusalOf`), and the strip says the computer's
   * reason instead of reconnecting in silence (gotcha 124).
   */
  const linkText = el('span', {}, 'Reconnecting…')
  const retryDevice = el('button', { type: 'button', class: 'btn btn-sm', hidden: true }, 'Try again')
  const linkStrip = el('div', { class: 'link-strip', role: 'status', hidden: true }, el('i', { class: 'spinner' }), linkText, retryDevice)
  const paintLink = (): void => {
    linkText.textContent = opts.remote
      ? deviceState?.message || (deviceState?.mode === 'view' ? `View only on ${targetName()}. Allow control there to type.` : 'Connecting to your other device…')
      : accessRefusalOf(store.error) ?? 'Reconnecting…'
  }
  paintLink()

  /* ------------------------------------------------------------- terminal */

  const inner = el('div', { class: 'term-inner' })
  const wrap = el('div', { class: 'term-wrap', 'data-cls': cls }, inner)
  const layoutBanner = el('div', { class: 'banner', hidden: true })

  /* ----------------------------------------------------------------- dock */

  const tray = el('div', { class: 'tray', hidden: true, role: 'group', 'aria-label': 'Answer the prompt' })
  const queued = el('div', { class: 'queued', hidden: true, 'aria-live': 'polite' })
  const endedBox = el('div', { class: 'ended', hidden: true, role: 'status' })

  const keys = el('div', { class: 'keys', role: 'toolbar', 'aria-label': 'Terminal keys', id: `keys-${ptyId}` })
  const keysToggle = el(
    'button',
    { type: 'button', class: 'keys-toggle', 'aria-label': 'Terminal keys', 'aria-expanded': 'false', 'aria-controls': keys.id },
    icon('keyboard', 20)
  )
  const input = el('textarea', {
    rows: 1,
    class: 'composer-input',
    placeholder: 'Message…',
    'aria-label': 'Message to the agent',
    autocapitalize: 'sentences',
    enterkeyhint: fine ? 'send' : 'enter',
    spellcheck: true
  })
  const mic = el('button', { type: 'button', class: 'mic', 'aria-label': 'Dictate' }, icon('mic', 20))
  const send = el('button', { type: 'button', class: 'send', 'aria-label': 'Send' }, icon('send', 20))
  // The mic sits inside the field, as a keyboard's own does: one control less on the row.
  const composer = el('div', { class: 'composer' }, keysToggle, el('div', { class: 'composer-field' }, input, mic), send)
  const dockRow = el('div', { class: 'dock-row has-terminal-keys' }, keys, composer)
  const draftLabel = el('span', {})
  const recoverDrafts = el('button', { type: 'button', hidden: true }, 'Recover draft')
  const draftNote = el('div', { class: 'draft-note', hidden: true }, draftLabel, recoverDrafts)
  const dock = el('div', { class: 'dock' }, tray, queued, endedBox, dockRow, draftNote)

  const root = el(
    'section',
    { class: 'session', 'aria-label': 'Session', 'data-wide': opts.wide ? 'true' : undefined },
    header,
    linkStrip,
    layoutBanner,
    wrap,
    dock
  )

  /* --------------------------------------------------------- header data */

  const paintHeader = (): void => {
    const name = row?.project || pending?.project || 'Session'
    // What it is doing first, as the list reads; the project while it has no title.
    const title = row ? rowTitle(row) : 'Starting…'
    const titled = Boolean(row?.title || row?.context?.title)
    titleLine.textContent = titled || !row ? title : name
    const agent = row && row.cli !== 'claude' ? row.agentName : null
    where.textContent = [opts.remote ? targetName() : null, titled || !row ? name : null, row?.host ? 'ssh' : agent].filter(Boolean).join(' · ')
    where.title = where.textContent
    where.hidden = !where.textContent
    document.title = `${name}${opts.remote ? ` · ${targetName()}` : ''} · Stoke`
    const p = statusPill(status, waitingFor, opts.remote ? deviceState?.state !== 'open' : !linkStrip.hidden)
    statusSlot.dataset.tone = p.tone
    statusSlot.replaceChildren(el('i', { 'aria-hidden': 'true' }), deviceState?.state === 'open' && deviceState.mode === 'view' ? 'View only' : p.label)
    const ctx = row?.context
    if (ctx?.ready && ctx.contextLimit > 0) {
      const pct = contextPercent(ctx.contextTokens, ctx.contextLimit)
      // The number alone, as the list's meter label reads; the words are for a screen reader.
      ctxChip.textContent = `${pct}%`
      ctxChip.title = `Context: ${pct}% used`
      ctxChip.setAttribute('aria-label', `Context ${pct}% used`)
      ctxChip.dataset.level = contextLevel(pct)
      ctxChip.hidden = false
    } else ctxChip.hidden = true
    stopBtn.hidden = ended || status !== 'busy' || !mayType()
    paintMode()
  }

  /** The shift-tab key's second line: the mode on screen, else the transcript's. */
  const paintMode = (): void => {
    const modeKey = keys.querySelector<HTMLElement>('[data-key="⇧tab"] .key-sub')
    if (!modeKey) return
    const mode = row?.context?.permissionMode
    modeKey.textContent = modeFromScreen(screenLines(term)) ?? (mode ? (MODE_LABEL[mode] ?? mode) : 'mode')
  }

  const setStatus = (next: PhoneSessionStatus, why: string | null, prompt: string | null = null): void => {
    if (ended) next = 'ended'
    const changed = next !== status || why !== waitingFor || prompt !== promptId
    status = next
    waitingFor = why
    promptId = prompt
    // A new prompt is drawn afresh even when its options read the same.
    if (changed) lastTraySig = ''
    paintHeader()
    if (changed) refreshTray()
  }

  if (!opts.remote) signal.addEventListener('abort', store.subscribe(() => {
    paintLink()
    const next = store.row(ptyId)
    if (next) {
      row = next
      if (next.status !== status || next.waitingFor !== waitingFor || next.promptId !== promptId) {
        setStatus(next.status, next.waitingFor, next.promptId)
      }
      else paintHeader()
    }
  }) as unknown as EventListener)

  /* --------------------------------------------------------------- xterm */

  const fontFamily = theme?.fontFamily || "'JetBrains Mono', 'SF Mono', Menlo, monospace"
  const ratio = cellRatio(fontFamily)
  let userFont = storedFont(cls)
  const term = new Terminal({
    fontFamily,
    fontSize: userFont,
    lineHeight: 1.2,
    cursorBlink: false,
    scrollback: 5000,
    convertEol: false,
    allowProposedApi: true,
    theme: theme?.terminal ?? {},
    // Replayed history can carry colours chosen for another background (PX-21).
    minimumContrastRatio: phoneTermContrast(theme?.contrastBoost)
  })
  term.open(inner)
  term.loadAddon(new UnicodeGraphemesAddon())
  term.unicode.activeVersion = '15-graphemes'
  // The desktop switched theme while this was open: repaint in place.
  window.addEventListener(
    THEME_EVENT,
    () => {
      term.options.theme = theme?.terminal ?? {}
      term.options.minimumContrastRatio = phoneTermContrast(theme?.contrastBoost)
    },
    { signal }
  )

  /*
   * Keys typed into the terminal itself go straight through — the laptop
   * case; on a phone the terminal is not focusable in any useful way.
   */
  let touchScrolling = false
  term.onData((data) => {
    // Touch-generated wheel reports may pass while the composer owns focus.
    // Automatic answers to replayed queries must never reach the pty.
    if (isTerminalReport(data) || (!touchScrolling && !inner.contains(document.activeElement))) return
    if (opts.remote && data.length > REMOTE_DEVICE_INPUT_MAX) { toast('That paste is too large. Send it in smaller parts.', 'error'); return }
    if (!ended && mayType() && ws?.readyState === WebSocket.OPEN && ready) ws.send(JSON.stringify({ type: 'input', data }))
  })

  /* ---------------------------------------------------------- the layout */

  let desktop: Size = { cols: row?.cols ?? 100, rows: row?.rows ?? 30 }
  let pty: Size = { ...desktop }
  let resized = false
  let fitWidth: number | null = null
  let deferred = false
  const storedLayout = (): 'fit' | 'desktop' | null => {
    const v = localStorage.getItem(LAYOUT_KEY)
    return v === 'fit' || v === 'desktop' ? v : null
  }
  const layout = (): TermLayout => (opts.wide ? 'native' : (mayResize() ? storedLayout() ?? 'desktop' : 'desktop'))

  const cell = (): { width: number; height: number } | null => {
    const dims = (term as unknown as { _core: { _renderService: { dimensions: { css: { cell: { width: number; height: number } } } } } })
      ._core._renderService.dimensions.css.cell
    return dims.width > 0 && dims.height > 0 ? dims : null
  }

  /** The box the terminal may fill, px, after the wrap's padding and xterm's scrollbar. */
  const box = (): { width: number; height: number } => {
    const style = getComputedStyle(wrap)
    const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
    const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
    return { width: Math.max(0, wrap.clientWidth - padX - 14), height: Math.max(0, wrap.clientHeight - padY) }
  }

  const relayout = (reason: 'attach' | 'observe' | 'toggle' | 'blur'): void => {
    const mode = layout()
    const b = box()
    // The desktop layout shrinks the font to show the desktop's columns, down
    // to a readable floor (`desktopFont`), and scrolls sideways past it. Fit
    // and native use the user's.
    // A laptop shows the pty's own grid whole when it can: shrink toward 10px
    // to fit its width and its height rather than scroll a tall desktop grid.
    const byHeight = Math.floor((b.height / (pty.rows * 1.22)) * 2) / 2
    const font =
      mode === 'desktop'
        ? desktopFont(b.width, desktop.cols, ratio, userFont)
        : mode === 'native'
          ? Math.max(10, Math.min(fontToFit(b.width, pty.cols, ratio, 10, userFont), byHeight))
          : userFont
    if (term.options.fontSize !== font) term.options.fontSize = font
    const c = cell()
    const proposed = c ? { cols: Math.floor(b.width / c.width), rows: Math.floor(b.height / c.height) } : null
    const decision = decideResize({
      layout: mode,
      reason,
      width: b.width,
      fitWidth,
      cellWidth: c?.width ?? font * ratio,
      proposed,
      pty,
      desktop,
      composerFocused: document.activeElement === input,
      resized
    })
    deferred = decision.deferred
    if (decision.send && mayResize() && ws?.readyState === WebSocket.OPEN && ready) {
      ws.send(JSON.stringify({ type: 'resize', cols: decision.send.cols, rows: decision.send.rows, force: true }))
      resized = mode === 'fit'
    } else if (decision.send && mode === 'fit') {
      // Not attached yet: the attach will ask again.
      return
    }
    fitWidth = decision.fitWidth
    pty = decision.local
    if (term.cols !== pty.cols || term.rows !== pty.rows) term.resize(pty.cols, pty.rows)
    wrap.dataset.layout = mode
    showLayoutBanner()
    stickToBottom()
    // Wider than the screen: open where the cursor is, not at column 0.
    if (mode === 'desktop' && (reason === 'attach' || reason === 'toggle') && c) {
      const x = term.buffer.active.cursorX * c.width
      wrap.scrollLeft = scrollToColumn(x, c.width, b.width, wrap.scrollLeft)
    }
  }

  let observeTimer: ReturnType<typeof setTimeout> | null = null
  const observer = new ResizeObserver(() => {
    if (observeTimer) clearTimeout(observeTimer)
    observeTimer = setTimeout(() => relayout('observe'), 300)
  })
  observer.observe(wrap)
  signal.addEventListener('abort', () => {
    observer.disconnect()
    if (observeTimer) clearTimeout(observeTimer)
  })
  input.addEventListener(
    'blur',
    () => {
      if (deferred) setTimeout(() => relayout('blur'), 350)
    },
    { signal }
  )

  const showLayoutBanner = (): void => {
    // The layout choice remains in Session options. On keyboard-height
    // viewports its initial suggestion would leave no usable terminal row.
    if (opts.wide || root.clientHeight < 500 || storedLayout() || ended || !mayResize()) {
      layoutBanner.hidden = true
      return
    }
    const b = box()
    const font = fontToFit(b.width, desktop.cols, ratio, 1, 99)
    if (font >= 9) {
      layoutBanner.hidden = true
      return
    }
    const fitBtn = el('button', { type: 'button', class: 'btn btn-sm', 'data-variant': 'primary' }, 'Fit to phone')
    const keep = el('button', { type: 'button', class: 'btn btn-sm' }, 'Keep')
    fitBtn.addEventListener('click', () => chooseLayout('fit'))
    keep.addEventListener('click', () => chooseLayout('desktop'))
    layoutBanner.replaceChildren(
      el(
        'div',
        { class: 'banner-text' },
        el('strong', {}, `${desktop.cols}-column desktop`),
        el('span', {}, 'Fitting reflows it there too.')
      ),
      el('div', { class: 'banner-actions' }, keep, fitBtn)
    )
    layoutBanner.hidden = false
  }

  const chooseLayout = (next: 'fit' | 'desktop'): void => {
    if (next === 'fit' && !mayResize()) return
    localStorage.setItem(LAYOUT_KEY, next)
    layoutBanner.hidden = true
    relayout('toggle')
    if (next === 'fit') toast(`Fitted to this screen. The terminal on ${targetName()} follows until you leave.`)
  }

  /* ------------------------------------------------ sticking to the bottom */

  let stick = true
  let programmaticTop: number | null = null
  const followTop = (): number => {
    const height = cell()?.height
    if (!height) return Math.max(0, wrap.scrollHeight - wrap.clientHeight)
    const buffer = term.buffer.active
    const cursor = buffer.baseY + buffer.cursorY - buffer.viewportY
    let lastRow = cursor >= 0 && cursor < term.rows ? cursor : 0
    for (let y = term.rows - 1; y > lastRow; y--) {
      if (buffer.getLine(buffer.viewportY + y)?.translateToString(true).trim()) { lastRow = y; break }
    }
    const style = getComputedStyle(wrap)
    return terminalFollowTop({ lastRow, rows: term.rows, cellHeight: height,
      padding: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom),
      viewport: wrap.clientHeight, scrollHeight: wrap.scrollHeight })
  }
  wrap.addEventListener(
    'scroll',
    () => {
      const expected = programmaticTop
      programmaticTop = null
      if (expected !== null && Math.abs(wrap.scrollTop - expected) <= 1) return
      stick = Math.abs(wrap.scrollTop - followTop()) <= 4
    },
    { passive: true, signal }
  )
  const stickToBottom = (): void => {
    if (stick) {
      programmaticTop = followTop()
      wrap.scrollTop = programmaticTop
    }
  }

  /* --------------------------------------------------------------- socket */

  let ws: WebSocket | null = null
  let ready = false
  let everAttached = false
  let interaction = 0
  const touched = (): void => { interaction++ }
  wrap.addEventListener('wheel', touched, { passive: true, signal })
  wrap.addEventListener('touchstart', touched, { passive: true, signal })
  wrap.addEventListener('pointerdown', touched, { signal })
  wrap.addEventListener('keydown', touched, { signal })
  let backoff = 1000
  let retry: ReturnType<typeof setTimeout> | null = null
  let leaving = false
  let sendState: SendState = INITIAL_SEND_STATE
  const queuedDrafts = new Map<number, string>()
  const forgetQueuedDraft = (id: number): void => {
    const key = queuedDrafts.get(id)
    if (!key) return
    try { localStorage.removeItem(key); queuedDrafts.delete(id); draftCache.refresh() } catch { /* Keep recovery when storage is unavailable. */ }
  }

  const connect = (): void => {
    if (leaving || ended) return
    if (retry) {
      clearTimeout(retry)
      retry = null
    }
    const socket = openRemoteSocket(wsUrl(opts.remote
      ? `/ws/machine?device=${encodeURIComponent(opts.remote.device)}&ptyId=${encodeURIComponent(ptyId)}`
      : `/ws?ptyId=${encodeURIComponent(ptyId)}`))
    ws = socket
    socket.addEventListener('message', (ev) => {
      if (ws !== socket) return
      try {
        const frame: unknown = JSON.parse(String(ev.data))
        if (!frame || typeof frame !== 'object' || typeof (frame as Frame).type !== 'string') throw new Error('Invalid frame')
        onFrame(frame as Frame)
      } catch {
        socket.close(1002, 'Invalid terminal frame')
      }
    })
    socket.addEventListener('close', (ev) => {
      if (ws !== socket) return
      ready = false
      keyBar.setEnabled(false)
      const refusedDevice = !!opts.remote && ev.code === 1008 && deviceState?.state === 'refused'
      if (opts.remote) {
        if (!ended && !refusedDevice) deviceState = null
        paintRemoteControls()
        paintLink()
      }
      sendState = sendLost(sendState)
      paintQueued()
      // A normal close after an exit frame is the end, not a dropped link
      // (phone contract point 5): never reconnect to a finished process.
      if (leaving || ended || (ev.code === 1000 && ended)) return
      linkStrip.hidden = false
      paintHeader()
      // Invalid/stale device links need a deliberate retry, not an endless
      // stream of fresh relay requests that erases the host's refusal.
      if (refusedDevice) return
      retry = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 10_000)
    })
  }

  interface Frame {
    type: string
    data?: string
    history?: string
    cols?: number
    rows?: number
    desktopCols?: number
    desktopRows?: number
    status?: PhoneSessionStatus
    waitingFor?: string | null
    promptId?: string | null
    code?: number | null
    reason?: string
  }

  const onFrame = (msg: Frame): void => {
    if (msg.type === 'remote-state' && opts.remote) {
      const next = msg as unknown as RemoteDeviceState
      deviceState = next
      const activity = next.state === 'open' ? next.session?.activity : null
      setStatus(activity === 'busy' || activity === 'shell' ? 'busy' : activity === 'waiting' ? 'waiting' : activity === 'idle' ? 'idle' : 'unknown', activity === 'waiting' ? 'input needed' : null, null)
      const context = next.session?.context
      row = {
        ptyId, sessionId: '', cwd: '', name: next.project || next.title, host: null, exited: next.state === 'ended',
        startedAt: 0, cols: row?.cols ?? 100, rows: row?.rows ?? 30,
        context: context ? { contextTokens: context.used, contextLimit: context.limit, messageCount: 0, title: next.title, ready: true, permissionMode: null } : null,
        status, waitingFor, promptId: null, lastActivityAt: null,
        cli: next.session?.agent ?? '', agentName: next.session?.agent || 'Agent',
        project: next.project, title: next.title || null, endedAt: null, exitCode: null
      }
      if (next.state !== 'open') ready = false
      paintLink()
      linkStrip.hidden = next.state === 'open' && next.mode === 'full'
      if (next.state === 'ended') {
        ended = true
        endReason = next.message
        showEnded()
      }
      paintRemoteControls()
      paintHeader()
      paintKeys()
    } else if (msg.type === 'attached') {
      const saved = everAttached ? captureTerminalViewport(term) : null
      const outerTop = wrap.scrollTop
      const wasSticking = stick
      const revision = interaction
      backoff = 1000
      linkStrip.hidden = !opts.remote || mayType()
      paintHeader()
      desktop = { cols: msg.desktopCols ?? msg.cols ?? desktop.cols, rows: msg.desktopRows ?? msg.rows ?? desktop.rows }
      pty = { cols: msg.cols ?? pty.cols, rows: msg.rows ?? pty.rows }
      // A phone that fitted before a reconnect is still the one that resized.
      resized = pty.cols !== desktop.cols || pty.rows !== desktop.rows ? resized : false
      fitWidth = null
      if (term.cols !== pty.cols || term.rows !== pty.rows) term.resize(pty.cols, pty.rows)
      // The server replays the full history on every attach: reset first, in
      // the same frame, so the replay does not land on top of the old screen.
      if (everAttached) term.reset()
      everAttached = true
      term.write(msg.history ?? '', () => {
        if (leaving) return
        if (revision === interaction) {
          if (saved) restoreTerminalViewport(term, saved)
          else term.scrollToBottom()
          stick = wasSticking
          if (stick) stickToBottom()
          else wrap.scrollTop = outerTop
        }
        refreshTray()
      })
      ready = true
      paintRemoteControls()
      paintKeys()
      relayout('attach')
      if (!opts.remote) {
        const previousQueue = sendState.queue
        const flushed = sendReady(sendState)
        let handed = 0
        for (const text of flushed.flush) {
          try {
            if (ws?.readyState !== WebSocket.OPEN) break
            ws.send(JSON.stringify({ type: 'submit', text }))
            forgetQueuedDraft(previousQueue[handed].id)
            handed++
          } catch { break }
        }
        sendState = { ...flushed.state, ready: handed === flushed.flush.length, queue: previousQueue.slice(handed) }
        if (handed) toast(handed === 1 ? 'Sent your queued message.' : `Sent ${handed} queued messages.`)
      }
      paintQueued()
      if (msg.status) setStatus(msg.status, msg.waitingFor ?? null, msg.promptId ?? null)
    } else if (msg.type === 'data' && msg.data) {
      term.write(msg.data, () => {
        stickToBottom()
        scheduleTray()
      })
    } else if (msg.type === 'size' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
      /*
       * The grid changed under this view (the desktop's pane resized, or
       * another phone fitted it). A laptop used to keep drawing the old grid
       * until it reconnected. Same bookkeeping as `attached`, then the usual
       * layout pass, which never sends a resize for this reason alone.
       */
      desktop = { cols: msg.desktopCols ?? msg.cols, rows: msg.desktopRows ?? msg.rows }
      pty = { cols: msg.cols, rows: msg.rows }
      resized = pty.cols !== desktop.cols || pty.rows !== desktop.rows ? resized : false
      relayout('observe')
    } else if (msg.type === 'status' && msg.status) {
      setStatus(msg.status, msg.waitingFor ?? null, msg.promptId ?? null)
    } else if (msg.type === 'exit') {
      ended = true
      exitCode = typeof msg.code === 'number' ? msg.code : null
      endReason = msg.reason ?? null
      setStatus('ended', null, null)
      showEnded()
    }
  }

  /* ----------------------------------------------------------- answer tray */

  let trayTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleTray = (): void => {
    if (trayTimer) return
    trayTimer = setTimeout(() => {
      trayTimer = null
      refreshTray()
      paintMode()
    }, 150)
  }

  const refreshTray = (): void => {
    // Remote terminal keys remain deliberate input; do not recreate the local
    // HTTP answer route without its host-side prompt-id check.
    if (opts.remote || status !== 'waiting' || ended) {
      tray.hidden = true
      lastTraySig = ''
      dock.dataset.waiting = 'false'
      paintKeys()
      return
    }
    const prompt: ParsedPrompt | null = parseAnswerOptions(screenLines(term), term.cols)
    const options = prompt?.options ?? GENERIC_ANSWERS
    const sig = JSON.stringify([prompt?.question, options])
    dock.dataset.waiting = 'true'
    tray.hidden = false
    paintKeys()
    if (sig === lastTraySig) return
    lastTraySig = sig
    const buttons = options.map((o, i) =>
      el(
        'button',
        {
          type: 'button',
          class: 'tray-btn',
          'data-variant': i === 0 ? 'primary' : undefined,
          'aria-label': `Answer ${o.key}: ${o.label}`,
          onclick: () => void answer(o.key)
        },
        el('span', { class: 'tray-key' }, o.key),
        el('span', { class: 'tray-label' }, o.label === o.key ? `Option ${o.key}` : o.label)
      )
    )
    // Cancel rides on the question's line: a full row of its own made the tray a band taller.
    const esc = el(
      'button',
      { type: 'button', class: 'tray-cancel', 'aria-label': 'Escape: cancel', onclick: () => void answer('esc') },
      el('span', { class: 'tray-key' }, 'esc'),
      'Cancel'
    )
    tray.replaceChildren(
      el('div', { class: 'tray-head' }, el('div', { class: 'tray-q' }, prompt?.question ?? statusPill('waiting', waitingFor).label), esc),
      el('div', { class: 'tray-options' }, ...buttons)
    )
  }

  const answer = async (key: string): Promise<void> => {
    if (opts.remote) return
    for (const b of tray.querySelectorAll('button')) b.disabled = true
    let ok: boolean
    if (key === 'esc' || Number(key) <= 3) ok = await sendAnswer(ptyId, key, promptId)
    else {
      ok = ws?.readyState === WebSocket.OPEN
      if (ok) ws!.send(JSON.stringify({ type: 'input', data: key }))
    }
    for (const b of tray.querySelectorAll('button')) b.disabled = false
    if (ok) {
      tray.hidden = true
      dock.dataset.waiting = 'false'
      paintKeys()
    }
  }

  /* ----------------------------------------------------------------- keys */

  const write = (seq: string): boolean => {
    if (ended || !mayType()) return false
    if (ws?.readyState === WebSocket.OPEN && ready) {
      ws.send(JSON.stringify({ type: 'input', data: seq }))
      return true
    }
    toast('Reconnecting — that key was not sent.', 'error')
    return false
  }
  mountTerminalTouchScroll(wrap, {
    enabled: () => ready && !ended && mayType() && term.modes.mouseTrackingMode !== 'none' && term.modes.mouseTrackingMode !== 'x10',
    lineHeight: () => cell()?.height ?? userFont * 1.2,
    wheel: (x, y, delta) => {
      const screen = inner.querySelector('.xterm-screen')
      if (!screen) return
      const box = screen.getBoundingClientRect()
      touchScrolling = true
      try {
        screen.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true, cancelable: true, deltaMode: WheelEvent.DOM_DELTA_LINE, deltaY: Math.sign(delta),
          clientX: Math.max(box.left + 1, Math.min(box.right - 1, x)),
          clientY: Math.max(box.top + 1, Math.min(box.bottom - 1, y))
        }))
      } finally { touchScrolling = false }
    },
    signal
  })
  const keyBar = mountTerminalKeys(keys, {
    write,
    applicationCursorMode: () => term.modes.applicationCursorKeysMode,
    signal
  })
  paintMode()

  /*
   * The key row: behind `keysToggle`, and out on its own while the composer has
   * focus and no prompt waits (`keyRowShown`). Focus is read a beat late on
   * the way out, so a tap on a key lands on the key and not on whatever moved
   * up into its place as the row folded away under the finger.
   */
  let keysChoice: boolean | null = null
  let composerFocused = false
  let wasWaiting = false
  let blurTimer: ReturnType<typeof setTimeout> | null = null
  const keyControl = (target: EventTarget | null): boolean => target instanceof Node && (keys.contains(target) || target === keysToggle)
  const paintKeys = (): void => {
    const waiting = dock.dataset.waiting === 'true'
    if (waiting !== wasWaiting) {
      // A prompt arriving or leaving is a new moment: the toggle's old choice lapses.
      wasWaiting = waiting
      keysChoice = null
    }
    const shown = keyRowShown({ toggled: keysChoice, composerFocused, keysFocused: !keys.hidden && keyControl(document.activeElement), waiting, ended })
    keys.hidden = !shown
    keyBar.setEnabled(ready && !ended && mayType())
    if (!shown) keyBar.reset()
    keysToggle.setAttribute('aria-expanded', String(shown))
    requestAnimationFrame(markKeyOverflow)
  }
  // Touch keys deliberately retain composer focus, so a tap can arrive while
  // Send still owns focus and the composer's blur timer is counting down.
  // Using the visible bar is an explicit choice to keep it open.
  keys.addEventListener('pointerdown', () => {
    if (keys.hidden) return
    if (blurTimer) clearTimeout(blurTimer)
    blurTimer = null
    keysChoice = true
    paintKeys()
  }, { signal, capture: true })
  keysToggle.addEventListener(
    'click',
    () => {
      keysChoice = keys.hidden
      paintKeys()
    },
    { signal }
  )
  keysToggle.addEventListener('pointerdown', event => event.preventDefault(), { signal })
  input.addEventListener(
    'focus',
    () => {
      if (blurTimer) clearTimeout(blurTimer)
      blurTimer = null
      composerFocused = true
      paintKeys()
    },
    { signal }
  )
  for (const control of [keys, keysToggle]) {
    control.addEventListener('focusin', () => {
      if (blurTimer) clearTimeout(blurTimer)
      blurTimer = null
      composerFocused = false
      paintKeys()
    }, { signal })
    control.addEventListener('focusout', () => {
      if (blurTimer) clearTimeout(blurTimer)
      blurTimer = setTimeout(() => {
        blurTimer = null
        composerFocused = document.activeElement === input
        paintKeys()
      }, 300)
    }, { signal })
  }
  input.addEventListener(
    'blur',
    () => {
      if (blurTimer) clearTimeout(blurTimer)
      blurTimer = setTimeout(() => {
        blurTimer = null
        composerFocused = document.activeElement === input
        paintKeys()
      }, 300)
    },
    { signal }
  )
  signal.addEventListener('abort', () => {
    if (blurTimer) clearTimeout(blurTimer)
  })

  /*
   * A landscape phone (PX-17) lays every key on one row that scrolls sideways
   * beside the composer, and the key at the edge was simply cut in half, which
   * read as a clipping bug (review, 844x390). Say which ends have more keys
   * past them; the stylesheet fades those ends.
   */
  const markKeyOverflow = (): void => {
    const hidden = keys.scrollWidth - keys.clientWidth > 1
    keys.dataset.moreStart = String(hidden && keys.scrollLeft > 1)
    keys.dataset.moreEnd = String(hidden && keys.scrollLeft + keys.clientWidth < keys.scrollWidth - 1)
  }
  keys.addEventListener('scroll', markKeyOverflow, { passive: true, signal })
  const keysObserver = new ResizeObserver(markKeyOverflow)
  keysObserver.observe(keys)
  signal.addEventListener('abort', () => keysObserver.disconnect())

  /* ------------------------------------------------------------- composer */

  const DRAFT = `stoke.draft.${opts.remote ? `${opts.remote.device}.` : ''}${ptyId}`
  let journal: DraftJournal | null = null
  const draftScope = opts.remote ? ['remote', opts.remote.device, ptyId]
    : row?.sessionId ? ['local', row.cli, row.cwd, row.sessionId] : ['local-pty', ptyId]
  try { journal = new DraftJournal(localStorage, JSON.stringify(draftScope), Date.now, undefined, `${targetName()} · ${row?.title || row?.project || pending?.project || ptyId}`) } catch { /* Storage blocked. Editing still works. */ }
  const draftCache = mountDraftCache(input, journal, {
    signal,
    notify: (state, records) => {
      draftNote.hidden = !input.value && !records.length && state !== 'error'
      draftNote.dataset.error = String(state === 'error')
      draftLabel.textContent = state === 'error' ? 'Draft could not be saved here. Copy it before leaving.'
        : state === 'restored' ? 'Draft recovered. Check the chat before sending.'
        : state === 'editing' ? 'Saving draft…' : 'Draft saved on this device'
      recoverDrafts.hidden = !records.length
      recoverDrafts.textContent = `Recovery (${records.length})`
    }
  })
  // One-time migration of the old per-tab cache, only when no newer journal
  // history (including an intentional clear) exists.
  try {
    const old = sessionStorage.getItem(DRAFT)
    if (old && journal && !journal.records().length && !input.value) {
      input.value = old
      if (draftCache.flush()) sessionStorage.removeItem(DRAFT)
    } else if (old && journal?.records().length) sessionStorage.removeItem(DRAFT)
  } catch { /* Private mode must not prevent opening the session. */ }
  const grow = (): void => {
    input.style.height = 'auto'
    // border-box: the height carries the border, which scrollHeight leaves out,
    // so a bare scrollHeight sat 2px short and clipped the last line. Nothing
    // to measure while detached (scrollHeight 0): the CSS min-height stands.
    const border = input.offsetHeight - input.clientHeight
    if (input.scrollHeight > 0) input.style.height = `${Math.min(input.scrollHeight + border, 132)}px`
    send.disabled = !input.value.trim() || (!!opts.remote && (!mayType() || !ready || ended))
  }
  input.addEventListener(
    'input',
    () => {
      grow()
    },
    { signal }
  )
  recoverDrafts.addEventListener('click', () => {
    const sheet = openSheet({ title: 'Recover a draft' })
    sheet.body.append(el('p', { class: 'sheet-note' }, 'Saved only in this browser for 14 days. Restoring never sends. Check the chat first: a queued message may already have been delivered.'))
    const list = el('div', { class: 'draft-recovery' })
    for (const record of draftCache.recoveries()) {
      const button = el('button', { type: 'button', class: 'btn' }, `${record.context || 'Saved session'} · ${record.kind === 'queued' ? 'Previously queued' : 'Unsent draft'} · ${new Date(record.at).toLocaleString()}\n${record.text.slice(0, 160)}${record.text.length > 160 ? '…' : ''}`)
      button.addEventListener('click', async () => {
        const otherSession = !record.key.startsWith(journal?.prefix ?? '\0')
        if ((otherSession || (input.value && input.value !== record.text)) && !await confirmSheet({ title: 'Restore into this session?', message: `${otherSession ? 'This draft belongs to another saved session. Check the target conversation before sending. ' : ''}${input.value ? 'Your current text will be kept as another recovery draft.' : 'Restoring only fills the composer.'}`, confirm: 'Restore' })) return
        if (signal.aborted) return
        if (draftCache.restore(record)) { grow(); sheet.close(); input.focus() }
      }, { signal })
      list.append(button)
    }
    sheet.body.append(list)
  }, { signal })
  /*
   * On a laptop Enter sends and Shift+Enter is a newline (PX-16); on a touch
   * keyboard Return stays a newline and the send button sends, since there is
   * no Shift+Return to fall back on.
   */
  input.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' && fine && !coarse && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        submit()
      }
    },
    { signal }
  )

  const paintQueued = (): void => {
    queued.hidden = sendState.queue.length === 0
    queued.replaceChildren(
      ...sendState.queue.map((q) =>
        el(
          'div',
          { class: 'queued-item' },
          el('span', { class: 'queued-tag' }, 'Queued'),
          el('span', { class: 'queued-text' }, q.text),
          el(
            'button',
            {
              type: 'button',
              class: 'queued-x',
              'aria-label': 'Take back this queued message',
              onclick: () => {
                if (input.value && !queuedDrafts.has(q.id)) {
                  const key = draftCache.queued(q.text)
                  if (!key) { toast('Finish your current draft before taking this message back; recovery storage is unavailable.', 'error'); return }
                  queuedDrafts.set(q.id, key)
                }
                sendState = cancelQueued(sendState, q.id)
                if (!input.value) {
                  input.value = q.text
                  grow()
                  if (draftCache.flush()) forgetQueuedDraft(q.id)
                } else toast('Removed from the queue. Its text is available in Recovery.')
                paintQueued()
              }
            },
            icon('close', 14)
          )
        )
      ),
      el('div', { class: 'queued-note' }, 'Sends when the connection is back.')
    )
  }

  const submit = (): void => {
    const value = input.value
    if (!value.trim() || ended) return
    if (opts.remote && value.length > REMOTE_DEVICE_SUBMIT_MAX) { toast('That message is too long. Send it in smaller parts.', 'error'); return }
    // A relay is scoped to the current, approved connection. Keep an unsent
    // draft in place; it must never reach a later reconnect or permission grant.
    if (opts.remote && (!mayType() || !ready || ws?.readyState !== WebSocket.OPEN)) {
      toast('Not sent. Wait for control of this session, then send again.', 'error')
      return
    }
    /*
     * /voice is answered here, never sent on: the CLI would open the
     * microphone of the computer running it — a machine nobody is sitting at
     * (PX-6). Intercepted whether or not the phone's own voice is available.
     */
    if (value.trim() === '/voice') {
      draftCache.clear()
      grow()
      toggleVoice()
      return
    }
    draftCache.flush()
    try {
      if (opts.remote) ws!.send(JSON.stringify({ type: 'submit', text: value }))
      else {
        const r = submitText(ready && ws?.readyState === WebSocket.OPEN ? sendState : sendLost(sendState), value, Date.now())
        // {type:'submit'} — the server writes text and Enter apart.
        if (r.send !== null) ws!.send(JSON.stringify({ type: 'submit', text: r.send }))
        else {
          const queued = r.state.queue.at(-1)
          const key = draftCache.queued(value)
          if (queued && key) queuedDrafts.set(queued.id, key)
        }
        sendState = r.state
      }
    } catch { toast('Not sent. Your text is still here; check the connection before sending again.', 'error'); return }
    paintQueued()
    draftCache.clear()
    try { sessionStorage.removeItem(DRAFT) } catch { /* Storage may be blocked. */ }
    grow()
    stick = true
    term.scrollToBottom()
    stickToBottom()
  }
  send.addEventListener('click', submit, { signal })
  grow()
  // Once more when the view is in the document, so the first paint has the
  // content height (a restored draft, the laptop's smaller --tap).
  requestAnimationFrame(grow)

  /* ---------------------------------------------------------------- voice */

  type VoiceBlock = { title: string; message: string } | null
  const voiceBlock = (): VoiceBlock => {
    if (!window.isSecureContext || !voiceSupported()) {
      return {
        title: 'Voice needs a secure link',
        message:
          'Browsers only allow the microphone on an https link, and this one is plain http. Use the tunnel link from Stoke for voice — or, on Wi-Fi, the dictation key on your keyboard works everywhere.'
      }
    }
    if (host?.stt === 'down') {
      return {
        title: 'Dictation is not answering',
        message: `The speech server on ${machineName()} is not answering. Use your keyboard's dictation key for now.`
      }
    }
    if (host?.stt === 'off') {
      return {
        title: 'Dictation is not set up',
        message: `Dictation isn't set up on ${machineName()}: it needs a speech server or a provider key, set in Stoke's Settings → Voice there. Use your keyboard's dictation key instead.`
      }
    }
    return null
  }
  const block = voiceBlock()
  mic.dataset.state = block ? 'off' : 'idle'
  if (block) {
    mic.replaceChildren(icon('micOff', 20))
    mic.setAttribute('aria-label', `Dictation unavailable: ${block.title}`)
  }
  /*
   * The recording volume, the desktop strip's line on the composer's top edge.
   * Written straight from the recorder's animation frame; shown only while
   * `composer[data-recording]`, and still live under reduced motion (it is
   * data), with only its easing dropped.
   */
  const levelFill = el('span', { class: 'mic-level-fill' })
  composer.append(el('span', { class: 'mic-level', 'aria-hidden': 'true' }, levelFill))
  const recorder = block
    ? null
    : createRecorder(postTranscription, {
        onLevel: (level) => {
          levelFill.style.transform = `scaleX(${level.toFixed(3)})`
        }
      })
  let voiceGeneration = 0
  const setMic = (state: 'idle' | 'recording' | 'working'): void => {
    mic.dataset.state = state
    mic.disabled = state === 'working' || (!!opts.remote && (!mayType() || !ready || ended))
    composer.dataset.recording = state === 'recording' ? 'true' : ''
    input.placeholder = state === 'recording' ? 'Listening…' : state === 'working' ? 'Transcribing…' : 'Message…'
  }
  const blocked = (): void => {
    setMic('idle')
    toast('The microphone is blocked. Allow it for this site and try again.', 'error')
  }
  /** Stop, transcribe, and add the words to the composer. Both gestures end here. */
  const stopAndInsert = async (): Promise<void> => {
    if (!recorder?.recording()) return
    if (opts.remote && (!mayType() || !ready || ended)) { recorder.cancel(); setMic('idle'); return }
    const generation = voiceGeneration
    setMic('working')
    try {
      const text = await recorder.finish()
      if (opts.remote && generation !== voiceGeneration) return
      setMic('idle')
      if (text) {
        input.value = input.value ? `${input.value.replace(/\s*$/, '')} ${text}` : text
        input.focus()
        input.dispatchEvent(new Event('input'))
      }
    } catch (err) {
      if (opts.remote && generation !== voiceGeneration) return
      setMic('idle')
      // A toast, never the placeholder: that clipped the message at 60
      // characters and left an internal URL in the field (PX-20).
      toast(err instanceof Error && !/https?:\/\//.test(err.message) ? err.message : 'Transcription failed. Try again.', 'error')
    }
  }

  /*
   * The mic button is press-and-hold with no threshold: pressing a button
   * labelled Dictate is the request. A release before the microphone has
   * opened (a permission prompt) cancels it, rather than leaving it recording
   * with nobody holding the button.
   */
  let pressed = false
  const begin = async (e: Event): Promise<void> => {
    e.preventDefault()
    if (opts.remote && (!mayType() || !ready || ended)) return
    if (!recorder || recorder.recording()) return
    pressed = true
    try {
      if (!(await recorder.start())) return
      if (pressed) setMic('recording')
      else recorder.cancel()
    } catch {
      blocked()
    }
  }
  const end = async (e: Event): Promise<void> => {
    e.preventDefault()
    if (!pressed) return
    pressed = false
    if (recorder?.recording()) await stopAndInsert()
  }
  if (block) {
    mic.addEventListener('click', () => explain(block.title, block.message), { signal })
  } else {
    mic.addEventListener('pointerdown', (e) => void begin(e), { signal })
    mic.addEventListener('pointerup', (e) => void end(e), { signal })
    mic.addEventListener('pointerleave', (e) => void end(e), { signal })
    mic.addEventListener(
      'pointercancel',
      (e) => {
        e.preventDefault()
        pressed = false
        recorder?.cancel()
        setMic('idle')
      },
      { signal }
    )
    mic.addEventListener('contextmenu', (e) => e.preventDefault(), { signal })
  }

  /*
   * Voice mode, matching the CLI's own gesture: hold space to speak, escape to
   * leave. Opt-in via /voice, and signposted while on.
   *
   * The same hold rule as the desktop terminal (`spaceHold`, voiceRoute.ts): a
   * tap types a space into the composer and never opens the microphone; only
   * a press held past DEFAULT_HOLD_MS (500ms since 2026-10-04) records, and
   * the keyboard's own repeat never starts it sooner. Every repeat is taken
   * (gotcha 79). The phone has no Settings of its own, so it keeps the default
   * threshold.
   */
  let voiceOn = false
  const VOICE_HINT = 'Voice mode: hold space to speak · tap for a space · esc to leave'
  const voiceBanner = el('div', { class: 'voice-banner', role: 'status' }, VOICE_HINT)
  let hold: SpaceHoldState = SPACE_IDLE
  let holdTimer = 0
  const clearHold = (): void => {
    window.clearTimeout(holdTimer)
    holdTimer = 0
  }
  /** The space a tap stood for: at the caret while the composer has focus, else at its end. */
  const typeSpace = (): void => {
    if (document.activeElement === input) {
      const at = input.selectionStart ?? input.value.length
      input.setRangeText(' ', at, input.selectionEnd ?? at, 'end')
    } else {
      input.value += ' '
    }
    input.dispatchEvent(new Event('input'))
  }
  const startHeld = async (): Promise<void> => {
    if (!recorder) return
    voiceBanner.textContent = 'Listening — release space to transcribe'
    try {
      if (!(await recorder.start())) return
      dispatch({ type: 'opened' })
      if (hold.phase === 'recording') setMic('recording')
    } catch {
      dispatch({ type: 'failed' })
      voiceBanner.textContent = VOICE_HINT
      blocked()
    }
  }
  const dispatch = (event: SpaceHoldEvent): SpaceHoldStep => {
    const step = spaceHold(hold, event, performance.now(), DEFAULT_HOLD_MS)
    hold = step.state
    switch (step.output) {
      case 'arm-timer':
        clearHold()
        holdTimer = window.setTimeout(() => dispatch({ type: 'timer' }), step.wait ?? DEFAULT_HOLD_MS)
        voiceBanner.textContent = 'Keep holding…'
        break
      case 'start':
        clearHold()
        void startHeld()
        break
      case 'type-space':
        clearHold()
        voiceBanner.textContent = VOICE_HINT
        typeSpace()
        break
      case 'finish':
        voiceBanner.textContent = VOICE_HINT
        void stopAndInsert()
        break
      case 'cancel':
        clearHold()
        voiceBanner.textContent = VOICE_HINT
        recorder?.cancel()
        setMic('idle')
        break
    }
    return step
  }
  const setVoice = (on: boolean): void => {
    if (on && opts.remote && (!mayType() || !ready || ended)) return
    if (!on && opts.remote) voiceGeneration++
    voiceOn = on
    clearHold()
    hold = SPACE_IDLE
    voiceBanner.textContent = VOICE_HINT
    if (on) {
      dock.prepend(voiceBanner)
      input.blur()
      term.blur()
    } else {
      voiceBanner.remove()
      recorder?.cancel()
      if (recorder) setMic('idle')
    }
  }
  const toggleVoice = (): void => {
    if (block) {
      explain(block.title, block.message)
      return
    }
    setVoice(!voiceOn)
  }
  /*
   * Capture phase, so a taken Space is stopped before the terminal's own
   * textarea ever sees it, rather than cancelled after xterm has had its turn.
   * The old handler here never took the repeats at all (`!e.repeat`), so with
   * the terminal focused every repeat could reach the pty — the stream a CLI's
   * own voice mode listens for (gotcha 79). Measured with the terminal
   * focused: a tap and a held Space landed in the composer and the recorder,
   * and the pty received nothing.
   */
  const take = (e: KeyboardEvent): void => {
    e.preventDefault()
    e.stopPropagation()
  }
  document.addEventListener(
    'keydown',
    (e) => {
      if (!voiceOn) return
      if (e.code === 'Space' && keyControl(e.target)) return
      if (e.key === 'Escape') {
        setVoice(false)
        return
      }
      if (dispatch(spaceKey(e, 'keydown')).take) take(e)
    },
    { signal, capture: true }
  )
  document.addEventListener(
    'keyup',
    (e) => {
      if (!voiceOn) return
      if (hold.phase === 'idle' && e.code === 'Space' && keyControl(e.target)) return
      if (dispatch(spaceKey(e, 'keyup')).take) take(e)
    },
    { signal, capture: true }
  )
  signal.addEventListener('abort', () => setVoice(false))

  function paintRemoteControls(): void {
    if (!opts.remote) return
    const writable = mayType() && ready && !ended
    if (!writable) {
      voiceGeneration++
      if (voiceOn) setVoice(false)
      pressed = false
      recorder?.cancel()
      if (recorder) setMic('idle')
    }
    input.disabled = !writable
    send.disabled = !writable || !input.value.trim()
    mic.disabled = !writable || mic.dataset.state === 'working'
    term.options.disableStdin = !writable
    retryDevice.hidden = !deviceState || !['refused', 'lost'].includes(deviceState.state)
    linkStrip.dataset.state = deviceState?.state ?? 'connecting'
    if (!writable) keyBar.reset()
  }

  /* ---------------------------------------------------------------- stop */

  stopBtn.addEventListener(
    'click',
    () => {
      // Claude Code interrupts on Esc; another CLI on ctrl-c.
      write(row?.cli && row.cli !== 'claude' ? '\x03' : '\x1b')
    },
    { signal }
  )

  /* ---------------------------------------------------------------- ended */

  const showEnded = (): void => {
    const code = exitCode !== null && exitCode !== 0 ? ` (exit ${exitCode})` : ''
    const cwd = row?.cwd ?? pending?.cwd
    const sessionId = row?.sessionId
    const canResume = !opts.remote && Boolean(cwd && sessionId && (!row || row.cli === 'claude') && !row?.host)
    const resume = el('button', { type: 'button', class: 'btn', 'data-variant': 'primary' }, 'Resume conversation')
    const backBtn = el('button', { type: 'button', class: 'btn' }, 'Back to sessions')
    backBtn.addEventListener('click', opts.onBack)
    resume.addEventListener('click', () => {
      resume.disabled = true
      resume.textContent = 'Resuming…'
      void resumeSession(cwd!, sessionId!)
        .then((started) => {
          if (started.alreadyOpen) toast('That conversation is already open. Showing it.')
          else pendingMeta.set(started.ptyId, { cwd: cwd!, project: row?.project ?? folderName(cwd!) })
          location.hash = `#/s/${encodeURIComponent(started.ptyId)}`
        })
        .catch((err: Error) => {
          resume.disabled = false
          resume.textContent = 'Resume conversation'
          toast(err.message, 'error')
        })
    })
    endedBox.replaceChildren(
      el(
        'div',
        { class: 'ended-text' },
        el('strong', {}, `Session ended${code}`),
        el('span', {}, endReason && !everAttached ? endReason : 'Nothing more will arrive. You can still scroll back through it.')
      ),
      el('div', { class: 'ended-actions' }, backBtn, canResume ? resume : null)
    )
    endedBox.hidden = false
    dockRow.hidden = true
    paintKeys()
    tray.hidden = true
    queued.hidden = true
    layoutBanner.hidden = true
    linkStrip.hidden = true
  }

  /* ----------------------------------------------------------------- menu */

  moreBtn.addEventListener(
    'click',
    () => {
      const sheet = openSheet({ title: opts.remote ? `Session on ${targetName()}` : 'Session' })
      const size = el('output', { class: 'font-size', 'aria-live': 'polite' }, `${userFont}px`)
      const setFont = (n: number): void => {
        userFont = Math.max(9, Math.min(20, n))
        localStorage.setItem(`${FONT_KEY}.${cls}`, String(userFont))
        size.textContent = `${userFont}px`
        relayout('toggle')
      }
      const smaller = el('button', { type: 'button', class: 'btn', 'aria-label': 'Smaller text' }, 'A−')
      const larger = el('button', { type: 'button', class: 'btn', 'aria-label': 'Larger text' }, 'A+')
      smaller.addEventListener('click', () => setFont(userFont - 1))
      larger.addEventListener('click', () => setFont(userFont + 1))
      const items: HTMLElement[] = [
        el('div', { class: 'menu-row' }, el('span', { class: 'menu-label' }, 'Text size'), el('div', { class: 'stepper' }, smaller, size, larger))
      ]
      if (!opts.wide && mayResize()) {
        const current = layout()
        const seg = (id: 'fit' | 'desktop', label: string): HTMLButtonElement => {
          const b = el('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(current === id) }, label)
          b.addEventListener('click', () => {
            chooseLayout(id)
            sheet.close()
          })
          return b
        }
        items.push(
          el(
            'div',
            { class: 'menu-row menu-col' },
            el('span', { class: 'menu-label' }, 'Layout'),
            el('div', { class: 'seg', role: 'group', 'aria-label': 'Terminal layout' }, seg('fit', 'Fit to phone'), seg('desktop', 'Desktop size')),
            el(
              'p',
              { class: 'menu-note' },
              current === 'fit'
                ? `Fitted: the terminal on ${targetName()} is resized to this screen while you watch, and goes back when you leave.`
                : `Showing the desktop's own ${desktop.cols} columns. Fit to phone resizes the terminal on ${targetName()} while you watch.`
            )
          )
        )
      }
      const action = (label: string, iconName: string, fn: () => void, danger = false): HTMLButtonElement => {
        const b = el('button', { type: 'button', class: 'menu-item', 'data-danger': danger ? 'true' : undefined }, icon(iconName, 18), label)
        b.addEventListener('click', () => {
          sheet.close()
          fn()
        })
        return b
      }
      items.push(
        action('Copy screen', 'copy', () => {
          const text = screenLines(term).join('\n')
          void navigator.clipboard?.writeText(text).then(
            () => toast('Copied the screen.'),
            () => toast('Copying needs a secure (https) link.', 'error')
          )
        })
      )
      items.push(action('Devices', 'devices', () => { location.hash = '#/devices' }))
      if (!ended && mayType()) {
        if (!opts.remote) items.push(action('Send or download files…', 'folder', () => openSessionFiles({
          ptyId, destination: row?.host ?? machineName(), ssh: !!row?.host, signal,
          insert: (path) => { input.value += `${input.value && !/\s$/.test(input.value) ? ' ' : ''}${path}`; input.dispatchEvent(new Event('input')); input.focus() }
        })))
        items.push(action('Interrupt (ctrl-c)', 'stop', () => write('\x03')))
        if (!opts.remote && (!row || row.cli === 'claude')) {
          items.push(
            action(
              'End session…',
              'close',
              () =>
                void confirmSheet({
                  title: 'End this session?',
                  message: 'This sends /exit. The conversation stays in history and can be resumed.',
                  confirm: 'End session',
                  danger: true
                }).then((yes) => {
                  if (yes && ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'submit', text: '/exit' }))
                }),
              true
            )
          )
        }
      }
      sheet.body.append(el('div', { class: 'menu' }, ...items))
    },
    { signal }
  )

  /* ------------------------------------------------------------ lifecycle */

  const reconnect = (): void => {
    if (leaving || ended) return
    // Invalidate first: a late close/message from this socket cannot alter
    // the replacement connection or flush a message twice.
    const previous = ws
    ws = null
    previous?.close()
    ready = false
    if (opts.remote) {
      deviceState = null
      paintRemoteControls()
      paintLink()
      keyBar.setEnabled(false)
    }
    sendState = sendLost(sendState)
    paintQueued()
    linkStrip.hidden = false
    backoff = 1000
    connect()
  }
  retryDevice.addEventListener('click', reconnect, { signal })
  let hiddenAt: number | null = null
  window.addEventListener('online', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) reconnect()
  }, { signal })

  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState !== 'visible') { hiddenAt = Date.now(); return }
      // Mobile browsers can keep an OPEN socket after suspending its network.
      // Reattach after a sustained background interval rather than trusting
      // that stale state. Uncertain sends retain their delivery warning.
      const suspended = hiddenAt !== null && Date.now() - hiddenAt >= 15_000
      hiddenAt = null
      if (suspended || !ws || ws.readyState > WebSocket.OPEN) reconnect()
    },
    { signal }
  )

  paintHeader()
  paintKeys()
  paintRemoteControls()
  connect()

  const destroy = (): void => {
    leaving = true
    if (retry) clearTimeout(retry)
    if (trayTimer) clearTimeout(trayTimer)
    ac.abort()
    ws?.close()
    term.dispose()
  }
  return { root, destroy }
}
