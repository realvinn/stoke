## Workstream E — the statusLine data channel

This workstream lands first, because everything else in the overhaul that shows a number depends
on it. The context meter (spec 2.1) and the usage chip (spec 2.2) currently read two sources that
have both stopped working: `windowFromBanner` greps for a `(1M context)` string that claude
2.1.221 no longer prints, and `readOauthToken` reads `~/.claude/.credentials.json`, which does not
exist on macOS. One channel replaces both — the CLI pipes a JSON payload to whatever
`statusLine` command it is configured with, and that payload states the context window per model
from token zero and carries the plan's rate limits. Because the wrapper owns stdout, suppressing
the in-terminal status line (spec 2.3) is the same act as reading the data.

The tasks are ordered so the payload is parseable before it is produced, produced before it is
installed, installed before it is routed, and routed before any pixel changes:

1–3 build `src/main/statusLine.ts` bottom-up (read the payload → generate the wrapper → fold both
settings keys into one file). 4 teaches `buildArgs` to take that file. 5 wires it into the launch
path. 6 points the context meter at it. 7 gets it to the renderer. 8–9 spend it on the usage chip
and the setting. 10 fixes the documentation it invalidates.

**Prerequisite.** Tasks 1–5 of `docs/superpowers/plans/parts/00-contracts.md` must already be
merged. This workstream imports `StatusLinePayload`, `StatusLineSnapshot`,
`StatusLineWindowReading`, `StatusLineRateLimit` and `Settings.hideStatusLine` from
`src/shared/types.ts`, and `CH.statusLineUpdate` / `CH.statusLineLast` from `src/shared/ipc.ts`.
None of them are created here.

**House rules that bite in this workstream specifically.** `src/main/statusLine.ts` is imported by
a verify suite under `node --experimental-strip-types`, so every relative import it makes carries
an explicit `.ts`, and `@shared/types` may only be imported **type-only** (those are erased; a
value import of the alias fails at runtime with `ERR_MODULE_NOT_FOUND`). No TypeScript parameter
properties. The generated `wrapper.mjs` is plain JavaScript on purpose — that is what lets the
suite execute the real artefact rather than a re-implementation of it.

---

### Task 1: Read the statusLine payload

Nothing produces a payload yet, so this task starts at the other end: the parser and the on-disk
reader, with the exact payload captured from claude 2.1.221 as its fixture. The one hazard worth
pinning immediately is that `rate_limits.*.resets_at` is epoch **seconds** while every other
timestamp in Stoke is milliseconds.

**Files:**
- Create: `src/main/statusLine.ts`
- Create: `scripts/verify-statusline.mts`
- Modify: `package.json:15` (add the `verify:statusline` script), `package.json:27` (chain it into `check`)
- Test: `node scripts/verify-statusline.mts`

**Interfaces:**
- Consumes: `StatusLinePayload`, `StatusLineRateLimit`, `StatusLineSnapshot`, `StatusLineWindowReading` — all type-only from `@shared/types`, landed by the contracts tasks.
- Produces:
  - `export function statusLineDir(): string`
  - `export function statusLinePayloadFile(sessionId: string): string`
  - `export function toSnapshot(sessionId: string, payload: StatusLinePayload, receivedAt: number): StatusLineSnapshot`
  - `export function readStatusLine(sessionId: string): StatusLineSnapshot | null`

- [ ] **Step 1: Write the failing suite**

  Create `scripts/verify-statusline.mts`:

  ```ts
  /*
   * Stoke's statusLine wrapper is the only channel that states a session's
   * context window before a token is spent, and the only source of plan limits
   * that works on macOS. Both halves fail silently when they fail: a payload
   * that never lands leaves the meter guessing 200k, and a wrapper that prints
   * something unexpected paints it straight into the user's terminal.
   *
   * So this exercises the REAL generated wrapper under this very node, rather
   * than a re-implementation of it.
   *
   *   node scripts/verify-statusline.mts
   */
  import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { dirname } from 'node:path'
  import {
    readStatusLine,
    statusLineDir,
    statusLinePayloadFile,
    toSnapshot
  } from '../src/main/statusLine.ts'
  import type { StatusLinePayload } from '../src/shared/types.ts'

  let failures = 0

  function check(name: string, got: unknown, want: unknown): void {
    const ok = JSON.stringify(got) === JSON.stringify(want)
    if (!ok) failures++
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
        (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
    )
  }

  /** The payload captured from claude 2.1.221 after one real request. */
  const REAL: StatusLinePayload = {
    session_id: 'a0e0ee79-0000-4000-8000-000000000000',
    model: { id: 'claude-opus-5', display_name: 'Opus 5' },
    context_window: {
      context_window_size: 1_000_000,
      used_percentage: 28,
      current_usage: { input_tokens: 10, cache_read_input_tokens: 15_645 }
    },
    exceeds_200k_tokens: false,
    rate_limits: {
      five_hour: { used_percentage: 15, resets_at: 1_786_078_200 },
      seven_day: { used_percentage: 3, resets_at: 1_786_647_600 }
    }
  }

  console.log('\nreading the payload')
  const snap = toSnapshot('sess-1', REAL, 1_700_000_000_000)
  check('the window comes straight out of the payload', snap.contextWindowSize, 1_000_000)
  check('so does the percentage', snap.usedPercentage, 28)
  check('and the model', [snap.modelId, snap.modelName], ['claude-opus-5', 'Opus 5'])
  check('resets_at is seconds in, milliseconds out', snap.fiveHour?.resetsAt, 1_786_078_200_000)
  check('the seven-day window converts the same way', snap.sevenDay?.resetsAt, 1_786_647_600_000)
  check(
    'percentages carry over',
    [snap.fiveHour?.percent, snap.sevenDay?.percent],
    [15, 3]
  )
  check('the file mtime is carried as receivedAt', snap.receivedAt, 1_700_000_000_000)

  console.log('\na CLI that drops fields degrades instead of throwing')
  const bare = toSnapshot('sess-2', {}, 5)
  check('no context window is null, not zero', bare.contextWindowSize, null)
  check('no rate limits is null, not an empty reading', [bare.fiveHour, bare.sevenDay], [null, null])
  check('exceeds_200k_tokens defaults to false', bare.exceeds200k, false)
  check(
    'a window size outside anything plausible is refused, so it cannot hide an overflow',
    toSnapshot('sess-3', { context_window: { context_window_size: 9_000_000_000 } }, 5)
      .contextWindowSize,
    null
  )
  check(
    'a rate limit with a percentage but no reset is still a reading',
    toSnapshot('sess-4', { rate_limits: { five_hour: { used_percentage: 40 } } }, 5).fiveHour,
    { percent: 40, resetsAt: null }
  )

  console.log('\nreading it back off disk')
  const readId = 'stoke-verify-read'
  const readFile = statusLinePayloadFile(readId)
  mkdirSync(dirname(readFile), { recursive: true })
  writeFileSync(readFile, JSON.stringify(REAL), 'utf8')
  const fromDisk = readStatusLine(readId)
  check('a written payload reads back', fromDisk?.contextWindowSize, 1_000_000)
  check(
    'and is stamped with the mtime of the file it came from',
    typeof fromDisk?.receivedAt === 'number' && fromDisk.receivedAt > 0,
    true
  )
  check('an unknown session reads as nothing at all', readStatusLine('stoke-verify-missing'), null)
  writeFileSync(readFile, 'not json', 'utf8')
  check('a truncated or garbled file reads as nothing, never a throw', readStatusLine(readId), null)
  rmSync(readFile, { force: true })
  check('the payload directory lives under the system temp dir', statusLineDir().startsWith(tmpdir()), true)

  console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
  process.exitCode = failures ? 1 : 0
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect it to fail before printing anything, with:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/thevinh/dev/personal/stoke/src/main/statusLine.ts' imported from /Users/thevinh/dev/personal/stoke/scripts/verify-statusline.mts`

- [ ] **Step 3: Create `src/main/statusLine.ts` with the reader half**

  ```ts
  import { readFileSync, statSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { join } from 'node:path'
  import type {
    StatusLinePayload,
    StatusLineRateLimit,
    StatusLineSnapshot,
    StatusLineWindowReading
  } from '@shared/types'

  /**
   * Stoke's own `statusLine` command, and the payload it captures.
   *
   * The CLI pipes a JSON object to the configured statusLine command on stdin
   * and prints whatever that command writes to stdout. That is the only channel
   * that states the context window before a single token is spent — the
   * transcript never records the tier, and the startup banner stopped saying it
   * in 2.1.221 (see CLAUDE.md gotcha 2). It is also the only source of the
   * plan's rate limits that works on macOS, where the OAuth token is in the
   * Keychain rather than in ~/.claude/.credentials.json.
   *
   * Transport is one file per session under the system temp directory, written
   * temp+rename so a reader never sees half a payload. Not a unix socket: there
   * is no Windows equivalent a shell command can reach as simply. Not an HTTP
   * POST: curl.exe only exists from Windows 10 1803, and a pass-through would
   * have to tee stdin. Not a pure shell wrapper: `more` paginates and re-wraps
   * and `findstr` truncates past ~8KB, and both do it silently.
   *
   * Nothing here writes to the user's own ~/.claude/settings.json. It is read,
   * once, so the line it configures can be passed through.
   */

  const WINDOW_MIN = 1_000
  const WINDOW_MAX = 10_000_000

  export function statusLineDir(): string {
    return join(tmpdir(), 'stoke', 'statusline')
  }

  /**
   * A session id is normally a uuid we minted, but `--session-id` can be handed
   * anything, so it is reduced to something safely joinable before it ever
   * becomes part of a path.
   */
  function key(sessionId: string): string {
    return sessionId.replace(/[^A-Za-z0-9._-]/g, '_')
  }

  export function statusLinePayloadFile(sessionId: string): string {
    return join(statusLineDir(), `${key(sessionId)}.json`)
  }

  function windowSize(v: unknown): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    const n = Math.round(v)
    // Bounded for the same reason windowFromBanner is: a nonsense value large
    // enough to read 0% forever would hide a real overflow.
    return n >= WINDOW_MIN && n <= WINDOW_MAX ? n : null
  }

  function percent(v: unknown): number | null {
    if (typeof v !== 'number' || !Number.isFinite(v)) return null
    return Math.max(0, Math.min(100, v))
  }

  function text(v: unknown): string | null {
    return typeof v === 'string' && v.trim() ? v.trim() : null
  }

  /**
   * `resets_at` is epoch SECONDS in this payload and epoch milliseconds
   * everywhere else in Stoke. This function is the only place the two meet.
   */
  function reading(raw: StatusLineRateLimit | undefined): StatusLineWindowReading | null {
    const pct = percent(raw?.used_percentage)
    if (pct === null) return null
    const secs = raw?.resets_at
    const resetsAt =
      typeof secs === 'number' && Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null
    return { percent: pct, resetsAt }
  }

  /**
   * The wire payload as the rest of the app wants it: flat, camelCase, and in
   * milliseconds, so no component ever meets the snake_case shape or the
   * seconds/ms boundary.
   */
  export function toSnapshot(
    sessionId: string,
    payload: StatusLinePayload,
    receivedAt: number
  ): StatusLineSnapshot {
    const cw = payload.context_window
    return {
      sessionId,
      contextWindowSize: windowSize(cw?.context_window_size),
      usedPercentage: percent(cw?.used_percentage),
      modelId: text(payload.model?.id),
      modelName: text(payload.model?.display_name),
      exceeds200k: payload.exceeds_200k_tokens === true,
      fiveHour: reading(payload.rate_limits?.five_hour),
      sevenDay: reading(payload.rate_limits?.seven_day),
      receivedAt
    }
  }

  /**
   * The last payload this session's wrapper wrote, or null.
   *
   * Null covers every failure the same way on purpose — no file yet, a CLI too
   * old to run a statusLine command, a half-written file, a temp sweeper that
   * deleted it. Every caller has a fallback, and a throw here would take the
   * context meter down with it.
   */
  export function readStatusLine(sessionId: string): StatusLineSnapshot | null {
    if (!sessionId) return null
    const file = statusLinePayloadFile(sessionId)
    try {
      const raw = readFileSync(file, 'utf8')
      const at = statSync(file).mtimeMs
      const payload = JSON.parse(raw) as unknown
      if (!payload || typeof payload !== 'object') return null
      return toSnapshot(sessionId, payload as StatusLinePayload, at)
    } catch {
      return null
    }
  }
  ```

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect every line to read `PASS` and the last line to read `all pass`.

