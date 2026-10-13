import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { grokBotCommand } from '../../shared/grokBotCommands.ts'
import { judgeProtection, sealedText, unsealedValue } from '../../shared/secrets.ts'
import { stableJson } from '../../shared/hub/codec.ts'
import {
  GBOT_VERSION,
  isGrokBotAccountId,
  type GrokBotAccount,
  type GrokBotAccountCommand,
  type GrokBotDesktopProfile,
  type GrokBotOperation,
  type GrokBotResult,
  type GrokBotView
} from '../../shared/grokBot.ts'
import type { SecretBackend } from '../secrets.ts'
import { PluginFile } from './files.ts'
import { PluginBusyError, PluginProcesses, pluginEnvironment } from './processes.ts'
import { GrokBotRuntime } from './grokBotRuntime.ts'
import { GrokBotSessionReader, validateGrokBotSession, type GrokBotSession } from './grokBotSession.ts'
interface SavedAccount {
  account: GrokBotAccount
  sealed: string
}
interface State {
  schema: 1
  revision: number
  accounts: SavedAccount[]
  defaultAccount: string | null
}
interface Options {
  root: string
  executable: string
  runner: string
  platform: string
  environment: NodeJS.ProcessEnv
  backend: SecretBackend
  reader: GrokBotSessionReader
  enabled: () => Promise<boolean>
  changed: (view: GrokBotView) => void
  openDesktop?: () => Promise<void>
}
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
function label(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 100 || /[\u0000-\u001f]/.test(value))
    throw new Error('Give the account a nickname.')
  return value.trim()
}
const reference = (id: string): string => `plugins.grok-bot.${id}`
function sendDelivery(data: unknown): 'accepted' | 'unknown' {
  if (!record(data) || (data.exitCode !== undefined && data.exitCode !== 0)) return 'unknown'
  if (data.delivery === 'accepted') return 'accepted'
  // Current gateways acknowledge with { accepted: true }, without messageId.
  // The pinned CLI keeps that acknowledgement in result but calls it unknown.
  return data.delivery === 'unknown' && record(data.result) && data.result.accepted === true
    ? 'accepted'
    : 'unknown'
}
/** Never resolves a command through the desktop app's current/default login. */
export class GrokBotPlugin {
  private options: Options
  /** Main-only vault adapter; no CLI runs and a disabled plugin stays disabled. */
  async exportForSync(): Promise<{ id: string; label: string; credential: { gatewayUrl: string; token: string; headers: Record<string, string> } }[]> {
    return this.file.transaction(async signal => {
      this.protected()
      const state = await this.load(signal)
      return state.accounts.flatMap(entry => {
        const session = this.session(entry)
        if (session.allowLocal) return []
        return [{ id: entry.account.id, label: entry.account.label, credential: { gatewayUrl: session.gatewayUrl, token: session.token, headers: session.headers } }]
      })
    })
  }

