/**
 * The activity report is the only answer to "what did I work on this week", so
 * the two numbers it states have to be defensible: active time, and lines
 * written. Both are easy to get subtly wrong in ways that still render.
 *
 * Active time is the one with a real trap in it. A session's wall-clock span is
 * not time worked — a real transcript on this machine spans 127.7 hours and
 * holds 12.5 hours of activity at a 5-minute idle cap, 18.4 at 15 minutes — so
 * a report that subtracted first from last would overstate a week by a factor
 * of seven and look entirely plausible doing it.
 *
 *   node scripts/verify-activity.mts
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  bucketActiveMs,
  dayKey,
  editFilePath,
  editLineCount,
  IDLE_GAP_MS,
  clearActivityCache,
  readActivity,
  readSessionActivity
} from '../src/main/activity.ts'

let failed = 0
const check = (name: string, ok: boolean, detail = ''): void => {
  if (!ok) failed++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}

const MIN = 60_000
/** 2026-08-25 in local time, so day boundaries are exercised in the local zone. */
const at = (h: number, m = 0): number => new Date(2026, 7, 25, h, m, 0, 0).getTime()

console.log('\nactive time')

const short = bucketActiveMs([at(9), at(9, 5), at(9, 9)])
check(
  'gaps under the cap accumulate in full',
  short.get(dayKey(at(9))) === 9 * MIN,
  String(short.get(dayKey(at(9))))
)

const long = bucketActiveMs([at(9), at(14)])
check(
  'a gap over the cap contributes exactly the cap, not zero and not its full length',
  long.get(dayKey(at(9))) === IDLE_GAP_MS,
  String(long.get(dayKey(at(9))))
)

const none = bucketActiveMs([at(9)])
check('a single stamp is no elapsed time', none.size === 0)

check('an empty session buckets nothing', bucketActiveMs([]).size === 0)

const unsorted = bucketActiveMs([at(9, 9), at(9), at(9, 5)])
check(
  'stamps out of order are sorted, not treated as negative gaps',
  unsorted.get(dayKey(at(9))) === 9 * MIN,
  String(unsorted.get(dayKey(at(9))))
)

console.log('\nlines written')

check(
  'Write counts every line of its content',
  editLineCount('Write', { file_path: '/a.ts', content: 'one\ntwo\nthree' }) === 3
)
check(
  'Edit counts the lines it puts in, not the ones it took out',
  editLineCount('Edit', { file_path: '/a.ts', old_string: 'a\nb\nc\nd', new_string: 'x\ny' }) === 2
)
check(
  'a tool with no file_path counts nothing, however much text it carries',
  editLineCount('Bash', { command: 'echo one\necho two' }) === 0
)
check(
  'an empty write is one line, not zero - the file still changed',
  editLineCount('Write', { file_path: '/a.ts', content: '' }) === 1
)
check('a read is not an edit', editLineCount('Read', { file_path: '/a.ts' }) === 0)
check(
  'an edit tool with no path counts nothing, so a malformed call cannot inflate a day',
  editLineCount('Write', { content: 'a\nb' }) === 0
)
check('the file path comes back for an edit', editFilePath({ file_path: '/a.ts' }) === '/a.ts')
check('and is null when absent', editFilePath({ command: 'ls' }) === null)
check('an empty path is null, not an empty-string file', editFilePath({ file_path: '' }) === null)

console.log('\nreading a transcript')

const dir = mkdtempSync(join(tmpdir(), 'stoke-activity-'))
const write = (name: string, lines: unknown[]): string => {
  const file = join(dir, name)
  writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8')
  return file
}
const iso = (h: number, m = 0): string => new Date(2026, 7, 25, h, m, 0, 0).toISOString()
const entry = (timestamp: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'assistant',
  timestamp,
  ...extra
})
const toolUse = (
  timestamp: string,
  name: string,
  input: Record<string, unknown>
): Record<string, unknown> => entry(timestamp, { message: { content: [{ type: 'tool_use', name, input }] } })

const oneDay = write('one.jsonl', [
  { type: 'summary', aiTitle: 'Vic Aluminium CRM job tracking' },
  entry(iso(9)),
  toolUse(iso(9, 4), 'Write', { file_path: '/x/a.ts', content: 'a\nb\nc' }),
  toolUse(iso(9, 8), 'Edit', { file_path: '/x/b.ts', old_string: 'q', new_string: 'r\ns' })
])

const slices = await readSessionActivity({
  sessionId: 's1',
  file: oneDay,
  project: 'Laro',
  title: null
})
check('one day yields one slice', slices.length === 1, String(slices.length))
check(
  'the title is read out of the transcript when the caller has none',
  slices[0]?.title === 'Vic Aluminium CRM job tracking',
  String(slices[0]?.title)
)
check('active time is the summed gaps', slices[0]?.activeMs === 8 * MIN, String(slices[0]?.activeMs))
check('lines are the edit tools summed', slices[0]?.linesWritten === 5, String(slices[0]?.linesWritten))
check('files are de-duplicated', slices[0]?.files.length === 2, JSON.stringify(slices[0]?.files))
check('the project comes through', slices[0]?.project === 'Laro')

