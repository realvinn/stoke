/**
 * Reading a transcript for Find in a conversation, inside its worker
 * (`transcriptFind.worker.ts`). The rules for WHAT is searched live in
 * src/shared/transcriptFind.ts; this is only the reading, which has to be
 * bounded twice over:
 *
 * - **Never one block** (gotcha 103): the file is read in 1 MB chunks, each cut
 *   at its last newline BEFORE it is decoded, so a multi-byte character or a
 *   record split across two reads is never decoded in halves.
 * - **Never the whole of a huge file**: past `LOCAL_TAIL_BYTES` only the end is
 *   read — the newest part, which is what Find lists first — and the answer
 *   says so (`partial`).
 *
 * Synchronous reads, on purpose: this runs on the worker's own thread, never on
 * main's (gotcha 40), and a sync loop is the simplest bounded reader.
 *
 * Relative `.ts` imports and no parameter properties, so `verify:find` runs it
 * under `node --experimental-strip-types`.
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { blocksOfJsonl, blocksOfLine, newBlockContext, type FindBlock } from '../shared/transcriptFind.ts'

/** The most of a local transcript Find reads, from its end. */
export const LOCAL_TAIL_BYTES = 64 * 1024 * 1024

/** One read. A record is usually far smaller; a long tool output can be larger, and is carried. */
export const CHUNK_BYTES = 1024 * 1024

const NL = 0x0a

export interface ReadBlocks {
  blocks: FindBlock[]
  /** The file was larger than the cap and only its end was read. */
  partial: boolean
  size: number
  mtimeMs: number
}

/**
 * Every searchable block in a transcript file, oldest first. `tailBytes` and
 * `chunkBytes` are parameters so the suite can put a record across a chunk
 * boundary and a cap through the middle of a file without writing 64 MB.
 */
export function readBlocks(
  file: string,
  includeTools: boolean,
  tailBytes: number = LOCAL_TAIL_BYTES,
  chunkBytes: number = CHUNK_BYTES
): ReadBlocks {
  const fd = openSync(file, 'r')
  try {
    const st = fstatSync(fd)
    const partial = st.size > tailBytes
    let pos = partial ? st.size - tailBytes : 0
    const ctx = newBlockContext()
    const blocks: FindBlock[] = []
    const take = (text: string): void => {
      for (const line of text.split('\n')) {
        if (!line) continue
        for (const b of blocksOfLine(line.endsWith('\r') ? line.slice(0, -1) : line, includeTools, ctx)) blocks.push(b)
      }
    }
    const buf = Buffer.allocUnsafe(chunkBytes)
    let carry: Buffer[] = []
    let carryLen = 0
    // Reading from the middle of a file starts mid-record: drop up to the first
    // newline, which the parser would drop anyway as unreadable.
    let skipFirst = partial
    while (pos < st.size) {
      const got = readSync(fd, buf, 0, Math.min(chunkBytes, st.size - pos), pos)
      if (got === 0) break
      pos += got
      let chunk = buf.subarray(0, got)
      if (skipFirst) {
        const first = chunk.indexOf(NL)
        if (first < 0) continue
        chunk = chunk.subarray(first + 1)
        skipFirst = false
      }
      const nl = chunk.lastIndexOf(NL)
      if (nl < 0) {
        carry.push(Buffer.from(chunk))
        carryLen += chunk.length
        continue
      }
      const head = carryLen ? Buffer.concat([...carry, chunk.subarray(0, nl)], carryLen + nl) : chunk.subarray(0, nl)
      take(head.toString('utf8'))
      carry = [Buffer.from(chunk.subarray(nl + 1))]
      carryLen = chunk.length - nl - 1
    }
    // The last record has no newline after it while Claude is still writing it.
    if (carryLen) take(Buffer.concat(carry, carryLen).toString('utf8'))
    return { blocks, partial, size: st.size, mtimeMs: st.mtimeMs }
  } finally {
    closeSync(fd)
  }
}

/** The same blocks from a copy held in memory ("Just this once" over SSH). */
export function readBlocksFromText(text: string, includeTools: boolean): FindBlock[] {
  return blocksOfJsonl(text, includeTools)
}

/**
 * One parse kept, so each keystroke of a query does not read the file again.
 * Keyed by everything that changes the answer: the file and its size and
 * mtime (Claude appends while you search), or a text copy's key, and whether
 * tools are in.
 */
export class BlockCache {
  private key = ''
  private value: ReadBlocks | null = null

  forFile(file: string, includeTools: boolean, stat: { size: number; mtimeMs: number }): ReadBlocks {
    const key = `f\0${file}\0${stat.size}\0${stat.mtimeMs}\0${includeTools}`
    if (this.value && this.key === key) return this.value
    const read = readBlocks(file, includeTools)
    this.key = key
    this.value = read
    return read
  }

  forText(textKey: string, text: string, includeTools: boolean): ReadBlocks {
    const key = `t\0${textKey}\0${text.length}\0${includeTools}`
    if (this.value && this.key === key) return this.value
    const read: ReadBlocks = { blocks: readBlocksFromText(text, includeTools), partial: false, size: text.length, mtimeMs: 0 }
    this.key = key
    this.value = read
    return read
  }
}
