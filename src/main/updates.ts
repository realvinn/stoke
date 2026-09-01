import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { CliRunResult } from '@shared/api'
import type { ChannelLag, CliUpdateInfo } from '@shared/types'
import { buildEnvPath, findClaude, loginPathProbeFailed, notFoundError, spawnSpec } from './cli.ts'
import { readClaudeSettings } from './claudeSettings.ts'

const execFileAsync = promisify(execFile)

/**
 * Version and health for the Claude Code CLI.
 *
 * The CLI already auto-updates itself; the value Stoke adds is telling you when
 * a newer version exists without silently changing anything, and surfacing the
 * warnings `claude doctor` produces (a stale npm-global install shadowing the
 * native one is easy to miss and hard to diagnose).
 */

/**
 * Aliased rather than declared, so the shape the renderer draws and the shape
 * this file builds cannot drift apart. A type-only import, which
 * `node --experimental-strip-types` removes outright — which is what lets
 * `verify:updates` load this module with no build step and no alias resolver.
 */
export type UpdateInfo = CliUpdateInfo

const REGISTRY = 'https://registry.npmjs.org/@anthropic-ai/claude-code'

/**
 * The channel the CLI follows when `autoUpdatesChannel` is unset.
 *
 * Taken from the CLI's own fallback, `settings?.autoUpdatesChannel ?? "latest"`,
 * read out of the 2.1.237 bundle — not guessed from the npm dist-tag of the
 * same name. Absent and an explicit `"latest"` therefore behave identically,
 * which is what lets Stoke's own control (`autoUpdatesChannel` in
 * shared/claudeConfig.ts, `unsetMeans: 'latest'`) clear the key rather than
 * write a default.
 */
export const DEFAULT_CHANNEL = 'latest'

/**
 * Which release channel `claude update` will actually follow.
 *
 * Pure, with the settings object passed in, so `verify:updates` can ask the
 * question without a `~/.claude/settings.json` to read.
 */
export function channelFrom(values: Record<string, unknown> | null): string {
  const raw = values?.['autoUpdatesChannel']
  if (typeof raw !== 'string') return DEFAULT_CHANNEL
  const trimmed = raw.trim()
  return trimmed === '' ? DEFAULT_CHANNEL : trimmed
}

/**
 * The npm dist-tag that answers "what would this channel install".
 *
 * The two sources agree, which is the only reason one npm request can stand in
 * for the channel the CLI actually reads. Measured 2026-08-31, both directions:
 *
 *   npm dist-tags                        GCS claude-code-releases/<channel>
 *   stable → 2.1.236                     stable → 2.1.236
 *   latest → 2.1.251                     latest → 2.1.251
 *
 * `disabled` is not a channel but a way of switching the whole mechanism off,
 * so there is no tag for it. It maps to `latest` deliberately: with updates off
 * the useful thing is still to be *told* a newer version exists, and
 * `shouldAutoUpdate` is the place that refuses to act on it. Reporting nothing
 * at all would make "switched off" and "already current" the same screen.
 *
 * A channel with no tag (`rc` is offered by Stoke's own control and publishes
 * neither an npm dist-tag nor a GCS object) 404s, and `checkForUpdate` reports
 * that as itself rather than silently falling back to a number from a channel
 * the CLI is not following.
 */
export function distTagFor(channel: string): string {
  return channel === 'disabled' ? DEFAULT_CHANNEL : channel
}

