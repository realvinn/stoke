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
 * The expression may be async; its promise is awaited before the value is
 * serialised, which is what lets a measurement dispatch an event and then read
 * the DOM React rendered in response. The page does the stringifying, so output
 * is compact JSON on one line.
 *
 * Deliberately not part of `npm run check`: it needs a live window.
 * Exit codes: 0 success; 1 no endpoint, no renderer, or the expression threw;
 * 2 usage error.
 */
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'

const port = process.env.CDP_PORT ?? '9222'
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

/** One request, matched back by id — replies and events share the socket. */
function send(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.id !== id) return
      ws.off('message', onMessage)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
    ws.on('message', onMessage)
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

const pages = targets.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl)
let hit = null

for (const page of pages) {
  const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
  try {
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    const isStoke = await evaluate(
      ws,
      1,
      'typeof window.stoke === "object" && typeof window.stoke.platform === "string"'
    )
    if (isStoke) {
      hit = ws
      break
    }
  } catch {
    /* a target that will not talk is not the renderer */
  }
  ws.close()
}

if (!hit) {
  console.error(
    `No Stoke renderer among ${pages.length} page target(s): ` +
      `${pages.map((p) => p.url).join(', ') || 'none'}`
  )
  process.exit(1)
}

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
