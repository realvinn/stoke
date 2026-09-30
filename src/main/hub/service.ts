/*
 * Stoke Hub, the desktop client: signing in, the vault and its Recovery Kit,
 * joining a device (by approval with the six digits, or by the Kit), sync of
 * settings, API keys, SSH hosts and — one at a time, by choice — SSH private
 * keys, the device list, and signing out.
 *
 * Everything it decides is in `src/shared/hub/` (the contract, and `client.ts`
 * for the sync rules); everything it seals is `crypto.ts`. This file is the
 * order things happen in, and the guards around them:
 *
 * - One queue (`serial`) for every step that talks to the hub or writes the
 *   two hub files, so a sync pass never interleaves with a revoke or a join.
 *   A user action claims its slot before its first await and refuses a second
 *   press (gotcha 20); a sync asked for while one runs is folded into it.
 * - A chain is trusted only as verified HERE (`verifyChain`) and compared with
 *   what this device pinned (`compareToPinned`): a rollback or a fork is an
 *   alarm and nothing is written until the owner acts (spec §4.3). A device is
 *   active only by id AND key (gotcha 140). A vault key is taken only when it
 *   matches the chain's commitment for its epoch (spec §4.2).
 * - Settings arrive through `deps.commit` (index.ts `commitSettings`, the path
 *   an import takes), so a synced theme repaints and synced bookmarks reach the
 *   browser; the hub's own `hub` block is written only here (gotcha 57).
 * - Nothing secret crosses to the renderer: the view carries names, counts,
 *   times and the pairing code. The one exception is the Recovery Kit, shown
 *   once when it is made — the owner has to be able to read it.
 *
 * No electron import (the Kit's save and print dialogs are injected), so
 * `verify:hub-client` runs two of these against a real hub on 127.0.0.1. No
 * TypeScript parameter properties (strip-only mode rejects them).
 */
import { join } from 'node:path'
import type { Settings, SshHost } from '../../shared/types.ts'
import { normalizeEmail, passwordProblem, parseInvite } from '../../shared/hub/auth.ts'
import {
  chainLinkText,
  chainSigningText,
  compareToPinned,
  DEVICE_CAPS,
  deviceRecordProblem,
  verifyChain,
  wrapsRequiredAfter,
  type ChainEntry,
  type ChainVerdict,
  type DeviceRecord
} from '../../shared/hub/chain.ts'
import {
  DEFAULT_HUB_URL,
  emptyHubState,
  emptyHubView,
  incomingFrom,
  localValues,
  MAX_CONFLICT_NOTES,
  MAX_DEVICE_NAME_CHARS,
  nextSyncDelay,
  planSync,
  recordCounts,
  SYNC_DEBOUNCE_MS,
  valueDigest,
  type HubAlarm,
  type HubLocalKeyView,
  type HubResult,
  type HubLocalState,
  type HubPairView,
  type HubView,
  type LocalValue,
  type PlannedUpload,
  type RemoteItem,
  type SyncedRecord,
  type SyncScope
} from '../../shared/hub/client.ts'
import { idFromBytes, isId, isRecord } from '../../shared/hub/codec.ts'
import { hubSocketUrl, hubUrlVerdict } from '../../shared/hub/edge.ts'
import { decideConflict, conflictNote, itemLabel, nextEditedAt, parseItemPath, versionRegression, type ItemEnvelope, type StoredItem } from '../../shared/hub/items.ts'
import { formatRecoverySecret, isPairRecord, parseRecoverySecret, type PairRecord } from '../../shared/hub/pairing.ts'
import {
  HUB_LIMITS,
  HUB_PROTOCOL,
  parsePresenceServerFrame,
  reconnectDelayMs,
  type RecoveryWrap,
  type VaultWrap
} from '../../shared/hub/protocol.ts'
import { keyFingerprint } from '../../shared/hub/relay.ts'
import { applySyncedSettings, sshKeyPayloadProblem, type SshKeyPayload, type SyncableHost } from '../../shared/hub/settings.ts'
import type { SecretBackend } from '../secrets.ts'
import type { ExecRun } from '../sshEnroll.ts'
import {
  generateDeviceKeys,
  itemKeys,
  newVaultKey,
  nodeChainCrypto,
  openItem,
  openRecoveryWrap,
  pairCode,
  pairCommit,
  randomB64u,
  randomU8,
  recoveryKeys,
  sealItem,
  sealRecoveryWrap,
  sha256B64u,
  signRequest,
  signText,
  unwrapVaultKey,
  vaultKeyCommit,
  vaultKeyMatches,
  wrapVaultKey,
  type ItemKeys
} from './crypto.ts'
import { HubFiles, type HubDevice } from './files.ts'
import { hubRequest, HubRequestError } from './http.ts'
import { defaultSshPaths, identityFilesFor, installReceivedKey, listKeyPairs, readKeyForShare, type SshPaths } from './sshKeys.ts'

type ChainOk = Extract<ChainVerdict, { ok: true }>
export type { HubResult }

/** The presence socket, as much of `ws`'s WebSocket as this uses. */
export interface PresenceSocket {
  send(text: string): void
  close(code?: number, reason?: string): void
  on(event: 'open', fn: () => void): unknown
  on(event: 'message', fn: (data: unknown) => void): unknown
  on(event: 'close', fn: (code: number) => void): unknown
  on(event: 'error', fn: (err: Error) => void): unknown
}

export interface HubServiceDeps {
  userData: string
  backend: SecretBackend
  platform: string
  hostname: string
  appVersion: string
  getSettings(): Settings
  /** Write settings the way an import does (index.ts `commitSettings`). */
  commit(patch: Partial<Settings>): Promise<Settings> | Settings
  /** `hydrateSettings`, for comparing like with like (gotcha 116). */
  hydrate(raw: unknown): Settings
  onSettingsChanged(fn: (s: Settings) => void): () => void
  emit(view: HubView): void
  now?: () => number
  fetch?: typeof fetch
  ssh?: Partial<SshPaths>
  exec?: ExecRun
  /** Open presence; null = no presence (polling only). Default: `ws`. */
  presence?: ((url: string, headers: Record<string, string>) => Promise<PresenceSocket>) | null
  /** The Kit's file and print, in main (dialogs). */
  saveKit?(name: string, text: string): Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; message: string }>
  printKit?(text: string): Promise<void>
  /** Poll interval for a pairing in progress. */
  pairPollMs?: number
  log?(message: string, err?: unknown): void
}

/** A Kit made and shown, waiting to be confirmed before the chain entry that uses it is posted. */
interface PendingKit {
  secret: Uint8Array
  kit: string
  /** 1-based group the owner must type back. */
  group: number
  purpose: 'genesis' | 'revoke' | 'rotate'
  target: string | null
  made: number
}

interface Joining {
  pair: string
  nonce: string
  record: DeviceRecord
  state: PairRecord['state']
  code: string | null
  approver: { id: string; sign: string; box: string; label: string } | null
  expiresAt: number
  message: string | null
}

interface Approving {
  nonce: string
  reveal: { device: DeviceRecord; nonce: string } | null
  code: string | null
}

class StaleEpoch extends Error {}
class Stop extends Error {}

const PAIR_POLL_MS = 1500
const REVOKED_SENTENCE =
  'This device was removed from your hub account. What it synced stays on this computer; sign out to forget its hub keys, then sign in again to join as a new device.'
const LOGOUT_TIMEOUT_MS = 5000

function cleanLabel(text: string, fallback: string): string {
  const t = (text ?? '').replace(/[\r\n\t]+/g, ' ').trim()
  const use = t || fallback.trim() || 'Stoke'
  return [...use].slice(0, 64).join('')
}

function platformOf(p: string): string {
  return /^[a-z0-9]{1,24}$/.test(p) ? p : 'other'
}

function messageOf(err: unknown): string {
  if (err instanceof HubRequestError) return err.message
  if (err instanceof Error) return err.message
  return String(err)
}

export class HubService {
  private readonly deps: HubServiceDeps
  private readonly files: HubFiles
  private readonly now: () => number
  private readonly ssh: SshPaths
  private dev: HubDevice | null
  private state: HubLocalState | null
  private verdict: ChainOk | null
  private role: 'owner' | 'member' | null
  private loginState: 'new-account' | 'pending' | 'active' | null
  private revoked: string | null
  private busyLabel: string | null
  private claimed: boolean
  private queue: Promise<unknown>
  private syncQueued: boolean
  private failures: number
  private lastError: HubView['error']
  private syncTimer: ReturnType<typeof setTimeout> | null
  private stampTimer: ReturnType<typeof setTimeout> | null
  private pairTimer: ReturnType<typeof setTimeout> | null
  private applying: boolean
  private pendingKit: PendingKit | null
  private joining: Joining | null
  private approving: Map<string, Approving>
  private pairs: PairRecord[]
  private online: string[]
  private socket: PresenceSocket | null
  private socketAttempts: number
  private socketTimer: ReturnType<typeof setTimeout> | null
  private socketPing: ReturnType<typeof setInterval> | null
  private socketOpening: boolean
  private revokeReport: HubView['revokeReport']
  private vkCache: Map<number, Uint8Array>
  private offSettings: (() => void) | null
  private started: boolean

  constructor(deps: HubServiceDeps) {
    this.deps = deps
    this.files = new HubFiles(deps.userData, deps.backend, deps.platform)
    this.now = deps.now ?? Date.now
    this.ssh = { ...defaultSshPaths(), ...(deps.ssh ?? {}) }
    this.dev = null
    this.state = null
    this.verdict = null
    this.role = null
    this.loginState = null
    this.revoked = null
    this.busyLabel = null
    this.claimed = false
    this.queue = Promise.resolve()
    this.syncQueued = false
    this.failures = 0
    this.lastError = null
    this.syncTimer = null
    this.stampTimer = null
    this.pairTimer = null
    this.applying = false
    this.pendingKit = null
    this.joining = null
    this.approving = new Map()
    this.pairs = []
    this.online = []
    this.socket = null
    this.socketAttempts = 0
    this.socketTimer = null
    this.socketPing = null
    this.socketOpening = false
    this.revokeReport = null
    this.vkCache = new Map()
    this.offSettings = null
    this.started = false
  }

  /* ======================================================== plumbing */

  private log(message: string, err?: unknown): void {
    this.deps.log?.(message, err)
  }

