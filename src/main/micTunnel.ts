/**
 * Main's half of the lent microphone (shared/micTunnel.ts has the why).
 *
 * One listener per SSH tab connection whose host lends the microphone: a Unix
 * socket in a private (0700) folder of its own, or `127.0.0.1:<port>` on
 * Windows, behind that connection's `-o RemoteForward=`. A connection must
 * send the token first (the random part of its far socket's name) or it is
 * closed at once; then the gate (`micGateAdmit`) decides, from the keys and
 * the pane state the renderer reports for that tab, whether anyone is talking
 * to that `claude` right now. A refusal closes the socket with no byte
 * written. An admission asks the tab's renderer to open the microphone and
 * writes the 16 kHz PCM frames it sends back until the first stop rule fires.
 *
 * No electron import, so verify:mic-tunnel drives it under
 * `node --experimental-strip-types` with a fake renderer. Relative `.ts`
 * imports, no parameter properties.
 */
import { execFile } from 'node:child_process'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIC_BACKLOG_MAX_BYTES,
  MIC_GATE_IDLE,
  MIC_REFUSAL_WORDS,
  MIC_TOKEN_WAIT_MS,
  isMicLocalEndpoint,
  micForwardOption,
  micGateAdmit,
  micGateEnded,
  micGateKey,
  micGatePane,
  micGateTick,
  micSetupBody,
  micTokenLine,
  parseMicSetup,
  type MicCloseEvent,
  type MicGateState,
  type MicInstallResult,
  type MicKey,
  type MicMode,
  type MicOpenEvent,
  type MicPane,
  type MicRefusal,
  type MicStopReason
} from '../shared/micTunnel.ts'
import { MIC_STAND_IN } from '../shared/micStandIn.ts'
import type { SshHost } from '../shared/types.ts'
import { buildMicSetupArgs, sshChildEnv, sshExecutable } from './ssh.ts'
import { prepareSshRoute } from './sshRoutes.ts'


export interface MicTunnelDeps {
  /** Send to the renderer (by webContents id) that shows the tab. */
  send(ownerId: number, event: { open: MicOpenEvent } | { close: MicCloseEvent }): void
  /** Main's own reading of that renderer's window: focused, by the OS. */
  windowFocused(ownerId: number): boolean
  now?: () => number
  log?: (line: string) => void
  platform?: NodeJS.Platform
  /** Where the private folders go. Tests point it at a scratch folder. */
  tmpRoot?: string
  /** How often a live stream is checked against its deadline and the window's focus. */
  tickMs?: number
}

/** A forward minted for one connection, before its pty exists. */
export interface MicLease {
  /** The `-o` value for `buildSshArgs`. */
  forward: string
  /** The pty this connection became: from now on the gate may admit. */
  attach(ptyId: string): void
  /** The launch failed: close the listener and its folder. */
  release(): void
}

/** Constant-time compare of two hex tokens of the same length. */
function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a, 'latin1')
  const y = Buffer.from(b, 'latin1')
  return x.length === y.length && timingSafeEqual(x, y)
}

function bytesOf(data: unknown): Buffer | null {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return null
}

/** The biggest frame main takes from a renderer: a second of audio, far over the 640 B a frame is. */
const MAX_FRAME_BYTES = 32_000

interface Live {
  id: string
  socket: Socket
  mode: MicMode
}

class Tunnel {
  readonly token: string
  readonly hostId: string
  readonly server: Server
  readonly dir: string | null
  readonly local: string
  ptyId: string | null = null
  owner: number | null = null
  gate: MicGateState = MIC_GATE_IDLE
  live: Live | null = null
  closed = false
  private readonly waiting = new Set<Socket>()
  private ticker: ReturnType<typeof setInterval> | null = null
  private readonly deps: MicTunnelDeps
  private readonly onStream: (t: Tunnel, live: Live | null) => void

