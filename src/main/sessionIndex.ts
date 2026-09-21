import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project, SessionIndexEntry } from '@shared/types'
import { projectsRoot } from './projects.ts'
import { CHUNK, mapLimit, promptOf, safeParse, titleOf } from './sessionFile.ts'

/**
 * What search needs to know about every session on the machine — its title and
 * its first prompt — without parsing any transcript in full.
 *
 * `listSessions` answers a different question and pays for it: it parses every
 * transcript of ONE project end to end, because the expanded list shows the
 * context meter and the message count. It streams and caches per file now
 * (gotcha 103), but a first listing still reads all of it, and run for every
 * project on a keystroke it would read everything under `~/.claude/projects` —
 * 297 MB across 95 transcripts on the machine this was written on, one of them
 * 38 MB.
 *
 * Neither field needs that. The first prompt is near the head of a transcript,
 * and the newest `ai-title` near its tail (measured: always inside the last
 * 31 KB, across every transcript here that has one). So each file costs at most
 * one `CHUNK` from either end, and then nothing at all until it changes,
 * because the result is cached against the file's mtime and size. Measured on
 * this machine against all 97 real transcripts: a cold pass read 34.8 MB in
 * ~80 ms, a warm one read nothing in 2 ms, and all 97 titles and first prompts
 * came out identical to `parseSession`'s full parse.
 *
 * Only top-level `*.jsonl` files are sessions. A session that ran subagents
 * also has `<dir>/<session-id>/subagents/*.jsonl` — 1,919 of them here — and
 * those are not conversations anyone would look for; `listSessions` ignores
 * them the same way, by never descending.
 *
 * Everything here is async, and bounded. A synchronous stat in the main
 * process stops every IPC reply and every frame with it (CLAUDE.md gotcha 40),
 * and an unbounded `Promise.all` over a hundred files opens a hundred handles
 * at once for no gain.
 */

/** How many files are stat'd and read at once. */
const CONCURRENCY = 8

interface Scanned {
  title: string | null
  firstPrompt: string | null
}

interface Cached {
  /** The history directory the file was listed from, for pruning. */
  dir: string
  mtimeMs: number
  size: number
  /**
   * A promise rather than the value, so two index passes that overlap — a
   * search started while a tab was opening, say — share one read of each file
   * instead of both reading it. It is set synchronously once a miss is known,
   * before anything is awaited, which is what makes the sharing reliable
   * (gotcha 20's shape: claim before the await, not after it).
   */
  scanned: Promise<Scanned | null>
}

/** File path -> what was last read from it, and the mtime/size it was read at. */
export type SessionIndexCache = Map<string, Cached>

export function createSessionIndexCache(): SessionIndexCache {
  return new Map()
}

/** The process's own cache. A suite passes its own so runs cannot see each other. */
const sharedCache = createSessionIndexCache()

/** Counters a suite reads to prove the reads are bounded and the cache is used. */
export interface SessionIndexStats {
  filesRead: number
  bytesRead: number
  cacheHits: number
}

export interface SessionIndexOptions {
  /** The directory holding the per-project history folders. `~/.claude/projects` by default. */
  root?: string
  cache?: SessionIndexCache
  stats?: SessionIndexStats
  /** Bytes read from each end of a transcript. `CHUNK` by default. */
  chunk?: number
  concurrency?: number
}

/**
 * Every session of every project in `projects` that has a history directory,
 * newest first.
 *
 * The caller hands in the project list rather than this module finding one, so
 * the IPC handler can pass exactly what `listProjects` returned — and a hidden
 * project, which that function has already dropped, never reaches the renderer
 * by way of its sessions.
 *
 * Two projects can name the same history directory (two config keys that differ
 * only in case, on a case-insensitive disk); each then gets an entry per
 * session, which is what expanding either of them already shows.
 */