/**
 * Is the channel this CLI follows behind the one everybody else is on?
 *
 * Pure, and separate from the two requests that feed it, for gotcha 31's
 * reason — the rule is the part worth asserting and the fetch is the part no
 * suite can reach. `verify:updates` calls it directly.
 *
 * The question this answers is the one nothing in Stoke used to ask. Gotcha 46
 * fixed the panel so it reads the configured channel and therefore stops
 * advertising updates `claude update` will refuse — correct, and it made the
 * panel silent about a machine drifting three weeks behind on `stable` while
 * every screen honestly said there was nothing to install. Reporting the
 * channel's own version is the truth; reporting only it is not the whole truth.
 *
 * The four cases, in the order they are tested:
 *
 *  - **The channel already resolves to `latest`.** Nothing to say, and this is
 *    most machines. `disabled` lands here too, via `distTagFor` — the CLI's
 *    updates being switched off is its own sentence in the panel and not a
 *    stale channel, so saying both would be noise on top of a contradiction.
 *  - **No `latest` version came back.** The extra request failed, or was never
 *    made. Nothing is claimed from a reading that does not exist; the check the
 *    user waits on is unaffected either way.
 *  - **The channel publishes nothing** (`channelVersion` null — `rc`, which
 *    Stoke's own control offers and npm does not publish). A lag, deliberately,
 *    because "you will never update again" wants the same remedy as "you are
 *    stale", and reporting only the 404 leaves the reader to work that out.
 *  - **Otherwise, compare.** Level or ahead is not a lag: an install can sit
 *    ahead of its channel (2.1.237 on a `stable` that had rolled back to
 *    2.1.236), and so can a channel, and neither is something to nag about.
 */
export function channelLag(
  channel: string,
  channelVersion: string | null,
  latestVersion: string | null
): ChannelLag | null {
  if (distTagFor(channel) === DEFAULT_CHANNEL) return null
  if (!latestVersion) return null
  if (channelVersion && compare(latestVersion, channelVersion) <= 0) return null
  return { channel, channelVersion, latestVersion }
}

/**
 * `claude` writes colour even when nothing is attached to stdout. Measured
 * against 2.1.226 through a plain `execFile`: the "up to date" line arrives as
 * `\x1b[32mClaude Code is up to date (2.1.226)\x1b[39m`. A <pre> has no terminal
 * to interpret those, so they render as literal `[32m` noise wrapped around the
 * one sentence the reader is looking for.
 */
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g

function clean(text: string): string {
  return text.replace(ANSI, '').trim()
}

/**
 * Node's `execFile` defaults `maxBuffer` to 1 MB and **kills the child** when it
 * is exceeded — see gotcha 13 in CLAUDE.md, which this call site did not honour.
 * An update killed that way still leaves plausible-looking progress text behind,
 * so the cap has to be far past anything these commands emit.
 */
const MAX_OUTPUT = 8 * 1024 * 1024

/** Extract "2.1.220" from "2.1.220 (Claude Code)". */
function parseVersion(raw: string | null): string | null {
  if (!raw) return null
  const m = /(\d+\.\d+\.\d+)/.exec(raw)
  return m ? m[1] : null
}

