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
  BROWSE_LABEL,
  breadcrumb,
  newFolderHint,
  newFolderNameProblem,
  phonePickerGroups,
  groupSessionRows,
  homeSegmentFor,
  keyRowShown,
  recentProjects,
  rowActivity,
  rowMeta,
  rowPillShown,
  runningBadge,
  initialAgent,
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
console.log('\nhome: Running | Recent, and two-line rows (the clean-up)')

// History was a screen of its own behind a second topbar button; it is home's
// Recent segment now, and a project or conversation opened from it keeps Recent lit.
check(
  'home and a session are Running; the old History address, a project and a conversation are Recent',
  ['home', 'session', 'history', 'project', 'transcript', 'nonsense'].map(homeSegmentFor),
  ['running', 'running', 'recent', 'recent', 'recent', 'running']
)
check(
  "Running's badge counts live sessions and the ones waiting, never an ended one",
  runningBadge([{ status: 'waiting' }, { status: 'busy' }, { status: 'waiting' }, { status: 'ended' }, { status: 'unknown' }]),
  { live: 4, needsYou: 2 }
)
check('no rows yet (loading) is no badge, not a crash', runningBadge(null), { live: 0, needsYou: 0 })
// The pill said Working under the Working heading: the same word twice per row.
check(
  'only a prompt kind or an ended session wears a pill; Working/Idle/Running are the heading already',
  (['waiting', 'busy', 'idle', 'unknown', 'ended'] as const).map(rowPillShown),
  [true, false, false, false, true]
)
// A block of its own: `base` is the resize section's name further down.
{
const NOW = 1_800_000_000_000
const base = {
  project: 'api-server',
  host: null as string | null,
  cli: 'claude',
  agentName: 'Claude Code',
  status: 'idle' as 'idle' | 'busy' | 'waiting' | 'ended' | 'unknown',
  lastActivityAt: NOW - 5 * 60_000 as number | null,
  startedAt: NOW - 60 * 60_000,
  endedAt: null as number | null,
  exitCode: null as number | null
}
check('an idle row: the project, then the time since it last did anything', rowMeta(base, NOW), 'api-server · 5m ago')
check(
  'a busy row says only the time: "working" was its heading said again',
  rowMeta({ ...base, status: 'busy', lastActivityAt: NOW - 10_000 }, NOW),
  'api-server · just now'
)
check('no activity yet falls back to when it started', rowActivity({ ...base, lastActivityAt: null }, NOW), '1h ago')
check(
  'an ended row says it ended, and a non-zero exit, because no heading can',
  rowMeta({ ...base, status: 'ended', endedAt: NOW - 2 * 60_000, exitCode: 1 }, NOW),
  'api-server · ended 2m ago · exit 1'
)
check('a clean exit is not called out', rowActivity({ ...base, status: 'ended', endedAt: NOW - 2 * 60_000, exitCode: 0 }, NOW), 'ended 2m ago')
check('an end with no timestamp still reads', rowActivity({ ...base, status: 'ended', endedAt: null, exitCode: null }, NOW), 'ended just now')
check(
  "an SSH row's project is its host already (gotcha 18): it adds ssh, not the host twice",
  rowMeta({ ...base, project: 'build-box', host: 'build-box' }, NOW),
  'build-box · ssh · 5m ago'
)
check('another agent adds its name', rowMeta({ ...base, cli: 'codex', agentName: 'Codex' }, NOW), 'api-server · Codex · 5m ago')
check('an empty project drops out rather than leaving a leading dot', rowMeta({ ...base, project: '' }, NOW), '5m ago')

const projects = [
  { name: 'web', label: 'web', path: '/u/a/web', sessionCount: 3, lastActivityAt: 10 },
  { name: 'web', label: 'web', hint: 'b', path: '/u/b/web', sessionCount: 1, lastActivityAt: 30 },
  { name: 'api', label: 'Api Server', path: '/u/a/api', sessionCount: 2, lastActivityAt: 20 },
  { name: 'fresh', label: 'fresh', path: '/u/a/fresh', sessionCount: 0, lastActivityAt: 99 }
]
check(
  'Recent: projects with a past conversation, newest first; one with none is not listed',
  recentProjects(projects, '').map((p) => p.path),
  ['/u/b/web', '/u/a/api', '/u/a/web']
)
check('the search matches the label the row shows', recentProjects(projects, 'server').map((p) => p.path), ['/u/a/api'])
check('and the folder path, case-blind', recentProjects(projects, '  /U/B ').map((p) => p.path), ['/u/b/web'])
check('a search that matches nothing is an empty list', recentProjects(projects, 'zzz'), [])

/* ------------------------------------------------------------------ */
console.log('\nthe session dock: the key row behind one toggle')

const dock = (over: Partial<Parameters<typeof keyRowShown>[0]> = {}): boolean =>
  keyRowShown({ toggled: null, composerFocused: false, waiting: false, ended: false, ...over })
check('at rest the key row is in: the composer alone', dock(), false)
check('typing brings it out: a soft keyboard has no esc, arrows or shift-tab', dock({ composerFocused: true }), true)
check(
  'a waiting prompt leaves it in: the answer tray replaced it (0d17f6b), and both is a band too many',
  [dock({ waiting: true }), dock({ waiting: true, composerFocused: true })],
  [false, false]
)
check('but the toggle brings it out over a prompt the tray cannot read', dock({ waiting: true, toggled: true }), true)
check('and the toggle closing it while typing is not overruled by the focus', dock({ composerFocused: true, toggled: false }), false)
check('an ended session has no keys, toggled or not', [dock({ ended: true, toggled: true }), dock({ ended: true, composerFocused: true })], [false, false])
}

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
// Measured on the cleaned-up session screen: focus (the key row comes out),
// four lines, blur → {type:'resize'} 50x43 → 50x39. A height change, sent late.
check(
  'a height change while typing is not deferred to the blur: it never counts',
  decideResize({ ...base, composerFocused: true, proposed: { cols: 52, rows: 33 } }),
  { send: null, local: { cols: 52, rows: 41 }, fitWidth: 382, deferred: false }
)
check(
  'and the blur itself, with the width unchanged, sends nothing however short the box got',
  decideResize({ ...base, reason: 'blur', proposed: { cols: 52, rows: 33 } }).send,
  null
)
check(
  'a rotation while typing is deferred, then sent on the blur, rows measured then',
  [
    decideResize({ ...base, width: 820, composerFocused: true, proposed: { cols: 112, rows: 18 } }).deferred,
    decideResize({ ...base, reason: 'blur', width: 820, proposed: { cols: 112, rows: 18 } }).send
  ],
  [true, { cols: 112, rows: 18 }]
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
/*
 * The picker is the desktop switcher's own list (`folderChoices`), so a phone
 * and the desktop offer the same places in the same order. It used to group
 * only the projects the server sent — sixty — so a 61st was unreachable.
 */
console.log('\nthe New session picker: the desktop switcher’s list (phone contract point 11)')
{
  const now = 30 * 86_400_000
  const row = (path: string, name: string, extra: Record<string, unknown> = {}) => ({
    path,
    name,
    label: null,
    pinned: false,
    exists: true,
    sessionCount: 1,
    lastActivityAt: now - 3600_000,
    ...extra
  })
  // Seventy projects, the oldest last: the one past the old 60 cap is `p69`.
  const many = Array.from({ length: 70 }, (_, i) => row(`/Users/v/dev/p${i}`, `p${i}`, { lastActivityAt: now - i * 60_000 }))
  const hosts = [{ id: 'h1', label: 'Box', alias: 'box' }]
  const base = { defaultCwd: '/Users/v/dev', hosts, query: '', platform: 'darwin' }
  const groups = phonePickerGroups({ ...base, projects: many })
  const shape = (gs: ReturnType<typeof phonePickerGroups>) => gs.map((g) => [g.title, g.items.map((c) => c.kind)])
  check(
    'Recent projects (eight), Elsewhere (Default, Scratch), Remote machines, then Browse',
    shape(groups),
    [
      ['Recent projects', Array(8).fill('project')],
      ['Elsewhere', ['default', 'scratch']],
      ['Remote machines', ['host']],
      ['', ['open']]
    ]
  )
  check('newest first, as the desktop ranks them', groups[0].items.slice(0, 2).map((c) => (c as { label: string }).label), ['p0', 'p1'])
  check('the desktop’s “Open folder…” is Browse on a phone', groups.at(-1)?.items[0], { kind: 'open', label: BROWSE_LABEL })
  check(
    'a search reaches the project past the old cap of sixty',
    phonePickerGroups({ ...base, projects: many, query: 'p69' })[0]?.items.map((c) => (c as { path: string }).path),
    ['/Users/v/dev/p69']
  )
  check(
    'pinned first, then most recent',
    phonePickerGroups({
      ...base,
      projects: [row('/a/x', 'x', { lastActivityAt: now }), row('/a/y', 'y', { pinned: true, lastActivityAt: now - 86_400_000 })]
    })[0].items.map((c) => (c as { label: string }).label),
    ['y', 'x']
  )
  check(
    'a label wins over the folder name, and two same-named projects get a hint',
    phonePickerGroups({
      ...base,
      projects: [row('/Users/v/work/app', 'app'), row('/Users/v/personal/app', 'app'), row('/Users/v/x', 'x', { label: 'Bench' })]
    })[0].items.map((c) => [(c as { label: string }).label, (c as { hint: string }).hint]),
    [
      ['app', 'work'],
      ['app', 'personal'],
      ['Bench', '']
    ]
  )
  check(
    'the default folder is listed once, as the default — /private spelling included',
    shape(
      phonePickerGroups({ ...base, defaultCwd: '/tmp/d', projects: [row('/private/tmp/d', 'd'), row('/tmp/e', 'e')] })
    ),
    [
      ['Recent projects', ['project']],
      ['Elsewhere', ['default', 'scratch']],
      ['Remote machines', ['host']],
      ['', ['open']]
    ]
  )
  check(
    'a missing folder is offered but marked, as on the desktop',
    (phonePickerGroups({ ...base, projects: [row('/a/gone', 'gone', { exists: false })] })[0].items[0] as { missing: boolean }).missing,
    true
  )
  check(
    'no match: Browse is still there, the way out',
    shape(phonePickerGroups({ ...base, projects: many, query: 'zzz-nothing' })),
    [['', ['open']]]
  )
  check(
    'a host is found by its alias too',
    shape(phonePickerGroups({ ...base, projects: [], query: 'box' })),
    [
      ['Remote machines', ['host']],
      ['', ['open']]
    ]
  )
  check(
    'an older desktop (no label, no hosts) still lists',
    shape(
      phonePickerGroups({
        ...base,
        hosts: [],
        projects: [{ path: '/a/q', name: 'q', pinned: false, exists: true, sessionCount: 0, lastActivityAt: null }]
      })
    ),
    [
      ['Recent projects', ['project']],
      ['Elsewhere', ['default', 'scratch']],
      ['', ['open']]
    ]
  )
}

console.log('\nthe Browse breadcrumb starts at the place, never above it')
{
  check('at the place itself: one crumb', breadcrumb('/Users/v/dev', '/Users/v/dev'), [{ label: 'dev', path: '/Users/v/dev' }])
  check('two folders down', breadcrumb('/Users/v/dev/work/app', '/Users/v/dev'), [
    { label: 'dev', path: '/Users/v/dev' },
    { label: 'work', path: '/Users/v/dev/work' },
    { label: 'app', path: '/Users/v/dev/work/app' }
  ])
  check('a trailing separator changes nothing', breadcrumb('/Users/v/dev/work/', '/Users/v/dev/'), [
    { label: 'dev', path: '/Users/v/dev' },
    { label: 'work', path: '/Users/v/dev/work' }
  ])
  check('a Windows desktop', breadcrumb('C:\\Users\\v\\dev\\app', 'C:\\Users\\v\\dev'), [
    { label: 'dev', path: 'C:\\Users\\v\\dev' },
    { label: 'app', path: 'C:\\Users\\v\\dev\\app' }
  ])
  check('a sibling that only shares a prefix is not under the place', breadcrumb('/Users/v/dev-old/x', '/Users/v/dev'), [
    { label: 'x', path: '/Users/v/dev-old/x' }
  ])
}

console.log('\nNew folder names (one segment, what every desktop OS can hold)')
{
  check('a plain name is fine', newFolderNameProblem('my-app'), null)
  check('spaces inside are fine, and the ends are trimmed', newFolderNameProblem('  side project  '), null)
  check('empty says so', newFolderNameProblem('   '), 'Give the folder a name.')
  const refused = ['a/b', 'a\\b', '..', '.', '.hidden', 'con', 'LPT1.txt', 'a:b', 'what?', 'ends.', 'tab\there', 'x'.repeat(121)]
  check(
    'a separator, . or .., a dot-name, a Windows-reserved name or character, a control character, too long: each refused',
    refused.filter((n) => newFolderNameProblem(n) === null),
    []
  )
  check('the field says nothing while it is empty', newFolderHint(''), null)
  check('and says why as soon as a name will not do', newFolderHint('a/b'), 'A folder name cannot contain / or \\.')
  check('a non-string (a crafted body) is refused, not thrown on', newFolderNameProblem(42), 'Give the folder a name.')
}

/*
 * The New session sheet used to open on `agents[0]` — Claude Code by table
 * order — whatever the desktop's default agent was.
 */
console.log("\nthe New session sheet's agent (defaults.cli)")
{
  const offered = [{ id: 'claude' }, { id: 'codex' }, { id: 'grok' }]
  check("opens on the desktop's default agent", initialAgent(offered, 'codex'), 'codex')
  check('a default the sheet does not offer: the first it does', initialAgent(offered, 'opencode'), 'claude')
  check('an older desktop sends no cli: the first agent, as before', initialAgent(offered, undefined), 'claude')
  check('no Claude on offer: the first agent that is', initialAgent([{ id: 'codex' }, { id: 'pi' }], undefined), 'codex')
  check('nothing on offer at all: Claude Code, never an empty agent', initialAgent([], 'codex'), 'claude')
}

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