export async function indexSessions(
  projects: readonly Project[],
  opts: SessionIndexOptions = {}
): Promise<SessionIndexEntry[]> {
  const root = opts.root ?? projectsRoot()
  const cache = opts.cache ?? sharedCache
  const chunk = opts.chunk ?? CHUNK
  const limit = Math.max(1, opts.concurrency ?? CONCURRENCY)

  // Which project paths each history directory answers for.
  const owners = new Map<string, string[]>()
  for (const p of projects) {
    if (!p.encodedDir) continue
    const dir = join(root, p.encodedDir)
    const list = owners.get(dir)
    if (!list) owners.set(dir, [p.path])
    else if (!list.includes(p.path)) list.push(p.path)
  }

  const listed = await mapLimit([...owners.keys()], limit, async (dir) => {
    try {
      const names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'))
      return { dir, names }
    } catch {
      return null // no history directory after all, or unreadable
    }
  })

  const files = listed.flatMap((l) => (l ? l.names.map((name) => ({ dir: l.dir, name })) : []))
  const found = await mapLimit(files, limit, async ({ dir, name }) => {
    const file = join(dir, name)
    // Null when it vanished between the listing and the stat.
    const st = await stat(file).catch(() => null)
    // A directory that happens to end in `.jsonl` is not a transcript.
    if (!st || !st.isFile()) return null
    const { mtimeMs, size } = st

    let entry = cache.get(file)
    if (entry && entry.mtimeMs === mtimeMs && entry.size === size) {
      if (opts.stats) opts.stats.cacheHits++
    } else {
      const fresh: Cached = { dir, mtimeMs, size, scanned: scanFile(file, size, chunk, opts.stats) }
      cache.set(file, fresh)
      // A failed read is not remembered: the next pass tries the file again.
      void fresh.scanned.then((r) => {
        if (r === null && cache.get(file) === fresh) cache.delete(file)
      })
      entry = fresh
    }

    const scanned = await entry.scanned
    if (!scanned) return null
    return { dir, id: name.slice(0, -'.jsonl'.length), modified: mtimeMs, ...scanned }
  })

  /*
   * Forget files that are gone, but only from directories this pass actually
   * listed. A directory that could not be read, or a project that was not in
   * this call's list, says nothing about what is in it.
   */
  const present = new Set(files.map(({ dir, name }) => join(dir, name)))
  const listedDirs = new Set(listed.flatMap((l) => (l ? [l.dir] : [])))
  for (const [file, cached] of cache) {
    if (listedDirs.has(cached.dir) && !present.has(file)) cache.delete(file)
  }

  const out: SessionIndexEntry[] = []
  for (const s of found) {
    if (!s) continue
    for (const projectPath of owners.get(s.dir) ?? []) {
      out.push({
        id: s.id,
        projectPath,
        title: s.title,
        firstPrompt: s.firstPrompt,
        modified: s.modified
      })
    }
  }
  return out.sort((a, b) => b.modified - a.modified)
}

async function scanFile(
  file: string,
  size: number,
  chunk: number,
  stats: SessionIndexStats | undefined
): Promise<Scanned | null> {
  try {
    const { head, tail, bytes } = await readEnds(file, size, chunk)
    if (stats) {
      stats.filesRead++
      stats.bytesRead += bytes
    }
    return scanText(head, tail)
  } catch {
    return null
  }
}

/**
 * The first `chunk` bytes and the last `chunk` bytes, through one handle. A file
 * no bigger than both together is read once, whole, and `tail` is null.
 *
 * `size` is the stat taken just before, so a session still being written may
 * have grown past it; the extra is simply not read this time, and the mtime
 * change makes the next pass read it.
 */
async function readEnds(
  file: string,
  size: number,
  chunk: number
): Promise<{ head: string; tail: string | null; bytes: number }> {
  const fh = await open(file, 'r')
  try {
    if (size <= chunk * 2) {
      const buf = Buffer.alloc(size)
      const { bytesRead } = await fh.read(buf, 0, size, 0)
      return { head: buf.subarray(0, bytesRead).toString('utf8'), tail: null, bytes: bytesRead }
    }
    const a = Buffer.alloc(chunk)
    const b = Buffer.alloc(chunk)
    const first = await fh.read(a, 0, chunk, 0)
    const last = await fh.read(b, 0, chunk, size - chunk)
    return {
      head: a.subarray(0, first.bytesRead).toString('utf8'),
      tail: b.subarray(0, last.bytesRead).toString('utf8'),
      bytes: first.bytesRead + last.bytesRead
    }
  } finally {
    await fh.close()
  }
}

