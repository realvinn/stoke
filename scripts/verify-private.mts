/*
 * Private chat (shared/privateChat.ts, src/main/privateChat.ts): what the CLI is
 * told, what is deleted afterwards and what never is, the boot sweep after a
 * crash, the watchdog, and the reduced hook event the real wrapper writes.
 *
 * Gotcha 74 is the loudest rule here: this suite DELETES. Every path the class
 * is handed — the private root, both config dirs, the temp root — is a fixture
 * under one mkdtemp folder, and every deleting step is checked against a
 * bystander beside its target that must survive. Nothing here reaches
 * `~/.claude`, userData or `$TMPDIR/stoke/statusline` except the wrapper run at
 * the end, which writes one events file under a synthetic key and removes it.
 *
 *   node scripts/verify-private.mts
 */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  cleanupAllowed,
  dropPrivateStoredTabs,
  encodeProjectDir,
  idFileMatches,
  isPrivateId,
  isPrivatePath,
  isPrivateProjectDir,
  keepStoredTab,
  markerText,
  MAX_PLAIN_SLUG,
  parseMarker,
  PRIVATE_ENV,
  PRIVATE_PLANS_DIR,
  PRIVATE_PROMPT_KEEP,
  PRIVATE_SETTINGS,
  privateCleanupTargets,
  privateCloseAsks,
  privateLaunchProblem,
  privateRebindVerdict,
  privateSlug,
  reducePrivateHookEvent,
  strictlyInside
} from '../src/shared/privateChat.ts'
import { pathRulesFor } from '../src/shared/paths.ts'
import type { StoredTab, StoredTabs } from '../src/shared/types.ts'
import { encodePath } from '../src/main/projects.ts'
import { findTranscriptStrict, PrivateChats, type PrivateState } from '../src/main/privateChat.ts'
import {
  clearSessionFiles,
  hookCommand,
  sessionEventsFile,
  sessionSettingsJson,
  statusLineDir,
  writeStatusLineWrapper
} from '../src/main/statusLine.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` +
      (ok ? '' : `\n        got ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  )
}

const ID = '1b4e28ba-2fa1-4d3b-a3f5-ef19b5a7633b'
const ID2 = '6f1c2b8e-0a4d-4c55-9a8e-2f7d3c1b0e99'
const OTHER = '0d9f6a52-7a6e-4bb0-8a3f-5c2e9b1d4f60'

/* ------------------------------------------------------------- the CLI */

console.log('what the CLI is told')
check(
  'the env: saving, checkpoints, backgrounding and auto-memory off, each "1"',
  PRIVATE_ENV,
  {
    CLAUDE_CODE_SKIP_PROMPT_HISTORY: '1',
    CLAUDE_CODE_DISABLE_FILE_CHECKPOINTING: '1',
    CLAUDE_CODE_DISABLE_AGENT_VIEW: '1',
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1'
  }
)
check(
  'the settings keys',
  Object.keys(PRIVATE_SETTINGS).sort(),
  ['autoDreamEnabled', 'autoMemoryEnabled', 'disableAgentView', 'disableRemoteControl', 'fileCheckpointingEnabled', 'plansDirectory', 'remoteControlAtStartup']
)
check('plans go inside the folder: a relative path (the CLI refuses one outside the project)', [PRIVATE_SETTINGS.plansDirectory, /^[./\\]|:/.test(PRIVATE_PLANS_DIR)], ['plans', false])
{
  const plain = sessionSettingsJson({ sessionId: ID, ultracode: false, hideStatusLine: true, passthroughCommand: '', hasGitBash: false })
  const priv = sessionSettingsJson({ sessionId: ID, ultracode: true, hideStatusLine: true, passthroughCommand: '', hasGitBash: false, privateChat: true })
  check('an ordinary session gets none of the private keys', Object.keys(PRIVATE_SETTINGS).filter((k) => k in plain), [])
  check('a private chat gets every one, in the same one file (gotcha 2)', Object.keys(PRIVATE_SETTINGS).every((k) => JSON.stringify(priv[k]) === JSON.stringify(PRIVATE_SETTINGS[k])), true)
  check('beside its statusLine, hooks and ultracode', ['statusLine', 'hooks', 'ultracode'].every((k) => k in priv), true)
  const hook = (priv.hooks as { Stop: Array<{ hooks: Array<{ command: string }> }> }).Stop[0].hooks[0].command
  const plainHook = (plain.hooks as { Stop: Array<{ hooks: Array<{ command: string }> }> }).Stop[0].hooks[0].command
  check("its hooks carry the 'private' word, an ordinary session's do not", [hook.endsWith('"event" "private"'), plainHook.endsWith('"event"')], [true, true])
  check(
    'on Windows too, with and without Git Bash',
    [hookCommand(ID, 'win32', true, true).endsWith('"event" "private"'), hookCommand(ID, 'win32', false, true).startsWith('& ')],
    [true, true]
  )
}

console.log('\nwhere it may start')
const asked = { host: false, install: false, enroll: false, accountLogin: false }
check('the desktop, locally: yes', privateLaunchProblem({ origin: 'desktop', ...asked }), null)
check('the phone (or another machine through it): never', privateLaunchProblem({ origin: 'remote', ...asked }) !== null, true)
check(
  'SSH, an install, an enrollment, a sign-in: never',
  (['host', 'install', 'enroll', 'accountLogin'] as const).map((k) => privateLaunchProblem({ origin: 'desktop', ...asked, [k]: true }) !== null),
  [true, true, true, true]
)

/* ----------------------------------------------------------------- ids */

console.log('\nids and slugs')
check('a minted uuid is an id', isPrivateId(randomUUID()), true)
check(
  'nothing else is: traversal, separators, upper case, empty, padding',
  ['..', '', `${ID}/..`, ID.toUpperCase(), ` ${ID}`, `${ID}x`, '../../etc', 42].map(isPrivateId),
  [false, false, false, false, false, false, false, false]
)
for (const p of ['/Users/me/Library/Application Support/Stoke/private/' + ID, 'C:\\Users\\Ö Brien\\AppData\\Roaming\\Stoke\\private\\' + ID, '/tmp/a b/c.d']) {
  check(`the slug is projects.ts's own rule: ${p.slice(0, 24)}…`, encodeProjectDir(p), encodePath(p))
}
check('a folder the CLI would hash has no slug, so no chat runs there', [privateSlug('/' + 'x'.repeat(MAX_PLAIN_SLUG)), privateSlug('/' + 'x'.repeat(MAX_PLAIN_SLUG - 1))?.length], [null, MAX_PLAIN_SLUG])

