/*
 * Stoke Hub's cryptography, on node:crypto and nothing else.
 *
 * The reference implementation of the contract in `src/shared/hub/`: device
 * keys, request signatures, the vault key wrapped to a device and to the
 * Recovery Kit, item sealing under opaque ids, pairing's commitment and code,
 * the relay handshake and its per-direction ciphers, and the scrypt password
 * hash the hub stores. Every label, AAD and info string comes from the shared
 * modules; `scripts/verify-hub.mts` pins test vectors over all of it, so a
 * changed label or byte layout fails the suite before it strands data already
 * sealed on a hub.
 *
 * Imports only `node:crypto` and `src/shared` by relative `.ts` path (gotcha
 * 78) and has no electron import, so the hub server on the NUC can import it
 * as it is, and verify:hub runs it under strip-types. No TypeScript parameter
 * properties (strip-only mode rejects them).
 *
 * Measured 2026-10-01 under Node 26.7/OpenSSL 3.5.7 and Electron 43's Node
 * 24.18/BoringSSL: identical public keys from identical seeds; an all-zero
 * X25519 peer key is REFUSED by both, with different error codes (catch,
 * never match the code); a raw private key imports only as PKCS8 DER with the
 * fixed prefix below — a JWK with just `d` is "Invalid JWK OKP key" in both.
 *
 * Design: docs/superpowers/specs/2026-10-01-stoke-hub-selfhosted.md §4, §6.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  hkdfSync,
  randomBytes,
  scrypt,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject
} from 'node:crypto'
import { formatPasswordHash, parsePasswordHash, PASSWORD_KDF } from '../../shared/hub/auth.ts'
import type { ChainCrypto } from '../../shared/hub/chain.ts'
import { b64uDecode, b64uEncode, fromUtf8, isB64u, utf8 } from '../../shared/hub/codec.ts'
import {
  ITEM_ID_BYTES,
  itemAadText,
  itemPlaintextText,
  MAX_ITEM_PLAINTEXT_BYTES,
  parseItemPath,
  parseItemPlaintext,
  type ItemEnvelope,
  type ItemPlaintext
} from '../../shared/hub/items.ts'
import { HUB_LABELS, itemIdInfo, itemKeyInfo, presenceKeyInfo, presenceStatusAad, recoveryWrapAad, vkCommitInfo, vkWrapInfo } from '../../shared/hub/labels.ts'
import { pairCommitText, pairSasText, sasDigits } from '../../shared/hub/pairing.ts'
import {
  HUB_HEADERS,
  REQUEST_NONCE_BYTES,
  REQUEST_SKEW_MS,
  requestSigningText,
  sealedStatusProblem,
  type RecoveryWrap,
  type SealedStatus,
  type VaultWrap
} from '../../shared/hub/protocol.ts'
import {
  hs2Problem,
  hs3Problem,
  RELAY_KEYS_INFO,
  RELAY_MAX_COUNTER,
  RELAY_NONCE_BYTES,
  relayFrameAad,
  relayHs2Text,
  relayHs3Text,
  relayNonce,
  relayTranscriptText,
  type RelayDir,
  type RelayHs1,
  type RelayHs2,
  type RelayHs3
} from '../../shared/hub/relay.ts'

/* ------------------------------------------------------------ bytes */

const ED25519_PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20])
const X25519_PKCS8_PREFIX = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20])

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function need(bytes: Uint8Array | null, length: number, what: string): Uint8Array {
  if (!bytes || bytes.length !== length) throw new Error(`${what} must be ${length} bytes`)
  return bytes
}

export function randomU8(n: number): Uint8Array {
  return new Uint8Array(randomBytes(n))
}

export function randomB64u(n: number): string {
  return b64uEncode(randomU8(n))
}

export function sha256(data: Uint8Array | string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(typeof data === 'string' ? utf8(data) : data).digest())
}

export function sha256B64u(data: Uint8Array | string): string {
  return b64uEncode(sha256(data))
}

/** HMAC-SHA256 of `text` under `key`, b64url: a digest only the key's holder can recompute or check a guess against. */
export function hmacB64u(key: Uint8Array, text: string): string {
  return b64uEncode(new Uint8Array(createHmac('sha256', key).update(utf8(text)).digest()))
}

function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array {
  return new Uint8Array(hkdfSync('sha256', ikm, salt, utf8(info), length))
}

