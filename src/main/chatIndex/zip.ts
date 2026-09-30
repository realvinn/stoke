/**
 * A small, suspicious ZIP reader: the central directory, then ONE member at a
 * time, inflated with `zlib.inflateRawSync` under a declared-size ceiling.
 * Written for account exports (a claude.ai or ChatGPT zip) and nothing else, so
 * it reads only what it is asked for — a ChatGPT export carries every generated
 * image beside the one `conversations.json` Stoke wants, and none of those is
 * ever read, let alone unpacked. `portableUpdate.extractZip` (tar/PowerShell,
 * whole archive to disk) is the wrong tool for that.
 *
 * Every limit is checked before the work it guards (`CHAT_EXPORT_LIMITS`):
 *
 * - the archive's size, the entry count and the directory's size before the
 *   directory is read;
 * - a name that could point outside the archive (`..`, an absolute path, a
 *   drive letter, a NUL) refuses the WHOLE archive — nothing is ever written
 *   to disk here, but no export Stoke reads has such a name, so one is either
 *   damage or an attack, and neither is worth reading past;
 * - a member's declared size, and its inflate ratio, before inflating;
 * - and the inflate itself stops at the declared size (`maxOutputLength`), so a
 *   header that lies about its size cannot make a small member large. The
 *   CRC-32 is checked after.
 *
 * Sync fs, like every reader in the worker: the libuv pool is shared with pty
 * writes (`sources.ts`). ZIP64 is read (its end record, and the extra field
 * for a member's sizes and offset) — some writers use it for every archive.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { crc32, inflateRawSync } from 'node:zlib'
import { CHAT_EXPORT_LIMITS } from '../../shared/chatIndex.ts'

export type ZipLimits = { [K in keyof typeof CHAT_EXPORT_LIMITS]: number }

/** A refusal worth showing the user as it is: every message is a sentence. */
export class ZipError extends Error {}

export interface ZipEntry {
  name: string
  flags: number
  method: number
  crc: number
  compressedSize: number
  size: number
  localOffset: number
}

export interface ZipArchive {
  fd: number
  bytes: number
  entries: ZipEntry[]
}

const SIG_EOCD = 0x06054b50
const SIG_EOCD64 = 0x06064b50
const SIG_EOCD64_LOCATOR = 0x07064b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50
const MAX16 = 0xffff
const MAX32 = 0xffffffff

function readAt(fd: number, pos: number, len: number): Buffer {
  const buf = Buffer.allocUnsafe(len)
  let got = 0
  while (got < len) {
    const n = readSync(fd, buf, got, len - got, pos + got)
    if (n === 0) break
    got += n
  }
  if (got < len) throw new ZipError('The archive ends early; it may not have finished downloading.')
  return buf
}

function u64(buf: Buffer, at: number): number {
  const v = buf.readBigUInt64LE(at)
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new ZipError('The archive states a size no file can have.')
  return Number(v)
}

/**
 * A name that could reach outside the archive if anything ever extracted it:
 * `..` as a segment (either slash), a leading slash, a drive letter, a NUL.
 */
export function isUnsafeZipName(name: string): boolean {
  if (!name || name.includes('\0')) return true
  if (name.startsWith('/') || name.startsWith('\\') || /^[A-Za-z]:/.test(name)) return true
  return name.split(/[/\\]/).some((seg) => seg === '..')
}

/**
 * Open an archive and read its central directory. The caller owns `fd` and
 * closes it (`closeZip`), because members are read one at a time afterwards.
 */
