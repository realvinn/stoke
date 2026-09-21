/**
 * Verifies the context-meter maths against real Claude Code transcripts.
 *
 * Run with:  node scripts/verify-context.mts
 * (Node strips the type annotations natively; there is no build step.)
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, open, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { ContextWatcher } from '../src/main/context.ts'
import { findSessionFile } from '../src/main/projects.ts'
import {
  contextLimitFor,
  contextUsed,
  createFold,
  finishFold,
  foldFrom,
  foldLines,
  parseSession
} from '../src/main/sessionFile.ts'
import { readStatusLine, statusLinePayloadFile, windowFor } from '../src/main/statusLine.ts'
import type { ContextSnapshot } from '../src/shared/types.ts'

const root = join(homedir(), '.claude', 'projects')

function fmt(n: number): string {
  return n.toLocaleString('en-US')
}

const failures: string[] = []

function check(label: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}  ${detail}`)
  if (!ok) failures.push(label)
}

// Pick the largest transcripts: they exercise the parser hardest.
const dirs = await readdir(root, { withFileTypes: true })
const files: { path: string; size: number }[] = []
for (const d of dirs) {
  if (!d.isDirectory()) continue
  let names: string[]
  try {
    names = await readdir(join(root, d.name))
  } catch {
    continue
  }
  for (const n of names) {
    if (!n.endsWith('.jsonl')) continue
    const full = join(root, d.name, n)
    try {
      files.push({ path: full, size: (await stat(full)).size })
    } catch {
      /* ignore */
    }
  }
}

files.sort((a, b) => b.size - a.size)
const sample = files.slice(0, 6)

console.log(`Found ${files.length} transcripts; checking the ${sample.length} largest.\n`)

let parsedAny = false

for (const f of sample) {
  const started = process.hrtime.bigint()
  const parsed = await parseSession(f.path)
  const ms = Number(process.hrtime.bigint() - started) / 1e6

  const used = contextUsed(parsed)
  const limit = contextLimitFor(parsed.model, used)
  const pct = limit > 0 ? ((used / limit) * 100).toFixed(1) : 'n/a'

  console.log(`${f.path.split(/[\\/]/).slice(-2).join('/')}  (${fmt(f.size)} bytes, ${ms.toFixed(0)}ms)`)
  console.log(`   model=${parsed.model ?? 'none'}  limit=${fmt(limit)}`)
  console.log(
    `   in=${fmt(parsed.inputTokens)} cacheRead=${fmt(parsed.cacheReadTokens)} ` +
      `cacheCreate=${fmt(parsed.cacheCreationTokens)} out=${fmt(parsed.outputTokens)}`
  )
  console.log(`   context used=${fmt(used)} (${pct}%)  messages=${parsed.messageCount}`)
  console.log(`   title=${parsed.title ? JSON.stringify(parsed.title.slice(0, 60)) : 'none'}`)
  console.log('')

  if (parsed.messageCount > 0) {
    parsedAny = true
    check(
      `${f.path.split(/[\\/]/).pop()}: context within window`,
      used <= limit,
      `${fmt(used)} <= ${fmt(limit)}`
    )
    check(
      `${f.path.split(/[\\/]/).pop()}: usage is non-negative`,
      used >= 0 && parsed.outputTokens >= 0,
      `used=${fmt(used)}`
    )
    check(
      `${f.path.split(/[\\/]/).pop()}: parse under 1s`,
      ms < 1000,
      `${ms.toFixed(0)}ms`
    )
  }
}

check('at least one transcript yielded messages', parsedAny, `${sample.length} sampled`)

// Context-window resolution rules.
check('opus-5 under 200k -> 200k', contextLimitFor('claude-opus-5', 50_000) === 200_000, '200,000')
check('opus-5[1m] suffix -> 1M', contextLimitFor('claude-opus-5[1m]', 10) === 1_000_000, '1,000,000')
check('fable-5 under 200k -> 200k', contextLimitFor('claude-fable-5', 1_000) === 200_000, '200,000')
check('unknown model -> 200k', contextLimitFor(null, 0) === 200_000, '200,000')
// The critical case: a 1M session whose transcript records no suffix at all.
check(
  'unsuffixed id above 200k -> 1M',
  contextLimitFor('claude-opus-5', 269_349) === 1_000_000,
  'inferred from observed usage'
)

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
try {
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
} finally {
  rmSync(payloadFile, { force: true })
}

