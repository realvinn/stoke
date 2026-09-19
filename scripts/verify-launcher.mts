/*
 * The new-session page: what each launch value resolves to and where it came
 * from, how two projects with one name are told apart, what the folder
 * switcher offers, which conversations are listed, and what a key does.
 *
 *   node scripts/verify-launcher.mts
 *
 * All of it is pure (src/shared/launch.ts, src/shared/launcher.ts). The wire
 * from these functions to the mounted launcher — focus after an overlay, the
 * splash swallowing Enter, the button not moving while sessions load — is a
 * side effect inside a component and is invisible here (gotcha 31); it was
 * driven over CDP against the built app instead.
 */
import {
  MODEL_OPTIONS,
  NO_CLAUDE_DEFAULTS,
  effortForModel,
  modelLabel,
  pruneOverride,
  resolveClaudeDefaults,
  resolveLaunch,
  sessionMode,
  type LaunchChoice
} from '../src/shared/launch.ts'
import {
  choiceKey,
  disambiguate,
  flatChoices,
  folderChoices,
  NO_BURST,
  PRESS_ARM_MS,
  launchAim,
  launcherKey,
  newestConversation,
  nextBurst,
  pickerSections,
  pressAllowed,
  rankProjects,
  selectAllInstalled,
  sessionTitle,
  sessionView,
  type LauncherKeyEvent,
  type ProjectLike
} from '../src/shared/launcher.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}

/* ------------------------------------------------------------ resolution */

console.log('\nClaude Code settings files fold like the CLI folds them')
const user = {
  name: '~/.claude/settings.json',
  values: { model: 'opus[1m]', effortLevel: 'high', permissions: { defaultMode: 'auto' } }
}
const project = { name: '.claude/settings.json', values: { model: 'sonnet' } }
const local = { name: '.claude/settings.local.json', values: { permissions: { defaultMode: 'plan' } } }
const folded = resolveClaudeDefaults([user, project, local])
check('the user file alone gives its three values', resolveClaudeDefaults([user]), {
  permissionMode: 'auto',
  model: 'opus[1m]',
  effort: 'high',
  modelEffort: {},
  from: {
    permissionMode: '~/.claude/settings.json',
    model: '~/.claude/settings.json',
    effort: '~/.claude/settings.json',
    modelEffort: null
  }
})
check('a project file overrides the user file key by key (model)', folded.model, 'sonnet')
check('…and says which file won', folded.from.model, '.claude/settings.json')
check('the local file outranks the project file (mode)', folded.permissionMode, 'plan')
check('a key no later file sets keeps the user value (effort)', folded.effort, 'high')
check(
  'ANTHROPIC_MODEL beats every file for the model',
  resolveClaudeDefaults([user], { ANTHROPIC_MODEL: 'haiku' }).model,
  'haiku'
)
check(
  "a file's env.ANTHROPIC_MODEL beats every file's model",
  [
    resolveClaudeDefaults([user, { name: '.claude/settings.json', values: { env: { ANTHROPIC_MODEL: 'haiku' } } }]).model,
    resolveClaudeDefaults([{ name: 'u', values: { model: 'opus', env: { ANTHROPIC_MODEL: 'fable' } } }, project]).model
  ],
  ['haiku', 'fable']
)
check(
  '…and the inherited variable, since the CLI applies the block over what it inherited',
  resolveClaudeDefaults([{ name: 'u', values: { env: { ANTHROPIC_MODEL: 'sonnet' } } }], { ANTHROPIC_MODEL: 'haiku' }).from.model,
  'u (env.ANTHROPIC_MODEL)'
)
check(
  'an empty or non-string env value is ignored',
  resolveClaudeDefaults([{ name: 'u', values: { model: 'opus', env: { ANTHROPIC_MODEL: '  ' } } }, { name: 'p', values: { env: { ANTHROPIC_MODEL: 3 } } }]).model,
  'opus'
)
check(
  'effortLevel max is dropped, as the CLI drops it (gotcha 39)',
  resolveClaudeDefaults([{ name: 'u', values: { effortLevel: 'max' } }]).effort,
  null
)
check(
  'an unknown defaultMode is not shown',
  resolveClaudeDefaults([{ name: 'u', values: { permissions: { defaultMode: 'yolo' } } }]).permissionMode,
  null
)
check(
  'an unreadable file (null) contributes nothing',
  resolveClaudeDefaults([{ name: 'u', values: null }]),
  NO_CLAUDE_DEFAULTS
)