/** AES-256-GCM: ciphertext with the 16-byte tag appended. */
function gcmSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  const c = createCipheriv('aes-256-gcm', need(key, 32, 'key'), need(nonce, 12, 'nonce'))
  c.setAAD(aad)
  const body = concat(new Uint8Array(c.update(plaintext)), new Uint8Array(c.final()))
  return concat(body, new Uint8Array(c.getAuthTag()))
}

/** The plaintext, or null for a wrong key, nonce, AAD or any flipped byte. */
function gcmOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array | null {
  if (key.length !== 32 || nonce.length !== 12 || sealed.length < 16) return null
  try {
    const d = createDecipheriv('aes-256-gcm', key, nonce)
    d.setAAD(aad)
    d.setAuthTag(sealed.subarray(sealed.length - 16))
    return concat(new Uint8Array(d.update(sealed.subarray(0, sealed.length - 16))), new Uint8Array(d.final()))
  } catch {
    return null
  }
}

/* ------------------------------------------------------------- keys */

function edPrivate(seed: string | Uint8Array): KeyObject {
  const s = typeof seed === 'string' ? b64uDecode(seed) : seed
  return createPrivateKey({ key: Buffer.from(concat(ED25519_PKCS8_PREFIX, need(s, 32, 'an Ed25519 seed'))), format: 'der', type: 'pkcs8' })
}

function edPublic(pub: string): KeyObject {
  need(b64uDecode(pub), 32, 'an Ed25519 public key')
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: pub }, format: 'jwk' })
}

function xPrivate(seed: string | Uint8Array): KeyObject {
  const s = typeof seed === 'string' ? b64uDecode(seed) : seed
  return createPrivateKey({ key: Buffer.from(concat(X25519_PKCS8_PREFIX, need(s, 32, 'an X25519 private key'))), format: 'der', type: 'pkcs8' })
}

function xPublic(pub: string): KeyObject {
  need(b64uDecode(pub), 32, 'an X25519 public key')
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: pub }, format: 'jwk' })
}

/** b64url of a private key's raw 32-byte public half. */
function publicOf(priv: KeyObject): string {
  const x = createPublicKey(priv).export({ format: 'jwk' }).x
  if (typeof x !== 'string') throw new Error('no public key')
  return x
}

/**
 * One device's two keypairs. The private halves are the raw 32-byte seeds,
 * b64url — what `hub-device.json` seals with safeStorage (spec §4.2).
 */
export interface DeviceKeys {
  signPub: string
  signPriv: string
  boxPub: string
  boxPriv: string
}

/** Keys from given seeds (test vectors); `generateDeviceKeys` for real ones. */
export function deviceKeysFromSeeds(signSeed: Uint8Array, boxSeed: Uint8Array): DeviceKeys {
  return {
    signPub: publicOf(edPrivate(signSeed)),
    signPriv: b64uEncode(need(signSeed, 32, 'a signing seed')),
    boxPub: publicOf(xPrivate(boxSeed)),
    boxPriv: b64uEncode(need(boxSeed, 32, 'a box seed'))
  }
}

export function generateDeviceKeys(): DeviceKeys {
  return deviceKeysFromSeeds(randomU8(32), randomU8(32))
}

/** b64url Ed25519 signature of `text` as UTF-8. */
export function signText(signPriv: string, text: string): string {
  return b64uEncode(new Uint8Array(sign(null, utf8(text), edPrivate(signPriv))))
}

/** Never throws: a malformed key or signature is simply not a valid signature. */
export function verifyText(signPub: string, text: string, sig: string): boolean {
  try {
    const s = b64uDecode(sig)
    if (!s || s.length !== 64) return false
    return verify(null, utf8(text), edPublic(signPub), s)
  } catch {
    return false
  }
}

/** What `verifyChain` (shared/hub/chain.ts) needs, backed by node:crypto. */
export const nodeChainCrypto: ChainCrypto = { verify: verifyText, digest: (text) => sha256B64u(text) }

/** X25519, or null for a peer key the curve refuses (low order: all-zero output). */
function agree(priv: KeyObject, peerPub: string): Uint8Array | null {
  try {
    return new Uint8Array(diffieHellman({ privateKey: priv, publicKey: xPublic(peerPub) }))
  } catch {
    return null
  }
}

/* -------------------------------------------------- request signing */

/** b64url SHA-256 of a request body; the empty string's for none. */
export function bodyDigest(body: Uint8Array | string | null | undefined): string {
  return sha256B64u(body ?? '')
}