/**
 * Title and first prompt out of a transcript's two ends.
 *
 * The first prompt comes from the head; the title is the newest `ai-title` in
 * the tail, or failing that the newest in the head — Claude retitles a session
 * as it goes, and a transcript whose later part is one enormous tool output can
 * push its last retitle out of the tail. `parseSession` reads a file under
 * 32 MB whole, so for a title that sits only in the untouched middle of a large
 * transcript the two can disagree; that has not been seen on a real one.
 *
 * Each cut end starts or finishes mid-line, so that fragment is not parsed as a
 * record. The substring tests in front of `safeParse` are a cheap filter, not
 * the rule: a user record's JSON must contain `"user"` and a title record's
 * must contain `ai-title`, and only lines that pass are parsed and then judged
 * by the same `promptOf`/`titleOf` `parseSession` uses.
 *
 * The head's cut line gets one second look, for the first prompt only — see
 * `promptFromCutLine`.
 */
function scanText(head: string, tail: string | null): Scanned {
  const headLines = head.split('\n')
  const cut = tail !== null ? headLines.pop() : undefined

  let firstPrompt: string | null = null
  let title: string | null = null
  for (const line of headLines) {
    if (firstPrompt === null && line.includes('"user"')) {
      const rec = safeParse(line)
      if (rec) firstPrompt = promptOf(rec)
    }
    if (line.includes('ai-title')) {
      const rec = safeParse(line)
      const t = rec ? titleOf(rec) : null
      if (t) title = t
    }
  }
  if (firstPrompt === null && cut !== undefined) firstPrompt = promptFromCutLine(cut)

  if (tail !== null) {
    for (const line of tail.split('\n').slice(1)) {
      if (!line.includes('ai-title')) continue
      const rec = safeParse(line)
      const t = rec ? titleOf(rec) : null
      if (t) title = t
    }
  }

  return { title, firstPrompt }
}

/* What a user message's own content looks like when it opens with typed text. */
const LEADING_TEXT = '"content":[{"type":"text","text":'
const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/y

/**
 * The first prompt out of a user record that the head's end cut through.
 *
 * The common way a first message outgrows 256 KB is pasted screenshots: the
 * CLI stores the typed text as the first content block and each image after it
 * as base64. Measured on this machine, one transcript in 97 opened with three
 * pasted images in a 753 KB line, so its first prompt was unreadable from the
 * head and that session could only be found by its title — and a session too
 * short to have been titled could not have been found at all.
 *
 * The typed text is whole even though the line is not, so it is taken from the
 * message's OWN content, and only when that opens with a text block. That
 * anchor is what keeps this from quoting a tool's output: a tool result is a
 * user record too, but its content opens with `{"tool_use_id"` (12,689 of the
 * 13,449 array-content user messages here; the other 760 open with `{"type"`),
 * and the text blocks nested inside it come after that. The text then goes
 * through `promptOf`, so it is judged and trimmed by the same rule as any other.
 *
 * One known difference from `parseSession`, which joins every text block: a
 * message with a second text block after its images, and a first block under
 * 300 characters, gets only the first here.
 */
function promptFromCutLine(line: string): string | null {
  if (!line.startsWith('{')) return null
  const message = line.indexOf('"message":')
  const user = line.indexOf('"type":"user"')
  if (message < 0 || user < 0 || user > message) return null
  const content = line.indexOf('"content":', message)
  if (content < 0 || !line.startsWith(LEADING_TEXT, content)) return null
  STRING_LITERAL.lastIndex = content + LEADING_TEXT.length
  const literal = STRING_LITERAL.exec(line)
  if (!literal) return null // the text itself runs past the cut
  let text: unknown
  try {
    text = JSON.parse(literal[0])
  } catch {
    return null
  }
  return typeof text === 'string' ? promptOf({ type: 'user', message: { content: text } }) : null
}
