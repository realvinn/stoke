import './style.css'
import { homeSegmentFor, runningBadge, type HomeSegment } from '@shared/phoneUi'
import { accessRefusalOf, AuthError, loadHost, loadTheme, machineName, setAuthFailureHandler, showMachine, host } from './api'
import { mountConnect } from './connect'
import { el, failure, humanError, icon, newButton, skeleton } from './dom'
import { mountProjectHistory, mountRecent, mountTranscript, type Recent } from './history'
import { mountSessionList, type SessionList } from './list'
import { openNewSession } from './newSession'
import { listenForNotificationTaps, notifyButton } from './notify'
import { mountSession } from './session'
import { store } from './store'

/**
 * Stoke on a phone — and in a laptop's browser.
 *
 * Screens: Connect (no key), home (Running | Recent), Session (terminal), New
 * session (a sheet), a project's past sessions and one conversation. Below
 * 1024px it is one screen at a time; from 1024px it is a real two-pane layout
 * — home as a 340px rail and the session (or the project) beside it at the
 * pty's own size — rather than a phone stretched to 1440px (audit PX-16).
 * Routes live in the hash, so the browser's and Android's back gestures work
 * and a reload lands where you were. `#/history` is home's Recent segment:
 * the old History screen's address, kept so a bookmark or a Back still lands.
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
    el('img', { class: 'brand-mark', src: './icon-192.png', alt: '', width: 24, height: 24 }),
    el('span', { class: 'brand-name' }, 'Stoke'),
    showMachine() && host ? el('span', { class: 'machine', title: host.machine }, host.machine) : null
  )
}

/**
 * The one action the home bar carries (the History button became the Recent
 * segment), and beside it the notifications bell — an icon, so New stays the
 * bar's one labelled action.
 */
function topbarActions(): HTMLElement[] {
  const create = newButton('New session')
  create.addEventListener('click', () => openNewSession())
  return [notifyButton(), create]
}

/**
 * Running | Recent. Links, not buttons: each is a route (`#/`, `#/history`),
 * so Back walks between them and a reload keeps the one you were on. While
 * Recent is open, Running says how many sessions wait on you.
 */
function segmentBar(active: HomeSegment): HTMLElement {
  const count = el('span', { class: 'seg-count' })
  const dot = el('span', { class: 'seg-dot', 'aria-hidden': 'true', hidden: true })
  // Plain links marked `aria-current`, not ARIA tabs: each one navigates, and a tab promises arrow keys and a panel.
  const tab = (id: HomeSegment, href: string, label: string, ...extra: HTMLElement[]): HTMLElement =>
    el(
      'a',
      { class: 'seg-btn', href, 'aria-current': active === id ? 'page' : undefined, 'data-segment': id },
      el('span', {}, label),
      ...extra
    )
  const running = tab('running', '#/', 'Running', count, dot)
  const bar = el(
    'nav',
    { class: 'segbar', 'aria-label': 'Sessions' },
    el('div', { class: 'seg' }, running, tab('recent', '#/history', 'Recent'))
  )
  const paint = (): void => {
    const b = runningBadge(store.rows)
    count.textContent = b.live ? String(b.live) : ''
    count.hidden = b.live === 0
    dot.hidden = active === 'running' || b.needsYou === 0
    running.setAttribute('aria-label', b.needsYou && active !== 'running' ? `Running, ${b.needsYou} need you` : 'Running')
  }
  paint()
  const off = store.subscribe(paint)
  bar.addEventListener('stoke:destroy', () => off())
  return bar
}

