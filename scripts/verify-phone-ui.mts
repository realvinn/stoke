/*
 * The phone UI's decisions (src/shared/phoneUi.ts), without a DOM.
 *
 * Every case is a defect the phone-ux audit observed: rows that could not say
 * which session needs you (PX-2), no one-tap answers (PX-12), a pty resized by
 * every keyboard and composer change (PX-5), a message typed while offline
 * thrown away (PX-3), a bare 401 page (PX-14), a transcript of one block per
 * tool call (PX-15), a project picker of 61 unsorted cards (PX-11).
 *
 *   node scripts/verify-phone-ui.mts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readTranscript } from '../src/main/sessionFile.ts'
import {
  GENERIC_ANSWERS,
  INITIAL_SEND_STATE,
  PHONE_MIN_CONTRAST,
  answerChoices,
  cancelQueued,
  collapseTurns,
  interruptionNote,
  toolOutcome,
  toolsLabel,
  decideResize,
  connectCopy,
  desktopFont,
  fontToFit,
  scrollToColumn,
  groupProjects,
  groupSessionRows,
  isTerminalReport,
  middleTruncate,
  modeFromScreen,
  parseAnswerOptions,
  parseConnectInput,
  phoneTermContrast,
  plural,
  relativeTime,
  sendLost,
  sendReady,
  splitMarkdown,
  statusPill,
  submitText,
  type ResizeInput
} from '../src/shared/phoneUi.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

/* ------------------------------------------------------------------ */
console.log('\nthe list: sections in attention order (PX-2)')

const row = (id: string, status: 'waiting' | 'busy' | 'idle' | 'ended' | 'unknown', lastActivityAt: number | null) => ({
  id,
  status,
  lastActivityAt
})
const sections = groupSessionRows([
  row('idle-old', 'idle', 10),
  row('ended', 'ended', 99),
  row('busy', 'busy', 20),
  row('wait-old', 'waiting', 5),
  row('codex', 'unknown', 50),
  row('wait-new', 'waiting', 30),
  row('idle-new', 'idle', 40)
])
check(
  'waiting first, then working, idle (with the agents Stoke cannot read), ended last',
  sections.map((s) => [s.label, s.rows.map((r) => r.id)]),
  [
    ['Needs you', ['wait-new', 'wait-old']],
    ['Working', ['busy']],
    ['Idle', ['idle-new', 'idle-old', 'codex']],
    ['Ended', ['ended']]
  ]
)
check('an empty list has no sections, not four empty headings', groupSessionRows([]), [])
check('a permission wait reads as Permission', statusPill('waiting', 'permission prompt'), { label: 'Permission', tone: 'waiting' })
check(
  'a fresh browser opened with a refused ?k= is told the link key is not current (phone QA)',
  connectCopy({ linkKey: true, connectedBefore: false }).title,
  'This link’s key isn’t current'
)
check('one that connected before and has no ?k= hears it was replaced', connectCopy({ linkKey: false, connectedBefore: true }).title, 'Your key was replaced')
check('a plain first visit is the plain Connect page', connectCopy({ linkKey: false, connectedBefore: false }).title, 'Connect to your computer')
check('while the socket is reconnecting, a stale Idle reads Offline', statusPill('idle', null, true), { label: 'Offline', tone: 'unknown' })
check('and a stale Working too', statusPill('busy', null, true).label, 'Offline')
check('an ended session stays Ended through a drop', statusPill('ended', null, true).label, 'Ended')
check(
  'an unrecognised wait says Needs you, never the raw 200-char string',
  statusPill('waiting', 'x'.repeat(200)).label,
  'Needs you'
)
check('busy is Working', statusPill('busy', null).label, 'Working')
check('an agent with no registry is Running, not Idle', statusPill('unknown', null).label, 'Running')

/* ------------------------------------------------------------------ */
console.log('\nanswer options read off the screen (PX-12)')

