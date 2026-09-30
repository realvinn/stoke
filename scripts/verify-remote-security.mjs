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
 *
 * Cloudflare Access, verified (gotcha 124), without a Cloudflare account:
 *
 *   1. node scripts/verify-remote-security.mjs --serve-fake-access 7991 /tmp/x/access.json
 *      writes a keypair, a team and an AUD to that file (or reuses them) and
 *      serves the team's JWKS at http://127.0.0.1:7991/cdn-cgi/access/certs
 *      until stopped. It prints the settings and the env line to use.
 *   2. Start an UNPACKAGED Stoke with STOKE_ACCESS_CERTS_URL pointing there and
 *      remote.accessTeamDomain/accessAud/requireAccessHeader as printed.
 *   3. node scripts/verify-remote-security.mjs <baseUrl> <token> --access-configured /tmp/x/access.json
 *      runs everything below with a token signed by that key, plus the forgeries.
 */
import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
function mint(privateKey, header, payload, alg = 'sha256') {
  const input = `${b64(header)}.${b64(payload)}`
  return `${input}.${sign(alg, Buffer.from(input), privateKey).toString('base64url')}`
}

/** The fake team: a keypair, a team domain and an AUD, kept in one file. */
function loadFakeTeam(file) {
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'))
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const team = {
    teamDomain: 'stoke-sandbox.cloudflareaccess.com',
    aud: [...Array(64)].map((_, i) => '0123456789abcdef'[(i * 7 + 3) % 16]).join(''),
    kid: 'sandbox-kid-1',
    privateKeyPem: privateKey.export({ format: 'pem', type: 'pkcs8' }),
    jwk: { ...publicKey.export({ format: 'jwk' }), kid: 'sandbox-kid-1', alg: 'RS256', use: 'sig' }
  }
  writeFileSync(file, JSON.stringify(team, null, 2), { mode: 0o600 })
  return team
}

if (process.argv[2] === '--serve-fake-access') {
  const port = Number(process.argv[3])
  const file = process.argv[4]
  if (!port || !file) {
    console.error('usage: node scripts/verify-remote-security.mjs --serve-fake-access <port> <keyfile>')
    process.exit(2)
  }
  const team = loadFakeTeam(file)
  const server = createServer((req, res) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.url}`)
    if (req.url !== '/cdn-cgi/access/certs') {
      res.writeHead(404).end()
      return
    }
    // Cloudflare's own shape and cache header (measured 2026-09-30).
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=14400, must-revalidate' })
    res.end(JSON.stringify({ keys: [team.jwk], public_cert: { kid: team.kid } }))
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`fake Access JWKS on http://127.0.0.1:${port}/cdn-cgi/access/certs`)
    console.log(`  STOKE_ACCESS_CERTS_URL=http://127.0.0.1:${port}/cdn-cgi/access/certs`)
    console.log(`  remote.accessTeamDomain=${team.teamDomain}`)
    console.log(`  remote.accessAud=${team.aud}`)
  })
  const stop = () => server.close(() => process.exit(0))
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
  // Serve until stopped; nothing below runs in this mode.
  await new Promise(() => {})
}

const base = (process.argv[2] || 'http://127.0.0.1:7878').replace(/\/$/, '')
const key = process.argv[3]

/*
 * An instance configured for the tunnel sets requireAccessHeader, and then
 * refuses everything that did not arrive through Cloudflare Access - including
 * this script, which makes all sixteen checks fail identically for a reason
 * that has nothing to do with what they test.
 *
 * --access forges the unsigned email header, which is all a PRESENCE-ONLY
 * instance (Access on, no team or AUD in settings) ever checked. That forgery
 * working was the finding: a verified instance refuses it, and
 * --access-configured proves so, then signs a real token with the fake team's
 * key so the rest of the matrix runs as the edge would.
 */
const withAccess = process.argv.includes('--access')
const configuredAt = process.argv.indexOf('--access-configured')
const fakeTeam = configuredAt > 0 ? loadFakeTeam(process.argv[configuredAt + 1]) : null
const nowS = Math.floor(Date.now() / 1000)
const teamKey = fakeTeam ? createPrivateKey(fakeTeam.privateKeyPem) : null
const claims = (over = {}) => ({
  aud: [fakeTeam?.aud],
  email: 'verify@localhost',
  exp: nowS + 600,
  iat: nowS,
  nbf: nowS,
  iss: `https://${fakeTeam?.teamDomain}`,
  type: 'app',
  sub: 'verify',
  ...over
})
const header = (over = {}) => ({ alg: 'RS256', kid: fakeTeam?.kid, typ: 'JWT', ...over })
const signedToken = fakeTeam ? mint(teamKey, header(), claims()) : null
const ACCESS = signedToken
  ? { 'cf-access-jwt-assertion': signedToken }
  : withAccess
    ? { 'cf-access-authenticated-user-email': 'verify@localhost' }
    : {}
/** The same headers as raw request lines, for the hand-written handshakes. */
const accessLines = (headers = ACCESS) =>
  Object.entries(headers)
    .map(([k, v]) => `${k}: ${v}\r\n`)
    .join('')

