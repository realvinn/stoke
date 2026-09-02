import {
  closeSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { claudeSettingsPath } from './claudePaths.ts'
import { NEVER_OFFERED, validateSetting, type ClaudeSettingValue } from '../shared/claudeConfig.ts'

/**
 * Reading and patching Claude Code's own `~/.claude/settings.json`.
 *
 * Two rules govern everything here.
 *
 * **Unknown keys survive verbatim.** This file is the user's, not Stoke's, and
 * it holds far more than Stoke draws — 156 keys are possible and several carry
 * union-typed values (`enabledPlugins` is `boolean | string[] | object`) whose
 * meaning a round trip through a typed model would quietly change. So a patch
 * is a read, one key set or deleted, and a write. Never a serialisation of
 * anything Stoke built.
 *
 * **Unset is a value.** Clearing a control deletes the key rather than writing
 * `null` or `false`, because absent is a distinct state the CLI reads
 * differently — see the tri-state note in shared/claudeConfig.ts.
 *
 * No lock against the CLI. Unlike the global config this file is hand-owned and
 * the CLI writes it only on an explicit user action, so a temp+rename is enough;
 * the CLI reads it through a watcher, so a running session picks the change up
 * without a restart.
 *
 * Stoke's own writes ARE serialised, which is a different problem and was
 * missing. See `queue` below.
 */

/**
 * One write at a time, in the order they were asked for.
 *
 * `patchClaudeSetting` is a read-modify-write with an `await` in the middle, so
 * two overlapping calls both read the pre-write file, each computes a `next`
 * from it, and the second rename silently discards the first's key — while both
 * return `ok: true`. Measured against a real temp settings.json: patching
 * `verbose` and `autoCompactEnabled` through `Promise.all` left a file
 * containing only `autoCompactEnabled`, with both callers told they had
 * succeeded.
 *
 * Reachable from the panel as it is drawn: ClaudeCodeSettings disables only the
 * row currently in flight (`disabled={busy === spec.key}`), so a second control
 * pressed inside one IPC round trip is an ordinary thing to do, not a race
 * someone has to engineer. Gotcha 57's shape — two writers, no invalidation —
 * except that here the second writer is the same function.
 *
 * A queue rather than the global config's mkdir lock: that lock exists to
 * arbitrate with the CLI, which contends for `~/.claude.json` constantly and
 * writes this file only when a person acts. This one only has to make Stoke
 * agree with itself, and a promise chain does that without a lock file to leave
 * behind if the process dies mid-write.
 */
let queue: Promise<unknown> = Promise.resolve()

function serialised<T>(job: () => Promise<T>): Promise<T> {
  // Chained off a swallowed tail so one rejected job cannot poison the queue
  // for every later caller.
  const next = queue.then(job, job)
  queue = next.catch(() => {})
  return next
}

export interface ClaudeSettingsRead {
  path: string
  /** Parsed settings, or null when the file is absent or unreadable. */
  values: Record<string, unknown> | null
  /**
   * Why `values` is null, or why a write would be refused. Null when the file
   * simply does not exist yet, which is not an error — it is a fresh install.
   */
  error: string | null
  exists: boolean
}

function settingsFile(): string {
  return claudeSettingsPath(process.env, homedir())
}

/** A leading BOM parses as nothing at all, so strip it. The CLI tolerates one too. */
function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export async function readClaudeSettings(): Promise<ClaudeSettingsRead> {
  const path = settingsFile()
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { path, values: null, error: null, exists: false }
    return { path, values: null, error: `Could not read ${path}: ${String(err)}`, exists: true }
  }
  try {
    const parsed: unknown = JSON.parse(stripBom(raw))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { path, values: null, error: `${path} is not a JSON object.`, exists: true }
    }
    return { path, values: parsed as Record<string, unknown>, error: null, exists: true }
  } catch (err) {
    /*
     * Refusing rather than repairing. Claude Code's own reaction to an
     * unparseable config is to back it up and reset to defaults, and Stoke
     * overwriting a file it could not read would be the same destructive move
     * with less standing to make it.
     */
    return {
      path,
      values: null,
      error: `${path} is not valid JSON (${String(err)}). Stoke will not overwrite it.`,
      exists: true
    }
  }
}