  /** Every step that talks to the hub or writes the hub files, one at a time. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  /**
   * A user action: claimed before its first await, refused while another is
   * running (gotcha 20), serialised with sync, and always emitting its result.
   */
  private async action<T extends object>(label: string, fn: () => Promise<HubResult<T>>): Promise<HubResult<T>> {
    if (this.claimed) return { ok: false, message: 'Stoke is still working on the last step. Try again in a moment.' }
    this.claimed = true
    this.busyLabel = label
    this.emit()
    try {
      return await this.serial(async () => {
        try {
          return await fn()
        } catch (err) {
          if (err instanceof Stop) return { ok: false, message: err.message }
          this.log(`hub: ${label} failed`, err)
          return { ok: false, message: messageOf(err) }
        }
      })
    } finally {
      this.claimed = false
      this.busyLabel = null
      this.emit()
    }
  }

  private settings(): Settings {
    return this.deps.getSettings()
  }

  private base(): string {
    const v = hubUrlVerdict(this.settings().hub.url)
    if (!v.ok) throw new Stop(v.problem)
    return v.base
  }

  private async commitHub(patch: Partial<Settings['hub']>): Promise<void> {
    const s = this.settings()
    await this.deps.commit({ hub: { ...s.hub, ...patch } })
  }

  private signedIn(): boolean {
    return !!this.dev?.token && !!this.dev.account
  }

  private me(): HubDevice {
    if (!this.dev) throw new Stop('This device has no hub keys yet. Sign in first.')
    return this.dev
  }

  private account(): string {
    const a = this.dev?.account
    if (!a) throw new Stop('Sign in first.')
    return a
  }

  private st(): HubLocalState {
    if (!this.state) throw new Stop('Sign in first.')
    return this.state
  }

  private saveState(): void {
    if (this.state) {
      try {
        this.files.saveState(this.state)
      } catch (err) {
        this.log('hub: could not write hub-state.json', err)
      }
    }
  }

  private saveDevice(): void {
    if (this.dev) this.files.saveDevice(this.dev)
  }

  /**
   * A signed request as this device. `session` (the default) carries the
   * bearer; `proof` signs with no bearer (an active device's sign-in, spec
   * §3.3); `none` is unsigned. A refused session is handled here, once, for
   * every caller.
   */
  private async req(
    method: 'GET' | 'POST',
    pathFromV1: string,
    body?: unknown,
    opts: { as?: 'session' | 'proof' | 'none'; base?: string } = {}
  ): Promise<Record<string, unknown>> {
    const dev = this.me()
    const as = opts.as ?? 'session'
    const auth = as === 'proof' ? { device: dev.id, signPriv: dev.keys.signPriv } : as === 'session' && dev.token ? { device: dev.id, signPriv: dev.keys.signPriv, token: dev.token } : null
    try {
      return await hubRequest({ fetch: this.deps.fetch ?? fetch, now: this.now }, opts.base ?? this.base(), method, pathFromV1, body, auth)
    } catch (err) {
      if (err instanceof HubRequestError && err.code === 'unauthorized' && as === 'session' && this.dev?.token) {
        this.dev.token = ''
        this.saveDevice()
        this.stopPresence()
        throw new Stop(err.message || 'Your hub session ended. Sign in again.')
      }
      throw err
    }
  }

  /* ======================================================== lifecycle */

  /** Boot: open the device and state files; resume background sync if this device is in. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.offSettings = this.deps.onSettingsChanged(() => this.onSettingsChanged())
    await this.serial(async () => {
      this.dev = await this.files.loadDevice()
      if (this.dev?.account) {
        this.state = await this.files.loadState(this.dev.account)
        if (this.state.chain.length) {
          const v = verifyChain(this.state.chain, nodeChainCrypto, { account: this.dev.account })
          this.verdict = v.ok ? v : null
        }
      }
    })
    this.emit()
    if (this.signedIn()) this.syncSoon(2000)
  }

  /** Quit: timers and the socket go; the files are already written. */
  stop(): void {
    this.offSettings?.()
    this.offSettings = null
    for (const t of [this.syncTimer, this.stampTimer, this.pairTimer, this.socketTimer]) if (t) clearTimeout(t)
    this.syncTimer = this.stampTimer = this.pairTimer = this.socketTimer = null
    this.stopPresence()
    this.saveState()
  }

  /* ======================================================== the view */

  private isActiveIn(v: ChainOk | null): boolean {
    const d = this.dev
    return !!v && !!d && v.active.some((a) => a.id === d.id && a.sign === d.keys.signPub)
  }

  private phase(): HubView['phase'] {
    const s = this.settings()
    if (!s.hub.url) return 'off'
    if (this.revoked) return 'revoked'
    if (!this.signedIn()) return 'signed-out'
    if (this.isActiveIn(this.verdict)) return 'active'
    if (!this.verdict && (this.loginState === 'new-account' || (this.state && this.state.chain.length === 0 && this.loginState !== 'pending'))) return 'new-account'
    return 'locked'
  }

  private deviceName(id: string, fallback: string): string {
    return this.state?.prefs.deviceNames?.names[id] ?? fallback
  }

  view(): HubView {
    const v = emptyHubView()
    const s = this.settings()
    v.phase = this.phase()
    v.url = s.hub.url
    const verdict = s.hub.url ? hubUrlVerdict(s.hub.url) : null
    v.urlWarning = verdict?.ok ? verdict.warning : null
    v.email = this.dev?.email || s.hub.email
    v.role = this.role
    v.device = this.dev ? { id: this.dev.id, label: this.deviceName(this.dev.id, this.dev.label), platform: this.dev.platform } : null
    v.keyStore = this.dev || this.state ? this.files.keyStore() : { protected: true, why: '' }
    v.busy = this.busyLabel
    v.lastSyncAt = this.state?.lastSyncAt ?? null
    v.error = this.revoked ? { message: this.revoked, at: this.now(), retryAt: null } : this.lastError
    const scope = this.scope()
    v.scope = { ...scope, keysDevice: s.hub.sync.keys }
    v.accountKeys = this.state?.prefs.syncKeys?.on ?? null
    v.counts = this.state ? recordCounts(this.state.records) : v.counts
    v.epoch = this.verdict?.epoch ?? 0
    const me = this.dev?.id
    v.devices = (this.verdict?.active ?? []).map((d) => ({
      id: d.id,
      label: this.deviceName(d.id, d.label),
      platform: d.platform,
      addedAt: d.addedAt,
      me: d.id === me,
      online: d.id === me ? true : this.online.includes(d.id),
      fingerprint: keyFingerprint(d.sign)
    }))
    v.pairs = this.pairs
      .filter((p) => p.state === 'waiting' || p.state === 'nonce' || p.state === 'revealed')
      .map(
        (p): HubPairView => ({
          pair: p.pair,
          state: p.state,
          device: p.device,
          createdAt: p.createdAt,
          expiresAt: p.expiresAt,
          code: this.approving.get(p.pair)?.code ?? null,
          mine: this.approving.has(p.pair)
        })
      )
    v.join = this.joining
      ? {
          pair: this.joining.pair,
          state: this.joining.state,
          code: this.joining.code,
          expiresAt: this.joining.expiresAt,
          approver: this.joining.approver ? this.deviceName(this.joining.approver.id, this.joining.approver.label) : null,
          message: this.joining.message
        }
      : null
    v.notes = this.state?.notes.map((n) => ({ ...n, otherDevice: this.deviceName(n.otherDevice, this.labelFromChain(n.otherDevice)) })) ?? []
    const st = this.state
    if (st) {
      const hosts = s.hosts as SyncableHost[]
      const aliasesFor = (keyId: string): string[] =>
        hosts.filter((h) => h.syncId && (st.keyRefs[h.syncId] ?? []).includes(keyId)).map((h) => h.label || h.alias)
      v.sshKeys = [
        ...Object.entries(st.shared).map(([keyId, k]) => ({
          keyId,
          name: k.name,
          fingerprint: k.fingerprint,
          comment: k.comment,
          passphrase: k.passphrase,
          from: this.dev ? this.deviceName(this.dev.id, this.dev.label) : '',
          mine: true,
          installedAs: k.name,
          hosts: aliasesFor(keyId)
        })),
        ...Object.entries(st.offered).map(([keyId, k]) => ({
          keyId,
          name: k.name,
          fingerprint: k.fingerprint,
          comment: k.comment,
          passphrase: k.passphrase,
          from: this.deviceName(k.from, this.labelFromChain(k.from)),
          mine: false,
          installedAs: st.received[keyId]?.installedAs ?? null,
          hosts: aliasesFor(keyId)
        }))
      ]
    }
    v.alarm = this.state?.alarm ?? null
    v.kitPending = this.pendingKit !== null
    v.revokeReport = this.revokeReport
    return v
  }

  private labelFromChain(id: string): string {
    for (const e of this.state?.chain ?? []) if (e.device?.id === id) return e.device.label
    return 'another device'
  }

  private emit(): void {
    try {
      this.deps.emit(this.view())
    } catch (err) {
      this.log('hub: could not publish the view', err)
    }
  }

  /* ======================================================== address */

  /** Where the hub is. Refused while signed in: a session belongs to one hub. */
  async setUrl(text: string): Promise<HubResult<{ url: string; warning: string | null }>> {
    const t = typeof text === 'string' ? text.trim() : ''
    if (this.signedIn() && t !== this.settings().hub.url) {
      return { ok: false, message: 'Sign out of this hub before pointing Stoke at another.' }
    }
    if (t === '') {
      await this.commitHub({ url: '' })
      this.emit()
      return { ok: true, url: '', warning: null }
    }
    const v = hubUrlVerdict(t)
    if (!v.ok) return { ok: false, message: v.problem }
    await this.commitHub({ url: v.base })
    this.emit()
    return { ok: true, url: v.base, warning: v.warning }
  }

  /** Ask an address whether it is a Stoke hub, without signing in. */
  async checkUrl(text: string): Promise<HubResult<{ base: string; version: string; needsBootstrap: boolean; warning: string | null }>> {
    const v = hubUrlVerdict(typeof text === 'string' && text.trim() ? text : DEFAULT_HUB_URL)
    if (!v.ok) return { ok: false, message: v.problem }
    try {
      const res = await hubRequest({ fetch: this.deps.fetch ?? fetch, now: this.now }, v.base, 'GET', '/v1/health', undefined, null)
      if (res.server !== 'stoke-hub') return { ok: false, message: 'That address answered, but not as a Stoke hub.' }
      if (res.protocol !== HUB_PROTOCOL) return { ok: false, message: `That hub speaks protocol ${String(res.protocol)}; this Stoke speaks ${HUB_PROTOCOL}. Update the older one.` }
      return { ok: true, base: v.base, version: String(res.version ?? ''), needsBootstrap: res.needsBootstrap === true, warning: v.warning }
    } catch (err) {
      return { ok: false, message: messageOf(err) }
    }
  }

