import { createHash, randomUUID } from 'node:crypto'
import { constants, writeFileSync, renameSync, rmSync } from 'node:fs'
import { open, lstat, realpath } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { Settings } from '../../shared/types.ts'
import type { AgentAccount } from '../../shared/accounts.ts'
import { isAccountId } from '../../shared/accounts.ts'
import { isGrokBotAccountId } from '../../shared/grokBot.ts'
import { codexAuthProblem, isSyncAccountId, MAX_SYNC_ACCOUNTS, syncedAccountProblem, type SyncedAccount, type SyncedAgentAccount } from '../../shared/hub/accountSync.ts'
import { stableJson } from '../../shared/hub/codec.ts'
import { judgeProtection, sealedText, unsealedValue } from '../../shared/secrets.ts'
import { makeAccountHome, type DefaultTrees } from '../accounts.ts'
import { PluginFile } from '../plugins/files.ts'
import type { SecretBackend } from '../secrets.ts'
import type { GrokBotPlugin } from '../plugins/grokBot.ts'

interface Entry {
  localId: string
  payload: SyncedAccount
  removed?: boolean
  pending?: { against: string | null }
}
interface State { v: 1; entries: Record<string, Entry> }
interface Stored { v: 1; sealed: string }
export interface AccountSyncOptions {
  userData: string
  root: string
  trees: DefaultTrees
  platform: string
  label: string
  backend: SecretBackend
  getSettings(): Settings
  commit(patch: Partial<Settings>): Promise<Settings> | Settings
  active(cli: string, accountId: string): boolean
  grok(): Promise<GrokBotPlugin>
  changed(): void
}
const SLOT = 'hub.synced-accounts'
const hash = (value: unknown): string => createHash('sha256').update(stableJson(value)).digest('hex')
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Main-only adapter. Only encrypted payloads are cached; CLI auth stays in owned local homes. */
export class AccountSync {
  private options: AccountSyncOptions
  private files = new Map<string, PluginFile<Stored>>()
  constructor(options: AccountSyncOptions) {
    this.options = options
  }
  private forVault(namespace: string): PluginFile<Stored> {
    if (!namespace || namespace.length > 256) throw new Error('Account sync needs a vault identity.')
    let file = this.files.get(namespace)
    if (!file) {
      file = new PluginFile(join(this.options.userData, `hub-accounts-${hash(namespace).slice(0, 24)}.json`), 20 * 1024 * 1024)
      this.files.set(namespace, file)
    }
    return file
  }
  private protected(): void {
    const b = this.options.backend
    if (!judgeProtection(this.options.platform, b.isEncryptionAvailable(), b.selectedBackend()).protected) throw new Error('Account sync requires the OS key store on this device.')
  }
  private async load(file: PluginFile<Stored>, namespace: string, signal: AbortSignal): Promise<State> {
    this.protected()
    const raw = await file.read(signal)
    if (raw === null) return { v: 1, entries: {} }
    try {
      if (!record(raw) || raw.v !== 1 || typeof raw.sealed !== 'string') throw new Error()
      const text = unsealedValue(`${SLOT}.${namespace}`, this.options.backend.decrypt(Buffer.from(raw.sealed, 'base64')))
      if (!text) throw new Error()
      const state = JSON.parse(text) as State
      if (state.v !== 1 || !record(state.entries) || Object.keys(state.entries).length > MAX_SYNC_ACCOUNTS) throw new Error()
      for (const [id, entry] of Object.entries(state.entries)) if (!isSyncAccountId(id) || !record(entry) ||
        !(isAccountId(entry.localId) || isGrokBotAccountId(entry.localId) || (typeof entry.localId === 'string' && /^@codex-default:[0-9a-f]{64}$/.test(entry.localId))) ||
        (entry.removed !== undefined && typeof entry.removed !== 'boolean') ||
        (entry.pending !== undefined && (!record(entry.pending) || (entry.pending.against !== null && (typeof entry.pending.against !== 'string' || !/^[0-9a-f]{64}$/.test(entry.pending.against))))) || syncedAccountProblem(entry.payload)) throw new Error()
      return state
    } catch { throw new Error('The synced account store cannot be opened. Keep it for recovery.') }
  }
  private save(state: State, file: PluginFile<Stored>, namespace: string, signal: AbortSignal): Promise<void> {
    return file.write({ v: 1, sealed: this.options.backend.encrypt(sealedText(`${SLOT}.${namespace}`, stableJson(state))).toString('base64') }, signal)
  }
  private ensure(allowed: () => boolean, signal: AbortSignal): void {
    signal.throwIfAborted()
    if (!allowed()) throw new Error('Account sync is no longer enabled for this vault.')
  }