/**
 * The four headers a signed request carries (spec §3.4), plus the bearer when
 * there is a session. A sign-in has none yet: an active device signs it anyway
 * (no `token`) to be judged by its own lockout, not the email's (spec §3.3).
 */
export function signRequest(f: {
  method: string
  pathFromV1: string
  device: string
  signPriv: string
  token?: string
  body?: Uint8Array | string | null
  now: number
  nonce?: string
}): Record<string, string> {
  const nonce = f.nonce ?? randomB64u(REQUEST_NONCE_BYTES)
  const ts = Math.floor(f.now)
  const text = requestSigningText({ method: f.method, pathFromV1: f.pathFromV1, ts, nonce, device: f.device, bodySha256: bodyDigest(f.body) })
  return {
    ...(f.token ? { authorization: `Bearer ${f.token}` } : {}),
    [HUB_HEADERS.device]: f.device,
    [HUB_HEADERS.ts]: String(ts),
    [HUB_HEADERS.nonce]: nonce,
    [HUB_HEADERS.sig]: signText(f.signPriv, text)
  }
}

/**
 * The hub's check of one signed request against the key its session is bound
 * to. Replay (a nonce seen before) needs the hub's memory and is checked by
 * the caller, after this passes.
 */
export function verifyRequest(f: {
  method: string
  pathFromV1: string
  headers: Record<string, string | undefined>
  body: Uint8Array | string | null | undefined
  signPub: string
  device: string
  now: number
}): { ok: true; nonce: string } | { ok: false; error: 'bad-signature' | 'clock-skew' } {
  const h = f.headers
  if (h[HUB_HEADERS.device] !== f.device) return { ok: false, error: 'bad-signature' }
  const ts = Number(h[HUB_HEADERS.ts])
  if (!Number.isSafeInteger(ts)) return { ok: false, error: 'bad-signature' }
  if (Math.abs(f.now - ts) > REQUEST_SKEW_MS) return { ok: false, error: 'clock-skew' }
  const nonce = h[HUB_HEADERS.nonce] ?? ''
  if (!isB64u(nonce, REQUEST_NONCE_BYTES)) return { ok: false, error: 'bad-signature' }
  const text = requestSigningText({ method: f.method, pathFromV1: f.pathFromV1, ts, nonce, device: f.device, bodySha256: bodyDigest(f.body) })
  return verifyText(f.signPub, text, h[HUB_HEADERS.sig] ?? '') ? { ok: true, nonce } : { ok: false, error: 'bad-signature' }
}

/* ------------------------------------------------------ the vault key */

export const VAULT_KEY_BYTES = 32

export function newVaultKey(): Uint8Array {
  return randomU8(VAULT_KEY_BYTES)
}

/**
 * The commitment to `VK_epoch` that the chain entry opening the epoch signs
 * (`ChainEntry.vk`: genesis, revoke, rotate). HKDF under its own label, so it
 * reveals nothing of the key or of the item keys HKDF derives from it under
 * other labels.
 *
 * Why it exists: a wrap (below) is an anonymous box. It proves only that
 * SOMEBODY sealed a key to a device's PUBLIC box key — which the hub, the
 * Cloudflare edge or anyone on a plain-http LAN path can do, with a key of
 * their choosing. Found in review (2026-10-01): with nothing to compare an
 * unwrapped key to, a joining device, or one fetching a new epoch after a
 * revoke, would take a planted key and seal its API and SSH keys under it.
 * The chain is signed by devices the hub cannot impersonate, so the key an
 * epoch's entry commits to is the only one a device will accept.
 */
export function vaultKeyCommit(vk: Uint8Array, f: { account: string; epoch: number }): string {
  return b64uEncode(hkdf(need(vk, VAULT_KEY_BYTES, 'a vault key'), new Uint8Array(0), vkCommitInfo(f), 32))
}

/** Whether `vk` is the key `commit` vouches for at this account and epoch. Constant time; a malformed commit is false. */
export function vaultKeyMatches(vk: Uint8Array, f: { account: string; epoch: number }, commit: string): boolean {
  const want = b64uDecode(commit)
  if (!want || want.length !== 32 || vk.length !== VAULT_KEY_BYTES) return false
  return timingSafeEqual(b64uDecode(vaultKeyCommit(vk, f)) as Uint8Array, want)
}

