/*
 * Safari import: the two file formats read by hand, on files built here.
 *
 * `Cookies.binarycookies` is undocumented and mixes big- and little-endian
 * fields in one file, so the parser is checked against buffers this suite
 * writes byte by byte — never against a real jar, which is behind Full Disk
 * Access and holds live logins besides. What matters most is the damage
 * control: a corrupt page, a truncated tail or a record whose offsets lie must
 * cost only the cookies inside it. Then the mapping, where a host-only cookie
 * handed a `domain` would be widened to every subdomain by Electron.
 *
 * The bookmarks half is the XML plist parser plutil's output goes through,
 * and the walk that turns Safari's folder tree into an ordered URL list.
 *
 *   node scripts/verify-safari-import.mts
 */
import { decodeEntities, parsePlistXml } from '../src/main/browserImport/plist.ts'
import {
  MAC_EPOCH_OFFSET,
  parseBinaryCookies,
  safariCookieToElectron,
  type SafariCookie
} from '../src/main/browserImport/safariCookies.ts'
import { bookmarkUrls, profileUuid } from '../src/main/browserImport/safari.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

function throws(fn: () => unknown): boolean {
  try {
    fn()
    return false
  } catch {
    return true
  }
}

// --- building a Cookies.binarycookies -------------------------------------

interface Spec {
  domain: string
  name: string
  path: string
  value: string
  flags: number
  /** Unix seconds; whole numbers, so the Mac-epoch round trip is exact. */
  expires: number
  created: number
}

/** One cookie record, laid out as Safari writes it: all little-endian. */
function record(c: Spec): Buffer {
  const strings = [c.domain, c.name, c.path, c.value].map((s) => Buffer.from(`${s}\0`, 'utf8'))
  const offsets: number[] = []
  let at = 56
  for (const s of strings) {
    offsets.push(at)
    at += s.length
  }
  const head = Buffer.alloc(56)
  head.writeUInt32LE(at, 0)
  head.writeUInt32LE(0, 4)
  head.writeUInt32LE(c.flags, 8)
  head.writeUInt32LE(0, 12)
  offsets.forEach((o, k) => head.writeUInt32LE(o, 16 + 4 * k))
  // 32..39: the end-of-header marker, zero.
  head.writeDoubleLE(c.expires - MAC_EPOCH_OFFSET, 40)
  head.writeDoubleLE(c.created - MAC_EPOCH_OFFSET, 48)
  return Buffer.concat([head, ...strings])
}

/** A page: big-endian 0x100 magic, then a little-endian count and offset table. */
function page(records: Buffer[], magic = 0x00000100): Buffer {
  const headerLen = 4 + 4 + 4 * records.length + 4
  const head = Buffer.alloc(headerLen)
  head.writeUInt32BE(magic, 0)
  head.writeUInt32LE(records.length, 4)
  let at = headerLen
  records.forEach((r, k) => {
    head.writeUInt32LE(at, 8 + 4 * k)
    at += r.length
  })
  // The four-byte page footer, zero, is already there.
  return Buffer.concat([head, ...records])
}

/** The file: "cook", a big-endian page count and size table, the pages, then a trailer to be ignored. */
function file(pages: Buffer[]): Buffer {
  const head = Buffer.alloc(8 + 4 * pages.length)
  head.write('cook', 0, 'latin1')
  head.writeUInt32BE(pages.length, 4)
  pages.forEach((p, k) => head.writeUInt32BE(p.length, 8 + 4 * k))
  const trailer = Buffer.from([0, 0, 0, 0, 0x07, 0x17, 0x20, 0x05, 0, 0, 0, 0x4b])
  return Buffer.concat([head, ...pages, trailer])
}

const NOW = 1_800_000_000
const LATER = 1_900_000_000
const CREATED = 1_700_000_000

