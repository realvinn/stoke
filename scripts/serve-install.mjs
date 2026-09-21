/*
 * The one-line installer endpoint, served locally from THIS checkout.
 *
 *   node scripts/serve-install.mjs [port]      default 8787, 127.0.0.1 only
 *
 * The Worker at stoke.vinn.dev serves install/ as it was at the last
 * `npm run deploy:install`, so a test that pipes `irm https://stoke.vinn.dev`
 * into PowerShell exercises the DEPLOYED script, not the one in the branch under
 * test. This serves the files in install/ as they are on disk, chosen by the
 * Worker's own `routeFor` — the same pure function worker/index.ts calls — so
 * `irm http://127.0.0.1:8787 | iex` takes exactly the route a real one-liner
 * takes, User-Agent sniffing included, against the code being changed.
 *
 * It is what the Windows workflow (.github/workflows/windows.yml) runs the
 * installer against from cmd, Windows PowerShell, PowerShell 7 and Git Bash.
 * There is deliberately no https and no redirect here: `httpsRedirect` is the
 * Worker's business and is held by verify:install.
 *
 * One rewrite, and only one: install.sh's Git Bash handoff fetches install.ps1
 * from a hard-coded `STOKE_PS1_URL` (https://stoke.vinn.dev/install.ps1), so
 * served verbatim it made the Git Bash leg run the DEPLOYED install.ps1 — the
 * exact thing this server exists to avoid. It went unnoticed until a fix to
 * install.ps1 "did not work" from Git Bash only (Windows workflow, run
 * 35568658784). That one assignment is pointed back at this server; the
 * shipped script keeps its URL and gains no override a user could be tricked
 * into setting. The server refuses to start if the line is not there to rewrite.
 *
 * Files are read per request, so editing install.ps1 while this runs is picked
 * up by the next `irm`. Once the listener is up, "listening <url>" is printed on
 * stdout, so a caller can wait for that line instead of guessing with a sleep.
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// Node strips the types itself (22.18+ by default; the repo runs every suite
// this way). Relative with the extension, because nothing here resolves aliases.
import { contentTypeFor, routeFor } from '../worker/route.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const FILES = { sh: 'install/install.sh', ps1: 'install/install.ps1', html: 'install/index.html' }
const port = Number(process.argv[2] ?? 8787)
const PS1_URL_LINE = "STOKE_PS1_URL='https://stoke.vinn.dev/install.ps1'"

/** install.sh with its handoff pointed at this server (see the header). */
function localSh(body) {
  const text = body.toString('utf8')
  if (!text.includes(PS1_URL_LINE)) {
    throw new Error(`install.sh no longer contains ${PS1_URL_LINE} — update serve-install.mjs, or the Git Bash leg tests the deployed install.ps1`)
  }
  return Buffer.from(text.replace(PS1_URL_LINE, `STOKE_PS1_URL='http://127.0.0.1:${port}/install.ps1'`), 'utf8')
}
localSh(readFileSync(join(root, FILES.sh)))

const server = createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' })
    res.end('Only GET.\n')
    return
  }
  const headers = {}
  for (const [name, value] of Object.entries(req.headers)) {
    headers[name] = Array.isArray(value) ? value.join(', ') : value
  }
  const route = routeFor(`http://127.0.0.1:${port}${req.url ?? '/'}`, headers)
  const raw = readFileSync(join(root, FILES[route.body]))
  const body = route.body === 'sh' ? localSh(raw) : raw
  // One line per request, so a CI log shows which body each shell was handed
  // and why — the question every "the installer printed HTML" report starts with.
  console.log(`${req.method} ${req.url} -> ${route.body} (${route.why}) ua=${JSON.stringify(headers['user-agent'] ?? '')}`)
  res.writeHead(200, { 'content-type': contentTypeFor(route.body), 'content-length': body.length, 'cache-control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : body)
})

server.listen(port, '127.0.0.1', () => {
  console.log(`listening http://127.0.0.1:${port}`)
})