/**
 * The CLI's own write shape, and worth matching rather than approximating.
 *
 * Sibling temp file, `O_EXCL`, existing mode preserved, **fsync before the
 * rename**, then rename. The rename is retried on `EPERM`/`EBUSY`/`EEXIST`
 * because those are routine on Windows — an antivirus scanner or an open handle
 * — and the CLI does *not* retry: its own retry predicate is stubbed to return
 * false, and on failure it falls back to a non-atomic in-place truncate-write
 * that can leave the file torn.
 */
export function writeJsonAtomic(path: string, text: string): void {
  const tmp = `${path}.stoke.${process.pid}.${randomBytes(6).toString('hex')}`
  let mode = 0o600
  try {
    mode = statSync(path).mode & 0o777
  } catch {
    // A new file gets 0600: this one holds tokens' worth of trust, not secrets
    // exactly, but there is no reason for it to be world-readable.
  }
  // 'wx' is O_WRONLY|O_CREAT|O_EXCL — the random suffix means a collision is a
  // bug worth hearing about rather than something to overwrite.
  const fd = openSync(tmp, 'wx', mode)
  try {
    writeSync(fd, text, null, 'utf8')
    try {
      fchmodSync(fd, mode)
    } catch {
      // Some filesystems do not support it. Not worth failing a settings write.
    }
    // Before the rename, not after: a rename that lands ahead of the data is
    // how a crash turns an atomic write into an empty file.
    fsyncSync(fd)
    // Touch fstat so a zero-length write cannot pass silently.
    if (fstatSync(fd).size === 0 && text.length > 0) throw new Error('wrote nothing')
  } finally {
    closeSync(fd)
  }

  let lastErr: unknown = null
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      renameSync(tmp, path)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EEXIST') break
      // Busy-wait briefly: this runs on the main process and the contended
      // window is milliseconds, so a timer would cost more than it saves.
      const until = Date.now() + 20 * (attempt + 1)
      while (Date.now() < until) {
        /* spin */
      }
    }
  }
  try {
    unlinkSync(tmp)
  } catch {
    // Best effort; a leftover temp is untidy, not harmful.
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export interface PatchResult {
  ok: boolean
  error: string | null
  read: ClaudeSettingsRead
}

/**
 * Set or clear one allowlisted key.
 *
 * `undefined` deletes. Anything not in the allowlist is refused here as well as
 * in the panel, because an IPC message is not a form — and because the CLI will
 * not refuse a bad value on anyone's behalf: several of these enums carry
 * `.catch(void 0)`, so an out-of-range write silently produces *no* setting
 * rather than an error.
 */
export function patchClaudeSetting(key: string, value: ClaudeSettingValue): Promise<PatchResult> {
  // Every path is inside the queue, including the validation refusal, so that
  // the `read` a refusal reports is not a snapshot taken while somebody else's
  // write was landing.
  return serialised(() => patchOnce(key, value))
}

async function patchOnce(key: string, value: ClaudeSettingValue): Promise<PatchResult> {
  const invalid = validateSetting(key, value)
  if (invalid) {
    return { ok: false, error: invalid, read: await readClaudeSettings() }
  }

  const read = await readClaudeSettings()
  if (read.error) return { ok: false, error: read.error, read }

  // An absent file is fine to create — that is a fresh Claude Code install, and
  // the CLI reads what it finds.
  const next: Record<string, unknown> = { ...(read.values ?? {}) }
  if (value === undefined) delete next[key]
  else next[key] = value

  try {
    // Two-space indent and a trailing newline: the CLI emits two-space indent
    // for the global config and this file is hand-edited often enough that a
    // final newline is worth more than byte-identical mimicry.
    writeJsonAtomic(read.path, `${JSON.stringify(next, null, 2)}\n`)
  } catch (err) {
    return { ok: false, error: `Could not write ${read.path}: ${String(err)}`, read }
  }

  return { ok: true, error: null, read: await readClaudeSettings() }
}

/**
 * Keys present in the file that Stoke draws no control for.
 *
 * Shown read-only in the panel rather than hidden, so it is obvious that this
 * file has a life beyond the eleven switches on screen — and so nobody reads an
 * empty panel as an empty file.
 */
export function untouchedKeys(values: Record<string, unknown> | null, drawn: string[]): string[] {
  if (!values) return []
  const known = new Set([...drawn, ...NEVER_OFFERED])
  return Object.keys(values)
    .filter((k) => !known.has(k))
    .sort()
}
