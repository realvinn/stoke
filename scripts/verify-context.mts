/**
 * Verifies the context-meter maths against real Claude Code transcripts.
 *
 * Run with:  node scripts/verify-context.mts
 * (Node strips the type annotations natively; there is no build step.)
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { ContextWatcher } from '../src/main/context.ts'
import { findSessionFile } from '../src/main/projects.ts'
import { contextLimitFor, contextUsed, parseSession } from '../src/main/sessionFile.ts'
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

console.log(`\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
