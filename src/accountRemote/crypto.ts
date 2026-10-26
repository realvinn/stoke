/** Browser implementation of the existing wire format. Cross-tested against node:crypto. */
import { ed25519, x25519 } from '@noble/curves/ed25519.js'
import { gcm } from '@noble/ciphers/aes.js'
import { sha256 as hash } from '@noble/hashes/sha2.js'
import { hkdf as derive } from '@noble/hashes/hkdf.js'
import { b64uDecode, b64uEncode, utf8, fromUtf8 } from '../shared/hub/codec.ts'
import { HUB_HEADERS, REQUEST_NONCE_BYTES, requestSigningText, sealedStatusProblem, type SealedStatus } from '../shared/hub/protocol.ts'
import { hs2Problem, hs3Problem, RELAY_KEYS_INFO, RELAY_MAX_COUNTER, RELAY_NONCE_BYTES, relayFrameAad, relayHs2Text, relayHs3Text, relayNonce, relayTranscriptText, type RelayDir, type RelayHs1, type RelayHs2, type RelayHs3 } from '../shared/hub/relay.ts'
import { presenceStatusAad } from '../shared/hub/labels.ts'
import { browserKeyProblem, browserKeyText, browserWrapInfo, type BrowserPresenceKey } from '../shared/hub/browser.ts'
const need = (bytes: Uint8Array | null, n: number, what: string): Uint8Array => { if (!bytes || bytes.length !== n) throw new Error(what); return bytes }
export const randomU8 = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n))
export const randomB64u = (n: number): string => b64uEncode(randomU8(n))
export const sha256B64u = (data: string | Uint8Array): string => b64uEncode(hash(typeof data === 'string' ? utf8(data) : data))
export const signText = (seed: string, text: string): string => b64uEncode(ed25519.sign(utf8(text), need(b64uDecode(seed), 32, 'signing seed')))
export function verifyText(pub: string, text: string, sig: string): boolean { try { return ed25519.verify(need(b64uDecode(sig),64,'signature'),utf8(text),need(b64uDecode(pub),32,'public key'), { zip215: false }) } catch { return false } }
export const nodeChainCrypto = { verify: verifyText, digest: sha256B64u }
const hkdf = (key: Uint8Array, salt: Uint8Array, info: string, length: number): Uint8Array => derive(hash,key,salt,utf8(info),length)
const agree = (key: Uint8Array, pub: string): Uint8Array | null => { try { return x25519.getSharedSecret(key,need(b64uDecode(pub),32,'peer key')) } catch { return null } }
const gcmSeal = (key: Uint8Array, nonce: Uint8Array, data: Uint8Array, aad: Uint8Array): Uint8Array => gcm(key,nonce,aad).encrypt(data)
const gcmOpen = (key: Uint8Array, nonce: Uint8Array, data: Uint8Array, aad: Uint8Array): Uint8Array | null => { try { return gcm(key,nonce,aad).decrypt(data) } catch { return null } }
export const bodyDigest = (data: Uint8Array | string | null | undefined): string => sha256B64u(data ?? '')
export interface RelayEphemeral { priv: Uint8Array; pub: string }
export function relayEphemeral(seed?: Uint8Array): RelayEphemeral { const priv=seed??randomU8(32);return {priv,pub:b64uEncode(x25519.getPublicKey(priv))} }
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


export function openBrowserPresence(value: BrowserPresenceKey, boxPriv: string, signer: string): Uint8Array | null {
  if (browserKeyProblem(value) || !verifyText(signer,browserKeyText(value),value.sig)) return null
  const shared=agree(need(b64uDecode(boxPriv),32,'browser box key'),value.wrap.eph)
  if (!shared) return null
  const info=browserWrapInfo(value.account,value.epoch,value.device)
  return gcmOpen(hkdf(shared,new Uint8Array(),info,32),need(b64uDecode(value.wrap.nonce),12,'nonce'),need(b64uDecode(value.wrap.ct),48,'ciphertext'),utf8(info))
}
export function browserPublic(seed: string): string { return b64uEncode(ed25519.getPublicKey(need(b64uDecode(seed),32,'seed'))) }