  /* ======================================================== sign in */

  /** This device's keys: made once, on the first sign-in, and kept until sign-out. */
  private async ensureDevice(label: string): Promise<HubDevice> {
    if (this.dev) {
      if (label && !this.isActiveIn(this.verdict)) this.dev.label = cleanLabel(label, this.deps.hostname)
      return this.dev
    }
    const loaded = await this.files.loadDevice()
    if (loaded) {
      this.dev = loaded
      if (label && !loaded.account) loaded.label = cleanLabel(label, this.deps.hostname)
      return loaded
    }
    const keys = generateDeviceKeys()
    this.dev = {
      id: idFromBytes('device', randomU8(10)),
      label: cleanLabel(label, this.deps.hostname),
      platform: platformOf(this.deps.platform),
      keys,
      token: '',
      account: '',
      email: '',
      tokenExpiresAt: 0,
      createdAt: this.now()
    }
    return this.dev
  }

  private record(): DeviceRecord {
    const d = this.me()
    return { id: d.id, label: d.label, platform: d.platform, sign: d.keys.signPub, box: d.keys.boxPub, caps: [...DEVICE_CAPS], addedAt: this.now() }
  }

  /**
   * Sign in (or, with an invite, create the account first). The password goes
   * to the hub and nowhere else: it opens no key (spec §3.2). A device the
   * chain already lists proves itself by signature, so a stranger locking the
   * email cannot lock it out (spec §3.3).
   */
  signIn(input: { email: string; password: string; label?: string; invite?: string }): Promise<HubResult<{ state: string }>> {
    return this.action<{ state: string }>(input.invite ? 'Creating your account…' : 'Signing in…', async () => {
      const email = normalizeEmail(input.email)
      if (!email) return { ok: false, message: 'Enter the email address of your hub account.' }
      if (typeof input.password !== 'string' || !input.password) return { ok: false, message: 'Enter your password.' }
      const base = this.base()
      if (input.invite !== undefined) {
        const invite = parseInvite(input.invite)
        if (!invite) return { ok: false, message: 'That is not an invite. It looks like INV-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX.' }
        const weak = passwordProblem(input.password)
        if (weak) return { ok: false, message: weak }
        await hubRequest({ fetch: this.deps.fetch ?? fetch, now: this.now }, base, 'POST', '/v1/auth/signup', { invite, email, password: input.password }, null)
      }
      const dev = await this.ensureDevice(input.label ?? this.settings().hub.deviceLabel)
      const proof = this.isActiveIn(this.verdict) && this.dev?.account !== ''
      const draft = { id: dev.id, label: dev.label, platform: dev.platform, sign: dev.keys.signPub, box: dev.keys.boxPub, caps: [...DEVICE_CAPS] }
      let res: Record<string, unknown>
      try {
        res = await this.req('POST', '/v1/auth/login', { email, password: input.password, device: draft }, { as: proof ? 'proof' : 'none', base })
      } catch (err) {
        if (err instanceof HubRequestError && err.code === 'forbidden' && this.state?.pinned) {
          this.revoked = REVOKED_SENTENCE
          this.emit()
        }
        throw err
      }
      const token = typeof res.token === 'string' ? res.token : ''
      const account = typeof res.accountId === 'string' ? res.accountId : ''
      if (!token || !isId('account', account)) return { ok: false, message: 'The hub answered the sign-in without a session.' }
      if (dev.account && dev.account !== account) {
        // Another account on this hub: its records and keys are not this one's.
        this.state = null
        this.verdict = null
        this.vkCache.clear()
      }
      dev.token = token
      dev.account = account
      dev.email = email
      dev.tokenExpiresAt = typeof res.expiresAt === 'number' ? res.expiresAt : 0
      this.saveDevice()
      this.loginState = res.state === 'active' || res.state === 'pending' || res.state === 'new-account' ? res.state : null
      this.revoked = null
      this.state ??= await this.files.loadState(account)
      if (this.state.account !== account) this.state = emptyHubState(account)
      this.saveState()
      await this.commitHub({ email, deviceId: dev.id, deviceLabel: dev.label, token: '' })
      try {
        const acct = await this.req('GET', '/v1/account')
        this.role = acct.role === 'owner' || acct.role === 'member' ? acct.role : null
      } catch {
        this.role = null
      }
      if (this.loginState !== 'new-account') {
        try {
          await this.refreshChain()
        } catch (err) {
          this.lastError = { message: messageOf(err), at: this.now(), retryAt: null }
        }
      }
      if (this.isActiveIn(this.verdict)) this.syncSoon(50)
      return { ok: true, state: this.phase() }
    })
  }

  /**
   * Sign out: tell the hub (best effort), then forget everything hub on this
   * computer — device keys, vault keys, session, records. Settings and keys
   * that already arrived stay: they are this computer's settings now.
   */
  signOut(): Promise<HubResult> {
    return this.action('Signing out…', async () => {
      if (this.dev?.token) {
        try {
          await Promise.race([this.req('POST', '/v1/auth/logout', {}), new Promise((r) => setTimeout(r, LOGOUT_TIMEOUT_MS))])
        } catch {
          /* the session dies with the device file either way */
        }
      }
      this.stopPresence()
      if (this.syncTimer) clearTimeout(this.syncTimer)
      if (this.pairTimer) clearTimeout(this.pairTimer)
      this.syncTimer = this.pairTimer = null
      await this.files.wipe()
      this.dev = null
      this.state = null
      this.verdict = null
      this.role = null
      this.loginState = null
      this.revoked = null
      this.pendingKit = null
      this.joining = null
      this.approving.clear()
      this.pairs = []
      this.online = []
      this.lastError = null
      this.failures = 0
      this.revokeReport = null
      this.vkCache.clear()
      await this.commitHub({ email: '', deviceId: '', token: '' })
      return { ok: true }
    })
  }

  /* ======================================================== the chain */

  /**
   * Fetch, verify and pin the device list. Null: the account has no chain yet.
   * A list that does not verify, is shorter than the pinned one, or differs at
   * a pinned entry is an alarm, and nothing after it runs.
   */
  private async refreshChain(): Promise<ChainOk | null> {
    const st = this.st()
    const res = await this.req('GET', '/v1/chain')
    const entries = Array.isArray(res.entries) ? res.entries : []
    if (entries.length === 0) {
      if (st.pinned) this.raise('rollback', 'The hub no longer has this account’s device list, which this device has seen. That is what a restored or tampered hub looks like, so nothing was synced.')
      this.verdict = null
      return null
    }
    const v = verifyChain(entries, nodeChainCrypto, { account: this.account() })
    if (!v.ok) this.raise('chain', `The device list the hub served does not check out (entry ${v.at}: ${v.reason}). Nothing was synced.`)
    const ok = v as ChainOk
    const cmp = compareToPinned(st.pinned, ok.links)
    if (cmp === 'rollback') this.raise('rollback', `The hub’s device list is shorter than the one this device last saw (${ok.seq + 1} entries, not ${(st.pinned?.seq ?? 0) + 1}). A restored backup looks like this; so does a hub going back in time. Nothing was synced.`)
    if (cmp === 'fork') this.raise('fork', 'The hub’s device list differs from the one this device last saw, at an entry both have. Nothing was synced.')
    st.chain = entries as ChainEntry[]
    st.pinned = { seq: ok.seq, head: ok.head }
    this.verdict = ok
    if (st.alarm?.kind !== 'version' && st.alarm?.kind !== 'key') st.alarm = null
    return ok
  }

  private raise(kind: HubAlarm['kind'], message: string): never {
    const st = this.st()
    st.alarm = { kind, message, at: this.now() }
    this.saveState()
    throw new Stop(message)
  }

  /**
   * The vault key of `epoch`, only ever as the verified chain vouches for it
   * (spec §4.2): from this device's sealed copy, else its wrap on the hub. A
   * key the commitment does not match is an alarm, never used.
   */
  private async vaultKey(v: ChainOk, epoch: number): Promise<Uint8Array | null> {
    const cached = this.vkCache.get(epoch)
    const commit = v.vkCommits[epoch]
    if (!commit) return null
    const f = { account: this.account(), epoch }
    if (cached && vaultKeyMatches(cached, f, commit)) return cached
    const st = this.st()
    const sealed = st.vaultKeys[String(epoch)]
    if (sealed) {
      const vk = this.files.openVault(f.account, epoch, sealed)
      if (vk && vaultKeyMatches(vk, f, commit)) {
        this.vkCache.set(epoch, vk)
        return vk
      }
    }
    let wrap: VaultWrap
    try {
      const res = await this.req('GET', `/v1/vault/wrap?epoch=${epoch}`)
      wrap = res.wrap as VaultWrap
    } catch (err) {
      if (err instanceof HubRequestError && err.code === 'not-found') return null
      throw err
    }
    const vk = unwrapVaultKey(wrap, { ...f, device: this.me().id, boxPriv: this.me().keys.boxPriv, commit })
    if (!vk) this.raise('key', `The hub served a vault key for epoch ${epoch} that the device list does not vouch for. It was refused; nothing was synced.`)
    this.storeVaultKey(epoch, vk as Uint8Array)
    return vk
  }

  private storeVaultKey(epoch: number, vk: Uint8Array): void {
    const st = this.st()
    st.vaultKeys[String(epoch)] = this.files.sealVault(this.account(), epoch, vk)
    this.vkCache.set(epoch, vk)
    this.saveState()
  }

  private keysCache = new Map<number, ItemKeys>()

  private async keysFor(v: ChainOk, epoch: number): Promise<ItemKeys | null> {
    const hit = this.keysCache.get(epoch)
    const vk = await this.vaultKey(v, epoch)
    if (!vk) return null
    if (hit && this.vkCache.get(epoch) === vk) return hit
    const k = itemKeys(vk, this.account(), epoch)
    this.keysCache.set(epoch, k)
    return k
  }

  private entry(v: ChainOk | null, prevEntry: ChainEntry | null, fields: Omit<ChainEntry, 'v' | 'account' | 'seq' | 'prev' | 'ts' | 'sig'>, signPriv: string): ChainEntry {
    const prev = prevEntry ?? (v ? this.st().chain[v.seq] : null)
    const bare: Omit<ChainEntry, 'sig'> = {
      v: 1,
      account: this.account(),
      seq: prev ? prev.seq + 1 : 0,
      prev: prev ? sha256B64u(chainLinkText(prev)) : '',
      ts: this.now(),
      ...fields
    }
    return { ...bare, sig: signText(signPriv, chainSigningText(bare)) }
  }

