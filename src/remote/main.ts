import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import { createRecorder, voiceSupported } from './voice'

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
  const history = el('button', { class: 'btn' }, 'History')
  const create = el('button', { class: 'btn', 'data-variant': 'primary' }, '+ New')
  const bar = el(
    'div',
    { class: 'bar' },
    el('h1', {}, 'Stoke'),
    el('div', { class: 'spacer' }),
    refresh,
    history,
    create
  )
  const scroll = el('div', { class: 'scroll' })
  app.append(bar, scroll)

  refresh.addEventListener('click', () => void load())
  history.addEventListener('click', () => void showHistory())
  create.addEventListener('click', () => void showNew())

  async function load(): Promise<void> {
    scroll.replaceChildren(el('div', { class: 'empty' }, 'Loading…'))
    try {
      const sessions = await api<SessionRow[]>('/api/sessions')
      if (!sessions.length) {
        /*
         * This list is live processes only, so an idle desktop makes it empty.
         * That read as "there is nothing here" when in fact every past
         * conversation was one tap away, so the empty state now says where.
         */
        const toHistory = el('button', { class: 'btn', 'data-variant': 'primary' }, 'Open history')
        toHistory.addEventListener('click', () => void showHistory())
        scroll.replaceChildren(
          el(
            'div',
            { class: 'empty' },
            el('p', {}, 'Nothing is running on your machine right now.'),
            el('p', {}, 'Your past conversations are still here — open one and resume it.'),
            toHistory
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

/* --------------------------------------------------------------- history */

/*
 * Past sessions, which is what someone opening this on their phone is usually
 * after. The live list only ever showed sessions running on the desktop at that
 * moment; everything done earlier lives in Claude Code's own transcripts, and
 * until now nothing here could reach them.
 */

interface SessionMetaRow {
  id: string
  projectPath: string
  title: string | null
  firstPrompt: string | null
  modified: number
  messageCount: number
  model: string | null
  contextTokens: number
  contextLimit: number
  gitBranch: string | null
}

interface TurnRow {
  role: 'user' | 'assistant'
  text: string
  tools: string[]
  at: number | null
}

const folderName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

async function showHistory(): Promise<void> {
  app.replaceChildren()
  const back = el('button', { class: 'btn' }, '‹')
  app.append(el('div', { class: 'bar' }, back, el('h1', {}, 'History')))
  const scroll = el('div', { class: 'scroll' })
  app.append(scroll)
  back.addEventListener('click', () => void showList())

  scroll.replaceChildren(el('div', { class: 'empty' }, 'Loading projects…'))
  try {
    const data = await api<{
      projects: { path: string; name: string; sessionCount: number; lastModified: number | null }[]
    }>('/api/projects')

    const withHistory = data.projects.filter((p) => p.sessionCount > 0)
    if (!withHistory.length) {
      scroll.replaceChildren(el('div', { class: 'empty' }, 'No past sessions found on this machine.'))
      return
    }

    scroll.replaceChildren(
      ...withHistory.map((p) =>
        el(
          'button',
          { class: 'card', onclick: () => void showProjectHistory(p.path, p.name) },
          el('div', { class: 'card-title' }, p.name),
          el('div', { class: 'card-sub' }, p.path),
          el(
            'div',
            { class: 'card-meta' },
            el('span', {}, `${p.sessionCount} session${p.sessionCount === 1 ? '' : 's'}`),
            el('span', {}, p.lastModified ? ago(p.lastModified) : '')
          )
        )
      )
    )
  } catch (err) {
    scroll.replaceChildren(el('div', { class: 'empty' }, (err as Error).message))
  }
}

async function showProjectHistory(cwd: string, name: string): Promise<void> {
  app.replaceChildren()
  const back = el('button', { class: 'btn' }, '‹')
  app.append(el('div', { class: 'bar' }, back, el('h1', {}, name)))
  const scroll = el('div', { class: 'scroll' })
  app.append(scroll)
  back.addEventListener('click', () => void showHistory())

  scroll.replaceChildren(el('div', { class: 'empty' }, 'Loading sessions…'))
  try {
    const data = await api<{ sessions: SessionMetaRow[] }>(
      `/api/history?cwd=${encodeURIComponent(cwd)}`
    )
    if (!data.sessions.length) {
      scroll.replaceChildren(el('div', { class: 'empty' }, 'No transcripts for this project.'))
      return
    }
    scroll.replaceChildren(
      ...data.sessions.map((s) => {
        const ratio = s.contextLimit ? Math.min(1, s.contextTokens / s.contextLimit) : 0
        const meter = el('div', {
          class: 'meter',
          'data-level': ratio >= 0.9 ? 'critical' : ratio >= 0.7 ? 'warn' : 'ok'
        })
        meter.append(el('i', { style: `transform: scaleX(${ratio})` }))
        return el(
          'button',
          { class: 'card', onclick: () => void showTranscript(s) },
          el('div', { class: 'card-title' }, s.title || s.firstPrompt || 'Untitled session'),
          el(
            'div',
            { class: 'card-meta' },
            el('span', {}, ago(s.modified)),
            el('span', {}, `${s.messageCount} msg`),
            meter,
            el('span', {}, s.gitBranch || '')
          )
        )
      })
    )
  } catch (err) {
    scroll.replaceChildren(el('div', { class: 'empty' }, (err as Error).message))
  }
}

async function showTranscript(meta: SessionMetaRow): Promise<void> {
  app.replaceChildren()
  const back = el('button', { class: 'btn' }, '‹')
  const resumeBtn = el('button', { class: 'btn', 'data-variant': 'primary' }, 'Resume')
  app.append(
    el(
      'div',
      { class: 'bar' },
      back,
      el('h1', {}, meta.title || folderName(meta.projectPath)),
      el('div', { class: 'spacer' }),
      resumeBtn
    )
  )
  const scroll = el('div', { class: 'scroll' })
  app.append(scroll)
  back.addEventListener('click', () => void showProjectHistory(meta.projectPath, folderName(meta.projectPath)))

  /*
   * Resuming hands the session back to a real CLI process rather than replaying
   * it: --resume is what Claude Code itself uses, so the conversation continues
   * with its full context instead of starting again from a summary.
   */
  resumeBtn.addEventListener('click', () => {
    void (async () => {
      resumeBtn.textContent = 'Resuming…'
      try {
        const started = await api<{ ptyId: string; sessionId: string }>('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ cwd: meta.projectPath, sessionId: meta.id, resume: true })
        })
        // The CLI needs a moment to replay the transcript and print its banner.
        setTimeout(() => {
          void showTerminal({
            ptyId: started.ptyId,
            sessionId: started.sessionId,
            cwd: meta.projectPath,
            name: meta.title || folderName(meta.projectPath),
            startedAt: Date.now(),
            cols: 100,
            rows: 30,
            context: null
          })
        }, 1600)
      } catch (err) {
        resumeBtn.textContent = 'Resume'
        toast((err as Error).message)
      }
    })()
  })

  scroll.replaceChildren(el('div', { class: 'empty' }, 'Loading conversation…'))
  try {
    const data = await api<{ turns: TurnRow[]; total: number; truncated: boolean }>(
      `/api/transcript?id=${encodeURIComponent(meta.id)}`
    )
    if (!data.turns.length) {
      scroll.replaceChildren(el('div', { class: 'empty' }, 'This transcript has no readable turns.'))
      return
    }

    const nodes: HTMLElement[] = []
    if (data.truncated) {
      nodes.push(
        el(
          'div',
          { class: 'note' },
          `Showing the last ${data.turns.length} of ${data.total} messages.`
        )
      )
    }
    for (const turn of data.turns) {
      const body = el('div', { class: 'turn-body' })
      if (turn.text) body.append(el('div', { class: 'turn-text' }, turn.text))
      if (turn.tools.length) {
        body.append(
          el('div', { class: 'turn-tools' }, turn.tools.map((t) => `⚙ ${t}`).join('  '))
        )
      }
      nodes.push(
        el(
          'div',
          { class: 'turn', 'data-role': turn.role },
          el(
            'div',
            { class: 'turn-head' },
            el('span', {}, turn.role === 'user' ? 'You' : 'Claude'),
            el('span', {}, turn.at ? ago(turn.at) : '')
          ),
          body
        )
      )
    }
    scroll.replaceChildren(...nodes)
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
  /*
   * Fit to the screen unless explicitly turned off. This used to default to off,
   * which meant a first visit rendered the desktop's fixed grid - a small panel
   * parked in the top-left of a much larger scrollable area - and looked broken.
   * Showing the desktop layout is the deliberate choice, not the default one.
   */
  let fit = localStorage.getItem(FIT_KEY) !== '0'
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

  /*
   * Push-to-talk. The transcript lands in the textarea rather than being sent,
   * because dictation mishears and a prompt you cannot correct before it runs
   * is worse than typing it.
   */
  const composer = el('div', { class: 'composer' }, input, send)
  if (voiceSupported()) {
    const mic = el('button', { class: 'mic', title: 'Hold to dictate' }, '🎙')
    const recorder = createRecorder()

    const setState = (state: 'idle' | 'recording' | 'working', label?: string): void => {
      mic.dataset.state = state
      mic.textContent = state === 'recording' ? '●' : state === 'working' ? '…' : '🎙'
      if (label) input.placeholder = label
      else input.placeholder = 'Message Claude…'
      mic.disabled = state === 'working'
    }

    const begin = async (e: Event): Promise<void> => {
      e.preventDefault()
      if (recorder.recording()) return
      try {
        await recorder.start()
        setState('recording', 'Listening…')
      } catch {
        setState('idle')
        input.placeholder = 'Microphone blocked — allow access and retry'
      }
    }

    const end = async (e: Event): Promise<void> => {
      e.preventDefault()
      if (!recorder.recording()) return
      setState('working', 'Transcribing…')
      try {
        const text = await recorder.finish()
        setState('idle')
        if (text) {
          input.value = input.value ? `${input.value.replace(/\s*$/, '')} ${text}` : text
          input.focus()
          input.dispatchEvent(new Event('input'))
        }
      } catch (err) {
        setState('idle')
        input.placeholder = err instanceof Error ? err.message.slice(0, 60) : 'Transcription failed'
      }
    }

    // Pointer events cover touch and mouse without a second code path.
    mic.addEventListener('pointerdown', begin)
    mic.addEventListener('pointerup', end)
    mic.addEventListener('pointerleave', end)
    mic.addEventListener('pointercancel', (e) => {
      e.preventDefault()
      recorder.cancel()
      setState('idle')
    })
    // Holding a button on iOS otherwise raises the selection callout.
    mic.addEventListener('contextmenu', (e) => e.preventDefault())

    composer.insertBefore(mic, send)
  }
  app.append(composer)

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
      // The socket is not open on the first fit, and an unguarded send throws
      // into the catch below - which would silently swallow real fit errors.
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows, force: true }))
      }
    } catch {
      /* not laid out yet */
    }
  }

  /*
   * Type straight into the terminal.
   *
   * This was deliberately left unwired - a soft keyboard fighting a TUI is
   * miserable, so the composer below was the only way in. But that also meant
   * clicking the terminal on a laptop did nothing, which is what everyone
   * expects to work. Both now: keystrokes go through when the terminal has
   * focus, and the composer stays for phones.
   */
  term.onData((data) => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }))
  })

  /*
   * Fit once the wrapper actually has a box. Calling fit() straight after
   * open() measures a zero-height element and produces a minimum-size grid.
   */
  requestAnimationFrame(() => applyFit())

  /*
   * The soft keyboard and rotation resize the container without firing a
   * window resize event on mobile, so watch the element itself.
   */
  if (typeof ResizeObserver !== 'undefined') {
    let queued = false
    const observer = new ResizeObserver(() => {
      if (queued) return
      queued = true
      requestAnimationFrame(() => {
        queued = false
        applyFit()
      })
    })
    observer.observe(wrap)
    ws.addEventListener('close', () => observer.disconnect())
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
