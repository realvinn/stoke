/*
 * The session list: the phone's home screen and, from 1024px, the laptop's
 * left rail. Sections in attention order — Needs you, Working, Idle, Ended —
 * with a waiting session answerable from the list itself (audit PX-2, PX-12;
 * phone contract points 3 and 7).
 *
 * Rows are keyed and patched, never rebuilt wholesale: `/ws/events` pushes
 * every ~250ms while a session prints, and replacing a row under a thumb that
 * is mid-tap on one of its answer buttons eats the tap.
 */
import { Terminal } from '@xterm/xterm'
import { contextLevel, contextPercent } from '@shared/contextLevel'
import {
  GENERIC_ANSWERS,
  groupSessionRows,
  parseAnswerOptions,
  relativeTime,
  statusPill,
  type AnswerOption,
  type ParsedPrompt
} from '@shared/phoneUi'
import { api, folderName, wsUrl, type ApiError, type SessionRow } from './api'
import { el, toast } from './dom'

export function compact(n: number): string {
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** The context meter, in the desktop's four tiers (shared/contextLevel.ts). */
export function meterMini(used: number, limit: number | null): HTMLElement {
  if (!limit || limit <= 0) {
    return el('span', { class: 'meter-label' }, used > 0 ? `${compact(used)} tokens` : '')
  }
  const pct = contextPercent(used, limit)
  const ratio = used > 0 ? Math.min(1, used / limit) : 0
  const bar = el('span', { class: 'meter', 'data-level': contextLevel(pct), 'aria-hidden': 'true' })
  bar.append(el('i', { style: `transform: scaleX(${ratio})` }))
  return el(
    'span',
    { class: 'meter-wrap', title: `${compact(used)} of ${compact(limit)} tokens` },
    bar,
    el('span', { class: 'meter-label' }, `${pct}%`)
  )
}

export function pill(status: SessionRow['status'], waitingFor: string | null): HTMLElement {
  const p = statusPill(status, waitingFor)
  return el('span', { class: 'pill', 'data-tone': p.tone }, el('i', { 'aria-hidden': 'true' }), p.label)
}

export function rowTitle(r: SessionRow): string {
  return r.title || r.context?.title || (r.status === 'ended' ? 'Ended session' : 'New session')
}

function activity(r: SessionRow, now: number): string {
  if (r.status === 'ended') {
    const code = r.exitCode !== null && r.exitCode !== 0 ? ` · exit ${r.exitCode}` : ''
    return `ended ${relativeTime(r.endedAt, now)}${code}`
  }
  if (r.status === 'busy') return `working · ${relativeTime(r.lastActivityAt ?? r.startedAt, now).replace(' ago', '')}`
  return `active ${relativeTime(r.lastActivityAt ?? r.startedAt, now)}`
}

/* -------------------------------------------------------- reading a prompt */

/**
 * Keyed by pty AND prompt (`promptKey`): prompt B arriving within one poll of
 * prompt A used to keep showing A's question and labels, cached per pty until
 * the row stopped being `waiting` — and a tap then answered B while showing A.
 */
const prompts = new Map<string, Promise<ParsedPrompt | null>>()

const promptKey = (r: Pick<SessionRow, 'ptyId' | 'promptId'>): string => `${r.ptyId}\u0000${r.promptId ?? ''}`

/**
 * The options a waiting session is offering, read off its screen.
 *
 * The list has no terminal, so it attaches to the pty once, replays its history
 * into an xterm that is never opened (the parser runs without a renderer), reads
 * the bottom rows and leaves. Cached per pty while it stays waiting, so a
 * prompt costs one replay however many pushes arrive.
 */
function peekPrompt(r: SessionRow): Promise<ParsedPrompt | null> {
  const cached = prompts.get(promptKey(r))
  if (cached) return cached
  const job = new Promise<ParsedPrompt | null>((resolve) => {
    let done = false
    // `peek=1`: one replay and a close, never counted as a phone attached.
    const socket = new WebSocket(wsUrl(`/ws?ptyId=${encodeURIComponent(r.ptyId)}&peek=1`))
    const finish = (value: ParsedPrompt | null): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.close()
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), 6000)
    socket.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as { type: string; cols?: number; rows?: number; history?: string }
      if (msg.type !== 'attached') return
      const term = new Terminal({ cols: msg.cols ?? 100, rows: msg.rows ?? 30, scrollback: 0, allowProposedApi: true })
      term.write(msg.history ?? '', () => {
        const lines = screenLines(term)
        const cols = term.cols
        term.dispose()
        finish(parseAnswerOptions(lines, cols))
      })
    })
    socket.addEventListener('close', () => finish(null))
    socket.addEventListener('error', () => finish(null))
  })
  prompts.set(promptKey(r), job)
  return job
}

