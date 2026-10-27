/** The actual phone HTTP/WS router, with only Electron and the hub relay replaced. */
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { BUILT_IN_THEMES } from '../src/shared/themes.ts'
import { REMOTE_DEVICE_INPUT_MAX, REMOTE_DEVICE_SUBMIT_MAX } from '../src/shared/remoteDevices.ts'
import { VirtualSocket } from '../src/main/remote/socket.ts'
import type { RemoteDeviceSink } from '../src/main/hub/remote.ts'

type Check = (name: string, got: unknown, want: unknown) => void
export async function remoteDeviceChecks(check: Check): Promise<void> {
  console.log('\nother devices: actual phone HTTP and WebSocket gates, bounded commands and ownership')
  const work = await mkdtemp(join(tmpdir(), 'stoke-remote-devices-'))
  const sockets: WebSocket[] = []
  let server: { start(config: unknown): Promise<unknown>; stop(): Promise<void>; relayRequest(method: string, path: string): Promise<{ status: number }>; serveRelay(hooks: unknown): void; relaySocket(path: string, socket: VirtualSocket): void } | null = null
  const until = async (ready: () => boolean): Promise<void> => {
    const end = Date.now() + 3000
    while (!ready() && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5))
    if (!ready()) throw new Error('remote device router fixture timed out')
  }
  try {
    const root = fileURLToPath(new URL('../', import.meta.url))
    const bundle = join(work, 'remote.cjs')
    await build({ stdin: { contents: `export { RemoteServer } from './src/main/remote/server.ts'`, resolveDir: root, loader: 'ts' }, outfile: bundle,
      bundle: true, platform: 'node', format: 'cjs', packages: 'external', logLevel: 'silent',
      banner: { js: `require = require('node:module').createRequire(${JSON.stringify(join(root, 'package.json'))});` },
      plugins: [{ name: 'device-test-electron', setup(builder) {
        builder.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'device-test' }))
        builder.onLoad({ filter: /.*/, namespace: 'device-test' }, () => ({ contents: `export const app={isPackaged:false,getAppPath:()=>${JSON.stringify(root)}}`, loader: 'js' }))
      } }] })
    const { RemoteServer } = createRequire(import.meta.url)(bundle)
    const calls: unknown[][] = []
    const sinks: RemoteDeviceSink[] = []
    const closeIntents: boolean[] = []
    const machines = [{ id: 'fixture-device', label: 'Desktop', platform: 'win32', status: { at: 1, open: true, chats: false,
      sessions: [{ ptyId: 'pty-remote1', project: 'project', title: 'Remote session', status: 'idle', agent: 'Codex', context: null, lastActivityAt: null }] } }]
    let localPtys: any = null
    server = new RemoteServer({
      ptys: () => localPtys, registryStates: () => [], hosts: () => [],
      theme: () => ({ theme: BUILT_IN_THEMES[0], fontFamily: 'monospace' }),
      devices: {
        view: () => ({ available: true, machines }),
        open: (device: string, ptyId: string, sink: RemoteDeviceSink) => {
          calls.push(['open', device, ptyId]); sinks.push(sink)
          sink.state({ type: 'remote-state', state: 'open', message: null, mode: 'full', sizes: true, typeOnly: true,
            deviceLabel: 'Desktop', title: 'Remote session', project: 'project', session: null })
          sink.frame({ type: 'attached', ptyId, history: 'fixture$ ', cols: 80, rows: 24 })
          return { ok: true, connection: {
            input: (data: string) => { calls.push(['input', data]); sink.frame({ type: 'data', data }); return true },
            submit: (text: string, enter: boolean) => { calls.push(['submit', text, enter]); return true },
            resize: (cols: number, rows: number) => { calls.push(['resize', cols, rows]); return true },
            close: (reconnecting = false) => { calls.push(['close', ptyId]); closeIntents.push(reconnecting) }
          } }
        }
      }
    })
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as { port: number }).port
    await new Promise<void>((resolve) => probe.close(() => resolve()))
    const config = { port, token: 'remote-device-fixture', hostname: '', bindLan: false, bindTailscale: false, requireAccessHeader: false }
    await server!.start(config)
    const base = `http://127.0.0.1:${port}`
    const headers = { authorization: 'Bearer remote-device-fixture' }
    check('machine summaries require the phone key', (await fetch(`${base}/api/machines`)).status, 401)
    check('machine summaries require this page’s origin', (await fetch(`${base}/api/machines`, { headers: { ...headers, origin: 'https://other.example' } })).status, 403)
    const list = await fetch(`${base}/api/machines`, { headers })
    check('the phone reads approved machine summaries only', [list.status, await list.json()], [200, { available: true, machines }])
    check('the machine endpoint accepts no mutations', (await fetch(`${base}/api/machines`, { method: 'POST', headers })).status, 405)
    check('the host relay API cannot enumerate a third computer', (await server!.relayRequest('GET', '/api/machines')).status, 404)
    const url = `ws://127.0.0.1:${port}/ws/machine?device=fixture-device&ptyId=pty-remote1`
    const refused = async (requestHeaders: Record<string, string>): Promise<number> => new Promise((resolve, reject) => {
      const ws = new WebSocket(url, { headers: requestHeaders }); sockets.push(ws)
      ws.on('unexpected-response', (_req, res) => { res.resume(); ws.terminate(); resolve(res.statusCode ?? 0) })
      ws.on('error', () => {})
      ws.on('open', () => { ws.close(); reject(new Error('unauthorized device socket opened')) })
    })
    check('device sockets reject a missing phone key before opening a relay', await refused({}), 401)
    check('device sockets reject cross-origin access before opening a relay', await refused({ ...headers, origin: 'https://other.example' }), 403)
    check('unauthorized requests created no relay', calls, [])
    const frames: Record<string, unknown>[] = []
    const ws = new WebSocket(url, { headers }); sockets.push(ws)
    ws.on('message', (raw) => frames.push(JSON.parse(String(raw))))
    await until(() => frames.some((f) => f.type === 'attached'))
    check('one browser owns one device/session relay and receives its replay', [calls[0], frames.map((f) => f.type), frames[1]?.history], [['open', 'fixture-device', 'pty-remote1'], ['remote-state', 'attached'], 'fixture$ '])
    ws.send(JSON.stringify({ type: 'input', data: '\x1b[1;2D' }))
    ws.send(JSON.stringify({ type: 'submit', text: 'one paced prompt', enter: true }))
    ws.send(JSON.stringify({ type: 'submit', text: 'dictation', enter: false }))
    ws.send(JSON.stringify({ type: 'resize', cols: 92, rows: 31, force: true }))
    await until(() => calls.length === 5 && frames.some((f) => f.type === 'data'))
    check('phone commands retain exact raw keys, submit Enter flags and dimensions', calls.slice(1), [['input', '\x1b[1;2D'], ['submit', 'one paced prompt', true], ['submit', 'dictation', false], ['resize', 92, 31]])
    for (const message of ['null', '[]', 'bad-json', JSON.stringify({ type: 'input', data: 'x'.repeat(REMOTE_DEVICE_INPUT_MAX + 1) }),
      JSON.stringify({ type: 'submit', text: 'x'.repeat(REMOTE_DEVICE_SUBMIT_MAX + 1) }), JSON.stringify({ type: 'submit', text: 'x', enter: 'no' }),
      JSON.stringify({ type: 'resize', cols: 1001, rows: 30, force: true }), JSON.stringify({ type: 'resize', cols: 80.5, rows: 30, force: true }),
      JSON.stringify({ type: 'resize', cols: 80, rows: 30 }), JSON.stringify({ type: 'req', path: '/api/files/list' })]) ws.send(message)
    // WebSocket messages are ordered. A valid sentinel proves every preceding
    // malformed frame was processed even on a slow native runner.
    ws.send(JSON.stringify({ type: 'input', data: 'after-invalid-frames' }))
    await until(() => calls.some((call) => call[0] === 'input' && call[1] === 'after-invalid-frames'))
    check('malformed, oversized and out-of-scope commands never reach the relay', calls.slice(5), [['input', 'after-invalid-frames']])
    ws.close()
    await until(() => calls.some((c) => c[0] === 'close'))
    check('a browser leaving releases exactly its own relay once', calls.filter((c) => c[0] === 'close'), [['close', 'pty-remote1']])
    const ws2 = new WebSocket(url, { headers }); sockets.push(ws2)
    await until(() => sinks.length === 2)
    sinks[1].close()
    await until(() => ws2.readyState === WebSocket.CLOSED)
    check('sign-out or relay teardown closes the browser socket', calls.filter((c) => c[0] === 'close').length, 2)
    const renewing = new WebSocket(url, {headers});sockets.push(renewing)
    await until(()=>sinks.length===3)
    renewing.close(4000,'reconnecting')
    await until(()=>closeIntents.length===3)
    check('an explicit browser reconnect preserves the host size lease through the gateway', closeIntents, [false,false,true])
    await server!.start({ ...config, requireAccessHeader: true })
    check('the Access gate also protects device summaries', (await fetch(`${base}/api/machines`, { headers })).status, 403)
    check('the Access gate also protects device sockets', await refused(headers), 403)
    server!.serveRelay({ sized: () => {} })
    let relayClosed = false
    server!.relaySocket('/ws/machine?device=fixture-device&ptyId=pty-remote1', new VirtualSocket(() => {}, () => { relayClosed = true }))
    check('a relayed socket cannot pivot through this gateway', [relayClosed, sinks.length], [true, 3])
    // Exercise the real PTY socket router across loss/re-attach, with a fake
    // timer only for the size lease; no sixty-second sleep or real agent.
    let dimensions = { cols: 120, rows: 40 }
    const sizes: unknown[] = []
    localPtys = {
      subscribe: () => () => {}, subscribeExit: () => () => {},
      list: () => [{ptyId:'pty-resize1',...dimensions,exited:false,instrumented:false}],
      lastInputAt: () => null, historyFor: () => '› saved input',
      resize: (_id: string, cols: number, rows: number) => { dimensions={cols,rows}; sizes.push({...dimensions}) }
    }
    const leases = new Map<any, () => void>()
    const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout
    globalThis.setTimeout = ((fn: () => void, ms: number, ...args: any[]) => {
      if(ms!==60_000) return realTimeout(fn, ms, ...args)
      const handle={unref(){}}; leases.set(handle,fn); return handle
    }) as any
    globalThis.clearTimeout = ((handle: any) => { if(!leases.delete(handle)) realClear(handle) }) as any
    try {
      const attach = () => { const socket=new VirtualSocket(()=>{},()=>{});server!.relaySocket('/ws?ptyId=pty-resize1',socket);return socket }
      const fit = (socket: VirtualSocket) => socket.deliver(JSON.stringify({type:'resize',cols:90,rows:28,force:true}))
      let socket=attach(); fit(socket); socket.drop('network lost')
      check('an interrupted link retains the remote grid and arms one lease', [dimensions,leases.size], [{cols:90,rows:28},1])
      socket=attach()
      check('reconnecting cancels restoration without a resize', [dimensions,leases.size,sizes.length], [{cols:90,rows:28},0,1])
      socket.drop('flap'); socket=attach(); socket.drop('flap again')
      check('repeated drops retain one pending restoration', [dimensions,leases.size], [{cols:90,rows:28},1])
      const [handle,expire]=[...leases][0];leases.delete(handle);expire()
      check('an abandoned connection eventually restores the host grid', dimensions, {cols:120,rows:40})
      socket=attach();fit(socket);socket.drop('explicit close',1000)
      check('a deliberate close restores immediately and leaves no timer', [dimensions,leases.size], [{cols:120,rows:40},0])
      socket=attach();fit(socket);socket.drop('network lost')
      const staleExpiry=[...leases.values()][0]
      localPtys.resize('pty-resize1',144,44);(server as any).desktopResized('pty-resize1')
      staleExpiry()
      check('host activity cancels restoration and cannot be rolled back by a stale timer', [dimensions,leases.size], [{cols:144,rows:44},0])
      socket=attach();fit(socket);socket.drop('network lost');await server!.stop()
      check('stopping cancels leases and restores the desktop', [dimensions,leases.size], [{cols:144,rows:44},0])
    } finally { globalThis.setTimeout=realTimeout;globalThis.clearTimeout=realClear }

  } finally {
    for (const socket of sockets) if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
    await server?.stop()
    await rm(work, { recursive: true, force: true })
  }
}
