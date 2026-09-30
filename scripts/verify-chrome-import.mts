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
  appPathMatchesBrowser,
  browserCloseScript,
  BROWSER_CLOSE_DEADLINE_MS,
  CHROME_EPOCH_OFFSET,
  cdpCookieToImported,
  chromeKey,
  chromeRowToCookie,
  chromeTimeToUnix,
  closeStuckMessage,
  closeVerdict,
  cookieIdentity,
  decryptChromeValue,
  groupKeysByBrowser,
  lockedCopyReport,
  parseCloseReport,
  reopenArgs,
  RESTART_MANAGER_SOURCE,
  sealedCookiesMissed,
  sealedReport,
  SESSION_COOKIE_DAYS,
  type CdpCookie,
  type ChromeCookieRow,
  type CloseStuck
} from '../src/main/browserImport/chromeCookies.ts'
import { CHROMIUM_BROWSERS, chromiumRoot } from '../src/main/browserImport/chromiumProfiles.ts'

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

console.log('\nCDP cookies into cookies (the Windows path: Chrome already decrypted them)')
const cdp = (over: Partial<CdpCookie>): CdpCookie => ({
  name: 'sid',
  value: 'v',
  domain: '.example.com',
  path: '/',
  secure: true,
  httpOnly: true,
  session: false,
  expires: NOW + 86_400,
  sameSite: 'Lax',
  ...over
})
check('a Domain= cookie keeps its dot and its url has none', cdpCookieToImported(cdp({}), NOW), {
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
  const c = cdpCookieToImported(cdp({ domain: 'app.example.com', path: '/a' }), NOW)
  check(
    'a host-only CDP cookie (no leading dot) gets NO domain',
    typeof c === 'object' ? [c.domain, c.url] : c,
    [undefined, 'https://app.example.com/a']
  )
}
check(
  'CDP sameSite None/Lax/Strict/absent map as Chromium sets them',
  (['None', 'Lax', 'Strict', undefined] as const).map((s) => {
    const c = cdpCookieToImported(cdp({ sameSite: s }), NOW)
    return typeof c === 'object' ? c.sameSite : c
  }),
  ['no_restriction', 'lax', 'strict', 'unspecified']
)
{
  const c = cdpCookieToImported(cdp({ sameSite: 'None', secure: false }), NOW)
  check(
    'SameSite=None without Secure becomes unspecified, over http',
    typeof c === 'object' ? [c.sameSite, c.url.slice(0, 5)] : c,
    ['unspecified', 'http:']
  )
}
{
  const c = cdpCookieToImported(cdp({ session: true, expires: -1 }), NOW)
  check(
    'a session CDP cookie is carried for SESSION_COOKIE_DAYS, not lost at the first quit',
    typeof c === 'object' ? c.expirationDate : c,
    NOW + SESSION_COOKIE_DAYS * 86_400
  )
}
check('an expired persistent CDP cookie is left behind', cdpCookieToImported(cdp({ expires: NOW - 1 }), NOW), 'expired')
check(
  'a partitioned CDP cookie (string partitionKey) is skipped',
  cdpCookieToImported(cdp({ partitionKey: 'https://embedder.test' }), NOW),
  'partitioned'
)
check(
  'a partitioned CDP cookie (object partitionKey) is skipped too',
  cdpCookieToImported(cdp({ partitionKey: { topLevelSite: 'https://embedder.test' } }), NOW),
  'partitioned'
)
{
  const c = cdpCookieToImported(cdp({ path: '' }), NOW)
  check('an empty CDP path is /', typeof c === 'object' ? c.path : c, '/')
}
check('a CDP host with junk in it is refused', cdpCookieToImported(cdp({ domain: 'a b/c' }), NOW), 'invalid')
{
  const c = cdpCookieToImported(cdp({ httpOnly: true, value: 'plaintext-from-cdp' }), NOW)
  check(
    'the decrypted value and HttpOnly flag carry straight through',
    typeof c === 'object' ? [c.value, c.httpOnly] : c,
    ['plaintext-from-cdp', true]
  )
}

console.log('\nWindows: the App Paths hit must be THIS browser (chrome.exe is shared)')
{
  // Chrome Stable, Beta and Chromium all name their exe chrome.exe, and the
  // installer writes one shared App Paths\chrome.exe key — so a registry hit can
  // belong to another channel. Accept it only when it ends with a browser's own
  // install subpath (gotcha 130).
  const stable = ['Google\\Chrome\\Application\\chrome.exe']
  const beta = ['Google\\Chrome Beta\\Application\\chrome.exe']
  check(
    "Stable's own exe matches Stable",
    appPathMatchesBrowser('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', stable),
    true
  )
  check(
    "Stable's exe is REJECTED for Beta (the shared-key trap)",
    appPathMatchesBrowser('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', beta),
    false
  )
  check(
    "Beta's own exe matches Beta",
    appPathMatchesBrowser('C:\\Program Files\\Google\\Chrome Beta\\Application\\chrome.exe', beta),
    true
  )
  check('the match is case-insensitive', appPathMatchesBrowser('C:\\PROGRAM FILES\\GOOGLE\\CHROME\\APPLICATION\\CHROME.EXE', stable), true)
  check('a forward-slash path still matches', appPathMatchesBrowser('C:/Program Files/Google/Chrome/Application/chrome.exe', stable), true)
  check('with no known subpaths there is nothing to check, so it is accepted', appPathMatchesBrowser('C:\\anywhere\\x.exe', []), true)
  check(
    'and CHROMIUM_BROWSERS really do share chrome.exe across Stable/Beta/Chromium',
    ['chrome', 'chrome-beta', 'chromium'].map((id) => CHROMIUM_BROWSERS.find((b) => b.id === id)?.winExe),
    ['chrome.exe', 'chrome.exe', 'chrome.exe']
  )
}

console.log('\nWindows: a v20 login the browser did not hand back is reported, not lost')
{
  // The reader takes Storage.getCookies as the whole answer; a v20 (app-bound)
  // row the browser could not decrypt is silently dropped from that list and is
  // never a `skipped`. sealedCookiesMissed counts those against the copied DB.
  const rows = [
    { host_key: '.example.com', name: 'sid', tag: 'v20' },
    { host_key: '.example.com', name: 'pref', tag: 'v10' },
    { host_key: 'app.test', name: 'tok', tag: 'v20' }
  ]
  check(
    'both v20 rows absent from CDP → 2 sealed',
    sealedCookiesMissed(rows, new Set()),
    2
  )
  check(
    'one v20 returned, one not → 1 sealed (v10 is never counted)',
    sealedCookiesMissed(rows, new Set([cookieIdentity('.example.com', 'sid')])),
    1
  )
  check(
    'every v20 returned → 0 sealed, even with the v10 missing',
    sealedCookiesMissed(rows, new Set([cookieIdentity('.example.com', 'sid'), cookieIdentity('app.test', 'tok')])),
    0
  )
  check('no v20 rows at all → 0 sealed', sealedCookiesMissed([{ host_key: 'a.com', name: 'x', tag: 'v10' }], new Set()), 0)
}

console.log('\nWindows: what a sealed or locked read tells the user (gotcha 130)')
{
  // Sealed v20 rows can never come from a copy — Chromium refuses app-bound
  // decryption outside the default user-data dir — so they must NEVER offer a
  // close (it would shut the user's browser for nothing), and the message must
  // not blame a running browser the copy just proved was not holding the file.
  const one = sealedReport('Chrome', 1)
  const many = sealedReport('Chrome', 3)
  check('no sealed rows → no error at all', sealedReport('Chrome', 0), {})
  check('sealed rows never ask for a close (no needsClose key)', 'needsClose' in one || 'needsClose' in many, false)
  check('the sealed message counts them', many.cookieError?.startsWith('3 logins could not come over'), true)
  check('the singular reads as one login', one.cookieError?.startsWith('1 login could not come over'), true)
  check('the sealed message names app-bound encryption', /app-bound encryption/.test(many.cookieError ?? ''), true)
  check('the sealed message never says "while … was running"', /running/i.test(many.cookieError ?? ''), false)
  check('the sealed message never offers to close the browser', /close/i.test(many.cookieError ?? ''), false)
  // A locked copy is the ONE case a close helps (Chromium's exclusive cookie-DB
  // lock on Windows). Offered once; after a close was tried, never again.
  check('a locked copy offers the close', lockedCopyReport('Edge', false).needsClose, true)
  check('a locked copy after a close does not offer it again (no loop)', 'needsClose' in lockedCopyReport('Edge', true), false)
  check('the locked message names the browser', /^Edge is open/.test(lockedCopyReport('Edge', false).cookieError), true)
  check('the after-close message never promises a force', /never forces/.test(lockedCopyReport('Edge', true).cookieError), true)
}

console.log('\nWindows: closing the browser like a sign-out, once per browser (gotcha 135)')
{
  // The close script's variable parts travel in the environment, never spliced
  // into the text (gotcha 101), and it carries no double quote for Windows'
  // command-line quoting to mangle. Pure ASCII for Windows PowerShell 5.1.
  const script = browserCloseScript()
  check('the close script is pure ASCII', /^[\x00-\x7f]*$/.test(script), true)
  check('the close script carries no double quote', script.includes('"'), false)
  check('no smart quotes sneaked into the script (gotcha 101)', /[‘’‚‛]/.test(script), false)
  for (const v of ['STOKE_BROWSER_EXE', 'STOKE_BROWSER_ROOT', 'STOKE_CLOSE_DEADLINE', 'STOKE_RM_SOURCE']) {
    check(`it reads ${v} from the environment`, script.includes(`$env:${v}`), true)
  }
  check(
    'it NEVER force-kills (no Stop-Process/taskkill/Kill/-Force)',
    /Stop-Process|taskkill|\.Kill\(|-Force/i.test(script),
    false
  )
  // Window by window loses every window but the last from the session: Chromium
  // commits a window's close at once while another window of the profile is open.
  check('it never closes window by window (no CloseMainWindow — loses all but the last window)', script.includes('CloseMainWindow'), false)
  check('it hands the close to the Restart Manager', script.includes('[StokeRestartManager]::Shutdown('), true)
  check(
    'it finds processes by CIM ExecutablePath (a 32-bit PS cannot read a 64-bit .Path — gotcha 94)',
    script.includes('Get-CimInstance Win32_Process') && script.includes('ExecutablePath'),
    true
  )
  check('it leaves other --user-data-dir instances alone (scoped to this root)', script.includes('--user-data-dir') && script.includes('$root'), true)
  check('the main process is the one with no --type=', script.includes("-notmatch ' --type='"), true)
  for (const k of ['started=', 'windows=', 'rm=', 'remaining=', 'error=']) {
    check(`it reports ${k}<…>`, script.includes(`'${k}'`), true)
  }

  // The C# is compiled by Windows PowerShell 5.1's Add-Type: C# 5, no later syntax.
  const cs = RESTART_MANAGER_SOURCE
  check('the Restart Manager source is pure ASCII', /^[\x00-\x7f]*$/.test(cs), true)
  check('it asks with flags 0 — never RmForceShutdown', /RmShutdown\(session, 0, IntPtr\.Zero\)/.test(cs) && !/Force/.test(cs), true)
  check('it never kills a process itself', /\.Kill\(|TerminateProcess/.test(cs), false)
  check('it always ends its Restart Manager session', /finally\s*\{\s*RmEndSession\(session\);/.test(cs), true)
  check('C# 5 only: no interpolated strings', cs.includes('$"'), false)
  check('C# 5 only: no ?. operator', cs.includes('?.'), false)
  check('C# 5 only: no out var', /out var /.test(cs), false)
  check('C# 5 only: no => members', cs.includes('=>'), false)
  check('braces balance in the C#', (cs.match(/\{/g) ?? []).length === (cs.match(/\}/g) ?? []).length, true)
  check('the class the script calls is the class the C# defines', cs.includes('public static class StokeRestartManager'), true)

  // The report → verdict. Reopen only a browser that ran AND exited.
  const r = (o: Partial<ReturnType<typeof parseCloseReport>>) => ({ started: null, windows: null, rm: null, remaining: null, error: null, ...o })
  check(
    'the report parses, CRLF and all',
    parseCloseReport('started=1\r\nwindows=2\r\nrm=0\r\nremaining=0\r\n'),
    { started: 1, windows: 2, rm: 0, remaining: 0, error: null }
  )
  check('an error line parses', parseCloseReport('started=1\r\nerror=MethodInvocationException\r\n').error, 'MethodInvocationException')
  check('not running → nothing to close, nothing to reopen', closeVerdict(r({ started: 0, remaining: 0 }), false), { closed: false })
  check('ran and exited → reopen it', closeVerdict(r({ started: 1, windows: 1, rm: 0, remaining: 0 }), false), { closed: true })
  check(
    'ran, had a window, still running → refused, never reopened',
    closeVerdict(r({ started: 1, windows: 1, rm: 351, remaining: 7 }), false),
    { closed: false, stuck: 'refused' }
  )
  check(
    'ran with no window, still running → background mode',
    closeVerdict(r({ started: 1, windows: 0, rm: 0, remaining: 3 }), false),
    { closed: false, stuck: 'background' }
  )
  check('Add-Type refused → blocked', closeVerdict(r({ started: 1, windows: 1, error: 'PSInvalidOperationException' }), false), { closed: false, stuck: 'blocked' })
  check('no report at all → blocked, never reopened', closeVerdict(parseCloseReport(''), false), { closed: false, stuck: 'blocked' })
  check('the script outran its wait → timeout, never reopened', closeVerdict(r({ started: 1, windows: 1 }), true), { closed: false, stuck: 'timeout' })
  check(
    'the remaining count decides — a clean rm code with processes left is still not closed',
    closeVerdict(r({ started: 1, windows: 1, rm: 0, remaining: 2 }), false).closed,
    false
  )
  const stuck: CloseStuck[] = ['background', 'refused', 'blocked', 'timeout']
  for (const k of stuck) {
    const m = closeStuckMessage('Chrome', k)
    check(`the ${k} message names the browser and promises no tabs`, m.includes('Chrome') && !/tab/i.test(m), true)
  }
  check('the background message points at the icon by the clock', /icon by the clock/.test(closeStuckMessage('Chrome', 'background')), true)

  // Reopen with NOTHING: every profile that was open comes back, not just one;
  // no --user-data-dir, so it is the user's real instance.
  check('reopen passes no arguments at all', reopenArgs(), [])
  check('the close deadline is a sane, bounded wait', BROWSER_CLOSE_DEADLINE_MS > 0 && BROWSER_CLOSE_DEADLINE_MS <= 60_000, true)

  // One close per browser, around all its profiles — never one per profile.
  const browserOf = (k: string): string | null => (k.startsWith('?') ? null : k.split('/')[0])
  check(
    'profiles group by browser, first-seen order kept',
    groupKeysByBrowser(['chrome/Default', 'edge/Default', 'chrome/Profile 1', 'safari/default', 'edge/Profile 2'], browserOf),
    [
      { browser: 'chrome', keys: ['chrome/Default', 'chrome/Profile 1'] },
      { browser: 'edge', keys: ['edge/Default', 'edge/Profile 2'] },
      { browser: 'safari', keys: ['safari/default'] }
    ]
  )
  check('unknown keys share one run', groupKeysByBrowser(['?a', 'chrome/x', '?b'], browserOf), [
    { browser: null, keys: ['?a', '?b'] },
    { browser: 'chrome', keys: ['chrome/x'] }
  ])
}

console.log('\nprofile roots, per platform')
{
  const chrome = CHROMIUM_BROWSERS.find((b) => b.id === 'chrome')!
  const edge = CHROMIUM_BROWSERS.find((b) => b.id === 'edge')!
  const arc = CHROMIUM_BROWSERS.find((b) => b.id === 'arc')!
  check(
    "macOS Chrome sits under ~/Library/Application Support",
    chromiumRoot(chrome, 'darwin', {}, '/Users/x'),
    '/Users/x/Library/Application Support/Google/Chrome'
  )
  check(
    'Windows Chrome uses %LOCALAPPDATA% and its own User Data root',
    chromiumRoot(chrome, 'win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'C:\\Users\\x'),
    'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data'
  )
  check(
    'Windows Edge lands in Microsoft\\Edge\\User Data',
    chromiumRoot(edge, 'win32', { LOCALAPPDATA: 'C:\\Users\\x\\AppData\\Local' }, 'C:\\Users\\x'),
    'C:\\Users\\x\\AppData\\Local\\Microsoft\\Edge\\User Data'
  )
  check(
    'Windows falls back to <home>\\AppData\\Local when LOCALAPPDATA is unset',
    chromiumRoot(chrome, 'win32', {}, 'C:\\Users\\x'),
    'C:\\Users\\x\\AppData\\Local\\Google\\Chrome\\User Data'
  )
  check('a browser with no known Windows folder (Arc) is skipped there', chromiumRoot(arc, 'win32', { LOCALAPPDATA: 'C:\\l' }, 'C:\\h'), null)
  check('Linux imports from no Chromium browser', chromiumRoot(chrome, 'linux', {}, '/home/x'), null)
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
