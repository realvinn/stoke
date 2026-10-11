/** Grok Bot desktop descriptor support, adapted from ScriptedAlchemy/grok-bot-cli
 * 43499fa27f36807f6ac93b56365b3cae5200bc1e (MIT; build/licenses/grok-bot-cli.txt).
 * Only an explicit Import action opens a session. No app auth file is changed.
 */
import { createDecipheriv, pbkdf2 } from 'node:crypto'
import { execFile } from 'node:child_process'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { grokBotGateway, type GrokBotSource } from '../../shared/grokBot.ts'
import { pluginEnvironment } from './processes.ts'

export interface GrokBotSession {
  gatewayUrl: string
  token: string
  headers: Record<string, string>
  allowLocal: boolean
}
const record = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw)

export function validateGrokBotSession(raw: unknown, allowLocal = false): GrokBotSession {
  if (
    !record(raw) ||
    typeof raw.token !== 'string' ||
    !raw.token.trim() ||
    raw.token.length > 16_384 ||
    /[\u0000-\u0020\u007f]/.test(raw.token.trim())
  )
    throw new Error('The session has no usable Grok Bot gateway token.')
  const gatewayUrl = grokBotGateway(raw.gatewayUrl, allowLocal)
  const headers: Record<string, string> = {}
  if (raw.headers !== undefined && !record(raw.headers)) throw new Error('Session headers must be an object.')
  const entries = Object.entries(record(raw.headers) ? raw.headers : {})
  if (entries.length > 24) throw new Error('The session has too many routing headers.')
  for (const [name, value] of entries) {
    if (
      !/^[a-zA-Z0-9-]{1,80}$/.test(name) ||
      ['authorization', 'cookie', 'host', 'content-length', 'content-type', 'connection'].includes(
        name.toLowerCase()
      ) ||
      typeof value !== 'string' ||
      value.length > 8192 ||
      /[\u0000-\u001f\u007f]/.test(value)
    )
      throw new Error('The session has an unsupported routing header.')
    headers[name.toLowerCase()] = value
  }
  return { gatewayUrl, token: raw.token.trim(), headers, allowLocal }
}

async function boundedJson(path: string, signal: AbortSignal): Promise<unknown> {
  let file: Awaited<ReturnType<typeof open>> | null = null
  try {
    file = await open(path, 'r')
    signal.throwIfAborted()
    const info = await file.stat()
    signal.throwIfAborted()
    if (!info.isFile() || info.size > 4 * 1024 * 1024)
      throw new Error('The Grok Bot desktop session file is too large.')
    return JSON.parse(await file.readFile({ encoding: 'utf8', signal }))
  } catch {
    throw new Error(
      'The Grok Bot desktop session could not be read. Open Grok Bot and sign in, then import again.'
    )
  } finally {
    await file?.close()
  }
}

function slots(raw: unknown): { id: string; encrypted: string; label: string }[] {
  if (!record(raw) || ![undefined, 1, 2].includes(raw.version as number | undefined))
    throw new Error('This desktop session format is not supported by the plugin yet.')
  const entries = raw.version === 2 && record(raw.entries) ? Object.entries(raw.entries) : [['current', raw]]
  if (!entries.length || entries.length > 32)
    throw new Error('Choose a desktop profile with saved Grok Bot sessions.')
  return entries.map(([id, entry], index) => {
    if (
      typeof id !== 'string' ||
      id.length > 160 ||
      !record(entry) ||
      typeof entry.encrypted !== 'string' ||
      !/^[a-z0-9+/]+={0,2}$/i.test(entry.encrypted) ||
      entry.encrypted.length > 128 * 1024
    )
      throw new Error('The desktop session descriptor has an unsupported entry.')
    const supplied =
      typeof entry.label === 'string' ? entry.label : typeof entry.email === 'string' ? entry.email : ''
    return {
      id,
      encrypted: entry.encrypted,
      label:
        supplied && supplied.length <= 160 && !/[\u0000-\u001f]/.test(supplied)
          ? supplied
          : entries.length === 1
            ? 'Current desktop login'
            : `Saved desktop session ${index + 1}`
    }
  })
}

