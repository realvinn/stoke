import { spawn, type ChildProcess } from 'node:child_process'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { buildEnvPath } from '../cli.ts'

/**
 * Runs a Cloudflare Tunnel so the loopback remote server is reachable at a real
 * hostname.
 *
 * Stoke deliberately does not attempt `cloudflared tunnel login` or DNS routing:
 * those are one-time interactive steps that need a browser and account
 * consent. What it does is detect the binary, hand over the exact commands, and
 * then supervise `cloudflared tunnel run` afterwards.
 */

export type TunnelMode = 'named' | 'quick'

export interface TunnelStatus {
  installed: boolean
  path: string | null
  running: boolean
  mode: TunnelMode | null
  /** Hostname for a named tunnel, or the trycloudflare URL for a quick one. */
  url: string | null
  log: string[]
  error: string | null
}

const LOG_LIMIT = 60

/** Where an installer puts cloudflared when it is not on PATH at all. */
function candidates(): string[] {
  const home = homedir()
  if (process.platform === 'win32') {
    return [
      'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
      'C:\\Program Files\\cloudflared\\cloudflared.exe',
      join(home, '.cloudflared', 'cloudflared.exe')
    ]
  }
  return [
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared',
    '/usr/bin/cloudflared',
    '/snap/bin/cloudflared',
    join(home, '.cloudflared', 'cloudflared')
  ]
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

/**
 * Where cloudflared is, or null.
 *
 * Asks the login-shell PATH first — the same probe `findClaude` uses, so a
 * `brew`, `mise`, `winget` or `~/.local/bin` install is found wherever the
 * shell would find it — and only then the handful of fixed paths installers
 * use. The old version checked four fixed paths with `existsSync`, then
 * returned null under a comment promising a PATH fallback it never performed;
 * `installed: false` then hid every tunnel button for anyone whose cloudflared
 * lived anywhere else, while `spawn('cloudflared')` would have worked.
 *
 * Async, because the PATH probe is (gotcha 52), and because `status()` used to
 * run four sync stats every four seconds while the panel was open.
 */
export async function findCloudflared(): Promise<string | null> {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared'
  for (const dir of (await buildEnvPath()).split(delimiter)) {
    if (dir && (await exists(join(dir, name)))) return join(dir, name)
  }
  for (const p of candidates()) if (await exists(p)) return p
  return null
}

/** The install hint for this platform, quoted when a spawn fails with ENOENT. */
export function installHint(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? 'brew install cloudflared'
    : platform === 'win32'
      ? 'winget install Cloudflare.cloudflared'
      : 'see developers.cloudflare.com/cloudflare-one/connections/connect-apps/install-and-setup/installation'
}

/**
 * The error a tunnel exit should report, with the reason in it.
 *
 * cloudflared says why it stopped on its last lines — "tunnel stoke not
 * found", "Cannot determine default origin certificate path", "login
 * required" — and the panel used to show only `exited with code 1` with that
 * line folded away behind a collapsed log. Gotcha 46's rule: quote the tool.
 * Pure and exported so the suite can hand it a log.
 */
export function exitError(code: number, log: string[]): string {
  const said = log.filter((l) => /ERR|error|fail|not found|required/i.test(l)).at(-1) ?? log.at(-1)
  const reason = said ? said.replace(/^\S+T\S+\s+(ERR|INF|WRN)\s+/, '').trim() : ''
  return reason ? `cloudflared exited with code ${code}: ${reason}` : `cloudflared exited with code ${code}`
}

export class TunnelManager {
  private proc: ChildProcess | null = null
  private mode: TunnelMode | null = null
  private url: string | null = null
  private log: string[] = []
  private error: string | null = null
  /**
   * Where cloudflared was last found. `undefined` means never looked; `null`
   * means looked and absent. Resolved once by `locate()` rather than on every
   * status read, and re-resolved on demand from the panel's "look again".
   */
  private resolved: string | null | undefined = undefined
  private locating: Promise<string | null> | null = null

  /** Find the binary, once. Safe to call from every status read. */
  locate(force = false): Promise<string | null> {
    if (!force && this.resolved !== undefined) return Promise.resolve(this.resolved)
    if (this.locating) return this.locating
    this.locating = findCloudflared()
      .then((p) => {
        this.resolved = p
        return p
      })
      .finally(() => {
        this.locating = null
      })
    return this.locating
  }

  status(): TunnelStatus {
    // Kick the lookup off if nothing has yet; the next read has the answer.
    if (this.resolved === undefined) void this.locate()
    return {
      installed: this.resolved !== null && this.resolved !== undefined,
      path: this.resolved ?? null,
      running: this.proc !== null && !this.proc.killed,
      mode: this.mode,
      url: this.url,
      log: this.log,
      error: this.error
    }
  }

  /**
   * `named` runs a tunnel you created and DNS-routed yourself, so it serves your
   * own hostname and can sit behind Access. `quick` asks Cloudflare for a
   * throwaway trycloudflare.com address — handy for a one-off test, but it has
   * no Access policy in front of it, so the bearer token is the only thing
   * protecting the session.
   *
   * Spawns even when the binary was not found, with the bare name: PATH
   * resolution by the OS is a real fallback here, and an ENOENT is turned into
   * an install hint rather than a hidden button.
   */
  start(mode: TunnelMode, opts: { port: number; tunnelName: string; hostname: string }): TunnelStatus {
    this.stop()
    this.error = null
    this.log = []
    this.url = null

    const exe = this.resolved ?? 'cloudflared'
    const args =
      mode === 'named'
        ? ['tunnel', '--no-autoupdate', 'run', '--url', `http://127.0.0.1:${opts.port}`, opts.tunnelName]
        : ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${opts.port}`]

    try {
      const proc = spawn(exe, args, { windowsHide: true })
      this.proc = proc
      this.mode = mode
      if (mode === 'named' && opts.hostname) this.url = `https://${opts.hostname}`

      const absorb = (buf: Buffer): void => {
        for (const line of buf.toString('utf8').split('\n')) {
          const trimmed = line.trim()
          if (!trimmed) continue
          this.log.push(trimmed)
          if (this.log.length > LOG_LIMIT) this.log.shift()
          // Quick tunnels announce their generated hostname in the output.
          const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(trimmed)
          if (match && mode === 'quick') this.url = match[0]
        }
      }

      proc.stdout?.on('data', absorb)
      proc.stderr?.on('data', absorb)
      proc.on('error', (err: NodeJS.ErrnoException) => {
        this.error =
          err.code === 'ENOENT'
            ? `cloudflared is not installed, or not on PATH. ${installHint()}`
            : err.message
        this.proc = null
        this.mode = null
      })
      proc.on('exit', (code) => {
        if (code !== 0 && code !== null) this.error = exitError(code, this.log)
        this.proc = null
        this.mode = null
      })
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
    }

    return this.status()
  }

  stop(): void {
    if (this.proc && !this.proc.killed) {
      try {
        this.proc.kill()
      } catch {
        /* already gone */
      }
    }
    this.proc = null
    this.mode = null
  }

  /** One-time commands the user runs themselves; they need a browser login. */
  setupCommands(tunnelName: string, hostname: string, port: number): string[] {
    return [
      'cloudflared tunnel login',
      `cloudflared tunnel create ${tunnelName}`,
      `cloudflared tunnel route dns ${tunnelName} ${hostname || 'code.example.com'}`,
      `# then Stoke runs: cloudflared tunnel run --url http://127.0.0.1:${port} ${tunnelName}`
    ]
  }
}