  /* ======================================================== the vault and its Kit */

  private makeKit(purpose: PendingKit['purpose'], target: string | null): { kit: string; group: number } {
    const secret = randomU8(16)
    const kit = formatRecoverySecret(secret)
    // Groups after `RK1-`: six of four characters and a last of three. Ask for a full one.
    const group = 1 + (randomU8(1)[0] % 6)
    this.pendingKit = { secret, kit, group, purpose, target, made: this.now() }
    return { kit, group }
  }

  /**
   * Start the vault: make the Recovery Kit and show it. Nothing is posted until
   * the owner types a group of it back (`confirmKit`) — a vault whose Kit was
   * never written down is a vault with no way back in.
   */
  createVault(): Promise<HubResult<{ kit: string; group: number }>> {
    return this.action<{ kit: string; group: number }>('Making your Recovery Kit…', async () => {
      if (this.phase() !== 'new-account') return { ok: false, message: 'This account already has a vault. Join it from another device, or with its Recovery Kit.' }
      const p = this.files.keyStore()
      if (!p.protected) return { ok: false, message: `${p.why} Stoke will not keep a vault key where it would be readable, so this computer cannot hold the vault.` }
      return { ok: true, ...this.makeKit('genesis', null) }
    })
  }

  /** The Kit again (it is still only in memory), for the owner who closed the panel before confirming. */
  pendingKitText(): HubResult<{ kit: string; group: number; purpose: string }> {
    const k = this.pendingKit
    return k ? { ok: true, kit: k.kit, group: k.group, purpose: k.purpose } : { ok: false, message: 'There is no Recovery Kit waiting.' }
  }

  cancelKit(): HubResult {
    this.pendingKit = null
    this.emit()
    return { ok: true }
  }

  private kitFileText(kit: string): string {
    const s = this.settings()
    return [
      'Stoke Hub Recovery Kit',
      '',
      `Account: ${this.dev?.email ?? ''}`,
      `Hub: ${s.hub.url}`,
      `Made: ${new Date(this.now()).toISOString()}`,
      '',
      `    ${kit}`,
      '',
      'This code opens your Stoke vault — your synced settings, API keys and any SSH keys you',
      'shared — if you ever lose every device signed in to it. Keep it offline: printed, or in a',
      'password manager. Anyone who has it AND your hub password can read your vault.',
      'Lose every device and this code, and the vault is gone: the hub cannot open it either.',
      ''
    ].join('\n')
  }

  async saveKit(): Promise<HubResult<{ path: string }>> {
    const k = this.pendingKit
    if (!k) return { ok: false, message: 'There is no Recovery Kit waiting to be saved.' }
    if (!this.deps.saveKit) return { ok: false, message: 'Saving a file is not available here.' }
    const res = await this.deps.saveKit('Stoke Recovery Kit.txt', this.kitFileText(k.kit))
    return res.ok ? { ok: true, path: res.path } : { ok: false, message: res.canceled ? '' : res.message }
  }

  async printKit(): Promise<HubResult> {
    const k = this.pendingKit
    if (!k) return { ok: false, message: 'There is no Recovery Kit waiting to be printed.' }
    if (!this.deps.printKit) return { ok: false, message: 'Printing is not available here.' }
    await this.deps.printKit(this.kitFileText(k.kit))
    return { ok: true }
  }

  /** The owner typed group N of the Kit back: now the entry that uses it is posted. */
  confirmKit(typed: string): Promise<HubResult> {
    return this.action('Sealing your vault…', async () => {
      const k = this.pendingKit
      if (!k) return { ok: false, message: 'There is no Recovery Kit waiting.' }
      const groups = k.kit.split('-').slice(1)
      const want = groups[k.group - 1] ?? ''
      const got = (typed ?? '').toUpperCase().replace(/[\s-]+/g, '').replace(/O/g, '0').replace(/[IL]/g, '1')
      if (got !== want) return { ok: false, message: `That is not group ${k.group} of your Recovery Kit. Check the copy you saved.` }
      if (k.purpose === 'genesis') await this.postGenesis(k)
      else await this.postRotation(k)
      this.pendingKit = null
      return { ok: true }
    })
  }

  private async postGenesis(k: PendingKit): Promise<void> {
    const account = this.account()
    const me = this.me()
    const vk = newVaultKey()
    const r = recoveryKeys(k.secret, account)
    const g0 = this.entry(null, null, { kind: 'genesis', epoch: 1, signer: me.id, device: this.record(), recovery: r.signPub, vk: vaultKeyCommit(vk, { account, epoch: 1 }) }, me.keys.signPriv)
    const recovery = sealRecoveryWrap(vk, r.wrapKey, { account, epoch: 1 })
    await this.req('POST', '/v1/chain', {
      entries: [g0],
      wraps: { epoch: 1, devices: [{ device: me.id, wrap: wrapVaultKey(vk, { account, epoch: 1, device: me.id, boxPub: me.keys.boxPub }) }], recovery }
    })
    this.loginState = 'active'
    const v = await this.refreshChain()
    if (!v || !this.isActiveIn(v)) throw new Stop('The vault was created, but the hub’s device list does not show this device in it.')
    this.storeVaultKey(1, vk)
    this.st().recoveryWraps['1'] = recovery
    this.saveState()
    this.syncSoon(50)
  }

  /* ======================================================== joining */

  /** Ask to join from this (locked) device: an active device approves, both show six digits (spec §4.4). */
  joinStart(): Promise<HubResult> {
    return this.action('Asking your other devices…', async () => {
      if (this.phase() !== 'locked') return { ok: false, message: 'This device is not waiting to join a vault.' }
      const p = this.files.keyStore()
      if (!p.protected) return { ok: false, message: `${p.why} Stoke will not keep a vault key where it would be readable, so this computer cannot join the vault.` }
      const account = this.account()
      const record = this.record()
      const nonce = randomB64u(32)
      const commit = pairCommit({ account, device: record, nonce })
      const res = await this.req('POST', '/v1/pair', { commit, device: { id: record.id, label: record.label, platform: record.platform } })
      const pair = typeof res.pair === 'string' ? res.pair : ''
      if (!isId('pair', pair)) return { ok: false, message: 'The hub did not open a request.' }
      this.joining = { pair, nonce, record, state: 'waiting', code: null, approver: null, expiresAt: Number(res.expiresAt) || this.now() + 10 * 60_000, message: null }
      this.pollPairs()
      return { ok: true }
    })
  }

  joinCancel(): Promise<HubResult> {
    return this.action('Cancelling…', async () => {
      const j = this.joining
      this.joining = null
      if (j && (j.state === 'waiting' || j.state === 'nonce' || j.state === 'revealed')) {
        try {
          await this.req('POST', `/v1/pair/${j.pair}/refuse`, {})
        } catch {
          /* it expires on its own */
        }
      }
      return { ok: true }
    })
  }

  /** One look at this device's own request: reveal once the approver answered; take the key once approved. */
  private async joinTick(): Promise<void> {
    const j = this.joining
    if (!j) return
    const rec = (await this.req('GET', `/v1/pair/${j.pair}`)) as unknown
    if (!isPairRecord(rec)) return
    j.state = rec.state
    j.expiresAt = rec.expiresAt
    if (rec.state === 'nonce' && rec.approver && rec.nonceE) {
      // The approver must be a device the verified chain lists, keys and all (gotcha 140).
      const v = await this.refreshChain()
      const a = rec.approver
      if (!v || !v.active.some((d) => d.id === a.id && d.sign === a.sign && d.box === a.box)) {
        j.message = 'The request was answered by a device this account’s list does not hold. It was refused.'
        await this.req('POST', `/v1/pair/${j.pair}/refuse`, {}).catch(() => undefined)
        j.state = 'refused'
        return
      }
      await this.req('POST', `/v1/pair/${j.pair}/reveal`, { device: j.record, nonce: j.nonce })
      j.approver = { id: a.id, sign: a.sign, box: a.box, label: a.label }
      j.code = pairCode({ account: this.account(), pair: j.pair, device: j.record, approver: a, nonceN: j.nonce, nonceE: rec.nonceE })
      j.state = 'revealed'
    } else if (rec.state === 'revealed' && !j.code && rec.approver && rec.nonceE) {
      j.approver = { id: rec.approver.id, sign: rec.approver.sign, box: rec.approver.box, label: rec.approver.label }
      j.code = pairCode({ account: this.account(), pair: j.pair, device: j.record, approver: rec.approver, nonceN: j.nonce, nonceE: rec.nonceE })
    } else if (rec.state === 'approved') {
      await this.finishJoin(j)
    } else if (rec.state === 'refused') {
      j.message = 'The request was refused on the other device (or the codes did not match there).'
    } else if (rec.state === 'expired') {
      j.message = 'The request expired before it was approved. Ask again.'
    }
  }

  /**
   * The approver's `add` landed: check it names exactly this device's keys and
   * was signed by the device whose keys entered the code, pin the list, and
   * take the vault key it vouches for (spec §4.4 step 5).
   */
  private async finishJoin(j: Joining): Promise<void> {
    const v = await this.refreshChain()
    const me = this.me()
    const add = v ? this.st().chain.find((e) => e.kind === 'add' && e.device?.id === me.id) : null
    if (!v || !add || add.device?.sign !== me.keys.signPub || add.device.box !== me.keys.boxPub || (j.approver && add.signer !== j.approver.id)) {
      j.message = 'The hub says the request was approved, but the device list does not add this device with its own keys. Nothing was taken.'
      j.state = 'refused'
      return
    }
    const vk = await this.vaultKey(v, v.epoch)
    if (!vk) {
      j.message = 'This device is in the list, but the hub has no vault key for it yet. Try again in a moment.'
      return
    }
    this.joining = null
    this.loginState = 'active'
    this.syncSoon(50)
  }