function compare(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

async function currentVersion(claudePath: string | null): Promise<string | null> {
  const exe = await findClaude(claudePath)
  if (!exe) return null
  try {
    const spec = spawnSpec(exe, ['--version'])
    const { stdout } = await execFileAsync(spec.file, spec.args, {
      timeout: 15_000,
      maxBuffer: MAX_OUTPUT,
      encoding: 'utf8',
      env: { ...process.env, PATH: await buildEnvPath() }
    })
    return parseVersion(clean(stdout))
  } catch {
    return null
  }
}

/**
 * What one dist-tag resolves to, as a value rather than an exception.
 *
 * Extracted from `checkForUpdate` when a second lookup joined the first, and
 * non-throwing because the two callers want opposite things from a failure.
 * The channel's own lookup failing is the check failing and has to be reported;
 * the `latest` lookup failing is a missing nicety that must never be able to
 * turn a working check into a broken one. A shared `throw` makes the second of
 * those the accident waiting to happen.
 *
 * `missing` is separated from `error` for the same reason it always was: a 404
 * means the tag does not exist, which is a fact about configuration, and
 * rendering it as a network problem sends the reader to the wrong place.
 */
async function lookupTag(
  tag: string
): Promise<{ version: string | null; error: string | null; missing: boolean }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 10_000)
  try {
    const res = await fetch(`${REGISTRY}/${encodeURIComponent(tag)}`, { signal: controller.signal })
    if (res.status === 404) return { version: null, error: null, missing: true }
    if (!res.ok) return { version: null, error: `registry responded ${res.status}`, missing: false }
    const body = (await res.json()) as { version?: string }
    return { version: body.version ?? null, error: null, missing: false }
  } catch (err) {
    return {
      version: null,
      error: err instanceof Error ? err.message : String(err),
      missing: false
    }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Read-only check. The npm registry is used rather than running `claude update`,
 * which would install as a side effect of merely looking.
 *
 * **The channel is read first, and asking the wrong one is not a rounding
 * error.** This used to fetch the `latest` dist-tag unconditionally while
 * `claude update` followed whatever `autoUpdatesChannel` said — so on this
 * machine, pinned to `stable`, the panel reported "2.1.251 available" for an
 * update the CLI would decline forever, and `updateVerdict` then blamed the
 * package manager for a refusal that was configuration. Worse, Stoke *draws*
 * that setting (shared/claudeConfig.ts:200) — two halves of one app disagreeing
 * about a key one of them writes.
 */
export async function checkForUpdate(claudePath: string | null): Promise<UpdateInfo> {
  const current = await currentVersion(claudePath)
  // A settings file that cannot be read is not an error here: `channelFrom`
  // falls back to the CLI's own default, which is what the CLI would do too.
  const channel = channelFrom((await readClaudeSettings()).values)
  const info: UpdateInfo = {
    current,
    latest: null,
    updateAvailable: false,
    checkedAt: Date.now(),
    error: null,
    channel,
    behindLatest: null
  }

  const tag = distTagFor(channel)
  /*
   * Two requests, in parallel, and the second one only exists when the channel
   * is not already `latest` — which on most machines it is, so most checks
   * still cost exactly one request. Parallel rather than sequential because
   * the answer to "is my channel stale" is worthless if getting it makes the
   * check that people actually wait on twice as slow.
   */
  const [followed, newest] = await Promise.all([
    lookupTag(tag),
    tag === DEFAULT_CHANNEL ? Promise.resolve(null) : lookupTag(DEFAULT_CHANNEL)
  ])

  /*
   * Computed BEFORE the error returns below, deliberately. A channel that
   * publishes no tag is the case most in need of this sentence — `rc` 404s, so
   * `followed` is an error and the old code returned here having said only
   * that npm does not publish it. Knowing that `latest` has a version, and
   * that switching to it is the fix, is the actionable half.
   */
  info.behindLatest = channelLag(channel, followed.version, newest?.version ?? null)

  if (followed.missing) {
    // Named rather than reported as a bare 404, which would send the reader to
    // the network when the answer is a channel that publishes nothing.
    info.error = `the CLI follows the "${channel}" channel, which npm does not publish`
    return info
  }
  if (followed.error) {
    info.error = followed.error
    return info
  }

  info.latest = followed.version
  if (info.current && info.latest) {
    info.updateAvailable = compare(info.latest, info.current) > 0
  }
  return info
}

/**
 * What `execFile` was actually unhappy about, in a sentence.
 *
 * Node overloads one `code` field across three unrelated things: a POSIX errno
 * string when the spawn itself failed, one of its own `ERR_*` identifiers, and a
 * plain number when the child ran and exited non-zero. They need separating
 * before any of them can be shown to a person.
 *
 * @param command the command as the user would type it, so the sentence names
 *   the thing that failed rather than "the process".
 */
export function describeExecError(
  err: { code?: string | number; killed?: boolean; signal?: string | null; message?: string },
  command: string,
  timeoutMs: number
): string {
  /*
   * Order matters, and this is the ordering bug that hid every timeout.
   *
   * A `timeout` breach does not produce an exit code — Node kills the child, so
   * the error arrives with `killed: true`, `signal: 'SIGTERM'` and `code: null`.
   * Testing the code first therefore reports "exited with code null", throwing
   * away the single fact that explains what happened.
   */
  if (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT') {
    const secs = Math.round(timeoutMs / 1000)
    return `\`${command}\` did not finish within ${secs}s and was stopped. Anything it printed before that is below; the install may be incomplete.`
  }
  if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return `\`${command}\` produced more output than Stoke will hold and was stopped.`
  }
  if (err.code === 'ENOENT') {
    return `\`${command}\` could not be started: the executable is no longer at the path Stoke found it at.`
  }
  if (err.code === 'EACCES') {
    return `\`${command}\` could not be started: permission denied.`
  }
  if (typeof err.code === 'number') {
    return `\`${command}\` exited with code ${err.code}.`
  }
  return err.message || `\`${command}\` failed.`
}