const createFile = [
  ' Create file',
  ' hello.txt',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  '  1 hi',
  '╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌',
  ' Do you want to create hello.txt?',
  ' ❯ 1. Yes',
  '   2. Yes, and switch to accept edits (auto-approve file',
  '      edits and common file commands) for this session',
  '      (shift+tab)',
  '   3. No',
  '',
  ' Esc to cancel · Tab to amend'
]
check('the audit screenshot p13: three options, the wrapped one joined, the cursor on 1', parseAnswerOptions(createFile, Math.max(...createFile.map((l) => l.length))), {
  question: 'Do you want to create hello.txt?',
  options: [
    { key: '1', label: 'Yes', selected: true },
    {
      key: '2',
      label: 'Yes, and switch to accept edits (auto-approve file edits and common file commands) for this session (shift+tab)',
      selected: false
    },
    { key: '3', label: 'No', selected: false }
  ]
})
check(
  'the plan dialog: a two-row question joined, and the hint under option 3 is not part of its label',
  parseAnswerOptions(
    [
      '  Claude has written up a plan and is ready to',
      '  execute. Would you like to proceed?',
      '',
      '  ❯ 1. Yes, and use auto mode',
      '    2. Yes, manually approve edits',
      '    3. Tell Claude what to change',
      '       shift+tab to approve with this feedback',
      '',
      '  ctrl+g to edit in Vim'
    ],
    50
  ),
  {
    question: 'Claude has written up a plan and is ready to execute. Would you like to proceed?',
    options: [
      { key: '1', label: 'Yes, and use auto mode', selected: true },
      { key: '2', label: 'Yes, manually approve edits', selected: false },
      { key: '3', label: 'Tell Claude what to change', selected: false }
    ]
  }
)
check(
  'the diff line "1 hi" above is not option 1 (no dot)',
  parseAnswerOptions(['  1 hi', '  2 there'])?.options.length ?? 0,
  0
)
check(
  'a boxed dialog: the │ edges are not part of the label',
  parseAnswerOptions([
    '│ Would you like to proceed?          │',
    '│ ❯ 1. Yes, and auto-accept edits     │',
    '│   2. Yes, and manually approve edits│',
    '│   3. No, keep planning              │'
  ]),
  {
    question: 'Would you like to proceed?',
    options: [
      { key: '1', label: 'Yes, and auto-accept edits', selected: true },
      { key: '2', label: 'Yes, and manually approve edits', selected: false },
      { key: '3', label: 'No, keep planning', selected: false }
    ]
  }
)
check(
  'the LAST run of 1, 2, … wins: an answered prompt above the live one is ignored',
  parseAnswerOptions([
    'Old question?',
    '  1. Stale yes',
    '  2. Stale no',
    '● did the thing',
    'New question?',
    '❯ 1. Fresh yes',
    '  2. Fresh no'
  ])?.options.map((o) => o.label),
  ['Fresh yes', 'Fresh no']
)
check('a numbered list in prose that skips a number is not a prompt', parseAnswerOptions(['1. a', '3. c']), null)
check('one option is not a choice', parseAnswerOptions(['Continue?', '❯ 1. Yes']), null)
check('nothing numbered: null, so the tray falls back to generic keys', parseAnswerOptions(['hello', 'world']), null)
check(
  'the generic fallback is numbers with no meaning: 3 is "tell Claude what to change" in a plan dialog and absent in a two-option one',
  GENERIC_ANSWERS.map((a) => a.label),
  ['1', '2', '3']
)

check(
  'the shift-tab key reads the mode off the footer, newest line first',
  [
    modeFromScreen(['⏵⏵ auto mode on (shift+tab to cycle) · ← 1 agent']),
    modeFromScreen(['⏸ manual mode on · ← 1 agent']),
    modeFromScreen(['⏸ plan mode on (shift+tab to cycle)']),
    modeFromScreen(['⏵⏵ accept edits on (shift+tab to cycle)']),
    modeFromScreen(['> hello'])
  ],
  ['Auto', 'Ask', 'Plan', 'Edits', null]
)

