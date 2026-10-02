/*
 * Find in a conversation: the find bar's rules, end to end short of a window.
 *
 * The screen half is xterm's SearchAddon and is not re-tested here. What is:
 * the transcript half (what is searched, the pattern, the window and the token
 * a hit offers, newest first, the caps), the reader (a record across a chunk
 * boundary, a multi-byte character across one, a capped tail, the parse cache),
 * the worker's budget against a runaway pattern (a real Worker), main's
 * finder (SSH consent, the in-flight claim, the refusal sentences) with fakes,
 * who takes Cmd+F when the docked browser is open, and the wires a pure
 * suite cannot otherwise see (gotcha 31): the files that must call these.
 *
 *   node scripts/verify-find.mts
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  FIND_LIMITS,
  blocksOfJsonl,
  blocksOfRecord,
  compileFind,
  consentVerdict,
  describeToolInput,
  newBlockContext,
  parseFindRequest,
  rangesIn,
  searchBlocks,
  tokenAround,
  windowAround,
  type FindBlock,
  type TranscriptFindResult
} from '../src/shared/transcriptFind.ts'
import { BlockCache, readBlocks } from '../src/main/transcriptFind.ts'
import { TranscriptFindHost } from '../src/main/transcriptFindHost.ts'
import { ConversationFinder, REMOTE_FRESH_MS, type FinderDeps } from '../src/main/findInConversation.ts'
import {
  barKey,
  findOwner,
  findTargetOf,
  paletteFindMatch,
  roleLabel,
  screenCountLabel,
  typedInto
} from '../src/renderer/src/lib/terminalFind.ts'
import { chordLabel, matchShortcut } from '../src/renderer/src/lib/shortcuts.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import type { SshHost } from '../src/shared/types.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`))
}

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')
const scratch = mkdtempSync(join(tmpdir(), 'stoke-verify-find-'))

const opts = (o: Partial<{ caseSensitive: boolean; wholeWord: boolean; regex: boolean }> = {}) => ({
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  ...o
})
const matches = (query: string, text: string, o = opts()): string[] => {
  const c = compileFind(query, o)
  if (!c || !c.ok) return [`<${c ? c.error : 'null'}>`]
  return rangesIn(text, c.re).map(([s, e]) => text.slice(s, e))
}

/* ------------------------------------------------------------- the pattern */

console.log('\nthe pattern')
check('a literal is a literal: "a.b" does not match "axb"', matches('a.b', 'axb a.b'), ['a.b'])
check('case folds by default', matches('inv', 'INV-1 inv'), ['INV', 'inv'])
check('Match case keeps it', matches('inv', 'INV-1 inv', opts({ caseSensitive: true })), ['inv'])
check(
  'Whole word reads "-" as a boundary, as xterm does: INV in INV-8F3K, not in INVOICE',
  matches('INV', 'INVOICE INV-8F3K', opts({ wholeWord: true })),
  ['INV']
)
check('Whole word keeps "_" inside a word', matches('id', 'user_id id', opts({ wholeWord: true })), ['id'])
check('Whole word knows letters past ASCII: "caf" is not a word in "café"', matches('caf', 'café caf', opts({ wholeWord: true })), ['caf'])
check('a regex runs as one', matches('INV-\\w+', 'code INV-8F3K ok', opts({ regex: true })), ['INV-8F3K'])
check(
  'a regex only valid without the u flag still runs (x\\:y, an identity escape)',
  matches('x\\:y', 'x:y', opts({ regex: true })),
  ['x:y']
)
{
  const bad = compileFind('(unclosed', opts({ regex: true }))
  check('a broken regex says so instead of throwing', bad?.ok === false ? 'refused' : 'compiled', 'refused')
}
check('an empty query is nothing to find, not an error', compileFind('', opts()), null)
check('an over-long query is refused', compileFind('x'.repeat(FIND_LIMITS.query + 1), opts())?.ok, false)
check('a pattern that can match nothing does not loop', matches('x*', 'abc', opts({ regex: true })), [])
{
  const c = compileFind('a', opts())
  check('matches past the cap are not counted on', c && c.ok ? rangesIn('a'.repeat(50), c.re, 7).length : -1, 7)
}

