/*
 * Stoke Hub's contract: the pure modules in src/shared/hub/ run against the
 * node:crypto reference in src/main/hub/crypto.ts, and pinned test vectors.
 *
 * Nothing here touches the network, a Keychain, a real ~/.ssh or a real
 * settings file: every input is synthetic (gotcha 74), and the only crypto is
 * node:crypto on bytes this file makes. The vectors at the end are the point
 * of the suite as much as the checks: every label and byte layout is part of
 * every wrap and item already sealed on a hub, so a changed string must fail
 * HERE, loudly, before it strands anybody's data.
 *
 *   node scripts/verify-hub.mts
 *   node scripts/verify-hub.mts --print-vectors   # after a deliberate v2
 */
import { createCipheriv } from 'node:crypto'
import { DEFAULT_SETTINGS, hydrateSettings } from '../src/main/settingsSchema.ts'
import {
  bodyDigest,
  deviceKeysFromSeeds,
  generateDeviceKeys,
  hashPassword,
  itemIdFor,
  itemKeys,
  newVaultKey,
  nodeChainCrypto,
  openItem,
  openRecoveryWrap,
  pairCode,
  pairCommit,
  recoveryKeys,
  relayAccept,
  relayAnswer,
  relayEphemeral,
  relayFinish,
  relayHello,
  relayKeys,
  RelayCipher,
  sealItem,
  sealRecoveryWrap,
  sha256,
  sha256B64u,
  signRequest,
  signText,
  UNMATCHABLE_PASSWORD_HASH,
  unwrapVaultKey,
  verifyPassword,
  verifyRequest,
  verifyText,
  wrapVaultKey,
  type DeviceKeys
} from '../src/main/hub/crypto.ts'
import {
  EMAIL_THROTTLE,
  formatInvite,
  IP_THROTTLE,
  isSessionToken,
  normalizeEmail,
  parseInvite,
  parsePasswordHash,
  passwordProblem,
  recordLoginFailure,
  throttleVerdict,
  type ThrottleState
} from '../src/shared/hub/auth.ts'
import {
  chainLinkText,
  chainSigningText,
  compareToPinned,
  verifyChain,
  wrapsRequiredAfter,
  type ChainEntry,
  type DeviceRecord
} from '../src/shared/hub/chain.ts'
import {
  b64uDecode,
  b64uEncode,
  base32Decode,
  base32Encode,
  canonicalJson,
  checkSymbol,
  HubCodecError,
  idFromBytes,
  isId,
  normalizeBase32,
  stableJson,
  utf8
} from '../src/shared/hub/codec.ts'
import { edgeForwardHeaders, edgeTarget, edgeVerdict, hubEndpoint, hubSocketUrl, hubUrlVerdict, sameSecret } from '../src/shared/hub/edge.ts'
import {
  decideConflict,
  envelopeProblem,
  itemAadText,
  itemPath,
  itemPlaintextText,
  nextEditedAt,
  parseItemPath,
  putVerdict,
  T1_KEYS,
  versionRegression,
  type ItemEnvelope
} from '../src/shared/hub/items.ts'
import { HUB_LABELS } from '../src/shared/hub/labels.ts'
import {
  formatRecoverySecret,
  pairTransition,
  parseRecoverySecret,
  revealProblem,
  sasDigits,
  type PairState
} from '../src/shared/hub/pairing.ts'
import {
  HUB_ERROR_STATUS,
  HUB_HEADERS,
  HUB_ROUTES,
  matchHubRoute,
  parsePresenceServerFrame,
  pathFromV1,
  readHubResponse,
  reconnectDelayMs,
  requestSigningText
} from '../src/shared/hub/protocol.ts'
import {
  parseRelayInner,
  relayFrameVerdict,
  relayNonce,
  relayRouteFor,
  type RelayHs2,
  type RelayInnerFrame
} from '../src/shared/hub/relay.ts'
import {
  applySyncedSettings,
  hostPayloadFor,
  HUB_SETTINGS_DEFAULTS,
  hydrateHubSettings,
  isSafeSshKeyName,
  sshKeyPayloadProblem,
  sshKeyTarget,
  t1ValuesFrom,
  t2ValuesFrom,
  type SyncableHost
} from '../src/shared/hub/settings.ts'
import { LOCAL_KEYS, PARTIAL_KEYS, PORTABLE_KEYS } from '../src/shared/setupFile.ts'
import type { Settings } from '../src/shared/types.ts'

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`))
}
function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`)
}
function throws(name: string, fn: () => unknown): void {
  let threw = false
  try {
    fn()
  } catch {
    threw = true
  }
  ok(name, threw, 'did not throw')
}

/** Deterministic bytes for fixtures and vectors: `n` bytes, each `(seed + i*7) & 255`. */
function bytes(n: number, seed: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (seed + i * 7) & 255)
}

const PRINT_VECTORS = process.argv.includes('--print-vectors')

/* ================================================================ codec */

console.log('\ncodec: base64url')
{
  let same = 0
  for (let n = 0; n <= 40; n++) {
    const b = bytes(n, n * 13)
    const enc = b64uEncode(b)
    const dec = b64uDecode(enc)
    if (enc === Buffer.from(b).toString('base64url') && dec && Buffer.from(dec).equals(Buffer.from(b))) same++
  }
  check('0..40 bytes encode exactly as node base64url and round-trip', same, 41)
  check('padding is refused', b64uDecode('AA=='), null)
  check('the standard alphabet is refused', b64uDecode('+/+/'), null)
  check('a length of 4n+1 is refused', b64uDecode('AAAAA'), null)
  check('non-zero padding bits are refused (one spelling per value)', b64uDecode('AB'), null)
  ok('the canonical spelling of that byte is accepted', b64uDecode('AA')?.length === 1)
}

console.log('\ncodec: Crockford base32')
{
  let round = 0
  for (let n = 1; n <= 20; n++) {
    const b = bytes(n, n * 31)
    const d = base32Decode(base32Encode(b), n)
    if (d && Buffer.from(d).equals(Buffer.from(b))) round++
  }
  check('1..20 bytes round-trip', round, 20)
  check('eight zero bytes', base32Encode(new Uint8Array(5)), '00000000')
  check('0xff×5 is all Z', base32Encode(new Uint8Array(5).fill(255)), 'ZZZZZZZZ')
  check('look-alikes read as Crockford says', normalizeBase32('o1-il lo'), '011110')
  check('U is not a data character', base32Decode('U0', 1), null)
  let checks = 0
  for (let n = 1; n <= 24; n++) {
    const b = bytes(n, n * 5 + 3)
    const want = Number(BigInt(`0x${Buffer.from(b).toString('hex')}`) % 37n)
    const sym = checkSymbol(b)
    const got = '0123456789ABCDEFGHJKMNPQRSTVWXYZ*~$=U'.indexOf(sym)
    if (got === want) checks++
  }
  check('the check symbol is the value mod 37 (checked against BigInt)', checks, 24)
}