/**
 * Run one claude subcommand and report whether it worked.
 *
 * The point of this function is the return type. Its predecessor returned
 * `stdout + stderr` from **both** the success path and the catch, so a clean
 * run, a non-zero exit, a three-minute timeout and a killed-for-buffer-overflow
 * child were all the same value: a string, rendered in the same grey box. That
 * is the whole reason a failed update was indistinguishable from a successful
 * one — not that the reason was unknowable, but that it was computed and then
 * discarded one line later.
 */
async function runCli(
  claudePath: string | null,
  args: string[],
  timeoutMs: number
): Promise<{ ok: boolean; output: string; error: string | null }> {
  const exe = await findClaude(claudePath)
  if (!exe) {
    return { ok: false, output: '', error: notFoundError(loginPathProbeFailed()) }
  }

  const command = `claude ${args.join(' ')}`
  try {
    const spec = spawnSpec(exe, args)
    const { stdout, stderr } = await execFileAsync(spec.file, spec.args, {
      timeout: timeoutMs,
      maxBuffer: MAX_OUTPUT,
      encoding: 'utf8',
      env: { ...process.env, PATH: await buildEnvPath() }
    })
    return { ok: true, output: clean(`${stdout}${stderr}`), error: null }
  } catch (err) {
    const e = err as {
      code?: string | number
      killed?: boolean
      signal?: string | null
      message?: string
      stdout?: string
      stderr?: string
    }
    return {
      ok: false,
      output: clean(`${e.stdout ?? ''}${e.stderr ?? ''}`),
      error: describeExecError(e, command, timeoutMs)
    }
  }
}

/**
 * Run the CLI's own updater.
 *
 * `from` and `to` are read either side of the run and are the load-bearing part:
 * `claude update` can exit 0 having changed nothing — that is what it does when
 * it is already current, and also what a blocked npm-global install looks like
 * from the outside. Exit status alone therefore cannot answer "did it update?",
 * so the two versions are reported as facts and the caller compares them.
 */
export async function runUpdate(claudePath: string | null): Promise<CliRunResult> {
  const from = await currentVersion(claudePath)
  const ran = await runCli(claudePath, ['update'], 180_000)
  // Re-read on the failure path too. A partly-applied update is exactly the case
  // where the version on disk is worth knowing, and assuming it still reads
  // `from` would state something that was never checked.
  const to = await currentVersion(claudePath)
  return { ...ran, from, to }
}

/** `claude doctor` output, including the warnings it finds. */
export async function runDoctor(claudePath: string | null): Promise<CliRunResult> {
  const ran = await runCli(claudePath, ['doctor'], 60_000)
  return { ...ran, from: null, to: null }
}

/* ------------------------------------------------------- keeping it current */

/**
 * How often the CLI is checked when Stoke is left running, and how long a
 * failed attempt is left alone for.
 *
 * Six hours because the CLI ships several times a week, not several times an
 * hour, and every check costs a `claude --version` spawn plus a registry
 * request. The retry interval is shorter but not much: the common failures
 * here — an npm-global install that needs a permission Stoke does not have, a
 * `claude` that has been moved — do not fix themselves in a minute, and
 * hammering `claude update` against one of them helps nobody.
 */
export const AUTO_CHECK_MS = 6 * 60 * 60 * 1000
export const AUTO_RETRY_MS = 60 * 60 * 1000

export interface AutoUpdateDecision {
  /** Run `claude update` now. */
  run: boolean
  /** Why not, for the log and the panel. Null when `run` is true. */
  reason: string | null
}

/**
 * What the last automatic attempt was and what came of it.
 *
 * `target` and `from` are here rather than just a timestamp because the two
 * things this module talks to can disagree indefinitely, and a time-based floor
 * cannot tell an indefinite disagreement from a transient one.
 *
 * The disagreement that produced this design was a bug, since fixed:
 * `checkForUpdate` read the npm `latest` dist-tag while `claude update`
 * followed the channel in `autoUpdatesChannel`. Measured 2026-08-28 — registry
 * 2.1.250, installed 2.1.237, and `claude update` answering
 *
 *   "You're running 2.1.237, which is newer than the stable channel's 2.1.236.
 *    Skipping update."
 *
 * — exit 0, nothing changed, `updateAvailable` still true afterwards, forever.
 * `checkForUpdate` reads the configured channel now, so that exact loop cannot
 * recur.
 *
 * This stays, because the *shape* outlives its first cause. An install `claude
 * update` cannot write to also exits 0 having changed nothing, and so does a
 * channel that moves between the check and the run. Both are a clean run that
 * bridged nothing, and neither can produce a different answer until one of the
 * two versions moves. Recording *what* was attempted turns "retry every six
 * hours forever" into one attempt per genuinely new situation.
 */