/* ------------------------------------------------- the window and the token */

console.log('\nwhat a hit shows and offers')
{
  const text = 'line one\nline two\nthe code is INV-8F3K-29.\nline four\nline five'
  const at = text.indexOf('INV')
  const w = windowAround(text, at, at + 3)
  check('the window is the match line and one either side', w.text, 'line two\nthe code is INV-8F3K-29.\nline four')
  check('and says it was cut on both ends', [w.cutBefore, w.cutAfter], [true, true])
  check('the token is the code, the full stop trimmed', tokenAround(text, at, at + 3), 'INV-8F3K-29')
}
{
  const crlf = 'one\r\ntwo INV-1\r\nthree\r\nfour'
  const at = crlf.indexOf('INV')
  const w = windowAround(crlf, at, at + 3)
  check('CRLF is one line break, and no lone CR ends the window', w.text, 'one\r\ntwo INV-1\r\nthree')
}
{
  // Two characters either side lands both cuts between the halves of an emoji.
  const emoji = '😀😀😀😀😀 NEEDLE 😀😀😀😀😀'
  const at = emoji.indexOf('NEEDLE')
  const w = windowAround(emoji, at, at + 6, 2)
  check('a narrow window never splits an emoji in half, at either end', w.text, '😀 NEEDLE 😀')
}
check('a bracketed token is taken from inside the brackets', tokenAround('see (INV-8F3K-29)', 5, 8), 'INV-8F3K-29')
check('markdown bold is trimmed', tokenAround('**INV-1** ok', 2, 5), 'INV-1')
check('a backticked token stops at the backticks', tokenAround('run `INV-2`', 5, 8), 'INV-2')
check('a match that ends in punctuation keeps it', tokenAround('done 29.', 5, 8), '29.')

/* --------------------------------------------------- what is searched */

console.log('\nwhat a transcript record gives the search')
const T = (s: number): string => new Date(Date.UTC(2026, 9, 2, 10, 0, s)).toISOString()
const records = [
  { type: 'user', timestamp: T(0), message: { role: 'user', content: 'find me the INV code' } },
  {
    type: 'assistant',
    timestamp: T(1),
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'SECRET-THOUGHT INV' },
        { type: 'text', text: 'Running the lookup.' },
        { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'grep -r "INV" .\necho done', description: 'Find it' } }
      ]
    }
  },
  {
    type: 'user',
    timestamp: T(2),
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'invoice: INV-8F3K-29 "quoted" 😀' }] }
  },
  {
    type: 'user',
    timestamp: T(3),
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'grep: INV-ERR' }, { type: 'image' }] }]
    }
  },
  { type: 'assistant', timestamp: T(4), isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'SIDECHAIN INV' }] } },
  { type: 'user', timestamp: T(5), isMeta: true, message: { role: 'user', content: 'META INV' } },
  { type: 'summary', summary: 'SUMMARY INV' },
  { type: 'assistant', timestamp: T(6), message: { role: 'assistant', content: [{ type: 'text', text: 'The code is INV-8F3K-29.' }] } }
]
const jsonl = records.map((r) => JSON.stringify(r)).join('\n') + '\n'
const withTools = blocksOfJsonl(jsonl, true)
const roles = (bs: FindBlock[]): string[] => bs.map((b) => `${b.role}${b.tool ? `:${b.tool}` : ''}${b.isError ? '!' : ''}`)
check(
  'user text, Claude text, the tool call, both outputs (one an error), in order',
  roles(withTools),
  ['user', 'assistant', 'tool-call:Bash', 'tool-output:Bash', 'tool-output:Bash!', 'assistant']
)
check('thinking, sidechains, meta and summaries are not searched', withTools.some((b) => /SECRET|SIDECHAIN|META|SUMMARY/.test(b.text)), false)
check('with tools off, only what was said', roles(blocksOfJsonl(jsonl, false)), ['user', 'assistant', 'assistant'])
check('a tool result in blocks keeps its text, not the image', withTools[4].text, 'grep: INV-ERR')
check('a call is its input as lines, strings unescaped', describeToolInput({ command: 'a "b"\nc', n: 2, xs: ['p', 'q'], o: { k: 1 } }), 'command: a "b"\nc\nn: 2\nxs: p, q\no: {"k":1}')
check('the timestamp is kept', withTools[0].atMs, Date.parse(T(0)))
{
  // The JSON-escape trap: in the raw line these are \" and \n and \ud83d...;
  // a needle that is searched in the RAW text misses all three.
  const c = compileFind('"quoted" 😀', opts())
  const hit = c && c.ok ? searchBlocks(withTools, c.re).hits.map((h) => h.role) : []
  check('a needle with a quote and an emoji is found in tool output', hit, ['tool-output'])
  const nl = compileFind('INV" .\necho', opts())
  check('a needle across a newline in a command is found', nl && nl.ok ? searchBlocks(withTools, nl.re).total : 0, 1)
}
{
  const ctx = newBlockContext()
  blocksOfRecord(records[1], true, ctx)
  check('a later output finds its tool by the call id', blocksOfRecord(records[2], true, ctx)[0]?.tool, 'Bash')
  check('without the call, the output still comes, unnamed', blocksOfRecord(records[2], true, newBlockContext())[0]?.tool, null)
  check('a broken record yields nothing and does not throw', blocksOfJsonl('{"type":"user", nope\n', true), [])
}

