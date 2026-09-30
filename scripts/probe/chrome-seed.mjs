/*
 * Wait for a headless Chrome (seeded by login-server's /seed) to have stored the
 * `sid` cookie, then close it GRACEFULLY so the 30-second cookie-commit batch is
 * flushed to disk. Used only by the Windows Chrome-import e2e
 * (.github/workflows/windows.yml).
 *
 *   node scripts/probe/chrome-seed.mjs <debug-port>
 *
 * Node 24: global fetch + WebSocket, no dependencies.
 */
const port = process.argv[2]
if (!port) {
  console.error('usage: node scripts/probe/chrome-seed.mjs <debug-port>')
  process.exit(1)
}
const until = Date.now() + 30_000

let ver
while (!ver) {
  try {
    ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
  } catch {
    if (Date.now() > until) throw new Error('Chrome never opened CDP (treated the dir as default?)')
    await new Promise((r) => setTimeout(r, 250))
  }
}

const ws = new WebSocket(ver.webSocketDebuggerUrl)
await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
})

let n = 0
const waiters = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  const w = waiters.get(m.id)
  if (w) {
    waiters.delete(m.id)
    w(m)
  }
}
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++n
    waiters.set(id, resolve)
    ws.send(JSON.stringify({ id, method, params }))
  })

for (;;) {
  const { result } = await send('Storage.getCookies')
  if (result?.cookies?.some((c) => c.name === 'sid')) break
  if (Date.now() > until) throw new Error('the sid cookie never appeared in the store')
  await new Promise((r) => setTimeout(r, 250))
}
await send('Browser.close')
console.log('seeded and closed')
process.exit(0)
