/* Approved Stoke devices, reached through the computer serving this website.
 * A session link names both device and PTY; a PTY id alone is never global. */
import type { OtherMachineView, RemoteSessionSummary } from '@shared/hub/remote'
import type { RemoteDevicesResponse } from '@shared/remoteDevices'
import { api, AuthError, host, machineName, type ApiError } from './api'
import { el, humanError, icon } from './dom'

export const deviceSessionHash = (device: string, ptyId: string): string =>
  `#/devices/${encodeURIComponent(device)}/${encodeURIComponent(ptyId)}`

const platformName = (platform: string): string =>
  ({ darwin: 'Mac', win32: 'Windows', linux: 'Linux' })[platform] ?? (platform || 'Computer')

const STATUS: Record<RemoteSessionSummary['status'], string> = {
  waiting: 'Needs you', busy: 'Working', idle: 'Idle', ended: 'Ended', unknown: 'Running'
}

interface DeviceCard {
  root: HTMLElement
  update: (machine: OtherMachineView) => void
}

/** `quiet`: the account site, where a last-known card keeps its note (see mountDevices). */
function deviceCard(quiet = false): DeviceCard {
  const name = el('h2', { class: 'device-name' })
  const platform = el('span', { class: 'device-platform' })
  const note = el('p', { class: 'device-note' })
  const sessions = el('nav', { class: 'device-sessions' })
  const root = el('section', { class: 'device-card' }, el('div', { class: 'device-head' }, name, platform), note, sessions)
  const links = new Map<string, { root: HTMLAnchorElement; title: HTMLElement; meta: HTMLElement }>()
  return {
    root,
    update(machine) {
      root.dataset.device = machine.id
      if (name.textContent !== machine.label) name.textContent = machine.label
      const platformText = platformName(machine.platform)
      if (platform.textContent !== platformText) platform.textContent = platformText
      sessions.setAttribute('aria-label', `Sessions on ${machine.label}`)
      const status = machine.status
      const message = machine.reachable === false && !quiet ? 'Reconnecting to your account… Showing last-known sessions.' : !status
        ? 'Waiting for this device to share its status…'
        : !status.open
          ? 'To open sessions, turn on “Let my other devices see and open my sessions” under Accounts → Devices & sync on this device.'
          : status.sessions.length === 0 ? 'No sessions running on this device.' : ''
      if (note.textContent !== message) note.textContent = message
      note.hidden = !message
      const rows = status?.open ? status.sessions : []
      const present = new Set(rows.map(session => session.ptyId))
      for (const [id, link] of links) if (!present.has(id)) { link.root.remove(); links.delete(id) }
      rows.forEach((session, index) => {
        let link = links.get(session.ptyId)
        if (!link) {
          const title = el('span', { class: 'device-session-title' })
          const meta = el('span', { class: 'device-session-meta' })
          link = { root: el('a', { class: 'device-session' }, title, meta, icon('chevron', 16)), title, meta }
          links.set(session.ptyId, link)
        }
        const title = session.title || session.project || 'Untitled session'
        const context = session.context && session.context.limit > 0
          ? `${Math.min(100, Math.max(0, Math.round(session.context.used / session.context.limit * 100)))}% context` : null
        const meta = [session.project, session.agent, STATUS[session.status], context].filter(Boolean).join(' · ')
        if (link.title.textContent !== title) link.title.textContent = title
        if (link.meta.textContent !== meta) link.meta.textContent = meta
        if (machine.reachable === false) { link.root.removeAttribute('href'); link.root.setAttribute('aria-disabled','true') }
        else { link.root.href = deviceSessionHash(machine.id, session.ptyId); link.root.removeAttribute('aria-disabled') }
        link.root.dataset.pty = session.ptyId
        link.root.dataset.status = session.status
        link.root.title = `Open ${title} on ${machine.label}. This device may ask for approval.`
        if (sessions.children[index] !== link.root) sessions.insertBefore(link.root, sessions.children[index] ?? null)
      })
      sessions.hidden = rows.length === 0
    }
  }
}

