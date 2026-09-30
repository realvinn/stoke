/*
 * The two files a signed-in device keeps for Stoke Hub, both in userData,
 * both mode 0600, both T0 (never synced, never exported):
 *
 * - `hub-device.json`: this device's id and label, its Ed25519 and X25519
 *   private keys, the session token, and the key hub-state.json's value
 *   digests are HMACs under (`digestKey`) — each secret sealed by the OS key
 *   store (`safeStorage`, through the same `SecretBackend` secrets.json uses)
 *   with the path-bound prefix `sealedText` puts on every sealed value, so an
 *   item copied onto another slot opens as nothing (spec §4.2).
 * - `hub-state.json`: the verified device chain, its pin and this device's
 *   anchor in it, the item records and cursor, conflict notes, account
 *   preferences, and the vault key of each epoch — sealed the same way. No
 *   value is in it in the clear, and no plain digest of one: records carry
 *   HMACs under `digestKey`, so a short secret cannot be guessed offline from
 *   the file (it is not sealed as a whole).
 *
 * The token lives here and not in Settings (`hub.token` stays ''), because
 * Settings travel to the renderer whole and a session is not something the
 * user typed.
 *
 * A key store `judgeProtection` calls unprotected (Linux `basic_text`, none)
 * may still sign in — the device keys and token are then written unsealed,
 * like secrets.json's own fallback — but may never hold a vault key: `sealVault`
 * refuses, and the service says why (spec §4.2).
 *
 * No electron import: `verify:hub-client` runs this under strip-types with a
 * synthetic userData and a fake backend (gotcha 74). No parameter properties.
 */
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { b64uDecode, b64uEncode, isB64u, isId } from '../../shared/hub/codec.ts'
import { emptyHubState, HUB_DEVICE_FILE, HUB_STATE_FILE, hydrateHubState, type HubLocalState } from '../../shared/hub/client.ts'
import { judgeProtection, sealedText, unsealedValue, type SecretProtection } from '../../shared/secrets.ts'
import { writePrivateFile, type SecretBackend } from '../secrets.ts'
import type { DeviceKeys } from './crypto.ts'

/** What hub-device.json holds once opened. */
export interface HubDevice {
  id: string
  label: string
  platform: string
  keys: DeviceKeys
  /** '' when signed out. */
  token: string
  account: string
  email: string
  tokenExpiresAt: number
  createdAt: number
  /**
   * 32 random bytes, b64url: the HMAC key of every value digest in
   * hub-state.json (`valueDigest`). '' when the file predates it: the service
   * makes one, and compares every record afresh.
   */
  digestKey: string
}

const DEVICE_FILE_VERSION = 1

/** The sealed slots, each bound into its ciphertext by `sealedText`. */
const SLOT = {
  sign: 'hub.device.sign',
  box: 'hub.device.box',
  token: 'hub.session',
  digest: 'hub.device.digest',
  vk: (account: string, epoch: number) => `hub.vault.${account}.${epoch}`
} as const

export class HubFiles {
  readonly dir: string
  private readonly backend: SecretBackend
  private readonly platform: string
  private protection: SecretProtection | null

  constructor(dir: string, backend: SecretBackend, platform: string) {
    this.dir = dir
    this.backend = backend
    this.platform = platform
    this.protection = null
  }

  get deviceFile(): string {
    return join(this.dir, HUB_DEVICE_FILE)
  }

  get stateFile(): string {
    return join(this.dir, HUB_STATE_FILE)
  }

  /** Asked once, and only when something is about to be sealed or opened. */
  keyStore(): SecretProtection {
    if (this.protection) return this.protection
    let available = false
    let linux: string | null = null
    try {
      available = this.backend.isEncryptionAvailable()
    } catch {
      available = false
    }
    try {
      linux = this.backend.selectedBackend()
    } catch {
      linux = null
    }
    this.protection = judgeProtection(this.platform, available, linux)
    return this.protection
  }

  private seal(slot: string, value: string): string {
    return this.backend.encrypt(sealedText(slot, value)).toString('base64')
  }

  private open(slot: string, sealed: string): string | null {
    try {
      return unsealedValue(slot, this.backend.decrypt(Buffer.from(sealed, 'base64')))
    } catch {
      return null
    }
  }

  /** A secret as the device file stores it: sealed when the key store protects, else as is. */
  private put(slot: string, value: string): { sealed: boolean; text: string } {
    if (value === '') return { sealed: false, text: '' }
    return this.keyStore().protected ? { sealed: true, text: this.seal(slot, value) } : { sealed: false, text: value }
  }