console.log('\npaths')
{
  const mac = pathRulesFor('darwin')
  const win = pathRulesFor('win32')
  check('inside', strictlyInside('/u/private', `/u/private/${ID}`, mac), true)
  check('the root itself is not inside itself', strictlyInside('/u/private', '/u/private/', mac), false)
  check('a sibling sharing the prefix is not inside', strictlyInside('/u/private', '/u/private-old/x', mac), false)
  check('Windows folds case and separators', strictlyInside('C:\\U\\Private', `c:/u/private/${ID}`, win), true)
  check('a private chat folder is private, its root and a neighbour are not', [`/r/private/${ID}`, '/r/private', '/r/privateer/x'].map((p) => isPrivatePath(p, ['/r/private'], 'darwin')), [true, false, false])
  check('either form of the root counts (raw and realpath)', isPrivatePath(`/private/tmp/ud/private/${ID}`, ['/tmp/ud/private', '/private/tmp/ud/private'], 'darwin'), true)
  const root = '/Users/me/ud/private'
  check(
    "a history folder is private by its slug's prefix, case-folded",
    [encodeProjectDir(`${root}/${ID}`), encodeProjectDir(`${root}/${ID}`).toUpperCase(), encodeProjectDir(root), encodeProjectDir('/Users/me/ud/privateer/x')].map((n) => isPrivateProjectDir(n, [root])),
    [true, true, false, false]
  )
  check('no roots, nothing hidden', isPrivateProjectDir(encodeProjectDir(`${root}/${ID}`), []), false)
  check('a target whose parent resolves inside a base may go', cleanupAllowed('/c/.claude/projects', ['/c/.claude'], 'darwin'), true)
  check('a parent that IS a base may go', cleanupAllowed('/c/.claude', ['/c/.claude'], 'darwin'), true)
  check('one that resolves elsewhere, or beside it, may not', [cleanupAllowed('/elsewhere', ['/c/.claude'], 'darwin'), cleanupAllowed('/c/.claude-x', ['/c/.claude'], 'darwin')], [false, false])
}

