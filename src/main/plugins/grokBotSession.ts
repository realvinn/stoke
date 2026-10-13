/** Grok Bot desktop descriptor support, adapted from ScriptedAlchemy/grok-bot-cli
 * 43499fa27f36807f6ac93b56365b3cae5200bc1e (MIT; build/licenses/grok-bot-cli.txt).
 * Only an explicit Import action opens a session. No app auth file is changed.
 */
import { createDecipheriv, pbkdf2, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, join } from 'node:path'
import { promisify } from 'node:util'
import { grokBotGateway, type GrokBotSource, type GrokBotDesktopProfile } from '../../shared/grokBot.ts'
import { pluginEnvironment } from './processes.ts'
import { PluginFile } from './files.ts'

export interface GrokBotSession {
  gatewayUrl: string
  token: string
  headers: Record<string, string>
  allowLocal: boolean
}
const record = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw)
// Grok Bot desktop 0.70.2 stores v3 connection snapshots for seven days.
const DESKTOP_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

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

class DesktopFileError extends Error {
  reason: 'missing' | 'unreadable'
  constructor(reason: 'missing' | 'unreadable', message: string) {
    super(message)
    this.reason = reason
  }
}
const MISSING_SESSION =
  'No Grok Bot gateway session is saved on this computer. Sign in to Grok Bot and connect its Computer view. If it is already connected, fully quit Grok Bot with Quit (Cmd+Q on Mac), reopen it and reconnect, then click Read desktop sessions again.'

async function boundedJson(
  path: string,
  signal: AbortSignal,
  purpose: 'session' | 'key' | 'status' | 'accounts' = 'session'
): Promise<unknown> {
  let file: Awaited<ReturnType<typeof open>> | null = null
  const name = purpose === 'key' ? 'Windows encryption-key file' : purpose === 'status' ? 'desktop status file' : purpose === 'accounts' ? 'saved account list' : 'desktop session file'
  try {
    signal.throwIfAborted()
    file = await open(path, 'r')
    signal.throwIfAborted()
    const info = await file.stat()
    signal.throwIfAborted()
    if (!info.isFile()) throw new DesktopFileError('unreadable', `The Grok Bot ${name} is not a regular file.`)
    if (info.size > (purpose === 'status' ? 8192 : 4 * 1024 * 1024))
      throw new DesktopFileError('unreadable', `The Grok Bot ${name} is too large to import.`)
    return JSON.parse(await file.readFile({ encoding: 'utf8', signal }))
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof DesktopFileError) throw error
    const code = record(error) ? error.code : undefined
    if (code === 'ENOENT' || code === 'ENOTDIR')
      throw new DesktopFileError('missing', purpose === 'session' ? MISSING_SESSION : `The Grok Bot ${name} is missing. Open the desktop app on this computer and reconnect its Computer view.`)
    if (code === 'EACCES' || code === 'EPERM')
      throw new DesktopFileError('unreadable', `Stoke does not have permission to read the Grok Bot ${name}. Run both apps as the same OS user and check access to the Grok Bot data folder.`)
    if (error instanceof SyntaxError)
      throw new DesktopFileError('unreadable', `The Grok Bot ${name} contains invalid JSON. Open the desktop app's Computer view to refresh its saved session, then try again.`)
    throw new DesktopFileError('unreadable', `The Grok Bot ${name} could not be read. Check access to its data folder, then try again.`)
  } finally {
    await file?.close()
  }
}