export interface AutoUpdateAttempt {
  at: number
  /** `info.latest` when this ran. */
  target: string | null
  /** `info.current` when this ran. */
  from: string | null
  /**
   * The run itself failed, as opposed to succeeding without moving the version.
   *
   * The two deserve different retry rules and this is the flag that separates
   * them. A failure can be transient — a network blip, a lock, a permission
   * that gets fixed — so it is retried on a timer. A clean run that changed
   * nothing is a stable disagreement between two sources, and retrying it
   * before either of them moves cannot produce a different answer.
   */
  failed: boolean
}

/**
 * Whether to install a CLI update without being asked.
 *
 * Pure, and separate from the scheduler that calls it, for the reason gotcha 31
 * gives: this is a rule whose only observable effect is a side effect inside a
 * timer, which is exactly the shape no suite can see. `verify:updates` calls it
 * directly.
 *
 * The gates, each of which has been a real failure:
 *
 *  - The setting is on. Replacing a program on someone's PATH is a real action
 *    and stays refusable.
 *  - A check actually succeeded. `checkForUpdate` reports `updateAvailable:
 *    false` both when the CLI is current AND when the registry could not be
 *    reached or `claude --version` could not be run — `info.error` is the only
 *    thing that separates them, and running an update off a failed check means
 *    running it off no information.
 *  - There is something to install. `claude update` exits 0 having changed
 *    nothing when it is already current, so "just run it periodically" costs a
 *    three-minute subprocess to achieve nothing and cannot be told apart from
 *    a blocked install.
 *  - The last attempt has not already answered this exact question. See
 *    `AutoUpdateAttempt`: a failure waits out a timer, and a clean no-op waits
 *    for one of the two versions to actually change.
 */
export function shouldAutoUpdate(
  info: UpdateInfo,
  enabled: boolean,
  last: AutoUpdateAttempt | null,
  now: number
): AutoUpdateDecision {
  if (!enabled) return { run: false, reason: 'Automatic updates are off.' }
  /*
   * The CLI's own switch, which is a different switch from Stoke's and outranks
   * it. `distTagFor` still resolves `disabled` to a real tag so the panel can
   * say a newer version exists; this is the line that stops Stoke acting on it.
   * Turning the mechanism off in `~/.claude/settings.json` and then having
   * Stoke run the updater anyway would be Stoke overruling a setting it draws.
   */
  if (info.channel === 'disabled') {
    return {
      run: false,
      reason: "The CLI's own auto-updates are switched off (autoUpdatesChannel: disabled)."
    }
  }
  if (info.error) return { run: false, reason: `The check itself failed: ${info.error}` }
  if (!info.current) return { run: false, reason: 'No claude executable was found.' }
  if (!info.updateAvailable) return { run: false, reason: null }

  if (last) {
    if (last.failed) {
      if (now - last.at < AUTO_RETRY_MS) {
        return { run: false, reason: 'An attempt failed recently; waiting before trying again.' }
      }
    } else if (info.latest === last.target && info.current === last.from) {
      // Same target, same installed version, and the last run already declined
      // to bridge them. Nothing about running it again could differ.
      return {
        run: false,
        reason: `\`claude update\` has already declined to move ${last.from} to ${last.target}; not asking it again until one of them changes.`
      }
    }
  }
  return { run: true, reason: null }
}

/**
 * Did the run that just finished actually move the version on disk?
 *
 * `claude update` exits 0 having changed nothing in two very different
 * situations — already current, and an npm-global install it cannot write to —
 * so exit status alone cannot answer this. `runUpdate` reads the version either
 * side precisely so the comparison is possible, and this is that comparison.
 */
export function updateApplied(result: CliRunResult): boolean {
  return result.ok && result.from !== result.to && result.to !== null
}