console.log('\nwhat the launcher says matches what the CLI runs (QA L11)')
const stoke: LaunchChoice = { permissionMode: 'default', model: '', effort: 'default', ultracode: false }
const claude = resolveClaudeDefaults([user])
const plain = resolveLaunch({ override: undefined, stoke, claude })
check('no flag + defaultMode auto reads Auto, not Ask', plain.permissionMode.label, 'Auto')
check('…sourced from Claude Code settings', plain.permissionMode.source, 'claude')
check('no --model + opus[1m] in settings reads Opus 1M', plain.model.label, 'Opus 1M')
check('no --effort + effortLevel high reads High effort', plain.effort.label, 'High effort')
check('Stoke still sends no flags for them', plain.choice, stoke)
const bare = resolveLaunch({ override: undefined, stoke, claude: NO_CLAUDE_DEFAULTS })
check('with no settings files the mode reads Ask, from the CLI', [bare.permissionMode.label, bare.permissionMode.source], ['Ask', 'cli'])
check('…and the model says Default model rather than inventing one', bare.model.label, 'Default model')
const flagged = resolveLaunch({
  override: undefined,
  stoke: { ...stoke, permissionMode: 'plan', model: 'sonnet' },
  claude
})
check('a Stoke default flag beats the settings file', [flagged.permissionMode.label, flagged.permissionMode.source], ['Plan', 'stoke'])
check('…for the model too', [flagged.model.label, flagged.model.source], ['Sonnet', 'stoke'])

console.log('\nper-launch changes stay on this launch (QA L10)')
const once = resolveLaunch({ override: { model: 'haiku' }, stoke, claude })
check('an override is what gets sent', once.choice.model, 'haiku')
check('…is marked as this launch', once.model.source, 'launch')
check('…and as changed from the default', once.model.changed, true)
check('the other keys still resolve normally', once.permissionMode.source, 'claude')
check(
  'an override equal to the default is not "changed"',
  resolveLaunch({ override: { model: '' }, stoke, claude }).model.changed,
  false
)
const ultra = resolveLaunch({ override: { ultracode: true, effort: 'low' }, stoke, claude })
check('ultracode pins effort to Extra high whatever was picked', ultra.effort.label, 'Extra high effort')
check('…and keeps the pick for when it is turned off', ultra.choice.effort, 'low')
check('pruneOverride drops keys equal to the default', pruneOverride({ model: '', effort: 'high' }, stoke), { effort: 'high' })
check('pruneOverride of nothing changed is undefined', pruneOverride({ model: '' }, stoke), undefined)

console.log('\nper-model effort outranks the top-level key (measured: banner said medium)')
{
  // The machine the QA ran on, read-only: effortLevel high, but modelSettings
  // pins claude-opus-5 to medium, and `claude` printed "with medium effort".
  const machine = resolveClaudeDefaults([
    {
      name: '~/.claude/settings.json',
      values: {
        model: 'opus[1m]',
        effortLevel: 'high',
        permissions: { defaultMode: 'auto' },
        modelSettings: { 'claude-opus-5': { effortLevel: 'medium' } }
      }
    }
  ])
  check('modelSettings is read', machine.modelEffort, { 'claude-opus-5': 'medium' })
  const r = resolveLaunch({ override: undefined, stoke, claude: machine })
  check('opus[1m] with opus-5 pinned to medium reads Medium effort, as the banner did', r.effort.label, 'Medium effort')
  check('…and says where it came from', r.effort.settingsFrom, '~/.claude/settings.json (modelSettings.claude-opus-5)')
  const sonnet = resolveLaunch({ override: { model: 'sonnet' }, stoke, claude: machine })
  check('a launch on Sonnet falls back to the top-level High', sonnet.effort.label, 'High effort')
  check('a full id finds its own entry', effortForModel('claude-opus-5[1m]', machine.modelEffort).value, 'medium')
  check(
    'two opus versions that disagree leave the alias unknown',
    effortForModel('opus', { 'claude-opus-5': 'medium', 'claude-opus-4-7': 'high' }),
    { value: null, known: false, key: 'claude-opus-5, claude-opus-4-7' }
  )
  const unknown = resolveLaunch({
    override: undefined,
    stoke,
    claude: resolveClaudeDefaults([
      { name: 'u', values: { effortLevel: 'high', modelSettings: { 'claude-opus-5': { effortLevel: 'low' } } } }
    ])
  })
  check('no model named and per-model entries present: no level is claimed', unknown.effort.label, 'Default effort')
  check('an explicit effort flag beats every file', resolveLaunch({ override: { effort: 'low' }, stoke, claude: machine }).effort.label, 'Low effort')
}