- [ ] **Step 5: Register the suite**

  In `package.json`, add the script immediately after `"verify:context"` on line 15:

  ```json
      "verify:statusline": "node scripts/verify-statusline.mts",
  ```

  and insert it into the `check` chain (line 27) immediately after `npm run verify:context`, so
  the whole line reads:

  ```json
      "check": "npm run typecheck && npm run verify:context && npm run verify:statusline && npm run verify:profiles && npm run verify:color && npm run verify:worklog-gate && npm run verify:worklog-runner && npm run verify:worklog-retry && npm run verify:worklog-recall && npm run verify:worklog-autoscan && npm run verify:ssh && npm run build",
  ```

- [ ] **Step 6: Confirm it runs from npm**

  ```bash
  npm run verify:statusline
  ```

  Expect `all pass` and exit code 0.

- [ ] **Step 7: Commit**

  ```bash
  git add src/main/statusLine.ts scripts/verify-statusline.mts package.json
  git commit -m "$(cat <<'EOF'
  Read the CLI's statusLine payload

  The context window cannot be derived from the model id and claude 2.1.221 no
  longer prints it in the startup banner, so the meter has been reading a 1M
  session against 200k until it crossed over. The statusLine payload states it
  per model from token zero. This is the parser and the on-disk reader; nothing
  produces a payload yet.

  resets_at in that payload is epoch seconds and every other timestamp in Stoke
  is milliseconds, so the conversion happens exactly once, in toSnapshot.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 2: Generate the wrapper the CLI actually runs

The wrapper reads the payload on stdin, stores it, and prints either nothing or the user's own
status line. It is generated rather than shipped as a build asset because it has to be launched
through `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, and that path is only known at runtime
and changes when the app updates.

**Files:**
- Modify: `src/main/statusLine.ts` (append after `statusLinePayloadFile`)
- Modify: `scripts/verify-statusline.mts` (new section before the summary lines)
- Test: `node scripts/verify-statusline.mts`

**Interfaces:**
- Consumes: `statusLineDir()`, `statusLinePayloadFile()`, `readStatusLine()` from Task 1.
- Produces:
  - `export function writeStatusLineWrapper(): string` — writes `wrapper.mjs` plus the platform shim and returns the shim's absolute path.
  - `export function statusLineCommand(sessionId: string): string` — pure; the exact string that goes into the settings file's `statusLine.command`.
  - File contract, relied on by Task 3: the wrapper reads its pass-through command from `<statusLineDir()>/<sessionId>.cmd` and writes its payload to `statusLinePayloadFile(sessionId)`.