/*
 * The check this replaces asserted contextLimitFor('claude-haiku-4-5', 10_000,
 * 200_000) === 200_000 — but that model, at that token count, resolves to
 * 200_000 from contextLimitFor(..., null) too: no payload was ever read, so
 * the assertion passed whether the stated limit was honoured or discarded.
 * Fixed by tagging the model id "[1m]", which contextLimitFor resolves to
 * 1,000,000 entirely on its own (see the "opus-5[1m] suffix -> 1M" case
 * above), and having the payload state 200,000 instead. Only a genuinely-read
 * and honoured payload can pull that down to 200,000; discarding it falls
 * straight back to the id-implied 1,000,000. Read through `windowFor` — the
 * same function index.ts wires into the running app — not a hand-lifted
 * `contextWindowSize`.
 */
const overrideId = 'verify-context-200k-override'
const overrideFile = statusLinePayloadFile(overrideId)
try {
  writeFileSync(
    overrideFile,
    JSON.stringify({ context_window: { context_window_size: 200_000 } }),
    'utf8'
  )
  const statedOverride = windowFor(overrideId, null)
  check(
    'a payload stating 200k overrides a [1m]-tagged model id, not the other way round',
    contextLimitFor('claude-opus-5[1m]', 10_000, statedOverride) === 200_000,
    String(statedOverride)
  )
} finally {
  rmSync(overrideFile, { force: true })
}

/* ------------------------------------------------------------------------
   Live watcher: session id -> transcript lookup -> parse -> emitted snapshot.
   This is the exact path the running app uses for the context meter, minus the
   IPC hop, and it costs nothing to exercise.
   ------------------------------------------------------------------------ */

const liveId = basename(sample[0].path, '.jsonl')

const located = await findSessionFile(liveId)
check('findSessionFile locates a transcript by session id alone', located !== null, located ?? 'null')

const snapshot = await new Promise<ContextSnapshot | null>((resolve) => {
  const watcher = new ContextWatcher((snap) => {
    if (!snap.ready) return
    watcher.disposeAll()
    resolve(snap)
  })
  watcher.watch(liveId)
  setTimeout(() => {
    watcher.disposeAll()
    resolve(null)
  }, 15_000)
})

check('watcher emits a ready snapshot', snapshot !== null, snapshot ? 'received' : 'timed out')
if (snapshot) {
  console.log(
    `\n   watcher snapshot: ${fmt(snapshot.contextTokens)} / ${fmt(snapshot.contextLimit)} ` +
      `(${((snapshot.contextTokens / snapshot.contextLimit) * 100).toFixed(1)}%), ` +
      `${snapshot.messageCount} messages, model=${snapshot.model ?? 'none'}\n`
  )
  check(
    'watcher snapshot has real token counts',
    snapshot.contextTokens > 0 && snapshot.contextTokens <= snapshot.contextLimit,
    `${fmt(snapshot.contextTokens)}`
  )
  check('watcher snapshot carries a model', snapshot.model !== null, snapshot.model ?? 'null')
}

/*
 * The same watcher, told the window by a payload instead of a banner. Written
 * against the live session id because that is the only id findSessionFile can
 * resolve — a REAL session id, in the directory the boot sweep only clears
 * after 6 hours, so the write and its removal are wrapped in try/finally:
 * without it, an abnormal exit between the write and the `rmSync` below
 * (Ctrl-C, or an unhandled rejection out of `void this.tick(...)`) would
 * leave this session's genuine payload clobbered and its window claiming
 * 2,000,000 tokens for up to 6 hours — understating context pressure for a
 * real session, which is the one direction this codebase treats as
 * dangerous.
 *
 * The window is 2,000,000, not 1,000,000: contextLimitFor's observed-usage
 * fallback (what a broken windowFor would leave the watcher with) tops out at
 * WINDOW_EXTENDED = 1,000,000 for any session over 200k tokens, and this
 * transcript already sits around 605k. A check against 1,000,000 would pass
 * identically whether windowFor read the payload or returned null — exactly
 * the mistake this check exists to catch. 2,000,000 is inside windowSize's
 * 1k-10M bound and above the observed count, so contextLimitFor's
 * `observedTokens <= bannerLimit` guard still admits it, and it is a window
 * the observed-usage inference can never produce on its own.
 */