export interface GrokBotSessionReaderOptions {
  home: string
  platform: string
  environment: NodeJS.ProcessEnv
  /** Injected only by owned tests; production uses native OS protection. */
  password?: (signal: AbortSignal) => Promise<string>
  unprotect?: (blob: Buffer, signal: AbortSignal) => Promise<Buffer>
}
export class GrokBotSessionReader {
  private options: GrokBotSessionReaderOptions
  constructor(options: GrokBotSessionReaderOptions) {
    this.options = options
  }
  private root(): string {
    const { platform, home, environment: env } = this.options
    return platform === 'win32'
      ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Grok Bot')
      : platform === 'linux'
        ? join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Grok Bot')
        : join(home, 'Library', 'Application Support', 'Grok Bot')
  }
  async sources(signal: AbortSignal): Promise<GrokBotSource[]> {
    return slots(await boundedJson(join(this.root(), 'gateway-descriptor.json'), signal)).map(
      ({ id, label }) => ({ id, label })
    )
  }
  private execute(executable: string, args: string[], input: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        args,
        {
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 256 * 1024,
          windowsHide: true,
          env: pluginEnvironment(this.options.environment),
          signal
        },
        (error, stdout) => {
          if (error)
            reject(
              new Error(
                'The system could not open the Grok Bot session. Check the OS key store and try importing again.'
              )
            )
          else resolve(stdout.trimEnd())
        }
      )
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    })
  }
  private password(signal: AbortSignal): Promise<string> {
    if (this.options.password) return this.options.password(signal)
    return this.options.platform === 'linux'
      ? this.execute(
          'secret-tool',
          ['lookup', 'xdg:schema', 'chrome_libsecret_os_crypt_password_v2', 'application', 'Grok Bot'],
          '',
          signal
        )
      : this.execute(
          '/usr/bin/security',
          ['find-generic-password', '-w', '-s', 'Grok Bot Safe Storage'],
          '',
          signal
        )
  }
  async load(
    sourceSlot: string | undefined,
    signal: AbortSignal
  ): Promise<{ session: GrokBotSession; slot: string }> {
    const entries = slots(await boundedJson(join(this.root(), 'gateway-descriptor.json'), signal))
    const selected = sourceSlot
      ? entries.find((entry) => entry.id === sourceSlot)
      : entries.length === 1
        ? entries[0]
        : undefined
    if (!selected) throw new Error('Choose which saved desktop session to import.')
    const encrypted = Buffer.from(selected.encrypted, 'base64')
    let clear: string
    try {
      if (this.options.platform === 'win32') {
        const state = await boundedJson(join(this.root(), 'Local State'), signal)
        const os = record(state) && record(state.os_crypt) ? state.os_crypt : null
        const wrapped = Buffer.from(typeof os?.encrypted_key === 'string' ? os.encrypted_key : '', 'base64')
        if (
          wrapped.subarray(0, 5).toString() !== 'DPAPI' ||
          encrypted.subarray(0, 3).toString() !== 'v10' ||
          encrypted.length < 32
        )
          throw new Error('Unsupported desktop encryption.')
        const blob = wrapped.subarray(5)
        const key = this.options.unprotect
          ? await this.options.unprotect(blob, signal)
          : Buffer.from(
              await this.execute(
                join(
                  this.options.environment.SystemRoot || this.options.environment.SYSTEMROOT || 'C:\\Windows',
                  'System32',
                  'WindowsPowerShell',
                  'v1.0',
                  'powershell.exe'
                ),
                [
                  '-NoProfile',
                  '-NonInteractive',
                  '-Command',
                  "Add-Type -AssemblyName System.Security; $blob=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($blob,$null,'CurrentUser'))"
                ],
                blob.toString('base64'),
                signal
              ),
              'base64'
            )
        signal.throwIfAborted()
        if (key.length !== 32) throw new Error('Unsupported desktop key.')
        const decipher = createDecipheriv('aes-256-gcm', key, encrypted.subarray(3, 15))
        decipher.setAuthTag(encrypted.subarray(-16))
        clear = Buffer.concat([decipher.update(encrypted.subarray(15, -16)), decipher.final()]).toString(
          'utf8'
        )
      } else {
        const prefix = encrypted.subarray(0, 3).toString()
        if (prefix !== 'v10' && !(this.options.platform === 'linux' && prefix === 'v11'))
          throw new Error('Unsupported desktop encryption.')
        const password =
          this.options.platform === 'linux' && prefix === 'v10' ? 'peanuts' : await this.password(signal)
        const key = await promisify(pbkdf2)(
          password,
          'saltysalt',
          this.options.platform === 'linux' ? 1 : 1003,
          16,
          'sha1'
        )
        signal.throwIfAborted()
        const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
        clear = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]).toString('utf8')
      }
    } catch {
      throw new Error(
        'The desktop session could not be decrypted. Sign in to Grok Bot on this computer, then import again.'
      )
    }
    signal.throwIfAborted()
    let descriptor: unknown
    try {
      descriptor = JSON.parse(clear)
    } catch {
      throw new Error('The desktop session descriptor is unreadable.')
    }
    if (!record(descriptor)) throw new Error('The desktop session descriptor is unreadable.')
    return {
      slot: selected.id,
      session: validateGrokBotSession({
        gatewayUrl: descriptor.baseUrl,
        token: descriptor.token,
        headers: descriptor.headers
      })
    }
  }
}