- [ ] **Step 1: Extend the suite with the wrapper section**

  In `scripts/verify-statusline.mts`, add `execFileSync` and the two extra `node:fs` helpers to the
  imports at the top so those lines read:

  ```ts
  import { execFileSync } from 'node:child_process'
  import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
  import { tmpdir } from 'node:os'
  import { dirname, join } from 'node:path'
  import {
    readStatusLine,
    statusLineCommand,
    statusLineDir,
    statusLinePayloadFile,
    toSnapshot,
    writeStatusLineWrapper
  } from '../src/main/statusLine.ts'
  ```

  Then insert this section immediately before the two summary lines at the end of the file:

  ```ts
  console.log('\nthe wrapper, run exactly the way the CLI runs it')
  const shim = writeStatusLineWrapper()
  check('the shim exists where the command points at it', existsSync(shim), true)

  const isWin = process.platform === 'win32'
  const shell = isWin ? (process.env.COMSPEC ?? 'cmd.exe') : '/bin/sh'
  const shellFlag = isWin ? '/c' : '-c'
  /** A pass-through command that works on both shells and prints one marker. */
  const ECHO_CMD = isWin ? 'echo STOKE-PASSTHROUGH' : "printf 'STOKE-PASSTHROUGH'"

  /** Run the statusLine command the way a shell would, payload on stdin. */
  function runWrapper(sessionId: string, input: string): string {
    return execFileSync(shell, [shellFlag, statusLineCommand(sessionId)], {
      input,
      encoding: 'utf8'
    })
  }

  const suppressed = 'stoke-verify-suppress'
  check('suppressed: the wrapper prints nothing at all', runWrapper(suppressed, JSON.stringify(REAL)), '')
  check(
    'suppressed: the payload landed anyway, byte for byte',
    readFileSync(statusLinePayloadFile(suppressed), 'utf8'),
    JSON.stringify(REAL)
  )
  check(
    'suppressed: and it parses back through the reader',
    readStatusLine(suppressed)?.contextWindowSize,
    1_000_000
  )
  rmSync(statusLinePayloadFile(suppressed), { force: true })

  const through = 'stoke-verify-passthrough'
  writeFileSync(join(statusLineDir(), `${through}.cmd`), ECHO_CMD, 'utf8')
  check(
    'pass-through: the user command owns stdout',
    runWrapper(through, JSON.stringify(REAL)).trim(),
    'STOKE-PASSTHROUGH'
  )
  check(
    'pass-through: the payload is still captured',
    readStatusLine(through)?.contextWindowSize,
    1_000_000
  )
  rmSync(join(statusLineDir(), `${through}.cmd`), { force: true })
  rmSync(statusLinePayloadFile(through), { force: true })

  const junk = 'stoke-verify-junk'
  check('a non-JSON payload prints nothing', runWrapper(junk, 'Error: something went wrong\n'), '')
  check(
    'and is not stored, so the last good reading survives a bad frame',
    readStatusLine(junk),
    null
  )

  check(
    'the command is one quoted path and one quoted id, with no shell metacharacter',
    /^"[^"]+" "stoke-verify-junk"$/.test(statusLineCommand(junk)),
    true
  )
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect a link-time failure before any output:
  `SyntaxError: The requested module '../src/main/statusLine.ts' does not provide an export named 'statusLineCommand'`

- [ ] **Step 3: Add the wrapper generator to `src/main/statusLine.ts`**

  Extend the `node:fs` import at the top of the file to
  `import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'`, then
  append this after `statusLinePayloadFile`:

  ```ts
  /**
   * The wrapper, as source. Plain JavaScript rather than TypeScript because it
   * is executed, not built — which is also what lets verify-statusline run the
   * real artefact instead of a copy of its logic.
   *
   * It never parses the payload: the session id arrives on argv, so a malformed
   * frame costs nothing but a skipped write. It never throws, either — a
   * statusLine command that exits non-zero prints its noise into the TUI.
   */
  const WRAPPER_JS = `// Generated by Stoke. See src/main/statusLine.ts; edits here are overwritten.
  import { execFileSync } from 'node:child_process'
  import { readFileSync, renameSync, writeFileSync } from 'node:fs'
  import { basename, dirname, join } from 'node:path'
  import { fileURLToPath } from 'node:url'

  const dir = dirname(fileURLToPath(import.meta.url))
  // basename() and nothing else: the id is already sanitised on the way in, and
  // this makes a hand-edited settings file unable to escape the directory.
  const id = basename(String(process.argv[2] || ''))

  let raw = ''
  try {
    raw = readFileSync(0, 'utf8')
  } catch {
    raw = ''
  }

  // Only a JSON object is stored. A CLI that pipes an error message must not be
  // able to overwrite the last good reading with it.
  if (id && raw.trim().startsWith('{')) {
    try {
      const target = join(dir, id + '.json')
      const tmp = target + '.' + process.pid + '.tmp'
      writeFileSync(tmp, raw, 'utf8')
      renameSync(tmp, target)
    } catch {}
  }

  // Pass-through: print the user's own status line, fed the same payload. No
  // file means the line is suppressed, which is the default.
  let cmd = ''
  try {
    cmd = readFileSync(join(dir, id + '.cmd'), 'utf8').trim()
  } catch {}

  if (cmd) {
    try {
      const win = process.platform === 'win32'
      const shell = win ? process.env.COMSPEC || 'cmd.exe' : '/bin/sh'
      process.stdout.write(
        execFileSync(shell, [win ? '/c' : '-c', cmd], {
          input: raw,
          encoding: 'utf8',
          timeout: 5000,
          maxBuffer: 4 * 1024 * 1024,
          stdio: ['pipe', 'pipe', 'ignore']
        })
      )
    } catch {}
  }
  `

  function shimName(): string {
    return process.platform === 'win32' ? 'run.cmd' : 'run.sh'
  }

  /**
   * Write the wrapper and the shim that launches it, and return the shim path.
   *
   * The shim exists because the CLI runs a shell command and Stoke has no node
   * of its own: `ELECTRON_RUN_AS_NODE=1 <electron> wrapper.mjs` is the node it
   * has. Both files are rewritten on every call rather than cached, because
   * process.execPath moves when the app updates and a temp sweeper can delete
   * either of them out from under a long-running session — and a shim pointing
   * at a deleted Electron fails as an empty status line, which looks exactly
   * like it working.
   */
  export function writeStatusLineWrapper(): string {
    const dir = statusLineDir()
    mkdirSync(dir, { recursive: true })
    const wrapper = join(dir, 'wrapper.mjs')
    writeFileSync(wrapper, WRAPPER_JS, 'utf8')

    const shim = join(dir, shimName())
    if (process.platform === 'win32') {
      writeFileSync(
        shim,
        `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${wrapper}" %*\r\n`,
        'utf8'
      )
    } else {
      writeFileSync(
        shim,
        `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "${wrapper}" "$@"\n`,
        'utf8'
      )
      // Set explicitly rather than through writeFileSync's mode, which only
      // applies when the file is created and so leaves a rewrite unexecutable.
      chmodSync(shim, 0o755)
    }
    return shim
  }

  /**
   * The command string that goes into the settings file's statusLine key.
   *
   * Pure — it names the shim without writing it, so the JSON can be built and
   * asserted without touching the disk. Two quoted arguments and no shell
   * metacharacter, which is what keeps CLAUDE.md gotcha 13 out of this: the
   * string lives inside a --settings FILE and never on an argv.
   */
  export function statusLineCommand(sessionId: string): string {
    return `"${join(statusLineDir(), shimName())}" "${key(sessionId)}"`
  }
  ```

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect `all pass`. If the pass-through case fails on macOS or Linux with a permission error, the
  `chmodSync` in `writeStatusLineWrapper` is missing.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/statusLine.ts scripts/verify-statusline.mts
  git commit -m "$(cat <<'EOF'
  Ship the statusLine wrapper Stoke installs per session

  Reads the payload on stdin, stores it temp+rename, and prints either nothing
  or the user's own statusLine command's output. Owning stdout is what makes
  suppressing the in-terminal line the same act as reading the data.

  Generated at runtime rather than shipped as a build asset: it runs through
  process.execPath with ELECTRON_RUN_AS_NODE=1, and that path moves when the app
  updates. Rewritten on every launch for the same reason, plus temp sweepers.

  The suite executes the real generated wrapper through a real shell, which is
  only possible because the wrapper is plain JavaScript.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 3: One `--settings` file, carrying both keys

Measured against 2.1.221: **a second `--settings` silently discards the first.** `cli.ts:228-233`
already emits one for `ultracode`, so the statusLine key has to arrive in that same file. This
task builds the file, and the sibling `.cmd` file that carries the pass-through command — the
user's own shell command goes on disk rather than into our command string, so it is never handed
to a second round of shell parsing.

**Files:**
- Modify: `src/main/statusLine.ts` (append)
- Modify: `scripts/verify-statusline.mts` (new section before the summary lines)
- Test: `node scripts/verify-statusline.mts`

**Interfaces:**
- Consumes: `statusLineDir()`, `statusLinePayloadFile()`, `statusLineCommand()`, `writeStatusLineWrapper()`.
- Produces:
  - `export interface SessionSettingsInput { sessionId: string; ultracode: boolean; hideStatusLine: boolean; passthroughCommand: string }`
  - `export function sessionSettingsJson(input: SessionSettingsInput): Record<string, unknown>` — pure.
  - `export function writeSessionSettingsFile(input: SessionSettingsInput): string | null` — the `--settings` path, or null when there is nothing to say.
  - `export function clearSessionFiles(sessionId: string): void`
  - `export function userStatusLineCommand(settingsFile?: string): string`

- [ ] **Step 1: Extend the suite with the settings-file section**

  In `scripts/verify-statusline.mts`, extend the import from `../src/main/statusLine.ts` to also
  pull in `clearSessionFiles`, `sessionSettingsJson`, `userStatusLineCommand` and
  `writeSessionSettingsFile`, then insert this section immediately before the two summary lines:

  ```ts
  console.log('\none settings file, never two')
  const both = 'stoke-verify-settings'
  const json = sessionSettingsJson({
    sessionId: both,
    ultracode: true,
    hideStatusLine: true,
    passthroughCommand: 'bash ~/.claude/statusline-command.sh'
  })
  check('ultracode and statusLine ride in the same object', Object.keys(json).sort(), [
    'statusLine',
    'ultracode'
  ])
  check('the statusLine entry is a command', (json.statusLine as { type: string }).type, 'command')
  check(
    'and it is the command the wrapper answers to',
    (json.statusLine as { command: string }).command,
    statusLineCommand(both)
  )
  check(
    'no ultracode key when it was not asked for',
    Object.keys(
      sessionSettingsJson({
        sessionId: both,
        ultracode: false,
        hideStatusLine: true,
        passthroughCommand: ''
      })
    ),
    ['statusLine']
  )
  check(
    'a --continue session has no id to key on, but still gets its ultracode file',
    Object.keys(
      sessionSettingsJson({
        sessionId: '',
        ultracode: true,
        hideStatusLine: true,
        passthroughCommand: ''
      })
    ),
    ['ultracode']
  )
  check(
    'and nothing at all when there is nothing to say',
    writeSessionSettingsFile({
      sessionId: '',
      ultracode: false,
      hideStatusLine: true,
      passthroughCommand: ''
    }),
    null
  )

  const settingsFile = writeSessionSettingsFile({
    sessionId: both,
    ultracode: false,
    hideStatusLine: false,
    passthroughCommand: ECHO_CMD
  })
  check('the file is written', typeof settingsFile === 'string' && existsSync(settingsFile), true)
  check(
    'and parses as the object we built',
    Object.keys(JSON.parse(readFileSync(settingsFile as string, 'utf8'))),
    ['statusLine']
  )
  check(
    'the pass-through command is a file beside the payload, never part of the command string',
    readFileSync(join(statusLineDir(), `${both}.cmd`), 'utf8'),
    ECHO_CMD
  )
  check(
    'and the wrapper honours it end to end',
    runWrapper(both, JSON.stringify(REAL)).trim(),
    'STOKE-PASSTHROUGH'
  )

  writeSessionSettingsFile({
    sessionId: both,
    ultracode: false,
    hideStatusLine: true,
    passthroughCommand: ECHO_CMD
  })
  check(
    'switching suppression back on removes the pass-through file rather than leaving it armed',
    existsSync(join(statusLineDir(), `${both}.cmd`)),
    false
  )
  clearSessionFiles(both)
  check(
    'clearSessionFiles leaves nothing behind',
    [existsSync(statusLinePayloadFile(both)), existsSync(settingsFile as string)],
    [false, false]
  )

  console.log("\nthe user's own statusLine, read and never written")
  const userFile = join(statusLineDir(), 'stoke-verify-user-settings.json')
  writeFileSync(
    userFile,
    JSON.stringify({ statusLine: { type: 'command', command: 'bash ~/.claude/statusline-command.sh' } }),
    'utf8'
  )
  check('a command statusLine is what gets passed through', userStatusLineCommand(userFile), 'bash ~/.claude/statusline-command.sh')
  writeFileSync(userFile, JSON.stringify({ statusLine: { type: 'static', text: 'hi' } }), 'utf8')
  check('anything that is not a command has nothing to pass through', userStatusLineCommand(userFile), '')
  check('and a missing file is simply empty', userStatusLineCommand(join(statusLineDir(), 'nope.json')), '')
  rmSync(userFile, { force: true })
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect:
  `SyntaxError: The requested module '../src/main/statusLine.ts' does not provide an export named 'sessionSettingsJson'`

- [ ] **Step 3: Add the settings-file writer to `src/main/statusLine.ts`**

  Extend the `node:fs` import to
  `import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'`
  and the `node:os` import to `import { homedir, tmpdir } from 'node:os'`, then append:

  ```ts
  /** Where the pass-through command lives, when there is one. */
  function passthroughFile(sessionId: string): string {
    return join(statusLineDir(), `${key(sessionId)}.cmd`)
  }

  function settingsFileFor(sessionId: string): string {
    return join(statusLineDir(), `${key(sessionId) || 'default'}.settings.json`)
  }

  export interface SessionSettingsInput {
    sessionId: string
    ultracode: boolean
    hideStatusLine: boolean
    /** The user's own statusLine command, or '' when there is nothing to echo. */
    passthroughCommand: string
  }

  /**
   * Everything Stoke puts in one session's `--settings` file.
   *
   * One file, because a second `--settings` silently discards the first —
   * measured against 2.1.221, and the reason this function exists at all rather
   * than each feature appending its own flag.
   *
   * A session with no id (a `--continue`, whose id the CLI picks) gets no
   * statusLine key: the payload is keyed by session id and there is nothing to
   * key it with. Such a session already has no context meter for the same
   * reason, so nothing regresses.
   */
  export function sessionSettingsJson(input: SessionSettingsInput): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    if (input.ultracode) out.ultracode = true
    if (input.sessionId) {
      out.statusLine = { type: 'command', command: statusLineCommand(input.sessionId) }
    }
    return out
  }

  /**
   * Write that file and the pass-through command beside it, and return the path
   * for `--settings`. Null means there is nothing to pass.
   *
   * A failure returns null rather than throwing: buildArgs falls back to the
   * ultracode-only file, which does throw if it cannot be written, so the one
   * case that must stay loud — a session that promised ultracode and did not
   * get it — still is.
   */
  export function writeSessionSettingsFile(input: SessionSettingsInput): string | null {
    const json = sessionSettingsJson(input)
    if (!Object.keys(json).length) return null
    try {
      mkdirSync(statusLineDir(), { recursive: true })
      if (json.statusLine) writeStatusLineWrapper()
      if (input.sessionId) {
        const cmdFile = passthroughFile(input.sessionId)
        const passthrough = input.hideStatusLine ? '' : input.passthroughCommand.trim()
        // Removed rather than left in place when suppression is on: a stale
        // file would keep printing a line the user has just turned off.
        if (passthrough) writeFileSync(cmdFile, passthrough, 'utf8')
        else rmSync(cmdFile, { force: true })
      }
      const file = settingsFileFor(input.sessionId)
      writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8')
      return file
    } catch (err) {
      console.error('[stoke] could not write the session settings file', err)
      return null
    }
  }

  /** Remove everything written for one session. Called when its PTY exits. */
  export function clearSessionFiles(sessionId: string): void {
    if (!sessionId) return
    for (const f of [
      statusLinePayloadFile(sessionId),
      passthroughFile(sessionId),
      settingsFileFor(sessionId)
    ]) {
      try {
        rmSync(f, { force: true })
      } catch {
        /* a temp sweeper got there first */
      }
    }
  }

  /**
   * The user's own statusLine command, so it can be passed through when the
   * line is not suppressed. Read at launch rather than cached, because the file
   * is theirs and they can change it at any time.
   *
   * Read-only, always: Stoke never writes to Claude Code's own files.
   */
  export function userStatusLineCommand(
    settingsFile: string = join(homedir(), '.claude', 'settings.json')
  ): string {
    try {
      const raw = JSON.parse(readFileSync(settingsFile, 'utf8')) as {
        statusLine?: { type?: string; command?: string }
      }
      const sl = raw?.statusLine
      if (!sl || sl.type !== 'command') return ''
      return typeof sl.command === 'string' ? sl.command.trim() : ''
    } catch {
      return ''
    }
  }
  ```

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect `all pass`.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/statusLine.ts scripts/verify-statusline.mts
  git commit -m "$(cat <<'EOF'
  Build one --settings file carrying both session keys

  A second --settings silently discards the first, measured against 2.1.221, so
  the statusLine key has to arrive in the same file cli.ts already writes for
  ultracode. Appending a second flag would have switched ultracode off with no
  warning anywhere.

  The pass-through command goes in a sibling file rather than into our command
  string: it is the user's own shell command and embedding it would hand it to a
  second round of shell parsing.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 4: `buildArgs` takes the settings file