export function mountDevices(opts: { wide?: boolean; account?: boolean } = {}): { root: HTMLElement; destroy: () => void } {
  const abort = new AbortController()
  const signal = abort.signal
  // The account website opens on this list: there is no sessions page behind it,
  // and a back link to `#/` only redrew this page and added a history entry.
  const back = opts.account ? null : el('a', { class: 'icon-btn', href: '#/', 'aria-label': 'Back to sessions', title: 'Back to sessions' }, icon('back'))
  const refresh = el('button', { type: 'button', class: 'btn btn-sm device-refresh' }, icon('retry', 16), 'Refresh')
  const localName = machineName()
  const local = el('section', { class: 'device-card device-local', 'aria-label': 'Current device' },
    el('div', { class: 'device-head' }, el('h2', { class: 'device-name' }, localName), el('span', { class: 'device-platform' }, platformName(host?.platform ?? ''))),
    el('p', { class: 'device-note' }, 'You’re connected through this device.'),
    el('a', { class: 'device-session', href: '#/' }, el('span', { class: 'device-session-title' }, 'Open its sessions'), icon('chevron', 16)))
  const message = el('p', { class: 'device-note', role: 'status' }, 'Finding your other devices…')
  const devices = el('div')
  const body = el('main', { class: 'scroll' }, el('div', { class: 'devices-content' }, ...(opts.account ? [] : [local]),
    el('h2', { class: 'section-head' }, opts.account ? 'Online computers' : 'Other devices'), message, devices))
  const root = el('section', { class: 'page devices-page', 'data-wide': opts.wide ? 'true' : undefined },
    el('header', { class: 'topbar' }, ...(back ? [back] : []), el('h1', { class: 'topbar-title' }, opts.account ? 'Stoke account' : 'Devices'), el('span', { class: 'spacer' }), refresh), body)
  const cards = new Map<string, DeviceCard>()
  let pending = false
  let received = false
  const showMessage = (text: string, error = false): void => {
    if (message.textContent !== text) message.textContent = text
    message.hidden = !text
    message.dataset.error = String(error)
  }
  const load = async (): Promise<void> => {
    if (pending || signal.aborted || document.visibilityState === 'hidden') return
    pending = true
    // A background poll must not blur a keyboard user's focused Refresh.
    // The pending guard above also makes repeated activations harmless.
    refresh.setAttribute('aria-disabled', 'true')
    refresh.setAttribute('aria-busy', 'true')
    try {
      const reply = await api<RemoteDevicesResponse>('/api/machines', { signal })
      if (signal.aborted) return
      // The account site re-checks presence on every wake (back to the tab, the
      // network back) and every dropped socket (a second browser on the same
      // link takes it), and its client calls the list unavailable until presence
      // answers, while the hub still names the computers it last knew
      // (`reachable: false`). Emptying the list then put a scrolled one back at
      // its top each time. So their cards stay where they are, links held and
      // with no note to move them, until presence says who is online; with none
      // known, it says it is reconnecting.
      const rows = reply.available || opts.account ? reply.machines : []
      const present = new Set(rows.map(machine => machine.id))
      for (const [id, card] of cards) if (!present.has(id)) { card.root.remove(); cards.delete(id) }
      rows.forEach((machine, index) => {
        let card = cards.get(machine.id)
        if (!card) { card = deviceCard(opts.account); cards.set(machine.id, card) }
        card.update(machine)
        if (devices.children[index] !== card.root) devices.insertBefore(card.root, devices.children[index] ?? null)
      })
      received = true
      showMessage(!reply.available
        ? opts.account ? (rows.length ? '' : 'Reconnecting to your Stoke account…') : `Sign in to Stoke Hub and join your vault on ${localName} to reach your other approved devices.`
        : rows.length === 0
          ? 'None of your other devices is online. Open Stoke on another device signed in to the same Hub account and vault.' : '')
    } catch (error) {
      if (signal.aborted || error instanceof AuthError) return
      const status = (error as ApiError)?.status
      showMessage(status === 404
        ? `Update Stoke on ${localName} to open your other devices from this website.`
        : `${received ? 'Couldn’t refresh devices. ' : 'Couldn’t load devices. '}${humanError(error)} Use Refresh to try again.`, true)
    } finally {
      pending = false
      if (!signal.aborted) { refresh.removeAttribute('aria-disabled'); refresh.removeAttribute('aria-busy') }
    }
  }
  if (opts.account) window.addEventListener('stoke:devices-change', () => void load(), { signal })
  refresh.addEventListener('click', () => void load(), { signal })
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void load() }, { signal })
  const poll = setInterval(() => void load(), 5000)
  void load()
  return { root, destroy: () => { clearInterval(poll); abort.abort() } }
}