/* -------------------------------------------------------------- marker */

console.log('\nthe marker')
{
  const m = { version: 1 as const, id: ID, ids: [ID, ID2], configDirs: ['/c/.claude', 'C:\\acct'], createdAt: 5 }
  check('round trip', parseMarker(markerText(m), ID), m)
  check('named for another id: refused', parseMarker(markerText(m), ID2), null)
  check('ids not holding its own id: refused', parseMarker(markerText({ ...m, ids: [ID2] }), ID), null)
  check('an id that is not one: refused', parseMarker(markerText({ ...m, ids: [ID, '../x'] }), ID), null)
  check('a relative config dir: refused', parseMarker(markerText({ ...m, configDirs: ['rel/.claude'] }), ID), null)
  check('junk and a wrong version: refused', [parseMarker('{', ID), parseMarker('[]', ID), parseMarker(markerText({ ...m, version: 2 as unknown as 1 }), ID)], [null, null, null])
  check('a file name that is not an id: refused', parseMarker(markerText(m), '..'), null)
}

/* -------------------------------------------------------------- targets */

console.log('\nwhat is deleted, by exact join')
{
  const t = privateCleanupTargets({
    ids: [ID, '../evil'],
    folder: `/ud/private/${ID}`,
    privateRoot: '/ud/private',
    configDirs: ['/h/.claude', '/h/.claude', 'relative'],
    tmpRoots: ['/tmp/claude-501'],
    join: (...p) => p.join('/')
  })
  const slug = encodeProjectDir(`/ud/private/${ID}`)
  check(
    'every path, each with the base it must resolve inside; an invalid id and a relative dir build nothing',
    t,
    [
      { path: `/h/.claude/projects/${slug}`, within: '/h/.claude' },
      { path: `/h/.claude/file-history/${ID}`, within: '/h/.claude' },
      { path: `/h/.claude/session-env/${ID}`, within: '/h/.claude' },
      { path: `/h/.claude/image-cache/${ID}`, within: '/h/.claude' },
      { path: `/h/.claude/tasks/${ID}`, within: '/h/.claude' },
      { path: `/h/.claude/debug/${ID}.txt`, within: '/h/.claude' },
      { path: `/tmp/claude-501/${slug}`, within: '/tmp/claude-501' },
      { path: `/ud/private/${ID}`, within: '/ud/private' }
    ]
  )
  check(
    'files named for the id, and only those',
    idFileMatches([`1p_failed_events.${ID}.${OTHER}.json`, `1p_failed_events.${OTHER}.x.json`, `${ID}-agent-${ID}.json`, `a/${ID}`, 'history.jsonl'], [ID, 'nope']),
    [`1p_failed_events.${ID}.${OTHER}.json`, `${ID}-agent-${ID}.json`]
  )
  check(
    "another session's file whose second, random uuid is one of ours is not ours",
    idFileMatches([`1p_failed_events.${OTHER}.${ID}.json`, `${OTHER}-agent-${ID}.json`], [ID]),
    []
  )
}