`cli.ts:228-233` currently hardcodes `ultracodeSettingsFile()`. It becomes a fallback, so any
caller that passes no file still gets ultracode and the loud failure that goes with it.

**Files:**
- Modify: `src/main/cli.ts:189` (signature), `src/main/cli.ts:228-233` (the ultracode block)
- Modify: `scripts/verify-statusline.mts` (new section before the summary lines)
- Test: `node scripts/verify-statusline.mts`

**Interfaces:**
- Consumes: `LaunchOptions` (type-only, `@shared/types`); `ultracodeSettingsFile(): string` (existing, `src/main/cli.ts:161`).
- Produces: `export function buildArgs(opts: LaunchOptions, settingsFile: string | null = null): string[]` — replaces the one-argument form. The only existing caller is `src/main/pty.ts:140`, updated in Task 5.

- [ ] **Step 1: Extend the suite with the argv section**

  Add these imports to the top of `scripts/verify-statusline.mts`:

  ```ts
  import { buildArgs } from '../src/main/cli.ts'
  import type { LaunchOptions, StatusLinePayload } from '../src/shared/types.ts'
  ```

  (replacing the existing `StatusLinePayload` type import line), then insert before the summary
  lines:

  ```ts
  console.log('\nbuildArgs emits exactly one --settings')
  const base: LaunchOptions = {
    cwd: '/tmp',
    permissionMode: 'default',
    model: '',
    effort: 'default',
    cols: 80,
    rows: 24
  }

  const argsBoth = buildArgs({ ...base, ultracode: true, sessionId: 'sid' }, '/tmp/sid.settings.json')
  check('one --settings, not two', argsBoth.filter((a) => a === '--settings').length, 1)
  check(
    'pointing at the file it was handed',
    argsBoth[argsBoth.indexOf('--settings') + 1],
    '/tmp/sid.settings.json'
  )
  check('ultracode still pins the effort flag', argsBoth[argsBoth.indexOf('--effort') + 1], 'xhigh')

  const argsPlain = buildArgs({ ...base, effort: 'high', sessionId: 'sid' }, '/tmp/sid.settings.json')
  check(
    'a session with no ultracode still gets the file, because it carries the statusLine key',
    argsPlain.filter((a) => a === '--settings').length,
    1
  )
  check('and keeps the effort it asked for', argsPlain[argsPlain.indexOf('--effort') + 1], 'high')

  check('no file, no flag', buildArgs({ ...base, sessionId: 'sid' }, null).includes('--settings'), false)

  check(
    'ultracode with no file falls back to its own, so a one-argument caller cannot lose it',
    buildArgs({ ...base, ultracode: true, sessionId: 'sid' }).filter((a) => a === '--settings').length,
    1
  )

  const argsUser = buildArgs(
    { ...base, sessionId: 'sid', extraArgs: ['--settings', '/my/own.json'] },
    '/tmp/sid.settings.json'
  )
  check(
    "a hand-written --settings still comes last, so it still wins",
    argsUser.slice(argsUser.lastIndexOf('--settings')),
    ['--settings', '/my/own.json']
  )
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect two failures in the new section:
  `FAIL  pointing at the file it was handed` with `got undefined, want "/tmp/sid.settings.json"`,
  and `FAIL  a session with no ultracode still gets the file...` with `got 0, want 1` — because
  today `buildArgs` ignores a second argument entirely.

- [ ] **Step 3: Change `buildArgs`**

  In `src/main/cli.ts`, replace the signature on line 189 and the block at lines 228-233.

  The signature becomes:

  ```ts
  /**
   * @param settingsFile the one `--settings` file for this session, holding both
   *   the ultracode key and the statusLine wrapper. Null means the session needs
   *   none — but note the ultracode fallback below, which keeps a caller that
   *   passes nothing working exactly as it did.
   */
  export function buildArgs(opts: LaunchOptions, settingsFile: string | null = null): string[] {
  ```

  and the ultracode block becomes:

  ```ts
    if (opts.ultracode) {
      args.push('--effort', 'xhigh')
    } else if (opts.effort && opts.effort !== 'default') {
      args.push('--effort', opts.effort)
    }

    // Exactly one --settings, ever. A second silently discards the first
    // (measured against 2.1.221), so ultracode and the statusLine wrapper have
    // to share a file rather than each append a flag — which is why this is one
    // push and not two. The fallback keeps a caller that hands over no file
    // getting its ultracode key, including the deliberate throw when that file
    // cannot be written.
    //
    // It sits before extraArgs so a hand-written `--settings` there still wins —
    // a repeated option is last-wins.
    const file = settingsFile ?? (opts.ultracode ? ultracodeSettingsFile() : null)
    if (file) args.push('--settings', file)
  ```

  Leave the long measurement comment above it (lines 210-227) in place; it still explains why
  ultracode pins `--effort xhigh`.

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts && npm run typecheck
  ```

  Expect `all pass` from the suite and no output from `typecheck`.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/cli.ts scripts/verify-statusline.mts
  git commit -m "$(cat <<'EOF'
  Let buildArgs be handed the session's settings file

  It hardcoded ultracodeSettingsFile(), so the statusLine key had nowhere to go
  but a second --settings — which silently discards the first and would have
  turned ultracode off with no warning anywhere.

  The old path stays as a fallback so a caller passing no file behaves exactly as
  before, including the deliberate throw when the file cannot be written.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 5: Install the wrapper on every session Stoke starts

The session id is minted inside `PtyManager.start`, so the settings file has to be built there —
but `pty.ts` must not read settings directly (it takes `claudePath` as an argument for the same
reason). It takes a factory instead, in the style `ContextWatcher` already uses for its resolvers.

**Files:**
- Modify: `src/main/pty.ts:5` (import), `src/main/pty.ts:112-116` (signature), `src/main/pty.ts:140` (argv), `src/main/pty.ts:149-155` (comment), `src/main/pty.ts:220-225` (exit cleanup)
- Modify: `src/main/index.ts:27` (import), `src/main/index.ts:136-144` (`launchSession`)
- Test: launch the app and read the files it wrote (below)

**Interfaces:**
- Consumes: `writeSessionSettingsFile(input: SessionSettingsInput): string | null` and `userStatusLineCommand(settingsFile?: string): string` from Task 3; `buildArgs(opts, settingsFile)` from Task 4; `clearSessionFiles(sessionId: string): void` from Task 3; `Settings.hideStatusLine: boolean` from the contracts tasks.
- Produces: `PtyManager.start(opts: LaunchOptions, claudePathOverride: string | null, mcpConfigPath?: string | null, sessionSettings?: (sessionId: string) => string | null): Promise<StartResult>` — a fourth optional parameter, defaulting to `() => null`.

- [ ] **Step 1: Take the factory in `pty.ts`**

  Change the import on line 5 and add one below it:

  ```ts
  import { buildArgs, buildEnvPath, findClaude, spawnSpec } from './cli.ts'
  import { clearSessionFiles } from './statusLine.ts'
  ```

  Change the `start` signature (lines 112-116) to:

  ```ts
    /**
     * @param sessionSettings builds this session's `--settings` file, given the
     *   id — which is minted here, so it cannot be passed in ready-made.
     *   Injected rather than read from the store so this module stays free of
     *   electron, like every other dependency it takes.
     */
    async start(
      opts: LaunchOptions,
      claudePathOverride: string | null,
      mcpConfigPath?: string | null,
      sessionSettings: (sessionId: string) => string | null = () => null
    ): Promise<StartResult> {
  ```

  Replace line 140 with:

  ```ts
      // One --settings, holding both the ultracode key and the statusLine
      // wrapper: a second silently discards the first. Local only — a remote
      // session runs ssh, and this file is on this disk.
      const settingsFile = opts.host ? null : sessionSettings(sessionId)
      const args = opts.host
        ? buildSshArgs(opts.host)
        : buildArgs({ ...opts, sessionId }, settingsFile)
  ```

- [ ] **Step 2: Clear the session's files when it exits**

  In `src/main/pty.ts`, replace the `proc.onExit` handler (lines 220-225) with:

  ```ts
      proc.onExit(({ exitCode, signal }) => {
        session.exited = true
        this.sessions.delete(ptyId)
        // The payload, the pass-through command and the settings file are all
        // per-session temp files. Nothing reads them once the process is gone,
        // and leaving them would accumulate one set per session ever started.
        clearSessionFiles(sessionId)
        this.onExit(ptyId, exitCode, signal)
        for (const fn of this.exitSubscribers) fn(ptyId, exitCode)
      })
  ```

  and update the comment block at lines 149-155 so its first sentence reads:

  ```ts
      // Ultracode and the statusLine wrapper both need nothing here: buildArgs
      // has already folded them into the single `--settings <file>` above. Do
      // not be tempted to write `/effort ultracode` into the pty after start
  ```

  (the rest of that comment is unchanged).

- [ ] **Step 3: Build the file in `index.ts`**

  Add the import after line 27 (`import { getSettings, setSettings } from './store.ts'`):

  ```ts
  import { userStatusLineCommand, writeSessionSettingsFile } from './statusLine.ts'
  ```

  and replace `launchSession` (lines 136-144) with:

  ```ts
  async function launchSession(opts: LaunchOptions): Promise<StartResult> {
    if (!ptys) throw new Error('Window is not ready')
    const settings = getSettings()
    const result = await ptys.start(opts, settings.claudePath, mcpConfigPath, (sessionId) =>
      writeSessionSettingsFile({
        sessionId,
        ultracode: opts.ultracode === true,
        hideStatusLine: settings.hideStatusLine,
        // Read now rather than cached: it is the user's own settings.json and
        // they can edit it between one session and the next.
        passthroughCommand: settings.hideStatusLine ? '' : userStatusLineCommand()
      })
    )
    watcher?.watch(result.sessionId)
    const cwd = ptys.list().find((s) => s.sessionId === result.sessionId)?.cwd
    if (cwd) sessionCwds.set(result.sessionId, cwd)
    if (opts.host) sessionHosts.set(result.sessionId, opts.host)
    return result
  }
  ```

- [ ] **Step 4: Typecheck**

  ```bash
  npm run typecheck
  ```

  Expect no output.

- [ ] **Step 5: Prove it against a real session**

  ```bash
  rm -rf "${TMPDIR:-/tmp}/stoke/statusline"
  npm run dev
  ```

  Start any session in the app, type `hello` and press Enter, then in a second terminal:

  ```bash
  ls "${TMPDIR:-/tmp}/stoke/statusline"
  ```

  Expect four entries: `run.sh`, `wrapper.mjs`, `<uuid>.settings.json` and `<uuid>.json`. Then:

  ```bash
  cat "${TMPDIR:-/tmp}/stoke/statusline/"*.settings.json
  node -e "const fs=require('fs'),os=require('os'),p=require('path');const d=p.join(os.tmpdir(),'stoke','statusline');const f=fs.readdirSync(d).find(n=>/^[0-9a-f-]{36}\.json$/.test(n));console.log(JSON.parse(fs.readFileSync(p.join(d,f),'utf8')).context_window)"
  ```

  Expect the settings file to read
  `{ "statusLine": { "type": "command", "command": "\"…/run.sh\" \"<uuid>\"" } }`, and the second
  command to print an object containing `context_window_size` — `1000000` on an Opus 5 session.
  Expect **no status line at the bottom of the terminal in Stoke**, where one used to be.

- [ ] **Step 6: Prove the cleanup**

  Close that tab in Stoke, then:

  ```bash
  ls "${TMPDIR:-/tmp}/stoke/statusline"
  ```

  Expect only `run.sh` and `wrapper.mjs` to remain.

- [ ] **Step 7: Commit**

  ```bash
  git add src/main/pty.ts src/main/index.ts
  git commit -m "$(cat <<'EOF'
  Install Stoke's statusLine wrapper on every session it starts

  This is what makes the payload exist at all: the CLI only runs a statusLine
  command if one is configured, and the user's own settings.json is never
  touched, so it has to arrive per session through --settings.

  pty.ts takes a factory rather than reading the store, because the session id is
  minted inside start() and because pty.ts stays free of electron. The per-session
  temp files are removed when the process exits, so they cannot accumulate one set
  per session ever started.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 6: Point the context meter at the payload

`contextLimitFor` is unchanged — it already takes a stated limit that wins over its inference. All
that changes is where index.ts gets that statement from: the payload first, then the banner, then
nothing. The banner path and the observed-usage inference both stay, for CLI versions that emit no
payload.

The precedence rule itself becomes a named function rather than a lambda buried in `index.ts`,
because a lambda in a constructor call is the one shape no suite in this repo can reach — and this
particular rule is the whole point of the workstream.

**Files:**
- Modify: `src/main/statusLine.ts` (append `windowFor`)
- Modify: `src/main/index.ts` (the `./statusLine.ts` import, and `src/main/index.ts:382-392`, the watcher's window resolver)
- Modify: `src/main/sessionFile.ts:175-191` (the now-stale doc comment on the window rules)
- Modify: `scripts/verify-statusline.mts` (new section before the summary lines)
- Modify: `scripts/verify-context.mts:7-13` (imports), `scripts/verify-context.mts:103-108` and `:147` (new payload cases)
- Test: `node scripts/verify-statusline.mts && node scripts/verify-context.mts`

**Interfaces:**
- Consumes: `readStatusLine(sessionId: string): StatusLineSnapshot | null` and `statusLinePayloadFile()` from Task 1; `PtyManager.bannerWindowFor(sessionId: string): number | null` (existing, `src/main/pty.ts:270`); `contextLimitFor(model, observedTokens, bannerLimit)` (existing, `src/main/sessionFile.ts:302`); `ContextWatcher` (existing, `src/main/context.ts:27`).
- Produces: `export function windowFor(sessionId: string, bannerWindow: number | null): number | null` in `src/main/statusLine.ts` — the payload first, the banner second, null third. `ContextWatcher`'s second constructor argument becomes `(sessionId) => windowFor(sessionId, ptys?.bannerWindowFor(sessionId) ?? null)`.

- [ ] **Step 1: Pin the precedence rule in `scripts/verify-statusline.mts`**

  Add `windowFor` to the import from `../src/main/statusLine.ts`, then insert before the summary
  lines:

  ```ts
  console.log('\nwhich source states the context window')
  const winId = 'stoke-verify-window'
  check(
    'no payload and no banner is no statement at all, so the caller infers',
    windowFor(winId, null),
    null
  )
  check('no payload falls back to the banner', windowFor(winId, 1_000_000), 1_000_000)
  mkdirSync(statusLineDir(), { recursive: true })
  writeFileSync(
    statusLinePayloadFile(winId),
    JSON.stringify({ context_window: { context_window_size: 1_000_000 } }),
    'utf8'
  )
  check('a payload states it', windowFor(winId, null), 1_000_000)
  check(
    'and beats the banner, which is the older and now usually absent source',
    windowFor(winId, 200_000),
    1_000_000
  )
  writeFileSync(
    statusLinePayloadFile(winId),
    JSON.stringify({ context_window: { used_percentage: 4 } }),
    'utf8'
  )
  check(
    'a payload that omits the size falls through rather than reporting zero',
    windowFor(winId, 200_000),
    200_000
  )
  rmSync(statusLinePayloadFile(winId), { force: true })
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect:
  `SyntaxError: The requested module '../src/main/statusLine.ts' does not provide an export named 'windowFor'`

- [ ] **Step 3: Add `windowFor` to `src/main/statusLine.ts`**

  Append:

  ```ts
  /**
   * The context window for a session, in order of authority.
   *
   * 1. The statusLine payload. A direct statement, per model, correct from token
   *    zero, and the only one that still exists — claude 2.1.221 dropped
   *    "(1M context)" from its startup banner.
   * 2. The banner, for a CLI old enough to still print it.
   * 3. Null, and `contextLimitFor` falls back to inferring the tier from observed
   *    usage. That cannot be right below 200k, but it is never wrong in the
   *    dangerous direction.
   *
   * A named function rather than a lambda inside the ContextWatcher construction
   * because this ordering is the whole point of the statusLine channel, and a
   * lambda in a constructor call is the one shape no suite here can reach.
   */
  export function windowFor(sessionId: string, bannerWindow: number | null): number | null {
    return readStatusLine(sessionId)?.contextWindowSize ?? bannerWindow ?? null
  }
  ```

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect `all pass`.

- [ ] **Step 5: Add the payload cases to `scripts/verify-context.mts`**

  Add to the imports at the top of the file:

  ```ts
  import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
  import { dirname } from 'node:path'
  import { readStatusLine, statusLinePayloadFile } from '../src/main/statusLine.ts'
  ```

  (`basename, join` are already imported from `node:path`; add `dirname` to that existing line
  rather than duplicating it.)

  Then insert after the existing `'unsuffixed id above 200k -> 1M'` check (line 104-108):

  ```ts
  /* ---------------------------------------------------------------------------
     The statusLine payload, which is now the primary source for the window size.
     The banner this used to depend on is gone: claude 2.1.221 prints
     "Claude Code v2.1.221    Opus 5 with low effort · Claude Max" and the word
     "context" appears nowhere in its startup output. So these cases assert the
     1M tier is read with no banner at all, at a token count far below 200k —
     which is exactly where the observed-usage inference gets it wrong.
     --------------------------------------------------------------------------- */
  const payloadId = 'verify-context-1m'
  const payloadFile = statusLinePayloadFile(payloadId)
  mkdirSync(dirname(payloadFile), { recursive: true })
  writeFileSync(
    payloadFile,
    JSON.stringify({
      model: { id: 'claude-opus-5', display_name: 'Opus 5' },
      context_window: { context_window_size: 1_000_000, used_percentage: 3 },
      exceeds_200k_tokens: false
    }),
    'utf8'
  )
  const stated = readStatusLine(payloadId)?.contextWindowSize ?? null
  check('statusLine payload states the window', stated === 1_000_000, String(stated))
  check(
    'a 1M session reads 1M at 50k tokens, with no banner anywhere',
    contextLimitFor('claude-opus-5', 50_000, stated) === 1_000_000,
    'the payload beat the observed-usage inference'
  )
  check(
    'a 200k model in the payload stays 200k',
    contextLimitFor('claude-haiku-4-5', 10_000, 200_000) === 200_000,
    '200,000'
  )
  rmSync(payloadFile, { force: true })
  ```

  Then, so the whole watcher path is exercised without a banner, insert this immediately after the
  existing `check('watcher snapshot carries a model', ...)` block (after line 147):

  ```ts
  /*
   * The same watcher, told the window by a payload instead of a banner. Written
   * against the live session id because that is the only id findSessionFile can
   * resolve, and removed immediately afterwards: leaving it would make a running
   * copy of Stoke read this session against 1M until its next real payload.
   */
  const livePayload = statusLinePayloadFile(liveId)
  writeFileSync(
    livePayload,
    JSON.stringify({ context_window: { context_window_size: 1_000_000 } }),
    'utf8'
  )
  const viaPayload = await new Promise<ContextSnapshot | null>((resolve) => {
    const payloadWatcher = new ContextWatcher(
      (snap) => {
        if (!snap.ready) return
        payloadWatcher.disposeAll()
        resolve(snap)
      },
      (id) => windowFor(id, null)
    )
    payloadWatcher.watch(liveId)
    setTimeout(() => {
      payloadWatcher.disposeAll()
      resolve(null)
    }, 10_000)
  })
  rmSync(livePayload, { force: true })
  check(
    'the watcher takes its window from the payload, banner or no banner',
    viaPayload?.contextLimit === 1_000_000,
    String(viaPayload?.contextLimit ?? 'timed out')
  )
  ```

  Note the import line in that first block must also pull in `windowFor`, so it reads
  `import { readStatusLine, statusLinePayloadFile, windowFor } from '../src/main/statusLine.ts'`.

- [ ] **Step 6: Run it and watch it pass**

  ```bash
  node scripts/verify-context.mts
  ```

  Expect `ALL CHECKS PASSED`, including
  `PASS  the watcher takes its window from the payload, banner or no banner  1000000` and
  `PASS  a 1M session reads 1M at 50k tokens, with no banner anywhere`.

  These are green on the first run and that is correct: `contextLimitFor` has always accepted a
  stated limit, and Step 3 already supplied the source. What this suite adds is the guarantee that
  the whole watcher path — transcript lookup, parse, limit resolution, emitted snapshot — honours
  the payload, which is the path `index.ts` is about to be pointed down in Step 7.

- [ ] **Step 7: Point the watcher at `windowFor` in `src/main/index.ts`**

  Extend the import added in Task 5 to:

  ```ts
  import {
    userStatusLineCommand,
    windowFor,
    writeSessionSettingsFile
  } from './statusLine.ts'
  ```

  and replace the comment and second constructor argument at lines 382-392 with:

  ```ts
    // The window size comes from the statusLine payload first and the CLI's own
    // startup banner second; see windowFor. The banner used to be the only
    // source and 2.1.221 stopped printing it.
    watcher = new ContextWatcher(
      (snap) => {
        send(CH.ctxUpdate, snap)
        // `ready` is false for the placeholder emitted while a brand-new session
        // has no transcript yet; its counts are zeroes and would set a baseline
        // the real first reading then blows straight past.
        if (snap.ready) autoscan?.observe(snap.sessionId, snap.messageCount, snap.updatedAt)
      },
      (sessionId) => windowFor(sessionId, ptys?.bannerWindowFor(sessionId) ?? null),
      {
  ```

  (the options object at lines 393-411 is unchanged).

- [ ] **Step 8: Correct the stale comment in `sessionFile.ts`**

  Replace the doc comment at `src/main/sessionFile.ts:175-191` with:

  ```ts
  /**
   * Context window size for a session.
   *
   * The model id alone is NOT sufficient. A session running the 1M-context tier
   * records its model as plain `claude-opus-5` — the `[1m]` suffix that appears
   * in CLI flags does not survive into the transcript, and no `context_window`
   * field is written either. Verified against a live 1M session sitting at 269k
   * tokens whose every assistant record said `claude-opus-5`.
   *
   * The window is therefore *stated* rather than derived, by the caller: the
   * statusLine payload first (`statusLine.ts`), then the startup banner for a
   * CLI old enough to print one. Both arrive here as `bannerLimit`.
   *
   * With no statement at all, observed usage is the authority: exceeding the
   * standard window is proof the session is on the extended tier. The id is
   * still checked first for the cases where a suffix is present.
   *
   * Known imprecision in that last case only: an extended-tier session below
   * 200k is reported against the 200k window until it crosses over. That reads
   * conservatively (it can over-state pressure, never under-state it) and it can
   * never exceed 100%.
   */
  ```

- [ ] **Step 9: Run both suites, then measure it live**

  ```bash
  node scripts/verify-statusline.mts && node scripts/verify-context.mts && npm run typecheck
  ```

  Expect `all pass`, then `ALL CHECKS PASSED`, then no output.

  Then launch the app on an Opus 5 session and hover the tab's context ring:

  ```bash
  npm run dev
  ```

  Expect the ring's tooltip to read against **1,000,000**, not 200,000, on a fresh session with
  only a few thousand tokens used. Before this change it read 200,000 until the session crossed
  200k.

- [ ] **Step 10: Commit**

  ```bash
  git add src/main/statusLine.ts src/main/index.ts src/main/sessionFile.ts scripts/verify-statusline.mts scripts/verify-context.mts
  git commit -m "$(cat <<'EOF'
  Take the context window from the statusLine payload

  windowFromBanner greps for "(1M context)", which claude 2.1.221 no longer
  prints, so contextLimitFor fell through to inferring the tier from observed
  usage and a 1M session read 200k until it crossed 200k — the exact failure that
  function's doc comment was written to prevent. A session at 182k showed "92%
  full" with 82% of the window still free.

  The banner and the observed-usage inference stay as fallbacks; only the order
  changes. contextLimitFor itself is untouched.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 7: Get the payload to the renderer

Two channels, both already named in `src/shared/ipc.ts` by the contracts tasks. `statusline:update`
is pushed, and must fire **only** when the payload file's mtime has moved — the file is rewritten
on every frame the CLI renders, so pushing unconditionally would be several messages per second
per session.

**Files:**
- Modify: `src/main/index.ts` (module state near line 57, the watcher's emit callback, one handler in the context IPC section near line 543, and the `ptyKill` handler at line 536)
- Modify: `src/shared/api.ts` (imports, and a `statusLine` block after `context`)
- Modify: `src/preload/index.ts:61-65` (a `statusLine` block after `context`)
- Create: `scripts/cdp-eval.mjs`
- Test: `node scripts/cdp-eval.mjs` against a running instance

**Interfaces:**
- Consumes: `CH.statusLineUpdate` (`'statusline:update'`), `CH.statusLineLast` (`'statusline:last'`), `StatusLineSnapshot` — all from the contracts tasks; `readStatusLine()` from Task 1.
- Produces:
  - `window.stoke.statusLine.last(): Promise<StatusLineSnapshot | null>`
  - `window.stoke.statusLine.onUpdate(cb: (snapshot: StatusLineSnapshot) => void): () => void`
  - `scripts/cdp-eval.mjs` — a dev tool: `node scripts/cdp-eval.mjs "<javascript>"` evaluates in the renderer and prints the result.

- [ ] **Step 1: Create the CDP helper**

  Create `scripts/cdp-eval.mjs`:

  ```js
  /*
   * Evaluate an expression in Stoke's renderer over CDP and print the result.
   *
   *   npm run build
   *   npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp
   *   node scripts/cdp-eval.mjs "document.querySelectorAll('.tab').length"
   *
   * Targets are filtered by URL on purpose: the docked browser is its own CDP
   * target of type "page", so attaching to the first one drives the wrong page
   * entirely (CLAUDE.md gotcha 6).
   */
  import WebSocket from 'ws'

  const port = process.env.CDP_PORT ?? '9222'
  const expression = process.argv.slice(2).join(' ')
  if (!expression) {
    console.error('usage: node scripts/cdp-eval.mjs "<javascript>"')
    process.exit(2)
  }

  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
  const target = targets.find(
    (t) => t.type === 'page' && (t.url.includes('/index.html') || /localhost:\d+\/?$/.test(t.url))
  )
  if (!target) {
    console.error(
      'no Stoke renderer target found. Targets:',
      targets.map((t) => `${t.type} ${t.url}`)
    )
    process.exit(1)
  }

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve) => ws.once('open', resolve))
  ws.send(
    JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true }
    })
  )
  const reply = await new Promise((resolve) => ws.once('message', (m) => resolve(JSON.parse(String(m)))))
  ws.close()
  console.log(JSON.stringify(reply.result?.result?.value ?? reply.result, null, 2))
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  npm run build
  npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp
  ```

  and in a second terminal, with a session open in the app:

  ```bash
  node scripts/cdp-eval.mjs "typeof window.stoke.statusLine"
  ```

  Expect `"undefined"` — the bridge does not exist yet. (The explicit
  `--user-data-dir` is honoured over the app's own dev isolation; see CLAUDE.md gotcha 12. Reuse
  the same one throughout, so settings written in one step are still there in the next.)

- [ ] **Step 3: Declare the API surface**

  In `src/shared/api.ts`, add `StatusLineSnapshot` to the type import from `./types` (the block at
  the top listing `BrowserState, CliInfo, ContextSnapshot, …`), then add this block immediately
  after the `context: { … }` block:

  ```ts
    /**
     * The CLI's own statusLine payload: the context window and the plan limits.
     *
     * Only arrives while a session is open and rendering, which is the accepted
     * trade-off for not bundling a Keychain binding — see `last()`.
     */
    statusLine: {
      /**
       * The newest reading seen this run, from whichever session produced it.
       * Rate limits are account-wide, so any session answers for all of them,
       * and this is what lets the usage chip show figures with an "as of HH:MM"
       * when no session is open. Null before the first payload of the run.
       */
      last(): Promise<StatusLineSnapshot | null>
      onUpdate(cb: (snapshot: StatusLineSnapshot) => void): () => void
    }
  ```

- [ ] **Step 4: Bridge it in the preload**

  In `src/preload/index.ts`, add immediately after the `context: { … },` block (lines 61-65):

  ```ts
    statusLine: {
      last: () => ipcRenderer.invoke(CH.statusLineLast),
      onUpdate: (cb) => on<[Parameters<typeof cb>[0]]>(CH.statusLineUpdate, cb)
    },
  ```

- [ ] **Step 5: Produce it in `src/main/index.ts`**

  Add `StatusLineSnapshot` to the type import on line 5 so it reads:

  ```ts
  import type { LaunchOptions, Rect, Settings, SshHost, StatusLineSnapshot } from '@shared/types'
  ```

  and add `readStatusLine` back to the `./statusLine.ts` import, which Task 6 left holding
  `windowFor` instead, so it reads:

  ```ts
  import {
    readStatusLine,
    userStatusLineCommand,
    windowFor,
    writeSessionSettingsFile
  } from './statusLine.ts'
  ```

  Add this module state after line 57 (`let usageCache: UsageSnapshot | null = null`):

  ```ts
  /**
   * The newest statusLine reading seen this run, whichever session produced it.
   *
   * The rate limits in it are account-wide, so any open session's payload
   * answers for all of them — and keeping one means the usage chip still has
   * figures once every tab is closed, which is the whole "as of HH:MM" case.
   */
  let lastStatusLine: StatusLineSnapshot | null = null
  /** receivedAt of the last payload pushed per session, so nothing is sent twice. */
  const statusLineSeen = new Map<string, number>()

  /**
   * Push a session's payload at the renderer, if it has actually changed.
   *
   * The file is rewritten on every frame the CLI renders, so the mtime guard is
   * load-bearing rather than tidy: without it this is several IPC messages a
   * second per open session, carrying identical objects.
   */
  function pushStatusLine(sessionId: string): void {
    const snap = readStatusLine(sessionId)
    if (!snap) return
    if (statusLineSeen.get(sessionId) === snap.receivedAt) return
    statusLineSeen.set(sessionId, snap.receivedAt)
    lastStatusLine = snap
    send(CH.statusLineUpdate, snap)
  }
  ```

  In the watcher's emit callback (edited in Task 6), add one line after `send(CH.ctxUpdate, snap)`:

  ```ts
        send(CH.ctxUpdate, snap)
        pushStatusLine(snap.sessionId)
  ```

  In the `ptyKill` handler (line 536-540), add the forget:

  ```ts
    ipcMain.on(CH.ptyKill, (_e, ptyId: string) => {
      const sessionId = ptys?.sessionIdFor(ptyId)
      ptys?.kill(ptyId)
      if (sessionId) {
        watcher?.unwatch(sessionId)
        statusLineSeen.delete(sessionId)
      }
    })
  ```

  And add the handler in the context section, after `CH.ctxUnwatch` (line 544):

  ```ts
    ipcMain.handle(CH.statusLineLast, () => lastStatusLine)
  ```

- [ ] **Step 6: Run it and watch it pass**

  ```bash
  npm run typecheck
  ```

  Expect no output. Then rebuild and restart the app
  (`npm run build && npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp`),
  open a session, send it one message, and:

  ```bash
  node scripts/cdp-eval.mjs "JSON.stringify(await window.stoke.statusLine.last())"
  ```

  Expect a JSON string containing `"contextWindowSize":1000000` (on Opus 5) and a `"fiveHour"`
  object with a `percent` and a millisecond `resetsAt` — a 13-digit number, not a 10-digit one.

- [ ] **Step 7: Confirm the channel is not chatty**

  ```bash
  node scripts/cdp-eval.mjs "new Promise(r => { let n = 0; const off = window.stoke.statusLine.onUpdate(() => n++); setTimeout(() => { off(); r(n) }, 10000) })"
  ```

  With a session sitting idle, expect `0`. A number in the tens means the mtime guard is not
  working.

- [ ] **Step 8: Commit**

  ```bash
  git add src/main/index.ts src/preload/index.ts src/shared/api.ts scripts/cdp-eval.mjs
  git commit -m "$(cat <<'EOF'
  Publish the statusLine reading to the renderer

  Two channels: a push for the live reading and an invoke for the last one seen,
  which is what lets the usage chip show figures with an "as of" when no session
  is open.

  The push is gated on the payload file's mtime because the CLI reruns the
  statusLine command on every frame it renders — ungated this is several
  identical objects a second per session.

  Adds scripts/cdp-eval.mjs, since there is no DOM test runner here and every UI
  claim in this overhaul has to be measured in a running instance.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 8: Draw the usage chip from `rate_limits`

