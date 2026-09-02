import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { extname, join, normalize, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { app } from 'electron'
import { WebSocketServer, type WebSocket } from 'ws'
import type { ContextSnapshot, LaunchOptions, Project, SessionMeta, Theme } from '@shared/types'
import type { ContextWatcher } from '../context.ts'
import type { PtyManager, StartResult } from '../pty.ts'
import type { Transcript } from '../sessionFile.ts'
import { MAX_AUDIO_BYTES, transcribe } from '../stt.ts'
import { isTailnetAddress, tailnetAddress } from './link.ts'

/*
 * `connectUrl` is deliberately absent: it returned `connectTarget(...).url` and
 * had no caller anywhere in src/, so it was a second entry point that took the
 * same options and silently discarded the `reach` half of the answer. One way
 * in, or the next reader picks the one that cannot say how the link gets there.
 */
export { connectTarget, isTailnetAddress, lanAddresses, tailnetAddress } from './link.ts'
export type { ConnectTarget, Reach } from './link.ts'

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
  /**
   * The SSH host a session runs on, or null for a local one. An SSH session's
   * `cwd` is the LOCAL folder Stoke happened to be pointed at (CLAUDE.md
   * gotcha 18), so naming the session by it on the phone names the wrong
   * machine entirely.
   */
  hostFor: (sessionId: string) => string | null
  /**
   * The theme the desktop is painting, so the phone can paint the same one.
   * The mobile bundle used to carry a hand copy of one palette that drifted
   * every time the desktop's moved (gotcha 43); serving it is the fix.
   */
  theme: () => { theme: Theme; fontFamily: string }
}

/** Session ids are UUIDs, and they are joined onto filesystem paths. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Returned by readJson for a body that arrived but would not parse. */
const BAD_JSON = Symbol('bad-json')

export interface RemoteConfig {
  port: number
  token: string
  /** Public hostname the tunnel points at; used to police WebSocket origins. */
  hostname: string
  /** Bind on the LAN too, not just loopback. Off by default. */
  bindLan: boolean
  /**
   * Bind the Tailscale address as well as loopback, so a phone on the tailnet
   * reaches this directly without the tunnel. Unlike `bindLan` this exposes the
   * port to the tailnet only, never to whatever network the machine is on.
   */
  bindTailscale: boolean
  /**
   * Reject anything without Cloudflare Access headers, so only the tunnel works.
   *
   * Enforced on the loopback listener only — see `viaLoopback`.
   */
  requireAccessHeader: boolean
  /**
   * Speech-to-text sidecar, e.g. `http://127.0.0.1:17890`.
   *
   * Empty does not hide the microphone — the button is gated on browser
   * capability alone — it fails at press time with a 503 from `/api/transcribe`.
   *
   * Stoke proxies to it rather than letting the phone reach it directly: the
   * sidecar has no authentication of its own, so publishing it through the
   * tunnel would put an open transcription endpoint on the internet.
   */
  sttUrl: string
}

export interface RemoteStatus {
  running: boolean
  port: number
  error: string | null
  clients: number
  /** Addresses actually bound, so the UI can offer a tailnet link as well as the tunnel. */
  addresses: string[]
  /** How many phones are attached to each pty, so a tab can say one is watching. */
  attachedByPty: Record<string, number>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8'
}

