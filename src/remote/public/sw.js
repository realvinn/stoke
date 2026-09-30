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
 * fetched as it is (the server sets the cookie on that response), and the
 * shell is stored under one fixed key, so a key never lands in Cache Storage.
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
 * Plain JS, no imports: this file runs as it is. `verify:remote` loads it in a
 * sandbox and holds `route` to the rules above.
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

/** The network's shell, stored under the one fixed key; the stored one if the network fails or stalls. */
async function shell(request) {
  const cache = await caches.open(CACHE)
  const key = scopeUrl('index.html')
  const network = fetch(request).then((res) => {
    if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
      void cache.put(key, res.clone())
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

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  const kind = route(url.pathname, new URL(self.registration.scope).pathname, request.mode === 'navigate')
  if (kind === 'shell') event.respondWith(shell(request))
  else if (kind === 'asset' || kind === 'static') event.respondWith(cacheFirst(request))
})