console.log('\nrebind, close and the hook event')
{
  const slug = encodeProjectDir(`/ud/private/${ID}`)
  check('the id it is on: nothing changes', privateRebindVerdict({ newId: ID, known: [ID], transcript: null, slug }), 'same')
  check('a /clear successor with no transcript joins the delete set', privateRebindVerdict({ newId: ID2, known: [ID], transcript: null, slug }), 'adopt')
  check('one whose transcript is under THIS folder joins it too', privateRebindVerdict({ newId: ID2, known: [ID], transcript: `/h/.claude/projects/${slug}/${ID2}.jsonl`, slug }), 'adopt')
  check(
    'a conversation saved elsewhere, resumed into, never does',
    privateRebindVerdict({ newId: OTHER, known: [ID], transcript: `/h/.claude/projects/-Users-me-dev-app/${OTHER}.jsonl`, slug }),
    'foreign'
  )
  check('an id that is not one is refused', privateRebindVerdict({ newId: '../x', known: [ID], transcript: null, slug }), 'invalid')
  check(
    'a lookup that could not answer is unsure, never a /clear: adopting a resumed chat would delete its checkpoints',
    privateRebindVerdict({ newId: OTHER, known: [ID], transcript: undefined, slug }),
    'unsure'
  )
  check(
    'close asks only when something is lost',
    [
      privateCloseAsks({ files: 0, busy: false }),
      privateCloseAsks({ files: 0, busy: null }),
      privateCloseAsks({ files: 2, busy: false }),
      privateCloseAsks({ files: 0, busy: true }),
      privateCloseAsks({ files: null, busy: false })
    ],
    [false, false, true, true, true]
  )
  const raw = {
    hook_event_name: 'Stop',
    session_id: ID,
    cwd: `/ud/private/${ID}`,
    transcript_path: `/h/.claude/projects/x/${ID}.jsonl`,
    last_assistant_message: 'THE WHOLE REPLY',
    message: 'a notification text',
    background_tasks: [{ type: 'workflow', status: 'running', name: 'w' }],
    prompt: 'p'.repeat(200)
  }
  const reduced = reducePrivateHookEvent(raw)
  check('the reduced event drops the reply, the notification text and the transcript path', ['last_assistant_message', 'message', 'transcript_path'].filter((k) => k in reduced), [])
  check('keeps what the dot reads', [reduced.hook_event_name, reduced.session_id, reduced.background_tasks], ['Stop', ID, raw.background_tasks])
  check('and only the opening of a prompt', (reduced.prompt as string).length, PRIVATE_PROMPT_KEEP)
}

console.log('\ntabs.json')
{
  const st = (over: Partial<StoredTab>): StoredTab =>
    ({ kind: 'session', cliId: 'claude', sessionId: 's', cwd: '/w/a', projectName: 'a', title: 'a', permissionMode: 'default', model: '', effort: 'default', ultracode: false, hostId: null, selectedPath: null, expandedPath: null, lastActiveAt: 1, context: null, screen: 'x', ...over }) as StoredTab
  const roots = ['/ud/private']
  check('a private id or folder is never kept; anything else is', [keepStoredTab(st({ sessionId: ID }), new Set([ID]), roots, 'darwin'), keepStoredTab(st({ cwd: `/ud/private/${ID}` }), new Set(), roots, 'darwin'), keepStoredTab(st({}), new Set([ID]), roots, 'darwin')], [false, false, true])
  const state: StoredTabs = { version: 1, savedAt: 1, activeIndex: 2, tabs: [st({ sessionId: 'a' }), st({ sessionId: ID }), st({ sessionId: 'c' })] }
  const dropped = dropPrivateStoredTabs(state, new Set([ID]), roots, 'darwin')
  check('dropped, and the selection stays on its own tab', [dropped.tabs.map((t) => t.sessionId), dropped.activeIndex], [['a', 'c'], 1])
  check('the selected private tab hands the selection to the tab before it', dropPrivateStoredTabs({ ...state, activeIndex: 1 }, new Set([ID]), roots, 'darwin').activeIndex, 0)
  const clean: StoredTabs = { ...state, tabs: [st({ sessionId: 'a' })], activeIndex: 0 }
  check('nothing private: the very same object back', dropPrivateStoredTabs(clean, new Set([ID]), roots, 'darwin') === clean, true)
  check('only private tabs: an empty list at 0', [dropPrivateStoredTabs({ ...state, tabs: [st({ sessionId: ID })], activeIndex: 0 }, new Set([ID]), roots, 'darwin')].map((s) => [s.tabs.length, s.activeIndex])[0], [0, 0])
}

