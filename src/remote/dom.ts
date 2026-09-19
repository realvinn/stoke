/*
 * The phone UI's building blocks: a tiny DOM builder, the icon set, toasts
 * (announced to screen readers, PX-25) and the one sheet/modal component.
 * Every colour is a CSS custom property; nothing here names one.
 */

type Child = Node | string | null | undefined | false

/**
 * Tiny DOM builder. Props are loosely typed on purpose so dashed attributes
 * (`aria-pressed`, `data-level`) can sit alongside real element properties.
 * `on*` functions become listeners; pass `signal` in `listen` for cleanup.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue
    if (k === 'class') node.className = String(v)
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    } else if (k.includes('-') || k === 'role' || k === 'for') node.setAttribute(k, String(v))
    else (node as unknown as Record<string, unknown>)[k] = v
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c)
  return node
}

/* ---------------------------------------------------------------- icons */

/*
 * Stroke icons on a 24px grid (Lucide's geometry), drawn in currentColor so a
 * button's text colour is its icon colour. Inline so the shell stays one JS
 * file and one CSS file with no icon font to fetch.
 */
const ICONS: Record<string, string> = {
  back: 'M15 18l-6-6 6-6',
  plus: 'M12 5v14M5 12h14',
  history: 'M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  send: 'M12 19V5M5 12l7-7 7 7',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3',
  micOff: 'M2 2l20 20M18.9 13.9A7 7 0 0 0 19 12v-2M5 10v2a7 7 0 0 0 12 5M15 9.3V5a3 3 0 0 0-5.7-1.3M9 9v3a3 3 0 0 0 5.1 2.1M12 19v3',
  stop: 'M6 6h12v12H6z',
  close: 'M18 6L6 18M6 6l12 12',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  chevron: 'M9 18l6-6-6-6',
  folder: 'M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9l-.8-1.2A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z',
  terminal: 'M4 17l6-6-6-6M12 19h8',
  keyboard: 'M2 6h20v12H2zM6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  pin: 'M12 17v5M9 10.8V4h6v6.8l3 3.2H6z',
  retry: 'M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5',
  link: 'M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'
}

export function icon(name: keyof typeof ICONS | string, size = 20): SVGSVGElement {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(ns, 'path')
  path.setAttribute('d', ICONS[name] ?? '')
  svg.append(path)
  return svg
}

/** A 44px icon-only button with a real accessible name (PX-18, PX-25). */
export function iconButton(name: string, label: string, props: Record<string, unknown> = {}): HTMLButtonElement {
  return el('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label, ...props }, icon(name))
}

/* --------------------------------------------------------------- toasts */

let toastHost: HTMLElement | null = null

/** A short message, announced politely (the host is a live region). */
export function toast(message: string, tone: 'info' | 'error' = 'info'): void {
  if (!toastHost) {
    toastHost = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' })
    document.body.append(toastHost)
  }
  const node = el('div', { class: 'toast', 'data-tone': tone }, message)
  toastHost.append(node)
  setTimeout(() => node.remove(), 3200)
}

/* ---------------------------------------------------------------- sheet */

export interface Sheet {
  root: HTMLElement
  body: HTMLElement
  close: () => void
  setTitle: (text: string, back?: (() => void) | null) => void
}

/**
 * A bottom sheet on a phone, a centred modal from 768px up (CSS decides).
 * Escape and the scrim close it; focus moves in and comes back out.
 */
export function openSheet(opts: { title: string; label?: string; size?: 'full' | 'auto'; onClose?: () => void }): Sheet {
  const previous = document.activeElement as HTMLElement | null
  const titleText = el('h2', { class: 'sheet-title', id: `sheet-${Date.now()}` }, opts.title)
  const backSlot = el('div', { class: 'sheet-back' })
  const closeBtn = iconButton('close', 'Close')
  const body = el('div', { class: 'sheet-body' })
  const panel = el(
    'div',
    {
      class: 'sheet',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': titleText.id,
      'data-size': opts.size ?? 'auto',
      tabindex: '-1'
    },
    el('div', { class: 'sheet-grip', 'aria-hidden': 'true' }),
    el('header', { class: 'sheet-head' }, backSlot, titleText, closeBtn),
    body
  )
  const scrim = el('div', { class: 'scrim' })
  const root = el('div', { class: 'sheet-layer' }, scrim, panel)
  document.body.append(root)
  requestAnimationFrame(() => root.classList.add('open'))

  const ac = new AbortController()
  let closed = false
  const close = (): void => {
    if (closed) return
    closed = true
    ac.abort()
    root.classList.remove('open')
    setTimeout(() => root.remove(), 200)
    opts.onClose?.()
    previous?.focus?.()
  }
  scrim.addEventListener('click', close, { signal: ac.signal })
  // A sheet belongs to the screen it opened on: leaving the screen closes it.
  window.addEventListener('hashchange', close, { signal: ac.signal })
  closeBtn.addEventListener('click', close, { signal: ac.signal })
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    },
    { signal: ac.signal }
  )
  panel.focus({ preventScroll: true })

  const setTitle = (text: string, back?: (() => void) | null): void => {
    titleText.textContent = text
    backSlot.replaceChildren()
    if (back) {
      const b = iconButton('back', 'Back')
      b.addEventListener('click', back)
      backSlot.append(b)
    }
  }
  return { root, body, close, setTitle }
}

/** A confirmation as a small sheet; resolves true only on the primary button. */
export function confirmSheet(opts: { title: string; message: string; confirm: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false
    const sheet = openSheet({
      title: opts.title,
      onClose: () => {
        if (!answered) resolve(false)
      }
    })
    const yes = el('button', { type: 'button', class: 'btn', 'data-variant': opts.danger ? 'danger' : 'primary' }, opts.confirm)
    const no = el('button', { type: 'button', class: 'btn' }, 'Cancel')
    yes.addEventListener('click', () => {
      answered = true
      resolve(true)
      sheet.close()
    })
    no.addEventListener('click', () => sheet.close())
    sheet.body.append(el('p', { class: 'sheet-text' }, opts.message), el('div', { class: 'sheet-actions' }, no, yes))
    yes.focus()
  })
}

/** An explanation with one OK — the mic's "why not" (PX-6, PX-20). */
export function explain(title: string, message: string): void {
  const sheet = openSheet({ title })
  const ok = el('button', { type: 'button', class: 'btn', 'data-variant': 'primary' }, 'OK')
  ok.addEventListener('click', () => sheet.close())
  sheet.body.append(el('p', { class: 'sheet-text' }, message), el('div', { class: 'sheet-actions' }, ok))
  ok.focus()
}

/** Skeleton rows while something loads, rather than the word "Loading…". */
export function skeleton(count: number): HTMLElement {
  return el(
    'div',
    { class: 'skeletons', 'aria-busy': 'true', 'aria-label': 'Loading' },
    ...Array.from({ length: count }, () =>
      el('div', { class: 'skeleton' }, el('i', { class: 'sk-a' }), el('i', { class: 'sk-b' }), el('i', { class: 'sk-c' }))
    )
  )
}

/** A friendly failure with a Retry (PX-24: never "Failed to fetch"). */
export function failure(title: string, detail: string, retry: () => void): HTMLElement {
  const btn = el('button', { type: 'button', class: 'btn' }, icon('retry', 16), 'Try again')
  btn.addEventListener('click', retry)
  return el('div', { class: 'empty' }, el('p', { class: 'empty-title' }, title), el('p', { class: 'empty-text' }, detail), btn)
}

export function humanError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return 'Your computer did not answer. Is it awake, and is Stoke still running?'
  return msg
}
