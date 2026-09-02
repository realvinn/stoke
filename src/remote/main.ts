import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './style.css'
import { createRecorder, postTranscription, voiceSupported } from '@shared/voice'

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
  /** The SSH host this runs on, or null for a local session. */
  host: string | null
  /** The process has ended; nothing more will ever arrive. */
  exited: boolean
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
  /*
   * A replaced key used to surface as "401 Unauthorized" on every screen with
   * nothing to do about it: the server's own sentence is only ever seen on a
   * top-level navigation, never through fetch. Say what happened and where the
   * new code is, once, in place of whatever screen was loading.
   */
  if (res.status === 401) {
    app.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        el('p', {}, 'This link’s key has been replaced.'),
        el('p', {}, 'On your computer, press the phone button in Stoke’s title bar and scan the new code.')
      )
    )
    throw new Error('Key replaced')
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as T
}

/* ---------------------------------------------------------------- theme */

/**
 * Paint the desktop's own theme. The stylesheet carries a fallback copy of one
 * palette that used to be the only palette, and drifted every time the desktop's
 * moved (CLAUDE.md gotcha 43); the server now serves the live one, and this
 * writes it onto :root with the same camelCase -> kebab rule the desktop uses.
 */
interface RemoteTheme {
  appearance: 'dark' | 'light'
  colors: Record<string, string>
  terminal: Record<string, string>
  fontFamily: string
}

let theme: RemoteTheme | null = null

async function loadTheme(): Promise<RemoteTheme | null> {
  try {
    theme = await api<RemoteTheme>('/api/theme')
  } catch {
    return theme
  }
  const root = document.documentElement
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, value)
  }
  root.style.colorScheme = theme.appearance
  root.dataset.appearance = theme.appearance
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
  if (meta) meta.content = theme.colors.bgSunken ?? theme.colors.bg
  return theme
}

/* --------------------------------------------------------- session list */