Spec 2.2: the chip renders nothing on macOS because `~/.claude/.credentials.json` does not exist
there. The payload carries the same two windows, so the chip gets a source that works on every
platform. The account API path stays exactly as it is, as the fallback where it does work.

**Files:**
- Create: `src/shared/statusLine.ts`
- Modify: `src/renderer/src/components/UsageMeter.tsx:1-2` (imports), `:72-145` (`UsageChip`)
- Modify: `scripts/verify-statusline.mts` (new section before the summary lines)
- Test: `node scripts/verify-statusline.mts`, then `node scripts/cdp-eval.mjs`

**Interfaces:**
- Consumes: `StatusLineSnapshot`, `UsageWindow`, `UsageSnapshot` (types); `window.stoke.statusLine.last()` / `.onUpdate()` from Task 7; `window.stoke.usage.read()` (existing).
- Produces (in `src/shared/statusLine.ts`):
  - `export const FIVE_HOUR_MS: number`, `export const SEVEN_DAY_MS: number`
  - `export function elapsedFraction(resetsAt: number | null, windowMs: number, now: number): number | null`
  - `export function statusLineWindows(snap: StatusLineSnapshot, now: number): UsageWindow[]`

- [ ] **Step 1: Extend the suite with the mapping section**

  In `scripts/verify-statusline.mts`, add the import:

  ```ts
  import { statusLineWindows } from '../src/shared/statusLine.ts'
  ```

  and insert before the summary lines:

  ```ts
  console.log('\nthe usage bars the chip draws from it')
  // Half an hour before the five-hour window in REAL resets.
  const barsNow = 1_786_076_400_000
  const windows = statusLineWindows(toSnapshot('sess-5', REAL, barsNow), barsNow)
  check('two windows, in the order the chip reads them', windows.map((w) => w.kind), [
    'session',
    'weekly'
  ])
  check('labels match the ones the account API produces', windows.map((w) => w.label), [
    '5 hours',
    'Weekly'
  ])
  check('percentages carry over', windows.map((w) => w.percent), [15, 3])
  check(
    'the five-hour window is 90% elapsed half an hour before it resets',
    windows[0].elapsed,
    0.9
  )
  check(
    'a window with no reset time gets no pace marker, rather than a wrong one',
    statusLineWindows(
      toSnapshot('sess-6', { rate_limits: { five_hour: { used_percentage: 12 } } }, barsNow),
      barsNow
    )[0].elapsed,
    null
  )
  check(
    'no rate limits at all means no bars, so the chip hides instead of showing zeroes',
    statusLineWindows(toSnapshot('sess-7', {}, barsNow), barsNow),
    []
  )
  ```

