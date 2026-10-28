import { HubRemote, type RelaySocket } from '../main/hub/remote.ts'
import { HubPresence } from '../main/hub/presence.ts'
import { hubEndpoint, hubSocketUrl } from '../shared/hub/edge.ts'
import { verifyChain, type ChainEntry } from '../shared/hub/chain.ts'
import { parsePresenceServerFrame, readHubResponse, type SealedStatus } from '../shared/hub/protocol.ts'
import { browserLinkOf, type BrowserLink, type BrowserPresenceKey } from '../shared/hub/browser.ts'
import { emptyRemoteView, type HubRemoteView } from '../shared/hub/remote.ts'
import { browserPublic, nodeChainCrypto, openBrowserPresence, signRequest } from './crypto.ts'
import type { RemoteBackend } from '../remote/api.ts'

const STORAGE = 'stoke.account-remote.v1'
export function restoreBrowserLink(): BrowserLink | null { try { return browserLinkOf(JSON.parse(localStorage.getItem(STORAGE) ?? 'null')) } catch { return null } }
export function rememberBrowserLink(link: BrowserLink): void { localStorage.setItem(STORAGE, JSON.stringify(link)) }

class BrowserSocket {
  readonly ws: WebSocket
  constructor(url: string) { this.ws = new WebSocket(url); this.ws.binaryType = 'arraybuffer' }
  get readyState(): number { return this.ws.readyState }
  get bufferedAmount(): number { return this.ws.bufferedAmount }
  send(data: string | Uint8Array): void { this.ws.send(typeof data === 'string' ? data : new Uint8Array(data)) }
  close(code = 1000, reason = ''): void { this.ws.close(code === 1006 ? 1000 : code, reason.slice(0, 100)) }
  terminate(): void { this.close() }
  on(event: string, fn: (...args: any[]) => void): this {
    this.ws.addEventListener(event, (ev: Event) => {
      if (event === 'message') { const data = (ev as MessageEvent).data; fn(data, typeof data !== 'string') }
      else if (event === 'close') fn((ev as CloseEvent).code)
      else if (event === 'error') fn(new Error('The account connection failed.'))
      else fn()
    }); return this
  }
}

/** A browser-facing terminal socket backed directly by the target's encrypted relay. */
class TerminalSocket extends EventTarget {
  readyState: number = WebSocket.CONNECTING
  private connection: ReturnType<HubRemote['openDevice']> | null = null
  private closed = false
  private view: (() => void) | null = null
  constructor(client: AccountRemote, url: URL) {
    super()
    queueMicrotask(() => {
      if (this.closed) return
      this.readyState = WebSocket.OPEN
      this.dispatchEvent(new Event('open'))
      if (url.pathname === '/ws/events') {
        const update = (): void => this.frame({ type: 'sessions', rows: [] })
        this.view = update; client.addEventListener('change', update); update(); return
      }
      if (url.pathname !== '/ws/machine') { this.close(); return }
      this.connection = client.remote.openDevice(url.searchParams.get('device') ?? '', url.searchParams.get('ptyId') ?? '', {
        state: state => this.frame(state), frame: frame => this.frame(frame), close: () => this.close()
      })
      if (!this.connection.ok) { this.frame({ type: 'remote-state', state: 'lost', message: this.connection.message }); this.close() }
    })
    this.addEventListener('close', () => { if (this.view) client.removeEventListener('change', this.view) }, { once: true })
  }
  private frame(data: unknown): void { if (!this.closed) this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) })) }
  send(text: string): void {
    if (this.readyState !== WebSocket.OPEN || !this.connection?.ok) return
    let frame: any
    try { frame = JSON.parse(text) } catch { return }
    const connection = this.connection.connection
    if (frame.type === 'input') connection.input(frame.data)
    else if (frame.type === 'submit') connection.submit(frame.text, frame.enter !== false)
    else if (frame.type === 'resize') connection.resize(frame.cols, frame.rows)
  }
  close(code = 1000, _reason = ''): void {
    if (this.closed) return
    this.closed = true; this.readyState = WebSocket.CLOSED
    if (this.connection?.ok) this.connection.connection.close(code !== 1000)
    this.dispatchEvent(new CloseEvent('close', { code: 1000 }))
  }
}