/* ------------------------------------------------------------ the search */

console.log('\nnewest first, and the caps')
{
  const c = compileFind('INV-8F3K-29', opts())
  const ans = c && c.ok ? searchBlocks(withTools, c.re) : null
  check('the newest message comes first', ans?.hits.map((h) => h.role), ['assistant', 'tool-output'])
  check('every match counted', ans?.total, 2)
  check('a hit carries its token and its exact match', ans ? [ans.hits[1].token, ans.hits[1].matchText] : null, ['INV-8F3K-29', 'INV-8F3K-29'])
  check('Copy message has the whole message', ans ? ans.messages[ans.hits[1].message].text : null, 'invoice: INV-8F3K-29 "quoted" 😀')
}
{
  const many: FindBlock[] = Array.from({ length: 300 }, (_, i) => ({ role: 'assistant', tool: null, isError: false, atMs: i, text: `n${i} INV` }))
  const c = compileFind('INV', opts())
  const ans = c && c.ok ? searchBlocks(many, c.re) : null
  check('at most 200 listed', ans?.hits.length, FIND_LIMITS.hits)
  check('all 300 counted, and the cut is said', [ans?.total, ans?.truncated], [300, true])
  check('the cut drops the oldest', [ans?.hits[0].atMs, ans?.hits[199].atMs], [299, 100])
}
{
  // Twelve matches far enough apart that each has a window of its own.
  const text = Array.from({ length: 12 }, (_, i) => `INV ${i}`).join('\n\n\n\n') + 'x'.repeat(60_000)
  const block: FindBlock = { role: 'tool-output', tool: 'Bash', isError: false, atMs: null, text }
  const c = compileFind('INV', opts())
  const ans = c && c.ok ? searchBlocks([block], c.re) : null
  check('five hits from one message, the rest counted on the last', ans ? [ans.hits.length, ans.hits[4].more, ans.truncated] : null, [5, 7, true])
  check('a long message is cut for Copy message, and says so', ans ? [ans.messages[0].text.length, ans.messages[0].cut] : null, [FIND_LIMITS.message, true])
}
{
  // The owner's case: "INV", case folded, also matches "Invoice" and "invite".
  const block: FindBlock = { role: 'tool-output', tool: 'Bash', isError: false, atMs: null, text: 'Invoice 2026-10\nYour invite code is INV-8F3K-29.\nTotal' }
  const c = compileFind('INV', opts())
  const ans = c && c.ok ? searchBlocks([block], c.re, {}, 'INV') : null
  check('matches in one window are one hit, all of them marked', ans ? [ans.hits.length, ans.hits[0].ranges.length] : null, [1, 3])
  check('and the hit offers the one spelled as typed: the code, not "Invoice"', ans ? [ans.hits[0].matchText, ans.hits[0].token] : null, ['INV', 'INV-8F3K-29'])
  check('every match is still counted, none hidden', ans ? [ans.total, ans.truncated] : null, [3, false])
  const plain = c && c.ok ? searchBlocks([block], c.re) : null
  check('with nothing preferred, the first in the window', plain?.hits[0].matchText, 'Inv')
}

