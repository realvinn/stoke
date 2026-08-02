import type { WebContents } from 'electron'
import extractSource from './inject/extract.js?raw'
import type { EmbeddedBrowser } from '../browser.ts'
import { normalizeUrl } from '../browser.ts'

/**
 * Drives the docked page on the agent's behalf.
 *
 * Everything goes through the injected extractor rather than raw CDP: it keeps
 * element refs stable across calls and lets the representation handed back be
 * shaped for an agent (markdown, ref lists) instead of DOM dumps.
 */

export interface Signature {
  url: string
  title: string
  lines: string[]
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Read the extractor's version out of its own source rather than restating it.
 *
 * These two ends drifted once, and the symptom is silent rather than loud: the
 * guard simply never matches, so every single call re-injects the whole script
 * and the page pays for it forever.
 */
const EXTRACT_VERSION = Number(/version:\s*(\d+)/.exec(extractSource)?.[1] ?? 0)

export class PageAgent {
  private readonly browser: EmbeddedBrowser
  /** Last content signature, used to answer "what changed?" after an action. */
  private lastSignature: Signature | null = null

  constructor(browser: EmbeddedBrowser) {
    this.browser = browser
  }

  private wc(): WebContents {
    return this.browser.ensureHeadless()
  }

  /**
   * The page itself, for the analyses that go over CDP rather than through the
   * injected extractor. Design, performance and security all need computed
   * styles, traces and response metadata that no in-page script can reach.
   */
  webContents(): WebContents {
    return this.wc()
  }

  private async evaluate<T>(expression: string): Promise<T> {
    return (await this.wc().executeJavaScript(expression, true)) as T
  }

  /** The extractor is wiped by every navigation, so re-inject on demand. */
  private async ensureInjected(): Promise<void> {
    const present = await this.evaluate<boolean>(
      `typeof window.__stoke !== "undefined" && window.__stoke.version === ${EXTRACT_VERSION}`
    )
    if (!present) await this.wc().executeJavaScript(extractSource, true)
  }

  private async call<T>(fn: string, args: unknown[] = []): Promise<T> {
    await this.ensureInjected()
    const argList = args.map((a) => JSON.stringify(a === undefined ? null : a)).join(',')
    return this.evaluate<T>(`window.__stoke.${fn}(${argList})`)
  }

  /**
   * Wait until the page stops loading and its text stops growing.
   *
   * Without this the agent reads skeleton loaders and reports them as the page,
   * which is worse than waiting — it produces confidently wrong answers.
   */
  async waitForStable(timeoutMs = 10_000): Promise<{ settled: boolean }> {
    const wc = this.wc()
    const deadline = Date.now() + timeoutMs

    while (wc.isLoading() && Date.now() < deadline) await sleep(100)

    let previous = -1
    let steady = 0
    while (Date.now() < deadline && steady < 2) {
      let length = 0
      try {
        length = await this.evaluate<number>(
          'document.body ? document.body.innerText.length : 0'
        )
      } catch {
        // Mid-navigation the context is torn down; try again shortly.
      }
      // Count a stable reading even at zero, otherwise a genuinely empty page
      // burns the whole timeout on every call.
      if (length === previous) steady++
      else {
        steady = 0
        previous = length
      }
      await sleep(170)
    }

    return { settled: steady >= 2 }
  }

  async open(url: string): Promise<void> {
    const wc = this.wc()
    await wc.loadURL(normalizeUrl(url))
    await this.waitForStable()
  }

  async history(action: 'back' | 'forward' | 'reload'): Promise<void> {
    const wc = this.wc()
    if (action === 'reload') wc.reload()
    else if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) {
      wc.navigationHistory.goForward()
    }
    await this.waitForStable()
  }

  read(opts: {
    ref?: string
    section?: number
    full?: boolean
    maxChars?: number
  }): Promise<unknown> {
    return this.call('read', [opts])
  }

  outline(): Promise<unknown> {
    return this.call('outline')
  }

  snapshot(limit?: number): Promise<unknown> {
    return this.call('snapshot', [{ limit }])
  }

  find(query: string, limit?: number): Promise<unknown> {
    return this.call('find', [query, limit])
  }

  /**
   * Full pointer sequence rather than element.click(): frameworks that listen
   * for pointerdown/mouseup (menus, drag handles, custom widgets) ignore a bare
   * click event.
   */
  async click(ref: string): Promise<string> {
    await this.ensureInjected()
    const result = await this.evaluate<string>(`(() => {
      const el = window.__stoke.resolve(${JSON.stringify(ref)})
      if (!el) return 'STALE'
      window.__stoke.centreOf(el)
      const label = window.__stoke.describe(el)
      const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 }
      el.dispatchEvent(new PointerEvent('pointerdown', opts))
      el.dispatchEvent(new MouseEvent('mousedown', opts))
      if (typeof el.focus === 'function') el.focus()
      el.dispatchEvent(new PointerEvent('pointerup', opts))
      el.dispatchEvent(new MouseEvent('mouseup', opts))
      el.click()
      return label
    })()`)

    if (result === 'STALE') throw new Error(`ref ${ref} is stale — take a new snapshot first`)
    await this.waitForStable(6000)
    return result
  }

