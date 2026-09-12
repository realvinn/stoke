/**
 * Which of the three bodies `stoke.vinn.dev` serves a given request.
 *
 * Pure and import-free on purpose, the same way `src/shared/paths.ts` and
 * `src/shared/drop.ts` are: `scripts/verify-install.mts` imports it under
 * `node --experimental-strip-types` and runs the whole User-Agent matrix
 * against it. The Worker itself (`worker/index.ts`) does nothing but call this
 * and pick a string, so the only part with a decision in it is the part a suite
 * can hold. Gotcha 31 is the reason: the rule below is otherwise a side effect
 * inside a request handler nobody local can invoke.
 *
 * The order of the tests is the whole design, and one of them is load-bearing
 * enough to state twice: **PowerShell's User-Agent starts with `Mozilla/5.0`.**
 * Its own source builds it as `{Compatibility} ({PlatformName}; {OS};
 * {Culture}) {App}` where `Compatibility` is the literal string `Mozilla/5.0`
 * and `App` is `PowerShell/7.5.0` or `WindowsPowerShell/5.1.x`. So the obvious
 * rule — "contains Mozilla, therefore a browser" — hands `irm | iex` an HTML
 * page, and PowerShell's parse error on HTML reads like a broken installer
 * rather than like a content-negotiation bug. The PowerShell test therefore
 * runs before anything browser-shaped, and is a case-insensitive SUBSTRING test
 * so that `WindowsPowerShell` matches it too.
 *
 * The fallback is HTML and must stay HTML. An unknown client is far more likely
 * to be a crawler or a link-preview bot — Slack, Discord and iMessage all fetch
 * this URL the moment somebody pastes it — than a shell. Serving executable
 * text to anything you failed to identify is the wrong direction to fail in.
 */

/** The three bodies. Nothing else is ever served from this hostname. */
export type InstallerBody = 'sh' | 'ps1' | 'html'

/** A body, plus why it was chosen. The reason is asserted, not decorative. */
export interface Route {
  body: InstallerBody
  /**
   * Which rule fired. `verify:install` asserts this as well as the body, so a
   * case that starts passing for the wrong reason — a browser served HTML by
   * the fallback rather than by the Accept test — is a failure rather than a
   * coincidence that holds until the next change.
   */
  why:
    | 'query override'
    | 'explicit path'
    | 'powershell user-agent'
    | 'cli downloader user-agent'
    | 'browser navigation'
    | 'fallback'
}

/**
 * Headers as the Worker hands them over: lowercase names, as the Fetch API
 * guarantees when iterating a `Headers`. A missing header is `undefined` and
 * every test below treats that as "said nothing", never as a match.
 */
export type RouteHeaders = Record<string, string | undefined>

/** `?sh`, `?ps1`, `?html` — present with any value, or none. */
function queryOverride(search: string): InstallerBody | null {
  // Parsed by hand rather than with URLSearchParams so this module keeps
  // working identically for `?ps1` (a bare key, no `=`), which is the form the
  // landing page documents and the form somebody types from memory.
  for (const part of search.replace(/^\?/, '').split('&')) {
    const key = part.split('=')[0]
    if (key === 'sh' || key === 'ps1' || key === 'html') return key
  }
  return null
}

/**
 * The stable, readable paths. These exist so the one-liner is auditable —
 * anybody can `curl https://stoke.vinn.dev/install.sh | less` before piping
 * anything to a shell — and so a machine behind a User-Agent-rewriting proxy
 * has a route that does not depend on sniffing at all.
 */
function pathOverride(pathname: string): InstallerBody | null {
  if (pathname === '/install.sh') return 'sh'
  if (pathname === '/install.ps1') return 'ps1'
  if (pathname === '/index.html') return 'html'
  return null
}

/**
 * The rule. `url` is the full request URL; `headers` are its headers with
 * lowercase names.
 *
 * Unknown paths deliberately fall through to negotiation rather than 404ing:
 * this hostname serves one thing, and a trailing slash, a `/favicon.ico` from a
 * preview bot or a typo should all end up at the landing page rather than at an
 * error. Nothing here ever serves a script to a path it did not recognise —
 * that decision belongs entirely to the User-Agent tests below.
 */