/*
 * A session that runs past midnight. The real ItemProcessor transcript spans
 * six days, so booking a whole overnight stretch to one day is not a corner
 * case here - it is the common shape.
 */
const overnight = write('overnight.jsonl', [
  entry(new Date(2026, 7, 25, 23, 50).toISOString()),
  entry(new Date(2026, 7, 25, 23, 55).toISOString()),
  entry(new Date(2026, 7, 26, 0, 3).toISOString()),
  entry(new Date(2026, 7, 26, 0, 8).toISOString())
])
const spanning = await readSessionActivity({
  sessionId: 's2',
  file: overnight,
  project: 'Laro',
  title: null
})
check('a session crossing midnight is split across two days', spanning.length === 2, String(spanning.length))
/*
 * The gap that straddles midnight (23:55 -> 00:03) is booked whole to the day
 * it began in, so the 25th gets 5 + 8 and the 26th gets only its own 5. That
 * is a deliberate simplification rather than an oversight: splitting a gap at
 * midnight would be more precise, and the error it avoids is bounded above by
 * IDLE_GAP_MS per crossing - at most 15 minutes, once a night. Every other gap
 * after midnight is attributed to the 26th correctly, because each is measured
 * from its own start.
 */
check(
  'the straddling gap is booked whole to the day it started in',
  spanning.find((s) => s.day === '2026-08-25')?.activeMs === 13 * MIN,
  JSON.stringify(spanning.map((s) => [s.day, s.activeMs]))
)
check(
  'and the new day keeps its own gaps rather than losing them to the old one',
  spanning.find((s) => s.day === '2026-08-26')?.activeMs === 5 * MIN,
  JSON.stringify(spanning.map((s) => [s.day, s.activeMs]))
)

const empty = write('empty.jsonl', [])
check(
  'an empty transcript yields nothing and does not throw',
  (await readSessionActivity({ sessionId: 's3', file: empty, project: 'Laro', title: null })).length === 0
)

const junk = join(dir, 'junk.jsonl')
writeFileSync(junk, 'not json at all\n' + JSON.stringify(toolUse(iso(10), 'Write', { file_path: '/x/c.ts', content: 'z' })) + '\n', 'utf8')
const survived = await readSessionActivity({ sessionId: 's4', file: junk, project: 'Laro', title: null })
check(
  'an unparseable line is skipped rather than failing the whole read',
  survived.length === 1 && survived[0].linesWritten === 1,
  JSON.stringify(survived)
)

/*
 * The caller's own title wins. listSessions already knows it, so the regex
 * scan is a fallback for a transcript Stoke has not indexed, never an override.
 */
const titled = await readSessionActivity({
  sessionId: 's5',
  file: oneDay,
  project: 'Laro',
  title: 'A title the caller already had'
})
check("the caller's title is not overwritten", titled[0]?.title === 'A title the caller already had')

console.log('\nmany sessions at once')

const many = await readActivity([
  { sessionId: 's1', file: oneDay, project: 'Laro', title: null },
  { sessionId: 's3', file: empty, project: 'oseo', title: null },
  { sessionId: 'gone', file: join(dir, 'does-not-exist.jsonl'), project: 'ghost', title: null }
])
check('a missing transcript is counted, not thrown', many.skipped === 1, String(many.skipped))
check('and the readable ones still come back', many.slices.length === 1, String(many.slices.length))

const windowed = await readActivity([{ sessionId: 's1', file: oneDay, project: 'Laro', title: null }], {
  from: new Date(2026, 7, 26).getTime(),
  to: new Date(2026, 7, 27).getTime()
})
check('a period that excludes the work returns nothing', windowed.slices.length === 0)

const inWindow = await readActivity([{ sessionId: 's1', file: oneDay, project: 'Laro', title: null }], {
  from: new Date(2026, 7, 25).getTime(),
  to: new Date(2026, 7, 25).getTime()
})
check('a single-day period includes that day', inWindow.slices.length === 1, String(inWindow.slices.length))

/*
 * The pre-filter. A transcript last written before the period began cannot
 * hold an entry inside it, so it is never opened - which is what keeps "today"
 * from parsing every transcript on the disk.
 */
const stale = await readActivity(
  [{ sessionId: 's1', file: oneDay, project: 'Laro', title: null, modified: new Date(2026, 6, 1).getTime() }],
  { from: new Date(2026, 7, 25).getTime(), to: new Date(2026, 7, 25).getTime() }
)
check('a transcript older than the period is skipped without being read', stale.slices.length === 0)
check('and skipping it is not counted as a failure', stale.skipped === 0, String(stale.skipped))

clearActivityCache()

rmSync(dir, { recursive: true, force: true })

console.log(failed === 0 ? '\nall pass' : `\n${failed} failure(s)`)
process.exitCode = failed === 0 ? 0 : 1