  constructor(
    init: { token: string; hostId: string; server: Server; dir: string | null; local: string },
    deps: MicTunnelDeps,
    onStream: (t: Tunnel, live: Live | null) => void
  ) {
    this.token = init.token
    this.hostId = init.hostId
    this.server = init.server
    this.dir = init.dir
    this.local = init.local
    this.deps = deps
    this.onStream = onStream
    this.server.on('connection', (sock) => this.accept(sock))
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private log(line: string): void {
    ;(this.deps.log ?? ((l: string) => console.log(l)))(`[stoke] mic tunnel: ${line}`)
  }

  private refuse(sock: Socket, why: MicRefusal | 'token' | 'unbound'): void {
    this.waiting.delete(sock)
    sock.destroy()
    this.log(`refused a connection (${MIC_REFUSAL_WORDS[why]})`)
  }

  /** A connection through the forward: token first, then the gate. Nothing is written before both pass. */
  private accept(sock: Socket): void {
    if (this.closed) {
      sock.destroy()
      return
    }
    this.waiting.add(sock)
    sock.on('error', () => {})
    let buffered = ''
    const timer = setTimeout(() => this.refuse(sock, 'token'), MIC_TOKEN_WAIT_MS)
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('latin1')
      const line = micTokenLine(buffered)
      if (!line.done) return
      clearTimeout(timer)
      sock.off('data', onData)
      if (!line.token || !sameToken(line.token, this.token)) return this.refuse(sock, 'token')
      this.decide(sock)
    }
    sock.on('data', onData)
    sock.on('close', () => {
      clearTimeout(timer)
      this.waiting.delete(sock)
    })
  }

  private decide(sock: Socket): void {
    if (this.closed || this.ptyId === null) return this.refuse(sock, 'unbound')
    const focused = this.owner !== null && this.deps.windowFocused(this.owner)
    const { state, verdict } = micGateAdmit(this.gate, this.now(), focused)
    if (!verdict.ok) return this.refuse(sock, verdict.reason)
    this.gate = state
    this.waiting.delete(sock)
    const live: Live = { id: randomBytes(8).toString('hex'), socket: sock, mode: verdict.mode }
    this.live = live
    sock.setNoDelay?.(true)
    // Whatever the far side sends after its token is read and dropped, so it
    // can never fill a buffer here.
    sock.on('data', () => {})
    sock.on('close', () => {
      if (this.live === live) this.stop('closed')
    })
    this.onStream(this, live)
    this.log(`streaming to ${this.hostId} (${verdict.mode})`)
    this.deps.send(this.owner!, { open: { streamId: live.id, ptyId: this.ptyId, hostId: this.hostId, mode: verdict.mode } })
    const every = this.deps.tickMs ?? 250
    this.ticker = setInterval(() => this.tick(), every)
  }

  private tick(): void {
    if (!this.live) return
    const due = micGateTick(this.gate, this.now())
    if (due) return this.stop(due)
    if (this.owner === null || !this.deps.windowFocused(this.owner)) this.stop('blur')
  }

  stop(reason: MicStopReason): void {
    const live = this.live
    if (!live) return
    this.live = null
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.gate = micGateEnded(this.gate)
    live.socket.destroy()
    this.onStream(this, null)
    this.log(`stopped (${reason})`)
    if (this.owner !== null && this.ptyId !== null) {
      this.deps.send(this.owner, { close: { streamId: live.id, ptyId: this.ptyId, reason } })
    }
  }

  key(owner: number, kind: MicKey): void {
    if (owner !== this.owner) return
    const step = micGateKey(this.gate, kind, this.now())
    this.gate = step.state
    if (step.stop) this.stop(step.stop)
  }

  pane(owner: number, pane: MicPane): void {
    // The window showing the tab owns its reports; a window it left (a tab
    // moved to another) may report "not in front" late, and is not heard.
    if (pane.front) {
      /*
       * Another window took the tab while it streamed (a tab moved): the
       * microphone is open in the OLD window, and only it can close it. End
       * the stream first, so `stop` tells that window, then hand over. The
       * new window never opened anything for it.
       */
      if (owner !== this.owner && this.live) this.stop('tab')
      this.owner = owner
    } else if (owner !== this.owner) return
    const step = micGatePane(this.gate, pane)
    this.gate = step.state
    if (step.stop) this.stop(step.stop)
  }

