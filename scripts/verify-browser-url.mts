/*
 * What the docked browser will and will not load.
 *
 * Two separate things are asserted here and they fail in opposite directions.
 *
 * The first is a *capability boundary*. `browser_read` renders whatever is
 * loaded into text for the model, so whatever `browser_open` accepts is what an
 * agent can read off this machine. `normalizeUrl` used to return any
 * scheme-shaped input untouched — `if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) return
 * raw` — which made `file:///Users/you/.ssh/id_rsa` a complete exfiltration path
 * with no prompt anywhere along it. The address bar keeps `file://` because the
 * actor there is a person who typed the path; no tool call does.
 *
 * The second is the ordinary case that the first one broke on the way past.
 * `localhost:3000` MATCHES the scheme shape, so it was returned verbatim and
 * Chromium was handed a URL whose scheme was `localhost`. It failed inside
 * `loadURL`'s own swallowed `.catch`, so the single most common development
 * address in the world did nothing and said nothing. A security fix that
 * silently breaks a daily workflow is not a fix, which is why both halves are
 * in one suite.
 *
 *   node scripts/verify-browser-url.mts
 */
import { normalizeUrl, refusedScheme } from '../src/shared/url.ts'

const BAR = { allowLocalFiles: true }

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

/** A search is the refusal: it is what the address bar does with what it cannot open. */
const searched = (raw: string): string => `https://duckduckgo.com/?q=${encodeURIComponent(raw)}`

console.log('\nthe schemes an agent may open')
check('http passes', normalizeUrl('http://example.com/x'), 'http://example.com/x')
check('https passes', normalizeUrl('https://example.com/x'), 'https://example.com/x')
check('about: passes, because that is where a blank tab starts', normalizeUrl('about:blank'), 'about:blank')
check(
  'file:// does NOT — this is the whole point of the suite',
  normalizeUrl('file:///Users/you/.ssh/id_rsa'),
  searched('file:///Users/you/.ssh/id_rsa')
)
check('nor does a file:// with no host', normalizeUrl('file:/etc/passwd'), searched('file:/etc/passwd'))
check('javascript: never, on any path', normalizeUrl('javascript:alert(1)'), searched('javascript:alert(1)'))
check('data: never either', normalizeUrl('data:text/html,<h1>x'), searched('data:text/html,<h1>x'))
check('chrome:// is not the agent’s business', normalizeUrl('chrome://settings'), searched('chrome://settings'))
check('nor is devtools://', normalizeUrl('devtools://devtools/x'), searched('devtools://devtools/x'))
check('mailto: would hand the page to another app', normalizeUrl('mailto:a@b.c'), searched('mailto:a@b.c'))
check('FILE:// in capitals is the same scheme', normalizeUrl('FILE:///etc/passwd'), searched('FILE:///etc/passwd'))
check(
  'and so is a leading space, because the scheme is read after a trim',
  normalizeUrl('  file:///etc/passwd'),
  searched('file:///etc/passwd')
)

console.log('\nthe address bar, where the actor is a person who typed it')
check('file:// is allowed back in, and only here', normalizeUrl('file:///Users/me/dist/index.html', BAR), 'file:///Users/me/dist/index.html')
check('javascript: is still refused, because nobody ever means it', normalizeUrl('javascript:alert(1)', BAR), searched('javascript:alert(1)'))
check('data: likewise', normalizeUrl('data:text/html,<h1>x', BAR), searched('data:text/html,<h1>x'))

console.log('\nrefusedScheme names the scheme, so the model is told why')
check('the refused scheme comes back by name', refusedScheme('file:///etc/passwd'), 'file')
check('the address bar refuses nothing about file://', refusedScheme('file:///etc/passwd', BAR), null)
check('an allowed scheme is not a refusal', refusedScheme('https://example.com'), null)
check('a bare hostname has no scheme to refuse', refusedScheme('example.com'), null)
check('and neither does free text', refusedScheme('how tall is everest'), null)

console.log('\nhost:port is scheme-shaped and is not a scheme')
check('localhost:3000 — the case the scheme test used to eat', normalizeUrl('localhost:3000'), 'http://localhost:3000')
check('with a path', normalizeUrl('localhost:5173/app'), 'http://localhost:5173/app')
check('bare localhost still works', normalizeUrl('localhost'), 'http://localhost')
check('localhost is never reported as a refused scheme', refusedScheme('localhost:3000'), null)
check('an IPv4 host and port is unaffected', normalizeUrl('127.0.0.1:8080'), 'http://127.0.0.1:8080')
check('a LAN address too', normalizeUrl('192.168.1.10:8000/x'), 'http://192.168.1.10:8000/x')

console.log('\neverything else the address bar has always done')
check('a bare hostname becomes https', normalizeUrl('example.com'), 'https://example.com')
check('a hostname with a path', normalizeUrl('example.com/a/b'), 'https://example.com/a/b')
check('free text is searched', normalizeUrl('how tall is everest'), searched('how tall is everest'))
check('empty is a blank tab, not a search for nothing', normalizeUrl(''), 'about:blank')
check('whitespace only is also a blank tab', normalizeUrl('   '), 'about:blank')

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