const session: Spec = {
  domain: '.example.com',
  name: 'sid',
  path: '/',
  value: 'abc123',
  flags: 0x1 | 0x4,
  expires: LATER,
  created: CREATED
}
const hostOnly: Spec = {
  domain: 'app.example.com',
  name: 'theme',
  path: '/settings',
  value: 'dark',
  flags: 0,
  expires: LATER,
  created: CREATED
}
const expired: Spec = {
  domain: '.old.example',
  name: 'gone',
  path: '/',
  value: 'x',
  flags: 0x1,
  expires: NOW - 60,
  created: CREATED
}
const afterCorrupt: Spec = {
  domain: '.after.example',
  name: 'survivor',
  path: '/',
  value: 'yes',
  flags: 0x4,
  expires: LATER,
  created: CREATED
}
const tailWhole: Spec = {
  domain: 'tail.example',
  name: 'whole',
  path: '/',
  value: 'kept',
  flags: 0,
  expires: LATER,
  created: CREATED
}
const tailCut: Spec = {
  domain: 'tail.example',
  name: 'cut',
  path: '/',
  value: 'lost-in-the-truncation',
  flags: 0,
  expires: LATER,
  created: CREATED
}

/** A record whose value offset points past its own end: a lie that must cost only itself. */
function lyingRecord(): Buffer {
  const r = record({ ...hostOnly, name: 'liar' })
  r.writeUInt32LE(r.length + 400, 28)
  return r
}
/** A record whose last string has no NUL before the record ends. */
function unterminatedRecord(): Buffer {
  const r = record({ ...hostOnly, name: 'unterminated', value: 'v' })
  r[r.length - 1] = 0x41
  return r
}

const good = page([record(session), record(hostOnly), record(expired)])
const corrupt = page([record({ ...session, name: 'never' })], 0xdeadbeef)
const mixed = page([lyingRecord(), record(afterCorrupt), unterminatedRecord()])
const tail = page([record(tailWhole), record(tailCut)])
const whole = file([good, corrupt, mixed, tail])
// Cut the file inside the last record, as a copy taken mid-rewrite would be.
const truncated = whole.subarray(0, whole.length - 12 - 10)

console.log('\nbinarycookies, the good page')
const all = parseBinaryCookies(whole)
check(
  'every readable cookie, in file order: bad page, lying and unterminated records skipped',
  all.map((c) => c.name),
  ['sid', 'theme', 'gone', 'survivor', 'whole', 'cut']
)
const sid = all.find((c) => c.name === 'sid') as SafariCookie
check('a domain cookie keeps its leading dot', sid.domain, '.example.com')
check('flag 0x1 is Secure and 0x4 HttpOnly', [sid.secure, sid.httpOnly], [true, true])
check('expiry is Mac absolute time moved to the Unix epoch', sid.expires, LATER)
check('and so is creation', sid.created, CREATED)
check('the value is read whole', sid.value, 'abc123')
const theme = all.find((c) => c.name === 'theme') as SafariCookie
check('a host-only cookie has no dot and neither flag', [theme.domain, theme.secure, theme.httpOnly], ['app.example.com', false, false])
check('its path is read as written', theme.path, '/settings')

console.log('\nbinarycookies, damage control')
check('a page with the wrong magic is skipped', all.some((c) => c.name === 'never'), false)
check('and the page after it still reads', all.some((c) => c.name === 'survivor'), true)
check('a record whose offset points past its end costs only itself', all.some((c) => c.name === 'liar'), false)
check('a string with no NUL inside its record costs only its record', all.some((c) => c.name === 'unterminated'), false)
check(
  'a file cut mid-record keeps every cookie before the cut and drops the cut one',
  parseBinaryCookies(truncated).map((c) => c.name),
  ['sid', 'theme', 'gone', 'survivor', 'whole']
)
check(
  'a file cut inside its page-size table throws: no page can be located',
  throws(() => parseBinaryCookies(whole.subarray(0, 14))),
  true
)
check('an empty file is an empty jar', parseBinaryCookies(Buffer.alloc(0)), [])
check('a file that is not a cookie jar throws rather than reading as empty', throws(() => parseBinaryCookies(Buffer.from('bplist00 not cookies'))), true)
{
  const huge = Buffer.from(whole)
  huge.writeUInt32BE(0x40000000, 4)
  check('a page count the file cannot hold throws instead of reading garbage', throws(() => parseBinaryCookies(huge)), true)
}
{
  const liesAboutCount = page([record(session)])
  liesAboutCount.writeUInt32LE(100_000, 4)
  check(
    'a page claiming more cookies than it has room for is skipped whole',
    parseBinaryCookies(file([liesAboutCount, page([record(hostOnly)])])).map((c) => c.name),
    ['theme']
  )
}
{
  let fuzzThrew = 0
  let seed = 7
  for (let n = 0; n < 500; n++) {
    const b = Buffer.from(whole)
    for (let k = 0; k < 6; k++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      const at = 8 + 4 * 4 + (seed % (b.length - 24))
      b[at] = seed & 0xff
    }
    if (throws(() => parseBinaryCookies(b))) fuzzThrew++
  }
  check('500 randomly damaged files past the header never throw', fuzzThrew, 0)
}

