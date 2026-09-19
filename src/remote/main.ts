import './style.css'
import { AuthError, loadHost, loadTheme, machineName, setAuthFailureHandler, showMachine, host } from './api'
import { mountConnect } from './connect'
import { el, failure, humanError, icon, iconButton, skeleton } from './dom'
import { mountHistory, mountProjectHistory, mountTranscript, type Page } from './history'
import { mountSessionList, type SessionList } from './list'
import { openNewSession } from './newSession'
import { mountSession } from './session'
import { store } from './store'

/**
 * Stoke on a phone — and in a laptop's browser.
 *
 * Screens: Connect (no key), Sessions (home), Session (terminal), New session
 * (a sheet), History. Below 1024px it is one screen at a time; from 1024px it
 * is a real two-pane layout — the session list as a 320px rail and the session
 * beside it at the pty's own size — rather than a phone stretched to 1440px
 * (audit PX-16). Routes live in the hash, so the browser's and Android's back
 * gestures work and a reload lands where you were.
 */

const app = document.getElementById('app') as HTMLDivElement
const wideQuery = matchMedia('(min-width: 1024px)')

type Route =
  | { name: 'home' }
  | { name: 'session'; ptyId: string }
  | { name: 'history' }
  | { name: 'project'; cwd: string }
  | { name: 'transcript'; id: string; cwd: string }

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').map((p) => decodeURIComponent(p))
  if (parts[0] === 's' && parts[1]) return { name: 'session', ptyId: parts[1] }
  if (parts[0] === 'history') {
    if (parts[1] === 'p' && parts[2]) return { name: 'project', cwd: parts[2] }
    if (parts[1] === 't' && parts[2] && parts[3]) return { name: 'transcript', id: parts[2], cwd: parts[3] }
    return { name: 'history' }
  }
  return { name: 'home' }
}

/* ------------------------------------------------------------------ chrome */

function brand(): HTMLElement {
  return el(
    'div',
    { class: 'brand' },
    el('img', { class: 'brand-mark', src: './icon-192.png', alt: '', width: 26, height: 26 }),
    el('span', { class: 'brand-name' }, 'Stoke'),
    showMachine() && host ? el('span', { class: 'machine', title: host.machine }, host.machine) : null
  )
}

function topbarActions(): HTMLElement[] {
  const history = iconButton('history', 'History')
  history.addEventListener('click', () => (location.hash = '#/history'))
  const create = iconButton('plus', 'New session', { class: 'icon-btn', 'data-variant': 'primary' })
  create.addEventListener('click', () => openNewSession())
  return [history, create]
}

/** The global "can't reach your computer" strip, driven by the session store. */
function linkStrip(): HTMLElement {
  const strip = el('div', { class: 'link-strip', role: 'status', hidden: true })
  const paint = (): void => {
    const down = store.link === 'down'
    strip.hidden = !down
    if (down) {
      strip.replaceChildren(
        el('i', { class: 'spinner', 'aria-hidden': 'true' }),
        el('span', {}, `Can't reach ${machineName()} — retrying. If Phone access was turned off, turn it back on in Stoke.`)
      )
    }
  }
  paint()
  const off = store.subscribe(paint)
  strip.addEventListener('stoke:destroy', () => off())
  return strip
}

function emptyState(): HTMLElement {
  const start = el('button', { type: 'button', class: 'btn', 'data-variant': 'primary' }, icon('plus', 18), 'Start a session')
  start.addEventListener('click', () => openNewSession())
  const hist = el('a', { class: 'btn', href: '#/history' }, icon('history', 18), 'Resume from history')
  return el(
    'div',
    { class: 'empty' },
    el('div', { class: 'empty-mark', 'aria-hidden': 'true' }, icon('terminal', 28)),
    el('p', { class: 'empty-title' }, `Nothing running on ${machineName()}`),
    el('p', { class: 'empty-text' }, 'Start a new session, or pick up a past conversation where you left it.'),
    el('div', { class: 'empty-actions' }, start, hist)
  )
}

function mountList(container: HTMLElement, compact: boolean): SessionList {
  const list = mountSessionList(container, {
    compact,
    empty: emptyState,
    loading: () => skeleton(compact ? 4 : 3),
    failure: (err) => failure(`Can't reach ${machineName()}`, humanError(err), () => void store.refresh())
  })
  list.update(store.rows, store.error)
  const off = store.subscribe(() => list.update(store.rows, store.error))
  return {
    ...list,
    destroy: () => {
      off()
      list.destroy()
    }
  }
}

/* -------------------------------------------------------------- screens */

interface Mounted {
  root: HTMLElement
  destroy: () => void
}

function mountHome(): Mounted {
  const body = el('div', { class: 'content' })
  const strip = linkStrip()
  const root = el(
    'section',
    { class: 'page home' },
    el('header', { class: 'topbar' }, brand(), el('span', { class: 'spacer' }), ...topbarActions()),
    strip,
    el('main', { class: 'scroll', 'aria-label': 'Sessions' }, body)
  )
  const list = mountList(body, false)
  return {
    root,
    destroy: () => {
      list.destroy()
      strip.dispatchEvent(new Event('stoke:destroy'))
    }
  }
}