/* ------------------------------------------------- the class, on disk */

console.log('\nPrivateChats on fixture folders (gotcha 74: nothing real is reachable)')
const box = realpathSync.native(mkdtempSync(join(tmpdir(), 'stoke-private-')))
try {
  const ud = join(box, 'ud')
  const root = join(ud, 'private')
  const cfg = join(box, 'home', '.claude')
  const acct = join(box, 'accounts', 'claude-work')
  const tmpRoot = join(box, 'tmp', 'claude-501')
  const outside = join(box, 'outside')
  for (const d of [cfg, acct, tmpRoot, outside]) mkdirSync(d, { recursive: true })
  const put = (path: string, text = 'x'): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, text)
  }
  const states: PrivateState[] = []
  const cleared: string[] = []
  const make = (): PrivateChats =>
    new PrivateChats({
      root,
      tmpRoots: () => [tmpRoot],
      findTranscript: async (id, dirs) => {
        for (const d of dirs) {
          const projects = join(d, 'projects')
          if (!existsSync(projects)) continue
          for (const p of readdirSync(projects)) {
            const f = join(projects, p, `${id}.jsonl`)
            if (existsSync(f)) return f
          }
        }
        return null
      },
      clearStatusFiles: (id) => cleared.push(id),
      onState: (st) => states.push(st)
    })

  const chats = make()
  const { id, folder } = await chats.begin([cfg, acct])
  const slug = encodeProjectDir(folder)
  check('begin mints an id and a folder named for it, under the root', [isPrivateId(id), folder], [true, join(root, id)])
  check('the marker is on disk beside it, naming both config dirs', parseMarker(readFileSync(join(root, `${id}.json`), 'utf8'), id)?.configDirs, [cfg, acct])
  if (process.platform !== 'win32') {
    check('owner-only: the root and the folder are 0700, the marker 0600', [statSync(root).mode & 0o777, statSync(folder).mode & 0o777, statSync(join(root, `${id}.json`)).mode & 0o777], [0o700, 0o700, 0o600])
  }
  chats.attach(id, 'pty-1')
  check('it knows its pty and its id', [chats.isPrivatePty('pty-1'), chats.isPrivatePty('pty-2'), [...chats.sessionIds()]], [true, false, [id]])

  // An empty plans folder is nothing to lose; a file Claude wrote is.
  mkdirSync(join(folder, PRIVATE_PLANS_DIR, 'empty'), { recursive: true })
  check('an empty folder (plans dir and all) holds no files', await chats.inspect('pty-1'), { files: 0 })
  put(join(folder, 'notes.md'))
  check('a file Claude made is counted', await chats.inspect('pty-1'), { files: 1 })
  check('an unknown pty cannot be counted', await chats.inspect('nope'), { files: null })

  // What the CLI could have left, everywhere the scout found it.
  const mine = [
    join(cfg, 'projects', slug, `${id}.jsonl`),
    join(cfg, 'projects', slug, 'memory', 'MEMORY.md'),
    join(cfg, 'file-history', id, 'abc@v1'),
    join(cfg, 'session-env', id, 'sessionstart-hook-0.sh'),
    join(cfg, 'tasks', id, 't.json'),
    join(cfg, 'debug', `${id}.txt`),
    join(cfg, 'telemetry', `1p_failed_events.${id}.${OTHER}.json`),
    join(cfg, 'todos', `${id}-agent-${id}.json`),
    join(acct, 'file-history', id, 'x@v1'),
    join(tmpRoot, slug, id, 'scratch.txt')
  ]
  const bystanders = [
    join(cfg, 'projects', '-Users-me-dev-app', `${OTHER}.jsonl`),
    join(cfg, 'file-history', OTHER, 'keep@v1'),
    join(cfg, 'session-env', OTHER, 'keep.sh'),
    join(cfg, 'telemetry', `1p_failed_events.${OTHER}.${ID2}.json`),
    join(cfg, 'history.jsonl'),
    join(box, 'home', '.claude.json'),
    join(tmpRoot, '-Users-me-dev-app', 'keep.txt'),
    join(root, `${OTHER}`, 'no-marker-so-never-touched.txt')
  ]
  for (const f of [...mine, ...bystanders]) put(f)

  // The watchdog: a transcript under this chat's own slug is a leak.
  await chats.scan()
  check('the watchdog flags the transcript the CLI wrote anyway', states.at(-1), { ptyId: 'pty-1', leak: true, foreign: false })
  check('and says it once', (await chats.scan(), states.length), 1)

  // A /clear: the new id joins what is deleted. A resume into a saved one does not.
  put(join(cfg, 'file-history', ID2, 'clear@v1'))
  check('a /clear successor is adopted', await chats.rebind('pty-1', ID2), 'adopt')
  check('and written to the marker, so a crash after it still cleans it', parseMarker(readFileSync(join(root, `${id}.json`), 'utf8'), id)?.ids, [id, ID2])
  check('a resume into a conversation saved elsewhere is foreign', await chats.rebind('pty-1', OTHER), 'foreign')
  check('and the tab is told', states.at(-1), { ptyId: 'pty-1', leak: true, foreign: true })
  check('its id never joins the delete set', [...chats.sessionIds()].includes(OTHER), false)

  // A link that leads out of the tree: what is behind it is left alone, by
  // realpath. `image-cache` points outside the config dir, at a folder that
  // happens to hold this very id.
  const escapeTarget = join(outside, 'image-cache')
  put(join(escapeTarget, id, 'must-survive.png'))
  // A junction on Windows: a directory link that needs no admin rights.
  const dirLink = process.platform === 'win32' ? 'junction' : 'dir'
  symlinkSync(escapeTarget, join(cfg, 'image-cache'), dirLink)
  // An account's `projects` is a link into the default tree (accounts.ts): allowed.
  rmSync(join(acct, 'projects'), { recursive: true, force: true })
  symlinkSync(join(cfg, 'projects'), join(acct, 'projects'), dirLink)

  // Two exits for one pty at once (a kill racing the process's own exit):
  // the pty is claimed before the first await, so only one cleans.
  const [removed, twice] = await Promise.all([chats.finish('pty-1'), chats.finish('pty-1')])
  check('finish removes what it built, once', [removed > 0, twice], [true, 0])
  check(
    'every file the chat left is gone, in both config dirs and the temp root',
    mine.filter((f) => existsSync(f)).map((f) => f.slice(box.length)),
    []
  )
  check('the /clear successor went with it', existsSync(join(cfg, 'file-history', ID2)), false)
  check('the folder and the marker are gone', [existsSync(folder), existsSync(join(root, `${id}.json`))], [false, false])
  check('every bystander survives', bystanders.filter((f) => !existsSync(f)).map((f) => f.slice(box.length)), [])
  check('a link out of the tree is not followed', existsSync(join(escapeTarget, id, 'must-survive.png')), true)
  check("the account's linked projects folder is still a link", lstatSync(join(acct, 'projects')).isSymbolicLink(), true)
  check('and a later one finds nothing to do', await chats.finish('pty-1'), 0)

  // A launch that failed after begin: everything goes at once.
  const failed = await chats.begin([cfg])
  await chats.abandon(failed.id)
  check('an abandoned launch leaves no folder and no marker', [existsSync(failed.folder), existsSync(join(root, `${failed.id}.json`))], [false, false])

  // A crash: chat 2 runs, writes, and the process dies with no finish.
  const crashed = await chats.begin([cfg])
  chats.attach(crashed.id, 'pty-2')
  const cSlug = encodeProjectDir(crashed.folder)
  const left = [
    join(crashed.folder, 'work.txt'),
    join(cfg, 'projects', cSlug, `${crashed.id}.jsonl`),
    join(cfg, 'session-env', crashed.id, 'h.sh'),
    join(tmpRoot, cSlug, 'f')
  ]
  for (const f of left) put(f)
  // A quit: folders go synchronously, markers stay for the sweep.
  chats.quitSync()
  check('a quit removes the folder at once and leaves the marker', [existsSync(crashed.folder), existsSync(join(root, `${crashed.id}.json`))], [false, true])
  // And a corrupt marker beside it, which the sweep must leave alone.
  const corrupt = join(root, `${ID2}.json`)
  writeFileSync(corrupt, '{"version":1,"id":"not-this-one"}')
  put(join(root, ID2, 'unproven.txt'))

  const next = make()
  const swept = await next.sweepAtBoot()
  check('the next boot sweeps the one chat its marker names', swept, 1)
  check('everything that chat left is gone', left.filter((f) => existsSync(f)).map((f) => f.slice(box.length)), [])
  check('its marker too', existsSync(join(root, `${crashed.id}.json`)), false)
  check('its statusLine files are cleared by id', cleared, [crashed.id])
  check('a marker that does not parse is left alone, and its folder', [existsSync(corrupt), existsSync(join(root, ID2, 'unproven.txt'))], [true, true])
  check('a folder with no marker is never touched', existsSync(join(root, OTHER, 'no-marker-so-never-touched.txt')), true)
  check('every bystander still survives', bystanders.filter((f) => !existsSync(f)).map((f) => f.slice(box.length)), [])
  check('a second sweep finds nothing', await next.sweepAtBoot(), 0)

  // A root whose folder names the CLI would hash cannot host one.
  const longRoot = join(box, 'l'.repeat(MAX_PLAIN_SLUG))
  let refused = false
  try {
    await new PrivateChats({ root: longRoot, tmpRoots: () => [], findTranscript: async () => null, clearStatusFiles: () => {}, onState: () => {} }).begin([cfg])
  } catch {
    refused = true
  }
  check('a root too long for a plain slug refuses to start a chat', refused, true)
  check('and leaves no marker behind', existsSync(longRoot) ? readdirSync(longRoot).length : 0, 0)

  /*
   * Review fixes (2026-10-02). Each was mutated back to red; see gotcha 148's
   * "Checked against the code" note.
   */
  console.log('\nlooking an id up: "none" only when every folder was read')
  {
    const look = join(box, 'look')
    const lookCfg = join(look, '.claude')
    check('no config dir at all: none', await findTranscriptStrict(ID, [join(look, 'absent')]), null)
    put(join(lookCfg, 'projects', '-a', `${OTHER}.jsonl`))
    put(join(lookCfg, 'projects', 'stray-file'))
    check('found where it is; a stray file beside the folders is not an error', await findTranscriptStrict(OTHER, [lookCfg]), join(lookCfg, 'projects', '-a', `${OTHER}.jsonl`))
    check('a folder read through with no such file: none', await findTranscriptStrict(ID2, [lookCfg]), null)
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      chmodSync(join(lookCfg, 'projects'), 0o000)
      let threw = false
      try {
        await findTranscriptStrict(ID2, [lookCfg])
      } catch {
        threw = true
      }
      chmodSync(join(lookCfg, 'projects'), 0o700)
      check('a folder it could not list is "could not tell", never "none"', threw, true)
    }
  }

  console.log('\na rebind that cannot look, a rebind still looking at close, and a file that will not go')
  {
    // Ids the CLI could move to: a /clear's (no transcript) and a saved chat
    // resumed into, whose lookups fail until `canLook` is set.
    const cleared = randomUUID()
    const resumed = randomUUID()
    const slowId = randomUUID()
    let canLook = false
    const seen: PrivateState[] = []
    const opts = {
      root,
      tmpRoots: () => [tmpRoot],
      findTranscript: async (id: string): Promise<string | null> => {
        if (id === slowId) return new Promise((r) => setTimeout(() => r(null), 150))
        if (id === resumed || !canLook) throw new Error('EACCES')
        return null
      },
      clearStatusFiles: () => {},
      onState: (st: PrivateState) => seen.push(st)
    }
    const c3 = new PrivateChats(opts)
    const a = await c3.begin([cfg])
    c3.attach(a.id, 'pty-u')
    const clearedFile = join(cfg, 'session-env', cleared, 'h.sh')
    const resumedFile = join(cfg, 'file-history', resumed, 'checkpoint@v1')
    put(clearedFile)
    put(resumedFile)
    check('a rebind whose lookup fails is unsure', await c3.rebind('pty-u', cleared), 'unsure')
    check('and its id is neither deleted nor called saved yet', [[...c3.sessionIds()].includes(cleared), seen.length], [false, 0])
    canLook = true
    await c3.scan()
    check('the watchdog looks again, and a /clear it can now place is adopted', [...c3.sessionIds()].includes(cleared), true)
    check('a resumed chat whose lookup never answers stays unsure', await c3.rebind('pty-u', resumed), 'unsure')
    await c3.finish('pty-u')
    check("the close deletes the adopted id's files", existsSync(clearedFile), false)
    check("and leaves the never-placed one's checkpoints whole", existsSync(resumedFile), true)

    // A close while a rebind is still looking its id up waits for it.
    const b = await c3.begin([cfg])
    c3.attach(b.id, 'pty-s')
    const slowFile = join(cfg, 'session-env', slowId, 'h.sh')
    put(slowFile)
    const pending = c3.rebind('pty-s', slowId)
    await c3.finish('pty-s')
    check('a /clear still being looked up at close is deleted with the rest', [await pending, existsSync(slowFile)], ['adopt', false])
    await new Promise((r) => setTimeout(r, 200))
    check('and its marker is not written back after the close removed it', existsSync(join(root, `${b.id}.json`)), false)

    // A file the cleanup cannot remove keeps the marker, so the next start retries.
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const d = await c3.begin([cfg])
      c3.attach(d.id, 'pty-f')
      const stuck = join(cfg, 'file-history', d.id, 'x@v1')
      put(stuck)
      chmodSync(join(cfg, 'file-history'), 0o500)
      try {
        await c3.finish('pty-f')
      } finally {
        chmodSync(join(cfg, 'file-history'), 0o700)
      }
      check('a file that would not go keeps the marker', [existsSync(join(cfg, 'file-history', d.id)), existsSync(join(root, `${d.id}.json`))], [true, true])
      check('and its folder still went', existsSync(d.folder), false)
      const after = new PrivateChats(opts)
      check('the next start sweeps it', [await after.sweepAtBoot(), existsSync(join(cfg, 'file-history', d.id)), existsSync(join(root, `${d.id}.json`))], [1, false, false])
    }
  }
} finally {
  rmSync(box, { recursive: true, force: true })
}