console.log('\nmapping to Electron')
check(
  'a secure domain cookie: https url on the bare host, domain kept with its dot',
  safariCookieToElectron(sid, NOW),
  {
    url: 'https://example.com/',
    name: 'sid',
    value: 'abc123',
    path: '/',
    secure: true,
    httpOnly: true,
    expirationDate: LATER,
    sameSite: 'unspecified',
    domain: '.example.com'
  }
)
const mappedTheme = safariCookieToElectron(theme, NOW)
check(
  'a host-only cookie: http url with its path, and NO domain key — Electron would widen it',
  mappedTheme,
  {
    url: 'http://app.example.com/settings',
    name: 'theme',
    value: 'dark',
    path: '/settings',
    secure: false,
    httpOnly: false,
    expirationDate: LATER,
    sameSite: 'unspecified'
  }
)
check('the host-only object has no domain property at all', mappedTheme !== null && 'domain' in mappedTheme, false)
check('an expired cookie is not carried over', safariCookieToElectron(all.find((c) => c.name === 'gone') as SafariCookie, NOW), null)
check('nor one expiring this very second', safariCookieToElectron({ ...sid, expires: NOW }, NOW), null)
check('nor one with no host', safariCookieToElectron({ ...sid, domain: '.' }, NOW), null)
check('an empty path becomes /', safariCookieToElectron({ ...theme, path: '' }, NOW)?.url, 'http://app.example.com/')
check('a host that makes no URL is refused, not handed to Electron', safariCookieToElectron({ ...theme, domain: 'bad host' }, NOW), null)

console.log('\nprofile keys')
check('a profile key must be a UUID, and comes back lower-case', profileUuid('safari/5A3B1C2D-0E4F-4A5B-8C6D-7E8F9A0B1C2D'), '5a3b1c2d-0e4f-4a5b-8c6d-7e8f9a0b1c2d')
check('a key that climbs out of the data store is refused', profileUuid('safari/../../../../etc'), null)
check('a key with a separator is refused', profileUuid('safari/5a3b1c2d-0e4f-4a5b-8c6d-7e8f9a0b1c2d/..'), null)
check('another browser\'s key is refused', profileUuid('chrome/5a3b1c2d-0e4f-4a5b-8c6d-7e8f9a0b1c2d'), null)
check('the default key is not a UUID', profileUuid('safari/default'), null)

console.log('\nplist XML')
check('the five named entities', decodeEntities('&amp;&lt;&gt;&quot;&apos;'), `&<>"'`)
check('decimal and hex character references', decodeEntities('caf&#233; &#x1F525;'), 'café 🔥')
check('an unknown entity is left as written, not looked up on Object', decodeEntities('&constructor; &nbsp;'), '&constructor; &nbsp;')
check('a reference past U+10FFFF is left as written', decodeEntities('&#x110000;'), '&#x110000;')
check('&amp;lt; decodes once, to &lt;', decodeEntities('&amp;lt;'), '&lt;')

