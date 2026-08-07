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
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  clearSessionFiles,
  readStatusLine,
  sessionSettingsJson,
  statusLineCommand,
  statusLineDir,
  statusLinePayloadFile,
  toSnapshot,
  userStatusLineCommand,
  writeSessionSettingsFile,
  writeStatusLineWrapper
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

/**
 * Best-effort fixture teardown. Every case below writes its `.cmd`/script
 * files and payload before running the wrapper, so a throw out of
 * `runWrapper` (or an assertion helper, in principle) must not skip cleanup —
 * hence `finally`, not "after". `rmSync(..., { force: true })` already
 * tolerates a missing path; the try/catch here additionally tolerates a path
 * still in use, matching the directory-level cleanup at the end of this file.
 */
function cleanup(...paths: string[]): void {
  for (const p of paths) {
    try {
      rmSync(p, { recursive: true, force: true })
    } catch {
      // Another process may hold the file; leaving it behind is harmless,
      // and a fixture must never fail the suite on its way out.
    }
  }
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

console.log('\nthe payload names its own session, and that wins')
/*
 * The files are named after a KEY, which is the session id for every session
 * Stoke mints one for. A `--continue` session's id is picked by the CLI after
 * launch, so its files are named after a launch key instead — and the payload
 * is then the only place the real id appears at all. E Task 11 relies on this.
 */
check(
  'a payload read under a launch key reports the id the CLI actually chose',
  toSnapshot('launch-key-not-a-session', REAL, 1).sessionId,
  'a0e0ee79-0000-4000-8000-000000000000'
)
check(
  'and a payload that names no session falls back to the key it was read under',
  toSnapshot('launch-key-not-a-session', { context_window: { used_percentage: 4 } }, 1).sessionId,
  'launch-key-not-a-session'
)
check(
  'a blank session_id is not an id',
  toSnapshot('sess-9', { session_id: '   ' }, 1).sessionId,
  'sess-9'
)

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
  'a window size of zero is below WINDOW_MIN and is refused too',
  toSnapshot('sess-3b', { context_window: { context_window_size: 0 } }, 5).contextWindowSize,
  null
)
check(
  'a legitimate 200k window (Haiku, not just the 1M tier) survives untouched',
  toSnapshot('sess-3c', { context_window: { context_window_size: 200_000 } }, 5).contextWindowSize,
  200_000
)
check(
  'a rate limit with a percentage but no reset is still a reading',
  toSnapshot('sess-4', { rate_limits: { five_hour: { used_percentage: 40 } } }, 5).fiveHour,
  { percent: 40, resetsAt: null }
)
check(
  'a rate limit with a reset but no percentage is dropped entirely, reset and all — deliberate',
  toSnapshot('sess-4b', { rate_limits: { five_hour: { resets_at: 1_786_078_200 } } }, 5).fiveHour,
  null
)

console.log('\nnumeric fields are never coerced from strings')
/*
 * The whole point of this parser is that it trusts `typeof`, never `Number(v)`
 * / `parseInt` / `+v`. A CLI that ever sent a numeric field as a string (or a
 * refactor that started coercing one) must fall back to null, not a confident
 * wrong number. Pinned on every numeric field the parser reads, not just the
 * two context ones.
 */
check(
  'a string-typed context_window_size is refused, not parsed',
  toSnapshot(
    's',
    { context_window: { context_window_size: '1000000', used_percentage: '28' } } as never,
    0
  ).contextWindowSize,
  null
)
check(
  'a string-typed used_percentage is refused the same way',
  toSnapshot(
    's',
    { context_window: { context_window_size: '1000000', used_percentage: '28' } } as never,
    0
  ).usedPercentage,
  null
)
check(
  'a string-typed rate-limit used_percentage is refused, dropping the whole reading',
  toSnapshot(
    'sess-6',
    { rate_limits: { five_hour: { used_percentage: '40', resets_at: 1_786_078_200 } } } as never,
    0
  ).fiveHour,
  null
)
check(
  'a string-typed resets_at is refused on its own — the percent survives, the reset does not',
  toSnapshot(
    'sess-7',
    { rate_limits: { five_hour: { used_percentage: 40, resets_at: '1786078200' } } } as never,
    0
  ).fiveHour,
  { percent: 40, resetsAt: null }
)

console.log('\na non-string session id degrades instead of throwing')
/*
 * TypeScript blocks this in-repo, but Task 10 wires readStatusLine behind IPC,
 * where a renderer argument arrives as `any`. A non-string id must not reach
 * key()'s .replace unguarded.
 */