/**
 * `VK_epoch` sealed to one device's X25519 key: an ephemeral key agreement,
 * HKDF over the shared secret salted with both public keys, AES-256-GCM with
 * the same labelled info as AAD. `opts` exist for test vectors only. Anyone
 * can make one of these: the reader's `unwrapVaultKey` checks the key inside
 * against the chain's commitment, which is what makes it trustworthy.
 */
export function wrapVaultKey(
  vk: Uint8Array,
  f: { account: string; epoch: number; device: string; boxPub: string },
  opts: { ephSeed?: Uint8Array; nonce?: Uint8Array } = {}
): VaultWrap {
  need(vk, VAULT_KEY_BYTES, 'a vault key')
  const eph = xPrivate(opts.ephSeed ?? randomU8(32))
  const ephPub = publicOf(eph)
  const shared = agree(eph, f.boxPub)
  if (!shared) throw new Error('that device key cannot be wrapped to')
  const info = vkWrapInfo(f)
  const key = hkdf(shared, concat(need(b64uDecode(ephPub), 32, 'eph'), need(b64uDecode(f.boxPub), 32, 'box')), info, 32)
  const nonce = opts.nonce ?? randomU8(12)
  return { v: 1, eph: ephPub, nonce: b64uEncode(nonce), ct: b64uEncode(gcmSeal(key, nonce, vk, utf8(info))) }
}

/**
 * The vault key, or null when this wrap was not made for this device, account
 * and epoch — or when the key inside is not the one `commit` vouches for.
 * `commit` is `vkCommits[epoch]` of the chain this device VERIFIED
 * (`verifyChain`), never a value the hub served beside the wrap: a planted key
 * is refused here, not used. Null either way is an alarm, not a retry.
 */
export function unwrapVaultKey(wrap: VaultWrap, f: { account: string; epoch: number; device: string; boxPriv: string; commit: string }): Uint8Array | null {
  try {
    if (wrap?.v !== 1 || !isB64u(wrap.eph, 32)) return null
    const priv = xPrivate(f.boxPriv)
    const shared = agree(priv, wrap.eph)
    const nonce = b64uDecode(wrap.nonce)
    const ct = b64uDecode(wrap.ct)
    if (!shared || !nonce || !ct) return null
    const info = vkWrapInfo(f)
    const key = hkdf(shared, concat(b64uDecode(wrap.eph) as Uint8Array, need(b64uDecode(publicOf(priv)), 32, 'box')), info, 32)
    const vk = gcmOpen(key, nonce, ct, utf8(info))
    return vk && vk.length === VAULT_KEY_BYTES && vaultKeyMatches(vk, f, f.commit) ? vk : null
  } catch {
    return null
  }
}

/* ------------------------------------------------------ the Recovery Kit */

export interface RecoveryKeys {
  /** Wraps VK per epoch. */
  wrapKey: Uint8Array
  /** The Ed25519 seed that may sign chain entries as 'recovery', b64url. */
  signPriv: string
  /** Its public key: the chain's `recovery`. */
  signPub: string
}

/** Both keys a Recovery Kit secret stands for, salted with the account id. */
export function recoveryKeys(secret: Uint8Array, account: string): RecoveryKeys {
  need(secret, 16, 'a recovery secret')
  const salt = utf8(account)
  const wrapKey = hkdf(secret, salt, HUB_LABELS.recoveryWrap, 32)
  const seed = hkdf(secret, salt, HUB_LABELS.recoverySign, 32)
  return { wrapKey, signPriv: b64uEncode(seed), signPub: publicOf(edPrivate(seed)) }
}

export function sealRecoveryWrap(vk: Uint8Array, wrapKey: Uint8Array, f: { account: string; epoch: number }, opts: { nonce?: Uint8Array } = {}): RecoveryWrap {
  const nonce = opts.nonce ?? randomU8(12)
  return { v: 1, nonce: b64uEncode(nonce), ct: b64uEncode(gcmSeal(wrapKey, nonce, need(vk, 32, 'a vault key'), utf8(recoveryWrapAad(f)))) }
}

/**
 * The vault key the Kit's wrap holds, or null — including when it is not the
 * key `commit` (the verified chain's `vkCommits[epoch]`) vouches for. The hub
 * cannot seal to the Kit's key, but a wrap is still data it serves: the same
 * check as `unwrapVaultKey`, so no path takes a key the chain did not name.
 */
