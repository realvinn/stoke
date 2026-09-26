/**
 * Safari's `Cookies.binarycookies`, read and turned into what Electron sets.
 *
 * The format is undocumented and has been stable for a decade: a big-endian
 * file header naming its pages, then pages whose own tables are LITTLE-endian
 * — the one fact about it most likely to be got wrong. Offsets inside a page
 * count from the page's start; offsets inside a cookie record count from the
 * record's start. Times are Mac absolute time: seconds since 2001-01-01 UTC.
 *
 * Read defensively, because the file is another program's live state: a copy
 * taken while Safari rewrites it can end mid-page. A page or record that does
 * not add up is skipped, and the cookies around it still come through; only a
 * file with no usable header at all throws. Every offset is checked against
 * the buffer before it is read, so no field can index past the end.
 *
 * Pure, so `scripts/verify-safari-import.mts` runs it under
 * `node --experimental-strip-types` on buffers it builds itself.
 */
import type { ImportedCookie } from './types.ts'

/** 2001-01-01T00:00:00Z in Unix seconds: Mac absolute time's epoch. */
export const MAC_EPOCH_OFFSET = 978307200

const FLAG_SECURE = 0x1
const FLAG_HTTP_ONLY = 0x4

/** A record's fixed part: size, flags, four string offsets, the marker, two dates. */
const RECORD_HEADER = 56

export interface SafariCookie {
  /** As stored: a leading dot means a domain cookie, none means host-only. */
  domain: string
  name: string
  path: string
  value: string
  secure: boolean
  httpOnly: boolean
  /** Unix seconds. */
  expires: number
  /** Unix seconds. */
  created: number
}

/**
 * Every cookie in the file that can be read. An empty buffer is an empty jar;
 * a buffer that is not a cookies file at all throws, so a wrong file is never
 * reported as "no cookies".
 */
export function parseBinaryCookies(buf: Buffer): SafariCookie[] {
  if (buf.length === 0) return []
  if (buf.length < 8 || buf.toString('latin1', 0, 4) !== 'cook') {
    throw new Error('not a Safari cookie file (no "cook" header)')
  }
  const pageCount = buf.readUInt32BE(4)
  const tableEnd = 8 + 4 * pageCount
  if (tableEnd > buf.length) {
    throw new Error(`its header names ${pageCount} pages, more than the file can hold`)
  }

  const out: SafariCookie[] = []
  let pageStart = tableEnd
  for (let p = 0; p < pageCount && pageStart < buf.length; p++) {
    const size = buf.readUInt32BE(8 + 4 * p)
    // A truncated last page still gives up the records it holds whole.
    readPage(buf, pageStart, Math.min(pageStart + size, buf.length), out)
    pageStart += size
  }
  return out
}

function readPage(buf: Buffer, start: number, end: number, out: SafariCookie[]): void {
  if (end - start < 8 || buf.readUInt32BE(start) !== 0x00000100) return
  const count = buf.readUInt32LE(start + 4)
  if (8 + 4 * count > end - start) return
  for (let k = 0; k < count; k++) {
    const recordStart = start + buf.readUInt32LE(start + 8 + 4 * k)
    const cookie = readRecord(buf, recordStart, end)
    if (cookie) out.push(cookie)
  }
}

function readRecord(buf: Buffer, start: number, pageEnd: number): SafariCookie | null {
  if (start + RECORD_HEADER > pageEnd) return null
  const size = buf.readUInt32LE(start)
  if (size < RECORD_HEADER || start + size > pageEnd) return null
  const end = start + size
  const flags = buf.readUInt32LE(start + 8)
  const domain = cString(buf, start, buf.readUInt32LE(start + 16), end)
  const name = cString(buf, start, buf.readUInt32LE(start + 20), end)
  const path = cString(buf, start, buf.readUInt32LE(start + 24), end)
  const value = cString(buf, start, buf.readUInt32LE(start + 28), end)
  if (domain === null || name === null || path === null || value === null || !domain) return null
  const expires = buf.readDoubleLE(start + 40) + MAC_EPOCH_OFFSET
  const created = buf.readDoubleLE(start + 48) + MAC_EPOCH_OFFSET
  if (!Number.isFinite(expires)) return null
  return {
    domain,
    name,
    path,
    value,
    secure: (flags & FLAG_SECURE) !== 0,
    httpOnly: (flags & FLAG_HTTP_ONLY) !== 0,
    expires,
    created: Number.isFinite(created) ? created : 0
  }
}

/** A record's NUL-terminated string, or null if its offset points into the header or it runs past the record. */
function cString(buf: Buffer, recordStart: number, offset: number, end: number): string | null {
  const at = recordStart + offset
  if (offset < RECORD_HEADER || at >= end) return null
  const nul = buf.indexOf(0, at)
  if (nul < 0 || nul >= end) return null
  return buf.toString('utf8', at, nul)
}

/**
 * One Safari cookie as `session.cookies.set` wants it, or null when it cannot
 * be carried over: expired, or with no host to set it on.
 *
 * The domain is passed only for a domain cookie, dot included. Electron
 * prefixes a dot to any domain it is given, so passing a host-only cookie's
 * host would quietly widen it to every subdomain. SameSite is not in the file,
 * so it goes over as `unspecified` and the browser's default applies.
 */
export function safariCookieToElectron(c: SafariCookie, nowSeconds: number): ImportedCookie | null {
  if (!(c.expires > nowSeconds)) return null
  const host = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain
  if (!host) return null
  const path = c.path.startsWith('/') ? c.path : `/${c.path}`
  const url = `${c.secure ? 'https://' : 'http://'}${host}${path}`
  try {
    new URL(url)
  } catch {
    return null
  }
  const cookie: ImportedCookie = {
    url,
    name: c.name,
    value: c.value,
    path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    expirationDate: c.expires,
    sameSite: 'unspecified'
  }
  if (c.domain.startsWith('.')) cookie.domain = c.domain
  return cookie
}
