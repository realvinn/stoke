/*
 * Sealing and opening a `.stoke-setup` file: scrypt for the key, AES-256-GCM
 * for the contents, node:crypto only — no dependency, and the same primitives
 * the auth-hub design picks for every later phase (design §6.1).
 *
 * The format, the merge and the preview are in `src/shared/setupFile.ts`; this
 * is only the part that needs Node. No `electron` import, so
 * `scripts/verify-secrets.mts` round-trips real files through it.
 *
 * Probed inside Electron 43 on macOS before relying on it (Electron builds
 * Node's crypto on BoringSSL, where not every OpenSSL primitive exists):
 * `scrypt` at N = 2^17, r = 8 ran in ~515 ms and `aes-256-gcm` is listed.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb } from 'node:crypto'
import {
  headerAad,
  KDF_MEM_MAX,
  parseSetupEnvelope,
  parseSetupPayload,
  SETUP_AEAD,
  SETUP_FORMAT,
  SETUP_KDF_DEFAULTS,
  SETUP_VERSION,
  type SetupEnvelope,
  type SetupHeader,
  type SetupPayload,
  type SetupRefusal
} from '../shared/setupFile.ts'

const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const SALT_BYTES = 16

function deriveKey(passphrase: string, salt: Buffer, N: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    // NFC, so the same passphrase typed on a Mac (which may hand back NFD) and
    // on Windows derives the same key.
    scryptCb(passphrase.normalize('NFC'), salt, KEY_BYTES, { N, r, p, maxmem: KDF_MEM_MAX + 16 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  })
}

export interface SealOptions {
  /** Test seams only; a real export always takes fresh random bytes and the defaults. */
  salt?: Buffer
  nonce?: Buffer
  N?: number
  r?: number
  p?: number
}

/** Seal a payload under a passphrase. Returns the file's text. */
export async function sealSetup(payload: SetupPayload, passphrase: string, opts: SealOptions = {}): Promise<string> {
  const salt = opts.salt ?? randomBytes(SALT_BYTES)
  const nonce = opts.nonce ?? randomBytes(NONCE_BYTES)
  const header: SetupHeader = {
    format: SETUP_FORMAT,
    v: SETUP_VERSION,
    kdf: {
      alg: SETUP_KDF_DEFAULTS.alg,
      N: opts.N ?? SETUP_KDF_DEFAULTS.N,
      r: opts.r ?? SETUP_KDF_DEFAULTS.r,
      p: opts.p ?? SETUP_KDF_DEFAULTS.p,
      salt: salt.toString('base64')
    },
    aead: SETUP_AEAD,
    nonce: nonce.toString('base64')
  }
  const key = await deriveKey(passphrase, salt, header.kdf.N, header.kdf.r, header.kdf.p)
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
  cipher.setAAD(Buffer.from(headerAad(header), 'utf8'))
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final(), cipher.getAuthTag()])
  const envelope: SetupEnvelope = { ...header, ciphertext: body.toString('base64') }
  return `${JSON.stringify(envelope, null, 2)}\n`
}

export type OpenResult =
  | { ok: true; payload: SetupPayload }
  | { ok: false; reason: SetupRefusal; message: string }

/**
 * Open a setup file. Every refusal is a sentence the import can show as is.
 *
 * A wrong passphrase and a changed byte are the SAME failure to GCM — the tag
 * does not match — and are reported as one, honestly, rather than guessing
 * which it was.
 */
export async function openSetup(text: string, passphrase: string): Promise<OpenResult> {
  const parsed = parseSetupEnvelope(text)
  if (!parsed.ok) return parsed
  const env = parsed.envelope
  const salt = Buffer.from(env.kdf.salt, 'base64')
  const nonce = Buffer.from(env.nonce, 'base64')
  const body = Buffer.from(env.ciphertext, 'base64')
  if (salt.length < SALT_BYTES || nonce.length !== NONCE_BYTES || body.length <= TAG_BYTES) {
    return { ok: false, reason: 'damaged', message: 'That setup file is damaged.' }
  }
  let key: Buffer
  try {
    key = await deriveKey(passphrase, salt, env.kdf.N, env.kdf.r, env.kdf.p)
  } catch (err) {
    return {
      ok: false,
      reason: 'unknown-kdf',
      message: `This Stoke could not run the file's key derivation (${err instanceof Error ? err.message : String(err)}).`
    }
  }
  let plain: string
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES })
    decipher.setAAD(Buffer.from(headerAad(env), 'utf8'))
    decipher.setAuthTag(body.subarray(body.length - TAG_BYTES))
    plain = Buffer.concat([decipher.update(body.subarray(0, body.length - TAG_BYTES)), decipher.final()]).toString('utf8')
  } catch {
    return {
      ok: false,
      reason: 'wrong-passphrase',
      message: 'Wrong passphrase — or the file was changed after it was made. Nothing was imported.'
    }
  }
  const payload = parseSetupPayload(plain)
  if (!payload) {
    return { ok: false, reason: 'damaged', message: 'That setup file opened but holds nothing Stoke can read.' }
  }
  return { ok: true, payload }
}

/** `stoke-setup-2026-09-30.stoke-setup`: the date, so two exports never collide by name. */
export function defaultSetupName(now: Date): string {
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  return `stoke-setup-${d}.stoke-setup`
}