export function openRecoveryWrap(wrap: RecoveryWrap, wrapKey: Uint8Array, f: { account: string; epoch: number; commit: string }): Uint8Array | null {
  const nonce = b64uDecode(wrap?.nonce ?? '')
  const ct = b64uDecode(wrap?.ct ?? '')
  if (wrap?.v !== 1 || !nonce || !ct) return null
  const vk = gcmOpen(wrapKey, nonce, ct, utf8(recoveryWrapAad(f)))
  return vk && vk.length === VAULT_KEY_BYTES && vaultKeyMatches(vk, f, f.commit) ? vk : null
}

/* ------------------------------------------------------------ items */

/** The two keys one epoch's items use, derived from VK_epoch. */
export interface ItemKeys {
  account: string
  epoch: number
  sealKey: Uint8Array
  idKey: Uint8Array
}

export function itemKeys(vk: Uint8Array, account: string, epoch: number): ItemKeys {
  need(vk, VAULT_KEY_BYTES, 'a vault key')
  const none = new Uint8Array(0)
  return {
    account,
    epoch,
    sealKey: hkdf(vk, none, itemKeyInfo({ account, epoch }), 32),
    idKey: hkdf(vk, none, itemIdInfo({ account, epoch }), 32)
  }
}

/** The opaque id the hub stores `path` under this epoch (spec §4.7). */
export function itemIdFor(keys: ItemKeys, path: string): string {
  const mac = new Uint8Array(createHmac('sha256', keys.idKey).update(utf8(path)).digest())
  return `i${b64uEncode(mac.subarray(0, ITEM_ID_BYTES))}`
}

/** Seal one item as version `version` by `author`. Throws on a path the grammar refuses or a value past the size cap. */
export function sealItem(
  keys: ItemKeys,
  f: { version: number; author: string } & ItemPlaintext,
  opts: { nonce?: Uint8Array } = {}
): ItemEnvelope {
  if (!parseItemPath(f.path)) throw new Error(`not an item path: ${f.path}`)
  const plaintext = utf8(itemPlaintextText(f))
  if (plaintext.length > MAX_ITEM_PLAINTEXT_BYTES) throw new Error('item too large to sync')
  const id = itemIdFor(keys, f.path)
  const aad = utf8(itemAadText({ account: keys.account, id, version: f.version, epoch: keys.epoch, author: f.author }))
  const nonce = opts.nonce ?? randomU8(12)
  return { v: 1, id, version: f.version, epoch: keys.epoch, author: f.author, nonce: b64uEncode(nonce), ct: b64uEncode(gcmSeal(keys.sealKey, nonce, plaintext, aad)) }
}

export type OpenedItem =
  | { ok: true; item: ItemPlaintext }
  | { ok: false; reason: 'epoch' | 'tag' | 'plaintext' | 'id' }

/**
 * Open an envelope with this epoch's keys. `tag` covers a wrong key, a moved
 * or edited envelope (id, version, epoch and author are in the AAD) and any
 * flipped byte; `id` is a plaintext whose path does not hash to the slot it
 * sits in — refused, never applied.
 */
export function openItem(keys: ItemKeys, e: ItemEnvelope): OpenedItem {
  if (e.epoch !== keys.epoch) return { ok: false, reason: 'epoch' }
  const nonce = b64uDecode(e.nonce)
  const ct = b64uDecode(e.ct)
  if (!nonce || !ct) return { ok: false, reason: 'tag' }
  const aad = utf8(itemAadText({ account: keys.account, id: e.id, version: e.version, epoch: e.epoch, author: e.author }))
  const plain = gcmOpen(keys.sealKey, nonce, ct, aad)
  if (!plain) return { ok: false, reason: 'tag' }
  const text = fromUtf8(plain)
  const item = text === null ? null : parseItemPlaintext(text)
  if (!item) return { ok: false, reason: 'plaintext' }
  if (itemIdFor(keys, item.path) !== e.id) return { ok: false, reason: 'id' }
  return { ok: true, item }
}

/* ---------------------------------------------------------- pairing */

/** The new device's commitment (b64url SHA-256 of `pairCommitText`). */
export function pairCommit(f: Parameters<typeof pairCommitText>[0]): string {
  return sha256B64u(pairCommitText(f))
}

/** The six digits both screens show. */
export function pairCode(f: Parameters<typeof pairSasText>[0]): string {
  return sasDigits(sha256(pairSasText(f)))
}