/* ------------------------------------------------------------------ */
console.log('\nthe phone never answers replayed terminal queries')

check(
  'replies xterm generates on a history replay are reports (measured on the wire over CDP)',
  ['\u001b[?1;2c', '\u001b]11;rgb:f6f6/f3f3/f2f2\u001b\\', '\u001b[O', '\u001b[I', '\u001b[12;40R', '\u001b[?2004;1$y', '\u001bP>|xterm.js(6.0.0)\u001b\\'].map(
    isTerminalReport
  ),
  [true, true, true, true, true, true, true]
)
check(
  'keys a person types are not',
  ['a', 'hello', '\r', '\u001b', '\u001b[A', '\u001b[Z', '\u0003', '\u001b[200~pasted\u001b[201~'].map(isTerminalReport),
  [false, false, false, false, false, false, false, false]
)

/* ------------------------------------------------------------------ */
console.log('\nresizing the pty (PX-5, F2)')

const base: ResizeInput = {
  layout: 'fit',
  reason: 'observe',
  width: 382,
  fitWidth: 382,
  cellWidth: 7.2,
  proposed: { cols: 52, rows: 40 },
  pty: { cols: 52, rows: 41 },
  desktop: { cols: 100, rows: 30 },
  composerFocused: false,
  resized: true
}
check(
  'the composer growing a line (height only) sends nothing',
  decideResize({ ...base, proposed: { cols: 52, rows: 38 } }).send,
  null
)
check(
  'the soft keyboard (composer focused) sends nothing and asks again on blur',
  (({ send, deferred }) => ({ send, deferred }))(decideResize({ ...base, width: 700, composerFocused: true })),
  { send: null, deferred: true }
)
check(
  'a sub-cell width wobble sends nothing',
  decideResize({ ...base, width: 386 }).send,
  null
)
check(
  'rotation (a real width change) refits columns AND measures rows then',
  decideResize({ ...base, width: 820, proposed: { cols: 112, rows: 18 } }).send,
  { cols: 112, rows: 18 }
)
check(
  'choosing Fit to phone sends even while the composer has focus',
  decideResize({ ...base, reason: 'toggle', fitWidth: null, composerFocused: true, resized: false, pty: { cols: 100, rows: 30 } }).send,
  { cols: 52, rows: 40 }
)
check(
  'the first attach in fit mode fits',
  decideResize({ ...base, reason: 'attach', fitWidth: null, resized: false, pty: { cols: 100, rows: 30 } }).send,
  { cols: 52, rows: 40 }
)
check(
  'a tiny box never asks for fewer than 20 columns',
  decideResize({ ...base, reason: 'attach', fitWidth: null, proposed: { cols: 9, rows: 3 } }).send,
  { cols: 20, rows: 8 }
)
check(
  'leaving fit puts the DESKTOP size back (desktopCols/Rows), not the phone-sized pty (F2)',
  decideResize({ ...base, layout: 'desktop', reason: 'toggle' }),
  { send: { cols: 100, rows: 30 }, local: { cols: 100, rows: 30 }, fitWidth: null, deferred: false }
)
check(
  'desktop layout on a client that never resized: renders the desktop size, sends nothing',
  decideResize({ ...base, layout: 'desktop', reason: 'attach', resized: false, pty: { cols: 100, rows: 30 } }),
  { send: null, local: { cols: 100, rows: 30 }, fitWidth: null, deferred: false }
)
check(
  'a laptop browser (native) never resizes, whatever the box does (PX-16)',
  decideResize({ ...base, layout: 'native', resized: false, reason: 'observe', width: 1400, pty: { cols: 120, rows: 40 } }),
  { send: null, local: { cols: 120, rows: 40 }, fitWidth: null, deferred: false }
)
check('100 columns into 382px at 0.6 is a 6px font: clamped up to the 7px floor', fontToFit(382, 100, 0.6, 7, 12), 7)
check('100 columns into 800px fits at 13px', fontToFit(800, 100, 0.6, 7, 14), 13)
// Phone QA: "Desktop size" at 390x844 drew 100 columns at ~4.2px per column.
check('Desktop size on a 390px phone floors at a readable 10px and scrolls sideways', desktopFont(382, 100, 0.6, 12), 10)
check('in landscape (722px) it still fits the grid whole', desktopFont(722, 100, 0.6, 12), 12)
check('a user who chose a smaller Text size keeps it', desktopFont(382, 100, 0.6, 9), 9)
check('the cursor already in view does not move the scroll', scrollToColumn(100, 6, 382, 0), 0)
check('a cursor past the right edge is brought to the middle', scrollToColumn(540, 6, 382, 0), 352)
check('never a negative scroll', scrollToColumn(0, 6, 382, 200), 0)

