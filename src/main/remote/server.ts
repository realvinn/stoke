import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { app } from 'electron'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ContextSnapshot, LaunchOptions, Project, SessionMeta } from '@shared/types'
import type { ContextWatcher } from '../context.ts'
import type { PtyManager, StartResult } from '../pty.ts'
import type { Transcript } from '../sessionFile.ts'

/**
 * Serves Stoke's sessions to a phone or another browser.
 *
 * The intended deployment is a Cloudflare Tunnel pointing a hostname at this
 * loopback port, with Cloudflare Access in front for identity. The bearer token
 * below is deliberately kept as well: if the tunnel is up and the Access policy
 * is misconfigured or removed, a token is all that stands between the internet
 * and a shell on this machine.
 */

export interface RemoteDeps {
  ptys: () => PtyManager | null
  watcher: () => ContextWatcher | null
  listProjects: () => Promise<Project[]>
  startSession: (opts: LaunchOptions) => Promise<StartResult>
  defaultCwd: () => string
  /** Past sessions for a project, read from Claude Code's own transcripts. */
  listSessions: (projectPath: string) => Promise<SessionMeta[]>
  /** The conversation in a past session, for reading it back. */
  readTranscript: (sessionId: string) => Promise<Transcript | null>
}

export interface RemoteConfig {
  port: number
  token: string
  /** Bind on the LAN too, not just loopback. Off by default. */
  bindLan: boolean
  /** Reject anything without Cloudflare Access headers, so only the tunnel works. */
  requireAccessHeader: boolean
}

export interface RemoteStatus {
  running: boolean
  port: number
  error: string | null
  clients: number
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8'
}

export function generateToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * The link to open on the phone. Prefers the tunnel hostname; falls back to a
 * LAN address when the server is bound beyond loopback, and otherwise localhost
 * (useful only on this machine, but it makes the state obvious).
 */