  /**
   * Join with the Recovery Kit, from a signed-in device the list does not hold
   * (spec §4.5): open the Kit's wrap of the current epoch — against the
   * chain's commitment — and add this device, signed by the Kit.
   */
  recover(kitText: string): Promise<HubResult> {
    return this.action('Opening the vault with your Recovery Kit…', async () => {
      if (this.phase() !== 'locked') return { ok: false, message: 'This device is not waiting to join a vault.' }
      const p = this.files.keyStore()
      if (!p.protected) return { ok: false, message: `${p.why} Stoke will not keep a vault key where it would be readable.` }
      const parsed = parseRecoverySecret(kitText)
      if (!parsed.ok) return { ok: false, message: parsed.message }
      const account = this.account()
      const v = await this.refreshChain()
      if (!v) return { ok: false, message: 'This account has no vault yet.' }
      const r = recoveryKeys(parsed.secret, account)
      if (r.signPub !== v.recovery) return { ok: false, message: 'That Recovery Kit is not this account’s current one (it may have been replaced by a newer Kit).' }
      const res = await this.req('GET', `/v1/vault/recovery?epoch=${v.epoch}`)
      const vk = openRecoveryWrap(res.wrap as RecoveryWrap, r.wrapKey, { account, epoch: v.epoch, commit: v.vkCommits[v.epoch] })
      if (!vk) return { ok: false, message: 'The Kit is right, but the vault key the hub holds for it does not match the device list. Nothing was taken.' }
      const me = this.me()
      const add = this.entry(v, null, { kind: 'add', epoch: v.epoch, signer: 'recovery', device: this.record() }, r.signPriv)
      await this.req('POST', '/v1/chain', {
        entries: [add],
        wraps: { epoch: v.epoch, devices: [{ device: me.id, wrap: wrapVaultKey(vk, { account, epoch: v.epoch, device: me.id, boxPub: me.keys.boxPub }) }] }
      })
      const after = await this.refreshChain()
      if (!after || !this.isActiveIn(after)) return { ok: false, message: 'The hub took the entry, but the device list does not show this device.' }
      this.storeVaultKey(v.epoch, vk)
      this.st().recoveryWraps[String(v.epoch)] = res.wrap as RecoveryWrap
      this.loginState = 'active'
      this.syncSoon(50)
      return { ok: true }
    })
  }

  /* ======================================================== approving */

  private async refreshPairs(): Promise<void> {
    if (!this.isActiveIn(this.verdict)) {
      this.pairs = []
      return
    }
    const res = await this.req('GET', '/v1/pair')
    this.pairs = Array.isArray(res.pairs) ? (res.pairs as unknown[]).filter(isPairRecord) : []
    for (const id of [...this.approving.keys()]) if (!this.pairs.some((p) => p.pair === id)) this.approving.delete(id)
  }

  /** Answer a request with this device's nonce; the code appears once the new device reveals. */
  approveStart(pair: string): Promise<HubResult> {
    return this.action('Answering the request…', async () => {
      if (!isId('pair', pair)) return { ok: false, message: 'No such request.' }
      if (!this.isActiveIn(this.verdict)) return { ok: false, message: 'Only a device in the vault can approve another.' }
      const nonce = randomB64u(32)
      await this.req('POST', `/v1/pair/${pair}/nonce`, { nonce })
      this.approving.set(pair, { nonce, reveal: null, code: null })
      await this.refreshPairs()
      this.pollPairs()
      return { ok: true }
    })
  }

  /** Check the reveal against the commitment and work out the code both screens show. */
  private async approveTick(pair: string, a: Approving): Promise<void> {
    if (a.code) return
    const rec = (await this.req('GET', `/v1/pair/${pair}`)) as unknown
    if (!isPairRecord(rec) || rec.state !== 'revealed' || !rec.reveal) return
    const account = this.account()
    const reveal = rec.reveal
    const bad =
      deviceRecordProblem(reveal.device) ??
      (reveal.device.id !== rec.device.id ? 'the reveal names another device' : null) ??
      (pairCommit({ account, device: reveal.device, nonce: reveal.nonce }) !== rec.commit ? 'the reveal does not match what the device first committed to' : null) ??
      (!reveal.device.caps.includes('vault') ? 'the device does not ask for the vault' : null)
    if (bad) {
      await this.req('POST', `/v1/pair/${pair}/refuse`, {}).catch(() => undefined)
      this.approving.delete(pair)
      this.lastError = { message: `A request to join was refused: ${bad}.`, at: this.now(), retryAt: null }
      return
    }
    const me = this.me()
    a.reveal = reveal
    a.code = pairCode({ account, pair, device: reveal.device, approver: { id: me.id, sign: me.keys.signPub, box: me.keys.boxPub }, nonceN: reveal.nonce, nonceE: a.nonce })
  }

  /** The codes matched: add the device and hand it the vault key (one request, spec §4.4 step 4). */
  approveConfirm(pair: string): Promise<HubResult> {
    return this.action('Adding the device…', async () => {
      const a = this.approving.get(pair)
      if (!a?.reveal || !a.code) return { ok: false, message: 'That request has no code to confirm yet.' }
      const v = await this.refreshChain()
      if (!v || !this.isActiveIn(v)) return { ok: false, message: 'This device is not in the vault.' }
      const vk = await this.vaultKey(v, v.epoch)
      if (!vk) return { ok: false, message: 'This device does not hold the vault key.' }
      const me = this.me()
      const account = this.account()
      const d = a.reveal.device
      const add = this.entry(v, null, { kind: 'add', epoch: v.epoch, signer: me.id, device: d }, me.keys.signPriv)
      await this.req('POST', '/v1/chain', { entries: [add], wraps: { epoch: v.epoch, devices: [{ device: d.id, wrap: wrapVaultKey(vk, { account, epoch: v.epoch, device: d.id, boxPub: d.box }) }] } })
      this.approving.delete(pair)
      await this.refreshChain()
      await this.refreshPairs()
      return { ok: true }
    })
  }

  refusePair(pair: string): Promise<HubResult> {
    return this.action('Refusing…', async () => {
      if (!isId('pair', pair)) return { ok: false, message: 'No such request.' }
      await this.req('POST', `/v1/pair/${pair}/refuse`, {})
      this.approving.delete(pair)
      await this.refreshPairs()
      return { ok: true }
    })
  }

  /** While a join or an approval is under way, look again every second and a half. */
  private pollPairs(): void {
    if (this.pairTimer) return
    const busy = (): boolean =>
      (this.joining !== null && ['waiting', 'nonce', 'revealed'].includes(this.joining.state)) ||
      [...this.approving.values()].some((a) => !a.code) ||
      this.pairs.some((p) => p.state !== 'approved' && this.approving.has(p.pair))
    const tick = (): void => {
      this.pairTimer = null
      if (!this.signedIn() || !busy()) return
      void this.serial(async () => {
        try {
          if (this.joining) await this.joinTick()
          for (const [pair, a] of [...this.approving]) await this.approveTick(pair, a)
          if (this.approving.size) await this.refreshPairs()
        } catch (err) {
          this.log('hub: pairing poll failed', err)
        }
      }).finally(() => {
        this.emit()
        if (busy()) this.pairTimer = setTimeout(tick, this.deps.pairPollMs ?? PAIR_POLL_MS)
      })
    }
    this.pairTimer = setTimeout(tick, this.deps.pairPollMs ?? PAIR_POLL_MS)
  }

  /* ======================================================== devices */

  /** A name every device shows for `id` (a chain label is fixed at join; this is the vault's). */
  renameDevice(id: string, name: string): Promise<HubResult> {
    return this.action('Renaming…', async () => {
      if (!this.verdict?.active.some((d) => d.id === id)) return { ok: false, message: 'No such device in the vault.' }
      const st = this.st()
      const t = (name ?? '').replace(/[\r\n\t]+/g, ' ').trim()
      const names = { ...(st.prefs.deviceNames?.names ?? {}) }
      if (t) names[id] = [...t].slice(0, MAX_DEVICE_NAME_CHARS).join('')
      else delete names[id]
      st.prefs.deviceNames = { names }
      this.saveState()
      await this.pass()
      return { ok: true }
    })
  }

  /**
   * Remove a device: a `revoke` entry, a new vault key for everyone left, and
   * every item re-sealed under it (spec §4.6). The hub insists the Kit's copy
   * of the new key comes with it, and only the Kit can make that copy — so the
   * owner types the Kit, or makes a new one (`newKit`, shown and confirmed
   * first like the first one). A Kit kept on the devices would let a removed
   * device holding the password open every later key.
   */
  revokeDevice(target: string, how: { kit: string } | { newKit: true }): Promise<HubResult<{ kit?: string; group?: number }>> {
    return this.action<{ kit?: string; group?: number }>('Removing the device…', async () => {
      const v = await this.refreshChain()
      if (!v || !this.isActiveIn(v)) return { ok: false, message: 'Only a device in the vault can remove another.' }
      if (target === this.me().id) return { ok: false, message: 'Remove this device from another one, or sign out here.' }
      if (!v.active.some((d) => d.id === target)) return { ok: false, message: 'That device is not in the vault.' }
      if ('newKit' in how) return { ok: true, ...this.makeKit('revoke', target) }
      const parsed = parseRecoverySecret(how.kit)
      if (!parsed.ok) return { ok: false, message: parsed.message }
      if (recoveryKeys(parsed.secret, this.account()).signPub !== v.recovery) return { ok: false, message: 'That Recovery Kit is not this account’s current one.' }
      await this.rotate(v, { secret: parsed.secret, replaceKit: false, target })
      return { ok: true }
    })
  }

  /** A new Kit, and a new vault key with it (after a Kit was typed somewhere, or lost). */
  newKit(): Promise<HubResult<{ kit: string; group: number }>> {
    return this.action<{ kit: string; group: number }>('Making a new Recovery Kit…', async () => {
      if (!this.isActiveIn(this.verdict)) return { ok: false, message: 'Only a device in the vault can replace its Recovery Kit.' }
      return { ok: true, ...this.makeKit('rotate', null) }
    })
  }

  private async postRotation(k: PendingKit): Promise<void> {
    const v = await this.refreshChain()
    if (!v || !this.isActiveIn(v)) throw new Stop('This device is not in the vault any more.')
    await this.rotate(v, { secret: k.secret, replaceKit: true, target: k.purpose === 'revoke' ? k.target : null })
  }

