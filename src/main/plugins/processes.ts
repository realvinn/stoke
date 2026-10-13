import { StringDecoder } from 'node:string_decoder'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export interface PluginProcessSpec {
  executable: string
  args: string[]
  cwd: string
  env: Record<string, string>
  input: string
}
function stopChild(child: ChildProcessWithoutNullStreams | null): void {
  if (!child?.pid) return
  if (process.platform === 'win32') {
    if (child.exitCode !== null || child.signalCode !== null) return
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      shell: false
    })
    killer.on('error', () => {
      child.kill()
    })
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      child.kill('SIGKILL')
    }
  }
}
export class PluginBusyError extends Error {
  constructor() { super('This plugin already has four operations running.') }
}
/** Each plugin owns its jobs; disabling it revokes both pending work and live children. */
export class PluginProcesses {
  private jobs = new Map<
    string,
    { controller: AbortController; child: ChildProcessWithoutNullStreams | null }
  >()
  private stopped = false
  private epoch = 0
  resume(): void {
    this.stopped = false
  }
  stop(): void {
    this.stopped = true
    this.epoch++
    for (const job of this.jobs.values()) {
      job.controller.abort()
      stopChild(job.child)
    }
  }
  async run(
    prepare: (signal: AbortSignal) => Promise<PluginProcessSpec>
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    if (this.stopped) throw new Error('Enable this plugin first.')
    if (this.jobs.size >= 4) throw new PluginBusyError()
    const id = randomUUID(),
      epoch = this.epoch
    const job = { controller: new AbortController(), child: null as ChildProcessWithoutNullStreams | null }
    this.jobs.set(id, job)
    const signal = job.controller.signal
    const timer = setTimeout(() => {
      job.controller.abort()
      stopChild(job.child)
    }, 60_000)
    try {
      const spec = await Promise.race([
        prepare(signal),
        new Promise<never>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(new Error('The plugin operation stopped.')), {
            once: true
          })
        )
      ])
      signal.throwIfAborted()
      if (this.stopped || epoch !== this.epoch)
        throw new Error('The plugin was disabled before this operation started.')
      return await new Promise((resolve, reject) => {
        const child = spawn(spec.executable, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          windowsHide: true,
          stdio: 'pipe',
          shell: false,
          detached: process.platform !== 'win32'
        })
        job.child = child
        const stdoutDecoder = new StringDecoder('utf8'),
          stderrDecoder = new StringDecoder('utf8')
        let stdout = '',
          stderr = '',
          bytes = 0,
          settled = false
        const finish = (error?: Error, code = 1): void => {
          if (settled) return
          settled = true
          signal.removeEventListener('abort', abort)
          if (error) reject(error)
          else resolve({ code, stdout, stderr })
        }
        const abort = (): void => {
          stopChild(child)
          finish(
            new Error(
              'The operation stopped. If a message was being sent, check its thread before sending again.'
            )
          )
        }
        signal.addEventListener('abort', abort, { once: true })
        const collect = (chunk: Buffer, error: boolean): void => {
          bytes += chunk.length
          if (bytes > 2 * 1024 * 1024) {
            stopChild(child)
            finish(new Error('The plugin returned too much output.'))
            return
          }
          if (error) stderr += stderrDecoder.write(chunk)
          else stdout += stdoutDecoder.write(chunk)
        }
        child.stdout.on('data', (chunk) => collect(chunk, false))
        child.stderr.on('data', (chunk) => collect(chunk, true))
        child.on('error', () =>
          finish(new Error('The plugin process could not start. Check its installation.'))
        )
        child.on('close', (code) => {
          stdout += stdoutDecoder.end()
          stderr += stderrDecoder.end()
          stopChild(child)
          finish(undefined, code ?? 1)
        })
        child.stdin.on('error', () => {})
        child.stdin.end(spec.input)
        if (signal.aborted) abort()
      })
    } finally {
      clearTimeout(timer)
      if (this.jobs.get(id) === job) this.jobs.delete(id)
    }
  }
}

/** Do not inherit another agent's login, API keys or Node startup injection. */
export function pluginEnvironment(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of [
    'PATH',
    'Path',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'SystemRoot',
    'SYSTEMROOT',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'LANG',
    'LC_ALL',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS',
    'DISPLAY',
    'WAYLAND_DISPLAY',
    'XAUTHORITY',
    'XDG_CONFIG_HOME',
    'XDG_DATA_HOME',
    'XDG_CACHE_HOME'
  ])
    if (source[name] && !Object.keys(env).some((key) => key.toLowerCase() === name.toLowerCase()))
      env[name] = source[name]!
  env.ELECTRON_RUN_AS_NODE = '1'
  return env
}
