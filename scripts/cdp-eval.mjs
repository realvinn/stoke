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
 * object. Matching on URL is NOT enough: the docked browser is its own page
 * target (gotcha 6) and it exists precisely so the user can point it at a local
 * dev server or a file:// page, so `localhost:<port>`, `/index.html` and
 * `file://` are all URLs it legitimately shows. contextBridge is injected into
 * the renderer only, which is why it is the one reliable discriminator.
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
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'

// A few seconds is long enough for a live renderer to answer and short enough
// that a stalled target (dead socket, blocked main thread, quit mid-evaluate)
// fails fast instead of hanging on a live handle until the caller's own
// timeout kills the process.
const CDP_TIMEOUT_MS = 5000

const port = process.env.CDP_PORT || '9222'
const argv = process.argv.slice(2)
const wantsShot = argv[0] === '--shot'
const arg = wantsShot ? argv[1] : argv.join(' ')

if (!arg) {
  console.error('usage: node scripts/cdp-eval.mjs "<javascript expression>"')
  console.error('       node scripts/cdp-eval.mjs --shot <file.png>')
  process.exit(2)
}

let targets
try {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`)
  targets = await res.json()
} catch {
  console.error(
    `No CDP endpoint on port ${port}. Launch the app with --remote-debugging-port=${port} first.`
  )
  process.exit(1)
}

/** Resolves once the socket opens; rejects on error or after CDP_TIMEOUT_MS. */
function openSocket(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out after ${CDP_TIMEOUT_MS}ms opening the socket`))
    }, CDP_TIMEOUT_MS)
    const onOpen = () => {
      cleanup()
      resolve()
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    // Removing both listeners on settle matters as much as adding the
    // timeout: left attached, this same `onError` would still be listening
    // on the winning socket during the later send() calls and would consume
    // a real mid-evaluate error before send()'s own handler ever saw it.
    function cleanup() {
      clearTimeout(timer)
      ws.off('open', onOpen)
      ws.off('error', onError)
    }
    ws.once('open', onOpen)
    ws.once('error', onError)
  })
}

/**
 * One request, matched back by id — replies and events share the socket.
 * Rejects on a matching error reply, on the socket closing or erroring before
 * a reply arrives, or after CDP_TIMEOUT_MS — so a target that goes silent
 * mid-evaluate (app quit, page reload, blocked main thread) fails this call
 * instead of leaving the promise, and the process, hanging forever.
 */
function send(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out after ${CDP_TIMEOUT_MS}ms waiting for a reply to ${method}`))
    }, CDP_TIMEOUT_MS)
    const onMessage = (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.id !== id) return
      cleanup()
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
    const onClose = () => {
      cleanup()
      reject(new Error(`socket closed while waiting for a reply to ${method}`))
    }
    const onError = (err) => {
      cleanup()
      reject(err)
    }
    function cleanup() {
      clearTimeout(timer)
      ws.off('message', onMessage)
      ws.off('close', onClose)
      ws.off('error', onError)
    }
    ws.on('message', onMessage)
    ws.once('close', onClose)
    ws.once('error', onError)
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evaluate(ws, id, expression) {
  const result = await send(ws, id, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  }
  return result.result.value
}

const allPages = targets.filter((t) => t.type === 'page')
// Chromium omits webSocketDebuggerUrl for a target that already has a
// debugger attached — most commonly DevTools open on it. Losing that target
// silently here would make an already-running renderer look absent, so it is
// tracked separately and named explicitly if nothing else matches.
const pages = allPages.filter((t) => t.webSocketDebuggerUrl)
const noDebuggerUrl = allPages.filter((t) => !t.webSocketDebuggerUrl)

let hit = null
let hitPage = null
const attempts = []

for (const page of pages) {
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
  try {
    await openSocket(ws)
    const isStoke = await evaluate(
      ws,
      1,
      'typeof window.stoke === "object" && typeof window.stoke.platform === "string"'
    )
    if (isStoke) {
      hit = ws
      hitPage = page
      break
    }
  } catch (e) {
    attempts.push(`${page.url}: ${e instanceof Error ? e.message : String(e)}`)
  }
  ws.close()
}

if (!hit) {
  const lines = [`No Stoke renderer among ${pages.length} page target(s) with a debugger URL.`]
  if (attempts.length) {
    lines.push('Attempts:')
    for (const a of attempts) lines.push(`  - ${a}`)
  }
  if (noDebuggerUrl.length) {
    lines.push(
      `${noDebuggerUrl.length} more page target(s) had no webSocketDebuggerUrl and could not be ` +
        `tried at all — Chromium omits it when a debugger is already attached to that target, ` +
        `most likely DevTools open on it: ${noDebuggerUrl.map((p) => p.url).join(', ')}`
    )
  }
  console.error(lines.join('\n'))
  process.exit(1)
}

// Always on stderr, never stdout: makes a wrong-target attachment obvious at
// a glance without disturbing the measured value a caller is capturing.
console.error(`Attached to Stoke renderer: ${hitPage.url}`)

try {
  if (wantsShot) {
    const result = await send(hit, 2, 'Page.captureScreenshot', { format: 'png' })
    writeFileSync(arg, Buffer.from(result.data, 'base64'))
    console.log(arg)
  } else {
    const value = await evaluate(
      hit,
      2,
      `Promise.resolve((() => (${arg}))()).then((v) => JSON.stringify(v))`
    )
    console.log(value)
  }
} catch (e) {
  console.error(String(e instanceof Error ? e.message : e))
  hit.close()
  process.exit(1)
}

hit.close()