console.log('\ncodec: canonical JSON')
{
  check('keys sorted at every depth, no whitespace', canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x' } }), '{"a":{"c":"x","d":[3,{"y":2,"z":1}]},"b":1}')
  check('an undefined property is omitted, as JSON.stringify does', canonicalJson({ a: undefined, b: null }), '{"b":null}')
  check('undefined in an array is null, as JSON.stringify does', canonicalJson([undefined, 1]), '[null,1]')
  check('strings escape exactly as JSON.stringify', canonicalJson({ s: 'q"\\\n é🔥' }), `{"s":${JSON.stringify('q"\\\n é🔥')}}`)
  throws('NaN throws (stringify would write null)', () => canonicalJson({ a: NaN }))
  throws('Infinity throws', () => canonicalJson([Infinity]))
  throws('a Date throws', () => canonicalJson({ d: new Date(0) }))
  throws('a bigint throws', () => canonicalJson({ n: 1n }))
  throws('a function throws', () => canonicalJson({ f: () => 1 }))
  throws('undefined at the top throws', () => canonicalJson(undefined))
  ok('what it throws is a HubCodecError', (() => { try { canonicalJson(NaN) } catch (e) { return e instanceof HubCodecError } return false })())
  const v = { z: [1, 2.5, 'x', { k: true }], a: '' }
  check('a round trip through JSON.parse is a fixed point', canonicalJson(JSON.parse(canonicalJson(v))), canonicalJson(v))
  ok('stableJson never throws, and a broken value never equals a good one', stableJson({ a: NaN }) !== stableJson({ a: null }))
  check('stableJson ignores key order', stableJson({ a: 1, b: 2 }) === stableJson({ b: 2, a: 1 }), true)
}

console.log('\ncodec: ids')
{
  const d = idFromBytes('device', bytes(10, 1))
  ok('a device id is d + 16 lower-case Crockford characters', /^d[0-9a-z]{16}$/.test(d) && isId('device', d), d)
  check('an id of one kind is not another kind', isId('account', d), false)
  check('upper case is not an id', isId('device', d.toUpperCase()), false)
  check('i, l, o and u never appear in an id', ['di000000000000000', 'dl000000000000000', 'do000000000000000', 'du000000000000000'].some((x) => isId('device', x)), false)
  throws('the wrong byte count throws', () => idFromBytes('relay', bytes(10, 1)))
  ok('a host SYNC id starts with h', isId('host', idFromBytes('host', bytes(10, 9))))
}

/* =============================================================== labels */

console.log('\nlabels')
{
  const all = Object.values(HUB_LABELS)
  check('every label is distinct', new Set(all).size, all.length)
  check('every label is stoke-hub/v1/…', all.every((l) => /^stoke-hub\/v1\/[a-z0-9-]+$/.test(l)), true)
  check('no label is a prefix of another (a text for one can never read as another)', all.some((a) => all.some((b) => a !== b && b.startsWith(`${a}\n`))), false)
}

/* ================================================================= auth */

console.log('\nauth: email, password, invites, tokens')
{
  check('an email is trimmed and lower-cased', normalizeEmail('  Vinh@Example.COM '), 'vinh@example.com')
  check('no @ is not an email', normalizeEmail('vinh.example.com'), null)
  check('no dot after the @ is not an email', normalizeEmail('vinh@localhost'), null)
  check('a space inside is not an email', normalizeEmail('vi nh@example.com'), null)
  check('255 characters is too long', normalizeEmail(`${'a'.repeat(243)}@example.com`), null)
  ok('11 characters is too short', passwordProblem('abcdefghijk') !== null)
  check('12 characters is enough', passwordProblem('abcdefghijkl'), null)
  ok('twelve spaces is not a password', passwordProblem(' '.repeat(12)) !== null)
  check('length counts code points, not UTF-16 units', passwordProblem('🔥'.repeat(12)), null)
  const inv = formatInvite(bytes(15, 77))
  ok('an invite is INV- and six groups of four', /^INV(-[0-9A-HJKMNP-TV-Z]{4}){6}$/.test(inv), inv)
  check('a typed invite is forgiven case, spaces and look-alikes', parseInvite(` ${inv.toLowerCase().replace(/-/g, ' ').replace(/0/g, 'o').replace(/1/g, 'l')} `), inv)
  check('a lower-case prefix is still the prefix (INV normalises to 1NV)', parseInvite(inv.toLowerCase()), inv)
  check('an invite typed without its prefix reads', parseInvite(inv.slice(4)), inv)
  check('a short invite is refused', parseInvite(inv.slice(0, -2)), null)
  check('a session token is sht_ + 32 bytes b64url', isSessionToken(`sht_${b64uEncode(bytes(32, 3))}`), true)
  check('a token of 31 bytes is not one', isSessionToken(`sht_${b64uEncode(bytes(31, 3))}`), false)
}

console.log('\nauth: stored password hashes')
{
  const good = `scrypt$17$8$1$${b64uEncode(bytes(16, 1))}$${b64uEncode(bytes(32, 2))}`
  check('the stored form parses', parsePasswordHash(good)?.log2N, 17)
  check('N = 2^30 is refused before anything asks for 128 GiB', parsePasswordHash(good.replace('$17$', '$30$')), null)
  check('a 15-byte salt is refused', parsePasswordHash(`scrypt$17$8$1$${b64uEncode(bytes(15, 1))}$${b64uEncode(bytes(32, 2))}`), null)
  check('another algorithm is refused', parsePasswordHash(good.replace('scrypt', 'argon2')), null)
  ok('the unmatchable hash is well formed', parsePasswordHash(UNMATCHABLE_PASSWORD_HASH) !== null)
  const fast = await hashPassword('correct horse battery staple', { log2N: 14 })
  check('a hash verifies its own password', await verifyPassword('correct horse battery staple', fast), true)
  check('and refuses another', await verifyPassword('correct horse battery stable', fast), false)
  check('NFC and NFD spellings of one password are the same password', await verifyPassword('café horse battery', await hashPassword('café horse battery', { log2N: 14 })), true)
  check('no password matches the unmatchable hash', await verifyPassword('', UNMATCHABLE_PASSWORD_HASH), false)
  const t = Date.now()
  const full = await hashPassword('the shipped parameters once')
  ok('the shipped parameters (2^17, r 8, p 1) run under node’s maxmem', full.startsWith('scrypt$17$8$1$'), full)
  console.log(`        (one scrypt at 2^17 took ${Date.now() - t} ms here)`)
}

console.log('\nauth: throttle')
{
  const t0 = 1_000_000
  let s: ThrottleState | null = null
  for (let i = 0; i < 4; i++) s = recordLoginFailure(s, t0 + i, EMAIL_THROTTLE)
  check('four failures leave the email open', throttleVerdict(s, t0 + 5).ok, true)
  s = recordLoginFailure(s, t0 + 5, EMAIL_THROTTLE)
  const locked = throttleVerdict(s, t0 + 6)
  check('the fifth locks it', locked.ok, false)
  check('for 15 minutes', locked.ok ? 0 : locked.retryAfterMs, 15 * 60_000 - 1)
  const after = t0 + 5 + 15 * 60_000
  check('the lock ends when it says', throttleVerdict(s, after).ok, true)
  for (let i = 0; i < 5; i++) s = recordLoginFailure(s, after + i, EMAIL_THROTTLE)
  const second = throttleVerdict(s, after + 5)
  check('a second lockout lasts twice as long', second.ok ? 0 : second.retryAfterMs, 30 * 60_000 - 1)
  let q: ThrottleState | null = null
  for (let i = 0; i < 20; i++) q = recordLoginFailure(q, t0 + i * 10_000, EMAIL_THROTTLE)
  const capped = recordLoginFailure({ failures: 4, firstAt: t0, lockedUntil: 0, lockouts: 10, lastAt: t0 }, t0 + 1, EMAIL_THROTTLE)
  check('lockouts double only up to 24 hours', capped.lockedUntil - (t0 + 1), 24 * 60 * 60_000)
  const forgotten = recordLoginFailure({ failures: 0, firstAt: t0, lockedUntil: t0 + 1, lockouts: 5, lastAt: t0 }, t0 + 25 * 60 * 60_000, EMAIL_THROTTLE)
  check('a day with no failure forgets past lockouts', forgotten.lockouts, 0)
  let windowed: ThrottleState | null = null
  for (let i = 0; i < 4; i++) windowed = recordLoginFailure(windowed, t0 + i * 5 * 60_000, EMAIL_THROTTLE)
  windowed = recordLoginFailure(windowed, t0 + 16 * 60_000, EMAIL_THROTTLE)
  check('failures spread past the 15-minute window never lock', throttleVerdict(windowed, t0 + 16 * 60_000 + 1).ok, true)
  let ip: ThrottleState | null = null
  for (let i = 0; i < 29; i++) ip = recordLoginFailure(ip, t0 + i, IP_THROTTLE)
  check('an IP takes 29 failures', throttleVerdict(ip, t0 + 30).ok, true)
  ip = recordLoginFailure(ip, t0 + 30, IP_THROTTLE)
  check('and the 30th blocks it', throttleVerdict(ip, t0 + 31).ok, false)
}

/* ================================================================ chain */

const ACCOUNT = idFromBytes('account', bytes(10, 200))
function device(keys: DeviceKeys, idSeed: number, label: string, platform = 'darwin'): DeviceRecord {
  return { id: idFromBytes('device', bytes(10, idSeed)), label, platform, sign: keys.signPub, box: keys.boxPub, caps: ['vault', 'remote-host', 'remote-guest'], addedAt: 1_700_000_000_000 }
}
const KA = deviceKeysFromSeeds(bytes(32, 1), bytes(32, 2))
const KB = deviceKeysFromSeeds(bytes(32, 3), bytes(32, 4))
const KC = deviceKeysFromSeeds(bytes(32, 5), bytes(32, 6))
const DA = device(KA, 11, 'Mac')
const DB = device(KB, 12, 'Windows PC', 'win32')
const DC = device(KC, 13, 'Linux box', 'linux')
const RS1 = bytes(16, 90)
const RS2 = bytes(16, 91)
const R1 = recoveryKeys(RS1, ACCOUNT)
const R2 = recoveryKeys(RS2, ACCOUNT)

function entry(prev: ChainEntry | null, fields: Omit<ChainEntry, 'v' | 'account' | 'seq' | 'prev' | 'ts' | 'sig'>, signPriv: string): ChainEntry {
  const bare: Omit<ChainEntry, 'sig'> = {
    v: 1,
    account: ACCOUNT,
    seq: prev ? prev.seq + 1 : 0,
    prev: prev ? sha256B64u(chainLinkText(prev)) : '',
    ts: 1_700_000_000_000 + (prev ? prev.seq + 1 : 0),
    ...fields
  }
  return { ...bare, sig: signText(signPriv, chainSigningText(bare)) }
}

const g0 = entry(null, { kind: 'genesis', epoch: 1, signer: DA.id, device: DA, recovery: R1.signPub }, KA.signPriv)
const e1 = entry(g0, { kind: 'add', epoch: 1, signer: DA.id, device: DB }, KA.signPriv)
const e2 = entry(e1, { kind: 'revoke', epoch: 2, signer: DA.id, target: DB.id }, KA.signPriv)
const e3 = entry(e2, { kind: 'rotate', epoch: 3, signer: 'recovery', recovery: R2.signPub }, R1.signPriv)
const e4 = entry(e3, { kind: 'add', epoch: 3, signer: 'recovery', device: DC }, R2.signPriv)
const CHAIN = [g0, e1, e2, e3, e4]

console.log('\nchain: a real chain verifies')
{
  const v = verifyChain(CHAIN, nodeChainCrypto, { account: ACCOUNT })
  ok('genesis, add, revoke, rotate by recovery, add by the new recovery key', v.ok, v.ok ? '' : `${v.at}: ${v.reason}`)
  if (v.ok) {
    check('active after it all', v.active.map((d) => d.label), ['Mac', 'Linux box'])
    check('revoked', v.revoked, [DB.id])
    check('epoch', v.epoch, 3)
    check('the recovery key in force is the rotated one', v.recovery, R2.signPub)
    check('the head is the last link', v.head, sha256B64u(chainLinkText(e4)))
    check('wraps a revoke/rotate must carry: every active vault device', wrapsRequiredAfter(v), [DA.id, DC.id])
  }
}

console.log('\nchain: what the hub cannot do')
{
  const fail = (name: string, entries: unknown[], reason: string): void => {
    const v = verifyChain(entries, nodeChainCrypto, { account: ACCOUNT })
    check(name, v.ok ? 'verified' : v.reason, reason)
  }
  const KX = deviceKeysFromSeeds(bytes(32, 40), bytes(32, 41))
  const DX = device(KX, 44, 'Hub’s own device')
  fail('add its own device, signed by its own key', [g0, entry(g0, { kind: 'add', epoch: 1, signer: DX.id, device: DX }, KX.signPriv)], 'signer is not active')
  fail('add its own device, claiming the Mac signed it', [g0, entry(g0, { kind: 'add', epoch: 1, signer: DA.id, device: DX }, KX.signPriv)], 'bad signature')
  fail('edit an entry after signing (a label)', [g0, { ...e1, device: { ...DB, label: 'Renamed' } }], 'bad signature')
  fail('drop an entry from the middle', [g0, e2], 'seq out of order')
  fail('splice with a re-numbered entry', [g0, { ...e2, seq: 1 }], 'prev does not link')
  fail('a revoked device signs afterwards', [g0, e1, e2, entry(e2, { kind: 'add', epoch: 2, signer: DB.id, device: DX }, KB.signPriv)], 'signer is not active')
  fail('the OLD recovery key after a rotate', [...CHAIN, entry(e4, { kind: 'add', epoch: 3, signer: 'recovery', device: DX }, R1.signPriv)], 'bad signature')
  fail('re-add a revoked id', [g0, e1, e2, entry(e2, { kind: 'add', epoch: 2, signer: DA.id, device: DB }, KA.signPriv)], 'device id used before')
  fail('one signing key as two devices', [g0, entry(g0, { kind: 'add', epoch: 1, signer: DA.id, device: { ...DX, sign: KA.signPub } }, KA.signPriv)], 'signing key used before')
  fail('a revoke that keeps the epoch', [g0, e1, entry(e1, { kind: 'revoke', epoch: 1, signer: DA.id, target: DB.id }, KA.signPriv)], 'revoke must increment the epoch')
  fail('an add that moves the epoch', [g0, entry(g0, { kind: 'add', epoch: 2, signer: DA.id, device: DB }, KA.signPriv)], 'add changed the epoch')
  fail('a genesis signed by somebody else', [entry(null, { kind: 'genesis', epoch: 1, signer: DA.id, device: DA, recovery: R1.signPub }, KB.signPriv)], 'bad signature')
  fail('a genesis that is not self-signed', [entry(null, { kind: 'genesis', epoch: 1, signer: DB.id, device: DA, recovery: R1.signPub }, KB.signPriv)], 'genesis is not self-signed')
  fail('a second genesis', [g0, entry(g0, { kind: 'genesis', epoch: 1, signer: DX.id, device: DX, recovery: R1.signPub }, KX.signPriv)], 'second genesis')
  fail('another account’s chain', [{ ...g0, account: idFromBytes('account', bytes(10, 201)) }], 'another account')
  fail('an unknown field', [{ ...g0, extra: 1 }], 'unknown field')
  fail('a float timestamp', [{ ...g0, ts: 1.5 }], 'bad ts')
  fail('an empty chain', [], 'empty chain')
  fail('a device record with the same bytes for both keys', [entry(null, { kind: 'genesis', epoch: 1, signer: DA.id, device: { ...DA, box: DA.sign }, recovery: R1.signPub }, KA.signPriv)], 'device: signing and box keys are the same bytes')
}

console.log('\nchain: pinning')
{
  const v = verifyChain(CHAIN, nodeChainCrypto)
  const links = v.ok ? v.links : []
  check('nothing pinned yet', compareToPinned(null, links), 'new')
  check('pinned at the head', compareToPinned({ seq: 4, head: links[4] }, links), 'same')
  check('the chain grew', compareToPinned({ seq: 2, head: links[2] }, links), 'extends')
  check('the hub served a shorter chain', compareToPinned({ seq: 4, head: links[4] }, links.slice(0, 3)), 'rollback')
  check('the hub served a different entry at a pinned seq', compareToPinned({ seq: 2, head: 'x'.repeat(43) }, links), 'fork')
  check('the link hash is the digest verifyChain used', nodeChainCrypto.digest(chainLinkText(e1)), links[1])
}

/* ================================================================ vault */

console.log('\nvault key wrapped to a device')
{
  const vk = newVaultKey()
  const f = { account: ACCOUNT, epoch: 3, device: DC.id }
  const wrap = wrapVaultKey(vk, { ...f, boxPub: KC.boxPub })
  const back = unwrapVaultKey(wrap, { ...f, boxPriv: KC.boxPriv })
  ok('the device it was wrapped to opens it', !!back && Buffer.from(back).equals(Buffer.from(vk)))
  check('another device’s key does not', unwrapVaultKey(wrap, { ...f, boxPriv: KA.boxPriv }), null)
  check('the same key under another device id does not (id is bound)', unwrapVaultKey(wrap, { ...f, device: DA.id, boxPriv: KC.boxPriv }), null)
  check('another epoch does not', unwrapVaultKey(wrap, { ...f, epoch: 2, boxPriv: KC.boxPriv }), null)
  check('another account does not', unwrapVaultKey(wrap, { ...f, account: idFromBytes('account', bytes(10, 1)), boxPriv: KC.boxPriv }), null)
  const ct = b64uDecode(wrap.ct) as Uint8Array
  ct[0] ^= 1
  check('a flipped byte does not', unwrapVaultKey({ ...wrap, ct: b64uEncode(ct) }, { ...f, boxPriv: KC.boxPriv }), null)
  throws('wrapping to an all-zero (low-order) key throws', () => wrapVaultKey(vk, { ...f, boxPub: b64uEncode(new Uint8Array(32)) }))
  check('a malformed wrap is null, never a throw', unwrapVaultKey({ v: 1, eph: 'x', nonce: '', ct: '' }, { ...f, boxPriv: KC.boxPriv }), null)
}

console.log('\nthe Recovery Kit')
{
  const kit = formatRecoverySecret(RS1)
  ok('RK1- then seven groups (26 characters and a check)', /^RK1(-[0-9A-HJKMNP-TV-Z*~$=U]{1,4}){7}$/.test(kit), kit)
  const typed = parseRecoverySecret(kit.toLowerCase().replace(/-/g, '  ').replace(/0/g, 'O').replace(/1/g, 'I'))
  ok('typed back with case, spaces and look-alikes, it reads', typed.ok && Buffer.from(typed.secret).equals(Buffer.from(RS1)))
  const body = kit.replace(/^RK1-/, '').replace(/-/g, '')
  const bare = parseRecoverySecret(body)
  ok('typed without its prefix, it reads', bare.ok && Buffer.from(bare.secret).equals(Buffer.from(RS1)))
  const typo = body.slice(0, 5) + (body[5] === 'A' ? 'B' : 'A') + body.slice(6)
  const bad = parseRecoverySecret(typo)
  check('one wrong character is a typo, caught before any key', bad.ok ? 'read' : bad.problem, 'check')
  check('a missing character is a length problem', (() => { const r = parseRecoverySecret(body.slice(1)); return r.ok ? 'read' : r.problem })(), 'length')
  const again = recoveryKeys(RS1, ACCOUNT)
  check('the same secret and account give the same keys', again.signPub, R1.signPub)
  ok('another account gives other keys', recoveryKeys(RS1, idFromBytes('account', bytes(10, 5))).signPub !== R1.signPub)
  const vk = newVaultKey()
  const w = sealRecoveryWrap(vk, R1.wrapKey, { account: ACCOUNT, epoch: 1 })
  ok('the Kit opens its wrap', Buffer.from(openRecoveryWrap(w, R1.wrapKey, { account: ACCOUNT, epoch: 1 }) ?? []).equals(Buffer.from(vk)))
  check('another epoch’s wrap does not open as this one', openRecoveryWrap(w, R1.wrapKey, { account: ACCOUNT, epoch: 2 }), null)
  check('another Kit does not', openRecoveryWrap(w, R2.wrapKey, { account: ACCOUNT, epoch: 1 }), null)
  ok('the recovery signing key signs as the chain expects', verifyText(R1.signPub, 'x', signText(R1.signPriv, 'x')))
}

/* ================================================================ items */

console.log('\nitems: paths')
{
  const hostId = idFromBytes('host', bytes(10, 3))
  const keyId = idFromBytes('sshKey', bytes(10, 4))
  check('a T1 setting', parseItemPath('t1/settings/themeId'), { tier: 't1', kind: 'settings', key: 'themeId' })
  check('the wallpaper block (partial)', parseItemPath('t1/settings/wallpaper')?.tier, 't1')
  check('hosts are not T1 (each host is T3)', parseItemPath('t1/settings/hosts'), null)
  check('a machine-local setting is not a path at all', parseItemPath('t1/settings/projectRoots'), null)
  check('a portable key', parseItemPath('t2/secret/providers.anthropicApiKey')?.tier, 't2')
  check('an agent endpoint key', parseItemPath('t2/secret/agents.endpoints.codex.apiKey')?.tier, 't2')
  check('the phone access key can never be addressed', parseItemPath('t2/secret/remote.token'), null)
  check('nor the VAPID private key', parseItemPath('t2/secret/remote.push.vapidPrivate'), null)
  check('nor an account’s machine-local key', parseItemPath('t2/secret/accounts.work.apiKey'), null)
  check('nor a path through __proto__', parseItemPath('t2/secret/agents.endpoints.__proto__.apiKey'), null)
  check('a host by SYNC id', parseItemPath(`t3/host/${hostId}`)?.tier, 't3')
  check('a host by its per-machine counter id is refused', parseItemPath('t3/host/host-1'), null)
  check('an SSH key', parseItemPath(`t4/ssh-key/${keyId}`)?.tier, 't4')
  check('the account’s sync-keys switch', parseItemPath('acct/pref/sync-keys')?.tier, 'acct')
  check('traversal is not a path', parseItemPath('t1/settings/../settings/themeId'), null)
  check('an empty name is not a path', parseItemPath('t1/settings/'), null)
  check('itemPath inverts parseItemPath', ['t1/settings/themeId', `t3/host/${hostId}`, 't2/secret/voice.keys.openai', 'acct/pref/sync-keys'].every((p) => { const q = parseItemPath(p); return q && itemPath(q) === p }), true)
}

console.log('\nitems: T1 is the portable half of the settings partition')
{
  const want = [...PORTABLE_KEYS.filter((k) => k !== 'hosts'), ...Object.keys(PARTIAL_KEYS)].sort()
  check('T1_KEYS = PORTABLE_KEYS − hosts + PARTIAL blocks', [...T1_KEYS].sort(), want)
  check('no T1 key is machine-local', T1_KEYS.filter((k) => (LOCAL_KEYS as readonly string[]).includes(k)), [])
  check('every T1 key exists in DEFAULT_SETTINGS', T1_KEYS.filter((k) => !(k in DEFAULT_SETTINGS)), [])
  check('t1ValuesFrom gives exactly the T1 keys', Object.keys(t1ValuesFrom(DEFAULT_SETTINGS)).sort(), [...T1_KEYS].sort())
  const withKey = hydrateSettings({ providers: { anthropicApiKey: 'sk-ant-CANARY-hub-1' }, remote: { token: 'phone-CANARY-hub-2' } })
  ok('a T1 value never carries a key', !JSON.stringify(t1ValuesFrom(withKey)).includes('CANARY'))
  check('T2 carries the portable key and never the phone key', t2ValuesFrom(withKey), { 'providers.anthropicApiKey': 'sk-ant-CANARY-hub-1' })
}

const VK = bytes(32, 150)
const IK3 = itemKeys(VK, ACCOUNT, 3)

console.log('\nitems: sealing')
{
  const path = 't1/settings/themeId'
  const env = sealItem(IK3, { version: 1, author: DA.id, path, editedAt: 5, deleted: false, value: 'lagoon' })
  check('the envelope is well formed', envelopeProblem(env), null)
  ok('the hub sees no path', !JSON.stringify(env).includes('themeId'))
  const opened = openItem(IK3, env)
  check('it opens to what was sealed', opened.ok ? opened.item : opened.reason, { path, editedAt: 5, deleted: false, value: 'lagoon' })
  check('the id is a pure function of path, account and epoch', itemIdFor(itemKeys(VK, ACCOUNT, 3), path), env.id)
  ok('another epoch puts the same path in another slot', itemIdFor(itemKeys(VK, ACCOUNT, 4), path) !== env.id)
  const reason = (e: ItemEnvelope, keys = IK3): string => { const o = openItem(keys, e); return o.ok ? 'opened' : o.reason }
  check('replayed as another version (version is in the AAD)', reason({ ...env, version: 2 }), 'tag')
  check('moved to another slot', reason({ ...env, id: itemIdFor(IK3, 't1/settings/fontSize') }), 'tag')
  check('relabelled with another author', reason({ ...env, author: DC.id }), 'tag')
  check('served under another epoch', reason({ ...env, epoch: 2 }), 'epoch')
  const ct = b64uDecode(env.ct) as Uint8Array
  ct[ct.length - 1] ^= 0x80
  check('a flipped tag bit', reason({ ...env, ct: b64uEncode(ct) }), 'tag')
  check('another vault key', reason(env, itemKeys(bytes(32, 151), ACCOUNT, 3)), 'tag')
  // A holder of the vault key who seals path A's plaintext into path B's slot:
  const idB = itemIdFor(IK3, 't1/settings/fontSize')
  const nonce = bytes(12, 9)
  const aad = utf8(itemAadText({ account: ACCOUNT, id: idB, version: 1, epoch: 3, author: DA.id }))
  const c = createCipheriv('aes-256-gcm', IK3.sealKey, nonce)
  c.setAAD(aad)
  const forged = Buffer.concat([c.update(utf8(itemPlaintextText({ path, editedAt: 1, deleted: false, value: 'x' }))), c.final(), c.getAuthTag()])
  check('a plaintext whose path does not hash to its slot is refused', reason({ v: 1, id: idB, version: 1, epoch: 3, author: DA.id, nonce: b64uEncode(nonce), ct: b64uEncode(new Uint8Array(forged)) }), 'id')
  const tomb = sealItem(IK3, { version: 2, author: DA.id, path, editedAt: 6, deleted: true, value: 'ignored' })
  const t = openItem(IK3, tomb)
  check('a tombstone opens with a null value', t.ok ? [t.item.deleted, t.item.value] : t.reason, [true, null])
  throws('a value past 128 KiB is refused at seal time', () => sealItem(IK3, { version: 1, author: DA.id, path: 't1/settings/customThemes', editedAt: 1, deleted: false, value: 'x'.repeat(130 * 1024) }))
  throws('a path the grammar refuses is refused at seal time', () => sealItem(IK3, { version: 1, author: DA.id, path: 't2/secret/remote.token', editedAt: 1, deleted: false, value: 'x' }))
  check('an unknown envelope field is refused', envelopeProblem({ ...env, path }), 'unknown field')
  check('a version of 0 is refused', envelopeProblem({ ...env, version: 0 }), 'bad version')
}

console.log('\nitems: the hub’s put rule')
{
  const env = sealItem(IK3, { version: 1, author: DA.id, path: 't1/settings/fontSize', editedAt: 1, deleted: false, value: 14 })
  check('a new item at version 1 on base 0', putVerdict(null, 3, { baseVersion: 0, envelope: env }, DA.id), { ok: true })
  check('a stale base is a conflict', putVerdict({ version: 2 }, 3, { baseVersion: 1, envelope: { ...env, version: 2 } }, DA.id), { ok: false, error: 'conflict' })
  check('a skipped version is invalid', putVerdict(null, 3, { baseVersion: 0, envelope: { ...env, version: 2 } }, DA.id).ok, false)
  check('another epoch is stale-epoch (fetch the new wrap, re-seal)', putVerdict(null, 4, { baseVersion: 0, envelope: env }, DA.id), { ok: false, error: 'stale-epoch' })
  check('an author other than the signing device is invalid', putVerdict(null, 3, { baseVersion: 0, envelope: env }, DC.id), { ok: false, error: 'invalid', reason: 'author is not the signing device' })
  check('a malformed envelope is invalid', putVerdict(null, 3, { baseVersion: 0, envelope: { ...env, nonce: 'x' } }, DA.id), { ok: false, error: 'invalid', reason: 'bad nonce' })
}

console.log('\nitems: clocks and conflicts')
{
  check('the later edit wins', decideConflict({ editedAt: 10, author: DA.id }, { editedAt: 9, author: DC.id }), 'mine')
  check('an earlier edit loses', decideConflict({ editedAt: 9, author: DC.id }, { editedAt: 10, author: DA.id }), 'theirs')
  const [lo, hi] = [DA.id, DC.id].sort()
  check('a tie goes to the larger author id', decideConflict({ editedAt: 10, author: hi }, { editedAt: 10, author: lo }), 'mine')
  let agree = 0
  for (let i = 0; i < 50; i++) {
    const a = { editedAt: i % 7, author: i % 2 ? DA.id : DC.id }
    const b = { editedAt: (i * 3) % 7, author: i % 3 ? DC.id : DA.id }
    if (a.editedAt === b.editedAt && a.author === b.author) { agree++; continue }
    if ((decideConflict(a, b) === 'mine') === (decideConflict(b, a) === 'theirs')) agree++
  }
  check('both devices always reach the same answer', agree, 50)
  check('a clock that steps back still moves forward', nextEditedAt(1000, 5000), 5001)
  check('a normal clock is used as is', nextEditedAt(9000, 5000), 9000)
  check('a served version below the pin is a regression', versionRegression(5, 4), true)
  check('an unseen id is not', versionRegression(undefined, 1), false)
}

/* ============================================================== pairing */

console.log('\npairing: the state machine')
{
  const walk = (events: string[]): PairState | null => {
    let s: PairState | null = 'waiting'
    for (const e of events) s = s && pairTransition(s, e as never)
    return s
  }
  check('waiting → nonce → revealed → approved', walk(['nonce', 'reveal', 'approve']), 'approved')
  check('approve before the reveal is refused', walk(['nonce', 'approve']), null)
  check('a reveal before the nonce is refused (the commitment must come first)', walk(['reveal']), null)
  check('either side may refuse at any open point', walk(['nonce', 'refuse']), 'refused')
  check('nothing moves an approved pair', walk(['nonce', 'reveal', 'approve', 'refuse']), null)
  check('nothing moves an expired pair', walk(['expire', 'nonce']), null)
}

console.log('\npairing: commitment and the six digits')
{
  const nN = b64uEncode(bytes(32, 60))
  const nE = b64uEncode(bytes(32, 61))
  const pair = idFromBytes('pair', bytes(10, 62))
  const commit = pairCommit({ account: ACCOUNT, device: DC, nonce: nN })
  check('an honest reveal matches its commitment', revealProblem({ commit, commitDigest: pairCommit({ account: ACCOUNT, device: DC, nonce: nN }), device: DC, nonce: nN, pendingDevice: DC.id }), null)
  const KX = deviceKeysFromSeeds(bytes(32, 70), bytes(32, 71))
  const swapped = { ...DC, sign: KX.signPub, box: KX.boxPub }
  check('a reveal with substituted keys does not', revealProblem({ commit, commitDigest: pairCommit({ account: ACCOUNT, device: swapped, nonce: nN }), device: swapped, nonce: nN, pendingDevice: DC.id }), 'the reveal does not match the commitment')
  check('a reveal naming another device is refused', revealProblem({ commit, commitDigest: commit, device: DA, nonce: nN, pendingDevice: DC.id }), 'the reveal names another device')
  const onNew = pairCode({ account: ACCOUNT, pair, device: DC, approver: DA, nonceN: nN, nonceE: nE })
  const onOld = pairCode({ account: ACCOUNT, pair, device: DC, approver: DA, nonceN: nN, nonceE: nE })
  ok('both screens show the same six digits', onNew === onOld && /^\d{3} \d{3}$/.test(onNew), onNew)
  let differ = 0
  for (let i = 0; i < 20; i++) {
    const Ki = deviceKeysFromSeeds(bytes(32, 100 + i), bytes(32, 150 + i))
    if (pairCode({ account: ACCOUNT, pair, device: { ...DC, sign: Ki.signPub, box: Ki.boxPub }, approver: DA, nonceN: nN, nonceE: nE }) !== onNew) differ++
  }
  check('a hub that swaps the new device’s keys shows other digits (20 tries)', differ, 20)
  ok('a hub that impersonates the approver shows other digits', pairCode({ account: ACCOUNT, pair, device: DC, approver: { ...DA, sign: KX.signPub, box: KX.boxPub }, nonceN: nN, nonceE: nE }) !== onNew)
  check('digits from a zero digest', sasDigits(new Uint8Array(32)), '000 000')
  check('digits from an all-ones prefix (4294967295 mod 10^6)', sasDigits(new Uint8Array(32).fill(255)), '967 295')
}

/* ================================================================ relay */

console.log('\nrelay: the handshake')
{
  const relay = idFromBytes('relay', bytes(15, 80))
  const gEph = relayEphemeral()
  const hEph = relayEphemeral()
  const hs1 = relayHello({ relay, account: ACCOUNT, guest: DA.id, host: DC.id }, gEph)
  const { hs2, th } = relayAnswer(hs1, hEph, KC.signPriv)
  const fin = relayFinish(hs1, hs2, KC.signPub, KA.signPriv)
  ok('the guest accepts the host it pinned', fin.ok, fin.ok ? '' : fin.reason)
  if (fin.ok) {
    check('both sides hold the same transcript', fin.th, th)
    check('the host accepts the guest it pinned', relayAccept(th, hs2, fin.hs3, KA.signPub), true)
    check('the host refuses a guest key it did not pin', relayAccept(th, hs2, fin.hs3, KB.signPub), false)
    const gk = relayKeys(gEph, hs2.eph, fin.th)
    const hk = relayKeys(hEph, hs1.eph, th)
    ok('both sides derive the same two keys', !!gk && !!hk && Buffer.from(gk.g2h).equals(Buffer.from(hk.g2h)) && Buffer.from(gk.h2g).equals(Buffer.from(hk.h2g)))
    ok('and the two directions differ', !!gk && !Buffer.from(gk.g2h).equals(Buffer.from(gk.h2g)))
    if (gk && hk) {
      const gSend = new RelayCipher(gk.g2h, 'g2h', relay)
      const hRecv = new RelayCipher(hk.g2h, 'g2h', relay)
      const hSend = new RelayCipher(hk.h2g, 'h2g', relay)
      const gRecv = new RelayCipher(gk.h2g, 'h2g', relay)
      const f1 = gSend.seal('{"t":"req","id":1,"method":"GET","path":"/api/sessions"}')
      const f2 = gSend.seal('second')
      check('a frame opens on the other side', Buffer.from(hRecv.open(f1) ?? []).toString(), '{"t":"req","id":1,"method":"GET","path":"/api/sessions"}')
      check('in order', Buffer.from(hRecv.open(f2) ?? []).toString(), 'second')
      check('and the other way', Buffer.from(gRecv.open(hSend.seal('back')) ?? []).toString(), 'back')
      const f3 = gSend.seal('third')
      gSend.seal('fourth (dropped by the relay)')
      const f5 = gSend.seal('fifth')
      check('a dropped frame is noticed (the next one will not open)', [Buffer.from(hRecv.open(f3) ?? []).toString(), hRecv.open(f5)], ['third', null])
      check('and that direction stays dead', hRecv.open(gSend.seal('sixth')), null)
      const r2 = new RelayCipher(hk.g2h, 'g2h', relay)
      const again = new RelayCipher(gk.g2h, 'g2h', relay)
      const x = again.seal('once')
      r2.open(x)
      check('a replayed frame does not open', r2.open(x), null)
      const other = new RelayCipher(hk.g2h, 'g2h', idFromBytes('relay', bytes(15, 81)))
      check('a frame from another relay does not open', other.open(new RelayCipher(gk.g2h, 'g2h', relay).seal('x')), null)
      const mirror = new RelayCipher(gk.g2h, 'h2g', relay)
      check('a frame reflected back the other way does not open', mirror.open(new RelayCipher(gk.g2h, 'g2h', relay).seal('x')), null)
    }
  }
  const evil = relayEphemeral()
  const tampered: RelayHs2 = { ...hs2, eph: evil.pub }
  const mitm = relayFinish(hs1, tampered, KC.signPub, KA.signPriv)
  check('a relay that swaps the host’s ephemeral key is caught by the guest', mitm.ok ? 'accepted' : mitm.reason, 'the host did not sign this handshake')
  const impostor = relayAnswer(hs1, evil, KB.signPriv)
  const imp = relayFinish(hs1, impostor.hs2, KC.signPub, KA.signPriv)
  check('a hub answering as the host with another key is caught', imp.ok ? 'accepted' : imp.reason, 'the host did not sign this handshake')
  const n = relayNonce('h2g', 258)
  check('nonce layout: dir, three zeros, 8-byte big-endian counter', [...n], [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2])
  throws('a negative counter throws', () => relayNonce('g2h', -1))
}

console.log('\nrelay: what a guest may send')
{
  const req = (method: 'GET' | 'POST', path: string): RelayInnerFrame => ({ t: 'req', id: 1, method, path })
  const msg = (type: string): RelayInnerFrame => ({ t: 'ws-msg', id: 2, data: JSON.stringify({ type, data: 'x' }) })
  const v = (mode: 'view' | 'full' | null, f: RelayInnerFrame, sock?: string): string => { const r = relayFrameVerdict(mode, f, sock); return r.ok ? 'ok' : r.reason }
  check('view may list sessions', v('view', req('GET', '/api/sessions')), 'ok')
  check('view may read a transcript with a query', v('view', req('GET', '/api/transcript?id=abc&cwd=%2Fx')), 'ok')
  check('view may not start a session', v('view', req('POST', '/api/sessions')), 'this device may only watch')
  check('full may', v('full', req('POST', '/api/sessions')), 'ok')
  check('full may answer a prompt', v('full', req('POST', '/api/sessions/pty-12/answer')), 'ok')
  check('no grant is refused', v(null, req('GET', '/api/sessions')), 'no grant')
  check('speech is the phone’s, never relayed', v('full', req('POST', '/api/transcribe')), 'not a relayed route')
  check('push subscriptions are the phone’s', v('full', req('POST', '/api/push/test')), 'not a relayed route')
  check('static files are not relayed', v('full', req('GET', '/index.html')), 'not a relayed route')
  check('traversal is not a route', v('full', req('GET', '/api/../api/sessions')), 'not a relayed route')
  check('the pty socket opens with a ptyId', v('view', { t: 'ws-open', id: 3, path: '/ws?ptyId=pty-12' }), 'ok')
  check('and a peek', v('view', { t: 'ws-open', id: 3, path: '/ws?ptyId=pty-12&peek=1' }), 'ok')
  check('never with a key in the query', v('full', { t: 'ws-open', id: 3, path: '/ws?ptyId=pty-12&k=secret' }), 'not a relayed socket')
  check('never without a ptyId', v('full', { t: 'ws-open', id: 3, path: '/ws' }), 'not a relayed socket')
  check('a second ? cannot smuggle a parameter past the check', v('full', { t: 'ws-open', id: 3, path: '/ws?ptyId=pty-12?k=secret' }), 'not a relayed socket')
  check('view may not type', v('view', msg('input'), '/ws?ptyId=pty-12'), 'this device may only watch')
  check('view may not submit', v('view', msg('submit'), '/ws?ptyId=pty-12'), 'this device may only watch')
  check('view may not resize', v('view', msg('resize'), '/ws?ptyId=pty-12'), 'this device may only watch')
  check('full may type', v('full', msg('input'), '/ws?ptyId=pty-12'), 'ok')
  check('the events socket takes nothing from a guest', v('full', msg('input'), '/ws/events'), 'the events socket takes no frames')
  check('an unknown pty frame is refused', v('full', msg('kill'), '/ws?ptyId=pty-12'), 'not a pty frame')
  check('a guest cannot send ready', v('full', { t: 'ready', mode: 'full', host: { label: 'x', platform: 'darwin' } }), 'a guest does not send that')
  check('inner frames parse', parseRelayInner('{"t":"req","id":4,"method":"GET","path":"/api/host"}')?.t, 'req')
  check('a malformed one is null', parseRelayInner('{"t":"req","id":-1,"method":"GET","path":"/"}'), null)
  check('relayRouteFor needs the method to match', relayRouteFor('GET', '/api/sessions/pty-1/answer'), null)
}

/* ============================================================= protocol */

console.log('\nprotocol: signed requests')
{
  const now = 1_800_000_000_000
  const body = JSON.stringify({ puts: [] })
  const token = `sht_${b64uEncode(bytes(32, 5))}`
  const h = signRequest({ method: 'post', pathFromV1: '/v1/items', device: DA.id, signPriv: KA.signPriv, token, body, now })
  const headers: Record<string, string | undefined> = h
  const base = { method: 'POST', pathFromV1: '/v1/items', headers, body, signPub: KA.signPub, device: DA.id, now }
  check('a signed request verifies', verifyRequest(base).ok, true)
  check('the bearer is carried', h.authorization, `Bearer ${token}`)
  check('another body is a bad signature', verifyRequest({ ...base, body: '{"puts":[1]}' }), { ok: false, error: 'bad-signature' })
  check('another path is a bad signature', verifyRequest({ ...base, pathFromV1: '/v1/items/prune' }), { ok: false, error: 'bad-signature' })
  check('another method is a bad signature', verifyRequest({ ...base, method: 'GET' }), { ok: false, error: 'bad-signature' })
  check('another device key is a bad signature', verifyRequest({ ...base, signPub: KB.signPub }), { ok: false, error: 'bad-signature' })
  check('a device header naming another device is refused', verifyRequest({ ...base, headers: { ...headers, [HUB_HEADERS.device]: DC.id } }), { ok: false, error: 'bad-signature' })
  check('six minutes of skew is refused', verifyRequest({ ...base, now: now + 6 * 60_000 }), { ok: false, error: 'clock-skew' })
  check('four minutes is fine', verifyRequest({ ...base, now: now - 4 * 60_000 }).ok, true)
  check('an empty body signs as the empty string’s digest', bodyDigest(null), sha256B64u(''))
  check('the mount never enters a signature', pathFromV1('/hub/v1/items?since=3', '/hub'), '/v1/items?since=3')
  check('a path outside the mount has none', pathFromV1('/v1/items', '/hub'), null)
  check('a root mount', pathFromV1('/v1/items', '/'), '/v1/items')
}

console.log('\nprotocol: routes, responses, presence')
{
  let self = 0
  for (const [name, r] of Object.entries(HUB_ROUTES)) {
    const concrete = r.path.replace(':pair', idFromBytes('pair', bytes(10, 1))).replace(':relay', idFromBytes('relay', bytes(15, 1)))
    if (matchHubRoute(r.method, concrete)?.name === name) self++
  }
  check('every route matches its own path', self, Object.keys(HUB_ROUTES).length)
  check('params are read', matchHubRoute('POST', '/v1/pair/pabc/nonce'), { name: 'pairNonce', params: { pair: 'pabc' } })
  check('a query does not stop a match', matchHubRoute('GET', '/v1/items?since=4')?.name, 'itemsGet')
  check('an unknown path is 404', matchHubRoute('GET', '/v1/nope'), null)
  check('a param with a slash-free but odd value is refused', matchHubRoute('GET', '/v1/pair/..'), null)
  check('HUB_ERROR_STATUS names only 4xx/5xx', Object.values(HUB_ERROR_STATUS).every((s) => s >= 400 && s < 600), true)
  const challenge = readHubResponse(200, 'text/html; charset=UTF-8', '<!doctype html><title>Just a moment...</title>')
  check('a challenge page with status 200 is not the hub (gotcha 71)', challenge.ok, false)
  ok('and says so in words', !challenge.ok && /web page/.test(challenge.error.message))
  check('a hub error is passed through', readHubResponse(409, 'application/json', '{"error":"stale-epoch","message":"New key."}'), { ok: false, status: 409, error: { error: 'stale-epoch', message: 'New key.' } })
  check('an unknown error code is not trusted', readHubResponse(400, 'application/json', '{"error":"lol","message":"x"}').ok, false)
  check('a JSON array is not a hub answer', readHubResponse(200, 'application/json', '[]').ok, false)
  check('a hub answer', readHubResponse(200, 'application/json; charset=utf-8', '{"ok":true}'), { ok: true, status: 200, body: { ok: true } })
  check('presence frames parse', parsePresenceServerFrame('{"t":"relay","relay":"rx","guest":"dx"}'), { t: 'relay', relay: 'rx', guest: 'dx' })
  check('an unknown presence frame is null', parsePresenceServerFrame('{"t":"shell","cmd":"rm"}'), null)
  check('reconnect starts near a second', reconnectDelayMs(0, 0.5), 1000)
  check('and is capped at a minute', reconnectDelayMs(20, 0.5), 60_000)
  ok('with jitter inside ±20%', reconnectDelayMs(3, 0) === 6400 && reconnectDelayMs(3, 1) === 9600)
  check('the request text is the label and canonical fields', requestSigningText({ method: 'get', pathFromV1: '/v1/account', ts: 5, nonce: 'n', device: 'd', bodySha256: 'b' }), 'stoke-hub/v1/request\n{"body":"b","device":"d","method":"GET","nonce":"n","path":"/v1/account","ts":5}')
}

/* ================================================================= edge */

console.log('\nedge: the hub URL a Stoke accepts')
{
  const v = (t: string): string => { const r = hubUrlVerdict(t); return r.ok ? `${r.transport} ${r.base}` : 'refused' }
  check('a bare origin gets /hub', v('https://stoke.vinn.dev'), 'https https://stoke.vinn.dev/hub')
  check('a trailing slash is dropped', v('https://stoke.vinn.dev/hub/'), 'https https://stoke.vinn.dev/hub')
  check('a reverse-proxy mount is kept', v('https://example.org/tools/stoke-hub'), 'https https://example.org/tools/stoke-hub')
  check('mDNS on the LAN over http', v('http://nuc.local:8787'), 'http-private http://nuc.local:8787/hub')
  check('an RFC 1918 address over http', v('http://192.168.1.20:8787/hub'), 'http-private http://192.168.1.20:8787/hub')
  check('a tailnet address over http', v('http://100.101.102.103:8787'), 'http-private http://100.101.102.103:8787/hub')
  check('a tailnet name over http', v('http://nuc.tail1234.ts.net:8787'), 'http-private http://nuc.tail1234.ts.net:8787/hub')
  check('loopback IPv6', v('http://[::1]:8787'), 'http-private http://[::1]:8787/hub')
  check('a public host over http is refused', v('http://stoke.vinn.dev'), 'refused')
  check('172.32/16 is not private', v('http://172.32.0.1'), 'refused')
  check('100.128/10 is not the tailnet', v('http://100.128.0.1'), 'refused')
  check('credentials in the URL are refused', v('https://me:pw@stoke.vinn.dev'), 'refused')
  check('a query is refused', v('https://stoke.vinn.dev/hub?x=1'), 'refused')
  check('another scheme is refused', v('ftp://stoke.vinn.dev'), 'refused')
  check('nothing is refused', v('  '), 'refused')
  const http = hubUrlVerdict('http://nuc.local:8787')
  ok('plain http carries a warning to show', http.ok && typeof http.warning === 'string' && http.warning.length > 20)
  check('endpoints hang off the base', hubEndpoint('https://stoke.vinn.dev/hub', '/v1/items?since=2'), 'https://stoke.vinn.dev/hub/v1/items?since=2')
  check('sockets too', hubSocketUrl('https://stoke.vinn.dev/hub', '/v1/ws/presence'), 'wss://stoke.vinn.dev/hub/v1/ws/presence')
}

console.log('\nedge: the Worker and the hub’s check')
{
  const origin = 'https://hub-origin.vinn.dev'
  check('/hub/… is forwarded with path and query intact', edgeTarget('https://stoke.vinn.dev/hub/v1/items?since=3', origin), 'https://hub-origin.vinn.dev/hub/v1/items?since=3')
  check('/hubba is not the hub', edgeTarget('https://stoke.vinn.dev/hubba', origin), null)
  check('bare /hub is not forwarded (clients only call /hub/v1/…)', edgeTarget('https://stoke.vinn.dev/hub', origin), null)
  check('the installer’s root is not forwarded', edgeTarget('https://stoke.vinn.dev/?sh', origin), null)
  const secret = b64uEncode(bytes(32, 33))
  const fwd = edgeForwardHeaders(
    [['Upgrade', 'websocket'], ['Sec-WebSocket-Key', 'abc'], ['X-Stoke-Hub-Edge', 'forged'], ['x-stoke-client-ip', '6.6.6.6'], ['CF-Access-Client-Secret', 'forged'], ['Host', 'stoke.vinn.dev'], ['authorization', 'Bearer t']],
    { secret, clientIp: '203.0.113.9' }
  )
  const m = new Map(fwd)
  check('upgrade headers survive', [m.get('upgrade'), m.get('sec-websocket-key')], ['websocket', 'abc'])
  check('a client’s own edge secret is replaced by the real one', fwd.filter(([k]) => k === HUB_HEADERS.edge), [[HUB_HEADERS.edge, secret]])
  check('a client’s own client-ip is replaced', fwd.filter(([k]) => k === HUB_HEADERS.clientIp), [[HUB_HEADERS.clientIp, '203.0.113.9']])
  check('a client’s Access headers are dropped', m.has('cf-access-client-secret'), false)
  check('host is left to the fetch', m.has('host'), false)
  const ev = (listener: 'edge' | 'lan', cfg: string | null, headers: Record<string, string>): string => { const r = edgeVerdict({ listener, secret: cfg, headers, socketIp: '127.0.0.1' }); return r.ok ? r.clientIp : 'refused' }
  check('the edge listener takes the secret', ev('edge', secret, { [HUB_HEADERS.edge]: secret, [HUB_HEADERS.clientIp]: '203.0.113.9' }), '203.0.113.9')
  check('and refuses a wrong one', ev('edge', secret, { [HUB_HEADERS.edge]: `${secret}x` }), 'refused')
  check('and refuses none', ev('edge', secret, {}), 'refused')
  check('an edge listener with no secret configured refuses everything', ev('edge', null, { [HUB_HEADERS.edge]: '' }), 'refused')
  check('a short configured secret refuses everything', ev('edge', 'short', { [HUB_HEADERS.edge]: 'short' }), 'refused')
  check('the LAN listener needs no secret and ignores a forged client IP', ev('lan', null, { [HUB_HEADERS.clientIp]: '6.6.6.6' }), '127.0.0.1')
  check('sameSecret: equal', sameSecret('abc', 'abc'), true)
  check('sameSecret: a prefix is not equal', sameSecret('ab', 'abc'), false)
  check('sameSecret: empty never matches', sameSecret('', ''), false)
}

/* ============================================================= settings */

console.log('\nsettings: the local hub block')
{
  check('nothing stored hydrates to the defaults', hydrateHubSettings(undefined), HUB_SETTINGS_DEFAULTS)
  const h = hydrateHubSettings({
    url: ' https://stoke.vinn.dev/hub ',
    token: 7,
    deviceId: 'not-an-id',
    sync: { keys: false, settings: 'yes' },
    remoteHost: false,
    grants: { [DA.id]: { mode: 'full', label: 'Mac', at: 5 }, [DB.id]: { mode: 'admin' }, bad: { mode: 'view' } },
    extra: 'dropped'
  })
  check('the URL is trimmed', h.url, 'https://stoke.vinn.dev/hub')
  check('a non-string token is empty', h.token, '')
  check('a malformed device id is empty', h.deviceId, '')
  check('a switch keeps a boolean and defaults the rest', h.sync, { settings: true, hosts: true, keys: false })
  check('remoteHost off stays off', h.remoteHost, false)
  check('only well-formed grants survive', Object.keys(h.grants), [DA.id])
  check('an unknown field is dropped', 'extra' in h, false)
}

console.log('\nsettings: applying what arrives')
{
  const current = hydrateSettings({
    themeId: 'ember',
    wallpaper: { path: 'mine.jpg', blur: 0, dim: 0, opacity: 1 },
    providers: { anthropicApiKey: 'sk-ant-LOCAL-KEY' },
    defaults: { permissionMode: 'default' },
    remote: { token: 'phone-LOCAL' },
    hosts: [{ id: 'host-1', label: 'NUC', alias: 'nuc', command: '', keyEnrolled: true }]
  })
  const vpsSync = idFromBytes('host', bytes(10, 21))
  const nucSync = idFromBytes('host', bytes(10, 22))
  const r = applySyncedSettings(current, {
    settings: {
      themeId: 'lagoon',
      wallpaper: { path: 'theirs.jpg', blur: 8, dim: 0.2, opacity: 0.9 },
      providers: { ...t1ValuesFrom(current).providers as object },
      defaults: { ...current.defaults, permissionMode: 'bypassPermissions' },
      projectRoots: ['/theirs']
    },
    hosts: {
      [vpsSync]: hostPayloadFor({ id: 'host-1', label: 'VPS', alias: 'vps', command: '' }),
      [nucSync]: hostPayloadFor({ id: 'host-2', label: 'Home NUC', alias: 'nuc', command: '' })
    },
    secrets: { 'providers.openrouterApiKey': 'sk-or-SYNCED', 'remote.token': 'phone-SYNCED' }
  })
  const next = hydrateSettings(r.raw)
  check('a T1 key replaces the local value', next.themeId, 'lagoon')
  check('a partial block takes only its portable sub-keys', [next.wallpaper.path, next.wallpaper.blur, next.wallpaper.opacity], ['mine.jpg', 8, 0.9])
  check('a synced bypass default is not applied unasked', next.defaults.permissionMode, 'default')
  check('what was not applied is reported, in arrival order', r.skipped.map((s) => s.key), ['defaults.permissionMode', 'projectRoots', 'remote.token'])
  check('a machine-local key in the settings map is not applied', next.projectRoots, [])
  check('a scrubbed incoming providers block keeps the local key', next.providers.anthropicApiKey, 'sk-ant-LOCAL-KEY')
  check('a synced portable key lands', next.providers.openrouterApiKey, 'sk-or-SYNCED')
  check('the phone key never syncs in', next.remote.token, 'phone-LOCAL')
  const hosts = next.hosts as SyncableHost[]
  check('two machines’ host-1 stay two hosts (the measured import bug cannot happen here)', hosts.map((h) => [h.id, h.label, h.alias]), [['host-1', 'Home NUC', 'nuc'], ['host-2', 'VPS', 'vps']])
  check('the local NUC adopted the NUC’s sync id (same alias and command)', r.adopted, [{ id: 'host-1', syncId: nucSync }])
  check('keyEnrolled stays this device’s own', hosts.map((h) => h.keyEnrolled), [true, false])
  check('sync ids survive hydrate', hosts.map((h) => h.syncId), [nucSync, vpsSync])
  const cleared = hydrateSettings(applySyncedSettings(next, { secrets: { 'providers.openrouterApiKey': null }, hosts: { [vpsSync]: null } }).raw)
  check('a T2 tombstone clears the key', cleared.providers.openrouterApiKey, '')
  check('a T3 tombstone removes the host', (cleared.hosts as SyncableHost[]).map((h) => h.label), ['Home NUC'])
  const renamed = hydrateSettings(applySyncedSettings(cleared, { hosts: { [nucSync]: hostPayloadFor({ id: 'host-9', label: 'NUC (basement)', alias: 'nuc', command: '' }) } }).raw)
  check('an update by sync id keeps the local settings id', renamed.hosts.map((h) => [h.id, h.label]), [['host-1', 'NUC (basement)']])
  ok('a host payload never carries the settings id or keyEnrolled', !('id' in hostPayloadFor({ id: 'host-1', label: 'x', alias: 'x', command: '', keyEnrolled: true } as SyncableHost).host) && !('keyEnrolled' in hostPayloadFor({ id: 'host-1', label: 'x', alias: 'x', command: '', keyEnrolled: true }).host))
}

console.log('\nsettings: SSH key files')
{
  const names = new Map<string, 'same' | 'different'>([['id_ed25519', 'different'], ['id_ed25519-stoke-2', 'different'], ['work', 'same']])
  const probe = (n: string): 'free' | 'same' | 'different' => names.get(n) ?? 'free'
  check('a free name is written', sshKeyTarget('id_work', probe), { name: 'id_work', action: 'write' })
  check('an identical key already there is reused', sshKeyTarget('work', probe), { name: 'work', action: 'reuse' })
  check('a different key is never overwritten', sshKeyTarget('id_ed25519', probe), { name: 'id_ed25519-stoke-3', action: 'write' })
  check('every candidate taken is null', sshKeyTarget('k', () => 'different'), null)
  check('config is never a key name', isSafeSshKeyName('config'), false)
  check('nor known_hosts', isSafeSshKeyName('known_hosts'), false)
  check('nor authorized_keys (any case)', isSafeSshKeyName('Authorized_Keys'), false)
  check('nor a dotfile', isSafeSshKeyName('.hidden'), false)
  check('nor a .pub', isSafeSshKeyName('id.pub'), false)
  check('nor a path', isSafeSshKeyName('../id'), false)
  check('an ordinary name is fine', isSafeSshKeyName('id_ed25519_work'), true)
  const payload = { name: 'id_work', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n', publicKey: 'ssh-ed25519 AAAA x', comment: 'x', fingerprint: 'SHA256:x', passphrase: false }
  check('a key payload is accepted', sshKeyPayloadProblem(payload), null)
  check('a public key with a newline inside is refused', sshKeyPayloadProblem({ ...payload, publicKey: 'ssh-ed25519 AAAA\nx' }), 'bad public key')
  check('text that is not a private key is refused', sshKeyPayloadProblem({ ...payload, privateKey: 'hello' }), 'not a private key')
}

/* ============================================================== vectors */

console.log('\npinned vectors (a change here strands every wrap and item already on a hub)')
{
  const K = deviceKeysFromSeeds(bytes(32, 1), bytes(32, 2))
  const vk = bytes(32, 150)
  const wrap = wrapVaultKey(vk, { account: ACCOUNT, epoch: 1, device: DA.id, boxPub: K.boxPub }, { ephSeed: bytes(32, 7), nonce: bytes(12, 8) })
  const rk = recoveryKeys(bytes(16, 90), ACCOUNT)
  const rwrap = sealRecoveryWrap(vk, rk.wrapKey, { account: ACCOUNT, epoch: 1 }, { nonce: bytes(12, 9) })
  const ik = itemKeys(vk, ACCOUNT, 1)
  const item = sealItem(ik, { version: 1, author: DA.id, path: 't1/settings/themeId', editedAt: 1_800_000_000_000, deleted: false, value: 'lagoon' }, { nonce: bytes(12, 10) })
  const gE = relayEphemeral(bytes(32, 11))
  const hE = relayEphemeral(bytes(32, 12))
  const hs1 = relayHello({ relay: idFromBytes('relay', bytes(15, 13)), account: ACCOUNT, guest: DA.id, host: DC.id }, gE, bytes(32, 14))
  const { hs2, th } = relayAnswer(hs1, hE, KC.signPriv, bytes(32, 15))
  const keys = relayKeys(gE, hs2.eph, th)
  const frame = keys ? b64uEncode(new RelayCipher(keys.g2h, 'g2h', hs1.relay).seal('{"t":"ping"}')) : ''
  const got: Record<string, string> = {
    account: ACCOUNT,
    deviceId: DA.id,
    signPub: K.signPub,
    boxPub: K.boxPub,
    signature: signText(K.signPriv, 'stoke-hub vector'),
    genesisLink: sha256B64u(chainLinkText(g0)),
    vkWrap: canonicalJson(wrap),
    recoverySignPub: rk.signPub,
    recoveryWrap: canonicalJson(rwrap),
    itemId: item.id,
    itemCt: item.ct,
    relayTh: th,
    relayHs2Sig: hs2.sig,
    relayFrame: frame,
    pairCode: pairCode({ account: ACCOUNT, pair: idFromBytes('pair', bytes(10, 16)), device: DC, approver: DA, nonceN: b64uEncode(bytes(32, 17)), nonceE: b64uEncode(bytes(32, 18)) }),
    kit: formatRecoverySecret(bytes(16, 90)),
    sha256: b64uEncode(sha256('abc'))
  }
  /*
   * From `node scripts/verify-hub.mts --print-vectors` on 2026-10-01, and
   * reproduced byte for byte under Electron 43's Node (BoringSSL) as well as
   * Node 26 (OpenSSL). Ed25519 is deterministic and every nonce and
   * ephemeral key above is fixed, so each value is a pure function of the
   * labels, the canonical JSON and the byte layouts. Re-pin ONLY for a
   * deliberate protocol v2, never to make the suite pass.
   */
  const PINNED: Record<string, string> = {
    account: 'as37xdqf4xfsfj007',
    deviceId: 'd1c91j8175rtkrgta',
    signPub: '5AMJmM_VrRcjwWn5VqoLnrhhm1mSvWEsKvQo68efjfA',
    boxPub: 'c-eZcckRAClyNjKoC3B79PYsEldjNG4ehxjWwNzDqjo',
    signature: 'ylIttXBMVY7ZopfhE8Ipd3ebxEjJhOurVB12Iho63MvctsmDxRV5pUk9E88liEMQ48FB-8EeAAioS2xpfTtiAw',
    genesisLink: '843twFT3-OzdWDG2ATsXVRF74AxWgcKNDXmOnsmQ_bA',
    vkWrap: '{"ct":"SpxRoj_bbqx2HHJMSd3Uix3LEVe6HSsHNAjl47EBmih-Zg61VIxRIn6KgkfEZJnR","eph":"rp1aCT3yLydAm-SflswNNZjcZ31qD1GtHSsSTnwTWX4","nonce":"CA8WHSQrMjlAR05V","v":1}',
    recoverySignPub: 'IDQ6hRq4fQP7DKDQIttWr9SL65XSS6TicMZsMoOd2CY',
    recoveryWrap: '{"ct":"jrm2ZUM2eiveC2JUh7LzEGRIiOE45EIaWwmEqdxlxC0hOltcR61LgfJpBs0kp6AB","nonce":"CRAXHiUsMzpBSE9W","v":1}',
    itemId: 'i0SYIQOSHzMfaqqHf3LC2Kpn-Hsuj9i9Q',
    itemCt: 'd4P6OZ-8KodkycCcT-PaWZ-gSPXWTW91eKu4ahHvFtuBrU8uCtWRBOfGinOqXjCqlIdFriMgS_dP2HO_AAdEO0T7QqfWujWM39rxp4i65_GX2gk14Sr8ET4w1XhvQQ6HNT2m-QgPgPU',
    relayTh: 's68mmf6o4fB3csryxBrqkYXriVcyHW-HkW_Dke24Fkc',
    relayHs2Sig: 'D6eU8QYbAXWeaVKK0888GrAn9vco2yWeKN3Q6mrfhynwfL_gf6_gDuDnPVpSkv4iVUw6AYDSwCtOO0Scw44kCw',
    relayFrame: 'EDCDYuIcF2N6-0_vVIFICmI0mWRa87YeQksa3w',
    pairCode: '237 411',
    kit: 'RK1-B9GP-GVVP-FP28-Q4MS-M2KT-XDDW-RCS',
    sha256: 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0'
  }
  if (PRINT_VECTORS) {
    console.log(JSON.stringify(got, null, 2))
  } else {
    for (const [k, v] of Object.entries(got)) check(`vector ${k}`, v, PINNED[k])
  }
  check('SHA-256("abc") is the FIPS 180-2 value', Buffer.from(sha256('abc')).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  ok('keys generated for real are fresh each time', generateDeviceKeys().signPub !== generateDeviceKeys().signPub)
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