/* ------------------------------------------------------------------ */
console.log('\na send while disconnected is queued, never lost (PX-3)')

let s = INITIAL_SEND_STATE
let r = submitText(s, 'typed while offline', 1)
check('not attached: nothing sent, one queued', [r.send, r.state.queue.map((q) => q.text)], [null, ['typed while offline']])
s = r.state
r = submitText(s, 'and a second', 2)
s = r.state
check('a second queues behind it', s.queue.map((q) => q.text), ['typed while offline', 'and a second'])
const cancelled = cancelQueued(s, s.queue[1].id)
check('a queued message can be taken back', cancelled.queue.map((q) => q.text), ['typed while offline'])
const flushed = sendReady(s)
check('attached again: flushed oldest first, queue empty', [flushed.flush, flushed.state.queue.length, flushed.state.ready], [
  ['typed while offline', 'and a second'],
  0,
  true
])
check('attached with nothing queued: sent straight away', submitText(flushed.state, 'hi', 3).send, 'hi')
check('whitespace is not a message', submitText(flushed.state, '   ', 3), { state: flushed.state, send: null })
check('the socket dropping stops direct sends', submitText(sendLost(flushed.state), 'x', 4).send, null)

/* ------------------------------------------------------------------ */
console.log('\nthe Connect screen (PX-14)')

const origin = 'http://127.0.0.1:7922'
check('a bare key', parseConnectInput('  PhoneQaTestToken1234567890AB ', origin), { kind: 'key', key: 'PhoneQaTestToken1234567890AB' })
check(
  'the whole link, same machine',
  parseConnectInput('http://127.0.0.1:7922/?k=PhoneQaTestToken1234567890AB', origin),
  { kind: 'link', key: 'PhoneQaTestToken1234567890AB', url: 'http://127.0.0.1:7922/?k=PhoneQaTestToken1234567890AB', sameOrigin: true }
)
check(
  'a link to another address is still a link, flagged as elsewhere',
  (parseConnectInput('http://192.168.1.2:7922/?k=PhoneQaTestToken1234567890AB', origin) as { sameOrigin: boolean }).sameOrigin,
  false
)
check('a link with no key says so', parseConnectInput('http://127.0.0.1:7922/', origin).kind, 'invalid')
check('a javascript: URL is refused', parseConnectInput('javascript:alert(1)//?k=PhoneQaTestToken1234567890AB', origin).kind, 'invalid')
check('empty', parseConnectInput('', origin).kind, 'invalid')

/* ------------------------------------------------------------------ */
console.log('\nthe transcript (PX-15)')

