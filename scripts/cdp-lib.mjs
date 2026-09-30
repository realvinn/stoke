/*
 * The Chrome DevTools Protocol plumbing every script that drives a running
 * Stoke shares: list the page targets, attach to one, evaluate, screenshot.
 *
 * Two callers today, and one rule they must not each get wrong on their own:
 *
 *   scripts/cdp-eval.mjs   one expression per process, from a shell
 *   scripts/probe-e2e.mts  the CI probe, which drives a packaged app through
 *                          a whole session and needs BOTH Stoke's renderer and
 *                          the docked browser's page
 *
 * The rule is gotcha 6. Stoke's renderer is picked out of the page targets by
 * evaluating `typeof window.stoke`, never by URL: the docked browser is a page
 * target too, and it exists precisely so the user can point it at a local dev
 * server or a `file://` page, so `localhost:<port>`, `/index.html` and
 * `file://` are all URLs it legitimately shows. contextBridge is injected into
 * the renderer only, which is why it is the one reliable discriminator. The
 * docked browser's pages are therefore "a page target WITHOUT window.stoke",
 * narrowed by whatever the caller knows (its URL), never the other way round.
 *
 * Node 24's global `fetch`; `ws` for the socket, as cdp-eval.mjs always used.
 * No other dependency, so it runs anywhere `npm ci` has.
 */
import { writeFileSync } from 'node:fs'
import WebSocket from 'ws'

/**
 * A few seconds is long enough for a live renderer to answer and short enough
 * that a stalled target (dead socket, blocked main thread, quit mid-evaluate)
 * fails fast instead of hanging on a live handle until the caller's own
 * timeout kills the process.
 */
export const CDP_TIMEOUT_MS = 5000

/** What makes a page target Stoke's renderer (gotcha 6). */
export const IS_STOKE_EXPR = 'typeof window.stoke === "object" && typeof window.stoke.platform === "string"'

/** Every target the endpoint lists. Throws with the port named when nothing answers. */
export async function listTargets(port) {
  let res
  try {
    res = await fetch(`http://127.0.0.1:${port}/json/list`)
  } catch {
    throw new Error(`No CDP endpoint on port ${port}. Launch the app with --remote-debugging-port=${port} first.`)
  }
  return res.json()
}

/**
 * The page targets, split by whether they can be attached to at all.
 *
 * Chromium omits webSocketDebuggerUrl for a target that already has a
 * debugger attached — most commonly DevTools open on it. Losing that target
 * silently would make an already-running renderer look absent, so it is
 * returned separately and named in any "not found" message.
 */
export function splitPages(targets) {
  const all = targets.filter((t) => t.type === 'page')
  return { pages: all.filter((t) => t.webSocketDebuggerUrl), noDebuggerUrl: all.filter((t) => !t.webSocketDebuggerUrl) }
}

/** Resolves once the socket opens; rejects on error or after `timeoutMs`. */
function openSocket(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`timed out after ${timeoutMs}ms opening the socket`))
    }, timeoutMs)
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

/** One attached target: requests matched back by id, events by method. */
export class CdpClient {
  /** @param {WebSocket} ws @param {{ url: string }} page */
  constructor(ws, page) {
    this.ws = ws
    this.page = page
    this.nextId = 1
    this.listeners = new Map()
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      if (msg.id !== undefined || !msg.method) return
      for (const cb of this.listeners.get(msg.method) ?? []) cb(msg.params ?? {})
    })
  }

  /** Attach to one page target. */
  static async open(page, { timeoutMs = CDP_TIMEOUT_MS } = {}) {
    const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
    try {
      await openSocket(ws, timeoutMs)
    } catch (e) {
      ws.terminate()
      throw e
    }
    return new CdpClient(ws, page)
  }

  /** Subscribe to a CDP event (enable its domain first). Returns the unsubscribe. */
  on(method, cb) {
    const set = this.listeners.get(method) ?? new Set()
    set.add(cb)
    this.listeners.set(method, set)
    return () => set.delete(cb)
  }

  /**
   * One request. Rejects on an error reply, on the socket closing or erroring
   * before a reply arrives, or after `timeoutMs` — so a target that goes
   * silent mid-evaluate (app quit, page reload, blocked main thread) fails
   * this call instead of leaving the promise, and the process, hanging.
   */
  send(method, params = {}, { timeoutMs = CDP_TIMEOUT_MS } = {}) {
    const ws = this.ws
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a reply to ${method}`))
      }, timeoutMs)
      const onMessage = (raw) => {
        let msg
        try {
          msg = JSON.parse(String(raw))
        } catch {
          return
        }
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
      try {
        ws.send(JSON.stringify({ id, method, params }))
      } catch (e) {
        cleanup()
        reject(e)
      }
    })
  }

  /**
   * Evaluate an expression and hand back its value (by value, so it must be
   * JSON-able). A promise is awaited first. A thrown exception rejects with
   * the page's own description of it.
   */
  async evaluate(expression, { timeoutMs = CDP_TIMEOUT_MS } = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      { timeoutMs }
    )
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result.value
  }

  /**
   * A PNG of what the page painted, written to `file`. Never with a `clip`:
   * DevTools emulates the viewport for one, which ends any pointer drag in
   * progress (CLAUDE.md, standing traps). And it hangs while the window is
   * occluded, which is why every launch that screenshots carries
   * `--disable-backgrounding-occluded-windows`.
   */
  async screenshot(file, { timeoutMs = 15_000 } = {}) {
    const result = await this.send('Page.captureScreenshot', { format: 'png' }, { timeoutMs })
    writeFileSync(file, Buffer.from(result.data, 'base64'))
    return file
  }

  close() {
    try {
      this.ws.close()
    } catch {
      /* already gone */
    }
  }
}

/**
 * Attach to the first page target for which `accept(client, page)` answers
 * true, trying each in turn. `accept` may evaluate in the page (that is the
 * point: gotcha 6's test is an evaluation). Rejects with every attempt named
 * when none matches.
 */
export async function connectPage(port, accept, { what = 'a matching page', timeoutMs = CDP_TIMEOUT_MS } = {}) {
  const { pages, noDebuggerUrl } = splitPages(await listTargets(port))
  const attempts = []
  for (const page of pages) {
    let client = null
    try {
      client = await CdpClient.open(page, { timeoutMs })
      if (await accept(client, page)) return client
    } catch (e) {
      attempts.push(`${page.url}: ${e instanceof Error ? e.message : String(e)}`)
    }
    client?.close()
  }
  const lines = [`No ${what} among ${pages.length} page target(s) with a debugger URL.`]
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
  const err = new Error(lines.join('\n'))
  err.code = 'NO_TARGET'
  throw err
}

/** Stoke's own renderer: the page holding the `window.stoke` contextBridge object. */
export function connectStoke(port, opts = {}) {
  return connectPage(port, (client) => client.evaluate(IS_STOKE_EXPR), { what: 'Stoke renderer', ...opts })
}

/**
 * A page that is NOT Stoke's renderer and whose URL passes `urlTest` — a tab
 * of the docked browser. The URL narrows; the missing `window.stoke` decides.
 */
export function connectBrowserPage(port, urlTest, opts = {}) {
  return connectPage(
    port,
    async (client, page) => urlTest(page.url) && !(await client.evaluate(IS_STOKE_EXPR)),
    { what: 'docked-browser page', ...opts }
  )
}