/* ------------------------------------------------------------- the reader */

console.log('\nreading the file')
{
  const file = join(scratch, 'chunks.jsonl')
  // A record whose needle straddles a 64-byte read, with a multi-byte character
  // on the cut, and a last record with no newline yet.
  const lines = [
    JSON.stringify({ type: 'user', message: { content: 'padding padding padding' } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ééééé STRADDLE-NEEDLE ééééé' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'still writing TAIL-NEEDLE' }] } })
  ]
  writeFileSync(file, lines[0] + '\n' + lines[1] + '\n' + lines[2])
  const r = readBlocks(file, true, 64 * 1024 * 1024, 64)
  check('a record across 64-byte reads comes back whole', r.blocks[1]?.text, 'ééééé STRADDLE-NEEDLE ééééé')
  check('the last record, with no newline after it yet, is read', r.blocks[2]?.text, 'still writing TAIL-NEEDLE')
  check('nothing partial about a small file', r.partial, false)
  const tail = readBlocks(file, true, Buffer.byteLength(lines[2]) + 10, 64)
  check('past the cap only the end is read, and it says so', [tail.partial, tail.blocks.map((b) => b.text)], [true, ['still writing TAIL-NEEDLE']])
}
{
  const file = join(scratch, 'cache.jsonl')
  writeFileSync(file, JSON.stringify(records[0]) + '\n')
  const cache = new BlockCache()
  const first = cache.forFile(file, true, statSync(file))
  check('the same file twice is one parse', cache.forFile(file, true, statSync(file)) === first, true)
  appendFileSync(file, JSON.stringify(records[7]) + '\n')
  const later = new Date(Date.now() + 5000)
  utimesSync(file, later, later)
  const second = cache.forFile(file, true, statSync(file))
  check('an append is read: the cache keys on size and mtime', second.blocks.length, 2)
  check('tools on and off are two parses', cache.forFile(file, false, statSync(file)) !== second, true)
}

/* -------------------------------------------------- the worker's budget */

console.log('\nthe worker: a runaway pattern ends the thread, the next search gets a new one')
{
  const file = join(scratch, 'worker.jsonl')
  writeFileSync(file, jsonl + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'a'.repeat(40) + '!' }] } }) + '\n')
  const host = new TranscriptFindHost({
    workerPath: fileURLToPath(new URL('../src/main/transcriptFind.worker.ts', import.meta.url)),
    budgetMs: 1500,
    idleMs: 5_000
  })
  const base = { caseSensitive: false, wholeWord: false, includeTools: true, source: { kind: 'file' as const, file } }
  const ok = await host.find({ ...base, regex: false, query: 'INV-8F3K-29' })
  check('a search in the worker answers', ok.ok ? ok.value.total : ok.error, 2)
  const folded = await host.find({ ...base, regex: false, query: 'INV' })
  check(
    'the worker hands the query as typed to prefer: "INV" offers the code, not "invoice"',
    folded.ok ? folded.value.hits.find((h) => h.role === 'tool-output' && !h.isError)?.token : folded.error,
    'INV-8F3K-29'
  )
  const started = Date.now()
  const runaway = await host.find({ ...base, regex: true, query: '(a+)+$' })
  const took = Date.now() - started
  check('catastrophic backtracking is cut off as a timeout', runaway.ok ? 'answered' : runaway.timeout, true)
  check('within the budget, not after the pattern gave up', took < 4_000, true)
  const again = await host.find({ ...base, regex: false, query: 'INV-8F3K-29' })
  check('and the next search runs on a fresh worker', again.ok ? again.value.total : again.error, 2)
  const text = await host.find({ ...base, regex: false, query: 'INV', source: { kind: 'text', key: 'k', text: jsonl } })
  check('a copy held in memory is searched the same way', text.ok ? text.value.hits.length > 0 : text.error, true)
  await host.stop()
}

