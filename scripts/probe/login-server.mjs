/*
 * A tiny login server, for the two CI jobs that log a browser in:
 *
 *   - the Windows Chrome-import e2e (.github/workflows/windows.yml), which
 *     drives a headless Chrome to `/seed` and imports the cookie it stored;
 *   - the packaged-app probe (scripts/probe-e2e.mts, ci.yml), which logs
 *     Stoke's DOCKED browser in through `/login`'s form, the way a person does,
 *     and then asks `/whoami` and `/account` — from that browser, from a second
 *     browser profile that must NOT be signed in (gotcha 107), through Stoke's
 *     browser MCP from a coding agent, and again after a quit and relaunch.
 *
 * `/seed` is a GET that logs a browser in: it returns an HttpOnly cookie, so a
 * headless Chrome driven to it stores that cookie the way it stores any login,
 * encrypted with Chrome's own key. NOTE: in a NON-default --user-data-dir (which
 * the seed uses) Chrome writes the v10/plain-DPAPI scheme, not the v20 app-bound
 * one — see gotcha 130 and the seed step's tag readout. The reader under test
 * then has to hand it back decrypted.
 *
 *   GET  /login     a form with one field and a button (#go)
 *   POST /login     user=probe-user sets the cookie and redirects to /whoami
 *   GET  /seed      sets the cookie outright
 *   GET  /whoami    {"authed":true|false} for the cookie the caller carries
 *   GET  /account   the same as an HTML page with a heading, for an agent to read
 *
 *   SID=<value> PORT=<n|0> node scripts/probe/login-server.mjs   # prints the port
 *
 * Or imported: `startLoginServer({ sid, port })` resolves to `{ port, close }`.
 *
 * No dependencies: plain node:http. Binds loopback only.
 */
import http from 'node:http'
import { pathToFileURL } from 'node:url'

export const PROBE_USER = 'probe-user'

/** The cookie a login sets. HttpOnly so it never shows in document.cookie — the point is that the jar still returns it. */
export function loginCookie(sid) {
  // Max-Age (not a bare session cookie) so it survives a graceful shutdown's
  // flush and a relaunch — a session cookie is allowed to die with the process.
  return `sid=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
}

const page = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

export function startLoginServer({ sid = `probe-sid-${process.pid}`, port = 0 } = {}) {
  const cookie = loginCookie(sid)
  const carries = (req) => new RegExp(`(?:^|;\\s*)sid=${sid}(?:;|$)`).test(req.headers.cookie ?? '')
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const authed = carries(req)
    if (url.pathname === '/login' && req.method === 'POST') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const ok = new URLSearchParams(body).get('user') === PROBE_USER
        res.writeHead(ok ? 303 : 401, ok ? { 'Set-Cookie': cookie, Location: '/whoami' } : { 'Content-Type': 'text/plain' })
        res.end(ok ? '' : 'wrong user')
      })
      return
    }
    if (url.pathname === '/login') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(
        page(
          'Probe login',
          `<h1>Probe login</h1><form method="post" action="/login"><input name="user" value="${PROBE_USER}"><button id="go" type="submit">Log in</button></form>`
        )
      )
    }
    if (url.pathname === '/seed') {
      res.writeHead(200, { 'Set-Cookie': cookie, 'Content-Type': 'text/html' })
      return res.end('<p id=seeded>ok</p>')
    }
    if (url.pathname === '/whoami') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ authed }))
    }
    if (url.pathname === '/account') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      const h = authed ? `Signed in as ${PROBE_USER}` : 'Not signed in'
      return res.end(page(h, `<main><h1>${h}</h1><p>This page says whether the browser that asked carries the probe's login cookie.</p></main>`))
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve, reject) => {
    srv.once('error', reject)
    srv.listen(Number(port), '127.0.0.1', () => {
      const addr = srv.address()
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        close: () => new Promise((r) => srv.close(() => r()))
      })
    })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { port } = await startLoginServer({ sid: process.env.SID || undefined, port: process.env.PORT ?? 0 })
  console.log(port)
}