  frame(owner: number, streamId: string, data: unknown): void {
    const live = this.live
    if (!live || live.id !== streamId || owner !== this.owner) return
    const bytes = bytesOf(data)
    if (!bytes || bytes.length === 0 || bytes.length > MAX_FRAME_BYTES) return
    if (live.socket.writableLength > MIC_BACKLOG_MAX_BYTES) return this.stop('slow')
    live.socket.write(bytes)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.stop('tab-closed')
    for (const sock of this.waiting) sock.destroy()
    this.waiting.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    if (this.dir) await rm(this.dir, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Every lent-microphone listener, by pty. Index's `startSession` asks for a
 * lease before the spawn (`prepare`), attaches it once the pty exists, and the
 * pty's exit releases it; the renderer's key and pane reports and frames come
 * in through `registerMicTunnelIpc`.
 */
export class MicTunnels {
  private readonly deps: MicTunnelDeps
  private readonly byPty = new Map<string, Tunnel>()
  private readonly byStream = new Map<string, Tunnel>()
  private readonly unbound = new Set<Tunnel>()

  constructor(deps: MicTunnelDeps) {
    this.deps = deps
  }

  /** A fresh listener and token for one connection to `hostId`. Throws if it cannot listen. */
  async prepare(hostId: string): Promise<MicLease> {
    const token = randomBytes(16).toString('hex')
    const server = createServer({ allowHalfOpen: false })
    const platform = this.deps.platform ?? process.platform
    let dir: string | null = null
    let local: string
    try {
      if (platform === 'win32') {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(0, '127.0.0.1', () => resolve())
        })
        const addr = server.address()
        if (!addr || typeof addr === 'string') throw new Error('no port')
        local = `127.0.0.1:${addr.port}`
      } else {
        // A folder of its own, 0700 (mkdtemp), so only this user can reach the
        // socket; `/tmp` when the temp folder's path is too long for sun_path
        // or not one word ssh can carry.
        const roots = [this.deps.tmpRoot ?? tmpdir(), '/tmp']
        for (const root of roots) {
          const made = await mkdtemp(join(root, 'stoke-mic-'))
          const path = join(made, 'm.sock')
          if (isMicLocalEndpoint(path)) {
            dir = made
            break
          }
          await rm(made, { recursive: true, force: true })
        }
        if (!dir) throw new Error('no folder short enough for a socket')
        local = join(dir, 'm.sock')
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject)
          server.listen(local, () => resolve())
        })
        await chmod(local, 0o600)
      }
    } catch (err) {
      server.close()
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    const forward = micForwardOption(token, local)
    if (!forward) {
      server.close()
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
      throw new Error('the forward could not be built')
    }
    const tunnel = new Tunnel({ token, hostId, server, dir, local }, this.deps, (t, live) => {
      for (const [id, owner] of this.byStream) if (owner === t) this.byStream.delete(id)
      if (live) this.byStream.set(live.id, t)
    })
    this.unbound.add(tunnel)
    let settled = false
    return {
      forward,
      attach: (ptyId: string) => {
        if (settled) return
        settled = true
        this.unbound.delete(tunnel)
        const old = this.byPty.get(ptyId)
        if (old) void old.close()
        tunnel.ptyId = ptyId
        this.byPty.set(ptyId, tunnel)
      },
      release: () => {
        if (settled) return
        settled = true
        this.unbound.delete(tunnel)
        void tunnel.close()
      }
    }
  }

  /** Whether this pty lends the microphone (a listener is up for it). */
  lends(ptyId: string): boolean {
    return this.byPty.has(ptyId)
  }

  /** The stream running for this pty, if any. */
  streaming(ptyId: string): { streamId: string; mode: MicMode } | null {
    const live = this.byPty.get(ptyId)?.live
    return live ? { streamId: live.id, mode: live.mode } : null
  }

  key(owner: number, ptyId: string, kind: MicKey): void {
    this.byPty.get(ptyId)?.key(owner, kind)
  }

  pane(owner: number, ptyId: string, pane: MicPane): void {
    this.byPty.get(ptyId)?.pane(owner, pane)
  }

  frame(owner: number, streamId: string, data: unknown): void {
    this.byStream.get(streamId)?.frame(owner, streamId, data)
  }

  /** The person pressed Stop, or the renderer could not open the microphone. */
  stop(owner: number, streamId: string, reason: 'stop' | 'failed'): void {
    const t = this.byStream.get(streamId)
    if (t && t.owner === owner && t.live?.id === streamId) t.stop(reason)
  }

  /** The tab's pty exited or was killed. */
  async release(ptyId: string): Promise<void> {
    const t = this.byPty.get(ptyId)
    if (!t) return
    this.byPty.delete(ptyId)
    await t.close()
  }

  async closeAll(): Promise<void> {
    const all = [...this.byPty.values(), ...this.unbound]
    this.byPty.clear()
    this.unbound.clear()
    await Promise.all(all.map((t) => t.close()))
  }
}

