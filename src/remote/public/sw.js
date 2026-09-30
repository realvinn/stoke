/*
 * Stoke's phone shell, installable and quick to open, and able to paint
 * itself with no network — never a copy of any session data.
 *
 * What it touches, and nothing else (`route`):
 *   - the shell (index.html): NETWORK FIRST, so a Stoke update reaches the
 *     phone on its next load; the cached copy only answers when the network
 *     does not (offline, or no answer in SHELL_WAIT_MS), and it paints the
 *     Connect screen or the "can't reach" list, which is the truth then;
 *   - /assets/*: content-hashed files, one exact build each, cache first;
 *   - the manifest and the icons.
 * Never /api/* and never /ws: every byte of session data, and the key that
 * guards it, goes to the computer every time. A navigation carrying `?k=` is
 * fetched as it is (the server sets the cookie on that response), and what is
 * kept of it is a NEW Response holding only its bytes, status and headers
 * (`keepShell`). A fixed cache key is not enough: a stored Response keeps its
 * own URL list, so the network's answer to Connect's `/?k=<key>` navigation,
 * put under `index.html`, read back as `https://host/?k=<key>` from `.url` to
 * any script on the origin — the key the HttpOnly cookie exists to hide. An
 * asset or icon asked for with a query is left to the network, so the only
 * URLs this worker ever stores are bare file URLs.
 *
 * Versioned: vite.remote.config.ts stamps BUILD (a hash of the bundle) and the
 * file list into the copy in out/remote, so every new bundle is a new script
 * the browser installs, whose cache is named after it; activating it deletes
 * every other build's cache. Unstamped (a copy served straight from public/),
 * it still works, as a plain runtime cache.
 *
 * Registered by main.ts only in a secure context — https (the tunnel) or
 * localhost. Browsers refuse a service worker on a plain-http LAN or tailnet
 * address, and that page simply runs without one, exactly as before.
 *
 * It also shows Web Push notifications (`pushNotice`, phone contract point
 * 14): the payload's title and body cut to size, and a tap goes only to one of
 * this shell's own `#/` routes.
 *
 * Plain JS, no imports: this file runs as it is. `verify:remote` loads it in a
 * sandbox and holds `route` and `pushNotice` to the rules above.
 */

const BUILD = '__STOKE_BUILD__'
const PRECACHE = /* __STOKE_PRECACHE__ */ []
const CACHE = `stoke-shell-${BUILD}`
const SHELL_WAIT_MS = 4000

/**
 * What this worker does with a request for `pathname`, given the path its
 * scope starts at: 'shell', 'asset', 'static', or null to leave it alone.
 */
function route(pathname, scopePath, navigate) {
  if (!pathname.startsWith(scopePath)) return null
  const rel = pathname.slice(scopePath.length)
  if (rel === 'api' || rel.startsWith('api/') || rel === 'ws' || rel.startsWith('ws/')) return null
  if (rel === 'sw.js') return null
  if (rel === '' || rel === 'index.html') return 'shell'
  if (rel.startsWith('assets/')) return 'asset'
  if (rel === 'manifest.webmanifest' || /^icon-\d+\.png$/.test(rel)) return 'static'
  // Any other page (the SPA fallback) is the shell too; any other file is not ours.
  return navigate && !/\.[A-Za-z0-9]+$/.test(rel) ? 'shell' : null
}

function scopeUrl(path) {
  return new URL(path, self.registration.scope).toString()
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE.map(scopeUrl)))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.filter((n) => n.startsWith('stoke-shell-') && n !== CACHE).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  )
})

/**
 * Keeps the network's shell under `key` as a Response with NO URL: its bytes,
 * status and headers, rebuilt. `res` came back for the navigation's own URL,
 * `?k=<key>` included, and Cache Storage stores a response's URL list with it.
 */
async function keepShell(cache, key, res) {
  const body = await res.blob()
  await cache.put(key, new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers }))
}

/** The network's shell, kept under the one fixed key with no URL; the kept one if the network fails or stalls. */
async function shell(request) {
  const cache = await caches.open(CACHE)
  const key = scopeUrl('index.html')
  const network = fetch(request).then((res) => {
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      keepShell(cache, key, res.clone()).catch(() => {})
    }
    return res
  })
  // Handled here too: after a stall has answered from the cache, a late failure is nobody's error.
  network.catch(() => {})
  const stalled = new Promise((resolve) => setTimeout(() => resolve(null), SHELL_WAIT_MS))
  try {
    const first = await Promise.race([network, stalled])
    if (first) return first
    const cached = await cache.match(key)
    return cached || (await network)
  } catch {
    const cached = await cache.match(key)
    return cached || Response.error()
  }
}

/** A hashed or static file: this build's copy, else the network's (kept only if it is really that file). */
async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok && !(res.headers.get('content-type') || '').includes('text/html')) void cache.put(request, res.clone())
  return res
}

/*
 * Web Push (phone contract point 14). The payload is content-free by design —
 * a project name, "Needs you" or "Finished", and the session's route inside
 * this shell — and this worker trusts none of it past that: the text is cut,
 * and the route must be one of the shell's own hash routes, so a payload can
 * never send a tap to another page or origin.
 */
function pushNotice(data) {
  const d = data && typeof data === 'object' ? data : {}
  const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '')
  const route = typeof d.url === 'string' && /^#\/[A-Za-z0-9/%._-]*$/.test(d.url) ? d.url : '#/'
  return {
    title: text(d.title, 80) || 'Stoke',
    options: {
      body: text(d.body, 120),
      tag: text(d.tag, 80) || 'stoke',
      renotify: true,
      icon: scopeUrl('icon-192.png'),
      badge: scopeUrl('icon-192.png'),
      data: { route }
    }
  }
}

self.addEventListener('push', (event) => {
  let data = null
  try {
    data = event.data ? event.data.json() : null
  } catch {
    data = null
  }
  const notice = pushNotice(data)
  event.waitUntil(self.registration.showNotification(notice.title, notice.options))
})

/** A tap opens the session: the shell's own window if one is open (told to go there), else a new one. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const route = pushNotice({ url: event.notification.data && event.notification.data.route }).options.data.route
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const mine = list.find((c) => c.url.startsWith(self.registration.scope))
      if (mine) {
        mine.postMessage({ type: 'stoke:open', route })
        return mine.focus()
      }
      return self.clients.openWindow(scopeUrl('') + route)
    })
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const kind = route(url.pathname, new URL(self.registration.scope).pathname, request.mode === 'navigate')
  if (kind === 'shell') event.respondWith(shell(request))
  // A file asked for with a query is not one of the exact files this worker keeps:
  // `cacheFirst` would store that URL, query and all, so the network has it.
  else if ((kind === 'asset' || kind === 'static') && !url.search) event.respondWith(cacheFirst(request))
})
