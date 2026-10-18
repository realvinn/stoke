import { execFile } from 'node:child_process'
import type { IPty, IPtyForkOptions, IWindowsPtyForkOptions } from '@lydell/node-pty'
import { conptyScrub, newSshLoginWatch, sshLoginOutput, SSH_AUTH_SCAN_LIMIT } from '../shared/sshAuth.ts'
import { isTerminalReport } from '../shared/remotePhone.ts'

/**
 * OpenSSH normally falls through from a rejected key to an interactive login.
 * A server's MaxAuthTries can end the connection before it gets that far when
 * ssh-agent offers several keys. Retry that case once, in the same visible
 * terminal, without the keys. Never retry an authenticated command.
 *
 * VERBOSE makes OpenSSH emit its own authentication-success marker before it
 * can run a remote command. A plain prompt/error regex alone cannot establish
 * that boundary: an unstyled shell can print any error and exit 255.
 */
export class SshFallbackScan {
  private blocked = false
  private seen = 0
  private text = ''
  private pending = ''
  private conpty: boolean
  private login = newSshLoginWatch()

  constructor(conpty = process.platform === 'win32') { this.conpty = conpty }

  output(data: string): void {
    if (this.blocked) return
    this.seen += data.length
    if (this.seen > SSH_AUTH_SCAN_LIMIT) { this.blocked = true; return }
    this.login = sshLoginOutput(this.login, data, { conpty: this.conpty })
    if (this.login.settled || this.login.prompted) { this.blocked = true; return }
    if (this.conpty) {
      const scrubbed = conptyScrub(this.pending + data, { cursorBreaks: true })
      this.pending = scrubbed.rest
      if (scrubbed.painting) { this.blocked = true; return }
      data = scrubbed.text.replace(/[\f\v]/g, '\n')
    } else if (data.includes('\u001b')) { this.blocked = true; return }
    this.text += data
    // Partial success is deliberately excluded too: do not change an MFA flow.
    if (/Authenticated (?:to |using |with partial success)|Authentication succeeded|mux_client_request_session/.test(this.text)) {
      this.blocked = true
    }
  }

  input(data: string | Buffer): void {
    // A retry must never resubmit a password, passphrase, OTP or typed command.
    // Keep only a boolean; bytes are neither retained nor replayed.
    if (data.length && (typeof data !== 'string' || !isTerminalReport(data))) this.blocked = true
  }

  retry(exitCode: number, signal?: number): boolean {
    return !this.blocked && !signal && exitCode === 255 &&
      /(?:^|[\r\n])Received disconnect from [^\r\n]+: ?2: Too many authentication failures(?:\.[^\r\n]*)?(?:[\r\n]|$)/.test(this.text)
  }
}

/** Effective ssh -G options, never a second parser of the user's config. */
export function passwordFallbackArgs(config: string, args: readonly string[]): string[] | null {
  const values = new Map<string, string>()
  for (const line of config.split(/\r?\n/)) {
    const at = line.indexOf(' ')
    if (at > 0 && !values.has(line.slice(0, at))) values.set(line.slice(0, at), line.slice(at + 1).trim())
  }
  // Fail closed on an incomplete/older config dump, batch jobs, jump hosts,
  // arbitrary proxies and multiplexing (whose login happened in another ssh).
  if (values.get('batchmode') !== 'no' || !['yes', 'true', 'unbound', 'host-bound'].includes(values.get('pubkeyauthentication') ?? '') ||
      !['none', undefined].includes(values.get('proxyjump')) ||
      !['none', undefined].includes(values.get('proxycommand')) ||
      !['none', undefined].includes(values.get('controlpath'))) return null
  // ssh -G omits PreferredAuthentications when it is unset. OpenSSH's default
  // tries publickey before keyboard-interactive/password (ssh_config(5)).
  const methods = (values.get('preferredauthentications') ?? 'publickey,keyboard-interactive,password').split(',')
  if (!methods.includes('publickey')) return null
  const allowed = methods.filter(method =>
    (method === 'keyboard-interactive' && values.get('kbdinteractiveauthentication') === 'yes') ||
    (method === 'password' && values.get('passwordauthentication') === 'yes'))
  const prompts = Number(values.get('numberofpasswordprompts') ?? '0')
  if (!allowed.length || !Number.isInteger(prompts) || prompts < 1) return null
  return ['-o', 'PubkeyAuthentication=no', '-o', `PreferredAuthentications=${allowed.join(',')}`, ...args]
}