/* ---------------------------------------------------------------- the IPC */

const KEYS = new Set<MicKey>(['space-down', 'space-repeat', 'space-up', 'other'])

export interface MicIpcChannels {
  key: string
  pane: string
  frame: string
  stop: string
}

/**
 * Wire the renderer's reports in. Every argument is checked here: the
 * renderer names a pty and a stream, and anything else it sends is dropped.
 * `ipc` is electron's `ipcMain`, passed in so this module never imports it.
 */
export function registerMicTunnelIpc(
  ipc: { on(channel: string, listener: (e: { sender: { id: number } }, ...args: unknown[]) => void): unknown },
  tunnels: MicTunnels,
  ch: MicIpcChannels
): void {
  ipc.on(ch.key, (e, ptyId, kind) => {
    if (typeof ptyId === 'string' && KEYS.has(kind as MicKey)) tunnels.key(e.sender.id, ptyId, kind as MicKey)
  })
  ipc.on(ch.pane, (e, ptyId, pane) => {
    if (typeof ptyId !== 'string' || !pane || typeof pane !== 'object') return
    const p = pane as Record<string, unknown>
    tunnels.pane(e.sender.id, ptyId, { front: p.front === true, focused: p.focused === true, dictating: p.dictating === true })
  })
  ipc.on(ch.frame, (e, streamId, data) => {
    if (typeof streamId === 'string') tunnels.frame(e.sender.id, streamId, data)
  })
  ipc.on(ch.stop, (e, streamId, reason) => {
    if (typeof streamId === 'string') tunnels.stop(e.sender.id, streamId, reason === 'failed' ? 'failed' : 'stop')
  })
}

/* ------------------------------------------------------------ setting up */

/** The far body that installs the stand-in, from the one copy of its text. */
export function micSetupCommandBody(): string {
  const body = micSetupBody(Buffer.from(MIC_STAND_IN, 'utf8').toString('base64'))
  if (!body) throw new Error('The stand-in could not be encoded.')
  return body
}

/** The "Set up microphone" tab's program: ssh asking for the password there (gotcha 109). */
export function micSetupTabCommand(host: SshHost): { file: string; args: string[] } | null {
  const args = buildMicSetupArgs(host, micSetupCommandBody(), 'tab')
  return args ? { file: sshExecutable(), args } : null
}


/**
 * Install the stand-in over a one-shot BatchMode ssh (a host whose key login
 * works). A host that wants a password answers "Permission denied" and the
 * caller opens the "Set up microphone" tab instead. `sshChildEnv` (gotcha
 * 153): no pty, so Win32-OpenSSH's inherited stdio description must not reach
 * ssh.exe.
 */
export async function installMicStandIn(
  host: SshHost,
  run: (file: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean }> = defaultRun
): Promise<MicInstallResult> {
  const built = buildMicSetupArgs(host, micSetupCommandBody(), 'batch')
  if (!built) return { ok: false, needsLogin: false, message: 'Stoke will not hand this alias to ssh. Set it up by hand.' }
  let args = built
  try {
    args = await prepareSshRoute(built, sshExecutable(), sshChildEnv())
  } catch {
    args = built
  }
  const r = await run(sshExecutable(), args)
  if (r.killed) return { ok: false, needsLogin: false, message: 'The machine did not answer in time.' }
  if (r.code === 0) return { ok: true, report: parseMicSetup(r.stdout) }
  const said = `${r.stdout}\n${r.stderr}`
  if (/Permission denied \(/.test(said)) return { ok: false, needsLogin: true, message: 'That machine wants a password.' }
  const stoke = said.split(/\r?\n/).filter((l) => l.startsWith('Stoke: ')).pop()
  const last = r.stderr.trim().split(/\r?\n/).pop()
  return { ok: false, needsLogin: false, message: stoke ?? (last || `ssh exited ${r.code ?? 'with no code'}.`) }
}

function defaultRun(file: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string; killed: boolean }> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', windowsHide: true, env: sshChildEnv() },
      (err, stdout, stderr) => {
        // gotcha 25: a timeout is `killed` with no numeric code; test it first.
        const e = err as (Error & { killed?: boolean; code?: unknown }) | null
        if (e?.killed) return resolve({ code: null, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), killed: true })
        const code = !e ? 0 : typeof e.code === 'number' ? e.code : null
        resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? (e?.message ?? '')), killed: false })
      }
    )
  })
}
