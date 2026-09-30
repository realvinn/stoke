/*
 * A tiny login server for the Windows Chrome-import e2e (.github/workflows/windows.yml).
 *
 * `/seed` is a GET that logs a browser in: it returns an HttpOnly cookie, so a
 * headless Chrome driven to it stores that cookie the way it stores any login,
 * encrypted with Chrome's own key. NOTE: in a NON-default --user-data-dir (which
 * the seed uses) Chrome writes the v10/plain-DPAPI scheme, not the v20 app-bound
 * one — see gotcha 130 and the seed step's tag readout. The reader under test
 * then has to hand it back decrypted. `/whoami` reports whether the caller is
 * carrying the cookie.
 *
 *   SID=<value> PORT=<n|0> node scripts/probe/login-server.mjs   # prints the port
 *
 * No dependencies: plain node:http. Binds loopback only.
 */
import http from 'node:http'

const SID = process.env.SID || `probe-sid-${process.pid}`
// HttpOnly so it never shows in document.cookie — the point is that CDP still returns it.
// Max-Age (not a bare session cookie) so it survives Chrome's graceful shutdown flush.
const cookie = `sid=${SID}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`

const srv = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const authed = new RegExp(`(?:^|;\\s*)sid=${SID}(?:;|$)`).test(req.headers.cookie ?? '')
  if (url.pathname === '/seed') {
    res.writeHead(200, { 'Set-Cookie': cookie, 'Content-Type': 'text/html' })
    return res.end('<p id=seeded>ok</p>')
  }
  if (url.pathname === '/whoami') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ authed }))
  }
  res.writeHead(404)
  res.end()
})

srv.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => {
  const addr = srv.address()
  console.log(typeof addr === 'object' && addr ? addr.port : '')
})
