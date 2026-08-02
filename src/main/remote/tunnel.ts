import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

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
    join(home, '.cloudflared', 'cloudflared')
  ]
}

export function findCloudflared(): string | null {
  for (const p of candidates()) {
    if (existsSync(p)) return p
  }
  // Fall back to PATH resolution by the OS.
  return null
}

export class TunnelManager {
  private proc: ChildProcess | null = null
  private mode: TunnelMode | null = null
  private url: string | null = null
  private log: string[] = []
  private error: string | null = null

  status(): TunnelStatus {
    const path = findCloudflared()
    return {
      installed: path !== null,
      path,
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
   */
  start(mode: TunnelMode, opts: { port: number; tunnelName: string; hostname: string }): TunnelStatus {
    this.stop()
    this.error = null
    this.log = []
    this.url = null

    const exe = findCloudflared() ?? 'cloudflared'
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
      proc.on('error', (err) => {
        this.error = err.message
        this.proc = null
      })
      proc.on('exit', (code) => {
        if (code !== 0 && code !== null) this.error = `cloudflared exited with code ${code}`
        this.proc = null
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