/* ------------------------------------------------------------ main's finder */

console.log('\nmain: which transcript, and SSH only on the host\'s answer')
const SID = '3f2a6c1e-8a1b-4c2d-9e0f-123456789abc'
const host = (over: Partial<SshHost> = {}): SshHost => ({ id: 'host-1', label: 'web1', alias: 'web1', command: '', ...over })
function harness(opts: { host?: SshHost | null; local?: string | null; read?: () => Promise<unknown>; answer?: unknown } = {}) {
  const calls = { allow: [] as string[], read: 0, keep: 0, search: [] as unknown[] }
  let clock = 1_000_000
  const localFile = join(scratch, 'local.jsonl')
  writeFileSync(localFile, jsonl)
  const deps: FinderDeps = {
    hostFor: () => opts.host ?? null,
    allowHost: (id) => calls.allow.push(id),
    localFile: async () => (opts.local === undefined ? localFile : opts.local),
    readRemote: async () => {
      calls.read++
      return (opts.read ? await opts.read() : { ok: true, remotePath: '/home/me/.claude/projects/-app/abc.jsonl', jsonl }) as never
    },
    keepRemote: () => {
      calls.keep++
      return localFile
    },
    search: async (req) => {
      calls.search.push(req.source.kind)
      return (opts.answer ?? { ok: true, value: { hits: [], messages: [], total: 0, truncated: false, partial: false } }) as never
    },
    now: () => clock
  }
  return { finder: new ConversationFinder(deps), calls, tick: (ms: number) => (clock += ms) }
}
const ask = (over: Record<string, unknown> = {}) => ({ sessionId: SID, hostId: null, query: 'INV', includeTools: true, ...over })
const reason = (r: TranscriptFindResult): string => (r.ok ? `ok:${r.source.kind}` : r.reason)
{
  const h = harness()
  check('a local tab searches its own file', reason(await h.finder.find(ask())), 'ok:local')
  check('a --continue tab with no id yet: the screen only, said so', reason(await h.finder.find(ask({ sessionId: '' }))), 'no-session')
  check('a session id that is a path is refused before any read', reason(await h.finder.find(ask({ sessionId: '../../etc/passwd' }))), 'failed')
  check('a broken regex is refused before the worker', reason(await h.finder.find(ask({ query: '(', regex: true }))), 'bad-query')
  check('not a request at all', reason(await h.finder.find('nope')), 'failed')
  check('those refusals reached no worker', h.calls.search.length, 1)
  const none = harness({ local: null })
  check('no transcript on disk yet', reason(await none.finder.find(ask())), 'no-file')
}
{
  const h = harness({ host: host() })
  const r = await h.finder.find(ask())
  check('an SSH host nobody has allowed is asked about', reason(r), 'consent')
  check('the question names the host and the 4 MB copy', !r.ok && r.message.includes('web1') && r.message.includes('4 MB'), true)
  check('and nothing was fetched to ask it', h.calls.read, 0)
}
{
  const h = harness({ host: host() })
  const r = await h.finder.find(ask({ consent: 'once' }))
  check('"Just this once" searches', reason(r), 'ok:ssh')
  check('from memory: nothing written, nothing allowed', [h.calls.keep, h.calls.allow, r.ok && r.source.kind === 'ssh' ? r.source.kept : null], [0, [], false])
  check('the copy is searched as text', h.calls.search, ['text'])
  await h.finder.find(ask({ consent: 'once', query: 'INV-' }))
  check('the next letter within the window searches the same copy', h.calls.read, 1)
  h.tick(REMOTE_FRESH_MS)
  await h.finder.find(ask({ consent: 'once', query: 'INV-8' }))
  check('an older copy is fetched again', h.calls.read, 2)
}
{
  const h = harness({ host: host() })
  const r = await h.finder.find(ask({ consent: 'always' }))
  check('"Allow for this host" records the host', h.calls.allow, ['host-1'])
  check('and keeps the copy, names the file and the 4 MB tail', r.ok && r.source.kind === 'ssh' ? [r.source.kept, r.source.remotePath, r.source.tailBytes] : null, [
    true,
    '/home/me/.claude/projects/-app/abc.jsonl',
    4_000_000
  ])
  check('the kept copy is searched as a file', h.calls.search, ['file'])
}
{
  const h = harness({ host: host({ transcriptFind: true }) })
  const [a, b] = await Promise.all([h.finder.find(ask()), h.finder.find(ask({ query: 'INV-8' }))])
  check('an allowed host needs no answer', [reason(a), reason(b)], ['ok:ssh', 'ok:ssh'])
  check('two searches in flight share one fetch (claimed before the await)', h.calls.read, 1)
  await h.finder.find(ask({ refresh: true }))
  check('Copy it again fetches again', h.calls.read, 2)
  check('nothing was asked to allow it twice', h.calls.allow, [])
}
{
  const down = harness({ host: host({ transcriptFind: true }), read: async () => ({ ok: false, why: 'ssh' }) })
  const r = await down.finder.find(ask())
  check('a host ssh cannot reach without a prompt says BatchMode needs key login', [reason(r), !r.ok && r.message.includes('key login')], ['fetch-failed', true])
  const empty = harness({ host: host({ transcriptFind: true }), read: async () => ({ ok: false, why: 'none' }) })
  check('a host with no Claude conversation says so', reason(await empty.finder.find(ask())), 'no-remote')
  const slow = harness({ answer: { ok: false, timeout: true, error: 'x' } })
  check('a pattern past its budget is a timeout', reason(await slow.finder.find(ask())), 'timeout')
}
check('consent: an allowed host keeps', consentVerdict({ transcriptFind: true }, undefined), 'keep')
check('consent: allowed wins over once', consentVerdict({ transcriptFind: true }, 'once'), 'keep')
check('consent: once is once', consentVerdict({}, 'once'), 'once')
check('consent: otherwise ask', consentVerdict({ transcriptFind: 'yes' as unknown as boolean }, undefined), 'ask')
check('a request crossing IPC is rebuilt field by field', parseFindRequest({ sessionId: 'a', query: 'q', hostId: 7 }), null)
check(
  'and unknown consent is dropped, tools default on',
  parseFindRequest({ sessionId: 'a', query: 'q', consent: 'forever', regex: 'yes' }),
  { sessionId: 'a', hostId: null, query: 'q', caseSensitive: false, wholeWord: false, regex: false, includeTools: true }
)
{
  const s = hydrateSettings({ hosts: [{ id: 'h', alias: 'x', label: '', command: '', transcriptFind: 'true' }, { id: 'g', alias: 'y', label: '', command: '', transcriptFind: true }] })
  check('a hand-edited truthy consent hydrates as off; only the literal true is on', s.hosts.map((h) => h.transcriptFind), [false, true])
  check('a fresh settings file has no host to consent for', hydrateSettings(null).hosts, [])
}