function mountRoute(route: Route, wide: boolean): Mounted {
  switch (route.name) {
    case 'session': {
      const s = mountSession(route.ptyId, { wide, onBack: () => (location.hash = '#/') })
      return s
    }
    case 'history':
      return mountHistory() as Page
    case 'project':
      return mountProjectHistory(route.cwd)
    case 'transcript':
      return mountTranscript(route.id, route.cwd)
    default:
      return wide ? mountPlaceholder() : mountHome()
  }
}

/** The laptop pane with nothing picked: point at what needs you. */
function mountPlaceholder(): Mounted {
  const box = el('div', { class: 'placeholder' })
  const paint = (): void => {
    const rows = store.rows
    if (rows && rows.length === 0) {
      box.replaceChildren(emptyState())
      return
    }
    const waiting = rows?.filter((r) => r.status === 'waiting').length ?? 0
    box.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        el('div', { class: 'empty-mark', 'aria-hidden': 'true' }, icon('terminal', 28)),
        el('p', { class: 'empty-title' }, waiting ? `${waiting} ${waiting === 1 ? 'session needs' : 'sessions need'} you` : 'Pick a session'),
        el('p', { class: 'empty-text' }, `Everything running on ${machineName()} is on the left. Answer a prompt right there, or open a session to watch it.`)
      )
    )
  }
  paint()
  const off = store.subscribe(paint)
  return { root: el('section', { class: 'page' }, box), destroy: off }
}

/* ---------------------------------------------------------------- router */

let current: Mounted | null = null
let currentKey = ''
let rail: { root: HTMLElement; list: SessionList; pane: HTMLElement; strip: HTMLElement } | null = null
let connectMode = false

function teardown(): void {
  current?.destroy()
  current = null
  currentKey = ''
  if (rail) {
    rail.list.destroy()
    rail.strip.dispatchEvent(new Event('stoke:destroy'))
    rail = null
  }
}

function render(): void {
  if (connectMode) return
  const route = parseRoute(location.hash)
  const wide = wideQuery.matches
  const key = `${wide}|${JSON.stringify(route)}`
  if (key === currentKey) return

  if (wide) {
    if (!rail) {
      teardown()
      const listBox = el('div', { class: 'rail-list' })
      const strip = linkStrip()
      const pane = el('div', { class: 'pane' })
      const aside = el(
        'aside',
        { class: 'rail', 'aria-label': 'Sessions' },
        el('header', { class: 'topbar' }, brand(), el('span', { class: 'spacer' }), ...topbarActions()),
        strip,
        el('nav', { class: 'rail-scroll', 'aria-label': 'Running sessions' }, listBox)
      )
      app.replaceChildren(el('div', { class: 'split' }, aside, el('main', { class: 'pane-wrap' }, pane)))
      rail = { root: aside, list: mountList(listBox, true), pane, strip }
    }
    current?.destroy()
    current = mountRoute(route, true)
    rail.pane.replaceChildren(current.root)
    rail.list.setSelected(route.name === 'session' ? route.ptyId : null)
  } else {
    teardown()
    current = mountRoute(route, false)
    app.replaceChildren(current.root)
  }
  currentKey = key
  if (route.name !== 'session') document.title = 'Stoke'
}

function showConnect(): void {
  if (connectMode) return
  connectMode = true
  store.stop()
  teardown()
  document.title = 'Connect · Stoke'
  app.replaceChildren(mountConnect({ linkKey: openedWithKey }))
}

/*
 * Boot.
 *
 * The key is taken out of the address bar first. It arrives as `?k=<token>` and
 * the server parks it in an HttpOnly cookie on that same response, so nothing
 * later needs it — and left in the URL it is a live shell credential in the
 * phone's history, autocomplete and every screenshot.
 *
 * Then the theme, awaited, so the first paint is already the desktop's palette.
 * A 401 anywhere shows Connect instead of a dead screen.
 */
/** The page was opened with `?k=` (scrubbed at boot): a refusal then means that key. */
let openedWithKey = false

async function boot(): Promise<void> {
  const here = new URL(window.location.href)
  if (here.searchParams.has('k')) {
    openedWithKey = true
    here.searchParams.delete('k')
    window.history.replaceState(null, '', `${here.pathname}${here.search}${here.hash}`)
  }
  setAuthFailureHandler(showConnect)
  try {
    await loadTheme()
    await loadHost()
  } catch (err) {
    if (err instanceof AuthError) return showConnect()
  }
  store.start()
  window.addEventListener('hashchange', render)
  wideQuery.addEventListener('change', () => {
    currentKey = ''
    teardown()
    render()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !connectMode) void loadTheme().catch(() => {})
  })
  render()
}

void boot()
