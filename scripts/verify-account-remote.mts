/** Synthetic account + three computers + browser; every network request stays on loopback. */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { createServer, request as httpRequest } from 'node:http'
import { connect } from 'node:net'
import { spawn } from 'node:child_process'
import WebSocket from 'ws'
import edge from '../worker/hub-edge.ts'
import { build } from 'vite'
import { startHub } from '../hub/app.ts'
import { HubLog } from '../hub/log.ts'
import { HubService } from '../src/main/hub/service.ts'
import { HubFiles } from '../src/main/hub/files.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import type { Settings } from '../src/shared/types.ts'
import type { RemoteMachineDeps } from '../src/main/hub/remote.ts'
import { b64uDecode, fromUtf8 } from '../src/shared/hub/codec.ts'
import { browserLinkOf, browserRouteAllowed } from '../src/shared/hub/browser.ts'
import { hubRequest } from '../src/main/hub/http.ts'
import * as native from '../src/main/hub/crypto.ts'
import * as browser from '../src/accountRemote/crypto.ts'
import config from '../vite.account-remote.config.ts'

const temp = mkdtempSync(join(tmpdir(), 'stoke-account-remote-'))
const announced: string[] = []
const hub = await startHub({ dataDir: join(temp, 'hub'), mount: '/hub', edge: null, lan: { host: '127.0.0.1', port: 0 }, edgeSecret: null, rate: { capacity: 100000, refillPerSec: 1000 } }, { announce: text => announced.push(text), log: new HubLog(() => {}) })
const base = `http://127.0.0.1:${hub.lanPort}/hub`
const services: HubService[] = []
const password = 'correct horse battery staple'
const email = 'remote@example.test'
const backend = { isEncryptionAvailable: () => true, selectedBackend: () => 'gnome_libsecret', encrypt: (text: string) => Buffer.from(text), decrypt: (bytes: Buffer) => bytes.toString('utf8') }
const until = async (what: string, predicate: () => boolean, ms = 12000): Promise<void> => { const end = Date.now() + ms; while (!predicate()) { assert(Date.now() < end, what); await new Promise(r => setTimeout(r, 30)) } }
function computer(name: string, ptyId: string) {
  const root = join(temp, name); mkdirSync(root)
  let settings = hydrateSettings({ hub: { url: base, sync: { settings: false, hosts: false, keys: false, accounts: false } } })
  const listeners = new Set<(settings: Settings) => void>()
  const inputs: string[] = []
  const machine: RemoteMachineDeps = {
    sessions: async () => [{ ptyId, project: name, title: `${name} chat`, status: 'busy', agentName: 'Codex', exited: false, lastActivityAt: Date.now(), context: null }],
    request: async () => ({ status: 200, body: [] }),
    socket: (_path, socket) => { socket.send(JSON.stringify({ type: 'attached', history: `${name}: ready`, cols: 80, rows: 24 })); socket.on('message', raw => { const frame = JSON.parse(String(raw)); if (frame.type === 'submit') { inputs.push(frame.text); socket.send(JSON.stringify({ type: 'data', data: `${name}: ${frame.text}` })) } }) },
    emit: () => {}, frame: () => {}, typeOnly: true
  }
  const svc = new HubService({ userData: root, backend, platform: 'linux', hostname: name, appVersion: 'test', getSettings: () => settings, commit: patch => { settings = hydrateSettings({ ...settings, ...patch }); for (const fn of listeners) fn(settings); return settings }, hydrate: hydrateSettings, onSettingsChanged: fn => { listeners.add(fn); return () => listeners.delete(fn) }, emit: () => {}, pairPollMs: 30, remote: machine, ssh: { home: root, dir: join(root, '.ssh'), config: join(root, '.ssh/config') } })
  services.push(svc)
  return { svc, root, inputs, ptyId }
}
let account: any
try {
  // Differential tests cover the existing cryptographic wire format.
  const keys = native.generateDeviceKeys(), seed = new Uint8Array(32).fill(7)
  assert.equal(browser.browserPublic(keys.signPriv), keys.signPub)
  assert.equal(browser.signText(keys.signPriv, 'wire test'), native.signText(keys.signPriv, 'wire test'))
  assert.equal(browser.verifyText(keys.signPub, 'wire test', native.signText(keys.signPriv, 'wire test')), true)
  const ephemeral = browser.relayEphemeral(seed), host = native.relayEphemeral(seed)
  assert.equal(ephemeral.pub, host.pub)
  const hs1 = browser.relayHello({ account: 'a0000000000000000', relay: 'r000000000000000000000000', guest: 'd0000000000000000', host: 'd0000000000000001' }, ephemeral)
  const answer = native.relayAnswer(hs1, host, keys.signPriv)
  const finished = browser.relayFinish(hs1, answer.hs2, keys.signPub, keys.signPriv)
  assert(finished.ok)
  assert(native.relayAccept(answer.th, answer.hs2, finished.hs3, keys.signPub))
  const bk = browser.relayKeys(ephemeral, host.pub, answer.th)!, nk = native.relayKeys(host, ephemeral.pub, answer.th)!
  assert.deepEqual(bk.g2h, nk.g2h)
  const sender = new browser.RelayCipher(bk.g2h, 'g2h', hs1.relay), receiver = new native.RelayCipher(nk.g2h, 'g2h', hs1.relay)
  const encrypted = sender.seal('terminal bytes'); assert.equal(fromUtf8(receiver.open(encrypted)!), 'terminal bytes'); assert.equal(receiver.open(encrypted), null)
  assert.equal(browserRouteAllowed('GET', '/v1/vault/wrap?epoch=1'), false)
  assert.equal(browserRouteAllowed('POST', '/v1/chain'), false)
  assert.equal(browserRouteAllowed('GET', '/v1/items'), false)

  const laptop = computer('Laptop', 'pty-laptop'), work = computer('WorkPC', 'pty-work'), pc = computer('PC', 'pty-pc')
  await laptop.svc.start()
  const invite = /(INV(?:-[0-9A-Z]{4}){6})/.exec(announced.join(''))![1]
  assert((await laptop.svc.signIn({ invite, email, password, label: 'Laptop' })).ok)
  const kit = await laptop.svc.createVault(); assert(kit.ok, !kit.ok ? kit.message : '')
  assert((await laptop.svc.confirmKit(kit.kit.split('-')[kit.group])).ok)
  async function joinComputer(device: ReturnType<typeof computer>): Promise<void> {
    await device.svc.start(); assert((await device.svc.signIn({ email, password, label: device.root.split('/').at(-1) })).ok)
    await laptop.svc.syncNow()
    await until('pair request appears', () => laptop.svc.view().pairs.some(p => p.state === 'waiting'))
    const pair = laptop.svc.view().pairs.find(p => p.state === 'waiting')!
    assert((await laptop.svc.approveStart(pair.pair)).ok)
    await until('pair codes appear', () => !!device.svc.view().join?.code && !!laptop.svc.view().pairs.find(p => p.pair === pair.pair)?.code)
    assert((await laptop.svc.approveConfirm(pair.pair)).ok)
    assert((await device.svc.joinConfirm(true)).ok)
    assert((await device.svc.setSharing(true)).ok)
  }
  await joinComputer(work); await joinComputer(pc)
  await until('issuer action settles', () => !laptop.svc.view().busy)
  const created = await laptop.svc.createBrowserLink('Test phone'); assert(created.ok, !created.ok ? created.message : '')
  const link = browserLinkOf(JSON.parse(fromUtf8(b64uDecode(new URL(created.url).hash.slice(9))!)!))!
  assert(link); assert.equal(new URL(created.url).pathname, '/remote/')
  const phoneAuth = { device: link.device, signPriv: link.signPriv, token: link.token }
  const ticket = async () => (await hubRequest({ fetch, now: Date.now }, base, 'POST', '/v1/remote/socket', { path: '/v1/ws/presence' }, phoneAuth)).ticket as string
  const upgrade = (path: string, value: string): Promise<boolean> => new Promise(done => {
    const socket = new WebSocket(base.replace('http:', 'ws:') + path + '?stoke_ticket=' + value)
    const timeout = setTimeout(() => { socket.terminate(); done(false) }, 3000)
    socket.on('open', () => { clearTimeout(timeout); socket.close(); done(true) })
    socket.on('error', () => { clearTimeout(timeout); done(false) })
  })
  const once = await ticket()
  assert.equal(await upgrade('/v1/ws/presence', once), true)
  assert.equal(await upgrade('/v1/ws/presence', once), false, 'socket tickets cannot be replayed')
  const bound = await ticket()
  assert.equal(await upgrade('/v1/ws/relay/abc', bound), false, 'socket tickets are bound to their signed route')
  assert.equal(await upgrade('/v1/ws/presence', bound), false, 'a mismatched attempt also consumes its ticket')
  for (const path of ['/v1/items', '/v1/vault/wrap?epoch=1', '/v1/vault/recovery', '/v1/account']) await assert.rejects(hubRequest({ fetch, now: Date.now }, base, 'GET', path, undefined, phoneAuth), /remote-only/)
  await assert.rejects(hubRequest({ fetch, now: Date.now }, base, 'POST', '/v1/chain', { entries: [] }, phoneAuth), /remote-only/)
  const key = await hubRequest({ fetch, now: Date.now }, base, 'GET', '/v1/remote/key', undefined, phoneAuth)
  const issuerFiles = new HubFiles(laptop.root, backend, 'linux'), issuer = await issuerFiles.loadDevice()
  assert(issuer)
  const phoneChain = await hubRequest({ fetch, now: Date.now }, base, 'GET', '/v1/chain', undefined, phoneAuth)
  const keyAuthor = (phoneChain.entries as ChainEntry[]).find(e => e.device?.id === (key.key as any).author)!.device!
  const presenceKey = browser.openBrowserPresence(key.key as any, link.boxPriv, keyAuthor.sign)
  assert.equal(presenceKey?.length, 32)
  const state = await issuerFiles.loadState(issuer.account)
  assert(state)
  assert.notDeepEqual(presenceKey, issuerFiles.openVault(issuer.account, 1, state.vaultKeys['1']), 'browser gets only a derived discovery key')
  const wrapped = key.key as any
  assert.equal(browser.openBrowserPresence({ ...wrapped, epoch: wrapped.epoch + 1 }, link.boxPriv, keyAuthor.sign), null, 'signed key offers cannot be re-epoched')
  assert.equal(browser.openBrowserPresence(wrapped, native.generateDeviceKeys().boxPriv, keyAuthor.sign), null, 'another phone cannot open the wrap')

  // Use the actual browser-compiled relay code against the real hub.
  await build({ ...(config as any), configFile: false, logLevel: 'error', build: { outDir: join(temp, 'bundle'), emptyOutDir: true, lib: { entry: resolve('src/accountRemote/client.ts'), name: 'AccountRemote', formats: ['cjs'], fileName: () => 'client.cjs' } } })
  const values = new Map<string, string>()
  Object.assign(globalThis, { location: { origin: new URL(base).origin, href: new URL(base).origin + '/remote/' }, localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) } })
  if (!globalThis.CloseEvent) (globalThis as any).CloseEvent = class extends Event { code: number; constructor(type: string, options: { code: number }) { super(type); this.code = options.code } }
  const { AccountRemote } = createRequire(import.meta.url)(join(temp, 'bundle/client.cjs'))
  account = new AccountRemote(link)
  await account.start()
  await until('browser sees both online computers', () => account.view.machines.filter((m: any) => m.status?.sessions.length).length >= 2)
  const workId = work.svc.view().devices.find(d => d.me)!.id
  const pcId = pc.svc.view().devices.find(d => d.me)!.id
  const frames: any[] = []
  const opened = account.remote.openDevice(workId, work.ptyId, { state: (s: any) => frames.push(s), frame: (f: any) => frames.push(f), close: () => {} })
  assert(opened.ok)
  await until('work PC asks for phone permission', () => work.svc.remoteView().asks.length > 0)
  assert((await work.svc.remoteAnswer(work.svc.remoteView().asks[0].id, 'always')).ok)
  await until('browser terminal attaches', () => frames.some(f => f.type === 'attached'))
  laptop.svc.stop()
  await until('laptop is offline', () => !account.view.machines.some((m: any) => m.label === 'Laptop'))
  assert(opened.connection.submit('after laptop off'))
  await until('work PC receives input with issuer offline', () => work.inputs.includes('after laptop off'))
  assert(account.view.machines.some((m: any) => m.id === pcId), 'another online computer remains selectable')
  work.svc.stop()
  await until('work PC disappears without losing the account connection', () => !account.view.machines.some((m: any) => m.id === workId) && account.view.machines.some((m: any) => m.id === pcId))
  const nextFrames: any[] = []
  const next = account.remote.openDevice(pcId, pc.ptyId, { state: () => {}, frame: (f: any) => nextFrames.push(f), close: () => {} }); assert(next.ok)
  await until('fallback PC asks for permission', () => pc.svc.remoteView().asks.length > 0)
  assert((await pc.svc.remoteAnswer(pc.svc.remoteView().asks[0].id, 'always')).ok)
  await until('fallback terminal attaches', () => nextFrames.some(f => f.type === 'attached'))
  assert(next.connection.submit('explicit new session'))
  await until('fallback receives only its own input', () => pc.inputs.includes('explicit new session'))
  assert(!pc.inputs.includes('after laptop off'), 'old host input is never replayed into the fallback')
  const spare = await pc.svc.createBrowserLink('Spare phone'); assert(spare.ok)
  const spareLink = browserLinkOf(JSON.parse(fromUtf8(b64uDecode(new URL(spare.url).hash.slice(9))!)!))!
  assert((await pc.svc.revokeDevice(link.device, { kit: kit.kit })).ok)
  await until('revoked phone is disconnected', () => account.error.includes('removed'))
  await assert.rejects(hubRequest({ fetch, now: Date.now }, base, 'POST', '/v1/remote/socket', { path: '/v1/ws/presence' }, phoneAuth))
  assert.equal(next.connection.submit('must not arrive'), false)
  assert(!pc.inputs.includes('must not arrive'))
  account.stop()
  account = new AccountRemote(spareLink); await account.start()
  await until('remaining phone gets the new discovery key after rotation', () => account.view.machines.some((m: any) => m.id === pcId && m.status?.sessions.length))
  account.stop()
  // Serve the production browser bundle through the real edge asset handler;
  // only the loopback proxy substitutes for Cloudflare's network transport.
  await build({ ...config, logLevel: 'error' })
  const sockets = new Set<import('node:net').Socket>()
  const front = createServer(async (req, res) => {
    if (req.url?.startsWith('/hub/')) {
      const upstream = httpRequest(base + req.url.slice(4), { method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode!, reply.headers); reply.pipe(res) })
      upstream.on('error', () => { res.writeHead(502); res.end() }); req.pipe(upstream); return
    }
    try {
      const response = await edge.fetch(new Request(`http://${req.headers.host}${req.url}`), { REMOTE_ASSETS: { async fetch(request: Request) {
        const path = new URL(request.url).pathname
        const file = resolve('out/account-remote', path.slice(1) + (path.endsWith('/') ? 'index.html' : ''))
        if (!file.startsWith(resolve('out/account-remote') + '/')) return new Response(null, { status: 404 })
        try { return new Response(readFileSync(file), { headers: { 'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' } }) } catch { return new Response(null, { status: 404 }) }
      } } } as any)
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()))
    } catch { res.writeHead(500); res.end() }
  })
  front.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  front.on('upgrade', (req, socket, head) => {
    const upstream = connect(hub.lanPort, '127.0.0.1', () => {
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`)
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    socket.on('close', () => upstream.destroy()); upstream.on('error', () => socket.destroy())
  })
  await new Promise<void>(done => front.listen(0, '127.0.0.1', done))
  try {
    const port = (front.address() as import('node:net').AddressInfo).port
    const uiLink = { ...spareLink, hub: `http://127.0.0.1:${port}/hub` }
    const url = `http://127.0.0.1:${port}/remote/#connect=${Buffer.from(JSON.stringify(uiLink)).toString('base64url')}`
    const env = { ...process.env, STOKE_TEST_ACCOUNT_URL: url }; delete env.ELECTRON_RUN_AS_NODE
    const approve = setInterval(() => { for (const ask of pc.svc.remoteView().asks) void pc.svc.remoteAnswer(ask.id, 'always') }, 50)
    try {
      const child = spawn(createRequire(import.meta.url)('electron'), ['--use-mock-keychain', '--disable-backgrounding-occluded-windows', 'scripts/drive-account-remote.mts'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''; child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { output += data })
      const timeout = setTimeout(() => child.kill(), 60000)
      const code = await new Promise<number | null>((done, reject) => { child.on('error', reject); child.on('exit', done) }); clearTimeout(timeout)
      assert.equal(code, 0, output)
      await until('the browser page sends input directly to the remaining PC', () => pc.inputs.includes('browser UI input'))
      console.log(output.trim())
    } finally { clearInterval(approve) }
  } finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => front.close(() => done())) }
  console.log('PASS account remote: browser/Node crypto, restricted capabilities, independent phone identity, laptop shutdown, target shutdown, fallback session selection and no cross-host input replay.')
} finally {
  account?.stop()
  for (const service of services) service.stop()
  await hub.close(); rmSync(temp, { recursive: true, force: true })
}
