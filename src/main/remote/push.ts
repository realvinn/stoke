/*
 * Web Push for the phone's installed shell, with node:crypto and nothing else.
 *
 * A push is two standards and a POST. VAPID (RFC 8292) proves to the push
 * service — Google's, Mozilla's, Apple's — that the sender holds the private
 * half of the key the phone subscribed with: an ES256 JWT for the service's
 * origin, and the public key beside it. The message (RFC 8291 over RFC 8188's
 * `aes128gcm`) is encrypted to the subscription's own P-256 key and auth
 * secret, so the service carries bytes it cannot read. Both fit in this file,
 * so there is no `web-push` dependency to load (gotcha 40): `node:crypto` is a
 * builtin. `verify:remote` holds the encryption to RFC 8291's own Appendix A
 * vector, byte for byte, and the JWT to a signature check with the public key.
 *
 * What is sent is content-free by design (`pushPayload`, remotePhone.ts): a
 * project name and "Needs you" or "Finished", never a prompt, a line of output
 * or a path. Where it may be sent is `pushSubscriptionFrom`'s allowlist of the
 * real push services — a phone key must not turn this machine into something
 * that POSTs to any address it is given.
 *
 * No `electron` import: a suite runs every function here.
 */
import { createCipheriv, createECDH, createPrivateKey, hkdfSync, randomBytes, sign } from 'node:crypto'
import type { PushPayload } from '../../shared/remotePhone.ts'
import type { PushSubscriptionRecord } from '../../shared/types.ts'

/** The VAPID pair as stored: base64url, the public key a 65-byte uncompressed P-256 point, the private its 32-byte scalar. */
export interface VapidKeys {
  publicKey: string
  privateKey: string
}

/**
 * Who the JWT says is sending. Apple's service refuses a `sub` that is neither
 * `mailto:` nor an `https:` URL (and has refused `mailto:` at `localhost`), so
 * it is the project's own page.
 */
export const VAPID_SUBJECT = 'https://stoke.vinn.dev'

/** How long a push may wait at the service for a phone that is off, in seconds. */
export const PUSH_TTL_S = 3600

/** A JWT is good for at most a day (RFC 8292 §2); half of that is plenty for one send. */
const JWT_LIFETIME_S = 12 * 3600

/** One POST's deadline: a push service that hangs must not hold the next pass's sends. */
const SEND_TIMEOUT_MS = 10_000

/** Mint a VAPID pair. Only the remote server's start paths call this (gotcha 53). */
export function generateVapidKeys(): VapidKeys {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return { publicKey: ecdh.getPublicKey().toString('base64url'), privateKey: pad32(ecdh.getPrivateKey()).toString('base64url') }
}

/** Whether a stored pair is whole: a 65-byte point that the 32-byte scalar actually produces. */
export function isVapidPair(keys: VapidKeys | null | undefined): keys is VapidKeys {
  if (!keys?.publicKey || !keys.privateKey) return false
  try {
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(Buffer.from(keys.privateKey, 'base64url'))
    return ecdh.getPublicKey().toString('base64url') === keys.publicKey
  } catch {
    return false
  }
}

/** A scalar with its leading zero bytes put back, as JWK's `d` needs. */
function pad32(b: Buffer): Buffer {
  return b.length >= 32 ? b : Buffer.concat([Buffer.alloc(32 - b.length), b])
}

/** The ES256 JWT a push service checks (RFC 8292 §2), signed for `endpoint`'s origin. */
export function vapidJwt(endpoint: string, keys: VapidKeys, nowS: number, subject = VAPID_SUBJECT): string {
  const pub = Buffer.from(keys.publicKey, 'base64url')
  const key = createPrivateKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: pub.subarray(1, 33).toString('base64url'),
      y: pub.subarray(33, 65).toString('base64url'),
      d: pad32(Buffer.from(keys.privateKey, 'base64url')).toString('base64url')
    },
    format: 'jwk'
  })
  const part = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url')
  const data = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({ aud: new URL(endpoint).origin, exp: nowS + JWT_LIFETIME_S, sub: subject })}`
  // IEEE P1363 (r || s), which JWS requires — never DER.
  const sig = sign('sha256', Buffer.from(data), { key, dsaEncoding: 'ieee-p1363' })
  return `${data}.${sig.toString('base64url')}`
}

/** The `Authorization` header of RFC 8292 §3. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowS: number): string {
  return `vapid t=${vapidJwt(endpoint, keys, nowS)}, k=${keys.publicKey}`
}

/**
 * One `aes128gcm` message to one subscription (RFC 8291 §3.4, RFC 8188 §2): a
 * single record, the header carrying the salt, a 4096 record size and this
 * message's own ephemeral public key. `fixed` exists for the RFC's test
 * vector; every real send makes a fresh salt and key.
 */
export function encryptPush(
  plaintext: Uint8Array,
  sub: { p256dh: string; auth: string },
  fixed?: { salt: Buffer; privateKey: Buffer }
): Buffer {
  const uaPublic = Buffer.from(sub.p256dh, 'base64url')
  const authSecret = Buffer.from(sub.auth, 'base64url')
  const ecdh = createECDH('prime256v1')
  if (fixed) ecdh.setPrivateKey(fixed.privateKey)
  else ecdh.generateKeys()
  const asPublic = ecdh.getPublicKey()
  const shared = ecdh.computeSecret(uaPublic)
  const salt = fixed?.salt ?? randomBytes(16)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  // 0x02: the last (and only) record's delimiter, no padding.
  const body = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(4096, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, body])
}

/** What became of one send, in the terms the store acts on. */
export type PushOutcome = 'sent' | 'gone' | 'failed'

export type PushFetch = (url: string, init: { method: string; headers: Record<string, string>; body: Uint8Array; signal: AbortSignal }) => Promise<{ status: number }>

/**
 * POST one payload to one subscription. `gone` (404, 410: the phone
 * unsubscribed or the browser dropped it) tells the caller to forget the
 * subscription; anything else that is not 2xx is `failed` and kept — a
 * service having a bad minute is not the phone leaving.
 */
export async function sendPush(
  sub: PushSubscriptionRecord,
  payload: PushPayload,
  keys: VapidKeys,
  opts: { fetch?: PushFetch; nowS?: number; urgency?: 'high' | 'normal' } = {}
): Promise<PushOutcome> {
  const doFetch: PushFetch = opts.fetch ?? ((url, init) => fetch(url, init))
  const body = encryptPush(Buffer.from(JSON.stringify(payload)), sub)
  try {
    const res = await doFetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthorization(sub.endpoint, keys, opts.nowS ?? Math.floor(Date.now() / 1000)),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(PUSH_TTL_S),
        Urgency: opts.urgency ?? 'normal'
      },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS)
    })
    if (res.status >= 200 && res.status < 300) return 'sent'
    return res.status === 404 || res.status === 410 ? 'gone' : 'failed'
  } catch {
    return 'failed'
  }
}
