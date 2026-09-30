/*
 * The on-disk half of Codex usage (shared/codexUsage.ts is the parser): find
 * the newest rollout under a Codex home that states its limits, and read only
 * its TAIL.
 *
 * A rollout is one session's whole record — the one on this machine that
 * stated limits most recently is 28 KB, the longest runs to tens of MB of tool
 * output — and the line wanted is the LAST `token_count`, written after every
 * turn. So nothing here ever reads a whole file (gotcha 103): the last
 * `CODEX_TAIL_BYTES` are read, cut at the first newline BEFORE decoding (a
 * read can start inside a multi-byte character; 0x0A never occurs inside
 * one), and parsed from the end.
 *
 * Newest by mtime, not by name, among the newest day folders: `codex resume`
 * appends to the rollout of the day the session STARTED, so the file written
 * last can sit in an older folder than one opened and abandoned since. The
 * newest file may state nothing (a session with no finished turn — the case
 * on this machine the day this was written), so up to `CODEX_MAX_FILES` are
 * tried, newest first.
 *
 * Read-only, async, under a deadline (gotcha 40: a Codex home can sit on a
 * volume that is asleep). No electron import, so `verify:usage` runs it
 * against synthetic homes.
 */
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { codexUsageSnapshot, lastCodexLimits } from '../shared/codexUsage.ts'
import type { UsageSnapshot } from '../shared/types.ts'

/** How much of a rollout's end is read: many turns' worth of token_count lines. */
export const CODEX_TAIL_BYTES = 256 * 1024
/** Rollouts tried, newest first, before concluding none states limits. */
export const CODEX_MAX_FILES = 6
/** Day folders scanned for candidates, newest first. */
const CODEX_MAX_DAYS = 4
/** The whole read's budget. */
export const CODEX_READ_DEADLINE_MS = 3_000

const ROLLOUT = /^rollout-.*\.jsonl$/

async function namesDesc(dir: string, pattern: RegExp): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  return names.filter((n) => pattern.test(n)).sort().reverse()
}

/**
 * The newest rollouts under `<home>/sessions`, newest mtime first: every
 * rollout of the newest `CODEX_MAX_DAYS` day folders that hold any.
 */
export async function newestRollouts(sessionsDir: string, limit = CODEX_MAX_FILES): Promise<{ path: string; mtimeMs: number }[]> {
  const files: { path: string; mtimeMs: number }[] = []
  let days = 0
  outer: for (const y of await namesDesc(sessionsDir, /^\d{4}$/)) {
    for (const m of await namesDesc(join(sessionsDir, y), /^\d{2}$/)) {
      for (const d of await namesDesc(join(sessionsDir, y, m), /^\d{2}$/)) {
        const dir = join(sessionsDir, y, m, d)
        const names = await namesDesc(dir, ROLLOUT)
        if (!names.length) continue
        const stats = await Promise.all(
          names.map(async (n) => {
            const st = await stat(join(dir, n)).catch(() => null)
            return st?.isFile() ? { path: join(dir, n), mtimeMs: st.mtimeMs } : null
          })
        )
        for (const s of stats) if (s) files.push(s)
        if (++days >= CODEX_MAX_DAYS) break outer
      }
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit)
}

/**
 * The last `bytes` of a file as text, starting after the first newline when
 * the read did not start at the beginning — cut as bytes, then decoded.
 */
export async function readTail(path: string, bytes = CODEX_TAIL_BYTES): Promise<string> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const start = Math.max(0, size - bytes)
    const buf = Buffer.alloc(size - start)
    let got = 0
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, start + got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    let body = buf.subarray(0, got)
    if (start > 0) {
      const nl = body.indexOf(0x0a)
      body = nl === -1 ? body.subarray(body.length) : body.subarray(nl + 1)
    }
    return body.toString('utf8')
  } finally {
    await fh.close()
  }
}

async function readHome(home: string, now: number): Promise<UsageSnapshot> {
  const files = await newestRollouts(join(home, 'sessions'))
  for (const f of files) {
    const text = await readTail(f.path).catch(() => '')
    const limits = lastCodexLimits(text)
    if (limits) return codexUsageSnapshot(limits, now, f.mtimeMs)
  }
  return codexUsageSnapshot(null, now, files[0]?.mtimeMs ?? null)
}

/**
 * The plan limits one Codex home's newest turn stated.
 *
 * @param home the account's `CODEX_HOME` (the Default account's is
 *             `CODEX_HOME` as inherited, else `~/.codex`)
 */
export async function readCodexUsage(home: string, now = Date.now(), deadlineMs = CODEX_READ_DEADLINE_MS): Promise<UsageSnapshot> {
  let timer: NodeJS.Timeout | null = null
  const late = new Promise<UsageSnapshot>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          source: 'codex',
          windows: [],
          extraCredits: null,
          fetchedAt: now,
          error: 'Codex’s sessions folder did not answer in time.',
          asOfLastTurn: true
        }),
      deadlineMs
    )
  })
  try {
    return await Promise.race([readHome(home, now), late])
  } catch {
    return { source: 'codex', windows: [], extraCredits: null, fetchedAt: now, error: 'Codex’s sessions could not be read.', asOfLastTurn: true }
  } finally {
    if (timer) clearTimeout(timer)
  }
}