  async importFromSync(id: string, value: { label: string; credential: { gatewayUrl: string; token: string; headers: Record<string, string> } } | null, allowed: () => boolean): Promise<void> {
    if (!isGrokBotAccountId(id)) throw new Error('The synced Grok Bot account ID is invalid.')
    this.protected()
    await this.file.transaction(async signal => {
      const state = await this.load(signal)
      if (!allowed()) throw new Error('Account sync was turned off.')
      const old = state.accounts.find(entry => entry.account.id === id)
      if (!value) {
        if (!old) return
        this.stop(); this.processes.resume()
        state.accounts = state.accounts.filter(entry => entry !== old)
        if (state.defaultAccount === id) state.defaultAccount = state.accounts[0]?.account.id ?? null
      } else {
        const name = label(value.label)
        const session = validateGrokBotSession(value.credential, false)
        if (!old && state.accounts.length >= 32) throw new Error('This device has too many Grok Bot accounts.')
        const changedCredential = !old || stableJson(this.session(old)) !== stableJson(session)
        if (old && old.account.label === name && !changedCredential) return
        if (changedCredential && old) { this.stop(); this.processes.resume() }
        const account: GrokBotAccount = { id, label: name, gatewayHost: new URL(session.gatewayUrl).host, source: 'manual', sourceSlot: '', status: changedCredential ? 'saved' : old!.account.status, checkedAt: changedCredential ? null : old!.account.checkedAt, updatedAt: Date.now() }
        const sealed = changedCredential ? this.options.backend.encrypt(sealedText(reference(id), JSON.stringify(session))).toString('base64') : old!.sealed
        state.accounts = [...state.accounts.filter(entry => entry.account.id !== id), { account, sealed }]
        state.defaultAccount ??= id
      }
      signal.throwIfAborted()
      if (!allowed()) throw new Error('Account sync was turned off.')
      state.revision++
      await this.file.write(state, signal)
      this.options.changed(this.view(state))
    })
  }
  private file: PluginFile<State>
  private runtime: GrokBotRuntime
  private processes = new PluginProcesses()
  private epoch = 0
  private controllers = new Set<AbortController>()
  private cliInstalled = false
  constructor(options: Options) {
    this.options = options
    this.file = new PluginFile(join(options.root, 'grok-bot-accounts.json'))
    this.runtime = new GrokBotRuntime(options.root)
  }
  stop(): void {
    this.epoch++
    for (const controller of this.controllers) controller.abort()
    this.processes.stop()
    this.runtime.stop()
  }
  private async guard(epoch: number): Promise<void> {
    if (epoch !== this.epoch || !(await this.options.enabled()) || epoch !== this.epoch)
      throw new Error('Enable the Grok Bot plugin first.')
  }
  private protected(): void {
    const b = this.options.backend
    if (!judgeProtection(this.options.platform, b.isEncryptionAvailable(), b.selectedBackend()).protected)
      throw new Error(
        'Grok Bot sessions require the OS key store. Set up Keychain, DPAPI or Linux Secret Service first.'
      )
  }
  private async load(signal: AbortSignal): Promise<State> {
    const raw = await this.file.read(signal)
    if (raw === null) return { schema: 1, revision: 0, accounts: [], defaultAccount: null }
    if (
      !record(raw) ||
      raw.schema !== 1 ||
      !Number.isSafeInteger(raw.revision) ||
      !Array.isArray(raw.accounts) ||
      raw.accounts.length > 32
    )
      throw new Error('The account store cannot be read. Keep it for recovery.')
    const seen = new Set<string>()
    for (const entry of raw.accounts) {
      if (
        !record(entry) ||
        !record(entry.account) ||
        !isGrokBotAccountId(entry.account.id) ||
        seen.has(entry.account.id) ||
        typeof entry.sealed !== 'string' ||
        entry.sealed.length > 512 * 1024 ||
        typeof entry.account.label !== 'string' ||
        typeof entry.account.gatewayHost !== 'string' ||
        !['saved', 'connected', 'reconnect'].includes(entry.account.status as string)
      )
        throw new Error('The account store contains an unsupported entry.')
      seen.add(entry.account.id)
    }
    if (
      raw.defaultAccount !== null &&
      (typeof raw.defaultAccount !== 'string' || !seen.has(raw.defaultAccount))
    )
      throw new Error('The default Grok Bot account is unavailable.')
    return raw as unknown as State
  }
  private view(state: State): GrokBotView {
    return {
      revision: state.revision,
      accounts: state.accounts.map((entry) => structuredClone(entry.account)),
      defaultAccount: state.defaultAccount,
      cli: { installed: this.cliInstalled, version: GBOT_VERSION }
    }
  }
  async read(): Promise<GrokBotView> {
    const epoch = this.epoch
    await this.guard(epoch)
    this.cliInstalled = await this.runtime.installed()
    await this.guard(epoch)
    return this.file.transaction(async (signal) => this.view(await this.load(signal)))
  }
  async install(): Promise<GrokBotView> {
    const epoch = this.epoch
    await this.guard(epoch)
    await this.runtime.install()
    await this.guard(epoch)
    this.cliInstalled = true
    const view = await this.read()
    this.options.changed(view)
    return view
  }
  async sources(profileId?: string): Promise<import('../../shared/grokBot.ts').GrokBotSource[]> {
    const epoch = this.epoch
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      await this.guard(epoch)
      const sources = await this.options.reader.sources(controller.signal, profileId)
      await this.guard(epoch)
      return sources
    } finally {
      clearTimeout(timer)
      this.controllers.delete(controller)
    }
  }
  async chooseProfile(choose: () => Promise<string | null>): Promise<GrokBotDesktopProfile | null> {
    const epoch = this.epoch
    await this.guard(epoch)
    // The native dialog may remain open; start the I/O deadline after selection.
    const path = await choose()
    await this.guard(epoch)
    if (path === null) return null
    const controller = new AbortController()
    this.controllers.add(controller)
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const profile = await this.options.reader.addProfile(path, controller.signal)
      await this.guard(epoch)
      return profile
    } finally {
      clearTimeout(timer)
      this.controllers.delete(controller)
    }
  }
  async change(raw: GrokBotAccountCommand): Promise<GrokBotView> {
    const epoch = this.epoch
    await this.guard(epoch)
    if (!record(raw) || !['import', 'manual', 'rename', 'remove', 'default'].includes(raw.kind))
      throw new Error('Choose an account action.')
    // Removing/replacing credentials invalidates all jobs prepared with old snapshots.
    if (raw.kind === 'remove' || (raw.kind === 'import' && raw.replace)) {
      this.stop()
      this.processes.resume()
    }
    const operationEpoch = this.epoch
    return this.file.transaction(async (signal) => {
      await this.guard(operationEpoch)
      const state = await this.load(signal)
      if (raw.kind === 'manual' || raw.kind === 'import') {
        this.protected()
        const name = label(raw.label)
        const loaded =
          raw.kind === 'import'
            ? await this.options.reader.load(raw.sourceSlot, signal, raw.profileId)
            : { slot: '', session: validateGrokBotSession(raw, raw.allowLocal === true) }
        await this.guard(operationEpoch)
        signal.throwIfAborted()
        const replace = raw.kind === 'import' ? raw.replace : undefined
        if (replace && !state.accounts.some((entry) => entry.account.id === replace))
          throw new Error('Choose the account to reconnect.')
        if (!replace && state.accounts.length >= 32)
          throw new Error('Remove an account before adding another.')
        const id = replace || `gbot-${randomUUID()}`
        const sealed = this.options.backend
          .encrypt(sealedText(reference(id), JSON.stringify(loaded.session)))
          .toString('base64')
        const account: GrokBotAccount = {
          id,
          label: name,
          gatewayHost: new URL(loaded.session.gatewayUrl).host,
          source: raw.kind === 'import' ? 'desktop' : 'manual',
          sourceSlot: loaded.slot,
          status: 'saved',
          checkedAt: null,
          updatedAt: Date.now()
        }
        state.accounts = [...state.accounts.filter((entry) => entry.account.id !== id), { account, sealed }]
        state.defaultAccount ??= id
      } else {
        if (!isGrokBotAccountId(raw.id)) throw new Error('Choose a saved account.')
        const entry = state.accounts.find((entry) => entry.account.id === raw.id)
        if (!entry) throw new Error('This account was removed.')
        if (raw.kind === 'rename') {
          entry.account.label = label(raw.label)
          entry.account.updatedAt = Date.now()
        } else if (raw.kind === 'default') state.defaultAccount = raw.id
        else {
          state.accounts = state.accounts.filter((entry) => entry.account.id !== raw.id)
          if (state.defaultAccount === raw.id) state.defaultAccount = state.accounts[0]?.account.id ?? null
        }
      }
      await this.guard(operationEpoch)
      signal.throwIfAborted()
      state.revision++
      await this.file.write(state, signal)
      const view = this.view(state)
      this.options.changed(view)
      return view
    })
  }
  private session(entry: SavedAccount): GrokBotSession {
    this.protected()
    try {
      const text = unsealedValue(
        reference(entry.account.id),
        this.options.backend.decrypt(Buffer.from(entry.sealed, 'base64'))
      )
      if (!text) throw new Error()
      const raw = JSON.parse(text)
      return validateGrokBotSession(raw, raw.allowLocal === true)
    } catch {
      throw new Error('This session cannot be opened. Reconnect this account on this device.')
    }
  }
  async operate(raw: GrokBotOperation): Promise<GrokBotResult> {
    const epoch = this.epoch
    await this.guard(epoch)
    if (
      !record(raw) ||
      !isGrokBotAccountId(raw.accountId)
    )
      throw new Error('Choose an account and Grok Bot action.')
    const plan = grokBotCommand(raw)
    const entry = await this.file.transaction(async (signal) =>
      (await this.load(signal)).accounts.find((entry) => entry.account.id === raw.accountId)
    )
    if (!entry) throw new Error('This account was removed.')
    if (raw.kind === 'desktop') {
      await this.guard(epoch)
      if (!this.options.openDesktop) throw new Error('Install the Grok Bot desktop app to view or control its computer.')
      await this.options.openDesktop()
      return { ok: true, data: null, message: `Opened Grok Bot. Verify that its signed-in account matches ${entry.account.label}, then open Computer and choose Take over.` }
    }
    const session = this.session(entry)
    await this.guard(epoch)
    this.processes.resume()
    const redact = (value: string): string => {
      for (const secret of [session.token, ...Object.values(session.headers)])
        if (secret) {
          value = value.split(secret).join('[redacted]')
          const escaped = JSON.stringify(secret).slice(1, -1)
          value = value.split(escaped).join('[redacted]')
        }
      return value
    }
    const invoke = async (argv: string[], gateway = true): Promise<unknown> => {
      const result = await this.processes.run(async (signal) => {
        await this.guard(epoch)
        const path = await this.runtime.ready()
        signal.throwIfAborted()
        await this.guard(epoch)
        const env = {
          ...pluginEnvironment(this.options.environment),
          GROK_BOT_GATEWAY_URL: session.gatewayUrl,
          GROK_BOT_GATEWAY_TOKEN: session.token,
          GROK_BOT_GATEWAY_HEADERS: JSON.stringify(session.headers),
          GROK_BOT_HISTORY: 'off',
          ...(session.allowLocal ? { GROK_BOT_ALLOW_LOCAL_GATEWAY: '1' } : {})
        }
        const cwd = join(this.options.root, 'data', 'grok-bot')
        await mkdir(cwd, { recursive: true, mode: 0o700 })
        signal.throwIfAborted()
        await this.guard(epoch)
        const separator = argv.indexOf('--')
        const flags = [...(gateway ? ['--gateway'] : []), '--json']
        const cliArgs =
          separator < 0
            ? [...argv, ...flags]
            : [...argv.slice(0, separator), ...flags, ...argv.slice(separator)]
        return {
          executable: this.options.executable,
          args: ['--require', this.options.runner, path],
          cwd,
          env,
          input: JSON.stringify({ argv: cliArgs })
        }
      })
      if (result.code)
        throw new Error(
          `Grok Bot exited with status ${result.code}. ${redact(result.stderr || result.stdout).slice(0, 1800)}`
        )
      try {
        return JSON.parse(redact(result.stdout))
      } catch {
        throw new Error('Grok Bot did not return a complete JSON result.')
      }
    }
    let sendReceipt: GrokBotResult | undefined
    let skillFolder: string | undefined
    try {
      let data: unknown
      if (raw.kind === 'list') {
        const [bots, groups] = await Promise.all([invoke(['bots', 'list']), invoke(['groups', 'list'])])
        data = { bots, groups }
      } else {
        if (plan.markdown !== undefined) {
          const parent = join(this.options.root, 'data', 'grok-bot')
          await mkdir(parent, { recursive: true, mode: 0o700 })
          skillFolder = await mkdtemp(join(parent, 'skill-'))
          const path = join(skillFolder, 'SKILL.md')
          await writeFile(path, plan.markdown, { mode: 0o600 })
          await this.guard(epoch)
          plan.argv.push('--', path)
        }
        data = await invoke(plan.argv, plan.gateway)
      }
      if (raw.kind === 'send') {
        const delivery = sendDelivery(data)
        sendReceipt = {
          ok: delivery === 'accepted',
          data: record(data) ? { ...data, delivery } : data,
          delivery,
          ...(delivery === 'unknown'
            ? { message: 'Grok Bot did not confirm delivery. Read the thread before resending.' }
            : {})
        }
      }
      await this.guard(epoch)
      await this.status(entry, 'connected', epoch)
      return sendReceipt ?? { ok: true, data }
    } catch (error) {
      // Saving account status is secondary to the server's confirmed receipt.
      // A disk error or disable after acceptance must not suggest resending.
      if (sendReceipt?.delivery === 'accepted') return sendReceipt
      if (
        epoch === this.epoch &&
        /(?:401|403|session cannot be opened|authentication|unauthori[sz]ed)/i.test(
          error instanceof Error ? error.message : ''
        )
      )
        await this.status(entry, 'reconnect', epoch).catch(() => {})
      return {
        ok: false,
        data: null,
        message: redact(error instanceof Error ? error.message : 'Grok Bot could not complete this action.'),
        ...(error instanceof PluginBusyError ? { code: 'busy' as const } : {}),
        ...(raw.kind === 'send' ? { delivery: 'unknown' as const } : {})
      }
    } finally {
      if (skillFolder) await rm(skillFolder, { recursive: true, force: true }).catch(() => {})
    }
  }
  private status(snapshot: SavedAccount, status: GrokBotAccount['status'], epoch: number): Promise<void> {
    return this.file.transaction(async (signal) => {
      await this.guard(epoch)
      const state = await this.load(signal),
        entry = state.accounts.find((entry) => entry.account.id === snapshot.account.id)
      if (!entry || entry.sealed !== snapshot.sealed) return
      entry.account.status = status
      entry.account.checkedAt = Date.now()
      state.revision++
      signal.throwIfAborted()
      await this.file.write(state, signal)
      this.options.changed(this.view(state))
    })
  }
}
