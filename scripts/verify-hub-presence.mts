import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { HubPresence } from '../src/main/hub/presence.ts'
import { WebSocket, WebSocketServer } from 'ws'

class Socket extends EventEmitter {
  sent: string[] = []
  terminated = false
  broken = false
  send(text: string): void { if (this.broken) throw new Error('broken send'); this.sent.push(text) }
  close(): void { this.terminated = true; this.emit('close', 1000) }
  terminate(): void { this.close() }
}
const until = async (test: () => boolean, label: string): Promise<void> => {
  const deadline = Date.now() + 2000
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}
let checks = 0
const pass = (text: string): void => { checks++; console.log(`PASS ${text}`) }

{
  const sockets: Socket[] = []
  let attempts = 0, opened = 0, closed = 0, messages = 0
  const connection = new HubPresence({
    open: async () => { if (++attempts === 1) throw new Error('offline'); const socket = new Socket(); sockets.push(socket); return socket },
    enabled: () => true, opened: () => { opened++ }, closed: () => { closed++ }, message: () => { messages++ }, error: () => {},
    retryMs: () => 5, handshakeMs: 500, pingMs: 500
  })
  try {
    connection.start()
    await until(() => !!sockets[0]?.listenerCount('open'), 'retry after rejected open')
    sockets[0].emit('open')
    assert.equal(attempts, 2); assert.equal(opened, 1)
    pass('a rejected opener retries without waiting for a sync pass')
    sockets[0].emit('error', new Error('connection lost'))
    await until(() => !!sockets[1]?.listenerCount('open'), 'replacement socket')
    sockets[1].emit('open')
    const before = closed
    sockets[0].emit('close', 1006)
    sockets[0].emit('message', '{"t":"pong"}')
    assert.equal(closed, before); assert.equal(messages, 0)
    sockets[1].emit('message', '{"t":"pong"}')
    assert.equal(messages, 1)
    pass('a stale socket cannot clear a replacement connection or publish stale messages')
  } finally { connection.stop() }
  const count = attempts
  await new Promise((resolve) => setTimeout(resolve, 15))
  assert.equal(attempts, count)
  pass('stop cancels reconnects and closes the transport')
}
{
  let resolveLate!: (socket: Socket) => void
  const delayed = new Promise<Socket>((resolve) => { resolveLate = resolve })
  const fresh = new Socket(), old = new Socket()
  let attempts = 0, opened = 0
  const connection = new HubPresence({
    open: () => ++attempts === 1 ? delayed : Promise.resolve(fresh), enabled: () => true,
    opened: () => { opened++ }, closed: () => {}, message: () => {}, error: () => {},
    handshakeMs: 15, retryMs: () => 5, pingMs: 500
  })
  try {
    connection.start()
    await until(() => !!fresh.listenerCount('open'), 'handshake deadline retries hung opener')
    fresh.emit('open')
    resolveLate(old)
    await until(() => old.terminated, 'late opener discarded')
    old.emit('open')
    assert.equal(opened, 1)
    pass('a hung opener times out and its late result cannot replace a newer socket')
  } finally { connection.stop() }
}
{
  const sockets: Socket[] = []
  let clock = 0
  const connection = new HubPresence({
    open: async () => { const socket = new Socket(); sockets.push(socket); return socket }, enabled: () => true,
    opened: () => {}, closed: () => {}, message: () => {}, error: () => {}, now: () => clock,
    handshakeMs: 500, retryMs: () => 5, pingMs: 5
  })
  try {
    connection.start()
    await until(() => !!sockets[0]?.listenerCount('open'), 'first socket')
    sockets[0].emit('open')
    await until(() => sockets[0].sent.length > 0, 'ping sent')
    clock = 100
    await until(() => sockets.length > 1, 'heartbeat failure reconnects')
    assert.equal(sockets[0].terminated, true)
    pass('a half-open connection that stops answering heartbeats is terminated and reconnected')
  } finally { connection.stop() }
}
{
  const socket = new Socket()
  let resolveOpen!: (socket: Socket) => void
  let opened = false
  const connection = new HubPresence({
    open: () => new Promise((resolve) => { resolveOpen = resolve }), enabled: () => true,
    opened: () => { opened = true }, closed: () => {}, message: () => {}, error: () => {}, handshakeMs: 500
  })
  connection.start()
  await until(() => !!resolveOpen, 'opener requested')
  connection.stop()
  resolveOpen(socket)
  await until(() => socket.terminated, 'pending open closed after stop')
  assert.equal(opened, false)
  pass('sign-out/stop invalidates an in-flight opener')
}
{
  const sockets: Socket[] = []
  const connection = new HubPresence({
    open: async () => { const socket = new Socket(); sockets.push(socket); return socket }, enabled: () => true,
    opened: () => {}, closed: () => {}, message: () => {}, error: () => {},
    handshakeMs: 500, retryMs: () => 5, pingMs: 5
  })
  try {
    connection.start()
    await until(() => !!sockets[0]?.listenerCount('open'), 'send failure socket')
    sockets[0].broken = true; sockets[0].emit('open')
    await until(() => sockets.length > 1, 'send failure retried')
    assert.equal(sockets[0].terminated, true)
    pass('heartbeat send errors reconnect immediately instead of waiting for a close event')
  } finally { connection.stop() }
}
{
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await new Promise<void>((resolve) => server.once('listening', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  let opened = 0, pongs = 0
  server.on('connection', (socket) => {
    socket.on('message', (data) => {
      if (JSON.parse(String(data)).t === 'ping') socket.send('{"t":"pong"}')
    })
  })
  const connection = new HubPresence({
    open: async () => new WebSocket(`ws://127.0.0.1:${address.port}`), enabled: () => true,
    opened: () => { opened++ }, closed: () => {}, message: () => { pongs++ }, error: () => {},
    handshakeMs: 500, retryMs: () => 5, pingMs: 20
  })
  try {
    connection.start()
    await until(() => pongs >= 2, 'real websocket heartbeat roundtrips')
    assert.equal(opened, 1)
    for (const socket of server.clients) socket.terminate()
    await until(() => opened >= 2, 'real websocket reconnect')
    pass('real loopback WebSockets answer heartbeats and reconnect after the server drops a connection')
  } finally {
    connection.stop()
    for (const socket of server.clients) socket.terminate()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}
console.log(`\n${checks} Hub presence recovery checks passed.`)
