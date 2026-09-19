/*
 * One session: the terminal, its status, the answer tray, the key row and the
 * composer.
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
import '@xterm/xterm/css/xterm.css'
import { contextPercent, contextLevel } from '@shared/contextLevel'
import {
  GENERIC_ANSWERS,
  INITIAL_SEND_STATE,
  cancelQueued,
  decideResize,
  fontToFit,
  isTerminalReport,
  modeFromScreen,
  parseAnswerOptions,
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
import { folderName, host, machineName, resumeSession, theme, wsUrl, type SessionRow } from './api'
import { confirmSheet, el, explain, icon, iconButton, openSheet, toast } from './dom'
import { rowTitle, screenLines, sendAnswer } from './list'
import { store } from './store'

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

/** A key the TUI needs and a phone keyboard lacks. */
interface KeyDef {
  label: string
  aria: string
  seq: string
  wide?: boolean
}

/*
 * The first row is the whole vocabulary of answering a prompt and cycling the
 * permission mode; the rest sit behind "more" on a phone rather than off the
 * edge of a sideways scroller where nobody found them. esc and enter are
 * reject and accept on a permission prompt, so the arrows sit between them:
 * one mistap must not invert the answer.
 */
const PRIMARY_KEYS: KeyDef[] = [
  { label: 'esc', aria: 'Escape', seq: '\x1b' },
  { label: '↑', aria: 'Up arrow', seq: '\x1b[A' },
  { label: '↓', aria: 'Down arrow', seq: '\x1b[B' },
  { label: 'enter', aria: 'Enter', seq: '\r' },
  { label: '⇧tab', aria: 'Shift-Tab: cycle permission mode', seq: '\x1b[Z', wide: true }
]
const MORE_KEYS: KeyDef[] = [
  { label: 'tab', aria: 'Tab', seq: '\t' },
  { label: '←', aria: 'Left arrow', seq: '\x1b[D' },
  { label: '→', aria: 'Right arrow', seq: '\x1b[C' },
  { label: 'ctrl-c', aria: 'Control-C: interrupt', seq: '\x03' },
  { label: 'ctrl-r', aria: 'Control-R: search history', seq: '\x12' },
  { label: 'ctrl-l', aria: 'Control-L: clear screen', seq: '\x0c' }
]

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