export function generateToken(): string {
  return randomBytes(24).toString('base64url')
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export class RemoteServer {
  private servers: Server[] = []
  private bound: string[] = []
  private wss: WebSocketServer | null = null
  private config: RemoteConfig | null = null
  private error: string | null = null
  private clients = new Set<WebSocket>()
  private offData: (() => void) | null = null
  private offExit: (() => void) | null = null
  /** ptyId -> sockets attached to it. */
  private attached = new Map<string, Set<WebSocket>>()
  /**
   * The desktop's own size for a pty a phone has resized, so it can be put
   * back when the last phone leaves. A phone that fits the terminal to its
   * own screen reflows the desktop's xterm to forty columns under whoever is
   * sitting at it, and nothing used to undo that.
   */
  private desktopSize = new Map<string, { cols: number; rows: number }>()

  private readonly deps: RemoteDeps
  /** Told whenever a client attaches or leaves, so the desktop can say so. */
  private readonly onClientsChanged: () => void

  constructor(deps: RemoteDeps, onClientsChanged: () => void = () => {}) {
    this.deps = deps
    this.onClientsChanged = onClientsChanged
  }

  status(): RemoteStatus {
    const attachedByPty: Record<string, number> = {}
    for (const [ptyId, set] of this.attached) if (set.size) attachedByPty[ptyId] = set.size
    return {
      running: this.servers.length > 0,
      port: this.config?.port ?? 0,
      error: this.error,
      clients: this.clients.size,
      addresses: [...this.bound],
      attachedByPty
    }
  }

  async start(config: RemoteConfig): Promise<RemoteStatus> {
    await this.stop()
    this.error = null
    this.config = config

    try {
      const wss = new WebSocketServer({ noServer: true })
      wss.on('connection', (ws, req) => this.handleSocket(ws, req))

      const listen = async (host: string): Promise<void> => {
        const server = createServer((req, res) => void this.handleHttp(req, res))
        server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head, wss))
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(config.port, host, () => resolve())
        })
        this.servers.push(server)
        this.bound.push(host)
      }

      /*
       * cloudflared runs on this machine and dials 127.0.0.1, so loopback must
       * always be bound or the tunnel has nothing to reach. Opening the LAN is
       * still all-or-nothing via 0.0.0.0, which already covers loopback and the
       * tailnet - binding it alongside 127.0.0.1 would collide on the port.
       */
      await listen(config.bindLan ? '0.0.0.0' : '127.0.0.1')

      /*
       * The tailnet address is bound as a second listener rather than instead of
       * loopback, so the tunnel and a direct tailnet connection both work. It is
       * best effort: Tailscale may be down or not installed, and that must not
       * take the whole remote server with it.
       */
      if (config.bindTailscale && !config.bindLan) {
        const tailnet = tailnetAddress()
        if (tailnet) {
          try {
            await listen(tailnet)
          } catch (err) {
            this.error = `bound loopback but not the tailnet address ${tailnet}: ${
              err instanceof Error ? err.message : String(err)
            }`
          }
        } else {
          this.error = 'Tailscale is enabled but no tailnet address was found on this machine'
        }
      }

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

    const servers = this.servers
    this.servers = []
    this.bound = []
    await Promise.all(
      servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
    )
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

  /**
   * Is this handshake from our own page?
   *
   * A missing Origin is allowed: non-browser clients (the verification scripts,
   * curl) send none, and they are already gated by the token. What must be
   * refused is an Origin belonging to somebody else's site.
   */
  private sameOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin
    if (!origin) return true

    let host: string
    try {
      host = new URL(origin).host
    } catch {
      return false
    }

    const configured = this.config?.hostname?.trim()
    if (configured && host === configured) return true
    // The Host header covers loopback and LAN use, where there is no
    // configured public hostname to compare against.
    return Boolean(req.headers.host) && host === req.headers.host
  }

  /**
   * Is this a directory the desktop already knows about?
   *
   * `cwd` came straight from the request body into spawn, so any path on the
   * machine could be used as a working directory for a new agent. Sessions may
   * only start where a project already exists.
   */
  private async knownCwd(cwd: string): Promise<boolean> {
    if (!cwd || typeof cwd !== 'string') return false
    if (cwd === this.deps.defaultCwd()) return true
    const normalised = normalize(cwd).replace(/[\\/]+$/, '').toLowerCase()
    const projects = await this.deps.listProjects()
    return projects.some(
      (p) => normalize(p.path).replace(/[\\/]+$/, '').toLowerCase() === normalised
    )
  }

  /**
   * True when the request came in on the loopback listener, which is where
   * cloudflared delivers tunnel traffic. Read from the local end of the socket,
   * so it reflects which listener accepted the connection and cannot be forged
   * by a header.
   */
  private viaLoopback(req: IncomingMessage): boolean {
    const local = req.socket.localAddress ?? ''
    return local === '127.0.0.1' || local === '::1' || local === '::ffff:127.0.0.1'
  }

  /**
   * True when this request came in on the dedicated tailnet listener.
   *
   * Requires `bindTailscale` and NOT `bindLan`: with the LAN open there is a
   * single 0.0.0.0 listener and no separate tailnet socket to be sure about, so
   * the exemption is withheld and Access is enforced as it was in 0.3.2. Read
   * from the local end of the socket, so a header cannot forge it.
   */
  private viaTailnet(req: IncomingMessage): boolean {
    if (!this.config?.bindTailscale || this.config.bindLan) return false
    return isTailnetAddress(req.socket.localAddress ?? '')
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.config) return false

    /*
     * Access headers are only meaningful on loopback, because that is the only
     * listener the tunnel arrives on. A request that came in on the tailnet
     * address reached the machine directly and can never carry them, so
     * enforcing the check there would 401 every device on the VPN. Those
     * requests are gated by tailnet membership plus the token instead, which is
     * why binding the tailnet is opt-in and off by default.
     */
    /*
     * Exempt exactly one thing: a request that arrived on the dedicated tailnet
     * listener. Ask that directly rather than inferring it.
     *
     * Two earlier attempts got this wrong in opposite directions, both silently.
     * Keying on `viaLoopback` alone also exempted the LAN, because bindLan
     * collapses everything onto one 0.0.0.0 listener where localAddress is the
     * interface IP. Adding a `!bindLan` guard then inverted the common case: with
     * bindLan off - which is the whole Tailscale configuration - the condition
     * was always true, so every tailnet request 401'd, including the WebSocket
     * upgrade, and the terminal simply never opened.
     */
    if (this.config.requireAccessHeader && !this.viaTailnet(req)) {
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
          /*
           * The cookie is a shell credential, so it carries Secure and must
           * never ride a plaintext request - except when this request did not
           * come through the tunnel, which is plain HTTP by definition and
           * where Secure would simply stop the cookie being stored at all.
           *
           * Keyed off how this request arrived rather than off bindLan, because
           * a tailnet connection is http://100.x.y.z:port too. Keying it off
           * the config would send Secure to a phone on the tailnet, the browser
           * would silently drop the cookie, and every request after the first
           * would 401 with nothing to explain why.
           *
           * SameSite stays Lax, not Strict: Cloudflare Access bounces the user
           * to its own hostname and back, and Strict withholds the cookie on
           * that return navigation, locking the user out of their own site.
           * Cross-site WebSocket handshakes are non-navigational, so Lax
           * already withholds there, which is the case that mattered.
           *
           * Ninety days rather than a year.
           */
          'set-cookie':
            `stoke_key=${encodeURIComponent(queryKey)}; Path=/; HttpOnly;` +
            `${this.viaLoopback(req) && !this.config?.bindLan ? ' Secure;' : ''}` +
            ` SameSite=Lax; Max-Age=7776000`
        }
      : {}

    try {
      if (url.pathname === '/api/sessions' && req.method === 'GET') {
        return this.json(res, await this.sessionList(), setCookie)
      }
      /*
       * Which machine this is. With one desktop it is noise; with a laptop and
       * a desktop behind the same bookmarks, two tabs are indistinguishable and
       * it is entirely possible to start work on the wrong computer.
       */
      if (url.pathname === '/api/host' && req.method === 'GET') {
        return this.json(res, { machine: hostname(), platform: process.platform }, setCookie)
      }
      /*
       * The colours this window is painting, so the phone paints the same
       * ones. Before this the mobile bundle carried a hand copy of one palette
       * that no suite could see and that had drifted to pre-ladder values: the
       * phone's terminal was a different black from its own page.
       */
      if (url.pathname === '/api/theme' && req.method === 'GET') {
        const { theme, fontFamily } = this.deps.theme()
        return this.json(
          res,
          { appearance: theme.appearance, colors: theme.colors, terminal: theme.terminal, fontFamily },
          setCookie
        )
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
        /*
         * Session ids are UUIDs and are joined onto a path. Without this an
         * `id` of `../../../../something` escaped the transcript directory and
         * read any .jsonl on the machine.
         */
        if (!UUID.test(id)) return this.json(res, { error: 'bad session id' }, setCookie, 400)
        const transcript = await this.deps.readTranscript(id)
        if (!transcript) return this.json(res, { error: 'no such session' }, setCookie, 404)
        return this.json(res, transcript, setCookie)
      }

      /*
       * Dictation. The phone records, converts to 16-bit PCM WAV in the browser
       * and posts the bytes here; we forward them to the speech sidecar. The
       * conversion has to happen on the phone because the sidecar validates the
       * RIFF header and rejects anything that is not 16-bit PCM WAV, and doing
       * it here would mean shipping ffmpeg.
       */
      if (url.pathname === '/api/transcribe' && req.method === 'POST') {
        const audio = await this.readBody(req, MAX_AUDIO_BYTES)
        if (!audio) {
          return this.json(res, { error: 'Recording too large or empty.' }, setCookie, 400)
        }
        /*
         * The call itself lives in ../stt.ts, which the desktop's dictation
         * uses too. Only the status code is decided here, because only this
         * caller speaks HTTP: 503 when no server is configured — the shipped
         * state, and not this request's fault — 502 for anything that went
         * wrong reaching one.
         */
        const result = await transcribe(this.config?.sttUrl, new Uint8Array(audio))
        if (!result.ok) {
          const configured = Boolean(this.config?.sttUrl?.trim())
          return this.json(res, { error: result.error }, setCookie, configured ? 502 : 503)
        }
        return this.json(res, { text: result.text }, setCookie)
      }

      if (url.pathname === '/api/sessions' && req.method === 'POST') {
        const parsed = await this.readJson(req)
        /*
         * A body that failed to parse used to read as "no body" and quietly
         * started a session in the default directory. A truncated request now
         * fails loudly instead of launching a real process somewhere unasked.
         */
        if (parsed === BAD_JSON) {
          return this.json(res, { error: 'Malformed JSON body.' }, setCookie, 400)
        }
        const body = parsed as Partial<LaunchOptions> | null

        /*
         * The phone may not start an unsandboxed agent. `bypassPermissions`
         * becomes --dangerously-skip-permissions, and the desktop guards it
         * behind an explicit confirmation; this route had no equivalent and the
         * UI never offered it, so accepting it turned "drive a terminal someone
         * is watching" into "spawn a silent autonomous agent anywhere on disk".
         */
        const requested = body?.permissionMode ?? 'default'
        if (requested === 'bypassPermissions') {
          return this.json(
            res,
            { error: 'Bypass permissions cannot be started remotely. Use the desktop app.' },
            setCookie,
            403
          )
        }

        /*
         * The working directory has to be one the desktop already knows about.
         * It was passed straight to spawn, so any path on the machine was fair
         * game, and a bad one threw a message that leaked absolute paths back.
         */
        const cwd = body?.cwd || this.deps.defaultCwd()
        if (!(await this.knownCwd(cwd))) {
          return this.json(res, { error: 'Unknown project directory.' }, setCookie, 400)
        }

        const started = await this.deps.startSession({
          cwd,
          // Resuming needs both flags: the id says which transcript, and
          // resume turns it into --resume rather than --session-id, which
          // would instead try to create a session that already exists.
          sessionId: typeof body?.sessionId === 'string' && UUID.test(body.sessionId)
            ? body.sessionId
            : undefined,
          resume: body?.resume === true && Boolean(body?.sessionId),
          permissionMode: requested,
          model: typeof body?.model === 'string' ? body.model : '',
          effort: body?.effort ?? 'default',
          cols: 100,
          rows: 30
        })
        return this.json(res, started, setCookie)
      }

      /*
       * Anything under /api that reached here matched no route - usually the
       * right path with the wrong method. It must not fall through to the
       * static handler, which answers unknown paths with the SPA shell: a
       * client calling .json() on that gets a parse error instead of a status
       * it can act on.
       */
      if (url.pathname.startsWith('/api/')) {
        return this.json(res, { error: 'No such endpoint or method.' }, setCookie, 404)
      }

      await this.serveStatic(url.pathname, res, setCookie)
    } catch (err) {
      // The message can carry absolute paths and internal detail, so it goes to
      // the log rather than to whoever asked.
      console.error('[remote]', err)
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('Internal error.')
    }
  }

  private async sessionList(): Promise<
    {
      ptyId: string
      sessionId: string
      cwd: string
      name: string
      /** The SSH host label when the session runs elsewhere, else null. */
      host: string | null
      /** True once the process has ended; the phone draws it as ended, not idle. */
      exited: boolean
      startedAt: number
      cols: number
      rows: number
      context: ContextSnapshot | null
    }[]
  > {
    const ptys = this.deps.ptys()
    const watcher = this.deps.watcher()
    if (!ptys) return []
    return ptys.list().map((s) => {
      const host = this.deps.hostFor(s.sessionId)
      return {
        ptyId: s.ptyId,
        sessionId: s.sessionId,
        cwd: s.cwd,
        // An SSH session's cwd is a local folder that has nothing to do with
        // where it runs (gotcha 18), so the host is the honest name.
        name: host ?? (s.cwd.split(/[\\/]/).filter(Boolean).pop() ?? s.cwd),
        host,
        exited: s.exited,
        startedAt: s.startedAt,
        cols: s.cols,
        rows: s.rows,
        context: watcher?.snapshot(s.sessionId) ?? null
      }
    })
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

  /** Raw request body, refused past `limit` so a bad client cannot exhaust memory. */
  private async readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req) {
      const buf = chunk as Buffer
      size += buf.length
      if (size > limit) return null
      chunks.push(buf)
    }
    return size ? Buffer.concat(chunks) : null
  }

  private async readJson(req: IncomingMessage): Promise<unknown> {
    // Bounded like readBody. Unbounded, an endless request body exhausts the
    // main process, which takes down every running session rather than one call.
    const body = await this.readBody(req, 256 * 1024)
    const raw = body ? body.toString('utf8') : ''
    if (!raw) return null
    try {
      return JSON.parse(raw)
    } catch {
      // Distinct from null: "you sent something broken" and "you sent nothing"
      // must not lead to the same behaviour.
      return BAD_JSON
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
    /*
     * Reject cross-origin handshakes before authorising.
     *
     * A WebSocket handshake is not subject to the same-origin policy, and the
     * cookie is a complete credential on its own, so any page the user visits
     * could otherwise open a socket here and drive the terminal. Current
     * browsers withhold a SameSite=Lax cookie from this non-navigational
     * request, which blocks the drive-by today - but that is browser behaviour,
     * not this server's doing, and it does not hold for embedded WebViews or
     * any non-browser client. An origin allowlist is the actual defence.
     */
    if (!this.sameOrigin(req)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.destroy()
      return
    }
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

    /*
     * Attaching to a pty that does not exist used to succeed: the client got an
     * `attached` frame with empty history and then sat forever on a terminal
     * that would never produce a byte. Say so instead - a session that died on
     * startup is the common cause, and silence makes it look like a hang.
     */
    if (!ptys.list().some((s) => s.ptyId === ptyId)) {
      ws.send(JSON.stringify({ type: 'exit', code: null, reason: 'That session is no longer running.' }))
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
    this.onClientsChanged()

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
    /*
     * A process that has already ended is still listed — the desktop keeps
     * its tab so the output can be read — but it will never write again. Say
     * so straight after the replay, or the phone shows a terminal that looks
     * alive and simply never answers.
     */
    if (info?.exited) {
      ws.send(JSON.stringify({ type: 'exit', ptyId, code: null, reason: 'That session has ended.' }))
    }

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
        /*
         * Only on explicit request: a phone resizing the PTY reflows the
         * desktop terminal too, which is jarring if someone is sitting at it.
         * The desktop's own size is remembered the first time a phone changes
         * it, so `drop` below can put it back when the last phone leaves.
         */
        if (!this.desktopSize.has(ptyId)) {
          const now = manager.list().find((s) => s.ptyId === ptyId)
          if (now) this.desktopSize.set(ptyId, { cols: now.cols, rows: now.rows })
        }
        manager.resize(ptyId, msg.cols, msg.rows)
      }
    })

    const drop = (): void => {
      set?.delete(ws)
      this.clients.delete(ws)
      if (set && set.size === 0) {
        const saved = this.desktopSize.get(ptyId)
        if (saved) {
          this.desktopSize.delete(ptyId)
          this.deps.ptys()?.resize(ptyId, saved.cols, saved.rows)
        }
      }
      this.onClientsChanged()
    }
    ws.on('close', drop)
    ws.on('error', drop)
  }
}