console.log('\nmodel names')
check('the 1M aliases are offered (the CLI lists them)', MODEL_OPTIONS.map((m) => m.id).filter((id) => id.endsWith('[1m]')), ['opus[1m]', 'sonnet[1m]', 'fable[1m]'])
check('haiku has no 1M alias, so none is offered', MODEL_OPTIONS.some((m) => m.id === 'haiku[1m]'), false)
check('a full id reads as words', modelLabel('claude-opus-5'), 'Opus 5')
check('a full 1M id keeps the 1M', modelLabel('claude-opus-5[1m]'), 'Opus 5 1M')

/* -------------------------------------------------------- disambiguation */

console.log('\nprojects with one name are told apart (QA L14)')
check(
  'two Laros differ by their parent',
  disambiguate([
    { path: '/Users/v/dev/work/Laro', label: 'Laro' },
    { path: '/Users/v/dev/personal/Laro', label: 'Laro' },
    { path: '/Users/v/dev/stoke', label: 'stoke' }
  ]),
  { '/Users/v/dev/work/Laro': 'work', '/Users/v/dev/personal/Laro': 'personal' }
)
check(
  'a shared parent reaches one level further',
  disambiguate([
    { path: '/a/x/qa/proj-a', label: 'proj-a' },
    { path: '/b/x/qa/proj-a', label: 'proj-a' }
  ]),
  { '/a/x/qa/proj-a': 'a/x/qa', '/b/x/qa/proj-a': 'b/x/qa' }
)
check(
  '/tmp and /private/tmp twins each get a suffix that differs',
  disambiguate([
    { path: '/tmp/qa/proj-a', label: 'proj-a' },
    { path: '/private/tmp/qa/proj-a', label: 'proj-a' }
  ]),
  { '/tmp/qa/proj-a': 'tmp/qa', '/private/tmp/qa/proj-a': 'private/tmp/qa' }
)
check(
  'labels compare case-folded',
  Object.keys(disambiguate([
    { path: '/w/laro', label: 'laro' },
    { path: '/p/Laro', label: 'Laro' }
  ])).length,
  2
)
check(
  'Windows paths keep their separator',
  disambiguate([
    { path: 'C:\\dev\\work\\Laro', label: 'Laro' },
    { path: 'C:\\dev\\home\\Laro', label: 'Laro' }
  ]),
  { 'C:\\dev\\work\\Laro': 'work', 'C:\\dev\\home\\Laro': 'home' }
)
check('a unique label gets nothing', disambiguate([{ path: '/a/b', label: 'b' }]), {})

/* -------------------------------------------------------- folder switcher */