/* ------------------------------------------------------------ relay */

/** An ephemeral X25519 key for one relay handshake. Never stored. */
export interface RelayEphemeral {
  priv: KeyObject
  pub: string
}

export function relayEphemeral(seed?: Uint8Array): RelayEphemeral {
  const priv = xPrivate(seed ?? randomU8(32))
  return { priv, pub: publicOf(priv) }
}

/** The guest's opening frame. */
export function relayHello(
  f: { relay: string; account: string; guest: string; host: string },
  eph: RelayEphemeral,
  nonce: Uint8Array = randomU8(RELAY_NONCE_BYTES)
): RelayHs1 {
  return { t: 'hs1', v: 1, relay: f.relay, account: f.account, guest: f.guest, host: f.host, eph: eph.pub, nonce: b64uEncode(need(nonce, RELAY_NONCE_BYTES, 'nonce')) }
}

/** b64url transcript hash over hs1 and hs2 (without its signature). */
export function relayTranscript(hs1: RelayHs1, hs2: Omit<RelayHs2, 'sig'>): string {
  return sha256B64u(relayTranscriptText(hs1, hs2))
}

/** The host's answer, signed with its device key. Returns the transcript hash for the key derivation. */
export function relayAnswer(hs1: RelayHs1, eph: RelayEphemeral, hostSignPriv: string, nonce: Uint8Array = randomU8(RELAY_NONCE_BYTES)): { hs2: RelayHs2; th: string } {
  const bare = { t: 'hs2' as const, v: 1 as const, eph: eph.pub, nonce: b64uEncode(need(nonce, RELAY_NONCE_BYTES, 'nonce')) }
  const th = relayTranscript(hs1, bare)
  return { hs2: { ...bare, sig: signText(hostSignPriv, relayHs2Text(th)) }, th }
}

/** The guest's check of hs2 against the host key IT pinned from the chain, and its hs3. */
export function relayFinish(
  hs1: RelayHs1,
  hs2: RelayHs2,
  hostSignPub: string,
  guestSignPriv: string
): { ok: true; hs3: RelayHs3; th: string } | { ok: false; reason: string } {
  const p = hs2Problem(hs2)
  if (p) return { ok: false, reason: p }
  const th = relayTranscript(hs1, hs2)
  if (!verifyText(hostSignPub, relayHs2Text(th), hs2.sig)) return { ok: false, reason: 'the host did not sign this handshake' }
  return { ok: true, hs3: { t: 'hs3', sig: signText(guestSignPriv, relayHs3Text(th, hs2.sig)) }, th }
}

/** The host's check of hs3 against the guest key IT pinned from the chain. */
export function relayAccept(th: string, hs2: RelayHs2, hs3: RelayHs3, guestSignPub: string): boolean {
  return hs3Problem(hs3) === null && verifyText(guestSignPub, relayHs3Text(th, hs2.sig), hs3.sig)
}

/** The two direction keys, from this side's ephemeral key, the peer's, and the transcript. */
export function relayKeys(eph: RelayEphemeral, peerEph: string, th: string): { g2h: Uint8Array; h2g: Uint8Array } | null {
  const shared = agree(eph.priv, peerEph)
  const salt = b64uDecode(th)
  if (!shared || !salt) return null
  const okm = hkdf(shared, salt, RELAY_KEYS_INFO, 64)
  return { g2h: okm.slice(0, 32), h2g: okm.slice(32, 64) }
}

/**
 * One direction of a relay: a key, its direction and a counter that only
 * ever moves forward. A sender seals with it, the other end opens with an
 * instance of its own for the same direction; any gap, repeat or edit fails
 * GCM and the relay is closed.
 */
export class RelayCipher {
  private readonly key: Uint8Array
  private readonly dir: RelayDir
  private readonly aad: Uint8Array
  private counter: number

  constructor(key: Uint8Array, dir: RelayDir, relay: string) {
    this.key = need(key, 32, 'a relay key')
    this.dir = dir
    this.aad = relayFrameAad(relay, dir)
    this.counter = 0
  }

  seal(plaintext: Uint8Array | string): Uint8Array {
    if (this.counter >= RELAY_MAX_COUNTER) throw new Error('relay counter exhausted: open a new relay')
    const out = gcmSeal(this.key, relayNonce(this.dir, this.counter), typeof plaintext === 'string' ? utf8(plaintext) : plaintext, this.aad)
    this.counter++
    return out
  }