/** The visible screen of a terminal, top to bottom, trailing blanks trimmed. */
export function screenLines(term: Terminal): string[] {
  const buf = term.buffer.active
  const lines: string[] = []
  for (let y = buf.baseY; y < buf.baseY + term.rows; y++) {
    lines.push(buf.getLine(y)?.translateToString(true) ?? '')
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop()
  return lines
}

/**
 * POST one answer to the prompt `promptId` names; true when it landed.
 *
 * 409 is the server refusing a tap that could land somewhere unintended: the
 * session is no longer waiting, or the prompt on screen is not the one this
 * phone was shown, or someone typed into it since (`answerVerdict`).
 */
export async function sendAnswer(ptyId: string, key: string, promptId: string | null): Promise<boolean> {
  try {
    await api(`/api/sessions/${encodeURIComponent(ptyId)}/answer`, {
      method: 'POST',
      body: JSON.stringify({ key, promptId })
    })
    return true
  } catch (err) {
    const e = err as ApiError
    const why = (e.body as { error?: unknown } | null | undefined)?.error
    toast(
      e.status !== 409
        ? e.message
        : why === 'stale'
          ? 'That prompt changed or was answered on the computer. Check the new one before you tap.'
          : 'That prompt was already answered.',
      'error'
    )
    return false
  }
}

function answerLabel(o: AnswerOption): string {
  return o.label === o.key ? o.key : `${o.key} · ${o.label}`
}

/* ------------------------------------------------------------------- rows */

interface Mounted {
  node: HTMLElement
  sig: string
}

export interface SessionList {
  update: (rows: SessionRow[] | null, error?: unknown) => void
  setSelected: (ptyId: string | null) => void
  destroy: () => void
}

export function mountSessionList(
  container: HTMLElement,
  opts: {
    compact: boolean
    empty: () => HTMLElement
    failure: (err: unknown) => HTMLElement
    loading: () => HTMLElement
  }
): SessionList {
  const mounted = new Map<string, Mounted>()
  const headings = new Map<string, HTMLElement>()
  let selected: string | null = null
  let last: SessionRow[] | null = null
  let state: 'loading' | 'empty' | 'error' | 'rows' | null = null
  const list = el('div', { class: 'slist', 'data-compact': opts.compact ? 'true' : undefined })

  const heading = (id: string, label: string, count: number): HTMLElement => {
    let h = headings.get(id)
    if (!h) {
      h = el('h2', { class: 'section-head', 'data-section': id })
      headings.set(id, h)
    }
    h.replaceChildren(el('span', {}, label), el('span', { class: 'section-count' }, String(count)))
    return h
  }

  const build = (r: SessionRow, now: number): HTMLElement => {
    const where = r.host ? `ssh ${r.host}` : r.agentName && r.cli !== 'claude' ? r.agentName : null
    const main = el(
      'a',
      { class: 'srow-main', href: `#/s/${encodeURIComponent(r.ptyId)}` },
      el(
        'div',
        { class: 'srow-top' },
        el('span', { class: 'srow-project' }, r.project || folderName(r.cwd)),
        where ? el('span', { class: 'srow-where' }, where) : null,
        el('span', { class: 'srow-gap' }),
        pill(r.status, r.waitingFor)
      ),
      el('div', { class: 'srow-title' }, rowTitle(r)),
      el(
        'div',
        { class: 'srow-meta' },
        el('span', { class: 'srow-time' }, activity(r, now)),
        r.context?.ready ? meterMini(r.context.contextTokens, r.context.contextLimit) : null
      )
    )
    const node = el('article', { class: 'srow', 'data-status': r.status }, main)
    if (r.status === 'waiting') node.append(answers(r))
    return node
  }

  const answers = (r: SessionRow): HTMLElement => {
    const box = el('div', { class: 'srow-answers' })
    const question = el('div', { class: 'srow-question' })
    const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Answer' })
    const draw = (prompt: ParsedPrompt | null): void => {
      const options = (prompt?.options ?? GENERIC_ANSWERS).filter((o) => Number(o.key) <= 3)
      question.textContent = prompt?.question ?? ''
      question.hidden = !prompt?.question
      // Real labels are sentences: stack them, one full-width answer a row.
      chips.dataset.long = String(options.some((o) => o.label.length > 12))
      chips.replaceChildren(
        ...options.map((o, i) =>
          el(
            'button',
            {
              type: 'button',
              class: 'answer',
              'data-variant': i === 0 ? 'primary' : undefined,
              'aria-label': `Answer ${o.key}: ${o.label}`,
              onclick: (e: Event) => void answer(e.currentTarget as HTMLButtonElement, o.key)
            },
            answerLabel(o)
          )
        ),
        el(
          'button',
          {
            type: 'button',
            class: 'answer',
            'data-variant': 'quiet',
            'aria-label': 'Escape: cancel the prompt',
            onclick: (e: Event) => void answer(e.currentTarget as HTMLButtonElement, 'esc')
          },
          'Esc'
        )
      )
    }
    const answer = async (btn: HTMLButtonElement, key: string): Promise<void> => {
      for (const b of chips.querySelectorAll('button')) b.disabled = true
      btn.dataset.sending = 'true'
      const ok = await sendAnswer(r.ptyId, key, r.promptId)
      if (ok) {
        prompts.delete(promptKey(r))
        box.dataset.answered = 'true'
      } else {
        for (const b of chips.querySelectorAll('button')) b.disabled = false
        delete btn.dataset.sending
      }
    }
    draw(null)
    void peekPrompt(r).then((p) => {
      if (p && box.isConnected && !box.dataset.answered) draw(p)
    })
    box.append(question, chips)
    return box
  }

  /** What a row shows, as a string: a row is rebuilt only when this changes. */
  const signature = (r: SessionRow, now: number): string =>
    JSON.stringify([
      r.status,
      r.waitingFor,
      r.promptId,
      r.project,
      r.title,
      r.context?.title,
      r.context?.ready ? contextPercent(r.context.contextTokens, r.context.contextLimit) : null,
      r.host,
      r.agentName,
      activity(r, now),
      r.exitCode
    ])

  const render = (): void => {
    const rows = last ?? []
    const now = Date.now()
    const seen = new Set<string>()
    const ordered: HTMLElement[] = []
    for (const section of groupSessionRows(rows)) {
      ordered.push(heading(section.id, section.label, section.rows.length))
      for (const r of section.rows) {
        seen.add(r.ptyId)
        const sig = signature(r, now)
        let m = mounted.get(r.ptyId)
        if (!m || m.sig !== sig) {
          const node = build(r, now)
          if (m) m.node.replaceWith(node)
          m = { node, sig }
          mounted.set(r.ptyId, m)
        }
        m.node.toggleAttribute('data-selected', r.ptyId === selected)
        if (r.ptyId === selected) m.node.querySelector('a')?.setAttribute('aria-current', 'page')
        else m.node.querySelector('a')?.removeAttribute('aria-current')
        ordered.push(m.node)
      }
    }
    for (const [id, m] of mounted) {
      if (!seen.has(id)) {
        m.node.remove()
        mounted.delete(id)
      }
    }
    // Drop every cached prompt that is no longer the one its row shows.
    const current = new Set(rows.filter((r) => r.status === 'waiting').map(promptKey))
    for (const k of [...prompts.keys()]) if (!current.has(k)) prompts.delete(k)
    // Reorder only when the order actually changed, so focus is not disturbed.
    const children = [...list.children]
    if (children.length !== ordered.length || children.some((n, i) => n !== ordered[i])) {
      list.replaceChildren(...ordered)
    }
  }

  const tick = setInterval(() => {
    if (state === 'rows') render()
  }, 30_000)

  const update = (rows: SessionRow[] | null, error?: unknown): void => {
    last = rows
    let next: typeof state
    if (rows === null) next = error ? 'error' : 'loading'
    else if (rows.length === 0) next = 'empty'
    else next = 'rows'
    if (next !== state) {
      state = next
      if (next === 'loading') container.replaceChildren(opts.loading())
      else if (next === 'error') container.replaceChildren(opts.failure(error))
      else if (next === 'empty') container.replaceChildren(opts.empty())
      else container.replaceChildren(list)
    }
    if (next === 'rows') render()
  }

  return {
    update,
    setSelected: (ptyId) => {
      selected = ptyId
      if (state === 'rows') render()
    },
    destroy: () => clearInterval(tick)
  }
}
