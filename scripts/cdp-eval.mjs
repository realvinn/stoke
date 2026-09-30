/*
 * Evaluate one expression inside Stoke's own renderer, or screenshot it.
 *
 *   npm run build
 *   npx electron . --remote-debugging-port=9222 &
 *   node scripts/cdp-eval.mjs "getComputedStyle(document.body).lineHeight"
 *   node scripts/cdp-eval.mjs --shot /tmp/stoke.png
 *
 * Why this exists: every alignment defect in the UX overhaul was established by
 * measuring the running app, and none of them is visible any other way — the
 * terminal is a WebGL canvas so its DOM is empty (CLAUDE.md gotcha 5) and the
 * CSS reads correct while laying out wrong (gotcha 14).
 *
 * Page targets are filtered to the one holding a `window.stoke` contextBridge
 * object, never matched on URL (gotcha 6) — that rule, and the socket
 * plumbing, live in scripts/cdp-lib.mjs, which the CI probe
 * (scripts/probe-e2e.mts) drives the app through too. This file is the thin
 * one-expression CLI over it.
 *
 * The expression is wrapped as `(() => (<expr>))()`, so it must be a single
 * expression — the `await` keyword cannot appear (the wrapper arrow function is
 * not async) and a sequence of statements is a syntax error. What IS supported
 * is an expression that *evaluates to* a promise: it is awaited via CDP's
 * awaitPromise before the value is serialised, which is what lets a
 * measurement dispatch an event and then read the DOM React rendered in
 * response, e.g.:
 *
 *   node scripts/cdp-eval.mjs 'new Promise(r => requestAnimationFrame(() => r(measure())))'
 *
 * (single-quote the expression in bash when it contains a template literal —
 * the expression is one argv element, and backticks would otherwise be
 * consumed by the shell instead of reaching node). The page does the
 * stringifying, so output is compact JSON on one line.
 *
 * Deliberately not part of `npm run check`: it needs a live window.
 * Exit codes: 0 success; 1 no endpoint, no renderer, or the expression threw;
 * 2 usage error.
 */
import { connectStoke } from './cdp-lib.mjs'

const port = process.env.CDP_PORT || '9222'
const argv = process.argv.slice(2)
const wantsShot = argv[0] === '--shot'
const arg = wantsShot ? argv[1] : argv.join(' ')

if (!arg) {
  console.error('usage: node scripts/cdp-eval.mjs "<javascript expression>"')
  console.error('       node scripts/cdp-eval.mjs --shot <file.png>')
  process.exit(2)
}

let client
try {
  client = await connectStoke(port)
} catch (e) {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
}

// Always on stderr, never stdout: makes a wrong-target attachment obvious at
// a glance without disturbing the measured value a caller is capturing.
console.error(`Attached to Stoke renderer: ${client.page.url}`)

try {
  if (wantsShot) {
    console.log(await client.screenshot(arg))
  } else {
    console.log(await client.evaluate(`Promise.resolve((() => (${arg}))()).then((v) => JSON.stringify(v))`))
  }
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e))
  client.close()
  process.exit(1)
}

client.close()
