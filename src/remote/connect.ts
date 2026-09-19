/*
 * Connect: what a phone without a working key sees — audit PX-14.
 *
 * It used to be the server's text/plain "Unauthorized" at 12px with no
 * viewport, with no way to enter anything. The shell is public now (phone
 * contract point 1), so it renders this instead: one field that takes the
 * whole link or the bare key. It is also what an iOS home-screen app opens to
 * on first launch, since it gets a cookie jar of its own.
 */
import { connectCopy, parseConnectInput } from '@shared/phoneUi'
import { api, AuthError, CONNECTED_KEY } from './api'
import { el, icon } from './dom'

/** `linkKey`: the page was opened with a `?k=` that the server then refused. */
export function mountConnect(opts: { linkKey?: boolean } = {}): HTMLElement {
  let replaced = false
  try {
    replaced = localStorage.getItem(CONNECTED_KEY) === '1'
  } catch {
    /* private mode */
  }
  const copy = connectCopy({ linkKey: opts.linkKey === true, connectedBefore: replaced })
  const field = el('input', {
    type: 'text',
    class: 'connect-input',
    id: 'connect-key',
    placeholder: 'http://…/?k=…  or the key',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
    enterkeyhint: 'go',
    'aria-describedby': 'connect-error'
  })
  const error = el('p', { class: 'connect-error', id: 'connect-error', role: 'alert' })
  const go = el('button', { type: 'submit', class: 'btn btn-block', 'data-variant': 'primary' }, 'Connect')
  const form = el(
    'form',
    { class: 'connect-form', novalidate: true },
    el('label', { class: 'field-label', for: 'connect-key' }, 'Paste the link or key from Stoke'),
    field,
    error,
    go
  )

  form.addEventListener('submit', (e) => {
    e.preventDefault()
    error.textContent = ''
    const parsed = parseConnectInput(field.value, location.origin)
    if (parsed.kind === 'invalid') {
      error.textContent = parsed.reason
      return
    }
    if (parsed.kind === 'link' && !parsed.sameOrigin) {
      // A link to another address (the LAN one pasted into the tunnel's app, say).
      location.href = parsed.url
      return
    }
    go.disabled = true
    go.textContent = 'Checking…'
    // Try the key before storing it, so a typo gets a sentence, not a loop.
    api('/api/host', { key: parsed.key })
      .then(() => {
        // The server turns ?k= into the HttpOnly cookie; boot scrubs it from the URL.
        location.replace(`${location.pathname}?k=${encodeURIComponent(parsed.key)}`)
      })
      .catch((err) => {
        go.disabled = false
        go.textContent = 'Connect'
        error.textContent =
          err instanceof AuthError
            ? 'That key was not accepted. It may have been replaced — copy the link again from Stoke.'
            : 'Stoke did not answer. Is your computer awake, with Phone access on?'
      })
  })

  return el(
    'main',
    { class: 'connect' },
    el(
      'div',
      { class: 'connect-card' },
      el('div', { class: 'connect-mark', 'aria-hidden': 'true' }, icon('link', 26)),
      el('h1', { class: 'connect-title' }, copy.title),
      el('p', { class: 'connect-text' }, copy.text),
      form,
      el(
        'ol',
        { class: 'connect-steps' },
        el('li', {}, 'On your computer, open Stoke.'),
        el('li', {}, 'Click the phone icon in the title bar.'),
        el('li', {}, 'Scan the code with this phone’s camera, or copy the link and paste it above.')
      )
    )
  )
}