  private take(slot: string, stored: unknown, sealed: boolean): string | null {
    if (typeof stored !== 'string') return null
    if (stored === '') return ''
    return sealed ? this.open(slot, stored) : stored
  }

  /** hub-device.json, opened; null when there is none or it will not open on this run. */
  async loadDevice(): Promise<HubDevice | null> {
    let raw: unknown
    try {
      raw = JSON.parse(await readFile(this.deviceFile, 'utf8'))
    } catch {
      return null
    }
    if (!raw || typeof raw !== 'object') return null
    const r = raw as Record<string, unknown>
    if (r.v !== DEVICE_FILE_VERSION || !isId('device', r.id) || !isB64u(r.signPub, 32) || !isB64u(r.boxPub, 32)) return null
    const sealed = r.sealed === true
    const signPriv = this.take(SLOT.sign, r.signPriv, sealed)
    const boxPriv = this.take(SLOT.box, r.boxPriv, sealed)
    if (!signPriv || !boxPriv || !isB64u(signPriv, 32) || !isB64u(boxPriv, 32)) return null
    const token = this.take(SLOT.token, r.token, sealed) ?? ''
    const digestKey = this.take(SLOT.digest, r.digestKey, sealed) ?? ''
    return {
      id: r.id,
      label: typeof r.label === 'string' ? r.label : '',
      platform: typeof r.platform === 'string' ? r.platform : this.platform,
      keys: { signPub: r.signPub as string, signPriv, boxPub: r.boxPub as string, boxPriv },
      token,
      account: isId('account', r.account) ? r.account : '',
      email: typeof r.email === 'string' ? r.email : '',
      tokenExpiresAt: typeof r.tokenExpiresAt === 'number' ? r.tokenExpiresAt : 0,
      createdAt: typeof r.createdAt === 'number' ? r.createdAt : 0,
      digestKey: isB64u(digestKey, 32) ? digestKey : ''
    }
  }

  saveDevice(d: HubDevice): void {
    const sign = this.put(SLOT.sign, d.keys.signPriv)
    const box = this.put(SLOT.box, d.keys.boxPriv)
    const token = this.put(SLOT.token, d.token)
    const digest = this.put(SLOT.digest, d.digestKey)
    const body = {
      v: DEVICE_FILE_VERSION,
      id: d.id,
      label: d.label,
      platform: d.platform,
      signPub: d.keys.signPub,
      boxPub: d.keys.boxPub,
      sealed: sign.sealed,
      signPriv: sign.text,
      boxPriv: box.text,
      token: token.text,
      digestKey: digest.text,
      account: d.account,
      email: d.email,
      tokenExpiresAt: d.tokenExpiresAt,
      createdAt: d.createdAt
    }
    writePrivateFile(this.deviceFile, `${JSON.stringify(body, null, 2)}\n`)
  }

  async loadState(account: string): Promise<HubLocalState> {
    try {
      return hydrateHubState(JSON.parse(await readFile(this.stateFile, 'utf8')), account)
    } catch {
      return emptyHubState(account)
    }
  }

  saveState(state: HubLocalState): void {
    writePrivateFile(this.stateFile, `${JSON.stringify(state)}\n`)
  }

  /**
   * A vault key sealed for hub-state.json. Throws on a key store that does not
   * protect: a vault key in the clear on disk is exactly what the vault exists
   * to prevent, so such a run does not join (spec §4.2).
   */
  sealVault(account: string, epoch: number, vk: Uint8Array): string {
    const p = this.keyStore()
    if (!p.protected) throw new Error(p.why)
    return this.seal(SLOT.vk(account, epoch), b64uEncode(vk))
  }

  openVault(account: string, epoch: number, sealed: string): Uint8Array | null {
    const text = this.open(SLOT.vk(account, epoch), sealed)
    const vk = text === null ? null : b64uDecode(text)
    return vk && vk.length === 32 ? vk : null
  }

  /** Sign-out: both files gone (the vault keys, the device keys and the session with them). */
  async wipe(): Promise<void> {
    await rm(this.deviceFile, { force: true })
    await rm(this.stateFile, { force: true })
    await rm(`${this.deviceFile}.tmp`, { force: true })
    await rm(`${this.stateFile}.tmp`, { force: true })
  }
}
