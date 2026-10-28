import '../remote/style.css'
import './style.css'
import { b64uDecode, fromUtf8 } from '../shared/hub/codec.ts'
import { browserLinkOf } from '../shared/hub/browser.ts'
import { AccountRemote, rememberBrowserLink, restoreBrowserLink } from './client.ts'
import { loadHost, setRemoteBackend } from '../remote/api.ts'
import { mountDevices } from '../remote/devices.ts'
import { mountSession } from '../remote/session.ts'
import { el } from '../remote/dom.ts'

const app = document.querySelector<HTMLDivElement>('#app')!
const notice = el('div', { class: 'account-notice', role: 'status', hidden: true })
const content = el('div', { class: 'account-content' })
app.append(notice, content)
let client: AccountRemote | null = null
let mounted: { root: HTMLElement; destroy(): void } | null = null
type SelectedSession = { device: string; pty: string; label: string; online: boolean }
let selected: SelectedSession | null = null
let previous: SelectedSession | null = null
let route = ''
/** The entry behind this session's is the computers list (it was opened from it). */
let fromList = false
/** A leave is on its way: the step back lands a task or more later, and two would go back two. */
let leaving = false
/** The note says the account connection failed: it goes once presence answers again. */
let failureShown = false
function showNote(text: string, failure = false): void { notice.textContent = text; notice.hidden = !text; failureShown = failure && !!text }
function routeParts(key: string): string[] {
  try { return key.replace(/^#\/?/, '').split('/').map(decodeURIComponent) } catch { return ['devices'] }
}
const isSessionRoute = (key: string): boolean => { const parts = routeParts(key); return parts[0] === 'devices' && !!parts[1] && !!parts[2] }
/**
 * Back to the computers list. Opened from it, the list is the entry behind,
 * so step back to it: setting the hash stacked a second list entry, and the
 * browser's own Back (iOS's edge swipe) then reopened the session just left.
 * Opened any other way (a reload, a saved link), replace the session's entry.
 * Leaving only disconnects this phone; the session runs on in its computer.
 * Once per leave (`leaving`, cleared by the render it causes): a second press,
 * or a second "went offline" update, before the first lands would otherwise
 * step back past the list, out of the site.
 */
function leaveSession(): void {
  if (leaving) return
  leaving = true
  if (fromList) history.back()
  else location.replace('#/devices')
}
function render(): void {
  if (!client) return
  const key = location.hash
  if (key === route && mounted) return
  // The list as it was MOUNTED, whatever its hash: one reached with none at all
  // (a bookmark, the address typed) has route '' like a first render does.
  if (key !== route) fromList = !!mounted && !isSessionRoute(route)
  leaving = false
  route = key; mounted?.destroy(); selected = null
  const parts = routeParts(key)
  if (isSessionRoute(key)) {
    const machine = client.view.machines.find(m => m.id === parts[1])
    selected = { device: parts[1], pty: parts[2], label: machine?.label ?? 'That computer', online: !!machine }
    mounted = mountSession(parts[2], { wide: false, remote: { device: parts[1] }, back: { label: 'Computers', name: 'Back to your computers' }, onBack: leaveSession })
  } else mounted = mountDevices({ account: true })
  content.replaceChildren(mounted.root)
}
async function boot(): Promise<void> {
  // Remove the credential fragment before rendering, requests, or a saved browser history entry.
  const fragment = location.hash
  if (fragment.startsWith('#connect=')) history.replaceState(null, '', location.pathname + '#/devices')
  let link = restoreBrowserLink()
  if (fragment.startsWith('#connect=')) {
    const bytes = b64uDecode(fragment.slice(9)), text = bytes && fromUtf8(bytes)
    try { link = browserLinkOf(text ? JSON.parse(text) : null) } catch { link = null }
    if (!link) throw new Error('This account link is incomplete. Create another account QR code in Stoke.')
    // Origin validation happens before persisting a credential from the address bar.
    client = new AccountRemote(link); rememberBrowserLink(link)
  }
  if (!link) {
    content.replaceChildren(el('main', { class: 'connect' }, el('div', { class: 'connect-card' }, el('h1', { class: 'connect-title' }, 'Your Stoke computers'), el('p', { class: 'connect-text' }, 'On any approved computer, open Stoke’s phone menu and choose “Pair phone to account”. Scan that QR once. This link keeps working when that computer goes offline.'))))
    return
  }
  client ??= new AccountRemote(link)
  setRemoteBackend(client)
  client.addEventListener('change', () => {
    window.dispatchEvent(new Event('stoke:devices-change'))
    if (selected) {
      const online = client!.view.machines.some(m => m.id === selected!.device)
      if (online) selected.online = true
      else if (selected.online && !client!.error && client!.view.available) {
        previous = selected
        showNote(`${selected.label} went offline. Choose a session on another online computer. Your draft is saved on this phone.`)
        leaveSession()
      }
    }
    if (client!.error) showNote(client!.error, true)
    // Once the account answers again, a failure note left up is stale.
    else if (failureShown && client!.view.available) showNote('')
    else if (previous && client!.view.machines.some(m => m.id === previous!.device)) showNote(`${previous.label} is back online. Its sessions are available below.`)
  })
  showNote('Connecting to your Stoke account…')
  await client.start(); await loadHost()
  showNote('')
  window.addEventListener('hashchange', render)
  const wake = (): void => { if (document.visibilityState === 'visible') void client?.wake().catch(error => showNote(error instanceof Error ? error.message : 'Reconnecting to your account…', true)) }
  window.addEventListener('online', wake); document.addEventListener('visibilitychange', wake)
  window.addEventListener('pagehide', () => { mounted?.destroy(); mounted = null; client?.stop() })
  window.addEventListener('pageshow', event => { if (event.persisted) void client?.start().then(render).catch(error => showNote(error instanceof Error ? error.message : 'Reconnecting to your account…', true)) })
  render()
}
void boot().catch(error => { showNote(error instanceof Error ? error.message : 'The account remote could not connect.'); content.append(el('button', { class: 'btn account-retry', type: 'button' }, 'Try again')); content.querySelector('button')?.addEventListener('click', () => location.reload()) })