  /** The plaintext, or null — after which this direction is dead and the relay must close. */
  open(frame: Uint8Array): Uint8Array | null {
    if (this.counter >= RELAY_MAX_COUNTER) return null
    const plain = gcmOpen(this.key, relayNonce(this.dir, this.counter), frame, this.aad)
    if (plain) this.counter++
    else this.counter = RELAY_MAX_COUNTER
    return plain
  }
}

/* --------------------------------------------------------- presence */

/**
 * The key every device of the account seals its presence status with under
 * `epoch` (spec §6.1, "Other machines"). Derived from that epoch's vault key,
 * so exactly the devices in the vault can read one — the hub forwards it
 * blind — and a device removed by a revoke (which opens a new epoch) cannot.
 */
export function presenceKey(vk: Uint8Array, account: string, epoch: number): Uint8Array {
  need(vk, VAULT_KEY_BYTES, 'a vault key')
  return hkdf(vk, new Uint8Array(0), presenceKeyInfo({ account, epoch }), 32)
}

/** `text` (a `RemoteStatus` as JSON) sealed as `device`'s status under `epoch`. */
export function sealStatus(key: Uint8Array, f: { account: string; epoch: number; device: string }, text: string, nonce: Uint8Array = randomU8(12)): SealedStatus {
  const ct = gcmSeal(key, need(nonce, 12, 'nonce'), utf8(text), utf8(presenceStatusAad(f)))
  return { v: 1, epoch: f.epoch, nonce: b64uEncode(nonce), ct: b64uEncode(ct) }
}

/**
 * The text of a status the hub said `device` sent, or null: a malformed
 * envelope, another epoch than `f.epoch`, another device's status relabelled,
 * or any flipped byte. The caller parses what it gets (remote.ts
 * `parseRemoteStatus`) — it is still another machine's text.
 */
export function openStatus(key: Uint8Array, f: { account: string; epoch: number; device: string }, s: SealedStatus): string | null {
  if (sealedStatusProblem(s) !== null || s.epoch !== f.epoch) return null
  const nonce = b64uDecode(s.nonce)
  const ct = b64uDecode(s.ct)
  if (!nonce || !ct) return null
  const plain = gcmOpen(key, nonce, ct, utf8(presenceStatusAad(f)))
  return plain ? fromUtf8(plain) : null
}

/* ------------------------------------------------------- passwords */

function scryptAsync(password: string, salt: Uint8Array, log2N: number, r: number, p: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) =>
    scrypt(password.normalize('NFC'), salt, PASSWORD_KDF.keyBytes, { N: 2 ** log2N, r, p, maxmem: PASSWORD_KDF.maxmem }, (err, key) =>
      err ? reject(err) : resolve(new Uint8Array(key))
    )
  )
}

/** The stored form of a new password (async: ~0.3–0.5 s off the event loop). */
export async function hashPassword(password: string, opts: { salt?: Uint8Array; log2N?: number } = {}): Promise<string> {
  const salt = opts.salt ?? randomU8(PASSWORD_KDF.saltBytes)
  const log2N = opts.log2N ?? PASSWORD_KDF.log2N
  const hash = await scryptAsync(password, salt, log2N, PASSWORD_KDF.r, PASSWORD_KDF.p)
  return formatPasswordHash({ log2N, r: PASSWORD_KDF.r, p: PASSWORD_KDF.p, salt: b64uEncode(salt), hash: b64uEncode(hash) })
}

/** Whether `password` matches `stored`. A malformed stored value is false, never a throw. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parsePasswordHash(stored)
  if (!h) return false
  const got = await scryptAsync(password, b64uDecode(h.salt) as Uint8Array, h.log2N, h.r, h.p)
  return timingSafeEqual(got, b64uDecode(h.hash) as Uint8Array)
}

/**
 * A well-formed hash no password matches: the hub checks an unknown email's
 * password against it, so a login for an account that does not exist costs
 * the same scrypt as one that does (spec §3.2: no enumeration by timing).
 */
export const UNMATCHABLE_PASSWORD_HASH = formatPasswordHash({
  log2N: PASSWORD_KDF.log2N,
  r: PASSWORD_KDF.r,
  p: PASSWORD_KDF.p,
  salt: b64uEncode(new Uint8Array(PASSWORD_KDF.saltBytes)),
  hash: b64uEncode(new Uint8Array(PASSWORD_KDF.keyBytes))
})