  /** Bounded reads of the documented file cache; keyring and ephemeral sign-ins are never scraped. */
  private async codex(home: string, fileStore = false): Promise<string | null> {
    let handle: Awaited<ReturnType<typeof open>> | null = null
    try {
      if (!fileStore) {
        let config: Awaited<ReturnType<typeof open>> | null = null
        try {
          config = await open(join(home, 'config.toml'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
          const stat = await config.stat()
          if (!stat.isFile() || stat.size > 256 * 1024) return null
          const contents = await config.readFile('utf8')
          const top = contents.split(/^\s*\[/m, 1)[0]
          if (/^\s*cli_auth_credentials_store\s*=\s*["'](?:keyring|auto|ephemeral)["']/m.test(top)) return null
        } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err } finally { await config?.close() }
      }
      const file = join(home, 'auth.json')
      if ((await lstat(file)).isSymbolicLink()) return null
      handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 64 * 1024) return null
      const raw: unknown = JSON.parse(await handle.readFile('utf8'))
      if (!record(raw)) return null
      const cache: Record<string, unknown> = {}
      for (const k of ['auth_mode', 'OPENAI_API_KEY', 'last_refresh']) if (typeof raw[k] === 'string' || raw[k] === null) cache[k] = raw[k]
      if (record(raw.tokens)) {
        const tokens: Record<string, unknown> = {}
        for (const k of ['id_token', 'access_token', 'refresh_token', 'account_id']) if (typeof raw.tokens[k] === 'string' || raw.tokens[k] === null) tokens[k] = raw.tokens[k]
        cache.tokens = tokens
      }
      const value = stableJson(cache)
      return codexAuthProblem(value) ? null : value
    } catch (err) {
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes((err as NodeJS.ErrnoException).code ?? '') || err instanceof SyntaxError) return null
      throw new Error('A Codex login cache could not be read.')
    } finally { await handle?.close() }
  }
  private defaultIdentity(auth: string): string {
    const r = JSON.parse(auth)
    let sub = ''
    try { sub = JSON.parse(Buffer.from(r.tokens?.id_token?.split('.')[1] ?? '', 'base64url').toString()).sub ?? '' } catch { /* an API login has no JWT */ }
    return hash([r.tokens?.account_id ?? '', sub, r.OPENAI_API_KEY ?? ''])
  }
  private async agent(account: AgentAccount): Promise<SyncedAgentAccount> {
    const auth = account.cli === 'codex' && account.kind === 'login' ? await this.codex(account.home, account.credentialStore === 'file') : null
    return { v: 1, kind: 'agent', cli: account.cli, accountKind: account.kind, label: account.label,
      ...(account.apiProfile ? { apiProfile: structuredClone(account.apiProfile) } : {}),
      credential: account.kind === 'key' ? { format: 'api-key', value: account.apiKey } : auth ? { format: 'codex-file', value: auth } : null }
  }
  private async install(entry: Entry, account: AgentAccount, allowed: () => boolean, signal: AbortSignal): Promise<void> {
    if (entry.payload.kind !== 'agent' || entry.payload.credential?.format !== 'codex-file') return
    const value = entry.payload.credential.value
    const current = await this.codex(account.home, account.credentialStore === 'file')
    this.ensure(allowed, signal)
    if (current === value) { delete entry.pending; return }
    if (this.options.active(account.cli, account.id)) {
      entry.pending ??= { against: current === null ? null : hash(current) }
      return
    }
    if (entry.pending && current !== null && hash(current) !== entry.pending.against) {
      // The CLI refreshed while busy. Preserve that fresh local cache rather than replaying older tokens.
      const localTime = Date.parse(JSON.parse(current).last_refresh ?? '')
      const remoteTime = Date.parse(JSON.parse(value).last_refresh ?? '')
      if (!Number.isFinite(remoteTime) || !Number.isFinite(localTime) || localTime >= remoteTime) { delete entry.pending; return }
    }
    // Auth files cannot be redirected through a symlink or another account's settings path.
    const target = join(account.home, 'auth.json')
    const nativeDefault = account.id === 'default' && account.home === this.options.trees.codex && entry.localId.startsWith('@codex-default:') && current !== null && this.defaultIdentity(current) === this.defaultIdentity(value)
    if (!nativeDefault && relative(await realpath(this.options.root), await realpath(account.home)) !== account.id) throw new Error('This synced login needs its own managed account folder.')
    try { if ((await lstat(target)).isSymbolicLink()) throw new Error('This account uses a linked login cache; sign in on this device.') } catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err }
    this.ensure(allowed, signal)
    if (this.options.active(account.cli, account.id)) { entry.pending ??= { against: current === null ? null : hash(current) }; return }
    const temp = join(account.home, `.stoke-auth-${randomUUID()}.tmp`)
    try { writeFileSync(temp, value, { mode: 0o600, flag: 'wx' }); this.ensure(allowed, signal); renameSync(temp, target) } finally { rmSync(temp, { force: true }) }
    delete entry.pending
    if (!nativeDefault && account.credentialStore !== 'file') {
      const settings = this.options.getSettings()
      await this.options.commit({ accounts: { ...settings.accounts, [account.id]: { ...account, credentialStore: 'file' } } })
    }
    this.options.changed()
  }

  async snapshot(allowed: () => boolean, namespace = 'owned-fixture'): Promise<Map<string, SyncedAccount>> {
    const file = this.forVault(namespace)
    return file.transaction(async signal => {
      this.ensure(allowed, signal)
      const state = await this.load(file, namespace, signal), before = stableJson(state)
      this.ensure(allowed, signal)
      const local = new Map<string, SyncedAccount>()
      for (const account of Object.values(this.options.getSettings().accounts)) {
        let entry = Object.values(state.entries).find(e => e.localId === account.id && !e.removed)
        if (entry?.pending) await this.install(entry, account, allowed, signal)
        const payload = await this.agent(this.options.getSettings().accounts[account.id] ?? account)
        if (syncedAccountProblem(payload)) continue
        if (!entry) {
          if (Object.keys(state.entries).length >= MAX_SYNC_ACCOUNTS) throw new Error('The account sync limit was reached.')
          entry = { localId: account.id, payload }; state.entries[`sa-${randomUUID().replaceAll('-', '')}`] = entry
        }
        entry.payload = entry.pending && entry.payload.kind === 'agent' ? { ...payload, credential: entry.payload.credential } : payload
        if (entry.pending && payload.credential?.format === 'codex-file' && entry.payload.kind === 'agent' && entry.payload.credential?.format === 'codex-file') {
          const localTime = Date.parse(JSON.parse(payload.credential.value).last_refresh ?? '')
          const remoteTime = Date.parse(JSON.parse(entry.payload.credential.value).last_refresh ?? '')
          if (Number.isFinite(remoteTime) && Number.isFinite(localTime) && remoteTime > localTime) payload.credential = entry.payload.credential
        }
        local.set(Object.entries(state.entries).find(([, e]) => e === entry)![0], payload)
      }
      // The existing Codex login becomes a separate owned profile on a receiving device.
      // The receiving device's Default login is never replaced by this profile.
      const native = await this.codex(this.options.trees.codex)
      if (native) {
        const ref = `@codex-default:${this.defaultIdentity(native)}`
        let pair = Object.entries(state.entries).find(([, e]) => e.localId === ref)
        if (!pair && Object.keys(state.entries).length < MAX_SYNC_ACCOUNTS) {
          const payload: SyncedAgentAccount = { v: 1, kind: 'agent', cli: 'codex', accountKind: 'login', label: `Codex · ${this.options.label}`.slice(0, 40), credential: { format: 'codex-file', value: native } }
          const id = `sa-${randomUUID().replaceAll('-', '')}`
          state.entries[id] = { localId: ref, payload }; pair = [id, state.entries[id]]
        }
        if (pair && !pair[1].removed) {
          const entry = pair[1]
          if (entry.pending) await this.install(entry, { id: 'default', cli: 'codex', kind: 'login', label: entry.payload.label, home: this.options.trees.codex, apiKey: '' }, allowed, signal)
          if (entry.payload.kind === 'agent' && !entry.pending) entry.payload.credential = { format: 'codex-file', value: await this.codex(this.options.trees.codex) ?? native }
          local.set(pair[0], entry.payload)
        }
      }
      for (const bot of await (await this.options.grok()).exportForSync()) {
        let pair = Object.entries(state.entries).find(([, e]) => e.localId === bot.id && !e.removed)
        const payload: SyncedAccount = { v: 1, kind: 'grok-bot', label: bot.label, credential: bot.credential }
        if (!pair) {
          if (Object.keys(state.entries).length >= MAX_SYNC_ACCOUNTS) throw new Error('The account sync limit was reached.')
          const id = `sa-${randomUUID().replaceAll('-', '')}`; state.entries[id] = { localId: bot.id, payload }; pair = [id, state.entries[id]]
        }
        pair[1].payload = payload; local.set(pair[0], payload)
      }
      this.ensure(allowed, signal)
      if (stableJson(state) !== before) await this.save(state, file, namespace, signal)
      return local
    })
  }

  async apply(id: string, value: unknown | null, allowed: () => boolean, namespace = 'owned-fixture'): Promise<void> {
    const file = this.forVault(namespace)
    if (!isSyncAccountId(id) || (value !== null && syncedAccountProblem(value))) throw new Error('The synced account record is invalid.')
    await file.transaction(async signal => {
      this.ensure(allowed, signal)
      const state = await this.load(file, namespace, signal)
      this.ensure(allowed, signal)
      let entry = state.entries[id]
      if (!value) {
        if (!entry || entry.removed) return
        if (entry.payload.kind === 'grok-bot') await (await this.options.grok()).importFromSync(entry.localId, null, allowed)
        else if (!entry.localId.startsWith('@')) {
          const settings = this.options.getSettings(), accounts = { ...settings.accounts }, defaultAccount = { ...settings.agents.defaultAccount }
          delete accounts[entry.localId]
          for (const cli of Object.keys(defaultAccount) as (keyof typeof defaultAccount)[]) if (defaultAccount[cli] === entry.localId) delete defaultAccount[cli]
          this.ensure(allowed, signal)
          await this.options.commit({ accounts, agents: { ...settings.agents, defaultAccount } })
        }
        entry.removed = true; delete entry.pending
      } else {
        const payload = value as SyncedAccount
        if (entry && (entry.payload.kind !== payload.kind || (entry.payload.kind === 'agent' && payload.kind === 'agent' && (entry.payload.cli !== payload.cli || entry.payload.accountKind !== payload.accountKind)))) throw new Error('The synced account changed its identity.')
        if (!entry) {
          if (Object.keys(state.entries).length >= MAX_SYNC_ACCOUNTS) throw new Error('This device has too many synced accounts.')
          let localId = payload.kind === 'agent' ? `${payload.cli}-vault-${id.slice(3, 27)}` : `gbot-${randomUUID()}`
          const base = localId
          for (let n = 2; this.options.getSettings().accounts[localId]; n++) localId = `${base}-${n}`
          entry = { localId, payload }
          state.entries[id] = entry
        }
        const prior = entry.payload
        entry.payload = payload; delete entry.removed
        if (payload.kind === 'agent' && payload.credential?.format === 'codex-file' && prior.kind === 'agent' && prior.credential?.format === 'codex-file' && payload.credential.value !== prior.credential.value) entry.pending ??= { against: hash(prior.credential.value) }
        if (payload.kind === 'grok-bot') await (await this.options.grok()).importFromSync(entry.localId, payload, allowed)
        else if (!entry.localId.startsWith('@')) {
          let old = this.options.getSettings().accounts[entry.localId]
          if (old && (old.cli !== payload.cli || old.kind !== payload.accountKind)) throw new Error('This local account is no longer the synced profile.')
          if (!old && payload.accountKind === 'login') {
            const made = await makeAccountHome({ root: this.options.root, id: entry.localId, cli: payload.cli, trees: this.options.trees, platform: this.options.platform })
            old = { id: entry.localId, cli: payload.cli, kind: 'login', label: payload.label, home: made.home, apiKey: '' }
          }
          const account: AgentAccount = { ...(old ?? { id: entry.localId, cli: payload.cli, kind: payload.accountKind, home: '', apiKey: '' }), label: payload.label,
            ...(payload.apiProfile ? { apiProfile: payload.apiProfile } : {}),
            ...(payload.accountKind === 'key' ? { apiKey: payload.credential?.format === 'api-key' ? payload.credential.value : '' } : {}) }
          this.ensure(allowed, signal)
          await this.install(entry, account, allowed, signal)
          this.ensure(allowed, signal)
          const installed = this.options.getSettings().accounts[account.id]
          await this.options.commit({ accounts: { ...this.options.getSettings().accounts, [account.id]: { ...account, ...(installed?.credentialStore === 'file' ? { credentialStore: 'file' as const } : {}) } } })
        } else if (payload.kind === 'agent' && payload.credential?.format === 'codex-file') {
          const current = await this.codex(this.options.trees.codex)
          if (current !== null && this.defaultIdentity(current) === this.defaultIdentity(payload.credential.value)) await this.install(entry, { id: 'default', cli: 'codex', kind: 'login', label: payload.label, home: this.options.trees.codex, apiKey: '' }, allowed, signal)
        }
      }
      this.ensure(allowed, signal)
      await this.save(state, file, namespace, signal)
      this.options.changed()
    })
  }
}