/** The global "can't reach your computer" strip, driven by the session store. */
function linkStrip(): HTMLElement {
  const strip = el('div', { class: 'link-strip', role: 'status', hidden: true })
  const paint = (): void => {
    const down = store.link === 'down'
    strip.hidden = !down
    if (down) {
      /*
       * An Access refusal is not "can't reach": the computer answered, and the
       * page's own body says why it refused (gotcha 124). Telling this person to
       * turn Phone access back on would send them after a server that is up.
       */
      const access = accessRefusalOf(store.error) !== null
      strip.replaceChildren(
        el('i', { class: 'spinner', 'aria-hidden': 'true' }),
        el(
          'span',
          {},
          access
            ? `Cloudflare Access check failed on ${machineName()} — retrying.`
            : `Can't reach ${machineName()} — retrying. If Phone access was turned off, turn it back on in Stoke.`
        )
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
  const hist = el('a', { class: 'btn', href: '#/history' }, icon('history', 18), 'Resume a recent one')
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
    // An Access refusal DID reach the computer: it answered, and said why not.
    failure: (err) =>
      failure(
        accessRefusalOf(err) !== null ? 'Cloudflare Access check failed' : `Can't reach ${machineName()}`,
        humanError(err),
        () => void store.refresh()
      )
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

/** Home on a phone or a tablet: the bar, the segments, then Running's list or Recent. */
function mountHome(segment: HomeSegment): Mounted {
  const body = el('div', { class: 'content' })
  const strip = linkStrip()
  const segs = segmentBar(segment)
  const root = el(
    'section',
    { class: 'page home', 'data-segment': segment },
    el('header', { class: 'topbar' }, brand(), el('span', { class: 'spacer' }), ...topbarActions()),
    segs,
    strip,
    el('main', { class: 'scroll', 'aria-label': segment === 'running' ? 'Running sessions' : 'Recent projects' }, body)
  )
  const list = segment === 'running' ? mountList(body, false) : null
  if (segment === 'recent') body.append(mountRecent({ compact: false }).root)
  return {
    root,
    destroy: () => {
      list?.destroy()
      strip.dispatchEvent(new Event('stoke:destroy'))
      segs.dispatchEvent(new Event('stoke:destroy'))
    }
  }
}

function mountRoute(route: Route, wide: boolean): Mounted {
  switch (route.name) {
    case 'session':
      return mountSession(route.ptyId, { wide, onBack: () => (location.hash = '#/') })
    case 'history':
      return wide ? mountPlaceholder('recent') : mountHome('recent')
    case 'project':
      return mountProjectHistory(route.cwd)
    case 'transcript':
      return mountTranscript(route.id, route.cwd)
    default:
      return wide ? mountPlaceholder('running') : mountHome('running')
  }
}

/** The laptop pane with nothing picked: point at what needs you, or at the projects. */
function mountPlaceholder(segment: HomeSegment): Mounted {
  const box = el('div', { class: 'placeholder' })
  if (segment === 'recent') {
    box.replaceChildren(
      el(
        'div',
        { class: 'empty' },
        el('div', { class: 'empty-mark', 'aria-hidden': 'true' }, icon('history', 28)),
        el('p', { class: 'empty-title' }, 'Pick a project'),
        el(
          'p',
          { class: 'empty-text' },
          `Every project on ${machineName()} with a past conversation is on the left. Open one to read back or resume its sessions.`
        )
      )
    )
    return { root: el('section', { class: 'page' }, box), destroy: () => {} }
  }
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
/** The laptop rail: the bar, the segments, and both lists — the route's segment decides which shows. */
let rail: {
  pane: HTMLElement
  strip: HTMLElement
  segs: HTMLElement
  segment: HomeSegment
  list: SessionList
  listBox: HTMLElement
  recent: Recent | null
  recentBox: HTMLElement
} | null = null
let connectMode = false

function teardown(): void {
  current?.destroy()
  current = null
  currentKey = ''
  if (rail) {
    rail.list.destroy()
    rail.strip.dispatchEvent(new Event('stoke:destroy'))
    rail.segs.dispatchEvent(new Event('stoke:destroy'))
    rail = null
  }
}

/** Point the rail at a segment: the bar's state, and the one list that belongs to it. */
function showRailSegment(segment: HomeSegment): void {
  if (!rail) return
  if (rail.segment !== segment) {
    const segs = segmentBar(segment)
    rail.segs.dispatchEvent(new Event('stoke:destroy'))
    rail.segs.replaceWith(segs)
    rail.segs = segs
    rail.segment = segment
    // Back on Recent: ask again, a session may have ended into history since.
    if (segment === 'recent') rail.recent?.refresh()
  }
  if (segment === 'recent' && !rail.recent) {
    rail.recent = mountRecent({ compact: true })
    rail.recentBox.append(rail.recent.root)
  }
  rail.listBox.hidden = segment !== 'running'
  rail.recentBox.hidden = segment !== 'recent'
}

function render(): void {
  if (connectMode) return
  const route = parseRoute(location.hash)
  const wide = wideQuery.matches
  const key = `${wide}|${JSON.stringify(route)}`
  if (key === currentKey) return

  if (wide) {
    const segment = homeSegmentFor(route.name)
    if (!rail) {
      teardown()
      const listBox = el('div', { class: 'rail-list' })
      const recentBox = el('div', { class: 'rail-list', hidden: true })
      const strip = linkStrip()
      const segs = segmentBar(segment)
      const pane = el('div', { class: 'pane' })
      const aside = el(
        'aside',
        { class: 'rail', 'aria-label': 'Sessions' },
        el('header', { class: 'topbar' }, brand(), el('span', { class: 'spacer' }), ...topbarActions()),
        segs,
        strip,
        el('nav', { class: 'rail-scroll', 'aria-label': 'Sessions and projects' }, listBox, recentBox)
      )
      app.replaceChildren(el('div', { class: 'split' }, aside, el('main', { class: 'pane-wrap' }, pane)))
      rail = { list: mountList(listBox, true), listBox, recent: null, recentBox, pane, strip, segs, segment }
    }
    showRailSegment(segment)
    current?.destroy()
    current = mountRoute(route, true)
    rail.pane.replaceChildren(current.root)
    rail.list.setSelected(route.name === 'session' ? route.ptyId : null)
    rail.recent?.setSelected(route.name === 'project' || route.name === 'transcript' ? route.cwd : null)
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

/**
 * The shell's service worker (public/sw.js): an installable app that opens at
 * once and paints Connect or "can't reach" with no network. Only in a secure
 * context — https through the tunnel, or localhost — because a browser refuses
 * one anywhere else; a plain-http LAN link runs exactly as before. It never
 * sees /api or /ws, so no session data is ever cached.
 */
function registerServiceWorker(): void {
  if (!window.isSecureContext || !('serviceWorker' in navigator)) return
  navigator.serviceWorker.register('./sw.js', { scope: './' }).catch(() => {
    /* a refused registration leaves the page as it always was */
  })
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
  // Before the first request: Connect and an offline shell both deserve one.
  registerServiceWorker()
  // A tapped notification while this page is open goes to its session here.
  listenForNotificationTaps()
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