/* ------------------------------------------------------------- the chord */

console.log('\nwho takes Cmd+F')
const k = (code: string, m: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}) => ({
  code,
  ctrlKey: !!m.ctrl,
  metaKey: !!m.meta,
  shiftKey: !!m.shift,
  altKey: !!m.alt
})
check('Cmd+F is find on macOS', matchShortcut(k('KeyF', { meta: true }), true), { type: 'find' })
check('Ctrl+Shift+F is find off macOS', matchShortcut(k('KeyF', { ctrl: true, shift: true }), false), { type: 'find' })
check('bare Ctrl+F stays the CLI\'s (forward-char) off macOS', matchShortcut(k('KeyF', { ctrl: true }), false), null)
check('Cmd+Shift+F is not find', matchShortcut(k('KeyF', { meta: true, shift: true }), true), null)
check('the label says what each platform presses', [chordLabel('find', true), chordLabel('find', false)], ['⌘F', 'Ctrl+Shift+F'])
{
  const el = (inside: string[]) => ({ closest: (sel: string) => (inside.includes(sel) ? {} : null) })
  check('a key in the terminal pane', findTargetOf(el(['.term-pane'])), { inBrowser: false, inTerminal: true })
  check('a key in the browser panel', findTargetOf(el(['section.browser'])), { inBrowser: true, inTerminal: false })
  check('a key on something with no DOM', findTargetOf(null), { inBrowser: false, inTerminal: false })
  const mac = { terminalChord: true, pageChord: true }
  const own = (where: { inBrowser?: boolean; inTerminal?: boolean }, rest: Partial<Parameters<typeof findOwner>[0]> = {}) =>
    findOwner({ inBrowser: false, inTerminal: false, terminalShown: true, browserOpen: true, ...mac, ...where, ...rest })
  check('macOS, focus in the terminal, browser docked: the TERMINAL bar', own({ inTerminal: true }), 'terminal')
  check('macOS, focus in the browser\'s chrome: the page', own({ inBrowser: true }), 'page')
  check('macOS, focus on the chrome elsewhere with a terminal in front: the terminal', own({}), 'terminal')
  check('macOS, no terminal in front, browser docked: the page', own({}, { terminalShown: false }), 'page')
  check('macOS, no terminal and no browser: nothing', own({}, { terminalShown: false, browserOpen: false }), null)
  check('a paused pane is no terminal: the page', own({ inTerminal: true }, { terminalShown: false }), 'page')
  const win = { terminalChord: false, pageChord: true }
  check('off macOS, Ctrl+F in the terminal is never a find', own({ inTerminal: true }, win), null)
  check('off macOS, Ctrl+F on the chrome is still the page\'s', own({}, win), 'page')
  check('off macOS, Ctrl+F in the browser: the page', own({ inBrowser: true }, win), 'page')
  check('off macOS, Ctrl+Shift+F in the terminal: the terminal', own({ inTerminal: true }), 'terminal')
}