if (!key || (configuredAt > 0 && !fakeTeam)) {
  console.error(
    'usage: node scripts/verify-remote-security.mjs <baseUrl> <token> [--access | --access-configured <keyfile>]\n' +
      '  --access                       forge the email header, for a presence-only instance\n' +
      '  --access-configured <keyfile>  sign real tokens with the fake team from --serve-fake-access'
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

/*
 * Phone contract point 1: the shell embeds no data, so it is served with no
 * key at all — a phone has to be able to load SOMETHING before it has one to
 * send. Every /api/* route stays exactly as gated as it was.
 */
console.log('\nthe shell is public; every API and socket stays gated')
check('the app shell needs no key', 200, await status('/'))
check('an unknown non-api path still falls to the shell, not a 401', 200, await status('/session/does-not-exist'))
check('the manifest needs no key', 200, await status('/manifest.webmanifest'))
check('/api/sessions is still gated', 401, await status('/api/sessions'))
check('/api/host is still gated', 401, await status('/api/host'))
check('/api/theme is still gated', 401, await status('/api/theme'))
{
  // No key at all, not even a bad one — the shell must carry no session data
  // for anyone who merely loads the page without ever authenticating.
  const res = await fetch(`${base}/`, { headers: ACCESS, signal: AbortSignal.timeout(20_000) })
  const body = await res.text()
  check('the public shell names no project path', false, /\/(Users|home)\//i.test(body))
}

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
 * Once the shell went public, the cookie was built from ANY ?k: a stranger
 * could navigate the phone to /?k=garbage and overwrite its working 90-day
 * cookie, logging it out. Only a key that authorised the request is stored.
 */
console.log('\na wrong key is never stored')
try {
  const res = await fetch(`${base}/?k=${'x'.repeat(key.length)}`, {
    headers: ACCESS,
    signal: AbortSignal.timeout(20_000)
  })
  check('the shell still loads for a wrong key', 200, res.status)
  check('with no set-cookie', null, res.headers.get('set-cookie'))
} catch (e) {
  console.log(`  FAIL  could not fetch the shell — ${e.message}`)
  fail++
}

/*
 * Raw socket rather than fetch: Connection and Upgrade are forbidden header
 * names, so fetch throws a TypeError before the request leaves the process and
 * the check silently never runs.
 */
async function handshakeStatus(origin, access = ACCESS, withKey = true) {
  const { connect } = await import('node:net')
  const { hostname, port } = new URL(base)
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) }, () => {
      socket.write(
        `GET /ws?ptyId=x${withKey ? `&k=${key}` : ''} HTTP/1.1\r\n` +
          `Host: ${hostname}:${port}\r\n` +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          (origin ? `Origin: ${origin}\r\n` : '') +
          accessLines(access) +
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

/*
 * /ws/events (phone contract point 4) is gated exactly like the pty socket —
 * same `handleUpgrade`, no path-based exemption — so the same two checks
 * apply to it.
 */
async function eventsHandshakeStatus(withKey, access = ACCESS) {
  const { connect } = await import('node:net')
  const { hostname, port } = new URL(base)
  return new Promise((resolve) => {
    const socket = connect({ host: hostname, port: Number(port) }, () => {
      socket.write(
        `GET /ws/events${withKey ? `?k=${key}` : ''} HTTP/1.1\r\n` +
          `Host: ${hostname}:${port}\r\n` +
          'Connection: Upgrade\r\nUpgrade: websocket\r\n' +
          'Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n' +
          accessLines(access) +
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

console.log('\n/ws/events is gated like the pty socket')
check('no key is refused', 401, await eventsHandshakeStatus(false))
check('the key authenticates', 101, await eventsHandshakeStatus(true))

/*
 * Access verified (gotcha 124). Every forgery below HOLDS THE KEY, so it must
 * be refused by the Access check and by nothing else — and SAY so: 403 with
 * `refused: 'access'`, never the key's 401, because the phone reads a 401 as
 * "your key was replaced". Before verification, the first of these — the email
 * header alone — was exactly what --access sent, and it passed. Before the
 * review of it, every refusal here was a 401.
 */
if (fakeTeam) {
  console.log('\nCloudflare Access is verified, not just present (gotcha 124)')
  const REFUSED = '403 access'
  /** `403 access` for an Access refusal the phone can read, else the bare status. */
  const withHeaders = async (headers) => {
    try {
      const res = await fetch(`${base}/api/projects?k=${key}`, {
        headers: { ...ACCESS, ...headers },
        signal: AbortSignal.timeout(20_000)
      })
      if (res.status !== 403) return res.status
      const body = await res.json().catch(() => null)
      return body?.refused === 'access' && typeof body.error === 'string' && body.error ? REFUSED : 403
    } catch (e) {
      return `error:${e.name}`
    }
  }
  // `status` spreads ACCESS first; an empty assertion overrides the valid one.
  const only = (headers) => ({ 'cf-access-jwt-assertion': '', ...headers })
  const throwaway = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
  const [h, p] = signedToken.split('.')
  const pem = createPublicKey(teamKey).export({ format: 'pem', type: 'spki' })
  const hsInput = `${b64(header({ alg: 'HS256' }))}.${p}`

  check('a signed token and the key are served', 200, await withHeaders({}))
  check('the key alone, with no Access token, is refused', REFUSED, await withHeaders(only({})))
  check(
    'the key and a forged Cf-Access-Authenticated-User-Email are refused',
    REFUSED,
    await withHeaders(only({ 'cf-access-authenticated-user-email': 'verify@localhost' }))
  )
  check('a garbage assertion is refused', REFUSED, await withHeaders({ 'cf-access-jwt-assertion': 'garbage' }))
  check(
    'a well-formed RS256 token from a key the team does not hold is refused',
    REFUSED,
    await withHeaders({ 'cf-access-jwt-assertion': mint(throwaway, header(), claims()) })
  )
  check(
    'and under a kid the team does not publish',
    REFUSED,
    await withHeaders({ 'cf-access-jwt-assertion': mint(throwaway, header({ kid: 'not-a-team-kid' }), claims()) })
  )
  check('alg none is refused', REFUSED, await withHeaders({ 'cf-access-jwt-assertion': `${b64(header({ alg: 'none' }))}.${p}.AAAA` }))
  check(
    'HS256 keyed with the public key is refused',
    REFUSED,
    await withHeaders({ 'cf-access-jwt-assertion': `${hsInput}.${createHmac('sha256', pem).update(hsInput).digest('base64url')}` })
  )
  check(
    'an expired token is refused',
    REFUSED,
    await withHeaders({ 'cf-access-jwt-assertion': mint(teamKey, header(), claims({ exp: nowS - 3600, iat: nowS - 4000, nbf: nowS - 4000 })) })
  )
  check('a token for another application is refused', REFUSED, await withHeaders({ 'cf-access-jwt-assertion': mint(teamKey, header(), claims({ aud: ['f'.repeat(64)] })) }))
  check(
    'a token naming another team as issuer is refused',
    REFUSED,
    await withHeaders({ 'cf-access-jwt-assertion': mint(teamKey, header(), claims({ iss: 'https://evil.cloudflareaccess.com' })) })
  )
  check('a payload edited after signing is refused', REFUSED, await withHeaders({ 'cf-access-jwt-assertion': `${h}.${b64(claims({ email: 'x@evil.example' }))}.${signedToken.split('.')[2]}` }))
  check('a signed token WITHOUT the key is still refused: Access is not the key', 401, await status('/api/projects'))

  {
    /*
     * The key matched, so it IS stored: the sender already holds it, and every
     * later call still has to pass Access. Withholding it was half the bug — the
     * phone's next call carried no key, got 401, and blamed the key.
     */
    const forgedOnly = { 'cf-access-authenticated-user-email': 'verify@localhost' }
    const res = await fetch(`${base}/?k=${key}`, { headers: forgedOnly, signal: AbortSignal.timeout(20_000) })
    check('the shell still loads for a forged header', 200, res.status)
    const cookie = res.headers.get('set-cookie') ?? ''
    check('and the matched key is stored as the cookie', true, cookie.startsWith(`stoke_key=${encodeURIComponent(key)};`))
    // What the phone's next call looks like: the cookie, no ?k, the same forgery.
    const next = await fetch(`${base}/api/host`, {
      headers: { ...forgedOnly, cookie: cookie.split(';')[0] },
      signal: AbortSignal.timeout(20_000)
    })
    const body = await next.json().catch(() => null)
    check("so the phone's next call hears Access, not the key: 403", 403, next.status)
    check('  with refused: access', 'access', body?.refused)
    check('  and a sentence that tells no key story', false, /replaced|not accepted|isn.t current/i.test(body?.error ?? 'replaced'))
    const wrong = 'x'.repeat(key.length)
    const wrongShell = await fetch(`${base}/?k=${wrong}`, { headers: forgedOnly, signal: AbortSignal.timeout(20_000) })
    const wrongApi = await fetch(`${base}/api/host?k=${wrong}`, { headers: forgedOnly, signal: AbortSignal.timeout(20_000) })
    check('a wrong key with the same forgery is still the key: no cookie, 401', 'null 401', `${wrongShell.headers.get('set-cookie')} ${wrongApi.status}`)
  }

  const forged = { 'cf-access-authenticated-user-email': 'verify@localhost' }
  // Sockets: 403 for Access, 401 only for the key — the same split as HTTP.
  check('the pty socket refuses the key with a forged email header, 403', 403, await handshakeStatus(null, forged))
  check('the pty socket refuses a throwaway-key token, 403', 403, await handshakeStatus(null, { 'cf-access-jwt-assertion': mint(throwaway, header(), claims()) }))
  check('the pty socket takes a signed token and the key', 101, await handshakeStatus(null))
  check('but not a signed token without the key: that is the key, 401', 401, await handshakeStatus(null, ACCESS, false))
  check('/ws/events refuses the key with a forged email header, 403', 403, await eventsHandshakeStatus(true, forged))
  check('/ws/events takes a signed token and the key', 101, await eventsHandshakeStatus(true))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