export class AccountRemote extends EventTarget implements RemoteBackend {
  readonly link: BrowserLink
  readonly remote: HubRemote
  view: HubRemoteView = emptyRemoteView()
  error = ''
  private presenceReady = false
  private chain: Extract<ReturnType<typeof verifyChain>, { ok: true }> | null = null
  private key: { epoch: number; bytes: Uint8Array } | null = null
  private presence: HubPresence
  private presenceSocket: BrowserSocket | null = null
  private statuses = new Map<string, SealedStatus | null>()
  private timer: ReturnType<typeof setInterval> | null = null
  private refreshing: Promise<void> | null = null
  private stopped = false
  private generation = 0
  constructor(link: BrowserLink) {
    super(); this.link = link
    const base = new URL(link.hub)
    if (base.origin !== location.origin || base.username || base.password || !/^https:$/.test(base.protocol) && !['127.0.0.1','localhost','[::1]'].includes(base.hostname)) throw new Error('Open the account link on its own secure Stoke website.')
    this.remote = new HubRemote({
      now: Date.now,
      context: () => this.chain ? { account: link.account, epoch: this.chain.epoch, me: { id: link.device, label: 'Phone', platform: 'web', signPriv: link.signPriv }, active: this.chain.active.map(d => ({ id: d.id, label: d.label, platform: d.platform, sign: d.sign, caps: d.caps })) } : null,
      presenceKey: async epoch => { await this.refreshKey(); return this.key?.epoch === epoch ? this.key.bytes : null },
      sendPresence: frame => { if (frame.t === 'status') return false; try { this.presenceSocket?.send(JSON.stringify(frame)); return !!this.presenceSocket } catch { return false } },
      createRelay: async host => this.request('POST', '/v1/relays', { host }),
      openRelay: async relay => this.openSocket(`/v1/ws/relay/${relay}`),
      sessions: async () => [], request: async () => ({ status: 403, body: {} }), socket: () => {},
      emit: view => { this.view = { ...view, available: view.available && this.presenceReady, machines: view.machines.filter(m => this.chain?.active.some(d => d.id === m.id && d.caps.includes('remote-host'))) }; this.dispatchEvent(new Event('change')) },
      frame: () => {}, sharing: () => false, shareChats: () => false, grants: () => ({}), chatGrants: () => ({}), setGrant: async () => {}, setChatGrant: async () => {}, log: () => {}
    })
    this.presence = new HubPresence({
      open: async () => { await this.refresh(); const socket = await this.openSocket('/v1/ws/presence'); this.presenceSocket = socket; return socket },
      enabled: () => !this.stopped,
      opened: socket => { socket.send(JSON.stringify({ t: 'hello', protocol: 1, app: 'Stoke account remote' })); this.remote.presenceOpened() },
      message: text => {
        const frame = parsePresenceServerFrame(text)
        if (!frame) return
        if (frame.t === 'welcome' || frame.t === 'presence') { this.error = ''; this.presenceReady = true; this.remote.onOnline(frame.online) }
        else if (frame.t === 'status') { this.statuses.set(frame.device, frame.status); void this.remote.onStatus(frame.device, frame.status) }
        else if (frame.t === 'chain') void this.refresh().catch(error => this.failed(error))
        else if (frame.t === 'bye') { void this.refresh().catch(error => this.failed(error)) }
      },
      closed: () => { this.presenceSocket = null; this.presenceReady = false; this.remote.presenceClosed() },
      error: error => this.failed(error)
    })
  }
  async request<T = any>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const text = body === undefined ? '' : JSON.stringify(body)
    const headers = signRequest({ method, pathFromV1: path, device: this.link.device, signPriv: this.link.signPriv, token: this.link.token, body: text, now: Date.now() })
    const response = await fetch(hubEndpoint(this.link.hub, path), { method, headers: { ...headers, 'content-type': 'application/json' }, body: text || undefined, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) })
    const reader = response.body?.getReader(); let total = 0, result = ''
    const decoder = new TextDecoder()
    if (reader) for (;;) {
      const chunk = await reader.read(); if (chunk.done) break
      total += chunk.value.byteLength
      if (total > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('The account response was too large.') }
      result += decoder.decode(chunk.value, { stream: true })
    }
    result += decoder.decode()
    const parsed = readHubResponse(response.status, response.headers.get('content-type'), result)
    if (!parsed.ok) {
      if (response.status === 401) {
        this.stop()
        throw new Error('This browser was removed or its account session expired. Pair it again from Stoke.')
      }
      throw new Error(parsed.error.message || 'The account connection was refused.')
    }
    return parsed.body as T
  }
  private async openSocket(path: string): Promise<BrowserSocket & RelaySocket> {
    const { ticket } = await this.request<{ ticket: string }>('POST', '/v1/remote/socket', { path })
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) throw new Error('The hub returned no usable socket ticket.')
    const url = new URL(hubSocketUrl(this.link.hub, path)); url.searchParams.set('stoke_ticket', ticket)
    return new BrowserSocket(url.toString())
  }
  private failed(error: unknown): void { this.error = error instanceof Error ? error.message : 'Account connection unavailable.'; this.dispatchEvent(new Event('change')) }
  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.readChain().finally(() => { this.refreshing = null })
    return this.refreshing
  }
  private async readChain(): Promise<void> {
    const generation = this.generation
    const response = await this.request<{ entries: ChainEntry[] }>('GET', '/v1/chain')
    if (this.stopped || generation !== this.generation) return
    const chain = verifyChain(response.entries, nodeChainCrypto, { account: this.link.account })
    const self = chain.ok ? chain.active.find(d => d.id === this.link.device && d.sign === browserPublic(this.link.signPriv)) : null
    if (!chain.ok || chain.links[this.link.anchor.seq] !== this.link.anchor.link || !self || self.caps.includes('vault') || !self.caps.includes('remote-guest')) {
      this.stop(); throw new Error('This browser was removed or its signed account device list could not be verified. Pair it again from Stoke.')
    }
    this.chain = chain
    this.link.anchor = { seq: chain.seq, link: chain.head }; rememberBrowserLink(this.link)
    await this.refreshKey()
    this.remote.chainChanged()
    for (const [device, sealed] of this.statuses) await this.remote.onStatus(device, sealed)
    /*
     * The account answered. A read that failed said so (`failed`), and only a
     * presence frame cleared it, so one failed 10 s pass (or `chain`/`bye`
     * read) while the presence socket stayed up left "did not answer" over a
     * live list, the list pushed down under it, until some device came or
     * went. With presence up too, nothing is wrong any more. Presence down:
     * its welcome clears it, once the list is live again.
     */
    if (this.error && this.presenceReady && !this.stopped && generation === this.generation) { this.error = ''; this.dispatchEvent(new Event('change')) }
  }
  private async refreshKey(): Promise<void> {
    const chain = this.chain
    if (!chain || this.key?.epoch === chain.epoch) return
    try {
      const { key } = await this.request<{ key: BrowserPresenceKey }>('GET', '/v1/remote/key')
      if (this.chain !== chain || key.account !== this.link.account || key.device !== this.link.device || key.epoch !== chain.epoch) return
      const author = chain.active.find(d => d.id === key.author && d.caps.includes('vault'))
      const bytes = author ? openBrowserPresence(key, this.link.boxPriv, author.sign) : null
      if (bytes?.length === 32) this.key = { epoch: chain.epoch, bytes }
    } catch { /* Online desktops publish an updated wrap after a rotation. Retry on the next pass. */ }
  }
  async start(): Promise<void> { if (this.timer) return; this.stopped = false; await this.refresh(); if (this.stopped) return; this.presence.start(); this.timer = setInterval(() => { void this.refresh().catch(error => this.failed(error)) }, 10_000) }
  /**
   * Back in view, or the network back: re-check presence from a fresh socket.
   * Restarted whatever the chain read says: a wake whose read failed (the hub
   * away for a moment) left presence stopped until the next wake, so the page
   * never reconnected when the hub came back. Started, presence's own open
   * reads the chain again and backs off between tries.
   */
  async wake(): Promise<void> {
    if (this.stopped) return
    this.presenceReady = false; this.presence.stop(); this.remote.presenceClosed()
    try { await this.refresh() } finally { if (!this.stopped) this.presence.start() }
  }
  stop(): void { this.stopped = true; this.presenceReady = false; this.generation++; this.presence.stop(); this.remote.reset(); if (this.timer) clearInterval(this.timer); this.timer = null }
  socket(url: string): WebSocket { return new TerminalSocket(this, new URL(url, location.href)) as unknown as WebSocket }
  async api<T>(path: string, init?: RequestInit): Promise<T> {
    if (init?.method && init.method !== 'GET') throw new Error('Choose a running session on a computer to continue.')
    if (path === '/api/machines') return { available: this.view.available, machines: this.view.machines } as T
    if (path === '/api/sessions') return [] as T
    if (path === '/api/host') return { machine: 'Stoke account', platform: 'web', stt: 'off', agents: [], defaults: { permissionMode: '', model: '', effort: '' } } as T
    throw new Error('This action belongs to a computer-specific Stoke link.')
  }
}