console.log('\na key pressed inside the bar never reaches the terminal')
{
  const k2 = (key: string, m: { ctrl?: boolean; meta?: boolean; alt?: boolean } = {}) => ({
    key,
    ctrlKey: !!m.ctrl,
    metaKey: !!m.meta,
    altKey: !!m.alt
  })
  // Found driving the built app: Enter on a focused Copy message was written to
  // the pty (submitting the prompt), and letters typed after clicking Aa landed
  // in Claude's prompt, because App's window listener types a plain key on a
  // button through to the terminal.
  check('Enter on a focused button stays in the bar, to press it', barKey(k2('Enter'), false), 'keep')
  check('so does Space', barKey(k2(' '), false), 'keep')
  check('a letter typed on a toggle edits the query', barKey(k2('x'), false), 'type')
  check('Backspace on a toggle edits the query', barKey(k2('Backspace'), false), 'type')
  check('an emoji is one character', barKey(k2('\u{1F525}'), false), 'type')
  check('Tab moves between controls, in the bar', barKey(k2('Tab'), false), 'keep')
  check('in the input every plain key is the input\'s', [barKey(k2('x'), true), barKey(k2('Enter'), true)], ['keep', 'keep'])
  check('Escape closes from the input or a control', [barKey(k2('Escape'), true), barKey(k2('Escape'), false)], ['close', 'close'])
  check('a chord goes on to App: Cmd+F re-focuses, Cmd+K opens the palette', [barKey(k2('f', { meta: true }), false), barKey(k2('F', { ctrl: true }), true)], ['chord', 'chord'])
  check('Alt too (Alt+C on the input is the bar\'s own toggle, handled there)', barKey(k2('c', { alt: true }), true), 'chord')
  check('typing on a control appends', typedInto('INV', '-'), 'INV-')
  check('Backspace takes the last character, an emoji whole', typedInto('a\u{1F525}', 'Backspace'), 'a')
}

console.log('\nthe words')
check('alternate screen: "on screen"', screenCountLabel(3, 0, 'alternate'), '1 of 3 on screen')
check('normal buffer: "in the terminal", scrollback and all', screenCountLabel(0, -1, 'normal'), 'None in the terminal')
check('past the highlight limit the index is unknown', screenCountLabel(2000, -1, 'normal'), '2000+ in the terminal')
check('a tool\'s error output is named as one', roleLabel('tool-output', 'Bash', true), 'Bash output (error)')
check('the palette lists Find for "find"', paletteFindMatch('find'), [[0, 4]])
check('and for "search conv"', paletteFindMatch('search conv'), [[13, 17]])
check('two words on one spot mark it once (Highlight takes no overlaps)', paletteFindMatch('find fin'), [[0, 4]])
check('not for a project name', paletteFindMatch('stoke'), null)
check('not on an empty query', paletteFindMatch(''), null)