const t = (role: 'user' | 'assistant', text: string, tools: string[] = [], at: number | null = null) => ({ role, text, tools, at })
check(
  'a run of tool-only turns becomes one line, counted by tool',
  collapseTurns([
    t('user', 'go'),
    t('assistant', '', ['Bash']),
    t('assistant', '', ['Read', 'Bash']),
    t('assistant', '', ['Bash'], 9),
    t('assistant', 'done')
  ]).map((i) => (i.kind === 'tools' ? `tools:${i.count}:${i.summary}:${i.at}` : `${i.turn.role}:${i.turn.text}`)),
  ['user:go', 'tools:4:Bash ×3, Read:9', 'assistant:done']
)
check('a turn with text keeps its own block', collapseTurns([t('assistant', 'hi', ['Bash'])]).length, 1)
// Phone QA: a rejected Write read "Ran 1 tool · Write" like the ones that ran,
// and "[Request interrupted by user for tool use]" was a YOU bubble.
const REJECTED =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file)."
check('a rejected tool_result is declined', toolOutcome(true, REJECTED), 'declined')
check('as an array of text blocks too', toolOutcome(true, [{ type: 'text', text: REJECTED }]), 'declined')
check('any other error is failed', toolOutcome(true, 'Error: ENOENT'), 'failed')
check('no error is ran', toolOutcome(undefined, 'ok'), 'ran')
check(
  'a run with one declined tool says so',
  (() => {
    const i = collapseTurns([{ ...t('assistant', '', ['Write']), toolStates: ['declined' as const] }])[0]
    return i.kind === 'tools' ? toolsLabel(i.count, i.declined, i.failed) : null
  })(),
  'Declined 1 tool'
)
check('mixed: "Ran 2 tools · 1 declined"', toolsLabel(3, 1, 0), 'Ran 2 tools · 1 declined')
check('all failed', toolsLabel(2, 0, 2), '2 tools failed')
check('the tool-use interruption marker is a note', interruptionNote('[Request interrupted by user for tool use]'), 'Stopped — tool declined')
check('the plain one too', interruptionNote('[Request interrupted by user]'), 'Stopped by you')
check('real speech is not', interruptionNote('[Request] please'), null)
check('a note turn survives collapsing', collapseTurns([{ ...t('user', ''), note: 'Stopped by you' }]).length, 1)
check('an empty turn is dropped', collapseTurns([t('assistant', '  ')]).length, 0)
check(
  'fences and inline code, everything else literal',
  splitMarkdown('run `npm test` then:\n```sh\nnpm run check\n```\n<b>not html</b>'),
  [
    { kind: 'text', text: 'run ' },
    { kind: 'code', text: 'npm test' },
    { kind: 'text', text: ' then:\n' },
    { kind: 'fence', lang: 'sh', text: 'npm run check' },
    { kind: 'text', text: '\n<b>not html</b>' }
  ]
)
check('an unclosed fence runs to the end', splitMarkdown('```\nabc'), [{ kind: 'fence', lang: '', text: 'abc' }])

/* ------------------------------------------------------------------ */
console.log('\ncopy and the project picker (PX-11, PX-24)')

check('"1 session", not "1 sessions"', [plural(1, 'session'), plural(2, 'session')], ['1 session', '2 sessions'])
check('relative time', [relativeTime(1000, 1000 + 30_000), relativeTime(0, 5), relativeTime(1, 1 + 3 * 3600_000)], [
  'just now',
  '',
  '3h ago'
])
check('a long path keeps both ends', middleTruncate('/Users/me/dev/personal/some/deep/project', 24), '/Users/me/de…eep/project')
check('a short path is untouched', middleTruncate('/tmp/a', 24), '/tmp/a')
const now = 30 * 86_400_000
const projects = [
  { path: '/a', name: 'alpha', pinned: false, lastActivityAt: now - 86_400_000, sessionCount: 1 },
  { path: '/b', name: 'beta', pinned: true, lastActivityAt: null, sessionCount: 0 },
  { path: '/c', name: 'charlie', pinned: false, lastActivityAt: now - 20 * 86_400_000, sessionCount: 3 },
  { path: '/z', name: 'zulu', pinned: false, lastActivityAt: now - 3600_000, sessionCount: 2 }
]
check(
  'pinned, then the last 7 days newest first, then everything else by name',
  groupProjects(projects, '', now).map((g) => [g.label, g.rows.map((p) => p.name)]),
  [
    ['Pinned', ['beta']],
    ['Recent', ['zulu', 'alpha']],
    ['All projects', ['charlie']]
  ]
)
check(
  'search matches name or path',
  groupProjects(projects, 'CHAR', now).flatMap((g) => g.rows.map((p) => p.name)),
  ['charlie']
)

