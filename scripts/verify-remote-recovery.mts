import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import vm from 'node:vm'
import { build } from 'vite'

const temp = mkdtempSync(join(tmpdir(), 'stoke-remote-recovery-'))
try {
  await build({ configFile: false, logLevel: 'error', resolve: { alias: { '@shared': resolve('src/shared') } }, build: { outDir: temp, emptyOutDir: true, lib: { entry: resolve('src/remote/store.ts'), formats: ['cjs'], fileName: () => 'store.cjs' } } })
  let now = 0, next = 0, stalled = false, calls = 0
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>()
  const timer = (fn: () => void, ms: number, every?: number): number => { const id = ++next; timers.set(id, { at: now + ms, fn, every }); return id }
  const clear = (id: number): void => { timers.delete(id) }
  const flush = async (): Promise<void> => { for (let i = 0; i < 12; i++) await Promise.resolve() }
  const advance = async (ms: number): Promise<void> => {
    const until = now + ms
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
      if (!due) break
      now = due[1].at; timers.delete(due[0])
      if (due[1].every) timers.set(due[0], { ...due[1], at: now + due[1].every })
      due[1].fn(); await flush()
    }
    now = until; await flush()
  }
  const sockets: FakeSocket[] = []
  class FakeSocket extends EventTarget {
    static OPEN = 1
    readyState = 0
    silentClose = false
    constructor(_url: string) { super(); sockets.push(this) }
    open(): void { this.readyState = 1; this.dispatchEvent(new Event('open')) }
    frame(rows: unknown[] = []): void { this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ type: 'sessions', rows }) })) }
    close(): void { if (this.readyState === 3) return; if (this.silentClose) { this.readyState = 2; return }; this.readyState = 3; this.dispatchEvent(new Event('close')) }
  }
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  const window = new EventTarget()
  const exports: Record<string, any> = {}
  const fakeDate = class extends Date { static now(): number { return now } }
  vm.runInNewContext(readFileSync(join(temp, 'store.cjs'), 'utf8'), {
    exports, document, window, location: { protocol: 'https:', host: 'phone.example.test' },
    WebSocket: FakeSocket, Date: fakeDate, AbortController, Error, Math,
    setTimeout: (fn: () => void, ms: number) => timer(fn, ms), clearTimeout: clear,
    setInterval: (fn: () => void, ms: number) => timer(fn, ms, ms), clearInterval: clear,
    localStorage: { setItem() {} },
    fetch: async (_path: string, options: RequestInit) => {
      calls++
      if (stalled) return new Promise((_resolve, reject) => {
        if (options.signal?.aborted) reject(options.signal.reason)
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })
      return { status: 200, ok: true, json: async () => [] }
    }
  })
  const store = exports.store
  store.start(); sockets[0].open()
  assert.equal(store.link, 'connecting', 'OPEN alone is not a usable list')
  sockets[0].frame(); assert.equal(store.link, 'live')
  stalled = true
  await advance(15_000)
  assert.equal(calls, 1)
  await advance(12_000)
  assert.equal(store.link, 'down', 'a stale OPEN socket is detected by a bounded application read')
  assert.equal(sockets[0].readyState, 3)
  stalled = false
  await advance(1000); sockets.at(-1)!.open(); sockets.at(-1)!.frame()
  assert.equal(store.link, 'live', 'the stale connection repairs automatically')
  document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange'))
  await advance(11_000)
  document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange')); await flush()
  const resumed = sockets.at(-1)!
  assert.notEqual(resumed, sockets[1], 'waking replaces a socket that may have died during sleep')
  sockets[1].frame([{ ptyId: 'stale' }]); assert.notEqual(store.rows?.[0]?.ptyId, 'stale', 'late old frames cannot overwrite the replacement')
  resumed.open(); resumed.frame(); assert.equal(store.link, 'live')
  window.dispatchEvent(new Event('online')); await flush()
  assert.notEqual(sockets.at(-1), resumed, 'a network change replaces even a socket still reporting OPEN')
  sockets.at(-1)!.open(); sockets.at(-1)!.frame()
  stalled = true; void store.refresh(); await flush()
  store.stop(); await flush(); assert.equal(timers.size, 0, 'stopping cancels reads, deadlines, retries and health timers')
  stalled = false; store.start(); const stuck = sockets.at(-1)!; stuck.open(); stuck.silentClose = true
  await advance(13_500)
  assert.notEqual(sockets.at(-1), stuck, 'an attach with no list retries even if its close handshake never finishes')
  store.stop(); await flush(); assert.equal(timers.size, 0)
  console.log('PASS remote recovery: readiness, stalled OPEN sockets, bounded reads, automatic repair, wake recovery, stale frames and timer cleanup.')
} finally { rmSync(temp, { recursive: true, force: true }) }