/* --------------------------------------------------- the real wrapper */

console.log('\nthe generated wrapper, run as the hook runs it')
{
  // A synthetic key under the shared directory: written once, removed after
  // (gotcha 74 allows writing under a key of our own; nothing directory-wide).
  const key = `stoke-verify-private-${randomUUID()}`
  writeStatusLineWrapper()
  const wrapper = join(statusLineDir(), 'wrapper.mjs')
  const event = {
    hook_event_name: 'UserPromptSubmit',
    session_id: ID,
    cwd: `/ud/private/${ID}`,
    transcript_path: '/h/.claude/projects/x/y.jsonl',
    prompt: 'secret words '.repeat(20),
    last_assistant_message: 'the reply'
  }
  try {
    execFileSync(process.execPath, [wrapper, key, 'event', 'private'], { input: JSON.stringify(event), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    execFileSync(process.execPath, [wrapper, key, 'event'], { input: JSON.stringify(event), env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
    const lines = readFileSync(sessionEventsFile(key), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
    check('the private hook wrote exactly the reduced event', lines[0], reducePrivateHookEvent(event))
    check('the plain hook still writes the whole event', lines[1], event)
  } finally {
    clearSessionFiles(key)
  }
  check('and the events file is gone afterwards', existsSync(sessionEventsFile(key)), false)
}

/*
 * The tally is the LAST statement (gotchas 50, 62): an assertion below it could
 * print FAIL and still exit 0.
 */
console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