function slots(raw: unknown): { id: string; encrypted: string; label: string; savedAtMs?: number }[] {
  if (!record(raw)) throw new Error('The desktop session descriptor is unreadable.')
  if (![undefined, 1, 2, 3].includes(raw.version as number | undefined)) {
    const version = Number.isSafeInteger(raw.version) ? ` (version ${raw.version})` : ''
    throw new Error(`This desktop session format${version} is not supported. Update Stoke and try again.`)
  }
  const multi = raw.version === 2 || raw.version === 3
  if (multi && !record(raw.entries))
    throw new Error('The desktop session descriptor has no valid saved sessions.')
  const entries = multi ? Object.entries(raw.entries as Record<string, unknown>) : [['current', raw]]
  if (!entries.length || entries.length > 32)
    throw new Error('Choose a desktop profile with saved Grok Bot sessions.')
  return entries.map(([id, entry], index) => {
    if (
      typeof id !== 'string' ||
      !id ||
      id.length > 160 ||
      /[\u0000-\u001f\u007f]/.test(id) ||
      !record(entry) ||
      typeof entry.encrypted !== 'string' ||
      !/^[a-z0-9+/]+={0,2}$/i.test(entry.encrypted) ||
      entry.encrypted.length > 128 * 1024
    )
      throw new Error('The desktop session descriptor has an unsupported entry.')
    if (raw.version === 3 && (!Number.isSafeInteger(entry.savedAtMs) || (entry.savedAtMs as number) < 0))
      throw new Error('The desktop session descriptor has an invalid saved-session date.')
    const supplied =
      typeof entry.label === 'string' ? entry.label : typeof entry.email === 'string' ? entry.email : ''
    return {
      id,
      encrypted: entry.encrypted,
      ...(raw.version === 3 ? { savedAtMs: entry.savedAtMs as number } : {}),
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
  /** Device-local folder grants; never included in account sync. */
  profileStore?: string
  /** Injected only by owned tests; production uses native OS protection. */
  password?: (signal: AbortSignal) => Promise<string>
  unprotect?: (blob: Buffer, signal: AbortSignal) => Promise<Buffer>
}
interface DesktopProfiles {
  version: 1
  profiles: { id: string; path: string }[]
}
const profileIdValid = (value: unknown): value is string =>
  typeof value === 'string' && /^gbprofile-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
export class GrokBotSessionReader {
  private options: GrokBotSessionReaderOptions
  private profiles: PluginFile<DesktopProfiles>
  constructor(options: GrokBotSessionReaderOptions) {
    this.options = options
    this.profiles = new PluginFile(options.profileStore || join(options.home, '.stoke', 'grok-bot-desktop-profiles.json'), 256 * 1024)
  }
  private defaultRoot(): string {
    const { platform, home, environment: env } = this.options
    return platform === 'win32'
      ? join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Grok Bot')
      : platform === 'linux'
        ? join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Grok Bot')
        : join(home, 'Library', 'Application Support', 'Grok Bot')
  }
  private async readProfiles(signal: AbortSignal): Promise<DesktopProfiles> {
    let raw: unknown
    try { raw = await this.profiles.read(signal) } catch {
      signal.throwIfAborted()
      throw new Error('The saved desktop profile folders cannot be read. Keep the file for recovery.')
    }
    if (raw === null) return { version: 1, profiles: [] }
    if (!record(raw) || raw.version !== 1 || !Array.isArray(raw.profiles) || raw.profiles.length > 32)
      throw new Error('The saved desktop profile folders cannot be read. Keep the file for recovery.')
    const ids = new Set<string>()
    for (const profile of raw.profiles) {
      if (!record(profile) || !profileIdValid(profile.id) || ids.has(profile.id) ||
        typeof profile.path !== 'string' || !isAbsolute(profile.path) || profile.path.length > 4096 || /[\u0000-\u001f]/.test(profile.path))
        throw new Error('The saved desktop profile folders contain an unsupported entry.')
      ids.add(profile.id)
    }
    return raw as unknown as DesktopProfiles
  }
  private async root(profileId: string | undefined, signal: AbortSignal): Promise<string> {
    if (profileId === undefined) return this.defaultRoot()
    if (!profileIdValid(profileId)) throw new Error('Choose a Grok Bot desktop profile folder again.')
    return this.profiles.transaction(async storeSignal => {
      const combined = AbortSignal.any([signal, storeSignal])
      const profile = (await this.readProfiles(combined)).profiles.find(item => item.id === profileId)
      combined.throwIfAborted()
      if (!profile) throw new Error('Choose a Grok Bot desktop profile folder again.')
      return profile.path
    })
  }
  /** Called only with a folder returned by the native picker, never a renderer path. */
  async addProfile(path: string, signal: AbortSignal): Promise<GrokBotDesktopProfile> {
    signal.throwIfAborted()
    if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f]/.test(path))
      throw new Error('Choose the Grok Bot data folder used by your desktop shortcut.')
    let folder: string
    try {
      folder = await realpath(path)
      signal.throwIfAborted()
      if (!(await stat(folder)).isDirectory()) throw new Error('not a folder')
    } catch {
      signal.throwIfAborted()
      throw new Error('The selected Grok Bot desktop profile folder is unavailable. Check its location and permissions.')
    }
    signal.throwIfAborted()
    if (folder.length > 4096 || /[\u0000-\u001f]/.test(folder))
      throw new Error('Choose a Grok Bot desktop profile folder with a supported path.')
    // Check the selected folder before remembering it. Listing never opens credentials.
    const sources = await this.folderSources(folder, signal)
    return this.profiles.transaction(async storeSignal => {
      const combined = AbortSignal.any([signal, storeSignal])
      const state = await this.readProfiles(combined)
      const identity = (value: string): string => this.options.platform === 'win32' ? value.toLowerCase() : value
      let profile = state.profiles.find(item => identity(item.path) === identity(folder))
      if (!profile) {
        if (state.profiles.length >= 32) throw new Error('This computer already has 32 registered Grok Bot desktop profile folders.')
        profile = { id: `gbprofile-${randomUUID()}`, path: folder }
        state.profiles.push(profile)
        await this.profiles.write(state, combined)
      }
      combined.throwIfAborted()
      return { id: profile.id, label: basename(folder), sources }
    })
  }
  private async descriptor(signal: AbortSignal, root: string): Promise<unknown> {
    try {
      return await boundedJson(join(root, 'gateway-descriptor.json'), signal)
    } catch (error) {
      if (!(error instanceof DesktopFileError) || error.reason !== 'missing') throw error
      let status: unknown
      try {
        // The public marker contains status only, never account credentials.
        status = await boundedJson(join(root, 'desktop-status.json'), signal, 'status')
      } catch {
        signal.throwIfAborted()
      }
      if (record(status) && status.version === 1 && status.signedIn === true)
        throw new DesktopFileError('missing', 'Grok Bot reports a signed-in account, but no gateway session is saved. Connect its Computer view. If it is already connected, fully quit Grok Bot with Quit (Cmd+Q on Mac), reopen it and reconnect, then click Read desktop sessions again.')
      throw error
    }
  }
  /** Reads only account IDs and the active marker. No OAuth/profile value is decrypted. */
  private async nativeLogins(root: string, signal: AbortSignal): Promise<{ ids: string[]; active: string | null } | null> {
    let raw: unknown
    try { raw = await boundedJson(join(root, 'sand-secrets.json'), signal, 'accounts') } catch (error) {
      if (error instanceof DesktopFileError && error.reason === 'missing') return null
      throw error
    }
    if (!record(raw) || ![undefined, 1].includes(raw.version as number | undefined))
      throw new Error('This Grok Bot saved-account format is not supported. Update Stoke and try again.')
    // Older app versions keep just one native login and have no account index.
    if (raw['cursor-accounts'] === undefined) return null
    if (typeof raw['cursor-accounts'] !== 'string')
      throw new Error('The Grok Bot saved account list is unreadable. Open its account switcher and try again.')
    let index: unknown
    try { index = JSON.parse(raw['cursor-accounts']) } catch {
      throw new Error('The Grok Bot saved account list is unreadable. Open its account switcher and try again.')
    }
    if (!record(index) || !record(index.accounts) ||
      !(index.active === null || typeof index.active === 'string') || Object.keys(index.accounts).length > 32)
      throw new Error('The Grok Bot saved account list has unsupported entries. Update Stoke and try again.')
    const ids: string[] = []
    for (const [id, account] of Object.entries(index.accounts)) {
      if (!/^[0-9a-f]{64}$/.test(id) || !record(account))
        throw new Error('The Grok Bot saved account list has unsupported entries. Update Stoke and try again.')
      // Match the desktop switcher's requirement for a complete saved login.
      if (typeof account['cursor-access-token'] === 'string' && account['cursor-access-token'].length &&
        typeof account['cursor-refresh-token'] === 'string' && account['cursor-refresh-token'].length) ids.push(id)
    }
    return { ids, active: typeof index.active === 'string' ? index.active : null }
  }
  private async folderSources(root: string, signal: AbortSignal): Promise<GrokBotSource[]> {
    // Both stores are metadata-only reads. They describe different things:
    // native saved logins versus recently exported computer connections.
    const [accounts, descriptor] = await Promise.allSettled([
      this.nativeLogins(root, signal), this.descriptor(signal, root)
    ])
    signal.throwIfAborted()
    if (accounts.status === 'rejected') throw accounts.reason
    const native = accounts.value
    let connections: ReturnType<typeof slots>
    if (descriptor.status === 'fulfilled') connections = slots(descriptor.value)
    else if (native?.ids.length && descriptor.reason instanceof DesktopFileError && descriptor.reason.reason === 'missing') connections = []
    else throw descriptor.reason
    if (!native?.ids.length) return connections.map(({ id, label }) => ({ id, label }))
    const byId = new Map(connections.map(entry => [entry.id, entry]))
    const sources: GrokBotSource[] = native.ids.map((id, index) => {
      const connection = byId.get(id)
      byId.delete(id)
      const state = !connection ? 'missing' : connection.savedAtMs !== undefined && Date.now() - connection.savedAtMs > DESKTOP_SESSION_MAX_AGE_MS ? 'expired' : 'saved'
      return {
        id, label: `Desktop login ${index + 1}`, nativeLogin: true, current: id === native.active,
        connection: state
      }
    })
    // Preserve legacy/orphan exports as separate connections; never guess an
    // account association or substitute a different login's gateway.
    sources.push(...[...byId.values()].map(({ id, label }) => ({ id, label })))
    return sources
  }
  async sources(signal: AbortSignal, profileId?: string): Promise<GrokBotSource[]> {
    return this.folderSources(await this.root(profileId, signal), signal)
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
    signal: AbortSignal,
    profileId?: string
  ): Promise<{ session: GrokBotSession; slot: string }> {
    const root = await this.root(profileId, signal)
    let entries: ReturnType<typeof slots>
    try { entries = slots(await this.descriptor(signal, root)) } catch (error) {
      if (error instanceof DesktopFileError && error.reason === 'missing' && sourceSlot &&
        (await this.nativeLogins(root, signal))?.ids.includes(sourceSlot))
        throw new Error('This desktop login has no saved computer connection. Switch to this account in Grok Bot, open Computer and wait for it to connect, then read desktop sessions again.')
      throw error
    }
    const selected = sourceSlot
      ? entries.find((entry) => entry.id === sourceSlot)
      : entries.length === 1
        ? entries[0]
        : undefined
    if (!selected) {
      if (sourceSlot && (await this.nativeLogins(root, signal))?.ids.includes(sourceSlot))
        throw new Error('This desktop login has no saved computer connection. Switch to this account in Grok Bot, open Computer and wait for it to connect, then read desktop sessions again.')
      throw new Error('Choose which saved desktop session to import.')
    }
    if (selected.savedAtMs !== undefined && Date.now() - selected.savedAtMs > DESKTOP_SESSION_MAX_AGE_MS)
      throw new Error(
        'This saved desktop session has expired. Open Grok Bot with the account you want, load a bot to refresh its session, then read desktop sessions and import again.'
      )
    const encrypted = Buffer.from(selected.encrypted, 'base64')
    let clear: string
    try {
      if (this.options.platform === 'win32') {
        const state = await boundedJson(join(root, 'Local State'), signal, 'key')
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
    } catch (error) {
      signal.throwIfAborted()
      if (error instanceof DesktopFileError) throw error
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