export function openZip(path: string, limits: ZipLimits = CHAT_EXPORT_LIMITS): ZipArchive {
  const fd = openSync(path, 'r')
  try {
    const bytes = fstatSync(fd).size
    if (bytes > limits.zipBytes) {
      throw new ZipError(`The archive is ${Math.round(bytes / 1024 ** 3)} GB; Stoke opens exports up to ${Math.round(limits.zipBytes / 1024 ** 3)} GB.`)
    }
    if (bytes < 22) throw new ZipError('This is not a zip archive.')
    // The end record sits in the last 22 bytes plus a comment of up to 64 KB.
    const tailLen = Math.min(bytes, 22 + MAX16)
    const tailStart = bytes - tailLen
    const tail = readAt(fd, tailStart, tailLen)
    let eocd = -1
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === SIG_EOCD) {
        eocd = i
        break
      }
    }
    if (eocd < 0) throw new ZipError('This is not a zip archive (no directory at its end).')
    if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) {
      throw new ZipError('This archive is split across several files; Stoke reads a single zip.')
    }
    let count = tail.readUInt16LE(eocd + 10)
    let dirSize = tail.readUInt32LE(eocd + 12)
    let dirOffset = tail.readUInt32LE(eocd + 16)
    if (count === MAX16 || dirSize === MAX32 || dirOffset === MAX32) {
      // ZIP64: a locator 20 bytes before the end record names where its own end record is.
      const locAt = tailStart + eocd - 20
      if (locAt < 0) throw new ZipError('The archive’s directory is damaged.')
      const loc = readAt(fd, locAt, 20)
      if (loc.readUInt32LE(0) !== SIG_EOCD64_LOCATOR) throw new ZipError('The archive’s directory is damaged.')
      const at = u64(loc, 8)
      if (at + 56 > bytes) throw new ZipError('The archive’s directory is damaged.')
      const rec = readAt(fd, at, 56)
      if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new ZipError('The archive’s directory is damaged.')
      count = u64(rec, 32)
      dirSize = u64(rec, 40)
      dirOffset = u64(rec, 48)
    }
    if (count > limits.entries) {
      throw new ZipError(`The archive lists ${count.toLocaleString('en-US')} files; Stoke opens exports of up to ${limits.entries.toLocaleString('en-US')}.`)
    }
    if (dirSize > limits.directoryBytes) throw new ZipError('The archive’s directory is larger than any export’s.')
    if (dirOffset + dirSize > bytes) throw new ZipError('The archive’s directory points past its end; it may not have finished downloading.')
    const dir = readAt(fd, dirOffset, dirSize)
    const entries: ZipEntry[] = []
    let p = 0
    for (let n = 0; n < count; n++) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('The archive’s directory is damaged.')
      const flags = dir.readUInt16LE(p + 8)
      const method = dir.readUInt16LE(p + 10)
      const crc = dir.readUInt32LE(p + 16)
      let compressedSize = dir.readUInt32LE(p + 20)
      let size = dir.readUInt32LE(p + 24)
      const nameLen = dir.readUInt16LE(p + 28)
      const extraLen = dir.readUInt16LE(p + 30)
      const commentLen = dir.readUInt16LE(p + 32)
      let localOffset = dir.readUInt32LE(p + 42)
      const end = p + 46 + nameLen + extraLen + commentLen
      if (end > dir.length) throw new ZipError('The archive’s directory is damaged.')
      // Bit 11: the name is UTF-8. Otherwise CP437, whose ASCII half is all a path test needs.
      const name = dir.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen)
      if (isUnsafeZipName(name)) {
        throw new ZipError(`The archive holds a file named “${name.replace(/\0/g, '\\0').slice(0, 80)}”, which points outside it. It was not read.`)
      }
      if (size === MAX32 || compressedSize === MAX32 || localOffset === MAX32) {
        // The ZIP64 extra field carries, in this order, only the fields whose 32-bit slot is full.
        let e = p + 46 + nameLen
        const extraEnd = e + extraLen
        let found = false
        while (e + 4 <= extraEnd) {
          const id = dir.readUInt16LE(e)
          const len = dir.readUInt16LE(e + 2)
          if (id === 0x0001) {
            let q = e + 4
            const take = (): number => {
              if (q + 8 > e + 4 + len) throw new ZipError('The archive’s directory is damaged.')
              const v = u64(dir, q)
              q += 8
              return v
            }
            if (size === MAX32) size = take()
            if (compressedSize === MAX32) compressedSize = take()
            if (localOffset === MAX32) localOffset = take()
            found = true
            break
          }
          e += 4 + len
        }
        if (!found) throw new ZipError('The archive’s directory is damaged.')
      }
      entries.push({ name, flags, method, crc, compressedSize, size, localOffset })
      p = end
    }
    return { fd, bytes, entries }
  } catch (err) {
    closeSync(fd)
    throw err
  }
}

export function closeZip(z: ZipArchive): void {
  try {
    closeSync(z.fd)
  } catch {
    /* already closed */
  }
}

/**
 * One member's bytes. Refused before any inflating when it is encrypted,
 * compressed some other way, bigger than `memberBytes` or compressed past
 * `ratio`; the inflate stops at the declared size, and the CRC must agree.
 */
export function readZipEntry(z: ZipArchive, e: ZipEntry, limits: ZipLimits = CHAT_EXPORT_LIMITS): Buffer {
  if (e.flags & 0x1) throw new ZipError(`“${e.name}” is encrypted; export the data again without a password.`)
  if (e.method !== 0 && e.method !== 8) throw new ZipError(`“${e.name}” is compressed in a way Stoke does not read (method ${e.method}).`)
  if (e.size > limits.memberBytes) {
    throw new ZipError(`“${e.name}” is ${Math.round(e.size / 1024 ** 2).toLocaleString('en-US')} MB unpacked; Stoke reads up to ${Math.round(limits.memberBytes / 1024 ** 2).toLocaleString('en-US')} MB.`)
  }
  if (e.size > limits.ratioFloorBytes && e.size / Math.max(1, e.compressedSize) > limits.ratio) {
    throw new ZipError(`“${e.name}” unpacks to over ${limits.ratio} times its packed size — the shape of a zip bomb, not an export. It was not read.`)
  }
  if (e.method === 0 && e.compressedSize !== e.size) throw new ZipError('The archive’s directory is damaged.')
  const head = readAt(z.fd, e.localOffset, 30)
  if (head.readUInt32LE(0) !== SIG_LOCAL) throw new ZipError('The archive’s directory is damaged.')
  const start = e.localOffset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
  if (start + e.compressedSize > z.bytes) throw new ZipError('The archive ends early; it may not have finished downloading.')
  const packed = readAt(z.fd, start, e.compressedSize)
  let out: Buffer
  if (e.method === 0) {
    out = packed
  } else {
    try {
      // Never more than it said: a lying header stops here, not at the heap.
      out = inflateRawSync(packed, { maxOutputLength: Math.max(1, e.size) })
    } catch (err) {
      const code = (err as { code?: unknown }).code
      if (code === 'ERR_BUFFER_TOO_LARGE' || err instanceof RangeError) {
        throw new ZipError(`“${e.name}” unpacks to more than its stated size — the shape of a zip bomb, not an export. It was not read.`)
      }
      throw new ZipError(`“${e.name}” could not be unpacked; the archive may be damaged.`)
    }
  }
  if (out.length !== e.size) throw new ZipError(`“${e.name}” unpacked to a different size than stated; the archive may be damaged.`)
  if (crc32(out) !== e.crc) throw new ZipError(`“${e.name}” failed its checksum; the archive may be damaged.`)
  return out
}