export function connectUrl(opts: {
  hostname: string
  port: number
  token: string
  bindLan: boolean
}): string {
  const key = `?k=${encodeURIComponent(opts.token)}`
  if (opts.hostname.trim()) return `https://${opts.hostname.trim()}/${key}`
  if (opts.bindLan) {
    const nets = networkInterfaces()
    for (const list of Object.values(nets)) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) {
          return `http://${net.address}:${opts.port}/${key}`
        }
      }
    }
  }
  return `http://127.0.0.1:${opts.port}/${key}`
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export class RemoteServer {
  private http: Server | null = null
  private wss: WebSocketServer | null = null
  private config: RemoteConfig | null = null
  private error: string | null = null
  private clients = new Set<WebSocket>()
  private offData: (() => void) | null = null
  private offExit: (() => void) | null = null
  /** ptyId -> sockets attached to it. */
  private attached = new Map<string, Set<WebSocket>>()

  private readonly deps: RemoteDeps

  constructor(deps: RemoteDeps) {
    this.deps = deps
  }

  status(): RemoteStatus {
    return {
      running: this.http !== null,
      port: this.config?.port ?? 0,
      error: this.error,
      clients: this.clients.size
    }
  }

  async start(config: RemoteConfig): Promise<RemoteStatus> {
    await this.stop()
    this.error = null
    this.config = config

    try {
      const server = createServer((req, res) => void this.handleHttp(req, res))
      const wss = new WebSocketServer({ noServer: true })

      server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head, wss))
      wss.on('connection', (ws, req) => this.handleSocket(ws, req))

      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(config.port, config.bindLan ? '0.0.0.0' : '127.0.0.1', () => resolve())
      })

      this.http = server
      this.wss = wss

      // Fan PTY output out to every attached remote client.
      const ptys = this.deps.ptys()
      if (ptys) {
        this.offData = ptys.subscribe((ptyId, data) => {
          this.broadcast(ptyId, { type: 'data', ptyId, data })
        })
        this.offExit = ptys.subscribeExit((ptyId, code) => {
          this.broadcast(ptyId, { type: 'exit', ptyId, code })
        })
      }
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    }

    return this.status()
  }

  async stop(): Promise<void> {
    this.offData?.()
    this.offExit?.()
    this.offData = null
    this.offExit = null

    for (const ws of this.clients) ws.close()
    this.clients.clear()
    this.attached.clear()

    this.wss?.close()
    this.wss = null

    if (this.http) {
      const server = this.http
      this.http = null
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  private broadcast(ptyId: string, message: unknown): void {
    const set = this.attached.get(ptyId)
    if (!set) return
    const text = JSON.stringify(message)
    for (const ws of set) {
      if (ws.readyState === 1) ws.send(text)
    }
  }

  /* --------------------------------------------------------------- auth */

  private tokenFrom(req: IncomingMessage): string | null {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const q = url.searchParams.get('k')
    if (q) return q

    const auth = req.headers.authorization
    if (auth?.startsWith('Bearer ')) return auth.slice(7)

    const cookie = req.headers.cookie ?? ''
    const match = /(?:^|;\s*)stoke_key=([^;]+)/.exec(cookie)
    return match ? decodeURIComponent(match[1]) : null
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.config) return false

    if (this.config.requireAccessHeader) {
      // Cloudflare Access injects these; their absence means the request did not
      // come through the tunnel.
      const hasAccess =
        req.headers['cf-access-jwt-assertion'] !== undefined ||
        req.headers['cf-access-authenticated-user-email'] !== undefined
      if (!hasAccess) return false
    }

    const token = this.tokenFrom(req)
    return token !== null && safeEqual(token, this.config.token)
  }

  /* --------------------------------------------------------------- http */

  private async handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost')

    if (!this.authorized(req)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Unauthorized. Open the link from Stoke, which carries the key.')
      return
    }

    // First visit arrives with ?k=<token>; park it in a cookie so later asset
    // and socket requests authenticate without the key in every URL.
    const queryKey = url.searchParams.get('k')
    const setCookie: Record<string, string> = queryKey
      ? {
          'set-cookie': `stoke_key=${encodeURIComponent(queryKey)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`
        }
      : {}

    try {
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        return this.json(res, await this.sessionList(), setCookie)
      }
      if (url.pathname === '/api/projects' && req.method === 'GET') {
        const projects = await this.deps.listProjects()
        return this.json(
          res,
          {
            defaultCwd: this.deps.defaultCwd(),
            projects: projects.slice(0, 60).map((p) => ({
              path: p.path,
              name: p.name,
              sessionCount: p.sessionCount,
              lastModified: p.lastModified
            }))
          },
          setCookie
        )
      }
      /*
       * Past sessions. Without these the phone can only see what happens to be
       * running on the desktop this second, which is almost never what someone
       * opening the site is looking for — the work they did earlier is in
       * Claude Code's transcripts, and the desktop app has always read them.
       */
      if (url.pathname === '/api/history' && req.method === 'GET') {
        const cwd = url.searchParams.get('cwd')
        if (!cwd) return this.json(res, { error: 'cwd is required' }, setCookie, 400)
        const sessions = await this.deps.listSessions(cwd)
        return this.json(res, { cwd, sessions: sessions.slice(0, 100) }, setCookie)
      }

      if (url.pathname === '/api/transcript' && req.method === 'GET') {
        const id = url.searchParams.get('id')
        if (!id) return this.json(res, { error: 'id is required' }, setCookie, 400)
        const transcript = await this.deps.readTranscript(id)
        if (!transcript) return this.json(res, { error: 'no such session' }, setCookie, 404)
        return this.json(res, transcript, setCookie)
      }

      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const body = (await this.readJson(req)) as Partial<LaunchOptions> | null
        const cwd = body?.cwd || this.deps.defaultCwd()
        const started = await this.deps.startSession({
          cwd,
          // Resuming needs both flags: the id says which transcript, and
          // resume turns it into --resume rather than --session-id, which
          // would instead try to create a session that already exists.
          sessionId: body?.sessionId,
          resume: body?.resume === true && Boolean(body?.sessionId),
          permissionMode: body?.permissionMode ?? 'default',
          model: body?.model ?? '',
          effort: body?.effort ?? 'default',
          cols: 100,
          rows: 30
        })
        return this.json(res, started, setCookie)
      }

      await this.serveStatic(url.pathname, res, setCookie)
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(err instanceof Error ? err.message : String(err))
    }
  }

  private async sessionList(): Promise<
    {
      ptyId: string
      sessionId: string
      cwd: string
      name: string
      startedAt: number
      cols: number
      rows: number
      context: ContextSnapshot | null
    }[]
  > {
    const ptys = this.deps.ptys()
    const watcher = this.deps.watcher()
    if (!ptys) return []
    return ptys.list().map((s) => ({
      ptyId: s.ptyId,
      sessionId: s.sessionId,
      cwd: s.cwd,
      name: s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd,
      startedAt: s.startedAt,
      cols: s.cols,
      rows: s.rows,
      context: watcher?.snapshot(s.sessionId) ?? null
    }))
  }

  private json(
    res: ServerResponse,
    body: unknown,
    extra: Record<string, string> = {},
    status = 200
  ): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra })
    res.end(JSON.stringify(body))
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks).toString('utf8')
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }

  /** Static files for the mobile UI, built separately into out/remote. */
  private async serveStatic(
    pathname: string,
    res: ServerResponse,
    extra: Record<string, string>
  ): Promise<void> {
    const root = join(app.getAppPath(), 'out', 'remote')
    const rel = pathname === '/' || pathname === '' ? 'index.html' : pathname.replace(/^\/+/, '')

    // Contain the path: a request for ../../ must not escape the bundle.
    const target = normalize(join(root, rel))
    if (!target.startsWith(root + sep) && target !== join(root, 'index.html')) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }

    try {
      const data = await readFile(target)
      res.writeHead(200, {
        'content-type': MIME[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
        ...extra
      })
      res.end(data)
    } catch {
      // Single-page app: unknown paths fall back to the shell.
      try {
        const html = await readFile(join(root, 'index.html'))
        res.writeHead(200, { 'content-type': MIME['.html'], ...extra })
        res.end(html)
      } catch {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('The remote UI is not built. Run `npm run build`.')
      }
    }
  }

  /* ---------------------------------------------------------- websocket */

  private handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    wss: WebSocketServer
  ): void {
    if (!this.authorized(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
  }

  private handleSocket(ws: WebSocket, req: IncomingMessage): void {
    this.clients.add(ws)
    const url = new URL(req.url ?? '/', 'http://localhost')
    const ptyId = url.searchParams.get('ptyId')
    const ptys = this.deps.ptys()

    if (!ptyId || !ptys) {
      ws.close()
      this.clients.delete(ws)
      return
    }

    let set = this.attached.get(ptyId)
    if (!set) {
      set = new Set()
      this.attached.set(ptyId, set)
    }
    set.add(ws)

    const info = ptys.list().find((s) => s.ptyId === ptyId)
    ws.send(
      JSON.stringify({
        type: 'attached',
        ptyId,
        cols: info?.cols ?? 100,
        rows: info?.rows ?? 30,
        history: ptys.historyFor(ptyId)
      })
    )

    ws.on('message', (raw) => {
      let msg: { type?: string; data?: string; cols?: number; rows?: number; force?: boolean }
      try {
        msg = JSON.parse(String(raw))
      } catch {
        return
      }
      const manager = this.deps.ptys()
      if (!manager) return

      if (msg.type === 'input' && typeof msg.data === 'string') {
        manager.write(ptyId, msg.data)
      } else if (msg.type === 'resize' && msg.force && msg.cols && msg.rows) {
        // Only on explicit request: a phone resizing the PTY reflows the
        // desktop terminal too, which is jarring if someone is sitting at it.
        manager.resize(ptyId, msg.cols, msg.rows)
      }
    })

    const drop = (): void => {
      set?.delete(ws)
      this.clients.delete(ws)
    }
    ws.on('close', drop)
    ws.on('error', drop)
  }
}