async function showList(): Promise<void> {
  app.replaceChildren()

  const refresh = el('button', { class: 'btn', title: 'Refresh' }, '↻')
  const history = el('button', { class: 'btn' }, 'History')
  const create = el('button', { class: 'btn', 'data-variant': 'primary' }, '+ New')
  /*
   * Name the machine. With one desktop this is noise; with a laptop and a
   * desktop behind similar bookmarks the two are indistinguishable, and it is
   * entirely possible to start work on the wrong computer without noticing.
   */
  const machine = el('span', { class: 'machine' }, '')
  void fetch('/api/host')
    .then((r) => (r.ok ? r.json() : null))
    .then((h) => {
      if (h?.machine) machine.textContent = String(h.machine).toLowerCase()
    })
    .catch(() => {
      /* a missing name is better than a wrong one */
    })

  const bar = el(
    'div',
    { class: 'bar' },
    el('h1', {}, 'Stoke'),
    machine,
    el('div', { class: 'spacer' }),
    refresh,
    history,
    create
  )
  const scroll = el('div', { class: 'scroll' })
  app.append(bar, scroll)

  /*
   * Refresh on a timer while this screen is up and visible. A session started
   * or ended on the desktop used to be invisible until the ↻ button. Cleared
   * by every route away from here, or the list would reload under the terminal.
   */
  const timer = window.setInterval(() => {
    if (document.visibilityState === 'visible') void load(true)
  }, 5000)
  const leave = (next: () => Promise<void>): void => {
    window.clearInterval(timer)
    void next()
  }
  refresh.addEventListener('click', () => void load())
  history.addEventListener('click', () => leave(showHistory))
  create.addEventListener('click', () => leave(showNew))

  async function load(quiet = false): Promise<void> {
    if (!quiet) scroll.replaceChildren(el('div', { class: 'empty' }, 'Loading…'))
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
      { class: 'card', 'data-exited': s.exited ? 'true' : undefined, onclick: () => leave(() => showTerminal(s)) },
      el(
        'div',
        { class: 'card-title' },
        ctx?.title || s.name,
        ...(s.host ? [el('span', { class: 'chip chip-inline mono' }, 'ssh')] : []),
        ...(s.exited ? [el('span', { class: 'chip chip-inline', 'data-tone': 'warn' }, 'ended')] : [])
      ),
      // An SSH session's cwd is the LOCAL folder Stoke was pointed at, which
      // says nothing about where it runs; the host is the honest line.
      el('div', { class: 'card-sub' }, s.host ? `ssh ${s.host}` : s.cwd),
      el(
        'div',
        { class: 'card-meta' },
        el('span', {}, ago(s.startedAt)),
        meter,
        el(
          'span',
          {},
          s.exited
            ? 'ended'
            : ctx?.ready
              ? `${compact(ctx.contextTokens)}/${compact(ctx.contextLimit)}`
              : 'idle'
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
        const started = await api<{ ptyId: string; sessionId: string }>('/api/sessions', {
          method: 'POST',
          body: JSON.stringify({ cwd })
        })
        // Straight into the session, the way Resume already does, after the
        // CLI has had a moment to print its banner. It used to return to the
        // list and leave the tap to the user.
        setTimeout(
          () =>
            void showTerminal({
              ptyId: started.ptyId,
              sessionId: started.sessionId,
              cwd,
              name: folderName(cwd),
              host: null,
              exited: false,
              startedAt: Date.now(),
              cols: 100,
              rows: 30,
              context: null
            }),
          1200
        )
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
            host: null,
            exited: false,
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
  /*
   * The row is wider than any phone, so it scrolls sideways. The wrapper exists
   * only to hang the edge fades on: they have to be painted over the keys, and
   * a pseudo-element on the scroller itself would scroll away with them.
   */
  const keyRow = el('div', { class: 'key-row' }, keys)
  app.append(keyRow)

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
   *
   * Claude Code has its own /voice with hold-space, but it records on the
   * machine running the CLI — which over the tunnel is the desktop, in another
   * room. Typing /voice here would hold open a microphone nobody is near, so
   * the command is intercepted and answered with the phone's own microphone
   * instead, keeping the same gesture.
   */
  const composer = el('div', { class: 'composer' }, input, send)
  /** Set by the voice block below; lets submit() intercept /voice. */
  let toggleVoiceMode: (() => void) | null = null
  /** Unbinds the hold-space handlers when this screen goes away. */
  let cleanupVoice: (() => void) | null = null
  if (voiceSupported()) {
    const mic = el('button', { class: 'mic', title: 'Hold to dictate' }, '🎙')
    const recorder = createRecorder(postTranscription)

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

    /*
     * Voice mode, matching the CLI's gesture: hold space to speak, escape to
     * leave. Space cannot be bound globally without it — it is an ordinary
     * keystroke the TUI needs — so this is opt-in and clearly signposted while
     * it is on.
     */
    const banner = el('div', { class: 'voice-banner' }, 'hold space to speak · esc to exit')
    let voiceOn = false

    const setVoiceMode = (on: boolean): void => {
      voiceOn = on
      document.body.classList.toggle('voice-on', on)
      if (on) {
        composer.before(banner)
        // Space must not land in the textarea while it means "talk".
        input.blur()
        term.blur()
      } else {
        banner.remove()
        recorder.cancel()
        setState('idle')
      }
    }
    toggleVoiceMode = () => setVoiceMode(!voiceOn)

    const onKeyDown = (e: KeyboardEvent): void => {
      if (!voiceOn) return
      if (e.key === 'Escape') {
        setVoiceMode(false)
        return
      }
      if (e.code !== 'Space' || e.repeat) return
      void begin(e)
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (!voiceOn || e.code !== 'Space') return
      void end(e)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    // Registered on the socket further down, once it exists. Without this the
    // handlers outlive the screen and holding space on the session list starts
    // recording into a terminal that is no longer there.
    cleanupVoice = () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('keyup', onKeyUp)
      setVoiceMode(false)
    }

    composer.insertBefore(mic, send)
  }
  app.append(composer)

  /*
   * The desktop's own palette, including all sixteen ANSI slots, so the CLI's
   * colours on the phone are the CLI's colours on the desk. This used to be
   * four hardcoded pre-ladder Ember hexes and xterm's built-in ANSI defaults —
   * a different black from the page around it, and Ember for a Daylight user.
   */
  const t = theme ?? (await loadTheme())
  const term = new Terminal({
    fontFamily: t?.fontFamily || "'JetBrains Mono', 'SF Mono', Menlo, monospace",
    fontSize: 11,
    lineHeight: 1.2,
    cursorBlink: false,
    // The desktop drives the real size; scrollback is what matters here.
    scrollback: 5000,
    convertEol: false,
    theme: t?.terminal ?? {}
  })
  const fitAddon = new FitAddon()
  term.loadAddon(fitAddon)
  term.open(wrap)

  /*
   * The socket, and the machinery that brings it back.
   *
   * iOS Safari drops a WebSocket seconds after the app is backgrounded, and
   * before this the only handling was a "Disconnected" toast: every return to
   * the phone showed a terminal that no longer updated and a composer whose
   * sends silently went nowhere. The server replays the full history on every
   * attach, so reconnecting is cheap; `term.reset()` first, or the replay
   * lands on top of what is already there.
   */
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  const wsUrl = `${proto}://${location.host}/ws?ptyId=${encodeURIComponent(session.ptyId)}`
  const linkChip = el('span', { class: 'chip', 'data-tone': 'warn' }, 'reconnecting…')
  linkChip.hidden = true
  let ws!: WebSocket
  let userClosed = false
  let backoff = 1000
  let retry: ReturnType<typeof setTimeout> | null = null
  let ever = false
  const wsBind: ((socket: WebSocket) => void)[] = []
  const connect = (): void => {
    if (userClosed) return
    if (retry) {
      clearTimeout(retry)
      retry = null
    }
    const socket = new WebSocket(wsUrl)
    ws = socket
    socket.addEventListener('open', () => {
      backoff = 1000
      linkChip.hidden = true
      if (ever) term.reset()
      ever = true
    })
    socket.addEventListener('close', () => {
      if (userClosed || ws !== socket) return
      linkChip.hidden = false
      retry = setTimeout(connect, backoff)
      backoff = Math.min(backoff * 2, 10_000)
    })
    for (const bind of wsBind) bind(socket)
  }
  const onSocket = (bind: (socket: WebSocket) => void): void => {
    wsBind.push(bind)
    bind(ws)
  }
  fitBtn.before(linkChip)
  connect()
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !userClosed && ws.readyState !== WebSocket.OPEN) connect()
  })

  /** Everything to undo when the user leaves this screen. */
  const onLeave: (() => void)[] = []

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
    onLeave.push(() => observer.disconnect())
  }

  onLeave.push(() => cleanupVoice?.())

  fitBtn.addEventListener('click', () => {
    fit = !fit
    localStorage.setItem(FIT_KEY, fit ? '1' : '0')
    fitBtn.setAttribute('aria-pressed', String(fit))
    applyFit()
    if (!fit) toast('Showing the desktop layout. Scroll sideways.')
    else toast('Resized to this screen — the desktop terminal reflows too.')
  })

  onSocket((socket) => socket.addEventListener('message', (ev) => {
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
      // Nothing more will come, so there is nothing to reconnect to.
      userClosed = true
    }
  }))

  const write = (data: string): void => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data }))
    else toast('Reconnecting — try again in a moment')
  }

  const submit = (): void => {
    const value = input.value
    if (!value.trim()) return

    /*
     * /voice is answered here rather than sent on. The CLI would take it and
     * open the microphone on the desktop, which over the tunnel is a machine
     * nobody is sitting at; the phone's microphone is the one in the room.
     */
    if (value.trim() === '/voice' && toggleVoiceMode) {
      toggleVoiceMode()
      input.value = ''
      input.style.height = 'auto'
      return
    }

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

  /*
   * The TUI needs these and a phone keyboard has none of them.
   *
   * Ordered by how often a thumb reaches for one, because only the first six
   * fit across a 390px screen and the rest have to be scrolled to. esc, enter,
   * the arrows and shift-tab are the whole vocabulary of answering a permission
   * prompt and cycling permission modes, so they lead; tab and ←/→ only matter
   * once you are editing the CLI's own input line rather than the composer,
   * which is the laptop case and the pager/REPL case.
   *
   * The arrows sit between esc and enter deliberately. Those two are reject and
   * accept on a permission prompt - the highest-traffic pair here - and putting
   * them side by side means one mistap inverts the answer. Both still land
   * above the fold.
   *
   * ctrl-l clears a screen that is only a few dozen rows tall here. ctrl-d is
   * handled separately below.
   */
  const KEYS: [string, string][] = [
    ['esc', '\x1b'],
    ['↑', '\x1b[A'],
    ['↓', '\x1b[B'],
    ['enter', '\r'],
    ['shift-tab', '\x1b[Z'],
    ['ctrl-c', '\x03'],
    ['tab', '\t'],
    ['←', '\x1b[D'],
    ['→', '\x1b[C'],
    ['ctrl-r', '\x12'],
    ['ctrl-l', '\x0c']
  ]
  for (const [label, seq] of KEYS) {
    keys.append(el('button', { class: 'key', onclick: () => write(seq) }, label))
  }

  /*
   * ctrl-d is the only way to send EOF - nothing else in this row can close a
   * REPL or a heredoc - but on an empty prompt it ends the session, and the
   * composer sends text+CR, so the prompt is empty essentially always.
   *
   * "Put it last so reaching it costs a scroll" does not hold: the row keeps
   * its scroll position, so after one legitimate scroll to ctrl-r this key sits
   * permanently under the thumb, styled like the harmless ones. That cost is
   * paid once, not per tap. So it arms on the first tap and fires on the
   * second, and disarms itself if the second never comes.
   */
  const eof = el('button', { class: 'key key-eof' }, 'ctrl-d')
  let armed: ReturnType<typeof setTimeout> | null = null
  const disarm = (): void => {
    if (armed) clearTimeout(armed)
    armed = null
    eof.classList.remove('armed')
    eof.textContent = 'ctrl-d'
    // The relabel changes the row's scrollWidth, so the fade has to re-measure.
    markOverflow()
  }
  let armedAt = 0
  eof.addEventListener('click', () => {
    if (armed) {
      // A double-tap is a mistap, not a decision - arming is worthless if the
      // second tap of one can fire it. Stay armed so a deliberate tap still works.
      if (Date.now() - armedAt < 350) return
      disarm()
      write('\x04')
      return
    }
    eof.classList.add('armed')
    eof.textContent = 'ctrl-d?'
    markOverflow()
    armedAt = Date.now()
    armed = setTimeout(disarm, 3000)
  })
  keys.append(eof)

  /*
   * Say which sides still have keys hidden behind them. The scrollbar is hidden
   * in CSS - mobile overlay scrollbars only appear once you are already
   * scrolling, so they never advertise anything - which left the row looking
   * like a complete set that happened to end at the screen edge. ctrl-r was
   * entirely off-screen on a phone and nothing hinted it was there.
   */
  const markOverflow = (): void => {
    const trailing = keys.scrollWidth - keys.clientWidth - keys.scrollLeft
    const start = keys.scrollLeft > 1
    const end = trailing > 1
    keyRow.dataset.more = start && end ? 'both' : start ? 'start' : end ? 'end' : 'none'
  }
  keys.addEventListener('scroll', markOverflow, { passive: true })
  // The row has no width until it is laid out; measuring now reports zero.
  requestAnimationFrame(markOverflow)
  /*
   * Scroll alone is not enough. Per the terminal's own fit logic above, the
   * soft keyboard and rotation resize elements on mobile without firing a
   * window resize, so watch the row itself. Rotating to landscape can fit every
   * key; without this the fade keeps claiming there are hidden ones.
   */
  if (typeof ResizeObserver !== 'undefined') {
    const keyObserver = new ResizeObserver(() => markOverflow())
    keyObserver.observe(keys)
    onLeave.push(() => keyObserver.disconnect())
  }

  back.addEventListener('click', () => {
    userClosed = true
    if (retry) clearTimeout(retry)
    ws.close()
    for (const fn of onLeave) fn()
    window.clearInterval(poll)
    term.dispose()
    void loadTheme().then(() => showList())
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
  window.addEventListener('resize', () => {
    applyFit()
    // Rotating changes how many keys fit, and so which edges have more behind them.
    markOverflow()
  })
}

/*
 * Boot.
 *
 * Two things happen before the first screen, and neither used to.
 *
 * The key is taken out of the address bar. It arrives as `?k=<token>` on the
 * first navigation and the server immediately parks it in a cookie so nothing
 * later needs it — but the URL kept carrying it, which put a live shell
 * credential in the phone's address bar, its history, its autocomplete, and any
 * screenshot or shared link of that page, permanently. `replaceState` drops it
 * the moment the cookie has been set (this document was served with it), which
 * is as early as it can go without breaking the exchange itself.
 *
 * And the theme is fetched for every screen rather than only the terminal.
 * `loadTheme` was called lazily from `showTerminal` and from the terminal's
 * back button, so the session list, history, transcript and new-session screens
 * painted the hand-copied Ember fallback in style.css no matter what the
 * desktop was actually running — with `color-scheme: dark` pinned along with
 * it, so on a light theme the keyboard and scrollbars came up wrong too.
 * Someone who only browsed history never saw the right theme at all. Awaited so
 * the first paint is already correct rather than repainting a beat later; a
 * failed fetch returns the fallback and the list still renders.
 */
async function boot(): Promise<void> {
  const here = new URL(window.location.href)
  if (here.searchParams.has('k')) {
    here.searchParams.delete('k')
    window.history.replaceState(null, '', `${here.pathname}${here.search}${here.hash}`)
  }
  await loadTheme()
  await showList()
}

void boot()
