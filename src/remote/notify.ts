/*
 * Notifications: the phone told when a session needs it, or finished, without
 * the page open (Web Push, phone contract point 14). A bell in the home bar
 * opens a sheet that says whether this phone gets them, turns them on or off,
 * and sends one test.
 *
 * What a notification carries is decided on the computer and is content-free:
 * the project's name and "Needs you" or "Finished" (`pushPayload`). Nothing a
 * session printed or asked ever leaves it this way.
 *
 * Only possible where the page is a secure context with a service worker —
 * the https tunnel link, or localhost — and on iOS only from the Home Screen
 * app. Everywhere else the sheet says which of those it is and why, rather than
 * failing at the first tap (`pushAvailability`).
 */
import { base64UrlBytes, pushAvailability, sameServerKey, type PushAvailability } from '@shared/phoneUi'
import { api, host, loadHost } from './api'
import { el, humanError, icon, iconButton, openSheet, toast } from './dom'

/** The browser's own facts, gathered once per read. */
function environment(): Parameters<typeof pushAvailability>[0] {
  const nav = navigator as Navigator & { standalone?: boolean }
  const ua = navigator.userAgent
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
  return {
    secure: window.isSecureContext,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    notification: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : 'default',
    ios,
    standalone: nav.standalone === true || matchMedia('(display-mode: standalone)').matches,
    serverKey: host?.push?.publicKey ?? null
  }
}

/** This page's worker registration, if the shell registered one (main.ts). */
async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  const reg = await navigator.serviceWorker.getRegistration()
  return reg ?? null
}

/** The subscription this browser holds for Stoke, if any. */
async function current(): Promise<PushSubscription | null> {
  const reg = await registration()
  return reg ? reg.pushManager.getSubscription() : null
}

/**
 * Subscribe (or re-subscribe, when the computer's key changed since) and tell
 * the computer. The permission prompt is the browser's own, raised from this
 * tap — a prompt nobody asked for is what browsers now refuse.
 */
async function turnOn(key: string): Promise<PushSubscription> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notifications were not allowed. Allow them in the browser’s site settings, then try again.')
  const reg = await navigator.serviceWorker.ready
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameServerKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => {})
    sub = null
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlBytes(key) as BufferSource })
  await api('/api/push/subscription', { method: 'POST', body: JSON.stringify(sub.toJSON()) })
  return sub
}

/** Forget it on the computer first (so nothing more is sent), then in the browser. */
async function turnOff(sub: PushSubscription): Promise<void> {
  await api('/api/push/subscription', { method: 'DELETE', body: JSON.stringify({ endpoint: sub.endpoint }) })
  await sub.unsubscribe().catch(() => {})
}

/** The bell in the home bar. */
export function notifyButton(): HTMLButtonElement {
  const b = iconButton('bell', 'Notifications', { 'data-testid': 'notify-button' })
  b.addEventListener('click', () => openNotifications())
  return b
}

/** The sheet: where this phone stands, and the one thing it can do. */
export function openNotifications(): void {
  const sheet = openSheet({ title: 'Notifications' })
  const status = el('p', { class: 'sheet-text notify-status', 'aria-live': 'polite', 'data-testid': 'notify-status' })
  const why = el('p', { class: 'field-note notify-why', 'data-testid': 'notify-why' })
  const actions = el('div', { class: 'sheet-actions' })
  sheet.body.replaceChildren(
    el(
      'p',
      { class: 'sheet-text' },
      'Stoke tells this phone when a session needs you, or finishes. A notification names only the project — never what the session printed or asked.'
    ),
    status,
    why,
    actions
  )

  let busy = false
  const button = (label: string, variant: 'primary' | null, run: () => Promise<void>): HTMLButtonElement => {
    const b = el('button', { type: 'button', class: 'btn', 'data-variant': variant ?? undefined }, label)
    b.addEventListener('click', () => {
      if (busy) return
      busy = true
      for (const x of actions.querySelectorAll('button')) x.disabled = true
      b.textContent = `${label}…`
      run()
        .catch((err) => toast(humanError(err), 'error'))
        .finally(() => {
          busy = false
          void paint()
        })
    })
    return b
  }

  const paint = async (): Promise<void> => {
    // The key is read afresh: Phone access may have started (and minted it) since this page loaded.
    if (!host?.push?.publicKey) await loadHost().catch(() => null)
    const env = environment()
    const verdict: PushAvailability = pushAvailability(env)
    const sub = verdict.ok ? await current().catch(() => null) : null
    const on = verdict.ok && sub !== null && sameServerKey(sub.options.applicationServerKey, env.serverKey ?? '')
    status.replaceChildren(icon(on ? 'bell' : 'bellOff', 18), el('span', {}, on ? 'On for this phone.' : 'Off for this phone.'))
    status.dataset.state = on ? 'on' : 'off'
    why.textContent = verdict.ok ? '' : verdict.text
    why.hidden = verdict.ok
    if (!verdict.ok) {
      actions.replaceChildren()
      return
    }
    const key = env.serverKey as string
    if (on && sub) {
      actions.replaceChildren(
        button('Turn off', null, async () => {
          await turnOff(sub)
          toast('Notifications are off for this phone.')
        }),
        button('Send a test', 'primary', async () => {
          await api('/api/push/test', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) })
          toast('Sent. It should arrive in a moment.')
        })
      )
    } else {
      actions.replaceChildren(
        button('Turn on', 'primary', async () => {
          await turnOn(key)
          toast('Notifications are on for this phone.')
        })
      )
    }
  }
  status.textContent = 'Checking…'
  void paint()
}

/**
 * A tap on a notification while the shell is open: the worker asks this page to
 * go to the session (`stoke:open`) rather than opening a second window. Only
 * the shell's own hash routes are followed.
 */
export function listenForNotificationTaps(): void {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const data = e.data as { type?: unknown; route?: unknown } | null
    if (data?.type === 'stoke:open' && typeof data.route === 'string' && /^#\/[A-Za-z0-9/%._-]*$/.test(data.route)) {
      location.hash = data.route
    }
  })
}