- [ ] **Step 2: Run it and watch it fail**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect:
  `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/Users/thevinh/dev/personal/stoke/src/shared/statusLine.ts'`

- [ ] **Step 3: Create `src/shared/statusLine.ts`**

  ```ts
  import type { StatusLineSnapshot, UsageWindow } from './types'

  /**
   * The statusLine payload's rate limits, in the shape the usage meter already
   * draws.
   *
   * Shared rather than renderer-local so a verify suite can pin the mapping —
   * and deliberately producing `UsageWindow`, not a second shape, so one
   * component renders both sources and the two can never drift into disagreeing
   * about what "5 hours" means.
   */

  /** Window lengths, so the pace marker has a start as well as an end. */
  export const FIVE_HOUR_MS = 5 * 60 * 60 * 1000
  export const SEVEN_DAY_MS = 7 * 24 * 60 * 60 * 1000

  /**
   * How far through its window a limit is, 0-1, or null when the reset time is
   * unknown. `resets_at` gives only the end, so the start is inferred from the
   * window's fixed length.
   */
  export function elapsedFraction(
    resetsAt: number | null,
    windowMs: number,
    now: number
  ): number | null {
    if (resetsAt === null) return null
    const startedAt = resetsAt - windowMs
    return Math.max(0, Math.min(1, (now - startedAt) / windowMs))
  }

  export function statusLineWindows(snap: StatusLineSnapshot, now: number): UsageWindow[] {
    const out: UsageWindow[] = []
    if (snap.fiveHour) {
      out.push({
        kind: 'session',
        label: '5 hours',
        percent: Math.round(snap.fiveHour.percent),
        // The payload states no severity, and inventing one would colour a bar
        // by a rule the account does not use. The pace marker still tones it.
        severity: 'normal',
        resetsAt: snap.fiveHour.resetsAt,
        elapsed: elapsedFraction(snap.fiveHour.resetsAt, FIVE_HOUR_MS, now),
        active: true
      })
    }
    if (snap.sevenDay) {
      out.push({
        kind: 'weekly',
        label: 'Weekly',
        percent: Math.round(snap.sevenDay.percent),
        severity: 'normal',
        resetsAt: snap.sevenDay.resetsAt,
        elapsed: elapsedFraction(snap.sevenDay.resetsAt, SEVEN_DAY_MS, now),
        active: true
      })
    }
    return out
  }
  ```

