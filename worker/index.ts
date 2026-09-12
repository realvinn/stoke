/**
 * `https://stoke.vinn.dev` — the one-line installer endpoint.
 *
 * Its only job is content negotiation. Everything it can serve is EMBEDDED at
 * deploy time from `install/` by wrangler's `Text` module rule (see
 * `wrangler.jsonc`), never fetched at request time, and the decision of which
 * one to serve lives in `worker/route.ts`, which is pure and has a suite.
 *
 * Two things this Worker deliberately does NOT do.
 *
 * It does not know what the current release is. Both scripts resolve that
 * themselves at runtime from `https://github.com/realvinn/stoke/releases/latest/
 * download/latest*.yml`, which is a plain 302 needing no API token and carrying
 * no rate limit worth thinking about. So cutting a release changes nothing here
 * — no deploy, no lag, and no way for this endpoint to advertise a version that
 * does not exist. The Worker is redeployed only when the installer LOGIC
 * changes. That separation is the point: this repo has a written history of two
 * lists that must agree drifting apart (gotchas 62, 68), and a Worker on the
 * release checklist would be the next one.
 *
 * It does not fetch anything. No `fetch()` to raw.githubusercontent, which would
 * put a second network hop inside every request, make GitHub a hard dependency
 * of the install endpoint, and mean a force-push to `main` silently changes what
 * every one-liner executes with no deploy and no audit trail.
 */
import { CACHE_CONTROL, contentTypeFor, routeFor, type InstallerBody } from './route.ts'
import sh from '../install/install.sh'
import ps1 from '../install/install.ps1'
import html from '../install/index.html'

const BODIES: Record<InstallerBody, string> = { sh, ps1, html }

export default {
  fetch(request: Request): Response {
    // HEAD is a GET whose body is dropped by the runtime; anything that writes
    // is meaningless here and is refused rather than silently treated as a GET.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Only GET.\n', {
        status: 405,
        headers: { 'content-type': 'text/plain; charset=utf-8', allow: 'GET, HEAD' }
      })
    }

    const headers: Record<string, string> = {}
    for (const [name, value] of request.headers) headers[name] = value
    const route = routeFor(request.url, headers)

    return new Response(BODIES[route.body], {
      headers: {
        'content-type': contentTypeFor(route.body),
        'cache-control': CACHE_CONTROL,
        // Which rule fired, for anyone debugging why they got the wrong body.
        // A header rather than a comment inside the body, because the body has
        // to stay byte-identical to the file in the repo — that equality is
        // what makes `curl https://stoke.vinn.dev/install.sh` auditable against
        // `install/install.sh` on GitHub.
        'x-stoke-route': `${route.body} (${route.why})`,
        'referrer-policy': 'no-referrer',
        'x-content-type-options': 'nosniff'
      }
    })
  }
}
