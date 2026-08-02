/*
 * The remote server hands a phone control of a terminal, so a hole here is a
 * remote shell. Every case below failed at some point and was fixed; they are
 * kept because none of them announced themselves — each returned a plausible
 * success.
 *
 * Stoke must already be running with remote access enabled. Pass the base URL
 * and key, or point it at an mcp-browser.json-style profile:
 *
 *   node scripts/verify-remote-security.mjs http://127.0.0.1:7982 <token>
 */
const base = (process.argv[2] || 'http://127.0.0.1:7878').replace(/\/$/, '')
const key = process.argv[3]

/*
 * An instance configured for the tunnel sets requireAccessHeader, and then
 * refuses everything that did not arrive through Cloudflare Access - including
 * this script, which makes all sixteen checks fail identically for a reason
 * that has nothing to do with what they test. --access stands in for the header
 * Cloudflare injects, so a production-shaped instance can be checked too.
 */
const withAccess = process.argv.includes('--access')
const ACCESS = withAccess ? { 'cf-access-authenticated-user-email': 'verify@localhost' } : {}

if (!key) {
  console.error(
    'usage: node scripts/verify-remote-security.mjs <baseUrl> <token> [--access]\n' +
      '  --access  send a Cloudflare Access header, for an instance with requireAccessHeader on'
  )
  process.exit(2)
}

let pass = 0
let fail = 0

function check(name, expected, actual) {
  if (expected === actual) {
    console.log(`  PASS  ${name}`)
    pass++
  } else {
    console.log(`  FAIL  ${name} — expected ${expected}, got ${actual}`)
    fail++
  }
}

async function status(path, init) {
  try {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { ...ACCESS, ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(20_000)
    })
    return res.status
  } catch (e) {
    return `error:${e.name}`
  }
}

const json = (body) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: typeof body === 'string' ? body : JSON.stringify(body)
})

console.log('\nauthentication')
check('a request with no key is refused', 401, await status('/api/projects'))
check('a request with the key is served', 200, await status(`/api/projects?k=${key}`))
check('a wrong key of the same length is refused', 401, await status(`/api/projects?k=${'x'.repeat(key.length)}`))

console.log('\nthe phone cannot start an unsandboxed agent')
check(
  'bypassPermissions is refused',
  403,
  await status(`/api/sessions?k=${key}`, json({ cwd: 'C:\\', permissionMode: 'bypassPermissions' }))
)
check(
  'a directory the desktop does not know is refused',
  400,
  await status(`/api/sessions?k=${key}`, json({ cwd: 'G:/no/such/dir/zzz' }))
)
check(
  'a malformed body does not quietly start a default session',
  400,
  await status(`/api/sessions?k=${key}`, json('not json{{{'))
)

console.log('\npath traversal')
check(
  'a traversing session id is refused',
  400,
  await status(`/api/transcript?id=${encodeURIComponent('../../../../etc/passwd')}&k=${key}`)
)
check('a non-uuid session id is refused', 400, await status(`/api/transcript?id=notauuid&k=${key}`))

console.log('\nthe wrong method no longer returns the app shell')
check('GET on a POST-only route', 404, await status(`/api/transcribe?k=${key}`))
check('POST on a GET-only route', 404, await status(`/api/projects?k=${key}`, { method: 'POST' }))
check('DELETE on sessions', 404, await status(`/api/sessions?k=${key}`, { method: 'DELETE' }))

console.log('\ncookie flags')
try {
  const res = await fetch(`${base}/?k=${key}`, {
    headers: ACCESS,
    signal: AbortSignal.timeout(20_000)
  })
  const cookie = res.headers.get('set-cookie') || ''
  console.log(`  ${cookie || '(no set-cookie)'}`)
  check('HttpOnly, so script cannot read the credential', true, /HttpOnly/i.test(cookie))
  check('Secure, so it never rides plaintext', true, /Secure/i.test(cookie))
  check('SameSite is set', true, /SameSite=/i.test(cookie))
} catch (e) {
  console.log(`  FAIL  could not read the cookie — ${e.message}`)
  fail++
}

/*
 * Raw socket rather than fetch: Connection and Upgrade are forbidden header
 * names, so fetch throws a TypeError before the request leaves the process and
 * the check silently never runs.
 */
async function handshakeStatus(origin) {
  const { connect } = await import('node:net')
  const { hostname, port } = new URL(base)
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) }, () => {
      socket.write(
        `GET /ws?ptyId=x&k=${key} HTTP/1.1\r\n` +
          `Host: ${hostname}:${port}\r\n` +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          (origin ? `Origin: ${origin}\r\n` : '') +
          (withAccess ? 'Cf-Access-Authenticated-User-Email: verify@localhost\r\n' : '') +
          '\r\n'
      )
    })
    const done = (v) => {
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(15_000, () => done('timeout'))
    socket.once('error', (e) => done(`error:${e.code}`))
    socket.once('data', (buf) => {
      const status = /^HTTP\/1\.1 (\d+)/.exec(buf.toString('latin1'))
      done(status ? Number(status[1]) : 'unparseable')
    })
  })
}

console.log('\nwebsocket origin')
check(
  'a handshake claiming another origin is refused',
  403,
  await handshakeStatus('https://evil.example')
)
check('a handshake with no origin still authenticates', 101, await handshakeStatus(null))

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