  /**
   * React (and Vue) track input values internally, so assigning `.value`
   * directly fires no change handler. Going through the prototype's native
   * setter defeats that tracking, which is the only reliable way to type into a
   * controlled component.
   */
  async type(ref: string, text: string, submit = false): Promise<string> {
    await this.ensureInjected()
    const result = await this.evaluate<string>(`(() => {
      const el = window.__stoke.resolve(${JSON.stringify(ref)})
      if (!el) return 'STALE'
      const value = ${JSON.stringify(text)}
      el.scrollIntoView({ block: 'center' })
      el.focus()

      if (el.isContentEditable) {
        el.textContent = value
        el.dispatchEvent(new InputEvent('input', { bubbles: true }))
      } else {
        const proto = el instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, value)
        else el.value = value
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }

      if (${submit ? 'true' : 'false'}) {
        const enter = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }
        el.dispatchEvent(new KeyboardEvent('keydown', enter))
        el.dispatchEvent(new KeyboardEvent('keyup', enter))
        if (el.form && typeof el.form.requestSubmit === 'function') el.form.requestSubmit()
      }
      return window.__stoke.describe(el)
    })()`)

    if (result === 'STALE') throw new Error(`ref ${ref} is stale — take a new snapshot first`)
    await this.waitForStable(6000)
    return result
  }

  async select(ref: string, value: string): Promise<string> {
    await this.ensureInjected()
    const result = await this.evaluate<string>(`(() => {
      const el = window.__stoke.resolve(${JSON.stringify(ref)})
      if (!el) return 'STALE'
      el.value = ${JSON.stringify(value)}
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return window.__stoke.describe(el)
    })()`)

    if (result === 'STALE') throw new Error(`ref ${ref} is stale — take a new snapshot first`)
    await this.waitForStable(4000)
    return result
  }

  async scroll(to: 'top' | 'bottom' | 'up' | 'down', ref?: string): Promise<void> {
    await this.ensureInjected()
    await this.evaluate(`(() => {
      ${ref ? `const el = window.__stoke.resolve(${JSON.stringify(ref)}); if (el) { el.scrollIntoView({ block: 'center' }); return }` : ''}
      const h = window.innerHeight * 0.85
      if (${JSON.stringify(to)} === 'top') window.scrollTo(0, 0)
      else if (${JSON.stringify(to)} === 'bottom') window.scrollTo(0, document.body.scrollHeight)
      else if (${JSON.stringify(to)} === 'up') window.scrollBy(0, -h)
      else window.scrollBy(0, h)
    })()`)
    await sleep(250)
  }

  /** PNG as base64. A ref scopes the capture to that element's box. */
  async screenshot(ref?: string): Promise<{ base64: string; width: number; height: number }> {
    const wc = this.wc()
    let rect: { x: number; y: number; width: number; height: number } | undefined

    if (ref) {
      await this.ensureInjected()
      const box = await this.evaluate<{ x: number; y: number; width: number; height: number } | null>(
        `(() => {
          const el = window.__stoke.resolve(${JSON.stringify(ref)})
          if (!el) return null
          el.scrollIntoView({ block: 'center' })
          const r = el.getBoundingClientRect()
          return { x: Math.max(0, Math.floor(r.left)), y: Math.max(0, Math.floor(r.top)),
                   width: Math.ceil(r.width), height: Math.ceil(r.height) }
        })()`
      )
      if (!box) throw new Error(`ref ${ref} is stale — take a new snapshot first`)
      await sleep(150)
      rect = box
    }

    const image = rect ? await wc.capturePage(rect) : await wc.capturePage()
    const size = image.getSize()
    return { base64: image.toPNG().toString('base64'), width: size.width, height: size.height }
  }

  /* --------------------------------------------------------------- changes */

  private async signature(): Promise<Signature> {
    return this.call<Signature>('signature')
  }

  /** Record the current content so the next changes() call has a baseline. */
  async mark(): Promise<void> {
    try {
      this.lastSignature = await this.signature()
    } catch {
      this.lastSignature = null
    }
  }

  /**
   * What changed since the last read or action.
   *
   * Returning a diff instead of the whole page is the single biggest saving in
   * a multi-step flow — most of a page is identical after a click, and re-sending
   * it every turn is what makes browser agents expensive.
   */
  async changes(): Promise<{
    url: string
    title: string
    navigated: boolean
    added: string[]
    removed: string[]
    unchanged: number
  }> {
    const next = await this.signature()
    const previous = this.lastSignature
    this.lastSignature = next

    if (!previous) {
      return {
        url: next.url,
        title: next.title,
        navigated: true,
        added: next.lines.slice(0, 200),
        removed: [],
        unchanged: 0
      }
    }

    const before = new Set(previous.lines)
    const after = new Set(next.lines)
    const added = next.lines.filter((l) => !before.has(l))
    const removed = previous.lines.filter((l) => !after.has(l))
    const unchanged = next.lines.length - added.length

    return {
      url: next.url,
      title: next.title,
      navigated: previous.url !== next.url,
      added: added.slice(0, 200),
      removed: removed.slice(0, 60),
      unchanged
    }
  }
}