console.log('\nthe folder switcher')
const p = (path: string, extra: Partial<ProjectLike> = {}): ProjectLike => ({
  path,
  name: path.split('/').pop() ?? path,
  label: null,
  exists: true,
  pinned: false,
  sessionCount: 1,
  lastModified: 1,
  ...extra
})
const projects = [
  p('/d/old', { lastModified: 1 }),
  p('/d/new', { lastModified: 9 }),
  p('/d/pin', { pinned: true, lastModified: 0 }),
  p('/w/Laro', { lastModified: 5 }),
  p('/h/Laro', { lastModified: 4, exists: false })
]
check('ranking is pinned, then most recent', rankProjects(projects).map((x) => x.path), ['/d/pin', '/d/new', '/w/Laro', '/h/Laro', '/d/old'])
const groups = folderChoices({
  projects,
  defaultCwd: '/home/me',
  hosts: [{ id: 'h1', label: 'Box', alias: 'box' }],
  query: ''
})
check('no query: recent, elsewhere, remote, then Open', groups.map((g) => g.title), ['Recent projects', 'Elsewhere', 'Remote machines', ''])
check('the default folder and scratch are always one pick away (QA L6)', groups[1].items.map((c) => c.kind), ['default', 'scratch'])
const laro = groups[0].items.filter((c) => c.kind === 'project' && c.label === 'Laro')
check('same-name projects carry their hints', laro.map((c) => (c.kind === 'project' ? c.hint : '')), ['w', 'h'])
check('a missing folder is tagged, not dropped (QA L13)', laro.map((c) => (c.kind === 'project' ? c.missing : null)), [false, true])
const q = folderChoices({ projects, defaultCwd: '/home/me', hosts: [], query: 'laro' })
check('a query lists only matches, and Open stays', flatChoices(q).map(choiceKey), ['p:/w/Laro', 'p:/h/Laro', 'open'])
check(
  'a query that matches nothing still offers Open folder…',
  flatChoices(folderChoices({ projects, defaultCwd: '', hosts: [], query: 'zzz' })).map(choiceKey),
  ['open']
)
check(
  'hosts are searchable by alias',
  flatChoices(folderChoices({ projects: [], defaultCwd: '', hosts: [{ id: 'h1', label: 'Box', alias: 'gpu-box' }], query: 'gpu' })).map(choiceKey),
  ['h:h1', 'open']
)
check(
  'with no query the recent list is capped',
  folderChoices({ projects: Array.from({ length: 20 }, (_, i) => p(`/x/${i}`, { lastModified: i })), defaultCwd: '', hosts: [], query: '', limit: 8 })[0].items.length,
  8
)

/* ---------------------------------------------------------- conversations */

console.log('\nthe conversation list (QA L12)')
const s = (id: string, messageCount: number, title: string | null = id, gitBranch: string | null = null) => ({
  id,
  title,
  firstPrompt: null,
  messageCount,
  gitBranch
})
const list = [s('a', 4), s('b', 0), s('c', 9, 'fix the build', 'main'), s('d', 2), s('e', 3), s('f', 1)]
const folded2 = sessionView(list, { query: '', showEmpty: false, all: false, limit: 3 })
check('empty sessions are hidden by default', folded2.shown.map((x) => x.id), ['a', 'c', 'd'])
check('…and counted', folded2.empty, 1)
check('the rest are folded behind Show all', folded2.more, 2)
check('Show all unfolds', sessionView(list, { query: '', showEmpty: false, all: true, limit: 3 }).shown.length, 5)
check('Show empty brings the empty one back', sessionView(list, { query: '', showEmpty: true, all: true, limit: 3 }).shown.map((x) => x.id), ['a', 'b', 'c', 'd', 'e', 'f'])
check('the filter matches titles', sessionView(list, { query: 'BUILD', showEmpty: false, all: false, limit: 3 }).shown.map((x) => x.id), ['c'])
check('…and branches', sessionView(list, { query: 'main', showEmpty: false, all: false, limit: 3 }).shown.map((x) => x.id), ['c'])
check('an untitled session says so', sessionTitle({ title: null, firstPrompt: null }), 'Untitled session')

/* ------------------------------------------------------------------ keys */

console.log('\nContinue names only a conversation with something in it')
check('the newest non-empty one', newestConversation(list)?.id, list.find((x) => x.messageCount > 0)?.id)
check(
  'a folder of empty sessions offers no Continue (it resumed a hidden "Untitled session")',
  newestConversation([
    { id: 'e1', title: null, firstPrompt: null, messageCount: 0 },
    { id: 'e2', title: null, firstPrompt: null, messageCount: 0 }
  ]),
  null
)

console.log('\nthe status bar names the mode the session is in (review of QA L11)')
check('no flag, nothing reported: the settings default', sessionMode({ reported: null, launched: 'default', claudeDefault: 'auto' }), 'auto')
check(
  'no flag, and the transcript reported default (Shift+Tab to Ask): Ask, not the settings default',
  sessionMode({ reported: 'default', launched: 'default', claudeDefault: 'auto' }),
  'default'
)
check('a reported plan wins over the settings default', sessionMode({ reported: 'plan', launched: 'default', claudeDefault: 'auto' }), 'plan')
check('a flag with nothing reported is the flag', sessionMode({ reported: null, launched: 'plan', claudeDefault: 'auto' }), 'plan')
check('no flag and no file sets one: the CLI default, Ask', sessionMode({ reported: null, launched: 'default', claudeDefault: null }), 'default')
check(
  "no flag while the folder's settings have not answered: nothing, not the last folder's",
  sessionMode({ reported: null, launched: 'default', claudeDefault: undefined }),
  null
)
check(
  'bypass from settings is bypass (the danger tone reads this)',
  sessionMode({ reported: null, launched: 'default', claudeDefault: 'bypassPermissions' }),
  'bypassPermissions'
)

