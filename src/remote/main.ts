import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './style.css'

/**
 * Stoke on a phone.
 *
 * Two screens: a list of live sessions, and a terminal view. The terminal is
 * read-mostly — text goes in through a normal <textarea> rather than the
 * terminal itself, because typing into an xterm on a soft keyboard is awful and
 * autocorrect fights the TUI.
 */

interface SessionRow {
  ptyId: string
  sessionId: string
  cwd: string
  name: string
  startedAt: number
  cols: number
  rows: number
  context: {
    contextTokens: number
    contextLimit: number
    messageCount: number
    title: string | null
    ready: boolean
  } | null
}

const app = document.getElementById('app') as HTMLDivElement

/* ------------------------------------------------------------- helpers */

/**
 * Tiny DOM builder. Props are loosely typed on purpose so dashed attributes
 * (`aria-pressed`, `data-level`) can sit alongside real element properties.
 */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = String(v)
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    } else if (v !== undefined && v !== null) {
      // Attributes like aria-* must go through setAttribute.
      if (k.includes('-')) node.setAttribute(k, String(v))
      else (node as unknown as Record<string, unknown>)[k] = v
    }
  }
  for (const c of children) node.append(c)
  return node
}

function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

function ago(ms: number): string {
  const d = (Date.now() - ms) / 60000
  if (d < 1) return 'just now'
  if (d < 60) return `${Math.floor(d)}m ago`
  if (d < 1440) return `${Math.floor(d / 60)}h ago`
  return `${Math.floor(d / 1440)}d ago`
}

function toast(message: string): void {
  const node = el('div', { class: 'toast' }, message)
  document.body.append(node)
  setTimeout(() => node.remove(), 2600)
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { 'content-type': 'application/json' } })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

/* --------------------------------------------------------- session list */

async function showList(): Promise<void> {
  app.replaceChildren()

  const refresh = el('button', { class: 'btn', title: 'Refresh' }, '↻')
  const create = el('button', { class: 'btn', 'data-variant': 'primary' }, '+ New')
  const bar = el('div', { class: 'bar' }, el('h1', {}, 'Stoke'), el('div', { class: 'spacer' }), refresh, create)
  const scroll = el('div', { class: 'scroll' })
  app.append(bar, scroll)

  refresh.addEventListener('click', () => void load())
  create.addEventListener('click', () => void showNew())

  async function load(): Promise<void> {
    scroll.replaceChildren(el('div', { class: 'empty' }, 'Loading…'))
    try {
      const sessions = await api<SessionRow[]>('/api/sessions')
      if (!sessions.length) {
        scroll.replaceChildren(
          el(
            'div',
            { class: 'empty' },
            'No sessions running on your machine. Start one here, or at your desk.'
          )
        )
        return
      }
      scroll.replaceChildren(...sessions.map(card))
    } catch (err) {
      scroll.replaceChildren(
        el('div', { class: 'empty' }, `Could not reach Stoke. ${(err as Error).message}`)
      )
    }
  }

  function card(s: SessionRow): HTMLElement {
    const ctx = s.context
    const ratio = ctx && ctx.contextLimit ? Math.min(1, ctx.contextTokens / ctx.contextLimit) : 0
    const level = ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'warn' : 'ok'

    const meter = el('div', { class: 'meter', 'data-level': level })
    meter.append(el('i', { style: `transform: scaleX(${ratio})` }))

    return el(
      'button',
      { class: 'card', onclick: () => void showTerminal(s) },
      el('div', { class: 'card-title' }, ctx?.title || s.name),
      el('div', { class: 'card-sub' }, s.cwd),
      el(
        'div',
        { class: 'card-meta' },
        el('span', {}, ago(s.startedAt)),
        meter,
        el(
          'span',
          {},
          ctx?.ready ? `${compact(ctx.contextTokens)}/${compact(ctx.contextLimit)}` : 'idle'
        )
      )
    )
  }

  await load()
}

/* ----------------------------------------------------------- new session */

async function showNew(): Promise<void> {
  app.replaceChildren()
  const back = el('button', { class: 'btn' }, '‹ Back')
  app.append(el('div', { class: 'bar' }, back, el('h1', {}, 'New session')))
  const scroll = el('div', { class: 'scroll' })
  app.append(scroll)
  back.addEventListener('click', () => void showList())

  scroll.replaceChildren(el('div', { class: 'empty' }, 'Loading projects…'))
  try {
    const data = await api<{
      defaultCwd: string
      projects: { path: string; name: string; sessionCount: number; lastModified: number | null }[]
    }>('/api/projects')

    const start = async (cwd: string): Promise<void> => {
      toast('Starting…')
      try {
        await api('/api/sessions', { method: 'POST', body: JSON.stringify({ cwd }) })
        // Give the CLI a moment to print its banner before attaching.
        setTimeout(() => void showList(), 1200)
      } catch (err) {
        toast((err as Error).message)
      }
    }

    scroll.replaceChildren(
      el(
        'button',
        { class: 'card', onclick: () => void start(data.defaultCwd) },
        el('div', { class: 'card-title' }, 'Default folder'),
        el('div', { class: 'card-sub' }, data.defaultCwd)
      ),
      ...data.projects.map((p) =>
        el(
          'button',
          { class: 'card', onclick: () => void start(p.path) },
          el('div', { class: 'card-title' }, p.name),
          el('div', { class: 'card-sub' }, p.path),
          el(
            'div',
            { class: 'card-meta' },
            el('span', {}, p.sessionCount ? `${p.sessionCount} sessions` : 'no history'),
            el('span', {}, p.lastModified ? ago(p.lastModified) : '')
          )
        )
      )
    )
  } catch (err) {
    scroll.replaceChildren(el('div', { class: 'empty' }, (err as Error).message))
  }
}

