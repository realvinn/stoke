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
import {
  GENERIC_ANSWERS,
  INITIAL_SEND_STATE,
  cancelQueued,
  collapseTurns,
  decideResize,
  fontToFit,
  groupProjects,
  groupSessionRows,
  isTerminalReport,
  middleTruncate,
  modeFromScreen,
  parseAnswerOptions,
  parseConnectInput,
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
  'the generic fallback names only what holds for every dialog: 1 accepts, 3 declines',
  GENERIC_ANSWERS.map((a) => a.label),
  ['Yes', '2', 'No']
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

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