  /**
   * Revoke (when `target`) and/or rotate, in ONE append: the last entry opens
   * the epoch everything is re-sealed under, wrapped to every device left and
   * to the Kit — the old Kit's wrap key, or a new Kit's with its public key in
   * a `rotate` entry.
   */
  private async rotate(v: ChainOk, f: { secret: Uint8Array; replaceKit: boolean; target: string | null }): Promise<void> {
    const me = this.me()
    const account = this.account()
    const oldEpoch = v.epoch
    const oldKeys = await this.keysFor(v, oldEpoch)
    if (!oldKeys) throw new Stop('This device does not hold the current vault key.')
    const kit = recoveryKeys(f.secret, account)
    const entries: ChainEntry[] = []
    let epoch = oldEpoch
    let vk = newVaultKey()
    let prev: ChainEntry = this.st().chain[v.seq]
    if (f.target) {
      epoch++
      const e = this.entry(v, prev, { kind: 'revoke', epoch, signer: me.id, target: f.target, vk: vaultKeyCommit(vk, { account, epoch }) }, me.keys.signPriv)
      entries.push(e)
      prev = e
    }
    if (f.replaceKit || !f.target) {
      if (f.target) vk = newVaultKey()
      epoch++
      const e = this.entry(v, prev, { kind: 'rotate', epoch, signer: me.id, ...(f.replaceKit ? { recovery: kit.signPub } : {}), vk: vaultKeyCommit(vk, { account, epoch }) }, me.keys.signPriv)
      entries.push(e)
    }
    const after = verifyChain([...this.st().chain, ...entries], nodeChainCrypto, { account })
    if (!after.ok) throw new Stop(`That change would not verify (${after.reason}).`)
    const devices = wrapsRequiredAfter(after).map((id) => {
      const d = after.active.find((x) => x.id === id) as DeviceRecord
      return { device: id, wrap: wrapVaultKey(vk, { account, epoch, device: id, boxPub: d.box }) }
    })
    const recovery = sealRecoveryWrap(vk, kit.wrapKey, { account, epoch })
    const heldBefore = this.heldReport()
    await this.req('POST', '/v1/chain', { entries, wraps: { epoch, devices, recovery } })
    const now = await this.refreshChain()
    if (!now || now.epoch !== epoch) throw new Stop('The hub took the change, but its device list did not move to the new key.')
    this.storeVaultKey(epoch, vk)
    this.st().recoveryWraps[String(epoch)] = recovery
    this.saveState()
    await this.reseal(now, oldKeys)
    if (f.target) {
      const label = this.deviceName(f.target, this.labelFromChain(f.target))
      this.revokeReport = { device: label, ...heldBefore }
    }
  }

  /** What any device in the vault could have read: every synced API key's name and every shared SSH key's. */
  private heldReport(): { keys: string[]; sshKeys: string[] } {
    const st = this.st()
    const keys: string[] = []
    for (const [path, r] of Object.entries(st.records)) {
      const p = parseItemPath(path)
      if (!r.deleted && p?.tier === 't2') keys.push(itemLabel(path))
    }
    const sshKeys = [...Object.values(st.shared).map((k) => k.name), ...Object.values(st.offered).map((k) => k.name)]
    return { keys: keys.sort(), sshKeys: [...new Set(sshKeys)].sort() }
  }

  /**
   * Every item the hub holds, re-sealed under the new epoch's keys, then the
   * old epochs pruned (spec §4.6). Values, edit times and tombstones travel
   * as they were; the author becomes this device, which signs the puts.
   */
  private async reseal(v: ChainOk, oldKeys: ItemKeys): Promise<void> {
    const keys = await this.keysFor(v, v.epoch)
    if (!keys) throw new Stop('The new vault key is not available.')
    const latest = new Map<string, { item: RemoteItem; env: ItemEnvelope }>()
    let since = 0
    for (;;) {
      const page = await this.req('GET', `/v1/items?since=${since}`)
      for (const s of (Array.isArray(page.items) ? page.items : []) as StoredItem[]) {
        const env = s.envelope
        const k = env.epoch === oldKeys.epoch ? oldKeys : await this.keysFor(v, env.epoch)
        if (!k) continue
        const opened = openItem(k, env)
        if (!opened.ok) continue
        const cur = latest.get(opened.item.path)
        if (cur && (cur.env.epoch > env.epoch || (cur.env.epoch === env.epoch && cur.env.version >= env.version))) continue
        latest.set(opened.item.path, { item: this.remoteOf(env, opened.item), env })
      }
      since = Number(page.next) || since
      if (page.more !== true) break
    }
    const puts: { path: string; item: RemoteItem; baseVersion: number; envelope: ItemEnvelope }[] = []
    for (const [path, { item, env }] of latest) {
      if (env.epoch === v.epoch) continue
      const envelope = sealItem(keys, { version: 1, author: this.me().id, path, editedAt: item.editedAt, deleted: item.deleted, value: item.value })
      puts.push({ path, item, baseVersion: 0, envelope })
    }
    const st = this.st()
    for (let i = 0; i < puts.length; i += HUB_LIMITS.putsPerRequest) {
      const batch = puts.slice(i, i + HUB_LIMITS.putsPerRequest)
      const res = await this.req('POST', '/v1/items', { puts: batch.map((p) => ({ baseVersion: p.baseVersion, envelope: p.envelope })) })
      const results = Array.isArray(res.results) ? res.results : []
      batch.forEach((p, idx) => {
        const r = results[idx] as { ok?: boolean; version?: number } | undefined
        if (!r?.ok) return
        const old = st.records[p.path]
        st.records[p.path] = {
          id: p.envelope.id,
          epoch: v.epoch,
          version: r.version ?? 1,
          hash: p.item.hash,
          localHash: old?.localHash ?? p.item.hash,
          editedAt: p.item.editedAt,
          author: this.me().id,
          deleted: p.item.deleted
        }
      })
    }
    await this.req('POST', '/v1/items/prune', { epochBelow: v.epoch })
    this.saveState()
  }

  /* ======================================================== sync */

  private scope(): SyncScope {
    const h = this.settings().hub.sync
    return { settings: h.settings, hosts: h.hosts, keys: h.keys && this.state?.prefs.syncKeys?.on === true }
  }

  /** This device's switches (T1, T3, T2-on-this-device). */
  setScope(patch: Partial<Settings['hub']['sync']>): Promise<HubResult> {
    return this.action('Saving…', async () => {
      const s = this.settings().hub.sync
      const next = {
        settings: typeof patch.settings === 'boolean' ? patch.settings : s.settings,
        hosts: typeof patch.hosts === 'boolean' ? patch.hosts : s.hosts,
        keys: typeof patch.keys === 'boolean' ? patch.keys : s.keys
      }
      await this.commitHub({ sync: next })
      if (this.isActiveIn(this.verdict)) await this.pass()
      return { ok: true }
    })
  }

  /** The account's switch for API keys (spec §5.1: the owner ticks it once, every device follows). */
  setAccountKeys(on: boolean): Promise<HubResult> {
    return this.action(on ? 'Turning on key sync…' : 'Turning off key sync…', async () => {
      if (!this.isActiveIn(this.verdict)) return { ok: false, message: 'Join the vault first.' }
      this.st().prefs.syncKeys = { on: on === true }
      this.saveState()
      await this.pass()
      return { ok: true }
    })
  }

  dismissNotes(): HubResult {
    if (this.state) {
      this.state.notes = []
      this.saveState()
    }
    this.emit()
    return { ok: true }
  }

  /**
   * After an alarm the owner has checked (a hub restored from a backup): take
   * the hub's list and items as the truth from here. What this device holds
   * is compared afresh; where both have a value the hub's wins.
   */
  trustHub(): Promise<HubResult> {
    return this.action('Starting over from the hub’s copy…', async () => {
      const st = this.st()
      st.alarm = null
      st.pinned = null
      st.chain = []
      st.records = {}
      st.seen = {}
      st.cursor = 0
      this.saveState()
      await this.pass()
      return { ok: true }
    })
  }

  syncNow(): Promise<HubResult> {
    return this.action('Syncing…', async () => {
      await this.pass()
      if (this.lastError) return { ok: false, message: this.lastError.message }
      return { ok: true }
    })
  }

  /** A background pass soon; folded into one if several are asked for. */
  private syncSoon(ms: number): void {
    if (this.syncTimer) clearTimeout(this.syncTimer)
    this.syncTimer = setTimeout(() => {
      this.syncTimer = null
      if (this.syncQueued) return
      this.syncQueued = true
      void this.serial(async () => {
        this.syncQueued = false
        await this.pass()
      })
    }, ms)
  }

  private onSettingsChanged(): void {
    if (this.applying || !this.isActiveIn(this.verdict)) return
    if (this.stampTimer) clearTimeout(this.stampTimer)
    this.stampTimer = setTimeout(() => {
      this.stampTimer = null
      if (!this.state) return
      this.stampLocal()
      this.saveState()
      this.syncSoon(SYNC_DEBOUNCE_MS)
    }, 1000)
  }

  private currentLocal(): Map<string, LocalValue> {
    const st = this.st()
    return localValues({ settings: this.deps.hydrate(this.settings()), scope: this.scope(), prefs: st.prefs, keyRefs: st.keyRefs })
  }

