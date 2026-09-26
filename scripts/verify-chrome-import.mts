/*
 * Importing Chrome's cookies: the decryption and the row mapping, on data this
 * suite encrypts itself exactly the way Chrome does. No real browser file,
 * Keychain item or cookie is read — the point is that the rules can be held
 * without one.
 *
 *   node scripts/verify-chrome-import.mts
 */
import { createCipheriv, createHash } from 'node:crypto'
import {
  CHROME_EPOCH_OFFSET,
  chromeKey,
  chromeRowToCookie,
  chromeTimeToUnix,
  decryptChromeValue,
  SESSION_COOKIE_DAYS,
  type ChromeCookieRow
} from '../src/main/browserImport/chromeCookies.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

const PASSWORD = 'synthetic-keychain-password'
const KEY = chromeKey(PASSWORD)

/** Encrypt as Chrome does: optional SHA-256(host) prefix, AES-128-CBC, IV of spaces, "v10" tag. */
function chromeEncrypt(value: string, host: string, withHostHash: boolean, key = KEY): Buffer {
  const plain = withHostHash
    ? Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])
    : Buffer.from(value)
  const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20))
  return Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()])
}

console.log('\nthe key and the cipher')
check('the key is 16 bytes', KEY.length, 16)
check(
  'a v24 value round-trips, host hash stripped',
  decryptChromeValue(chromeEncrypt('s3cr3t', '.example.com', true), KEY, '.example.com', 24),
  's3cr3t'
)
check(
  'an older DB has no host hash',
  decryptChromeValue(chromeEncrypt('old', 'example.com', false), KEY, 'example.com', 23),
  'old'
)
check(
  'a v24 row whose hash is for another host is refused, as Chrome refuses it',
  decryptChromeValue(chromeEncrypt('moved', '.other.com', true), KEY, '.example.com', 24),
  null
)
check(
  'the wrong key is null, not garbage',
  decryptChromeValue(chromeEncrypt('x', 'a.com', false, chromeKey('not-it')), KEY, 'a.com', 23),
  null
)
check('a tag other than v10 is not guessed at', decryptChromeValue(Buffer.from('v11abcdefgh'), KEY, 'a.com', 24), null)
check('an empty value is not v10', decryptChromeValue(new Uint8Array(0), KEY, 'a.com', 24), null)
check(
  'multi-byte text survives',
  decryptChromeValue(chromeEncrypt('café ☕', 'a.com', true), KEY, 'a.com', 24),
  'café ☕'
)

console.log('\ntime')
const NOW = 1_800_000_000
const inChrome = (unix: number): bigint => (BigInt(unix) + BigInt(CHROME_EPOCH_OFFSET)) * 1_000_000n
check('a bigint far past 2^53 converts without precision trouble', chromeTimeToUnix(inChrome(NOW + 3600)), NOW + 3600)
check('a plain number works too', chromeTimeToUnix(Number(inChrome(NOW))), NOW)

console.log('\nrows into cookies')
const row = (over: Partial<ChromeCookieRow>): ChromeCookieRow => ({
  host_key: '.example.com',
  name: 'sid',
  value: '',
  encrypted_value: null,
  path: '/',
  expires_utc: inChrome(NOW + 86_400),
  is_secure: 1,
  is_httponly: 1,
  has_expires: 1,
  samesite: 1,
  top_frame_site_key: '',
  ...over
})
check('a domain cookie keeps its dot and its url has none', chromeRowToCookie(row({}), 'v', NOW), {
  url: 'https://example.com/',
  name: 'sid',
  value: 'v',
  path: '/',
  secure: true,
  httpOnly: true,
  expirationDate: NOW + 86_400,
  sameSite: 'lax',
  domain: '.example.com'
})
{
  const c = chromeRowToCookie(row({ host_key: 'app.example.com', path: '/a' }), 'v', NOW)
  check(
    'a host-only cookie gets NO domain (Electron would dot it into every subdomain)',
    typeof c === 'object' ? [c.domain, c.url] : c,
    [undefined, 'https://app.example.com/a']
  )
}
check(
  'samesite as Chromium stores it: -1, 0, 1, 2, 3',
  [-1, 0, 1, 2, 3].map((n) => {
    const c = chromeRowToCookie(row({ samesite: n }), 'v', NOW)
    return typeof c === 'object' ? c.sameSite : c
  }),
  ['unspecified', 'no_restriction', 'lax', 'strict', 'unspecified']
)
{
  const c = chromeRowToCookie(row({ samesite: 0, is_secure: 0 }), 'v', NOW)
  check(
    'SameSite=None without Secure becomes unspecified, which the setter accepts',
    typeof c === 'object' ? [c.sameSite, c.url.slice(0, 5)] : c,
    ['unspecified', 'http:']
  )
}
check('an expired cookie is left behind', chromeRowToCookie(row({ expires_utc: inChrome(NOW - 1) }), 'v', NOW), 'expired')
{
  const c = chromeRowToCookie(row({ has_expires: 0, expires_utc: 0 }), 'v', NOW)
  check(
    'a session cookie is carried over for SESSION_COOKIE_DAYS, not lost at the first quit',
    typeof c === 'object' ? c.expirationDate : c,
    NOW + SESSION_COOKIE_DAYS * 86_400
  )
}
check(
  'a partitioned (CHIPS) cookie is skipped, never set unpartitioned',
  chromeRowToCookie(row({ top_frame_site_key: 'https://embedder.test' }), 'v', NOW),
  'partitioned'
)
check('a value that could not be decrypted is skipped', chromeRowToCookie(row({}), null, NOW), 'undecryptable')
check('a host with junk in it is refused', chromeRowToCookie(row({ host_key: 'a b/c' }), 'v', NOW), 'invalid')
{
  const c = chromeRowToCookie(row({ path: '' }), 'v', NOW)
  check('an empty path is /', typeof c === 'object' ? c.path : c, '/')
}
check(
  'bigint flags from node:sqlite read the same as numbers',
  (() => {
    const c = chromeRowToCookie(row({ is_secure: 1n, is_httponly: 0n, has_expires: 1n, samesite: 2n }), 'v', NOW)
    return typeof c === 'object' ? [c.secure, c.httpOnly, c.sameSite] : c
  })(),
  [true, false, 'strict']
)

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