export function resolvePasswordFallback(
  executable: string, args: readonly string[], env: Record<string, string | undefined>, signal: AbortSignal
): Promise<string[] | null> {
  return new Promise(resolve => {
    execFile(executable, ['-G', ...args], {
      encoding: 'utf8', timeout: 4000, maxBuffer: 256 * 1024, windowsHide: true, env, signal
    }, (error, stdout) => resolve(error ? null : passwordFallbackArgs(stdout, args)))
  })
}

type Exit = { exitCode: number; signal?: number }
type Options = IPtyForkOptions & IWindowsPtyForkOptions
export interface SshPtyDeps {
  spawn: (file: string, args: string[], options: Options) => IPty
  fallback?: (file: string, args: readonly string[], env: Record<string, string | undefined>, signal: AbortSignal) => Promise<string[] | null>
  /** Track and release the exact native children, including the replacement. */
  started: (child: IPty) => void
  exited: (child: IPty) => void
  conpty?: boolean
}

/** One logical PTY; no input is buffered across the two native connections. */
export function spawnSshPty(file: string, args: string[], options: Options, deps: SshPtyDeps): IPty {
  const initial = ['-o', 'LogLevel=VERBOSE', ...args]
  const dataListeners = new Set<(data: string) => void>()
  const exitListeners = new Set<(event: Exit) => void>()
  const controller = new AbortController()
  const scan = new SshFallbackScan(deps.conpty)
  let child: IPty
  let live = false, stopped = false, done = false, retried = false
  let cols = options.cols ?? 80, rows = options.rows ?? 24
  let flow = options.handleFlowControl ?? false
  const emitData = (data: string): void => { for (const listener of dataListeners) listener(data) }
  const finish = (event: Exit): void => {
    if (done) return
    done = true
    for (const listener of exitListeners) listener(event)
  }
  const launch = (nextArgs: string[]): void => {
    child = deps.spawn(file, nextArgs, { ...options, cols, rows, handleFlowControl: flow })
    const mine = child
    live = true
    deps.started(mine)
    mine.onData(data => {
      if (child !== mine || done) return
      if (!retried) scan.output(data)
      emitData(data)
    })
    mine.onExit(event => {
      deps.exited(mine)
      if (child !== mine || done) return
      live = false
      if (stopped || retried || !scan.retry(event.exitCode, event.signal)) { finish(event); return }
      retried = true // claim before the asynchronous config read
      void (deps.fallback ?? resolvePasswordFallback)(file, initial, options.env ?? {}, controller.signal).then(next => {
        if (stopped || controller.signal.aborted || !next) { finish(event); return }
        emitData('\r\nStoke: too many SSH keys were rejected. Trying another sign-in method; answer the SSH prompt below.\r\n')
        // A listener may close the tab while handling that visible notice.
        if (stopped) { finish(event); return }
        try { launch(next) } catch {
          emitData('\r\nStoke could not start password authentication.\r\n')
          finish(event)
        }
      }, () => finish(event))
    })
  }
  launch(initial)
  return {
    get pid() { return live ? child.pid : 0 },
    get cols() { return cols },
    get rows() { return rows },
    get process() { return child.process },
    get handleFlowControl() { return flow },
    set handleFlowControl(value) { flow = value; if (live) child.handleFlowControl = value },
    onData(listener) { dataListeners.add(listener); return { dispose: () => { dataListeners.delete(listener) } } },
    onExit(listener) { exitListeners.add(listener); return { dispose: () => { exitListeners.delete(listener) } } },
    write(data) { if (!live || stopped || done) return; scan.input(data); child.write(data) },
    resize(columns, lines, pixels) { cols = columns; rows = lines; if (live) child.resize(columns, lines, pixels) },
    clear() { if (live) child.clear() },
    kill(signal) { stopped = true; controller.abort(); if (live) child.kill(signal) },
    pause() { if (live) child.pause() },
    resume() { if (live) child.resume() }
  }
}