const livePayload = statusLinePayloadFile(liveId)
let viaPayload: ContextSnapshot | null = null
try {
  writeFileSync(
    livePayload,
    JSON.stringify({ context_window: { context_window_size: 2_000_000 } }),
    'utf8'
  )
  viaPayload = await new Promise<ContextSnapshot | null>((resolve) => {
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
} finally {
  rmSync(livePayload, { force: true })
}
check(
  'the watcher takes its window from the payload, banner or no banner',
  viaPayload?.contextLimit === 2_000_000,
  String(viaPayload?.contextLimit ?? 'timed out')
)

/* ------------------------------------------------------------------------
   The permission mode a session is actually in.
   It is captured in the tab at launch and Shift+Tab inside the session never
   reached it, so a tab could claim `bypass` for a session that had been put
   back into `default` half an hour earlier. The transcript is the only place
   that knows, and the watcher already reads it.
   ------------------------------------------------------------------------ */

const fixtureDir = await mkdtemp(join(tmpdir(), 'stoke-permission-'))
const withModes = join(fixtureDir, 'with-modes.jsonl')
const withoutModes = join(fixtureDir, 'without-modes.jsonl')

await writeFile(
  withModes,
  [
    JSON.stringify({ type: 'permission-mode', permissionMode: 'default', sessionId: 'x' }),
    JSON.stringify({ type: 'user', message: { content: 'hello' }, cwd: '/tmp' }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'bypassPermissions', sessionId: 'x' }),
    JSON.stringify({ type: 'permission-mode', permissionMode: 'nonsense', sessionId: 'x' }),
    ''
  ].join('\n')
)
await writeFile(
  withoutModes,
  [JSON.stringify({ type: 'user', message: { content: 'hello' }, cwd: '/tmp' }), ''].join('\n')
)

const modes = await parseSession(withModes)
const noModes = await parseSession(withoutModes)

check(
  'the newest permission-mode record wins',
  modes.permissionMode === 'bypassPermissions',
  String(modes.permissionMode)
)
check(
  'a value that is not a permission mode is ignored rather than adopted',
  modes.permissionMode !== 'nonsense',
  String(modes.permissionMode)
)
check(
  'a transcript with no permission-mode record reports null, not a guess',
  noModes.permissionMode === null,
  String(noModes.permissionMode)
)

/*
 * All four usage fields, not three.
 *
 * `contextUsed` summed input + cache_read + cache_creation and dropped
 * output_tokens. Those three are the prompt the model was GIVEN; the output is
 * what it wrote back, and that is in the conversation from the instant the turn
 * ends — which is exactly when someone looks at the ring. Measured across the
 * four largest real transcripts here, 2,486 consecutive turn pairs: the next
 * prompt grew by at least the previous output in 2,482 of them.
 *
 * Asserted on a synthetic record rather than on a real transcript, because the
 * point is the arithmetic and a real one cannot isolate a single field. Two
 * cases: the sum is right, and it is strictly larger than the old three-field
 * one whenever there is any output at all — the second is what actually fails
 * if someone "simplifies" the fourth term back out.
 */
const usage = { inputTokens: 100, cacheReadTokens: 1000, cacheCreationTokens: 20, outputTokens: 7 }
check('contextUsed counts all four usage fields', contextUsed(usage) === 1127, String(contextUsed(usage)))
check(
  'and never reports less than the prompt it was given',
  contextUsed(usage) > usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens,
  `${contextUsed(usage)} vs ${usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens}`
)
check(
  'a turn that wrote nothing is unchanged',
  contextUsed({ ...usage, outputTokens: 0 }) === 1120,
  String(contextUsed({ ...usage, outputTokens: 0 }))
)

await rm(fixtureDir, { recursive: true, force: true })

/* ------------------------------------------------------------------------
   Reading a real transcript in pieces (gotcha 103).

   The watcher folds a transcript once and then only what is appended, and
   `parseSession` streams it a chunk at a time; both must answer exactly what
   one fold of the whole text answers. `verify:folders` holds that on synthetic
   transcripts in CI; this holds it on the largest real ones here, which carry
   what no fixture thought of — megabyte lines, pasted images, every record
   type the CLI has ever written.

   Everything is bounded to the size stat'd at the start: these are live files,
   and the one this suite runs from is being appended to while it runs.
   ------------------------------------------------------------------------ */
{
  const sameFold = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  // A fixed sequence per file, so a failing cut point is printed and reproduces.
  const lcg = (seed: number) => () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  /*
   * Up to LINE_CUTS cuts just after a newline, then up to BYTE_CUTS anywhere
   * strictly inside the file (mid-line, mid-character).
   *
   * Both loops are bounded by what the file can offer AND by attempts. A set
   * holds no more distinct cuts than there are newlines, or bytes, to cut at,
   * and the largest transcript on a fresh machine can be a few lines long: the
   * unbounded `while (cuts.size < 9)` this replaces never returned there, and
   * `npm run check` hung on it rather than failing.
   */
  const LINE_CUTS = 6
  const BYTE_CUTS = 3
  const pickCuts = (newlines: readonly number[], size: number, rnd: () => number): Set<number> => {
    const cuts = new Set<number>()
    const lineTarget = Math.min(LINE_CUTS, newlines.length)
    for (let tries = 0; cuts.size < lineTarget && tries < 100 * LINE_CUTS; tries++) {
      cuts.add(newlines[Math.floor(rnd() * newlines.length)])
    }
    // 1..size-1 is size-1 positions; some may already be newline cuts, which
    // the attempt cap, not the target, then settles.
    const byteTarget = cuts.size + Math.min(BYTE_CUTS, Math.max(0, size - 1))
    for (let tries = 0; cuts.size < byteTarget && tries < 100 * BYTE_CUTS; tries++) {
      cuts.add(1 + Math.floor(rnd() * (size - 1)))
    }
    return cuts
  }
  // The shapes a fresh machine can hand it, run here because this machine's
  // own largest transcripts never will. Each must return, and stay in range.
  for (const [what, newlines, size, want] of [
    ['an empty file', [], 0, 0],
    ['one byte, no newline', [], 1, 0],
    ['two bytes, one newline at the end', [2], 2, 2],
    ['"\\n\\n\\n": every inner byte is already a newline cut', [1, 2, 3], 3, 3],
    ['two short lines', [3, 6], 6, 5],
    ['a large file', Array.from({ length: 50 }, (_, i) => (i + 1) * 100), 5000, LINE_CUTS + BYTE_CUTS]
  ] as const) {
    const cuts = pickCuts(newlines, size, lcg(size + 1))
    check(
      `cut points for ${what}: ${want} picked, all within the file`,
      cuts.size === want && [...cuts].every((c) => c >= 1 && c <= size),
      [...cuts].sort((a, b) => a - b).join(', ') || 'none'
    )
  }

  for (const f of sample.slice(0, 3)) {
    const name = f.path.split(/[\\/]/).pop()
    const fh = await open(f.path, 'r')
    try {
      const size = (await fh.stat()).size
      const one = { fold: createFold(), offset: 0 }
      await foldFrom(fh, one, size)
      const text = Buffer.alloc(one.offset)
      await fh.read(text, 0, one.offset, 0)
      const whole = createFold()
      foldLines(whole, text.toString('utf8'))
      check(
        `${name}: a streamed pass equals the whole-text fold`,
        sameFold(finishFold(one.fold), finishFold(whole)),
        `${fmt(one.offset)} bytes, ${one.fold.messageCount} messages`
      )

      const newlines: number[] = []
      for (let i = text.indexOf(0x0a); i >= 0; i = text.indexOf(0x0a, i + 1)) newlines.push(i + 1)
      const cuts = pickCuts(newlines, size, lcg(size))
      if (cuts.size === 0) {
        console.log(`SKIP  ${name}: ${fmt(size)} bytes, nothing to cut, so no cut-point check`)
        continue
      }
      if (cuts.size < LINE_CUTS + BYTE_CUTS) {
        console.log(
          `NOTE  ${name}: ${newlines.length} line(s) in ${fmt(size)} bytes, so ${cuts.size} of ` +
            `${LINE_CUTS + BYTE_CUTS} cut points`
        )
      }
      const wrong: number[] = []
      for (const cut of cuts) {
        const piecewise = { fold: createFold(), offset: 0 }
        await foldFrom(fh, piecewise, cut)
        await foldFrom(fh, piecewise, size)
        if (!sameFold(finishFold(piecewise.fold), finishFold(one.fold)) || piecewise.offset !== one.offset) {
          wrong.push(cut)
        }
      }
      check(
        `${name}: folding up to a cut and then the rest equals one pass, at ${cuts.size} cut points`,
        wrong.length === 0,
        wrong.length ? `wrong at ${wrong.join(', ')}` : [...cuts].sort((a, b) => a - b).join(', ')
      )
    } finally {
      await fh.close()
    }
  }
}

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