- [ ] **Step 4: Run it and watch it pass**

  ```bash
  node scripts/verify-statusline.mts
  ```

  Expect `all pass`.

- [ ] **Step 5: Rewrite `UsageChip`**

  In `src/renderer/src/components/UsageMeter.tsx`, replace the imports on lines 1-2 with:

  ```tsx
  import { useEffect, useState } from 'react'
  import type { StatusLineSnapshot, UsageSnapshot, UsageWindow } from '@shared/types'
  import { statusLineWindows } from '@shared/statusLine'
  ```

  Add this helper immediately after `countdown` (after line 24):

  ```tsx
  /** Local wall-clock HH:MM, for the "as of" on a reading that may be stale. */
  function clock(at: number): string {
    const d = new Date(at)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  ```

  and replace the whole of `UsageChip` (lines 72-145) with:

  ```tsx
  export function UsageChip(): React.JSX.Element | null {
    const [snap, setSnap] = useState<UsageSnapshot | null>(null)
    const [line, setLine] = useState<StatusLineSnapshot | null>(null)
    const [now, setNow] = useState(() => Date.now())
    const [open, setOpen] = useState(false)

    useEffect(() => {
      let live = true
      const pull = async (): Promise<void> => {
        const next = await window.stoke.usage.read()
        if (live) setSnap(next)
      }
      void pull()
      // The main process caches, and backs off further when rate-limited; this
      // only has to be often enough that the countdown does not visibly stall.
      const poll = setInterval(() => void pull(), 60_000)
      const tick = setInterval(() => setNow(Date.now()), 30_000)
      return () => {
        live = false
        clearInterval(poll)
        clearInterval(tick)
      }
    }, [])

    useEffect(() => {
      let live = true
      // The last reading of the run, so closing every tab does not blank the
      // chip — it goes quiet and says when it last heard anything.
      void window.stoke.statusLine.last().then((s) => {
        if (live && s) setLine(s)
      })
      const off = window.stoke.statusLine.onUpdate((s) => setLine(s))
      return () => {
        live = false
        off()
      }
    }, [])

    useEffect(() => {
      if (!open) return
      const onKey = (e: KeyboardEvent): void => {
        if (e.key === 'Escape') setOpen(false)
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [open])

    /*
     * The statusLine payload wins when there is one. It is the live account
     * state as the CLI itself was just told it, and on macOS it is the only
     * source there is — the OAuth token lives in the Keychain, not in
     * ~/.claude/.credentials.json, which is why this chip rendered nothing there.
     */
    const fromLine = line ? statusLineWindows(line, now) : []
    const windows: UsageWindow[] =
      fromLine.length > 0 ? fromLine : snap && !snap.error ? snap.windows : []

    // Nothing at all rather than a row of zeroes: no reading is not the same as
    // no usage, and a wrong number here would be believed.
    if (!windows.length) return null

    const asOf = fromLine.length > 0 && line ? `as of ${clock(line.receivedAt)}` : null

    // The two windows that actually run out. A model-scoped one is shown in the
    // panel but would make the chip a wall of digits.
    const session = windows.find((w) => w.kind === 'session')
    const weekly = windows.find((w) => w.kind === 'weekly')
    const ahead = windows.some((w) => w.elapsed !== null && w.percent > w.elapsed * 100)

    return (
      <div className="usage-chip-wrap">
        <button
          className="usage-chip"
          data-ahead={ahead || undefined}
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          title={asOf ? `Plan limits, ${asOf} — click for detail` : 'Plan limits — click for detail'}
        >
          {session && <span>{session.percent}%</span>}
          {session && weekly && <span className="usage-chip-sep">·</span>}
          {weekly && <span>{weekly.percent}%</span>}
        </button>

        {open && (
          <>
            {/* Click-away, behind the panel and above everything else. */}
            <div className="usage-backdrop" onClick={() => setOpen(false)} />
            <div className="usage-panel" role="dialog" aria-label="Plan limits">
              {windows.map((w) => (
                <Bar key={`${w.kind}-${w.label}`} window={w} now={now} />
              ))}
              <p className="usage-note">
                the white mark is where you would be using it evenly. fill past it means
                you are going faster than it refills.
              </p>
              {asOf && (
                <p className="usage-note">
                  read from an open session&rsquo;s status line, {asOf}. it only updates while a
                  session is running.
                </p>
              )}
            </div>
          </>
        )}
      </div>
    )
  }
  ```