/* --------------------------------------------------------------- the wires */

console.log('\nthe wires a pure suite cannot otherwise see (gotcha 31)')
{
  const tv = read('src/renderer/src/components/TerminalView.tsx')
  check('TerminalView loads the search addon on the terminal', /term\.loadAddon\(searcher\)/.test(tv), true)
  check('registers its bar only while it is the pane in front', /if \(!active\) return\s+return registerFinder\(tab\.ptyId, openFind\)/.test(tv), true)
  check('renders the bar inside the pane', /<TerminalFind\b/.test(tv), true)
  check('the right-click menu offers Find… with the chord', /label: 'Find…',\s+hint: chordLabel\('find', IS_MAC\)/.test(tv), true)
  const bar = read('src/renderer/src/components/TerminalFind.tsx')
  check(
    'every key in the bar is decided on its root, a button included, not only on the input',
    /className="term-find"[\s\S]*?onKeyDown=\{onRootKeyDown\}/.test(bar) &&
      /const onRootKeyDown = [\s\S]*?barKey\(e, e\.target === inputRef\.current\)[\s\S]*?if \(what === 'chord'\) return\s+e\.stopPropagation\(\)[\s\S]*?close\(\)[\s\S]*?typedInto\(/.test(bar),
    true
  )
  check(
    "answering the host's question keeps focus in the bar (its buttons unmount; found driving the built app)",
    /const answer = \([^)]*\): void => \{[\s\S]{0,300}?inputRef\.current\?\.focus\(\)/.test(bar),
    true
  )
  const app = read('src/renderer/src/App.tsx')
  check("App's chord asks findOwner and opens the terminal's bar only on its answer", /case 'find': \{[\s\S]*?findOwner\([\s\S]*?if \(owner === 'terminal'\) openActiveFinder\(\)/.test(app), true)
  check('the palette is handed the find row only with a terminal in front', /onFind=\{\s*hasActiveFinder\(\)/.test(app), true)
  const bp = read('src/renderer/src/components/BrowserPanel.tsx')
  check("the browser's window listener asks findOwner and opens only on 'page'", /findOwner\([\s\S]*?if \(owner !== 'page'\) return\s+e\.preventDefault\(\)\s+open\(\)/.test(bp), true)
  check('and no longer opens the page find from any focus', /if \(primary && !e\.altKey && e\.key\.toLowerCase\(\) === 'f'\) \{\s*e\.preventDefault\(\)\s*open\(\)/.test(bp), false)
  const main = read('src/main/index.ts')
  check('main answers the channel through the finder', /ipcMain\.handle\(CH\.transcriptFind, \(_e, req: unknown\) => finder\(\)\.find\(req\)\)/.test(main), true)
  check('the worker is its own bundle, never the chat index\'s', /from '\.\/transcriptFind\.worker\.ts\?modulePath'/.test(main), true)
  const hosts = read('src/renderer/src/components/HostsSettings.tsx')
  check('Settings › SSH hosts draws the consent row, marked for search (gotcha 138)', /data-setting="hosts\.transcript-find"/.test(hosts), true)
  const pkg = JSON.parse(read('package.json')) as { devDependencies: Record<string, string>; scripts: Record<string, string> }
  check('verify:find is in the check chain', pkg.scripts.check.includes('npm run verify:find'), true)
  check('@xterm/addon-search is a dependency like the other addons', pkg.devDependencies['@xterm/addon-search'], '^0.16.0')
  const commit = (p: string): string => (JSON.parse(read(`node_modules/${p}/package.json`)) as { commit?: string }).commit ?? '?'
  check('the installed addon was built from the same xterm commit as @xterm/xterm', commit('@xterm/addon-search'), commit('@xterm/xterm'))
}

rmSync(scratch, { recursive: true, force: true })
console.log(failures ? `\n${failures} failed` : '\nall pass')
process.exitCode = failures ? 1 : 0