/* -------------------------------------------------------------- terminal */

const FIT_KEY = 'stoke.fitToPhone'

async function showTerminal(session: SessionRow): Promise<void> {
  app.replaceChildren()

  const back = el('button', { class: 'btn' }, '‹')
  const title = el('h1', {}, session.context?.title || session.name)
  const meterChip = el('span', { class: 'chip' }, 'idle')
  let fit = localStorage.getItem(FIT_KEY) === '1'
  const fitBtn = el('button', { class: 'btn', 'aria-pressed': String(fit) }, 'Fit')

  app.append(
    el('div', { class: 'bar' }, back, title, el('div', { class: 'spacer' }), meterChip, fitBtn)
  )

  const wrap = el('div', { class: 'term-wrap' })
  app.append(wrap)

  const keys = el('div', { class: 'keys' })
  app.append(keys)

  const input = el('textarea', {
    rows: 1,
    placeholder: 'Message Claude…',
    autocapitalize: 'sentences',
    spellcheck: false
  })
  const send = el('button', { class: 'send' }, '↑')
  app.append(el('div', { class: 'composer' }, input, send))

  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
    fontSize: 11,
    lineHeight: 1.15,
    cursorBlink: false,
    // The desktop drives the real size; scrollback is what matters here.
    scrollback: 5000,
    convertEol: false,
    theme: {
      background: '#14110f',
      foreground: '#f2e9e1',
      cursor: '#ff9552',
      selectionBackground: 'rgba(255,149,82,0.3)'
    }
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(wrap)

  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const ws = new WebSocket(`${proto}://${location.host}/ws?ptyId=${encodeURIComponent(session.ptyId)}`)

  const applyFit = (): void => {
    if (!fit) {
      // Render at the desktop's width and let the container scroll sideways.
      term.resize(session.cols, Math.max(10, session.rows))
      return
    }
    try {
      fitAddon.fit()
      ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows, force: true }))
    } catch {
      /* not laid out yet */
    }
  }

  fitBtn.addEventListener('click', () => {
    fit = !fit
    localStorage.setItem(FIT_KEY, fit ? '1' : '0')
    fitBtn.setAttribute('aria-pressed', String(fit))
    applyFit()
    if (!fit) toast('Showing the desktop layout. Scroll sideways.')
    else toast('Resized to this screen — the desktop terminal reflows too.')
  })

  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      type: string
      data?: string
      history?: string
      cols?: number
      rows?: number
      code?: number
    }
    if (msg.type === 'attached') {
      session.cols = msg.cols ?? session.cols
      session.rows = msg.rows ?? session.rows
      applyFit()
      if (msg.history) term.write(msg.history)
      term.scrollToBottom()
    } else if (msg.type === 'data' && msg.data) {
      term.write(msg.data)
    } else if (msg.type === 'exit') {
      term.write(`\r\n\x1b[38;5;209m[session ended${msg.code ? ` (${msg.code})` : ''}]\x1b[0m\r\n`)
    }
  })

  ws.addEventListener('close', () => toast('Disconnected'))
  ws.addEventListener('error', () => toast('Connection error'))

  const write = (data: string): void => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }))
  }

  const submit = (): void => {
    const value = input.value
    if (!value.trim()) return
    write(`${value}\r`)
    input.value = ''
    input.style.height = 'auto'
    term.scrollToBottom()
  }

  send.addEventListener('click', submit)
  input.addEventListener('input', () => {
    input.style.height = 'auto'
    input.style.height = `${Math.min(input.scrollHeight, 104)}px`
  })

  // The TUI needs these and a phone keyboard has none of them.
  const KEYS: [string, string][] = [
    ['esc', '\x1b'],
    ['tab', '\t'],
    ['↑', '\x1b[A'],
    ['↓', '\x1b[B'],
    ['ctrl-c', '\x03'],
    ['enter', '\r'],
    ['shift-tab', '\x1b[Z'],
    ['ctrl-r', '\x12']
  ]
  for (const [label, seq] of KEYS) {
    keys.append(el('button', { class: 'key', onclick: () => write(seq) }, label))
  }

  back.addEventListener('click', () => {
    ws.close()
    term.dispose()
    void showList()
  })

  // Keep the meter chip current while the session runs.
  const poll = window.setInterval(async () => {
    try {
      const list = await api<SessionRow[]>('/api/sessions')
      const me = list.find((s) => s.ptyId === session.ptyId)
      const ctx = me?.context
      if (!ctx?.ready) return
      const ratio = ctx.contextLimit ? ctx.contextTokens / ctx.contextLimit : 0
      meterChip.textContent = `${Math.round(ratio * 100)}% · ${ctx.messageCount} msgs`
      meterChip.setAttribute(
        'data-tone',
        ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warn' : 'accent'
      )
      if (me && ctx.title) title.textContent = ctx.title
    } catch {
      /* transient */
    }
  }, 6000)

  window.addEventListener('beforeunload', () => window.clearInterval(poll))
  window.addEventListener('resize', () => applyFit())
}

void showList()