console.log('\na New tab keeps the folder it showed (review of QA L5/L6)')
const pa = { path: '/p/a', name: 'proj-a', label: null, exists: true, pinned: false, sessionCount: 1, lastModified: 200 }
const pb = { path: '/p/b', name: 'proj-b', label: null, exists: true, pinned: false, sessionCount: 1, lastModified: 100 }
const aim0 = launchAim({ selected: null, pinned: null, projects: [pa, pb], loading: false, defaultCwd: '/home' })
check('unselected, it aims at the most recent project and pins it', aim0, { path: '/p/a', pin: '/p/a' })
const pbTouched = { ...pb, lastModified: 300 }
check(
  "another project's transcript moving does not re-aim it (measured: proj-a became proj-b under a focused Start)",
  launchAim({ selected: null, pinned: aim0.pin, projects: [pa, pbTouched], loading: false, defaultCwd: '/home' }).path,
  '/p/a'
)
check(
  'an explicit pick still moves it',
  launchAim({ selected: '/p/b', pinned: '/p/a', projects: [pa, pbTouched], loading: false, defaultCwd: '/home' }).path,
  '/p/b'
)
check(
  'a pinned default folder stays pinned when a first project appears',
  launchAim({ selected: null, pinned: '/home', projects: [pa], loading: false, defaultCwd: '/home' }).path,
  '/home'
)
check(
  'a pin whose project left the list (hidden, another profile) resolves afresh',
  launchAim({ selected: null, pinned: '/p/a', projects: [pbTouched], loading: false, defaultCwd: '/home' }),
  { path: '/p/b', pin: '/p/b' }
)
check(
  'nothing while the list loads with no pin',
  launchAim({ selected: null, pinned: null, projects: [], loading: true, defaultCwd: '/home' }),
  { path: null, pin: null }
)

console.log('\nactivation-key bursts (review of QA L1)')
/*
 * The QA's run, replayed: a fresh (non-repeat) Enter every 40ms from boot. The
 * splash went at 781ms; the agent picker opened (armed) inside the next 460ms,
 * and one of these Enters answered it. Then the launcher armed as the picker
 * closed, and the next Enter started claude in a real project.
 */
function replay(presses: { at: number; repeat?: boolean }[], armedAt: number): number[] {
  let b = NO_BURST
  const passed: number[] = []
  for (const p of presses) {
    b = nextBurst(b, p.at, p.repeat ?? false)
    if (p.at >= armedAt && pressAllowed(b, armedAt)) passed.push(p.at)
  }
  return passed
}
const every40 = Array.from({ length: 100 }, (_, i) => ({ at: 40 * i }))
check('an Enter every 40ms from boot never answers a picker that opened at 1000ms', replay(every40, 1000), [])
check('…nor the launcher armed when that picker closed', replay(every40, 1244), [])
check(
  'stop for a moment, press once: that press counts',
  replay([...every40, { at: 4500 }], 1000),
  [4500]
)
check(
  'a single press well after it opened counts (the ordinary case)',
  replay([{ at: 100 }, { at: 2000 }], 1000),
  [2000]
)
check(
  'a burst begun before anyone could have seen it does not, however long it runs',
  replay(Array.from({ length: 30 }, (_, i) => ({ at: 1050 + 100 * i })), 1000),
  []
)
check(
  `a burst begun ${PRESS_ARM_MS}ms or more after it opened is a deliberate press`,
  replay([{ at: 1000 + PRESS_ARM_MS }, { at: 1000 + PRESS_ARM_MS + 150 }], 1000),
  [1000 + PRESS_ARM_MS, 1000 + PRESS_ARM_MS + 150]
)
check(
  "a held key's repeats continue its burst even after a long initial delay",
  replay([{ at: 900 }, { at: 1600, repeat: true }, { at: 1650, repeat: true }], 1000),
  []
)