/*
 * Review of PX-12: the list drew tappable numbers before its read of the
 * screen had finished, and for good when that read failed — a tap on a
 * question nobody on the phone had seen.
 */
console.log('\nlist answers wait for the question')
{
  const reading = answerChoices(null, 'reading')
  check('while reading: numbers drawn but held', [reading.enabled, reading.options.map((o) => o.key)], [false, ['1', '2', '3']])
  check('and it says why', reading.note !== null, true)
  const plan = {
    question: 'Would you like to proceed?',
    options: [
      { key: '1', label: 'Yes, and use auto mode', selected: true },
      { key: '2', label: 'Yes, manually approve edits', selected: false },
      { key: '3', label: 'Tell Claude what to change', selected: false },
      { key: '4', label: 'Keep planning', selected: false }
    ]
  }
  const read = answerChoices(plan, 'read')
  check('read: the real labels, up to 3, tappable, no note', [read.enabled, read.options.map((o) => o.label), read.note], [
    true,
    ['Yes, and use auto mode', 'Yes, manually approve edits', 'Tell Claude what to change'],
    null
  ])
  const failed = answerChoices(null, 'failed')
  check('read failed: bare numbers offered, with a note saying so', [failed.enabled, failed.options.map((o) => o.label), failed.note !== null], [
    true,
    ['1', '2', '3'],
    true
  ])
  check('the generic labels claim no meaning', GENERIC_ANSWERS.every((o) => o.label === o.key), true)
}

/*
 * PX-21: history replayed onto a phone can carry colours picked for another
 * background; the phone's terminal never drops under its contrast floor, and
 * keeps a stronger desktop choice.
 */
console.log('\nphone terminal contrast')
check('the desktop default (1) is lifted to the floor', phoneTermContrast(1), PHONE_MIN_CONTRAST)
check('a stronger desktop choice is kept', phoneTermContrast(7), 7)
check('nothing sent (an older desktop): the floor', phoneTermContrast(undefined), PHONE_MIN_CONTRAST)
check('garbage is not a ratio', phoneTermContrast('4.5'), PHONE_MIN_CONTRAST)
check('never past 21:1', phoneTermContrast(99), 21)

/*
 * The same, end to end through readTranscript, on a file this suite writes in
 * its own temp folder (gotcha 74: synthetic input, synthetic path).
 */
{
  const dir = await mkdtemp(join(tmpdir(), 'stoke-phone-ui-'))
  const file = join(dir, 'fixture.jsonl')
  const rec = (o: Record<string, unknown>) => JSON.stringify({ timestamp: '2026-09-19T10:00:00Z', ...o })
  await writeFile(
    file,
    [
      rec({ type: 'user', message: { role: 'user', content: 'write three files' } }),
      rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Write', input: {} }] } }),
      rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'File created' }] } }),
      rec({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Write', input: {} }] } }),
      rec({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: REJECTED }] } }),
      rec({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } })
    ].join('\n') + '\n'
  )
  const tr = await readTranscript(file)
  const items = collapseTurns(tr.turns)
  check(
    'readTranscript: the declined Write is counted as declined, and the marker is a note, not a YOU turn',
    items.map((i) => (i.kind === 'tools' ? toolsLabel(i.count, i.declined, i.failed) : i.turn.note ?? `${i.turn.role}:${i.turn.text}`)),
    ['user:write three files', 'Ran 1 tool · 1 declined', 'Stopped — tool declined']
  )
  await rm(dir, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