const BOOKMARKS_XML = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
  '<plist version="1.0">',
  '<dict>',
  '\t<key>Children</key>',
  '\t<array>',
  '\t\t<dict>',
  '\t\t\t<key>Title</key>',
  '\t\t\t<string>BookmarksBar</string>',
  '\t\t\t<key>WebBookmarkType</key>',
  '\t\t\t<string>WebBookmarkTypeList</string>',
  '\t\t\t<key>Children</key>',
  '\t\t\t<array>',
  '\t\t\t\t<dict>',
  '\t\t\t\t\t<key>URIDictionary</key>',
  '\t\t\t\t\t<dict>',
  '\t\t\t\t\t\t<key>title</key>',
  '\t\t\t\t\t\t<string>Search &amp; Rescue &lt;Caf&#233;&gt;</string>',
  '\t\t\t\t\t</dict>',
  '\t\t\t\t\t<key>URLString</key>',
  '\t\t\t\t\t<string>https://example.com/search?q=a&amp;b=c</string>',
  '\t\t\t\t\t<key>WebBookmarkType</key>',
  '\t\t\t\t\t<string>WebBookmarkTypeLeaf</string>',
  '\t\t\t\t</dict>',
  '\t\t\t\t<!-- a comment between children -->',
  '\t\t\t\t<dict>',
  '\t\t\t\t\t<key>Title</key>',
  '\t\t\t\t\t<string>Work</string>',
  '\t\t\t\t\t<key>WebBookmarkType</key>',
  '\t\t\t\t\t<string>WebBookmarkTypeList</string>',
  '\t\t\t\t\t<key>Children</key>',
  '\t\t\t\t\t<array>',
  '\t\t\t\t\t\t<dict>',
  '\t\t\t\t\t\t\t<key>URLString</key>',
  '\t\t\t\t\t\t\t<string>http://intranet.local/</string>',
  '\t\t\t\t\t\t\t<key>WebBookmarkType</key>',
  '\t\t\t\t\t\t\t<string>WebBookmarkTypeLeaf</string>',
  '\t\t\t\t\t\t</dict>',
  '\t\t\t\t\t\t<dict>',
  '\t\t\t\t\t\t\t<key>URLString</key>',
  '\t\t\t\t\t\t\t<string>javascript:alert(1)</string>',
  '\t\t\t\t\t\t\t<key>WebBookmarkType</key>',
  '\t\t\t\t\t\t\t<string>WebBookmarkTypeLeaf</string>',
  '\t\t\t\t\t\t</dict>',
  '\t\t\t\t\t\t<dict>',
  '\t\t\t\t\t\t\t<key>URLString</key>',
  '\t\t\t\t\t\t\t<string>https://example.com/search?q=a&amp;b=c</string>',
  '\t\t\t\t\t\t\t<key>WebBookmarkType</key>',
  '\t\t\t\t\t\t\t<string>WebBookmarkTypeLeaf</string>',
  '\t\t\t\t\t\t</dict>',
  '\t\t\t\t\t</array>',
  '\t\t\t\t</dict>',
  '\t\t\t</array>',
  '\t\t</dict>',
  '\t\t<dict>',
  '\t\t\t<key>Title</key>',
  '\t\t\t<string>com.apple.ReadingList</string>',
  '\t\t\t<key>WebBookmarkType</key>',
  '\t\t\t<string>WebBookmarkTypeList</string>',
  '\t\t\t<key>Children</key>',
  '\t\t\t<array>',
  '\t\t\t\t<dict>',
  '\t\t\t\t\t<key>ReadingList</key>',
  '\t\t\t\t\t<dict>',
  '\t\t\t\t\t\t<key>DateAdded</key>',
  '\t\t\t\t\t\t<date>2026-09-01T12:30:00Z</date>',
  '\t\t\t\t\t\t<key>PreviewText</key>',
  '\t\t\t\t\t\t<string/>',
  '\t\t\t\t\t</dict>',
  '\t\t\t\t\t<key>imageData</key>',
  '\t\t\t\t\t<data>',
  '\t\t\t\t\tAAEC',
  '\t\t\t\t\tAwQF',
  '\t\t\t\t\t</data>',
  '\t\t\t\t\t<key>URLString</key>',
  '\t\t\t\t\t<string>https://read.example/later</string>',
  '\t\t\t\t\t<key>WebBookmarkType</key>',
  '\t\t\t\t\t<string>WebBookmarkTypeLeaf</string>',
  '\t\t\t\t</dict>',
  '\t\t\t</array>',
  '\t\t</dict>',
  '\t</array>',
  '\t<key>WebBookmarkFileVersion</key>',
  '\t<integer>1</integer>',
  '\t<key>Sync</key>',
  '\t<dict>',
  '\t\t<key>Weight</key>',
  '\t\t<real>-2.5</real>',
  '\t\t<key>Enabled</key>',
  '\t\t<true/>',
  '\t\t<key>Paused</key>',
  '\t\t<false/>',
  '\t\t<key>Extra</key>',
  '\t\t<dict/>',
  '\t\t<key>Tags</key>',
  '\t\t<array/>',
  '\t\t<key>__proto__</key>',
  '\t\t<string>just data</string>',
  '\t</dict>',
  '</dict>',
  '</plist>',
  ''
].join('\n')