export function routeFor(url: string, headers: RouteHeaders): Route {
  const parsed = new URL(url)

  // 1. Explicit wins, always. Both forms are documented on the landing page,
  //    and both are the escape hatch for every failure mode below — a corporate
  //    MITM proxy rewriting User-Agent being the one with no other answer.
  const forcedByQuery = queryOverride(parsed.search)
  if (forcedByQuery) return { body: forcedByQuery, why: 'query override' }
  const forcedByPath = pathOverride(parsed.pathname)
  if (forcedByPath) return { body: forcedByPath, why: 'explicit path' }

  const ua = headers['user-agent'] ?? ''

  // 2. PowerShell, before anything that could read its `Mozilla/5.0` prefix as
  //    a browser. Matches `PowerShell/7.5.0` and `WindowsPowerShell/5.1.17763`.
  if (/powershell/i.test(ua)) return { body: 'ps1', why: 'powershell user-agent' }

  // 3. The command-line downloaders. `curl/8.7.1` and `Wget/1.21.4 (darwin)`
  //    are the two that matter; HTTPie and BSD fetch are free.
  //
  //    curl.exe on Windows lands here and gets the POSIX script, and there is
  //    no header that separates it from curl on Linux — every Windows 10 1803+
  //    ships it and plenty of people type `curl` reflexively. That case is
  //    handled in `install/install.sh` itself, which detects MINGW/MSYS/CYGWIN
  //    and `$OS = Windows_NT` and prints the PowerShell one-liner instead of
  //    proceeding. The mirror image (`pwsh` on macOS getting the .ps1) is
  //    handled the same way in `install/install.ps1`.
  if (/\b(curl|wget|httpie|fetch|aria2)\//i.test(ua)) {
    return { body: 'sh', why: 'cli downloader user-agent' }
  }

  // 4. A browser. Fetch Metadata first, because neither curl nor PowerShell
  //    ever sends `Sec-Fetch-*` — then `Accept: text/html`, which is what
  //    catches Safari older than 16.4.
  const fetchMode = headers['sec-fetch-mode'] ?? ''
  const accept = headers['accept'] ?? ''
  if (fetchMode === 'navigate' || accept.includes('text/html')) {
    return { body: 'html', why: 'browser navigation' }
  }

  // 5. Anything unidentified: the page, never a script.
  return { body: 'html', why: 'fallback' }
}

/**
 * The Content-Type for a body.
 *
 * `text/plain; charset=utf-8` for both scripts is a requirement rather than a
 * default. `Invoke-RestMethod` deserializes a JSON or XML content type into a
 * `[pscustomobject]` before `iex` ever sees it, so the one-liner would receive
 * an object instead of a script and fail in a way nobody diagnoses from the
 * error text. The charset matters for the same class of reason: the bodies must
 * arrive as the exact bytes the repo holds, with no BOM (a leading U+FEFF
 * survives into the string `iex` parses and is an "unexpected token" on line 1).
 */
export function contentTypeFor(body: InstallerBody): string {
  return body === 'html' ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8'
}

/**
 * How long the edge and the client may hold a body.
 *
 * Five minutes at most, and deliberately not more: this is the one artifact in
 * the project that has to be able to change *the day a release breaks*, and a
 * long TTL means a bad script stays live with no way to pull it.
 *
 * `Vary: User-Agent` is the obvious thing to reach for here and is a trap, which
 * is why it is written down rather than left to be rediscovered: every
 * PowerShell version times every Windows build times every locale is a distinct
 * User-Agent string, so the variant space is effectively unbounded and the cache
 * hit rate goes to zero. If edge caching is ever turned on, put the variant in
 * the cache KEY (a synthesized `https://stoke.vinn.dev/__v/ps1` request against
 * `caches.default`), which gives exactly three entries.
 *
 * `private` rather than `public`, and that is the other half of the same
 * decision. Three different bodies come back from one URL depending on the
 * User-Agent, and with no `Vary` a SHARED cache — a corporate MITM proxy, which
 * is the very thing the `?sh` override exists for — is entitled to store one of
 * them and hand it to the next client whatever it asked for. That is a shell
 * receiving the landing page, or a browser being offered a script to download.
 * `private` says only the end client may store this, and an end client has one
 * User-Agent, so the variant confusion cannot arise there. It costs nothing:
 * the edge cache this would otherwise feed is off (see wrangler.jsonc), and the
 * body is a few KB of embedded string.
 */
export const CACHE_CONTROL = 'private, max-age=300, must-revalidate'
