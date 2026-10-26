import { randomBytes } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { z } from 'zod'
import { isCodingCliId, isSafeResumeId } from '../shared/codingClis.ts'
import { atomicJson, configSchema, terminalHome } from './config.ts'
import { LocalSessions, type LiveChat } from './localSessions.ts'
import { MAX_SESSION_FRAME, processAlive, readServerInfo, sameToken, serverInfoPath, SESSION_PROTOCOL, socketPrefix } from './sessionProtocol.ts'

const chatSchema = z.object({
  id: z.string().uuid(), agent: z.string().refine(isCodingCliId), cwd: z.string(), title: z.string().max(200),
  createdAt: z.number(), model: z.string().max(200), nativeId: z.string().refine(isSafeResumeId).optional()
})
const requestSchema = z.object({
  id: z.number().int().nonnegative(), token: z.string(), command: z.enum(['list', 'start', 'input', 'resize', 'stop', 'shutdown']),
  chat: chatSchema.optional(), config: configSchema.optional(), prompt: z.string().max(65536).optional(), resume: z.boolean().optional(),
  override: z.object({ file: z.string(), args: z.array(z.string()) }).optional(),
  environment: z.record(z.string(), z.string()).optional(),
  session: z.string().uuid().optional(), data: z.string().max(65536).optional(),
  cols: z.number().int().min(1).max(1000).optional(), rows: z.number().int().min(1).max(500).optional()
})

/** Authenticated, per-user PTY owner. Transport is a private Unix socket or a
 * Windows named pipe. Disconnecting a UI never terminates its agent sessions. */
export async function runSessionServer(home = terminalHome()): Promise<void> {
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const lock = join(home, 'server.lock')
  let fd: number
  try { fd = openSync(lock, 'wx', 0o600) } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    let pid = 0
    try { pid = Number(readFileSync(lock, 'utf8')) } catch { /* stale lock */ }
    if (!pid || processAlive(pid)) return
    unlinkSync(lock)
    fd = openSync(lock, 'wx', 0o600)
  }
  writeFileSync(fd, String(process.pid)); closeSync(fd)
  const token = randomBytes(32).toString('hex')
  const endpoint = `${socketPrefix(home)}${process.pid}${process.platform === 'win32' ? '' : '.sock'}`
  const clients = new Set<Socket>()
  const owners = new Map<string, Socket>()
  let stopping = false, idleTimer: ReturnType<typeof setTimeout> | null = null
  const send = (socket: Socket, data: unknown): void => {
    if (!socket.destroyed && !socket.writableEnded) {
      const payload = JSON.stringify(data) + '\n'
      if (socket.writableLength + payload.length > MAX_SESSION_FRAME * 2) socket.destroy()
      else socket.write(payload)
    }
  }
  const broadcast = (data: unknown): void => { for (const client of clients) send(client, data) }
  const sessions = new LocalSessions((session, data) => broadcast({ event: 'output', session: session.chat.id, data }),
    (session) => { broadcast({ event: 'exit', session: session.chat.id, exitCode: session.exitCode }); scheduleIdle() }, home)
  const snapshot = (session: LiveChat): object => ({ chat: session.chat, exited: session.exited, exitCode: session.exitCode, cols: session.pty.cols, rows: session.pty.rows, snapshot: session.screen.snapshot() || '' })
  const cleanup = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    sessions.close()
    try { if (readServerInfo(home)?.pid === process.pid) unlinkSync(serverInfoPath(home)) } catch { /* already removed */ }
    try { if (readFileSync(lock, 'utf8') === String(process.pid)) unlinkSync(lock) } catch { /* already removed */ }
    try { if (process.platform !== 'win32' && existsSync(endpoint)) unlinkSync(endpoint) } catch { /* already removed */ }
  }
  const shutdown = (): void => {
    if (stopping) return
    stopping = true
    for (const client of clients) client.end()
    server.close()
    cleanup()
  }
  const scheduleIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    if (!clients.size && ![...sessions.live.values()].some((session) => !session.exited)) idleTimer = setTimeout(shutdown, 30_000)
  }
  const server = createServer((socket) => {
    let buffer = '', authenticated = false
    const deadline = setTimeout(() => socket.destroy(), 5000)
    socket.setEncoding('utf8')
    socket.on('error', () => socket.destroy())
    socket.on('close', () => {
      clearTimeout(deadline)
      clients.delete(socket)
      for (const [id, owner] of owners) if (owner === socket) owners.delete(id)
      scheduleIdle()
    })
    socket.on('data', async (chunk: string) => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_SESSION_FRAME) { socket.destroy(); return }
      for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1)
        const parsed = requestSchema.safeParse((() => { try { return JSON.parse(line) } catch { return null } })())
        if (!parsed.success || !sameToken(parsed.data.token, token)) { socket.destroy(); return }
        const request = parsed.data
        if (!authenticated) { authenticated = true; clearTimeout(deadline); clients.add(socket); if (idleTimer) clearTimeout(idleTimer) }
        try {
          let result: unknown = true
          const session = request.session ? sessions.live.get(request.session) : undefined
          switch (request.command) {
            case 'list':
              // Replay one bounded screen at a time. A workspace with many
              // chats must not become one enormous JSON response.
              for (const entry of sessions.live.values()) {
                send(socket, { event: 'created', ...snapshot(entry) })
                await nextTurn()
              }
              result = []; break
            case 'start': {
              if (!request.chat || !request.config) throw new Error('Missing chat or launch configuration.')
              const existing = sessions.live.get(request.chat.id)
              if (existing && !existing.exited) throw new Error('That session is already running. Attach instead.')
              const started = sessions.start(request.chat, request.config, request.prompt, request.resume, request.override, request.environment)
              owners.set(started.chat.id, socket)
              if (request.cols && request.rows) { started.pty.resize(request.cols, request.rows); started.screen.resize(request.cols, request.rows) }
              broadcast({ event: 'created', ...snapshot(started) })
              result = snapshot(started)
              break
            }
            case 'input':
              if (!session || session.exited) throw new Error('That session is no longer running.')
              if (owners.get(session.chat.id) !== socket) throw new Error('This chat is attached in another terminal. Reattach here to take control.')
              session.pty.write(request.data || ''); break
            case 'resize':
              if (!session || session.exited || !request.cols || !request.rows) throw new Error('That session is no longer running.')
              owners.set(session.chat.id, socket)
              session.screen.resize(request.cols, request.rows); session.pty.resize(request.cols, request.rows)
              broadcast({ event: 'resize', session: session.chat.id, cols: request.cols, rows: request.rows })
              break
            case 'stop': if (session && !session.exited) session.pty.kill(); break
            case 'shutdown': send(socket, { id: request.id, result: true }); shutdown(); return
          }
          send(socket, { id: request.id, result })
        } catch (error) { send(socket, { id: request.id, error: error instanceof Error ? error.message : String(error) }) }
      }
    })
  })
  process.once('exit', cleanup)
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(endpoint, resolve) })
  if (process.platform !== 'win32') chmodSync(endpoint, 0o600)
  atomicJson(serverInfoPath(home), { protocol: SESSION_PROTOCOL, pid: process.pid, endpoint, token })
  scheduleIdle()
}