const parsed = parsePlistXml(BOOKMARKS_XML) as Record<string, unknown>
const bar = (parsed.Children as Array<Record<string, unknown>>)[0]
const firstLeaf = (bar.Children as Array<Record<string, unknown>>)[0]
check('a string with entities decodes', (firstLeaf.URIDictionary as Record<string, unknown>).title, 'Search & Rescue <Café>')
check('an entity inside a URL decodes', firstLeaf.URLString, 'https://example.com/search?q=a&b=c')
const reading = ((parsed.Children as Array<Record<string, unknown>>)[1].Children as Array<Record<string, unknown>>)[0]
check('a date becomes its ISO string', (reading.ReadingList as Record<string, unknown>).DateAdded, '2026-09-01T12:30:00.000Z')
check('an empty <string/> is the empty string', (reading.ReadingList as Record<string, unknown>).PreviewText, '')
check('data becomes its base64 text, whitespace removed', reading.imageData, 'AAECAwQF')
check('an integer is a number', parsed.WebBookmarkFileVersion, 1)
check(
  'real, true, false, an empty dict and an empty array',
  parsed.Sync,
  // Computed, so the expectation has an own `__proto__` key rather than setting a prototype.
  { Weight: -2.5, Enabled: true, Paused: false, Extra: {}, Tags: [], ['__proto__']: 'just data' }
)
check(
  'a key named __proto__ is data, not a prototype',
  [Object.getPrototypeOf(parsed.Sync), (parsed.Sync as Record<string, unknown>)['__proto__']],
  [null, 'just data']
)
check(
  'the bookmarks walk: depth-first in order, http(s) only, duplicates once, Reading List included',
  bookmarkUrls(parsed),
  ['https://example.com/search?q=a&b=c', 'http://intranet.local/', 'https://read.example/later']
)
check('a walk over something that is not a tree finds nothing', bookmarkUrls('nope'), [])
check('CDATA is taken verbatim', parsePlistXml('<plist><string><![CDATA[a & <b>]]> &amp; c</string></plist>'), 'a & <b> & c')
check('hex integers and a negative', parsePlistXml('<plist><array><integer>0x1F</integer><integer>-3</integer></array></plist>'), [31, -3])

console.log('\nplist XML that is not one')
check('an unclosed dict throws', throws(() => parsePlistXml('<plist><dict><key>a</key><string>b</string></plist>')), true)
check('a value with no key in a dict throws', throws(() => parsePlistXml('<plist><dict><string>b</string></dict></plist>')), true)
check('a key with no value throws', throws(() => parsePlistXml('<plist><dict><key>a</key></dict></plist>')), true)
check('an unknown element throws', throws(() => parsePlistXml('<plist><blob/></plist>')), true)
check('a non-numeric integer throws', throws(() => parsePlistXml('<plist><integer>twelve</integer></plist>')), true)
check('an element inside a string throws', throws(() => parsePlistXml('<plist><string>a<b/>c</string></plist>')), true)
check('trailing content after the plist throws', throws(() => parsePlistXml('<plist><true/></plist><false/>')), true)
check('plain text is not a plist', throws(() => parsePlistXml('bplist00')), true)

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