- [ ] **Step 6: Measure it in a running instance**

  ```bash
  npm run typecheck && npm run build
  npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp
  ```

  With a session open and one message sent:

  ```bash
  node scripts/cdp-eval.mjs "document.querySelector('.usage-chip')?.textContent ?? 'NO CHIP'"
  node scripts/cdp-eval.mjs "document.querySelector('.usage-chip')?.title ?? 'NO CHIP'"
  ```

  Expect the first to print two percentages separated by `·` (for example `"15%·3%"`) and the
  second to match `Plan limits, as of HH:MM — click for detail`. On macOS, before this change the
  first command printed `"NO CHIP"`.

- [ ] **Step 7: Commit**

  ```bash
  git add src/shared/statusLine.ts src/renderer/src/components/UsageMeter.tsx scripts/verify-statusline.mts
  git commit -m "$(cat <<'EOF'
  Draw the usage chip from the statusLine rate limits

  Fixes the chip rendering nothing on macOS. It was never platform-gated: the
  only OAuth token source is ~/.claude/.credentials.json, which does not exist
  there because the token is in the login Keychain, so fetchUsage bailed with
  "Not signed in to Claude Code." and the chip returned null.

  The payload carries the same two windows. The account API path stays as the
  fallback where it works, and no Keychain binding is bundled — the accepted cost
  is that the figures only move while a session is open, which the chip now says
  with an "as of HH:MM".

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 9: The setting

"Hide Claude's status line in Stoke", default on. On, the wrapper prints nothing. Off, it prints
the user's own statusLine command's output. Either way the payload still arrives — the setting
governs stdout, not the data channel.

**Files:**
- Modify: `src/renderer/src/components/SettingsSheet.tsx:215-228` (insert a `check-row` after the "Start a session on launch" one)
- Test: `node scripts/cdp-eval.mjs` against a running instance, then a real session

**Interfaces:**
- Consumes: `Settings.hideStatusLine: boolean` (default `true`, hydrated in `src/main/settingsSchema.ts` by the contracts tasks); `onPatch(patch: Partial<Settings>): void` (existing prop, `SettingsSheet.tsx:24`); the launch-time read in `launchSession` from Task 5.
- Produces: nothing new.

- [ ] **Step 1: Add the toggle**

  In `src/renderer/src/components/SettingsSheet.tsx`, insert immediately after the closing
  `</label>` of the "Start a session on launch" row (line 228):

  ```tsx
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.hideStatusLine}
              onChange={(e) => onPatch({ hideStatusLine: e.target.checked })}
            />
            <span>
              <span className="field-label">Hide Claude&rsquo;s status line in Stoke</span>
              <span className="field-hint">
                Stoke reads the context window and your plan limits from the status line the CLI
                pipes to it, and by default prints nothing back — the line duplicates chrome the
                app already draws. Turn this off to keep your own status line, which still runs and
                still shows exactly what it did before. Your{' '}
                <span className="mono">~/.claude/settings.json</span> is never modified, and either
                way this applies to sessions started after the change.
              </span>
            </span>
          </label>
  ```

- [ ] **Step 2: Prove the default and the write path**

  ```bash
  npm run typecheck && npm run build
  rm -rf /tmp/stoke-cdp
  npx electron . --remote-debugging-port=9222 --user-data-dir=/tmp/stoke-cdp
  ```

  ```bash
  node scripts/cdp-eval.mjs "(await window.stoke.settings.get()).hideStatusLine"
  ```

  Expect `true` — that profile has never seen this key, which is exactly the upgrade case.

  Open Settings in the app, untick the new row, then:

  ```bash
  node scripts/cdp-eval.mjs "(await window.stoke.settings.get()).hideStatusLine"
  ```

  Expect `false`.

- [ ] **Step 3: Prove pass-through against a real session**

  With the box unticked, open a **new** session in Stoke. Expect the status line configured in
  `~/.claude/settings.json` (`bash ~/.claude/statusline-command.sh` on this machine) to appear at
  the bottom of the terminal, exactly as it does outside Stoke. Then:

  ```bash
  node scripts/cdp-eval.mjs "JSON.stringify(await window.stoke.statusLine.last())"
  ```

  Expect a payload with `contextWindowSize` — pass-through must not cost the data. Re-tick the box,
  open another new session, and expect no status line and a payload still arriving.

- [ ] **Step 4: Commit**

  ```bash
  git add src/renderer/src/components/SettingsSheet.tsx
  git commit -m "$(cat <<'EOF'
  Add "Hide Claude's status line in Stoke"

  Default on: the wrapper is how the context window and the plan limits reach the
  app at all, and the line it suppresses duplicates chrome Stoke already draws.
  Off passes the user's own command through unchanged, so the data still arrives
  either way — the setting governs stdout, not the channel.

  There is no CLI flag for this; --safe-mode and --bare both have unacceptable
  collateral, which is why it is a settings key.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```

---

### Task 10: Correct the documentation this invalidates

`CLAUDE.md` gotcha 2 documents a `(1M context)` banner that claude 2.1.221 no longer prints, and
`ARCHITECTURE.md` says the window is inferred from observed usage. Both were true when written.
Leaving them costs the next person exactly the time the gotcha list exists to save.

**Files:**
- Modify: `CLAUDE.md:103-110` (gotcha 2), `CLAUDE.md:27` (verify list), `CLAUDE.md:50` (layout)
- Modify: `ARCHITECTURE.md:101` (the context meter section)
- Test: `npm run check`

**Interfaces:**
- Consumes: everything landed in Tasks 1-9.
- Produces: nothing.

- [ ] **Step 1: Rewrite gotcha 2**

  In `CLAUDE.md`, replace lines 103-110 with:

  ```markdown
  2. **The context window is stated only by the statusLine payload.** It cannot be derived from
     the model id: a 1M-tier session records its model as plain `claude-opus-5`, no `[1m]` suffix
     survives into the transcript, and there is no `context_window` field. Verified again on a
     session at 713,617 tokens; the only tier-ish field anywhere is `usage.service_tier`, which is
     billing. The CLI *used* to state it in its startup banner and **2.1.221 does not** — the
     banner is now `Claude Code v2.1.221    Opus 5 with low effort · Claude Max`, and the word
     "context" appears nowhere in the startup output.

     So Stoke installs its own `statusLine` command (`src/main/statusLine.ts`), folded into the
     single `--settings` file at launch. The CLI pipes it a JSON payload on stdin whose
     `context_window.context_window_size` is the window — per model, and correct from token zero.
     The wrapper writes it to `<tmpdir>/stoke/statusline/<sessionId>.json` and prints nothing,
     which is why suppressing the in-terminal line and reading the data are the same act.
     `windowFromBanner` and `contextLimitFor`'s observed-usage inference are kept as **fallbacks**
     for CLI versions that emit no payload; a banner that does say `(1M context)` still works, and
     escape codes must still be stripped before matching, because the banner is styled.

     Three things that cost time if you forget them: **a second `--settings` silently discards the
     first**, so the statusLine key and the `ultracode` key have to arrive in one file;
     `rate_limits.*.resets_at` in that payload is epoch **seconds** while every other timestamp in
     Stoke is ms (converted once, in `toSnapshot`); and a `--continue` session has no id up front,
     so it gets no payload — exactly as it already gets no context meter.
  ```

- [ ] **Step 2: List the new suite and the new module**

  In `CLAUDE.md`, insert after line 27 (`npm run verify:context …`):

  ```
  npm run verify:statusline     # the statusLine wrapper: payload, suppression, pass-through
  ```

  and in the layout block, after line 50 (`sessionFile.ts    transcript parsing and the context maths`):

  ```
    statusLine.ts     Stoke's statusLine wrapper: context window + plan limits
  ```

- [ ] **Step 3: Correct `ARCHITECTURE.md`**

  Replace the sentence at `ARCHITECTURE.md:101` ("The window size is inferred from observed usage,
  not the model id — see gotcha 2. …") with:

  ```markdown
  The window size is **stated**, not derived. Stoke installs its own `statusLine` command for the
  sessions it spawns (`statusLine.ts`, folded into the one `--settings` file `cli.ts` writes), and
  the CLI pipes that command a JSON payload whose `context_window.context_window_size` is the
  answer — per model, correct before a token is spent. The CLI's startup banner is the fallback
  for older versions, and inferring the tier from observed usage is the fallback below that; see
  gotcha 2. Inference alone was wrong in the first implementation and reported 140–320% occupancy,
  which is why `npm run verify:context` exists and asserts the invariant against real transcripts.

  That command is the only thing Stoke installs into a session, and it still writes nothing of
  Claude's: the settings file, the wrapper and the payloads all live under the system temp
  directory, and `~/.claude/settings.json` is read for the user's own status line and never
  modified.
  ```

- [ ] **Step 4: Run the full check**

  ```bash
  npm run check
  ```

  Expect it to pass, including `verify:statusline` in its new slot after `verify:context`.

- [ ] **Step 5: Commit**

  ```bash
  git add CLAUDE.md ARCHITECTURE.md
  git commit -m "$(cat <<'EOF'
  Record that the (1M context) banner is gone

  Gotcha 2 documented a startup banner claude 2.1.221 no longer prints, so anyone
  trusting it would have gone looking for a regex that could never match. It now
  describes the statusLine payload as the source and keeps the banner as the
  fallback it has become, plus the two things that bite: one --settings file, and
  resets_at in seconds.

  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  EOF
  )"
  ```