export function mountSession(ptyId: string, opts: { wide: boolean; onBack: () => void }): SessionScreen {
  const ac = new AbortController()
  const signal = ac.signal
  const cls = deviceClass()
  const coarse = matchMedia('(pointer: coarse)').matches
  const fine = matchMedia('(pointer: fine)').matches

  let row: SessionRow | null = store.row(ptyId)
  const pending = pendingMeta.get(ptyId)
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
  const project = el('span', { class: 'sbar-project' })
  const subtitle = el('span', { class: 'sbar-sub' })
  const pillSlot = el('span', { class: 'sbar-pill' })
  const ctxChip = el('span', { class: 'ctx-chip', hidden: true })
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
    el('div', { class: 'sbar-title' }, el('div', { class: 'sbar-line' }, project, pillSlot), subtitle),
    ctxChip,
    stopBtn,
    moreBtn
  )

  const linkStrip = el('div', { class: 'link-strip', role: 'status', hidden: true }, el('i', { class: 'spinner' }), 'Reconnecting…')

  /* ------------------------------------------------------------- terminal */

  const inner = el('div', { class: 'term-inner' })
  const wrap = el('div', { class: 'term-wrap', 'data-cls': cls }, inner)
  const layoutBanner = el('div', { class: 'banner', hidden: true })

  /* ----------------------------------------------------------------- dock */

  const tray = el('div', { class: 'tray', hidden: true, role: 'group', 'aria-label': 'Answer the prompt' })
  const queued = el('div', { class: 'queued', hidden: true, 'aria-live': 'polite' })
  const endedBox = el('div', { class: 'ended', hidden: true, role: 'status' })

  const keys = el('div', { class: 'keys', role: 'toolbar', 'aria-label': 'Terminal keys' })
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
  const composer = el('div', { class: 'composer' }, input, mic, send)
  const dockRow = el('div', { class: 'dock-row' }, keys, composer)
  const dock = el('div', { class: 'dock' }, tray, queued, endedBox, dockRow)

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
    const name = row?.project ?? pending?.project ?? 'Session'
    project.textContent = name
    const t = row ? rowTitle(row) : 'Starting…'
    const agent = row && row.cli !== 'claude' ? row.agentName : null
    subtitle.textContent = [agent, row?.host ? `ssh ${row.host}` : null, t].filter(Boolean).join(' · ')
    document.title = `${name} · Stoke`
    const p = statusPill(status, waitingFor)
    pillSlot.replaceChildren(el('span', { class: 'pill', 'data-tone': p.tone }, el('i', { 'aria-hidden': 'true' }), p.label))
    const ctx = row?.context
    if (ctx?.ready && ctx.contextLimit > 0) {
      const pct = contextPercent(ctx.contextTokens, ctx.contextLimit)
      ctxChip.textContent = `${pct}%`
      ctxChip.title = `Context: ${pct}% used`
      ctxChip.setAttribute('aria-label', `Context ${pct}% used`)
      ctxChip.dataset.level = contextLevel(pct)
      ctxChip.hidden = false
    } else ctxChip.hidden = true
    stopBtn.hidden = ended || status !== 'busy'
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

  signal.addEventListener('abort', store.subscribe(() => {
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
    theme: theme?.terminal ?? {}
  })
  term.open(inner)

  /*
   * Keys typed into the terminal itself go straight through — the laptop
   * case; on a phone the terminal is not focusable in any useful way.
   */
  term.onData((data) => {
    // Only keys a person typed: xterm's automatic answers to replayed queries
    // must never reach the pty (isTerminalReport).
    if (isTerminalReport(data) || !inner.contains(document.activeElement)) return
    if (!ended && ws?.readyState === WebSocket.OPEN && ready) ws.send(JSON.stringify({ type: 'input', data }))
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
  const layout = (): TermLayout => (opts.wide ? 'native' : (storedLayout() ?? 'desktop'))

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
    // to a floor, and scrolls sideways past it. Fit and native use the user's.
    // A laptop shows the pty's own grid whole when it can: shrink toward 10px
    // to fit its width and its height rather than scroll a tall desktop grid.
    const byHeight = Math.floor((b.height / (pty.rows * 1.22)) * 2) / 2
    const font =
      mode === 'desktop'
        ? fontToFit(b.width, desktop.cols, ratio, 7, userFont)
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
    if (decision.send && ws?.readyState === WebSocket.OPEN && ready) {
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
    if (opts.wide || storedLayout() || ended) {
      layoutBanner.hidden = true
      return
    }
    const b = box()
    const font = fontToFit(b.width, desktop.cols, ratio, 1, 99)
    if (font >= 9) {
      layoutBanner.hidden = true
      return
    }
    const fitBtn = el('button', { type: 'button', class: 'btn', 'data-variant': 'primary' }, 'Fit to phone')
    const keep = el('button', { type: 'button', class: 'btn' }, 'Keep desktop size')
    fitBtn.addEventListener('click', () => chooseLayout('fit'))
    keep.addEventListener('click', () => chooseLayout('desktop'))
    layoutBanner.replaceChildren(
      el(
        'div',
        { class: 'banner-text' },
        el('strong', {}, `The desktop terminal is ${desktop.cols} columns wide.`),
        el('span', {}, ' Fit it to this screen? The terminal on your computer reflows to match while you watch.')
      ),
      el('div', { class: 'banner-actions' }, keep, fitBtn)
    )
    layoutBanner.hidden = false
  }

  const chooseLayout = (next: 'fit' | 'desktop'): void => {
    localStorage.setItem(LAYOUT_KEY, next)
    layoutBanner.hidden = true
    relayout('toggle')
    if (next === 'fit') toast('Fitted to this screen. The desktop terminal follows until you leave.')
  }

  /* ------------------------------------------------ sticking to the bottom */

  let stick = true
  wrap.addEventListener(
    'scroll',
    () => {
      stick = wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 4
    },
    { passive: true, signal }
  )
  const stickToBottom = (): void => {
    if (stick) wrap.scrollTop = wrap.scrollHeight
  }

  /* --------------------------------------------------------------- socket */

  let ws: WebSocket | null = null
  let ready = false
  let everAttached = false
  let backoff = 1000
  let retry: ReturnType<typeof setTimeout> | null = null
  let leaving = false
  let sendState: SendState = INITIAL_SEND_STATE

  const connect = (): void => {
    if (leaving || ended) return
    if (retry) {
      clearTimeout(retry)
      retry = null
    }
    const socket = new WebSocket(wsUrl(`/ws?ptyId=${encodeURIComponent(ptyId)}`))
    ws = socket
    socket.addEventListener('message', (ev) => {
      if (ws !== socket) return
      onFrame(JSON.parse(String(ev.data)) as Frame)
    })
    socket.addEventListener('close', (ev) => {
      if (ws !== socket) return
      ready = false
      sendState = sendLost(sendState)
      paintQueued()
      // A normal close after an exit frame is the end, not a dropped link
      // (phone contract point 5): never reconnect to a finished process.
      if (leaving || ended || (ev.code === 1000 && ended)) return
      linkStrip.hidden = false
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
    if (msg.type === 'attached') {
      backoff = 1000
      linkStrip.hidden = true
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
        term.scrollToBottom()
        stick = true
        stickToBottom()
        refreshTray()
      })
      ready = true
      relayout('attach')
      const flushed = sendReady(sendState)
      sendState = flushed.state
      for (const text of flushed.flush) ws?.send(JSON.stringify({ type: 'submit', text }))
      if (flushed.flush.length) toast(flushed.flush.length === 1 ? 'Sent your queued message.' : `Sent ${flushed.flush.length} queued messages.`)
      paintQueued()
      if (msg.status) setStatus(msg.status, msg.waitingFor ?? null, msg.promptId ?? null)
    } else if (msg.type === 'data' && msg.data) {
      term.write(msg.data, () => {
        stickToBottom()
        scheduleTray()
      })
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
    if (status !== 'waiting' || ended) {
      tray.hidden = true
      lastTraySig = ''
      dock.dataset.waiting = 'false'
      return
    }
    const prompt: ParsedPrompt | null = parseAnswerOptions(screenLines(term), term.cols)
    const options = prompt?.options ?? GENERIC_ANSWERS
    const sig = JSON.stringify([prompt?.question, options])
    dock.dataset.waiting = 'true'
    tray.hidden = false
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
    const esc = el(
      'button',
      { type: 'button', class: 'tray-btn', 'data-variant': 'quiet', 'aria-label': 'Escape: cancel', onclick: () => void answer('esc') },
      el('span', { class: 'tray-key' }, 'esc'),
      el('span', { class: 'tray-label' }, 'Cancel')
    )
    tray.replaceChildren(
      el('div', { class: 'tray-q' }, prompt?.question ?? statusPill('waiting', waitingFor).label),
      el('div', { class: 'tray-options' }, ...buttons, esc)
    )
  }

  const answer = async (key: string): Promise<void> => {
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
    }
  }

  /* ----------------------------------------------------------------- keys */

  const write = (seq: string): void => {
    if (ended) return
    if (ws?.readyState === WebSocket.OPEN && ready) ws.send(JSON.stringify({ type: 'input', data: seq }))
    else toast('Reconnecting — that key was not sent.', 'error')
  }

  const keyButton = (k: KeyDef): HTMLButtonElement =>
    el(
      'button',
      {
        type: 'button',
        class: 'key',
        'data-key': k.label,
        'data-wide': k.wide ? 'true' : undefined,
        'aria-label': k.aria,
        onclick: () => write(k.seq)
      },
      el('span', { class: 'key-main' }, k.label),
      k.wide ? el('span', { class: 'key-sub' }, 'mode') : null
    )

  /*
   * ctrl-d sends EOF, which on an empty prompt ends the session. It arms on the
   * first tap and fires on the second (not a double-tap: that is a mistap).
   */
  const eof = el('button', { type: 'button', class: 'key key-eof', 'aria-label': 'Control-D: end of input. Tap twice.' }, 'ctrl-d')
  let armed: ReturnType<typeof setTimeout> | null = null
  let armedAt = 0
  const disarm = (): void => {
    if (armed) clearTimeout(armed)
    armed = null
    eof.classList.remove('armed')
    eof.textContent = 'ctrl-d'
  }
  eof.addEventListener('click', () => {
    if (armed) {
      if (Date.now() - armedAt < 350) return
      disarm()
      write('\x04')
      return
    }
    eof.classList.add('armed')
    eof.textContent = 'ctrl-d?'
    armedAt = Date.now()
    armed = setTimeout(disarm, 3000)
  })
  signal.addEventListener('abort', disarm)

  const moreKeys = el('div', { class: 'keys-more', id: `more-${ptyId}` }, ...MORE_KEYS.map(keyButton), eof)
  const moreToggle = el(
    'button',
    { type: 'button', class: 'key key-toggle', 'aria-expanded': 'false', 'aria-controls': moreKeys.id, 'aria-label': 'More keys' },
    icon('keyboard', 18)
  )
  moreToggle.addEventListener('click', () => {
    const open = moreToggle.getAttribute('aria-expanded') !== 'true'
    moreToggle.setAttribute('aria-expanded', String(open))
    keys.dataset.more = String(open)
  })
  keys.append(el('div', { class: 'keys-main' }, ...PRIMARY_KEYS.map(keyButton), moreToggle), moreKeys)

  /* ------------------------------------------------------------- composer */

  const DRAFT = `stoke.draft.${ptyId}`
  input.value = sessionStorage.getItem(DRAFT) ?? ''
  const grow = (): void => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 132)}px`
    send.disabled = !input.value.trim()
  }
  input.addEventListener(
    'input',
    () => {
      grow()
      try {
        if (input.value) sessionStorage.setItem(DRAFT, input.value)
        else sessionStorage.removeItem(DRAFT)
      } catch {
        /* storage full or private */
      }
    },
    { signal }
  )
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
                sendState = cancelQueued(sendState, q.id)
                if (!input.value) {
                  input.value = q.text
                  grow()
                }
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
    /*
     * /voice is answered here, never sent on: the CLI would open the
     * microphone of the computer running it — a machine nobody is sitting at
     * (PX-6). Intercepted whether or not the phone's own voice is available.
     */
    if (value.trim() === '/voice') {
      input.value = ''
      grow()
      toggleVoice()
      return
    }
    const r = submitText(sendState, value, Date.now())
    sendState = r.state
    // {type:'submit'} — the server writes the text and Enter apart (PX-1, gotcha 85).
    if (r.send !== null) ws?.send(JSON.stringify({ type: 'submit', text: r.send }))
    paintQueued()
    input.value = ''
    sessionStorage.removeItem(DRAFT)
    grow()
    stick = true
    term.scrollToBottom()
    stickToBottom()
  }
  send.addEventListener('click', submit, { signal })
  grow()

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
        message: `Dictation isn't set up on ${machineName()}. Use your keyboard's dictation key instead.`
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
  const recorder = block ? null : createRecorder(postTranscription)
  const setMic = (state: 'idle' | 'recording' | 'working'): void => {
    mic.dataset.state = state
    mic.disabled = state === 'working'
    input.placeholder = state === 'recording' ? 'Listening…' : state === 'working' ? 'Transcribing…' : 'Message…'
  }
  const begin = async (e: Event): Promise<void> => {
    e.preventDefault()
    if (!recorder || recorder.recording()) return
    try {
      await recorder.start()
      setMic('recording')
    } catch {
      setMic('idle')
      toast('The microphone is blocked. Allow it for this site and try again.', 'error')
    }
  }
  const end = async (e: Event): Promise<void> => {
    e.preventDefault()
    if (!recorder?.recording()) return
    setMic('working')
    try {
      const text = await recorder.finish()
      setMic('idle')
      if (text) {
        input.value = input.value ? `${input.value.replace(/\s*$/, '')} ${text}` : text
        input.focus()
        input.dispatchEvent(new Event('input'))
      }
    } catch (err) {
      setMic('idle')
      // A toast, never the placeholder: that clipped the message at 60
      // characters and left an internal URL in the field (PX-20).
      toast(err instanceof Error && !/https?:\/\//.test(err.message) ? err.message : 'Transcription failed. Try again.', 'error')
    }
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
   */
  let voiceOn = false
  const voiceBanner = el('div', { class: 'voice-banner', role: 'status' }, 'Voice mode: hold space to speak · esc to leave')
  const setVoice = (on: boolean): void => {
    voiceOn = on
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
  document.addEventListener(
    'keydown',
    (e) => {
      if (!voiceOn) return
      if (e.key === 'Escape') setVoice(false)
      else if (e.code === 'Space' && !e.repeat) void begin(e)
    },
    { signal }
  )
  document.addEventListener(
    'keyup',
    (e) => {
      if (voiceOn && e.code === 'Space') void end(e)
    },
    { signal }
  )
  signal.addEventListener('abort', () => setVoice(false))

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
    const canResume = Boolean(cwd && sessionId && (!row || row.cli === 'claude') && !row?.host)
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
    tray.hidden = true
    queued.hidden = true
    layoutBanner.hidden = true
    linkStrip.hidden = true
  }

  /* ----------------------------------------------------------------- menu */

  moreBtn.addEventListener(
    'click',
    () => {
      const sheet = openSheet({ title: 'Session' })
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
      if (!opts.wide) {
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
                ? `Fitted: the terminal on ${machineName()} is resized to this screen while you watch, and goes back when you leave.`
                : `Showing the desktop's own ${desktop.cols} columns. Fit to phone resizes the terminal on ${machineName()} while you watch.`
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
      if (!ended) {
        items.push(action('Interrupt (ctrl-c)', 'stop', () => write('\x03')))
        if (!row || row.cli === 'claude') {
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

  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.visibilityState === 'visible' && !leaving && !ended && ws && ws.readyState > WebSocket.OPEN) {
        backoff = 1000
        connect()
      }
    },
    { signal }
  )

  paintHeader()
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
