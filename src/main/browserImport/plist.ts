/**
 * An XML property list, parsed into plain values.
 *
 * Safari keeps its bookmarks in a BINARY plist, and this does not read that
 * format — `/usr/bin/plutil -convert xml1 -o -` does, and hands back the XML
 * this parses. Writing a bplist reader would be the larger, riskier half of the
 * job, and plutil ships with every Mac that has a Safari to import from.
 *
 * Every plist type maps to the obvious JSON-shaped value, with two that have no
 * JSON form of their own: a `<date>` becomes its ISO string and `<data>` its
 * base64 text (whitespace removed), so the result survives `JSON.stringify`
 * whole. An `<integer>` past 2^53 loses precision as a number; nothing Safari
 * writes in a bookmark comes close.
 *
 * Pure and dependency-free, so `scripts/verify-safari-import.mts` runs it under
 * `node --experimental-strip-types`.
 */

interface Cursor {
  s: string
  i: number
}

interface Tag {
  name: string
  closing: boolean
  selfClosing: boolean
}

/** The five entities XML predefines. A Map, so `&constructor;` finds nothing. */
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"]
])

/**
 * Parse an XML plist. Throws on anything that is not one — the caller decides
 * what a malformed file means to the person who asked for it.
 */
export function parsePlistXml(xml: string): unknown {
  const c: Cursor = { s: xml, i: 0 }
  const first = readTag(c)
  let value: unknown
  if (first.name === 'plist' && !first.closing) {
    if (first.selfClosing) return undefined
    value = readValue(c, readTag(c))
    expectClose(c, 'plist')
  } else {
    // A bare value with no <plist> wrapper: lenient, since nothing is lost.
    value = readValue(c, first)
  }
  skipMisc(c)
  if (c.i < c.s.length) fail(c, 'unexpected content after the plist')
  return value
}

/** Replace XML's entity references; an unknown or out-of-range one is left as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text
  return text.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z]+);/g, (whole, ref: string) => {
    if (ref[0] !== '#') return NAMED_ENTITIES.get(ref) ?? whole
    const hex = ref[1] === 'x' || ref[1] === 'X'
    const cp = hex ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10)
    // A lone surrogate is not a character, and fromCodePoint throws past U+10FFFF.
    const valid = Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)
    return valid ? String.fromCodePoint(cp) : whole
  })
}

function fail(c: Cursor, what: string): never {
  throw new Error(`Not a readable property list: ${what} at offset ${c.i}.`)
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d
}

/** Skip whitespace, the XML declaration, a DOCTYPE and comments — everything that is not a value. */
function skipMisc(c: Cursor): void {
  for (;;) {
    while (c.i < c.s.length && isSpace(c.s.charCodeAt(c.i))) c.i++
    if (c.s.startsWith('<?', c.i)) {
      const end = c.s.indexOf('?>', c.i + 2)
      if (end < 0) fail(c, 'an unterminated <? ?>')
      c.i = end + 2
    } else if (c.s.startsWith('<!--', c.i)) {
      const end = c.s.indexOf('-->', c.i + 4)
      if (end < 0) fail(c, 'an unterminated comment')
      c.i = end + 3
    } else if (c.s.startsWith('<!DOCTYPE', c.i)) {
      // Apple's DOCTYPE has no internal subset, but one in [...] may hold a '>'.
      let depth = 0
      let j = c.i + 9
      for (; j < c.s.length; j++) {
        const ch = c.s[j]
        if (ch === '[') depth++
        else if (ch === ']') depth--
        else if (ch === '>' && depth <= 0) break
      }
      if (j >= c.s.length) fail(c, 'an unterminated DOCTYPE')
      c.i = j + 1
    } else {
      return
    }
  }
}

function readTag(c: Cursor): Tag {
  skipMisc(c)
  if (c.s[c.i] !== '<') fail(c, 'expected a tag')
  const end = c.s.indexOf('>', c.i)
  if (end < 0) fail(c, 'an unterminated tag')
  let body = c.s.slice(c.i + 1, end).trim()
  c.i = end + 1
  const closing = body.startsWith('/')
  if (closing) body = body.slice(1)
  const selfClosing = !closing && body.endsWith('/')
  if (selfClosing) body = body.slice(0, -1)
  const name = body.trim().split(/\s/, 1)[0]
  if (!name) fail(c, 'an empty tag')
  return { name, closing, selfClosing }
}