  /** Note WHEN each local change was first seen: a conflict is decided by these times (spec §5.2). */
  private stampLocal(): void {
    const st = this.st()
    const local = this.currentLocal()
    const tombstones = Object.entries(st.records).filter(([path, r]) => !r.deleted && !local.has(path) && /^t[23]\//.test(path))
    const entries: [string, LocalValue][] = [...local, ...tombstones.map(([path]): [string, LocalValue] => [path, { deleted: true, value: null }])]
    for (const [path, lv] of entries) {
      const hash = valueDigest(sha256B64u, lv)
      const rec = st.records[path]
      if (rec && rec.localHash === hash) {
        delete st.stamps[path]
        continue
      }
      if (st.stamps[path]?.hash === hash) continue
      const at = nextEditedAt(this.now(), st.lastEditedAt)
      st.lastEditedAt = at
      st.stamps[path] = { editedAt: at, hash }
    }
  }

  private remoteOf(env: ItemEnvelope, item: { path: string; editedAt: number; deleted: boolean; value: unknown }): RemoteItem {
    return {
      path: item.path,
      id: env.id,
      epoch: env.epoch,
      version: env.version,
      editedAt: item.editedAt,
      author: env.author,
      deleted: item.deleted,
      value: item.value,
      hash: valueDigest(sha256B64u, { deleted: item.deleted, value: item.value })
    }
  }

  /** What the hub holds for a path this pass did not see change: exactly the last agreement. */
  private synth(path: string, r: SyncedRecord): RemoteItem {
    return { path, id: r.id, epoch: r.epoch, version: r.version, editedAt: r.editedAt, author: r.author, deleted: r.deleted, value: undefined, hash: r.hash }
  }

  /**
   * The change feed since the cursor, opened. T4 items are listed (metadata
   * only) and recorded here, never planned: a key is installed by a press.
   */
  private async pull(v: ChainOk): Promise<{ delta: Map<string, RemoteItem>; next: number }> {
    const st = this.st()
    const delta = new Map<string, RemoteItem>()
    let since = st.cursor
    for (;;) {
      const page = await this.req('GET', `/v1/items?since=${since}`)
      for (const s of (Array.isArray(page.items) ? page.items : []) as StoredItem[]) {
        const env = s.envelope
        if (!isRecord(env) || typeof env.id !== 'string') continue
        if (versionRegression(st.seen[env.id], env.version)) {
          this.raise('version', `The hub served an older version of an item than this device has already seen (${env.version} after ${st.seen[env.id]}). A restored or tampered hub looks like this. Nothing was synced.`)
        }
        st.seen[env.id] = Math.max(st.seen[env.id] ?? 0, env.version)
        const keys = await this.keysFor(v, env.epoch)
        if (!keys) continue
        const opened = openItem(keys, env)
        if (!opened.ok) {
          this.log(`hub: an item did not open (${opened.reason})`)
          continue
        }
        const item = this.remoteOf(env, opened.item)
        const p = parseItemPath(item.path)
        if (p?.tier === 't4') {
          this.noteSshKey(p.keyId, item)
          continue
        }
        const cur = delta.get(item.path)
        if (cur && (cur.epoch > item.epoch || (cur.epoch === item.epoch && cur.version >= item.version))) continue
        delta.set(item.path, item)
      }
      since = Number(page.next) || since
      if (page.more !== true) break
    }
    return { delta, next: since }
  }

  private noteSshKey(keyId: string, item: RemoteItem): void {
    const st = this.st()
    const old = st.records[item.path]
    if (old && (old.epoch > item.epoch || (old.epoch === item.epoch && old.version > item.version))) return
    st.records[item.path] = { id: item.id, epoch: item.epoch, version: item.version, hash: item.hash, localHash: item.hash, editedAt: item.editedAt, author: item.author, deleted: item.deleted }
    if (item.deleted || sshKeyPayloadProblem(item.value)) {
      delete st.offered[keyId]
      return
    }
    if (item.author === this.me().id && st.shared[keyId]) return
    const k = item.value as SshKeyPayload
    st.offered[keyId] = { name: k.name, fingerprint: k.fingerprint, comment: k.comment, passphrase: k.passphrase, from: item.author, at: item.editedAt }
  }

  /**
   * One pass (spec §5): verify the list, take any new vault key, read the feed,
   * apply what the hub changed, give new hosts their sync ids, and upload what
   * this device changed. Failures back off quietly; the panel shows the last.
   */
  private async pass(depth = 0): Promise<void> {
    if (!this.signedIn() || !this.state) return
    const label = this.busyLabel
    if (!label) {
      this.busyLabel = 'Syncing…'
      this.emit()
    }
    try {
      if (this.state.alarm) throw new Stop(this.state.alarm.message)
      const v = await this.refreshChain()
      if (!v) {
        this.loginState = 'new-account'
        return
      }
      if (!this.isActiveIn(v)) {
        if (this.dev && v.revoked.includes(this.dev.id)) {
          this.revoked = REVOKED_SENTENCE
          this.stopPresence()
        }
        return
      }
      this.loginState = 'active'
      const keys = await this.keysFor(v, v.epoch)
      if (!keys) throw new Stop('This device is in the vault, but the hub has no vault key for it at the current epoch.')
      await this.refreshPairs().catch((err) => this.log('hub: could not list join requests', err))
      const st = this.state
      const { delta, next } = await this.pull(v)
      let scope = this.scope()
      const plan = (): ReturnType<typeof planSync> => {
        const remote = new Map(delta)
        for (const [path, r] of Object.entries(st.records)) if (!remote.has(path)) remote.set(path, this.synth(path, r))
        this.stampLocal()
        const res = planSync({
          local: this.currentLocal(),
          remote,
          records: st.records,
          scope,
          me: this.me().id,
          now: this.now(),
          lastEditedAt: st.lastEditedAt,
          digest: sha256B64u,
          stamps: st.stamps,
          label: (path) => itemLabel(path, { host: (id) => this.hostName(id) })
        })
        st.lastEditedAt = res.lastEditedAt
        return res
      }
      const first = plan()
      for (const r of first.adopt) this.adopt(r)
      await this.apply(first.apply, scope)
      this.addNotes(first.notes)
      /*
       * The account's key switch can arrive in the same pass as the keys it
       * lets in — a device joining a vault that already syncs keys. Plan again
       * under the widened scope, or those keys wait a whole interval.
       */
      if (this.scope().keys !== scope.keys) {
        scope = this.scope()
        const widened = plan()
        for (const r of widened.adopt) this.adopt(r)
        await this.apply(widened.apply, scope)
        this.addNotes(widened.notes)
      }
      st.cursor = next
      await this.mintHostIds(scope)
      const second = plan()
      for (const r of second.adopt) this.adopt(r)
      await this.upload(second.upload, v, keys)
      st.lastSyncAt = this.now()
      this.failures = 0
      this.lastError = null
      this.startPresence()
    } catch (err) {
      if (err instanceof StaleEpoch && depth < 2) {
        this.vkCache.clear()
        this.keysCache.clear()
        return this.pass(depth + 1)
      }
      this.failures++
      const retryAt = this.now() + nextSyncDelay(this.failures)
      this.lastError = { message: messageOf(err), at: this.now(), retryAt }
      if (!(err instanceof Stop)) this.log('hub: sync failed', err)
    } finally {
      this.saveState()
      if (!label) this.busyLabel = null
      if (depth === 0) {
        if (this.signedIn() && !this.revoked && this.isActiveIn(this.verdict)) this.syncSoon(nextSyncDelay(this.failures))
        this.emit()
      }
    }
  }

  private hostName(syncId: string): string {
    const h = (this.settings().hosts as SyncableHost[]).find((x) => x.syncId === syncId)
    return h ? h.label || h.alias : syncId
  }

  private addNotes(notes: ReturnType<typeof conflictNote>[]): void {
    if (!notes.length) return
    const st = this.st()
    st.notes = [...st.notes, ...notes].slice(-MAX_CONFLICT_NOTES)
  }

  private adopt(r: RemoteItem): void {
    const st = this.st()
    const old = st.records[r.path]
    st.records[r.path] = {
      id: r.id,
      epoch: r.epoch,
      version: r.version,
      hash: r.hash,
      localHash: old && old.hash === r.hash ? old.localHash : r.hash,
      editedAt: r.editedAt,
      author: r.author,
      deleted: r.deleted
    }
    delete st.stamps[r.path]
  }

  /** Fold items into Settings (and the account prefs), then record what THIS device now holds for each. */
  private async apply(items: RemoteItem[], scope: SyncScope): Promise<void> {
    if (!items.length) return
    const st = this.st()
    const { incoming, prefs, keyRefs } = incomingFrom(items)
    if (prefs.syncKeys) st.prefs.syncKeys = prefs.syncKeys
    if (prefs.deviceNames) st.prefs.deviceNames = prefs.deviceNames
    Object.assign(st.keyRefs, keyRefs)
    if (incoming.settings || incoming.hosts || incoming.secrets) {
      this.applying = true
      try {
        // Built from the settings as they are NOW, with no await before the commit.
        const res = applySyncedSettings(this.settings(), incoming)
        await this.deps.commit(res.raw as unknown as Partial<Settings>)
        for (const s of res.skipped) this.log(`hub: not applied ${s.key}: ${s.why}`)
      } finally {
        this.applying = false
      }
    }
    const after = localValues({ settings: this.deps.hydrate(this.settings()), scope, prefs: st.prefs, keyRefs: st.keyRefs })
    for (const r of items) {
      const lv = after.get(r.path) ?? { deleted: true, value: null }
      st.records[r.path] = {
        id: r.id,
        epoch: r.epoch,
        version: r.version,
        hash: r.hash,
        localHash: valueDigest(sha256B64u, lv),
        editedAt: r.editedAt,
        author: r.author,
        deleted: r.deleted
      }
      delete st.stamps[r.path]
    }
  }

  /** Hosts this device has that the hub has never seen get a sync id (gotcha 139): after apply, so a known one is adopted instead. */
  private async mintHostIds(scope: SyncScope): Promise<void> {
    if (!scope.hosts) return
    const hosts = this.settings().hosts as SyncableHost[]
    if (hosts.every((h) => isId('host', h.syncId))) return
    const next = hosts.map((h) => (isId('host', h.syncId) ? h : { ...h, syncId: idFromBytes('host', randomU8(10)) }))
    this.applying = true
    try {
      await this.deps.commit({ hosts: next as SshHost[] })
    } finally {
      this.applying = false
    }
  }

  /**
   * Put what this device changed. A conflict is decided on the spot by the
   * same rule (`decideConflict`) and noted; a stale epoch means a rotation
   * happened since: the pass starts over with the new key.
   */
  private async upload(ups: PlannedUpload[], v: ChainOk, keys: ItemKeys, depth = 0): Promise<void> {
    if (!ups.length) return
    const st = this.st()
    const me = this.me().id
    const retry: PlannedUpload[] = []
    const theirs: RemoteItem[] = []
    let stale = false
    for (let i = 0; i < ups.length; i += HUB_LIMITS.putsPerRequest) {
      const batch = ups.slice(i, i + HUB_LIMITS.putsPerRequest).map((u) => {
        const baseVersion = u.over && u.over.epoch === v.epoch ? u.over.version : 0
        const envelope = sealItem(keys, { version: baseVersion + 1, author: me, path: u.path, editedAt: u.editedAt, deleted: u.local.deleted, value: u.local.deleted ? null : u.local.value })
        return { u, baseVersion, envelope }
      })
      const res = await this.req('POST', '/v1/items', { puts: batch.map((b) => ({ baseVersion: b.baseVersion, envelope: b.envelope })) })
      const results = Array.isArray(res.results) ? res.results : []
      for (let j = 0; j < batch.length; j++) {
        const { u, envelope } = batch[j]
        const r = results[j] as Record<string, unknown> | undefined
        if (r?.ok === true) {
          st.records[u.path] = { id: envelope.id, epoch: v.epoch, version: Number(r.version) || envelope.version, hash: u.hash, localHash: u.hash, editedAt: u.editedAt, author: me, deleted: u.local.deleted }
          st.seen[envelope.id] = Math.max(st.seen[envelope.id] ?? 0, envelope.version)
          delete st.stamps[u.path]
        } else if (r?.error === 'conflict' && isRecord(r.current)) {
          const cur = r.current as unknown as StoredItem
          const k = cur.envelope.epoch === v.epoch ? keys : await this.keysFor(v, cur.envelope.epoch)
          const opened = k ? openItem(k, cur.envelope) : null
          if (!opened?.ok) continue
          const other = this.remoteOf(cur.envelope, opened.item)
          if (other.hash === u.hash) {
            this.adopt(other)
            continue
          }
          const mine = { editedAt: u.editedAt, author: me }
          const their = { editedAt: other.editedAt, author: other.author }
          this.addNotes([conflictNote({ path: u.path, label: itemLabel(u.path, { host: (id) => this.hostName(id) }), mine, theirs: their, now: this.now() })])
          if (decideConflict(mine, their) === 'mine') retry.push({ ...u, over: other })
          else theirs.push(other)
        } else if (r?.error === 'stale-epoch') {
          stale = true
        } else if (r) {
          this.log(`hub: the hub refused ${u.path}: ${String(r.reason ?? r.error)}`)
        }
      }
    }
    if (theirs.length) await this.apply(theirs, this.scope())
    if (retry.length && depth < 3) await this.upload(retry, v, keys, depth + 1)
    if (stale) throw new StaleEpoch('stale epoch')
  }

  /* ======================================================== SSH keys */

  /** The key pairs in this computer's `~/.ssh` the picker can offer. Names and fingerprints only. */
  async localKeys(): Promise<HubLocalKeyView[]> {
    const pairs = await listKeyPairs(this.ssh.dir)
    const shared = this.state?.shared ?? {}
    return pairs.map((p) => ({
      name: p.name,
      type: p.type,
      comment: p.comment,
      fingerprint: p.fingerprint,
      shared: Object.entries(shared).find(([, s]) => s.fingerprint === p.fingerprint)?.[0] ?? null
    }))
  }

  /**
   * Share one key: its private file is read now, for the first time, sealed
   * into the vault as it is (a passphrase stays on it), and the hosts whose
   * `ssh -G` offers it are marked as using it.
   */
  shareKey(name: string): Promise<HubResult<{ keyId: string }>> {
    return this.action<{ keyId: string }>('Sharing the key…', async () => {
      const v = this.verdict
      if (!v || !this.isActiveIn(v)) return { ok: false, message: 'Join the vault first.' }
      const payload = await readKeyForShare(this.ssh.dir, name)
      if ('error' in payload) return { ok: false, message: payload.error }
      const st = this.st()
      const already = Object.entries(st.shared).find(([, s]) => s.fingerprint === payload.fingerprint)
      if (already) return { ok: false, message: `${name} is already shared.` }
      const keyId = idFromBytes('sshKey', randomU8(10))
      await this.mintHostIds(this.scope())
      const keyPath = join(this.ssh.dir, name)
      for (const h of this.settings().hosts as SyncableHost[]) {
        if (!isId('host', h.syncId)) continue
        const files = await identityFilesFor(h.alias.trim(), this.ssh, this.deps.exec)
        if (files?.includes(keyPath)) st.keyRefs[h.syncId] = [...new Set([...(st.keyRefs[h.syncId] ?? []), keyId])].sort()
      }
      const keys = await this.keysFor(v, v.epoch)
      if (!keys) return { ok: false, message: 'This device does not hold the vault key.' }
      const path = `t4/ssh-key/${keyId}`
      const editedAt = nextEditedAt(this.now(), st.lastEditedAt)
      st.lastEditedAt = editedAt
      const hash = valueDigest(sha256B64u, { deleted: false, value: payload })
      await this.upload([{ path, local: { deleted: false, value: payload }, hash, editedAt, over: null }], v, keys)
      if (!st.records[path]) return { ok: false, message: 'The hub did not take the key.' }
      st.shared[keyId] = { name: payload.name, fingerprint: payload.fingerprint, comment: payload.comment, passphrase: payload.passphrase, path: keyPath, at: this.now() }
      this.saveState()
      await this.pass()
      return { ok: true, keyId }
    })
  }

  /**
   * Stop sharing: a tombstone, so no device can fetch it again. Devices that
   * installed it keep their copy — Stoke never deletes a key file — which is
   * why the panel says to take a shared key off its hosts when it matters.
   */
  unshareKey(keyId: string): Promise<HubResult> {
    return this.action('Stopping sharing…', async () => {
      const v = this.verdict
      if (!v || !this.isActiveIn(v)) return { ok: false, message: 'Join the vault first.' }
      const st = this.st()
      const path = `t4/ssh-key/${keyId}`
      const rec = st.records[path]
      if (!isId('sshKey', keyId) || !rec) return { ok: false, message: 'That key is not shared.' }
      const keys = await this.keysFor(v, v.epoch)
      if (!keys) return { ok: false, message: 'This device does not hold the vault key.' }
      const editedAt = nextEditedAt(this.now(), st.lastEditedAt)
      st.lastEditedAt = editedAt
      const tomb = { deleted: true, value: null }
      await this.upload([{ path, local: tomb, hash: valueDigest(sha256B64u, tomb), editedAt, over: this.synth(path, rec) }], v, keys)
      delete st.shared[keyId]
      delete st.offered[keyId]
      for (const h of Object.keys(st.keyRefs)) st.keyRefs[h] = st.keyRefs[h].filter((k) => k !== keyId)
      this.saveState()
      await this.pass()
      return { ok: true }
    })
  }

  /**
   * Install a key another device shared: fetched from the vault now, written
   * without replacing anything (0600), and offered for the synced hosts that
   * use it. The result line says exactly what happened.
   */
  installKey(keyId: string): Promise<HubResult<{ message: string; name: string | null }>> {
    return this.action<{ message: string; name: string | null }>('Installing the key…', async () => {
      const v = this.verdict
      if (!v || !this.isActiveIn(v)) return { ok: false, message: 'Join the vault first.' }
      const st = this.st()
      const path = `t4/ssh-key/${keyId}`
      const rec = st.records[path]
      const offered = st.offered[keyId]
      if (!isId('sshKey', keyId) || !rec || rec.deleted || !offered) return { ok: false, message: 'That key is not shared any more.' }
      let payload: SshKeyPayload | null = null
      let since = 0
      for (;;) {
        const page = await this.req('GET', `/v1/items?since=${since}`)
        for (const s of (Array.isArray(page.items) ? page.items : []) as StoredItem[]) {
          if (s.envelope.id !== rec.id) continue
          const k = await this.keysFor(v, s.envelope.epoch)
          const opened = k ? openItem(k, s.envelope) : null
          if (opened?.ok && opened.item.path === path && !opened.item.deleted && !sshKeyPayloadProblem(opened.item.value)) payload = opened.item.value as SshKeyPayload
        }
        since = Number(page.next) || since
        if (payload || page.more !== true) break
      }
      if (!payload) return { ok: false, message: 'The vault no longer holds that key.' }
      const from = this.deviceName(offered.from, this.labelFromChain(offered.from))
      const res = await installReceivedKey(this.ssh, keyId, payload, this.settings().hosts as SyncableHost[], st.keyRefs, from, this.deps.exec)
      if (res.name) st.received[keyId] = { installedAs: res.name, at: this.now(), hosts: res.hosts }
      this.saveState()
      return res.name ? { ok: true, message: res.message, name: res.name } : { ok: false, message: res.message }
    })
  }

  /* ======================================================== presence */

  /** One socket while this device is in the vault: hints that something moved, and who is online. */
  private startPresence(): void {
    if (this.socket || this.socketTimer || this.socketOpening || this.deps.presence === null || !this.isActiveIn(this.verdict)) return
    const dev = this.dev
    if (!dev?.token) return
    let url: string
    try {
      url = hubSocketUrl(this.base(), '/v1/ws/presence')
    } catch {
      return
    }
    const headers = signRequest({ method: 'GET', pathFromV1: '/v1/ws/presence', device: dev.id, signPriv: dev.keys.signPriv, token: dev.token, body: '', now: this.now() })
    const open = this.deps.presence ?? (async (u: string, h: Record<string, string>): Promise<PresenceSocket> => {
      const { WebSocket } = await import('ws')
      return new WebSocket(u, { headers: h, maxPayload: HUB_LIMITS.presenceFrameBytes }) as unknown as PresenceSocket
    })
    this.socketOpening = true
    void open(url, headers)
      .then((ws) => {
        this.socketOpening = false
        if (!this.signedIn() || this.revoked) {
          ws.close()
          return
        }
        this.socket = ws
        ws.on('open', () => {
          this.socketAttempts = 0
          ws.send(JSON.stringify({ t: 'hello', protocol: HUB_PROTOCOL, app: this.deps.appVersion }))
          this.socketPing = setInterval(() => {
            try {
              ws.send(JSON.stringify({ t: 'ping' }))
            } catch {
              /* close follows */
            }
          }, HUB_LIMITS.pingMs)
        })
        ws.on('message', (data) => this.onPresence(String(data)))
        ws.on('error', () => undefined)
        ws.on('close', () => {
          if (this.socketPing) clearInterval(this.socketPing)
          this.socketPing = null
          if (this.socket === ws) this.socket = null
          this.online = []
          if (!this.signedIn() || this.revoked) return
          const delay = reconnectDelayMs(this.socketAttempts++, Math.random())
          this.socketTimer = setTimeout(() => {
            this.socketTimer = null
            this.startPresence()
          }, delay)
        })
      })
      .catch((err) => {
        this.socketOpening = false
        this.log('hub: presence did not open', err)
      })
  }

  private stopPresence(): void {
    if (this.socketTimer) clearTimeout(this.socketTimer)
    this.socketTimer = null
    if (this.socketPing) clearInterval(this.socketPing)
    this.socketPing = null
    const ws = this.socket
    this.socket = null
    try {
      ws?.close(1000, 'bye')
    } catch {
      /* already closed */
    }
  }

  private onPresence(text: string): void {
    const f = parsePresenceServerFrame(text)
    if (!f) return
    switch (f.t) {
      case 'welcome':
      case 'presence':
        this.online = f.online
        this.emit()
        break
      case 'items':
      case 'chain':
        this.syncSoon(300)
        break
      case 'pair':
        void this.serial(async () => {
          await this.refreshPairs().catch(() => undefined)
          this.emit()
        })
        this.pollPairs()
        break
      case 'bye':
        if (/removed/.test(f.reason)) {
          this.revoked = REVOKED_SENTENCE
          this.emit()
        }
        break
      default:
        break
    }
  }
}

/** For the suite: a plan's upload count without the network. */
export type { RemoteItem, SyncedRecord }