console.log('\nthe keyboard model')
const k = (key: string, mods: Partial<LauncherKeyEvent> = {}): LauncherKeyEvent => ({
  key,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  repeat: false,
  ...mods
})
const out = { inField: false }
const inField = { inField: true, hasQuery: true }
const emptyField = { inField: true, hasQuery: false }
check('plain Enter is left to the focused button', launcherKey(k('Enter'), out), null)
check('a HELD Enter is swallowed, so its repeats cannot start a session (QA L1)', launcherKey(k('Enter', { repeat: true }), out), { type: 'swallow' })
check('…in the filter too', launcherKey(k('Enter', { repeat: true }), inField), { type: 'swallow' })
check('Enter in the filter resumes the top match', launcherKey(k('Enter'), inField), { type: 'resume', index: 0 })
check(
  'Enter in the EMPTY filter resumes nothing (it resumed the newest conversation)',
  launcherKey(k('Enter'), emptyField),
  null
)
check('Cmd+Enter continues', launcherKey(k('Enter', { metaKey: true }), out), { type: 'continue' })
check('Ctrl+Enter continues', launcherKey(k('Enter', { ctrlKey: true }), out), { type: 'continue' })
check('Alt+Enter opens the agent menu', launcherKey(k('Enter', { altKey: true }), out), { type: 'agents' })
check('/ opens the switcher', launcherKey(k('/'), out), { type: 'switcher' })
check('/ typed in the filter is a character', launcherKey(k('/'), inField), null)
check('Cmd+O opens a folder', launcherKey(k('o', { metaKey: true }), out), { type: 'openFolder' })
check('Ctrl+O opens a folder, even from the filter', launcherKey(k('o', { ctrlKey: true }), inField), { type: 'openFolder' })
check('3 resumes the third conversation', launcherKey(k('3'), out), { type: 'resume', index: 2 })
check('0 is not a row number', launcherKey(k('0'), out), { type: 'filter', char: '0' })
check('a digit in the filter is text', launcherKey(k('3'), inField), null)
check('a letter goes to the filter', launcherKey(k('b'), out), { type: 'filter', char: 'b' })
check('Space stays the button’s', launcherKey(k(' '), out), null)
check('Cmd+letter is left alone (the app’s chords)', launcherKey(k('k', { metaKey: true }), out), null)
check('Tab is left alone', launcherKey(k('Tab'), out), null)
check('arrows move', [launcherKey(k('ArrowDown'), out), launcherKey(k('ArrowUp'), inField)], [{ type: 'move', delta: 1 }, { type: 'move', delta: -1 }])
check('Escape is the card’s', launcherKey(k('Escape'), inField), { type: 'escape' })

/* ---------------------------------------------------------- agent picker */

console.log('\nthe first-run agent picker (QA L20, qol select-all)')
const ids = ['claude', 'codex', 'grok', 'opencode', 'pi']
check(
  'installed agents first, in picker order; the rest folded',
  pickerSections(ids, new Set(['claude', 'codex', 'opencode'])),
  { installed: ['claude', 'codex', 'opencode'], more: ['grok', 'pi'] }
)
check('before detection answers, one unsplit list', pickerSections(ids, null), { installed: [], more: ids })
const installedIds = ['claude', 'codex', 'opencode']
const locked = new Set(['claude'])
const none = selectAllInstalled(new Set(['claude']), installedIds, locked)
check('Select all with only Claude picked is mixed', [none.checked, none.mixed], [false, true])
check(
  'Select all ticks the INSTALLED agents only — never an install',
  [...none.toggle()].sort(),
  ['claude', 'codex', 'opencode']
)
const allOn = selectAllInstalled(new Set(['claude', 'codex', 'opencode', 'grok']), installedIds, locked)
check('with every installed one picked it reads checked', allOn.checked, true)
check(
  'unticking all keeps the locked agent and a hand-ticked install',
  [...allOn.toggle()].sort(),
  ['claude', 'grok']
)
check(
  'with nothing installed there is nothing to select',
  selectAllInstalled(new Set<string>(), [], new Set()).checked,
  false
)

/*
 * The tally is the LAST statement (gotcha 50): an assertion after it could
 * print FAIL and still exit 0.
 */
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