check('a numeric session id reads as nothing, never a throw', readStatusLine(12345 as never), null)

/*
 * Every fixture from here on lives under statusLineDir(). Whether that
 * directory pre-existed is captured now, before anything below creates it,
 * so the directory-level teardown in the `finally` at the bottom of this
 * file can tell "we made this" from "something else already had it" — the
 * house rule is that a fixture is deleted again, not "the directory is
 * always deleted".
 */
const dirExistedBefore = existsSync(statusLineDir())

try {
  console.log('\nreading it back off disk')
  const readId = 'stoke-verify-read'
  const readFile = statusLinePayloadFile(readId)
  try {
    mkdirSync(dirname(readFile), { recursive: true })
    writeFileSync(readFile, JSON.stringify(REAL), 'utf8')
    /*
     * A known mtime, set after the write so the OS-assigned "now" doesn't get
     * to masquerade as it. utimesSync takes epoch SECONDS; mtimeMs (and
     * receivedAt) is epoch MILLISECONDS — this is the boundary itself, so the
     * test has to cross it explicitly rather than accept whatever the clock
     * says.
     */
    const knownMtimeSeconds = 1_700_000_000
    utimesSync(readFile, knownMtimeSeconds, knownMtimeSeconds)
    const fromDisk = readStatusLine(readId)
    check('a written payload reads back', fromDisk?.contextWindowSize, 1_000_000)
    check(
      'and receivedAt is the file mtime in milliseconds, not Date.now()',
      fromDisk?.receivedAt,
      knownMtimeSeconds * 1000
    )
    check('an unknown session reads as nothing at all', readStatusLine('stoke-verify-missing'), null)
    writeFileSync(readFile, 'not json', 'utf8')
    check('a truncated or garbled file reads as nothing, never a throw', readStatusLine(readId), null)
  } finally {
    cleanup(readFile)
  }
  check(
    'the payload directory lives under the system temp dir',
    statusLineDir().startsWith(tmpdir()),
    true
  )

  console.log('\nthe wrapper, run exactly the way the CLI runs it')
  const shim = writeStatusLineWrapper()
  check('the shim exists where the command points at it', existsSync(shim), true)

  console.log('\nwriteStatusLineWrapper never throws, even when writing is impossible')
  /*
   * Forced by making the wrapper's own write target a directory it cannot
   * replace: writeAtomic's final renameSync(tmp, target) then fails
   * (EISDIR/ENOTEMPTY on POSIX), which is the same class of error a
   * read-only filesystem or a Windows sharing violation would also produce.
   * What this proves is the contract in the doc comment — "returns a path,
   * never throws" — not that a usable wrapper gets written; the case that
   * matters for real is a caller (Task 9) that must never see an exception
   * out of this call.
   */
  const wrapperTarget = join(statusLineDir(), 'wrapper.mjs')
  try {
    cleanup(wrapperTarget)
    mkdirSync(wrapperTarget, { recursive: true })
    let threw = false
    let shimWhenBlocked = ''
    try {
      shimWhenBlocked = writeStatusLineWrapper()
    } catch {
      threw = true
    }
    check(
      "writeStatusLineWrapper returns instead of throwing when its target can't be replaced",
      threw,
      false
    )
    check('and still returns the same shim path callers expect', shimWhenBlocked, shim)
  } finally {
    cleanup(wrapperTarget)
    // Restore a real wrapper.mjs, so the directory is left exactly as an
    // ordinary run would leave it rather than missing the file this block
    // deliberately broke.
    writeStatusLineWrapper()
  }

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
  try {
    check(
      'suppressed: the wrapper prints nothing at all',
      runWrapper(suppressed, JSON.stringify(REAL)),
      ''
    )
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
  } finally {
    cleanup(statusLinePayloadFile(suppressed))
  }

  const through = 'stoke-verify-passthrough'
  try {
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
  } finally {
    cleanup(join(statusLineDir(), `${through}.cmd`), statusLinePayloadFile(through))
  }

  console.log("\nELECTRON_RUN_AS_NODE does not leak into the user's command")
  /*
   * The shim sets this so <electron> runs as node for the wrapper itself —
   * simulated here by setting it in this process, since runWrapper inherits
   * this process's env with no override, exactly like the shim does for the
   * wrapper. If the wrapper didn't strip it, it would still be set when the
   * pass-through command below runs, and any Electron binary that command
   * invoked would start as node instead of as an app.
   */
  const envLeak = 'stoke-verify-env-leak'
  // %VAR% in cmd.exe stays literal when VAR is unset rather than expanding to
  // empty, so the Windows probe needs `if defined` instead of the POSIX
  // shell's plain interpolation — each branch's own value for "gone".
  const envCmd = isWin
    ? 'if defined ELECTRON_RUN_AS_NODE (echo LEAKED) else (echo CLEAN)'
    : 'echo "[$ELECTRON_RUN_AS_NODE]"'
  const envCmdWhenClean = isWin ? 'CLEAN' : '[]'
  const previousElectronEnv = process.env.ELECTRON_RUN_AS_NODE
  try {
    writeFileSync(join(statusLineDir(), `${envLeak}.cmd`), envCmd, 'utf8')
    process.env.ELECTRON_RUN_AS_NODE = '1'
    check(
      'the wrapper strips ELECTRON_RUN_AS_NODE before running the pass-through command',
      runWrapper(envLeak, JSON.stringify(REAL)).trim(),
      envCmdWhenClean
    )
  } finally {
    if (previousElectronEnv === undefined) delete process.env.ELECTRON_RUN_AS_NODE
    else process.env.ELECTRON_RUN_AS_NODE = previousElectronEnv
    cleanup(join(statusLineDir(), `${envLeak}.cmd`), statusLinePayloadFile(envLeak))
  }

  const junk = 'stoke-verify-junk'
  check('a non-JSON payload prints nothing', runWrapper(junk, 'Error: something went wrong\n'), '')
  check('and is not stored, so the last good reading survives a bad frame', readStatusLine(junk), null)

  check(
    'the command is one quoted path and one quoted id, with no shell metacharacter',
    /^"[^"]+" "stoke-verify-junk"$/.test(statusLineCommand(junk)),
    true
  )

  console.log('\na slow or runaway status line cannot wedge the terminal')
  /*
   * The pass-through is the one place Stoke runs a string as a shell command.
   * The string is the user's own statusLine.command out of their own
   * ~/.claude/settings.json, and the CLI already runs it through this same
   * shell — but the CLI re-renders about three times a second, so a command
   * that hangs, floods or fails has to be contained here rather than reach
   * the PTY.
   *
   * Every case below asserts the SAME outcome: an empty string. A status
   * line that failed is shown as no status line, never as its own error
   * text.
   */
  /** Prints, then hangs — so an empty result proves the timeout, not a dud command. */
  const hangCmd = isWin ? 'ping -n 31 127.0.0.1' : 'printf PARTIAL; sleep 30'
  /** The same command with the wait taken out. The control for the check above. */
  const controlCmd = isWin ? 'ping -n 1 127.0.0.1' : 'printf PARTIAL'

  const control = 'stoke-verify-slow-control'
  try {
    writeFileSync(join(statusLineDir(), `${control}.cmd`), controlCmd, 'utf8')
    check(
      'the hang case does print, when it is given no reason to hang',
      runWrapper(control, JSON.stringify(REAL)).length > 0,
      true
    )
  } finally {
    cleanup(join(statusLineDir(), `${control}.cmd`), statusLinePayloadFile(control))
  }

  const slow = 'stoke-verify-slow'
  try {
    writeFileSync(join(statusLineDir(), `${slow}.cmd`), hangCmd, 'utf8')
    const startedAt = Date.now()
    const slowOut = runWrapper(slow, JSON.stringify(REAL))
    const slowMs = Date.now() - startedAt
    check('a status line that hangs prints nothing at all, partial output included', slowOut, '')
    check('killed at the 2s timeout rather than waited out', slowMs < 10_000, true)
    check(
      'and the payload still landed, because the store happens before the pass-through',
      readStatusLine(slow)?.contextWindowSize,
      1_000_000
    )
  } finally {
    cleanup(join(statusLineDir(), `${slow}.cmd`), statusLinePayloadFile(slow))
  }

  const bad = 'stoke-verify-badexit'
  try {
    writeFileSync(join(statusLineDir(), `${bad}.cmd`), isWin ? 'exit /b 3' : 'exit 3', 'utf8')
    check('a non-zero exit prints nothing', runWrapper(bad, JSON.stringify(REAL)), '')
    check('and does not stop the payload being stored', readStatusLine(bad)?.contextWindowSize, 1_000_000)
  } finally {
    cleanup(join(statusLineDir(), `${bad}.cmd`), statusLinePayloadFile(bad))
  }

  /*
   * A quoted absolute path and nothing else — the same command shape as the
   * shim, which the checks above already prove a shell runs correctly on
   * this platform. Written as a file rather than inlined because the Windows
   * form of an infinite loop needs `&`, and cmd.exe eats it (CLAUDE.md
   * gotcha 13).
   *
   * 256 characters per line, so the 256KB cap is reached in about 1000
   * lines. That is what makes the elapsed-time check below able to tell
   * "maxBuffer killed it" from "the 2s timeout killed it" — without it, both
   * look like an empty string and the cap could have stopped working
   * unnoticed.
   */
  const flood = 'stoke-verify-flood'
  const FLOOD_LINE = 'x'.repeat(256)
  const FLOOD_MARKER = 'STOKE-FLOOD-CONTROL'
  // Named so it cannot be mistaken for `${flood}.cmd`, which is the pass-through
  // file pointing AT it rather than the script itself.
  const floodScript = join(statusLineDir(), isWin ? 'runaway-script.cmd' : 'runaway-script.sh')
  try {
    /*
     * Positive control FIRST, in the identical "<quoted script path>" shape
     * as the real flood case below, and sharing the same file and the same
     * single chmodSync call: prove the fixture itself actually runs before
     * trusting an empty result to mean "the cap fired". Without this, a
     * dropped chmodSync, a missing script, or an empty file all make the
     * real command below exit 126/127 within milliseconds too — floodOut is
     * '' and floodMs is ~100ms, and both real checks below pass while
     * testing nothing. writeFileSync truncates content on the second write
     * further down but does not touch existing permission bits, so this one
     * chmodSync call covers both the control and the real payload — deleting
     * it fails the control that runs first, not silently only the check it
     * originally guarded.
     */
    if (isWin) {
      writeFileSync(floodScript, `@echo off\r\necho ${FLOOD_MARKER}\r\n`, 'utf8')
    } else {
      writeFileSync(floodScript, `#!/bin/sh\necho ${FLOOD_MARKER}\n`, 'utf8')
      chmodSync(floodScript, 0o755)
    }
    writeFileSync(join(statusLineDir(), `${flood}.cmd`), `"${floodScript}"`, 'utf8')
    check(
      'flood control: the identical quoted-script shape actually runs and prints its marker',
      runWrapper(flood, JSON.stringify(REAL)).trim(),
      FLOOD_MARKER
    )
    cleanup(statusLinePayloadFile(flood))

    // The real runaway payload, same file and same executable bit.
    if (isWin) {
      writeFileSync(floodScript, `@echo off\r\n:loop\r\necho ${FLOOD_LINE}\r\ngoto loop\r\n`, 'utf8')
    } else {
      writeFileSync(floodScript, `#!/bin/sh\nwhile :; do echo ${FLOOD_LINE}; done\n`, 'utf8')
    }
    const floodStartedAt = Date.now()
    const floodOut = runWrapper(flood, JSON.stringify(REAL))
    const floodMs = Date.now() - floodStartedAt
    check('output past the 256KB cap prints nothing', floodOut, '')
    check(
      'and it was the cap that stopped it, not the timeout: ~1000 lines take well under 2s',
      floodMs < 1_500,
      true
    )
    check(
      'and the payload still landed, because the store happens before the pass-through',
      readStatusLine(flood)?.contextWindowSize,
      1_000_000
    )
  } finally {
    cleanup(join(statusLineDir(), `${flood}.cmd`), statusLinePayloadFile(flood), floodScript)
  }

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
    'an empty key gets no statusLine entry, because nothing would name the files',
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
  /*
   * ...and that case is unreachable for a session Stoke spawns locally. A
   * `--continue` has no session id at launch, so E Task 11 hands over a launch
   * key, which is an ordinary key here. It gets a wrapper like anything else,
   * which is what makes suppression and pass-through apply to it.
   */
  check(
    'a --continue session is keyed on its launch key, and gets the wrapper like any other',
    (
      sessionSettingsJson({
        sessionId: 'launch-6f1c2b',
        ultracode: false,
        hideStatusLine: true,
        passthroughCommand: ''
      }).statusLine as { command: string }
    ).command,
    statusLineCommand('launch-6f1c2b')
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
} finally {
  // The one directory-level fixture, torn down last so it actually runs
  // last regardless of which case above threw or failed a check.
  if (!dirExistedBefore) cleanup(statusLineDir())
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