function expectClose(c: Cursor, name: string): void {
  const t = readTag(c)
  if (!t.closing || t.name !== name) fail(c, `expected </${name}>, found <${t.closing ? '/' : ''}${t.name}>`)
}

/** Is the next tag a closing one? Leaves the cursor on it either way. */
function atClose(c: Cursor): boolean {
  skipMisc(c)
  return c.s.startsWith('</', c.i)
}

/**
 * The character content of `<name>…</name>`, entities decoded, the close tag
 * consumed. CDATA is taken verbatim; any child element is an error, since no
 * plist text element has one.
 */
function readText(c: Cursor, name: string): string {
  let out = ''
  for (;;) {
    const lt = c.s.indexOf('<', c.i)
    if (lt < 0) fail(c, `an unterminated <${name}>`)
    out += decodeEntities(c.s.slice(c.i, lt))
    c.i = lt
    if (c.s.startsWith('<![CDATA[', c.i)) {
      const end = c.s.indexOf(']]>', c.i + 9)
      if (end < 0) fail(c, 'an unterminated CDATA section')
      out += c.s.slice(c.i + 9, end)
      c.i = end + 3
    } else if (c.s.startsWith('<!--', c.i)) {
      const end = c.s.indexOf('-->', c.i + 4)
      if (end < 0) fail(c, 'an unterminated comment')
      c.i = end + 3
    } else {
      expectClose(c, name)
      return out
    }
  }
}

function readValue(c: Cursor, t: Tag): unknown {
  if (t.closing) fail(c, `an unexpected </${t.name}>`)
  switch (t.name) {
    case 'dict': {
      // Null prototype: a plist key named `__proto__` is data, not a prototype.
      const out: Record<string, unknown> = Object.create(null)
      if (t.selfClosing) return out
      while (!atClose(c)) {
        const k = readTag(c)
        if (k.closing || k.name !== 'key') fail(c, `expected <key> in a <dict>, found <${k.name}>`)
        const key = k.selfClosing ? '' : readText(c, 'key')
        out[key] = readValue(c, readTag(c))
      }
      expectClose(c, 'dict')
      return out
    }
    case 'array': {
      const out: unknown[] = []
      if (t.selfClosing) return out
      while (!atClose(c)) out.push(readValue(c, readTag(c)))
      expectClose(c, 'array')
      return out
    }
    case 'string':
      return t.selfClosing ? '' : readText(c, 'string')
    case 'true':
    case 'false':
      if (!t.selfClosing) expectClose(c, t.name)
      return t.name === 'true'
    case 'integer': {
      const text = t.selfClosing ? '' : readText(c, 'integer').trim()
      if (/^[+-]?\d+$/.test(text)) return Number(text)
      if (/^[+-]?0x[0-9a-f]+$/i.test(text)) {
        const n = parseInt(text.replace(/^[+-]/, '').slice(2), 16)
        return text[0] === '-' ? -n : n
      }
      return fail(c, `an <integer> of ${JSON.stringify(text)}`)
    }
    case 'real': {
      const text = t.selfClosing ? '' : readText(c, 'real').trim()
      const lower = text.toLowerCase()
      if (lower === 'nan') return NaN
      if (/^\+?inf(inity)?$/.test(lower)) return Infinity
      if (/^-inf(inity)?$/.test(lower)) return -Infinity
      const n = Number(text)
      if (text === '' || Number.isNaN(n)) fail(c, `a <real> of ${JSON.stringify(text)}`)
      return n
    }
    case 'date': {
      const text = t.selfClosing ? '' : readText(c, 'date').trim()
      const ms = Date.parse(text)
      // An unparseable date is kept as written: one odd timestamp is no reason to lose a file.
      return Number.isNaN(ms) ? text : new Date(ms).toISOString()
    }
    case 'data':
      return t.selfClosing ? '' : readText(c, 'data').replace(/\s+/g, '')
    default:
      return fail(c, `an unknown element <${t.name}>`)
  }
}
