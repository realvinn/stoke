/*
 * Work mode, the pretend IDE (the `work-mode` built-in plugin): every rule that
 * can be held without a window.
 *
 * - registration: the package, the catalog, the Settings row, the palette action;
 * - what may be listed and read (`workModePathClass`), types and picks, the
 *   folder verdict, the folder each tab kind hands over (gotcha 150);
 * - main's reader against REAL scratch folders and a REAL git: secret-named
 *   files, dependency and build output, over-cap, minified, NUL and FIFO files,
 *   links out of the folder (by the last component and by a parent), redaction
 *   of what is sent (both layers, each with a fixture only it catches), gotcha
 *   147's traps (fsmonitor, a clean filter, an index hook) each shown live
 *   first, deadlines, persistence, the disabled answer, one listing for two
 *   requests (gotcha 20);
 * - the typing model (a property test over thousands of steps), the session
 *   reducer, the highlighter (lossless, linear), keys, the leave chord, the tail,
 *   the pointer budget, the build panel's lines;
 * - the bundled sample website: it parses, balances and is redaction-clean;
 * - source pins on the wire the suite cannot run (gotcha 31, 175).
 *
 * Hermetic: suite-tmpdir is imported first (gotcha 74), every fixture is under
 * this run's scratch folder, git runs with a scratch global config and no
 * system config, and the reader gets a scratch HOME. Secret-shaped fixtures are
 * built from pieces at run time (gotcha 157). The tally is the last statement
 * (gotchas 50, 62).
 *
 *   node scripts/verify-work-mode.mts
 */
import './suite-tmpdir.mts'
import { requireScratch } from './suite-tmpdir.mts'
import { execFileSync } from 'node:child_process'
import { chmodSync, closeSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BUILTIN_PACKAGES,
  PLUGIN_CATALOG,
  parsePluginPackage,
  pluginInstallLink
} from '../src/shared/pluginPackages.ts'
import { SETTING_ROWS, searchSettings, settingsEntries } from '../src/shared/settingsIndex.ts'
import { PRESS_QUIET_MS } from '../src/shared/launcher.ts'
import { folderDepth } from '../src/shared/remotePhone.ts'
import { redactKeyShaped } from '../src/shared/keyShaped.ts'
import { pathRulesFor } from '../src/shared/paths.ts'
import {
  CODE_PATHSPECS,
  EXIT_START,
  NEVER_DEFAULT,
  POINTER_START,
  WM_CHARS_DEFAULT,
  WM_CHARS_MAX,
  WM_CHARS_MIN,
  WM_EXIT_WINDOW_MS,
  WM_FILES_MAX,
  WM_FILES_PER_TYPE,
  WM_FILE_MAX_BYTES,
  WM_FILE_MIN_BYTES,
  WM_FILL_GAP_MS,
  WM_HINT_AGAIN_MS,
  WM_HINT_MS,
  WM_IDLE_MS,
  WM_JUMP_PX,
  WM_LINE_MAX_CHARS,
  WM_LIST_MAX,
  WM_PANEL_DEV_MAX,
  WM_PANEL_LINES_MAX,
  WM_PANEL_TEST_MAX,
  WM_PICKS_MAX,
  WM_PROSE_LINE_MAX_CHARS,
  WM_PROJECTS_MAX,
  WM_PX_PER_LINE,
  WM_RANK_POOL_MAX,
  WM_SKIP_EVERY,
  WM_SKIP_RUN_MAX,
  WM_TABS_MAX,
  WM_TAIL_QUIET_MS,
  WM_TOTAL_MAX_BYTES,
  WM_TREE_MAX,
  WM_TREE_TESTS_MAX,
  WM_TYPES_SHOWN,
  WM_WALK_MAX_DEPTH,
  WM_WALK_MAX_ENTRIES,
  WORK_MODE_LANGUAGES,
  chooseCandidates,
  clock12,
  clock24,
  countTypes,
  defaultPicks,
  detectIndent,
  exitStep,
  explorerNodes,
  extOf,
  hasTestTerminal,
  isTestPath,
  lineCapOf,
  orderPicks,
  panelBurst,
  panelLineKind,
  panelPrompt,
  panelTestPrompt,
  panelTime,
  parseWorkModeState,
  pathDepth,
  pointerBudget,
  rememberedPicks,
  seededRandom,
  tailDone,
  testCount,
  testFileFor,
  testStem,
  toolchain,
  validPicks,
  windowQueues,
  workModeFolderVerdict,
  workModeKey,
  workModeMenuKey,
  workModePathClass,
  type ExitState,
  type PanelOut,
  type PanelSource,
  type Toolchain,
  type WorkModeFile,
  type WorkModeKeyEvent
} from '../src/shared/workMode.ts'
import {
  WRAP_MIN_COLS,
  WRAP_MIN_TEXT,
  WRAP_RESERVE,
  aimAt,
  aimTarget,
  bracketBalance,
  caretVisual,
  docRows,
  fillLine,
  lineOfVisual,
  newDoc,
  newSession,
  nextSlot,
  prepareFile,
  reduceWorkMode,
  skippable,
  splitTokens,
  tagBalance,
  textColumns,
  typeChars,
  wrapColumns,
  wrapIndent,
  wrapLayout,
  wrapStarts,
  type DocState,
  type LineWrap,
  type PreparedFile,
  type Session
} from '../src/shared/workModeDoc.ts'
import { isPlainState, lineStates, plainState, tokenizeLine, type Grammar } from '../src/shared/workModeHighlight.ts'
import { WORK_MODE_TIMEOUTS, WorkModeReader, cleanForShow, picksKey } from '../src/main/plugins/workMode.ts'
import { findGit, gitEnv, safeGitArgs } from '../src/main/gitStatus.ts'
import { redactSecrets } from '../src/main/chatIndex/parse.ts'
import { workModeFolder } from '../src/renderer/src/lib/tabs.ts'
import { PALETTE_ACTIONS, WORK_MODE_ACTION, paletteActions, paletteRows, searchPaletteActions } from '../src/renderer/src/lib/paletteRows.ts'

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got ${JSON.stringify(got)?.slice(0, 600)}, want ${JSON.stringify(want)?.slice(0, 600)}`))
}

/*
 * A blocked open (a FIFO opened without O_NONBLOCK) would hold the event loop
 * for good; the run then fails by name instead of hanging. Unref'd, so a
 * healthy run is never kept alive by it.
 */
const watchdog = setTimeout(() => {
  console.log('  FAIL  the suite did not finish in 90 s (an open that never returned?)')
  releaseFifo()
  process.exit(1)
}, 90_000)
watchdog.unref()

/**
 * Whether a read is blocked in open() on the fixture FIFO, released if so. A
 * nonblocking open for WRITING succeeds only while some reader has the FIFO
 * open or is waiting in open() for a writer, and it wakes that reader. Measured
 * 2026-10-28 by the O_NONBLOCK mutant: without it the stuck libuv worker made
 * even process.exit() hang in uv_thread_join, past this watchdog.
 */
let fifoPath = ''
function releaseFifo(): boolean {
  if (!fifoPath) return false
  try {
    closeSync(openSync(fifoPath, fsConstants.O_WRONLY | fsConstants.O_NONBLOCK))
    return true
  } catch {
    return false
  }
}

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (rel: string): string => readFileSync(join(root, rel), 'utf8')

/** A fake secret body, deterministic and never written out whole (gotcha 157). */
const fake = (prefix: string, n: number, alphabet = 'Ab3Cd5Ef7Gh9Jk2Mn4Pq6Rs8Tu'): string =>
  prefix + Array.from({ length: n }, (_, i) => alphabet[(i * 7) % alphabet.length]).join('')

const scratchBase = mkdtempSync(join(tmpdir(), 'stoke-verify-work-mode-'))
requireScratch(scratchBase, 'the fixture root')
const base = realpathSync.native(scratchBase)

/* -------------------------------------------------------- registration */

console.log('registration: the package, the catalog, the Settings row, the palette')
{
  check('Work and Grok Bot keep their places ([0], [1]): packageManager and verify:plugins read them by index', [BUILTIN_PACKAGES[0].id, BUILTIN_PACKAGES[1].id], ['work', 'grok-bot'])
  const mine = BUILTIN_PACKAGES.filter((p) => p.id === 'work-mode')
  check('exactly one work-mode built-in, named Work mode, with no permissions', mine.map((p) => [p.kind, p.name, p.permissions, p.panel.actions.length, Object.keys(p.files).length]), [['builtin', 'Work mode', [], 0, 0]])
  check('the catalog lists it once', PLUGIN_CATALOG.filter((e) => e.package.id === 'work-mode').length, 1)
  check('a marketplace link for it is accepted', pluginInstallLink('stoke://plugins/install?id=work-mode'), 'work-mode')
  const pkg = mine[0]
  check('a package naming it cannot add code: the clean built-in comes back', parsePluginPackage({ ...pkg, files: { 'evil.mjs': 'x' } }, true), pkg)
  const row = SETTING_ROWS.find((r) => r.id === 'plugins.work-mode')
  check('SETTING_ROWS has plugins.work-mode, the plugin\'s own, landing on the manager when not drawn', [row?.plugin, row?.page, row?.fallback], ['work-mode', 'plugins', 'plugins.manager'])
  const off = settingsEntries({ agents: ['claude'], enabledPlugins: [] }).some((e) => e.row === 'plugins.work-mode')
  const on = settingsEntries({ agents: ['claude'], enabledPlugins: ['work-mode'] }).some((e) => e.row === 'plugins.work-mode')
  check('search finds the row only while the plugin is enabled', [off, on], [false, true])
  check('"characters per key" finds the row first', searchSettings(settingsEntries({ agents: ['claude'], enabledPlugins: ['work-mode'] }), 'characters per key')[0]?.entry.row, 'plugins.work-mode')
  check('the standing palette actions are unchanged', PALETTE_ACTIONS.map((a) => a.id), ['private'])
  check('Work mode is an action only while enabled', [paletteActions({ workMode: false }).map((a) => a.id), paletteActions({ workMode: true }).map((a) => a.id)], [['private'], ['private', 'work-mode']])
  const hits = searchPaletteActions('work mode', paletteActions({ workMode: true }))
  check('"work mode" finds the action by its label (tier 6)', hits.map((h) => `${h.action.id}:${h.score}`), ['work-mode:6'])
  check('and "ide" or "boss" by its words', [searchPaletteActions('ide', [WORK_MODE_ACTION]).length, searchPaletteActions('boss', [WORK_MODE_ACTION]).length], [1, 1])
  const settingsHits = searchSettings(settingsEntries({ agents: ['claude'], enabledPlugins: ['work-mode'] }), 'work mode')
  const rows = paletteRows([], settingsHits.slice(0, 8), hits)
  check('in the palette the action comes before the settings row for "work mode"', rows[0]?.kind === 'action' && rows[0].hit.action.id, 'work-mode')
}

/* ------------------------------------------------------------- paths */

console.log('\nwhat may be listed, read or only shown (workModePathClass)')
{
  const cases: Array<[string, 'skip' | 'name' | 'read', string]> = [
    ['src/app.ts', 'read', 'source'],
    ['src/App.TSX', 'read', 'the extension is folded'],
    ['src/lib/tokenizer.ts', 'read', 'bystander: token is not a secret word'],
    ['src/keys.ts', 'read', 'bystander: keys alone is not api keys'],
    ['src/keyboard.ts', 'read', 'bystander'],
    ['design/tokens.css', 'read', 'bystander'],
    ['src/passwordReset.tsx', 'read', 'bystander: no separator after the word'],
    ['main.go', 'read', 'go'],
    ['lib/x.rb', 'read', 'ruby'],
    ['index.html', 'read', 'markup'],
    ['README.md', 'read', 'Markdown is a type now: read once it is picked'],
    ['docs/guide.md', 'read', 'Markdown in a docs folder'],
    ['notes.md', 'read', 'Markdown'],
    ['secrets.md', 'skip', 'a secret-named Markdown file is still never read'],
    ['package.json', 'name', 'shown only'],
    ['src/data.json', 'skip', 'data is never offered'],
    ['config.yaml', 'skip', 'config'],
    ['config.yml', 'skip', 'config'],
    ['Cargo.toml', 'name', 'a known name, shown only'],
    ['pyproject.toml', 'name', 'shown only'],
    ['settings.toml', 'skip', 'toml is never read'],
    ['app.ini', 'skip', 'ini is never read'],
    ['.env', 'skip', 'env'],
    ['.env.local', 'skip', 'env variant'],
    ['app/.env.production', 'skip', 'nested env'],
    ['.npmrc', 'skip', 'npm credentials'],
    ['.netrc', 'skip', 'netrc'],
    ['.git-credentials', 'skip', 'git credentials'],
    ['ssh/known_hosts', 'skip', 'known_hosts'],
    ['id_ed25519', 'skip', 'an ssh key'],
    ['keys/id_rsa.pub', 'skip', 'id_ prefix'],
    ['ops/id_deploy.sh', 'skip', 'id_ prefix, even on a code extension'],
    ['certs/server.pem', 'skip', 'pem'],
    ['certs/server.key', 'skip', 'key'],
    ['ios/dist.p12', 'skip', 'p12'],
    ['infra/prod.tfvars', 'skip', 'tfvars'],
    ['infra/terraform.tfstate', 'skip', 'tfstate'],
    ['config/credentials.js', 'skip', 'credential-named'],
    ['src/secrets.ts', 'skip', 'secret-named'],
    ['src/password-strength.ts', 'skip', 'errs towards skipping'],
    ['src/api_keys.py', 'skip', 'api keys'],
    ['src/private-key.go', 'skip', 'private key'],
    ['deploy/service-account.ts', 'skip', 'service account'],
    ['secrets/app.ts', 'skip', 'a secret-named folder'],
    ['node_modules/x/index.js', 'skip', 'dependencies'],
    ['packages/a/node_modules/b.js', 'skip', 'nested dependencies'],
    ['dist/out.js', 'skip', 'build output'],
    ['vendor/lib.php', 'skip', 'vendor'],
    ['target/debug/main.rs', 'skip', 'cargo output'],
    ['.git/hooks/x.sh', 'skip', 'the git dir'],
    ['.github/workflows/ci.ts', 'skip', 'a dot-directory'],
    ['src/app.min.js', 'skip', 'minified'],
    ['src/app.js.map', 'skip', 'a map'],
    ['package-lock.json', 'skip', 'a lockfile'],
    ['Cargo.lock', 'skip', 'a lockfile'],
    ['x.lock', 'skip', 'any .lock'],
    ['src/__snapshots__/a.snap', 'skip', 'a snapshot'],
    ['src/a.generated.ts', 'skip', 'generated'],
    ['image.png', 'skip', 'binary, never shown'],
    ['.eslintrc.js', 'skip', 'a dotfile is never read'],
    ['src/../etc/passwd.ts', 'skip', 'a dot-dot segment'],
    ['', 'skip', 'nothing']
  ]
  const wrong = cases.filter(([p, want]) => workModePathClass(p) !== want).map(([p, want, why]) => `${p} → ${workModePathClass(p)} (want ${want}: ${why})`)
  check(`all ${cases.length} cases`, wrong, [])
  check('every readable extension is in the git pathspecs', Object.keys(WORK_MODE_LANGUAGES).every((e) => CODE_PATHSPECS.includes(`*.${e}`)), true)
  check('data and config are never readable: JSON, YAML, TOML, env, ini, text', ['json', 'jsonc', 'yaml', 'yml', 'toml', 'env', 'ini', 'txt', 'cfg', 'conf', 'properties'].filter((e) => e in WORK_MODE_LANGUAGES), [])
  // Item 5 (polish): Markdown is offered when the project has it, read through the same rules and redaction.
  check('Markdown is a readable type, with its own grammar, in the git pathspecs', [WORK_MODE_LANGUAGES.md, CODE_PATHSPECS.includes('*.md')], [{ label: 'Markdown', grammar: 'markdown' }, true])
  check('…and the only type never picked by default', [...NEVER_DEFAULT], ['md'])
  check('a Markdown line may run to WM_PROSE_LINE_MAX_CHARS (a paragraph is one line); code keeps WM_LINE_MAX_CHARS', [lineCapOf('md'), lineCapOf('ts'), lineCapOf('css')], [WM_PROSE_LINE_MAX_CHARS, WM_LINE_MAX_CHARS, WM_LINE_MAX_CHARS])
}

/* ------------------------------------------------------- types, picks */

console.log('\ntypes and picks')
{
  const T = (pairs: Array<[string, number]>) => pairs.map(([ext, count]) => ({ ext, count }))
  check('ts 300, tsx 120, mjs 50: two (50·2 < 120)', defaultPicks(T([['ts', 300], ['tsx', 120], ['mjs', 50]])), ['ts', 'tsx'])
  check('js 10, css 6, html 4: all three', defaultPicks(T([['js', 10], ['css', 6], ['html', 4]])), ['js', 'css', 'html'])
  check('a single type gives itself, none gives none', [defaultPicks(T([['py', 3]])), defaultPicks([])], [['py'], []])
  check('a tie is decided the same way every time', [defaultPicks(T([['css', 5], ['ts', 5]])), defaultPicks(T([['ts', 5], ['css', 5]]))], [['css', 'ts'], ['css', 'ts']])
  check('countTypes counts readable extensions only, most first (Markdown counts, JSON does not)', countTypes(['a.ts', 'b.ts', 'c.css', 'README.md', 'x.json']), [{ ext: 'ts', count: 2 }, { ext: 'css', count: 1 }, { ext: 'md', count: 1 }])
  const types = T([['ts', 9], ['css', 4], ['html', 1]])
  check('remembered picks that vanished are dropped, the rest kept, most-used first', rememberedPicks(['go', 'css', 'ts'], types), ['ts', 'css'])
  check('none left: the defaults', rememberedPicks(['go'], types), ['ts', 'css'])
  // Item 2 (polish, prove Finding 2): unticking TS and ticking it again stored [tsx, ts, css], and the left typed .tsx (2 files), .ts (7) the right.
  const harbor = T([['ts', 7], ['css', 3], ['tsx', 2]])
  check('picks are ordered by the scan\'s counts whatever the tick order: [tsx, ts, css] is [ts, css, tsx]', [orderPicks(['tsx', 'ts', 'css'], harbor), rememberedPicks(['tsx', 'ts', 'css'], harbor), orderPicks(['css', 'go', 'tsx', 'css'], harbor)], [['ts', 'css', 'tsx'], ['ts', 'css', 'tsx'], ['css', 'tsx']])
  const harborFiles = (['tsx', 'ts', 'css', 'ts', 'tsx', 'ts'] as const).map((ext, i): WorkModeFile => ({ path: `src/f${i}.${ext}`, ext, text: 'const x = 1\n', eol: 'LF' }))
  const reticked = newSession(harborFiles, rememberedPicks(['tsx', 'ts', 'css'], harbor), 4, 1)
  check('so the left editor types the most-used picked type and the right the next', [reticked.groups[0].queue.map((i) => harborFiles[i].ext), [...new Set(reticked.groups[1].queue.map((i) => harborFiles[i].ext))]], [['ts', 'ts', 'ts'], ['css', 'tsx']])
  // Item 5: Markdown is never a default pick, however many files it has.
  check('Markdown is offered but never picked by default: md 40 and ts 3 picks ts; md alone picks nothing', [defaultPicks(T([['md', 40], ['ts', 3]])), defaultPicks(T([['md', 9]])), defaultPicks(T([['md', 30], ['css', 6], ['js', 5], ['html', 3]]))], [['ts'], [], ['css', 'js', 'html']])
  check('…and a remembered Markdown pick is kept (the owner chose it)', rememberedPicks(['md'], T([['ts', 4], ['md', 9]])), ['md'])
  check('a pick list must be unique known types, 1 to WM_PICKS_MAX', [validPicks(['ts']), validPicks([]), validPicks(['ts', 'ts']), validPicks(['exe']), validPicks('ts'), validPicks(Array(WM_PICKS_MAX + 1).fill('ts'))], [['ts'], null, null, null, null, null])
  const state = parseWorkModeState({ revision: 3, options: { charsPerKey: 99, panel: 'no' }, picks: { ['a'.repeat(32)]: { types: ['ts', 'bogus', 'ts'], at: 5 }, 'not-a-key': { types: ['ts'], at: 1 }, sample: { types: ['css'], at: 2 } } })
  check('the stored file is read leniently: clamped, unknown types and bad keys dropped', state, { schema: 1, revision: 3, options: { charsPerKey: 12, panel: true }, picks: { ['a'.repeat(32)]: { types: ['ts'], at: 5 }, sample: { types: ['css'], at: 2 } } })
  check('anything not an object is the empty state', [parseWorkModeState(null).picks, parseWorkModeState([1]).options.charsPerKey], [{}, WM_CHARS_DEFAULT])
  const many: Record<string, { types: string[]; at: number }> = {}
  for (let i = 0; i < WM_PROJECTS_MAX + 5; i++) many[i.toString(16).padStart(32, '0')] = { types: ['ts'], at: i }
  const kept = Object.keys(parseWorkModeState({ picks: many }).picks)
  check('at most WM_PROJECTS_MAX projects, the oldest dropped', [kept.length, kept.includes('0'.repeat(32))], [WM_PROJECTS_MAX, false])
}

/* ------------------------------------------------------- folder verdict */

console.log('\nwhich folders may be read at all')
{
  const posix = { home: '/Users/v', userData: '/Users/v/Library/Application Support/Stoke', privateRoots: ['/Users/v/Library/Application Support/Stoke/private'], rules: { sep: '/' as const, caseInsensitive: true } }
  const win = { home: 'C:\\Users\\v', userData: 'C:\\Users\\v\\AppData\\Roaming\\Stoke', privateRoots: [], rules: { sep: '\\' as const, caseInsensitive: true } }
  check('POSIX: the root and a top-level folder are too shallow', [workModeFolderVerdict('/', posix), workModeFolderVerdict('/Users', posix), workModeFolderVerdict('/tmp', posix)], ['shallow', 'shallow', 'shallow'])
  check('home itself, and above it, never', [workModeFolderVerdict('/Users/v', posix), workModeFolderVerdict('/Users/V/', posix)], ['home', 'home'])
  check('a project under home is fine', workModeFolderVerdict('/Users/v/dev/x', posix), 'ok')
  check('Stoke\'s own data and a private chat\'s folder never', [workModeFolderVerdict('/Users/v/Library/Application Support/Stoke/plugins', posix), workModeFolderVerdict('/Users/v/Library/Application Support/Stoke/private/abc', posix)], ['stoke', 'stoke'])
  check('Windows: a drive is shallow, home refused, a project fine', [workModeFolderVerdict('C:\\', win), workModeFolderVerdict('C:\\Users', win), workModeFolderVerdict('c:\\users\\V', win), workModeFolderVerdict('C:\\Users\\v\\src\\app', win), workModeFolderVerdict('C:\\Users\\v\\AppData\\Roaming\\Stoke', win)], ['shallow', 'shallow', 'home', 'ok', 'stoke'])
  const depths = ['/', '/Users', '/Users/v/x', 'C:\\', 'C:\\a\\b', '\\\\server\\share\\x']
  check('pathDepth is folderDepth (shared/remotePhone.ts), kept local so the chunk stays light', depths.map(pathDepth), depths.map(folderDepth))
}

/* --------------------------------------------- the folder each tab hands over */

console.log('\nthe folder Work mode reads for each kind of tab (gotcha 150)')
{
  const t = (over: Record<string, unknown>) => ({ kind: 'session', cwd: '/Users/v/dev/app', hostId: null, ...over })
  check('a local session: its folder', workModeFolder(t({}), null), '/Users/v/dev/app')
  check('an SSH tab: none (its cwd is the alias)', workModeFolder(t({ hostId: 'host-1', cwd: 'box' }), null), null)
  check('an Add-key tab: none', workModeFolder(t({ hostId: 'host-1', enrollHostId: 'host-1', cwd: 'box' }), null), null)
  check('a private chat: none (its folder is Stoke\'s scratch)', workModeFolder(t({ private: true, cwd: '/Users/v/Library/Application Support/Stoke/private/abc' }), null), null)
  check('a relative cwd: none', workModeFolder(t({ cwd: 'app' }), null), null)
  check('a New tab: the launcher\'s project, or none', [workModeFolder(t({ kind: 'new', cwd: '' }), '/Users/v/dev/site'), workModeFolder(t({ kind: 'new', cwd: '' }), null)], ['/Users/v/dev/site', null])
  check('another machine\'s session and a Grok Bot tab: none', [workModeFolder(t({ kind: 'remote' }), '/x/y'), workModeFolder(t({ kind: 'grok-bot' }), '/x/y')], [null, null])
  check('no tab: none', workModeFolder(null, '/x/y'), null)
}

/* ------------------------------------------------- choice, tree, toolchain */

console.log('\nwhich files are typed first, the explorer, the toolchain')
{
  const paths = ['src/cart.ts', 'src/index.ts', 'types/global.d.ts', 'tests/cart.test.ts', 'tools/x.ts', 'src/secrets.ts', 'src/style.css']
  const a = chooseCandidates(paths, ['ts'], 7).get('ts')!
  const b = chooseCandidates(paths, ['ts'], 7).get('ts')!
  check('deterministic per seed', a, b)
  check('src/ first, a barrel lower, typings and tests last', [a[0], a.indexOf('src/index.ts') > 0, a.slice(-2).sort()], ['src/cart.ts', true, ['tests/cart.test.ts', 'types/global.d.ts']])
  check('deeper than four folders costs a point a level', chooseCandidates(['a/b/c/d/e/f/deep.ts', 'a/near.ts'], ['ts'], 1).get('ts'), ['a/near.ts', 'a/b/c/d/e/f/deep.ts'])
  check('never a path that is not readable (secret-named, another type)', [a.includes('src/secrets.ts'), a.includes('src/style.css')], [false, false])
  const nodes = explorerNodes(['src/', 'src/b.ts', 'src/a.ts', 'README.md', 'src/lib/', 'src/lib/c.ts', 'app.js'])
  check('folders first, then files, each sorted', nodes.map((n) => n.name), ['src', 'app.js', 'README.md'])
  check('nested', nodes[0].children.map((n) => n.name), ['lib', 'a.ts', 'b.ts'])
  const many = Array.from({ length: WM_TREE_MAX + 50 }, (_, i) => `f${i}.ts`)
  const count = (ns: ReturnType<typeof explorerNodes>): number => ns.reduce((s, n) => s + 1 + count(n.children), 0)
  check('the tree respects its cap', count(explorerNodes(many)), WM_TREE_MAX)
  check('toolchain: vite, next, node, cargo, go, python, ruby, gradle, make', [
    toolchain(['package.json', 'vite.config.ts']), toolchain(['package.json', 'next.config.mjs']), toolchain(['package.json']), toolchain(['Cargo.toml']), toolchain(['go.mod']),
    toolchain(['pyproject.toml']), toolchain(['Gemfile']), toolchain(['build.gradle.kts']), toolchain(['Makefile'])
  ], ['vite', 'next', 'node', 'cargo', 'go', 'python', 'ruby', 'gradle', 'make'])
  const files = (exts: string[]): WorkModeFile[] => exts.map((ext, i) => ({ path: `f${i}.${ext}`, ext, text: 'x', eol: 'LF' }))
  check('queues: the left the first pick, the right the rest round-robin', windowQueues(files(['ts', 'css', 'ts', 'html', 'css']), ['ts', 'css', 'html']), { left: [0, 2], right: [1, 3, 4] })
  check('one pick: alternate', windowQueues(files(['ts', 'ts', 'ts']), ['ts']), { left: [0, 2], right: [1] })
  check('a first pick with no files gives way', windowQueues(files(['css', 'html']), ['ts', 'css', 'html']), { left: [0], right: [1] })
  check('a single file goes to both', windowQueues(files(['go']), ['go']), { left: [0], right: [0] })
}

/* --------------------------------------------- main's reader, real fs and git */

console.log('\nmain\'s reader against real folders and a real git')
const gitBin = await findGit(process.env.PATH ?? '')
const globalConfig = join(base, 'gitconfig')
writeFileSync(globalConfig, '')
const env: NodeJS.ProcessEnv = {
  ...gitEnv(process.env),
  GIT_CONFIG_GLOBAL: globalConfig,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Stoke Verify',
  GIT_AUTHOR_EMAIL: 'verify@example.invalid',
  GIT_COMMITTER_NAME: 'Stoke Verify',
  GIT_COMMITTER_EMAIL: 'verify@example.invalid'
}
const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const home = join(base, 'home')
mkdirSync(join(home, '.config'), { recursive: true })
writeFileSync(join(home, '.gitconfig'), '[stoke]\n\tverify = scratch\n')
const readerEnv: NodeJS.ProcessEnv = { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, '.config') }
const userData = join(base, 'userData')
let gitCalls = 0
const reader = (over: Partial<ConstructorParameters<typeof WorkModeReader>[0]> = {}): WorkModeReader =>
  new WorkModeReader({
    userData,
    home,
    platform: process.platform,
    git: async () => (gitCalls++, gitBin),
    env: async () => readerEnv,
    enabled: async () => true,
    privateRoots: () => [join(userData, 'private')],
    ...over
  })

const put = (path: string, text: string | Buffer): void => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}
/** A plausible source file over the size floor, carrying `marker`. */
const code = (marker: string, lines = 30): string =>
  Array.from({ length: lines }, (_, i) => `export function step${i}(value: number): number {\n  return value * ${i} // ${marker}\n}\n`).join('\n')

const CANARIES = ['CANARY_ENV', 'CANARY_IDKEY', 'CANARY_CRED', 'CANARY_NODEMOD', 'CANARY_DIST', 'CANARY_HUGE', 'CANARY_MINI', 'CANARY_NUL', 'CANARY_OUTSIDE', 'CANARY_ALIAS', 'CANARY_PARENTLINK', 'CANARY_SECRETNAME', 'CANARY_PWSTRENGTH', 'CANARY_FIFO', 'CANARY_HASHNAME']
/** A tracked file whose NAME is key-shaped (a hashed build artefact): never listed, never shown. */
const hashedName = `chunk-${fake('', 24)}.ts`
const repo = join(base, 'projects', 'shop')
const outside = join(base, 'outside')
// A key only the index's patterns catch, one only the key-shaped net catches, and one both do.
const patternsOnly = 'tangerine-harbour'
const netOnly = fake('', 32)
const both = fake('sk-' + 'ant-' + 'api03-', 40)
const appTs = [
  "import { formatPrice } from './lib/format'",
  '',
  `const dbPassword = '${patternsOnly}'`,
  `const cacheSeal = '${netOnly}'`,
  `export const anthropic = '${both}'`,
  '',
  code('APP_OK', 12)
].join('\n')
check('control: the patterns-only fixture is caught by the patterns and not by the net', [redactSecrets(`x = '${patternsOnly}'`).includes(patternsOnly) ? 'kept' : 'taken', redactKeyShaped(`const dbPassword = '${patternsOnly}'`).includes(patternsOnly) ? 'kept' : 'taken'], ['kept', 'kept'])
check('control: and the net-only fixture by the net alone', [redactSecrets(`const cacheSeal = '${netOnly}'`).includes(netOnly) ? 'kept' : 'taken', redactKeyShaped(`const cacheSeal = '${netOnly}'`).includes(netOnly) ? 'kept' : 'taken'], ['kept', 'taken'])
check('control: the dbPassword line is the patterns\' (keyed password)', redactSecrets(`const dbPassword = '${patternsOnly}'`).includes(patternsOnly), false)

put(join(repo, 'package.json'), '{ "name": "shop", "private": true }\n')
put(join(repo, 'vite.config.ts'), code('VITECONF', 10))
put(join(repo, 'README.md'), '# shop\n')
put(join(repo, 'src', 'app.ts'), appTs)
put(join(repo, 'src', 'lib', 'format.ts'), code('FORMAT_OK'))
put(join(repo, 'src', 'lib', 'cart.ts'), code('CART_OK'))
put(join(repo, 'src', 'components', 'Button.tsx'), code('BUTTON_OK').replace(/number/g, 'string'))
put(join(repo, 'src', 'styles', 'main.css'), Array.from({ length: 40 }, (_, i) => `.c${i} {\n  margin: ${i}px;\n  color: var(--x);\n}`).join('\n') + '\n')
put(join(repo, 'src', 'lib', 'types.d.ts'), code('TYPES_OK'))
put(join(repo, 'tests', 'cart.test.ts'), code('TEST_OK'))
put(join(repo, '.env'), `TOKEN=${fake('', 24)}\nCANARY_ENV=1\n` + 'x'.repeat(400))
put(join(repo, 'id_ed25519'), 'CANARY_IDKEY ' + 'x'.repeat(400))
put(join(repo, 'config', 'credentials.js'), code('CANARY_CRED'))
put(join(repo, 'node_modules', 'x', 'index.js'), code('CANARY_NODEMOD'))
put(join(repo, 'dist', 'out.js'), code('CANARY_DIST'))
put(join(repo, 'src', 'huge.ts'), code('CANARY_HUGE', 1200))
put(join(repo, 'src', 'bundle.js'), 'var a=' + JSON.stringify('CANARY_MINI'.padEnd(5000, 'z')) + ';\n')
put(join(repo, 'src', 'binary.ts'), Buffer.concat([Buffer.from(code('CANARY_NUL')), Buffer.from([0, 1, 2])]))
put(join(repo, 'src', 'secrets.ts'), code('CANARY_SECRETNAME'))
put(join(repo, 'src', 'password-strength.ts'), code('CANARY_PWSTRENGTH'))
put(join(repo, 'src', 'notes.txt'), code('CANARY_ALIAS'))
put(join(repo, 'src', 'pipe.ts'), code('CANARY_FIFO'))
put(join(repo, 'src', hashedName), code('CANARY_HASHNAME'))
put(join(repo, 'src', 'linked', 'inner.ts'), code('PARENTLINK_COMMITTED'))
put(join(outside, 'canary.ts'), code('CANARY_OUTSIDE'))
put(join(outside, 'linkdir', 'inner.ts'), code('CANARY_PARENTLINK'))
// A last-component link out of the folder, and one that stays inside it (only O_NOFOLLOW refuses the second).
symlinkSync(join('..', '..', '..', 'outside', 'canary.ts'), join(repo, 'src', 'link.ts'))
symlinkSync('notes.txt', join(repo, 'src', 'alias.ts'))
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'add', '-A', '-f')
git(repo, 'commit', '-q', '-m', 'init')
// After the commit: a PARENT folder swapped for a link out (only the realpath containment refuses it),
// and a tracked file swapped for a FIFO (only O_NONBLOCK keeps its open from blocking).
rmSync(join(repo, 'src', 'linked'), { recursive: true })
symlinkSync(join('..', '..', '..', 'outside', 'linkdir'), join(repo, 'src', 'linked'))
let fifo = false
if (process.platform !== 'win32') {
  rmSync(join(repo, 'src', 'pipe.ts'))
  try {
    execFileSync('mkfifo', [join(repo, 'src', 'pipe.ts')])
    fifo = true
    fifoPath = join(repo, 'src', 'pipe.ts')
  } catch {
    put(join(repo, 'src', 'pipe.ts'), code('PIPE_FALLBACK'))
  }
}
check('the fixture folder is a real repo and lists every trap', git(repo, 'ls-files').split('\n').filter((p) => /env|id_ed|credentials|node_modules|dist|huge|bundle|binary|secrets|password|link|alias|pipe|linked/.test(p)).length >= 14, true)

{
  const r = reader()
  gitCalls = 0
  const src = await r.source(repo)
  const json = JSON.stringify(src)
  if (fifo) {
    check('no read is left waiting in open() on a FIFO (it is opened O_NONBLOCK, gotcha 152)', releaseFifo(), false)
    // One check needs the FIFO; the later reads get a plain file in its place, so a regression fails here, by name, not by a hang.
    rmSync(fifoPath)
    fifoPath = ''
    put(join(repo, 'src', 'pipe.ts'), code('PIPE_RESTORED'))
  }
  check('it answers with files', [src.reason, src.files.length > 0], [null, true])
  check('no canary from any refused file reaches the answer', CANARIES.filter((c) => json.includes(c)), [])
  check('a key-shaped file name is not listed, counted or shown', [json.includes(hashedName), json.includes(hashedName.slice(6, 20))], [false, false])
  check('the fake keys come back [redacted], every layer', [json.includes(patternsOnly), json.includes(netOnly), json.includes(both)], [false, false, false])
  const app = src.files.find((f) => f.path === 'src/app.ts')
  check('…and the file around them is still there', [!!app, app?.text.includes('APP_OK'), (app?.text.match(/\[redacted\]/g) ?? []).length >= 3], [true, true, true])
  check('name, branch and toolchain', src.project, { name: 'shop', branch: 'main', toolchain: 'vite' })
  // Counted by path: a listed link, FIFO or over-cap file counts though it is never read.
  check('counts by type, by readable path (secret-named, dependency and build paths not counted; README.md is Markdown)', src.types, [{ ext: 'ts', count: 12 }, { ext: 'css', count: 1 }, { ext: 'js', count: 1 }, { ext: 'md', count: 1 }, { ext: 'tsx', count: 1 }])
  check('the default picks (Markdown, tied with css and js, is not one)', src.picks, ['ts', 'css', 'js'])
  check('every path sent is relative', [...src.files.map((f) => f.path), ...src.tree].filter((p) => p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('..')), [])
  check('no absolute path appears anywhere in the answer', [json.includes(base), json.includes(home), json.includes(repo)], [false, false, false])
  check('the explorer shows name-only files and code, never a skipped one', [src.tree.includes('README.md'), src.tree.includes('package.json'), src.tree.some((p) => /env|node_modules|dist|secrets/.test(p))], [true, true, false])
  check('one git run for the listing', gitCalls, 1)
  check('a CRLF file is reported as one', (await (async () => {
    put(join(repo, 'src', 'crlf.ts'), code('CRLF_OK').replace(/\n/g, '\r\n'))
    git(repo, 'add', 'src/crlf.ts')
    const fresh = reader()
    const s = await fresh.source(repo)
    return s.files.filter((f) => f.path === 'src/crlf.ts').map((f) => [f.eol, f.text.includes('\r')])
  })()), [['CRLF', false]])
  const sub = await reader().source(join(repo, 'src', 'lib'))
  check('a subfolder lists relative to itself', [sub.reason, sub.files.map((f) => f.path).sort()], [null, ['cart.ts', 'format.ts', 'types.d.ts']])
}

{
  console.log('\nrunning no repo code (gotcha 147)')
  const trap = join(base, 'projects', 'trap')
  put(join(trap, 'src', 'f.ts'), code('TRAP_OK'))
  git(trap, 'init', '-q', '-b', 'main')
  git(trap, 'add', '-A')
  git(trap, 'commit', '-q', '-m', 'init')
  const fsMarker = join(base, 'FSMONITOR_RAN')
  const filterMarker = join(base, 'FILTER_RAN')
  const hookMarker = join(base, 'INDEX_HOOK_RAN')
  const script = (name: string, marker: string, body = ''): string => {
    const p = join(base, name)
    writeFileSync(p, `#!/bin/sh\ntouch '${marker.replace(/\\/g, '/')}'\n${body}`)
    chmodSync(p, 0o755)
    return p.replace(/\\/g, '/')
  }
  git(trap, 'config', 'core.fsmonitor', script('fsmonitor.sh', fsMarker, 'exit 1\n'))
  git(trap, 'config', 'filter.ev.clean', script('clean.sh', filterMarker, 'cat\n'))
  writeFileSync(join(trap, '.git', 'info', 'attributes'), '* filter=ev\n')
  mkdirSync(join(trap, '.git', 'hooks'), { recursive: true })
  script(join('projects', 'trap', '.git', 'hooks', 'post-index-change'), hookMarker)
  const statDirty = (): void => {
    const t = new Date(Date.now() + 60_000 + Math.random() * 60_000)
    utimesSync(join(trap, 'src', 'f.ts'), t, t)
  }
  const clear = (): void => {
    for (const m of [fsMarker, filterMarker, hookMarker]) rmSync(m, { force: true })
  }
  // The controls run git as a person's shell would: without gitEnv's GIT_OPTIONAL_LOCKS=0, which alone stops the index write.
  const plainEnv: NodeJS.ProcessEnv = { ...env }
  delete plainEnv.GIT_OPTIONAL_LOCKS
  const plainGit = (...args: string[]): string => execFileSync('git', args, { cwd: trap, env: plainEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  clear()
  statDirty()
  plainGit('status', '--porcelain=v2')
  check('control: a plain git status runs the repo\'s fsmonitor hook, its clean filter and its index hook', [existsSync(fsMarker), existsSync(filterMarker), existsSync(hookMarker)], [true, true, true])
  clear()
  plainGit('ls-files', '-z', '--cached', '--', '*.ts')
  check('control: and a plain git ls-files runs the fsmonitor hook too (measured 2026-10-28, git 2.55)', existsSync(fsMarker), true)
  const prefix = await safeGitArgs(gitBin ?? 'git', trap, gitEnv(readerEnv), 2000)
  check('the shared prefix (safeGitArgs) holds every switch: no locks, fsmonitor off, the repo\'s filter emptied', [prefix?.[0], prefix?.includes('core.fsmonitor=false'), prefix?.includes('filter.ev.clean='), prefix?.includes('filter.ev.required=false')], ['--no-optional-locks', true, true, true])
  clear()
  statDirty()
  const r = reader()
  const scan = await r.scan(trap)
  const src = await reader().source(trap)
  check('the reader still answers', [scan.reason, src.files.map((f) => f.path)], [null, ['src/f.ts']])
  check('and ran none of the repo\'s code: no fsmonitor, no filter, no index hook', [existsSync(fsMarker), existsSync(filterMarker), existsSync(hookMarker)], [false, false, false])
}

{
  console.log('\na folder that is not a repository: the bounded walk')
  const plain = join(base, 'projects', 'plain')
  put(join(plain, 'src', 'a.ts'), code('WALK_OK'))
  put(join(plain, 'src', 'deep', 'b.py'), code('WALK_PY').replace(/export function/g, 'def').replace(/[{}:]/g, ''))
  put(join(plain, 'node_modules', 'x', 'c.ts'), code('CANARY_WALK_NODEMOD'))
  put(join(plain, '.hidden', 'd.ts'), code('CANARY_WALK_HIDDEN'))
  put(join(base, 'outside2', 'e.ts'), code('CANARY_WALK_LINKDIR'))
  symlinkSync(join('..', '..', 'outside2'), join(plain, 'linkdir'))
  let deep = join(plain, 'nest')
  for (let i = 0; i < WM_WALK_MAX_DEPTH + 2; i++) deep = join(deep, `d${i}`)
  put(join(deep, 'too-deep.ts'), code('CANARY_WALK_DEEP'))
  gitCalls = 0
  const src = await reader().source(plain)
  const json = JSON.stringify(src)
  check('it lists and reads the folder\'s code', src.files.map((f) => f.path).sort(), ['src/a.ts', 'src/deep/b.py'])
  check('never through a symlinked folder, never node_modules or a dot-folder, never past the depth', ['CANARY_WALK_NODEMOD', 'CANARY_WALK_HIDDEN', 'CANARY_WALK_LINKDIR', 'CANARY_WALK_DEEP'].filter((c) => json.includes(c)), [])
  check('and runs no git there', gitCalls, 0)
}

{
  console.log('\nin a repository only what git lists, and never through a parent link inside it (found in review)')
  // Tracked paths whose PARENT is swapped, after the commit, for a link to a secret-named or a hidden folder
  // INSIDE the project: the realpath containment passes, and only judging the realpath's own name refuses them.
  const inner = join(base, 'projects', 'inner-links')
  put(join(inner, 'src', 'app.ts'), code('INNER_APP_OK'))
  put(join(inner, 'src', 'conf', 'settings.ts'), code('INNER_COMMITTED'))
  put(join(inner, 'src', 'theme', 'tokens.ts'), code('INNER_COMMITTED_TOO'))
  put(join(inner, 'secrets', 'settings.ts'), code('CANARY_INNER_SECRETDIR'))
  put(join(inner, '.private', 'tokens.ts'), code('CANARY_INNER_DOTDIR'))
  git(inner, 'init', '-q', '-b', 'main')
  git(inner, 'add', '-A', '-f')
  git(inner, 'commit', '-q', '-m', 'init')
  rmSync(join(inner, 'src', 'conf'), { recursive: true })
  symlinkSync(join('..', 'secrets'), join(inner, 'src', 'conf'))
  rmSync(join(inner, 'src', 'theme'), { recursive: true })
  symlinkSync(join('..', '.private'), join(inner, 'src', 'theme'))
  const innerSeen = new Set<string>()
  for (let i = 0; i < 4; i++) {
    const s = JSON.stringify(await reader({ random: () => i / 5 }).source(inner))
    for (const c of ['INNER_APP_OK', 'CANARY_INNER_SECRETDIR', 'CANARY_INNER_DOTDIR']) if (s.includes(c)) innerSeen.add(c)
  }
  check('a parent link to a secret-named or hidden folder inside the project is never followed (the realpath is judged too)', [...innerSeen].sort(), ['INNER_APP_OK'])

  // .gitignore keeps a local config, and a scratch file at the top, out of git; one draft is untracked but not ignored.
  const ign = join(base, 'projects', 'ignoring')
  put(join(ign, 'src', 'app.ts'), code('IGN_APP_OK'))
  put(join(ign, '.gitignore'), 'config/local.ts\nscratch-notes.ts\n')
  put(join(ign, 'config', 'local.ts'), code('CANARY_IGNORED'))
  put(join(ign, 'scratch-notes.ts'), code('CANARY_IGNORED_TOP'))
  put(join(ign, 'src', 'draft.ts'), code('UNTRACKED_OK'))
  git(ign, 'init', '-q', '-b', 'main')
  git(ign, 'add', 'src/app.ts', '.gitignore')
  git(ign, 'commit', '-q', '-m', 'init')
  check('control: git says both are ignored, and the draft is not', git(ign, 'status', '--porcelain', '--ignored').split('\n').filter(Boolean).sort(), ['!! config/', '!! scratch-notes.ts', '?? src/draft.ts'])
  const ok = await reader().source(ign)
  const okJson = JSON.stringify(ok)
  check('an ignored file is never read, nor its name shown; an untracked one git does not ignore is typed', [ok.reason, okJson.includes('CANARY_IGNORED'), ok.tree.includes('scratch-notes.ts'), ok.tree.some((p) => p.startsWith('config')), okJson.includes('UNTRACKED_OK'), okJson.includes('IGN_APP_OK')], [null, false, false, false, true, true])
  // Each way the listing cannot run: git missing, an unsafe filter config (a name `-c` cannot carry), its deadline.
  const noGit = await reader({ git: async () => null }).source(ign)
  check('in a repository with no git to list it: no listing at all, never a walk', [noGit.reason, noGit.files.length, JSON.stringify(noGit).includes('CANARY_IGNORED')], ['unreadable', 0, false])
  const late = await reader({ timeouts: { list: 1 } }).source(ign)
  check('…nor past the listing\'s deadline', [late.reason, late.files.length, JSON.stringify(late).includes('CANARY_IGNORED')], ['slow', 0, false])
  git(ign, 'config', 'filter.a=b.clean', 'cat')
  const unsafe = await reader().source(ign)
  check('…nor when the repo\'s filter config cannot be emptied safely', [unsafe.reason, unsafe.files.length, JSON.stringify(unsafe).includes('CANARY_IGNORED')], ['unreadable', 0, false])
  // A repository with nothing committed yet: git still lists what it does not ignore.
  const fresh = join(base, 'projects', 'fresh')
  put(join(fresh, 'src', 'app.ts'), code('FRESH_OK'))
  put(join(fresh, '.gitignore'), 'config/\n')
  put(join(fresh, 'config', 'local.ts'), code('CANARY_FRESH_IGNORED'))
  git(fresh, 'init', '-q', '-b', 'main')
  const fr = JSON.stringify(await reader().source(fresh))
  check('a repository with nothing committed types what git does not ignore, never what it does', [fr.includes('FRESH_OK'), fr.includes('CANARY_FRESH_IGNORED')], [true, false])
}

{
  console.log('\na monorepo: main gets a turn while the listing is judged, and a type is ranked from a bounded pool (found in review)')
  const mono = join(base, 'projects', 'mono')
  mkdirSync(mono, { recursive: true })
  git(mono, 'init', '-q', '-b', 'main')
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: mono, env, input: code('MONO') }).toString().trim()
  // Index entries only (no files on disk): a scan lists, it reads nothing.
  const N = 20_000
  const entries = Array.from({ length: N }, (_, i) => `100644 ${blob}\tpackages/pkg-${i % 200}/src/module_${i}.${['ts', 'tsx', 'css'][i % 3]}`)
  execFileSync('git', ['update-index', '--index-info'], { cwd: mono, env, input: entries.join('\n') + '\n' })
  // Every turn the reader gives main goes through the global setImmediate (`yieldTurn`); node's own modules hold their own.
  const realImmediate = globalThis.setImmediate
  let turns = 0
  globalThis.setImmediate = ((fn: (...a: unknown[]) => void, ...args: unknown[]) => {
    turns++
    return realImmediate(fn, ...args)
  }) as typeof setImmediate
  let monoScan: Awaited<ReturnType<WorkModeReader['scan']>> | null = null
  try {
    monoScan = await reader().scan(mono)
  } finally {
    globalThis.setImmediate = realImmediate
  }
  // Both passes slice, the listing's (secret patterns) and the path rules' (gotcha 175: either alone would hide the other's loss).
  check(`${N.toLocaleString('en')} listed paths are judged in slices: main gets a turn every 1,000 in each pass (a whole 50,000 held it ~220 ms)`, [monoScan?.reason, monoScan?.types.reduce((n, t) => n + t.count, 0), turns >= (2 * N) / 1000], [null, N, true])
  // The listing's cap counts readable paths only: git prints untracked paths first and the index sorted, so a
  // dependency tree sorting before src/ (node_modules, an untracked one included) must not use the cap up.
  const deps = join(base, 'projects', 'deps-first')
  mkdirSync(deps, { recursive: true })
  git(deps, 'init', '-q', '-b', 'main')
  const depBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: deps, env, input: code('DEP') }).toString().trim()
  const depEntries = Array.from({ length: WM_LIST_MAX + 1 }, (_, i) => `100644 ${depBlob}\tnode_modules/dep-${i % 500}/lib/f${i}.js`)
  depEntries.push(`100644 ${depBlob}\tsrc/app.ts`, `100644 ${depBlob}\tsrc/cart.ts`)
  execFileSync('git', ['update-index', '--index-info'], { cwd: deps, env, input: depEntries.join('\n') + '\n', maxBuffer: 1 << 26 })
  const depScan = await reader().scan(deps)
  check('dependency paths sorting first never use up the listing\'s cap: the project\'s own code is still found', [depScan.reason, depScan.types], [null, [{ ext: 'ts', count: 2 }]])
  const oneType = Array.from({ length: 50_000 }, (_, i) => `packages/p${i % 300}/src/m${i}.ts`)
  const pool = chooseCandidates(oneType, ['ts'], 11).get('ts') ?? []
  check('a type with more paths than WM_RANK_POOL_MAX is ranked from a seeded sample of at most that many (all 50,000 held main ~100 ms)', [WM_RANK_POOL_MAX, pool.length <= WM_RANK_POOL_MAX, pool.length >= WM_RANK_POOL_MAX / 2, JSON.stringify(chooseCandidates(oneType, ['ts'], 11).get('ts')) === JSON.stringify(pool)], [2000, true, true, true])
  check('…while a type under it is ranked whole, as before', chooseCandidates(oneType.slice(0, 500), ['ts'], 11).get('ts')?.length, 500)
}

{
  console.log('\nMarkdown: offered when the project has it, never a default pick, read through the same rules and redaction (polish item 5)')
  const docs = join(base, 'projects', 'docs-too')
  for (const stem of ['queue', 'retry', 'worker', 'store', 'http', 'clock', 'jobs', 'batch']) put(join(docs, 'src', `${stem}.ts`), code(`MD_SRC_${stem.toUpperCase()}`))
  put(join(docs, 'tests', 'queue.test.ts'), code('MD_OWN_TEST'))
  const mdKey = fake('sk-' + 'ant-' + 'api03-', 40)
  const para = 'The queue retries a failed job with backoff and jitter, ' + 'so one flaky endpoint never stalls the rest of the batch. '.repeat(9)
  put(join(docs, 'README.md'), ['# Docs too', '', para.trim(), '', '```sh', `export ANTHROPIC_API_KEY=${mdKey}`, '```', '', ...Array.from({ length: 10 }, (_, i) => `- step ${i}: run the worker and watch the queue drain`)].join('\n') + '\n')
  put(join(docs, 'docs', 'guide.md'), ['## Running it', '', ...Array.from({ length: 14 }, (_, i) => `${i + 1}. Start worker ${i} with \`npm run worker\` and read its log.`)].join('\n') + '\n')
  put(join(docs, 'notes', 'secrets.md'), '# CANARY_SECRET_MD\n' + 'x '.repeat(200))
  put(join(docs, 'private-notes.md'), '# CANARY_IGNORED_MD\n' + 'x '.repeat(200))
  put(join(docs, '.gitignore'), 'private-notes.md\n')
  put(join(docs, 'config.json'), '{ "CANARY_JSON": 1 }' + ' '.repeat(400))
  put(join(docs, 'settings.yaml'), 'CANARY_YAML: 1\n' + 'x: y\n'.repeat(100))
  put(join(docs, 'tool.toml'), 'CANARY_TOML = 1\n' + 'x = 1\n'.repeat(100))
  git(docs, 'init', '-q', '-b', 'main')
  git(docs, 'add', '-A')
  git(docs, 'commit', '-q', '-m', 'init')
  const offered = await reader().scan(docs)
  check('the project\'s Markdown is offered with its count, and not picked by default', [offered.types.find((t) => t.ext === 'md')?.count, offered.picks], [2, ['ts']])
  const unpicked = await reader().source(docs)
  check('…so no Markdown is read until it is picked', unpicked.files.filter((f) => f.ext === 'md').length, 0)
  const pickedMd = await reader().pick(docs, ['md', 'ts'])
  check('picking it keeps it, most-used first (ts 9, md 2)', pickedMd.picks, ['ts', 'md'])
  const withMd = await reader().source(docs)
  const withJson = JSON.stringify(withMd)
  const readme = withMd.files.find((f) => f.path === 'README.md')
  check('a picked README is read, its 500-character paragraph line not refused as minified', [!!readme, readme?.text.includes(para.trim().slice(0, 80)), para.trim().length > WM_LINE_MAX_CHARS], [true, true, true])
  check('…and a key in its code block is masked, as in any file', [withJson.includes(mdKey), readme?.text.includes('ANTHROPIC_API_KEY=[redacted]')], [false, true])
  check('a secret-named or git-ignored Markdown file is never read; JSON, YAML and TOML never read nor offered', [['CANARY_SECRET_MD', 'CANARY_IGNORED_MD', 'CANARY_JSON', 'CANARY_YAML', 'CANARY_TOML'].filter((c) => withJson.includes(c)), withMd.types.map((t) => t.ext).sort()], [[], ['md', 'ts']])
  // Item 3 (polish): the explorer names the project's own test of a chosen file, so the build panel names a real test.
  check('the explorer names the project\'s own test of a chosen file (tests/queue.test.ts for src/queue.ts), though it is not typed', [withMd.files.some((f) => f.path === 'tests/queue.test.ts'), withMd.files.some((f) => f.path === 'src/queue.ts'), withMd.tree.includes('tests/queue.test.ts'), withMd.tree.includes('tests/')], [false, true, true, true])
}

{
  console.log('\ndeadlines, refusals, the disabled answer, one listing for two requests')
  mkdirSync(join(userData, 'plugins'), { recursive: true })
  const t0 = performance.now()
  let threw = false
  let answer: Awaited<ReturnType<WorkModeReader['source']>> | null = null
  try {
    answer = await reader({ timeouts: { list: 1, walk: 1, read: 1, file: 1 } }).source(repo)
  } catch {
    threw = true
  }
  const ms = performance.now() - t0
  check('with every deadline at 1 ms it resolves in under 500 ms and never throws', [threw, ms < 500], [false, true])
  check('…with a reason or some files, never a canary', [!!answer && (answer.reason !== null || answer.files.length > 0), CANARIES.filter((c) => JSON.stringify(answer).includes(c))], [true, []])
  check('the shipped deadlines (gotcha 175: the real ones, not a fake\'s)', WORK_MODE_TIMEOUTS, { config: 2000, list: 2500, walk: 1500, file: 1000, read: 3000, cache: 60_000 })
  const verdicts = await Promise.all([reader().scan(null), reader().scan('relative/path'), reader().scan('/'), reader().scan(home), reader().scan(join(userData, 'plugins')), reader().scan(join(base, 'nope')), reader().scan(`/x\u0000y`)])
  check('no folder, relative, root, home, Stoke\'s own, missing, a control character', verdicts.map((v) => v.reason), ['no-folder', 'no-folder', 'refused', 'refused', 'refused', 'unreadable', 'no-folder'])
  // A home and a userData known by a path through a link (macOS's /tmp, a symlinked home): the folder is a realpath, so both forms count.
  symlinkSync(home, join(base, 'home-link'))
  symlinkSync(userData, join(base, 'userData-link'))
  const linked = reader({ home: join(base, 'home-link'), userData: join(base, 'userData-link'), privateRoots: () => [join(base, 'userData-link', 'private')] })
  mkdirSync(join(userData, 'private', 'chat'), { recursive: true })
  check('a home or userData reached through a link is still refused (found driving a sandbox under /tmp)', [(await linked.scan(home)).reason, (await linked.scan(join(userData, 'plugins'))).reason, (await linked.scan(join(userData, 'private', 'chat'))).reason], ['refused', 'refused', 'refused'])
  gitCalls = 0
  const off = await reader({ enabled: async () => false }).source(repo)
  check('disabled: "disabled", nothing read, no git run at all', [off.reason, off.files.length, off.types.length, gitCalls], ['disabled', 0, 0, 0])
  gitCalls = 0
  const shared = reader()
  const [x, y] = await Promise.all([shared.source(repo), shared.source(repo)])
  check('two requests in one tick share one listing (one git run)', [gitCalls, x.types, y.types.length > 0], [1, x.types, true])
  gitCalls = 0
  await shared.scan(repo)
  check('and a scan right after reuses the cached listing', gitCalls, 0)
}

{
  console.log('\npicks and options are remembered, by a hash and never a path')
  const first = reader()
  // Item 2: saved most-used first, whatever order the boxes were ticked in (ts 12 files, css 1, tsx 1).
  const ticked = await first.pick(repo, ['tsx', 'css', 'ts'])
  const storedOrder = (JSON.parse(readFileSync(join(userData, 'plugins', 'work-mode.json'), 'utf8')) as { picks: Record<string, { types: string[] }> }).picks
  check('picks are saved most-used first, never in tick order (the left editor types the first)', [ticked.picks, storedOrder[picksKey(realpathSync.native(repo), pathRulesFor(process.platform))]?.types], [['ts', 'css', 'tsx'], ['ts', 'css', 'tsx']])
  check('…and come back that way', (await reader().scan(repo)).picks, ['ts', 'css', 'tsx'])
  const picked = await first.pick(repo, ['css'])
  check('a pick of a type the project has is kept', picked.picks, ['css'])
  const again = await reader().scan(repo)
  check('a new reader on the same userData remembers it', again.picks, ['css'])
  const stored = readFileSync(join(userData, 'plugins', 'work-mode.json'), 'utf8')
  check('work-mode.json names no folder', [stored.includes(repo), stored.includes('shop'), stored.includes(base), stored.includes(picksKey(realpathSync.native(repo), pathRulesFor(process.platform)))], [false, false, false, true])
  check('a type it does not have, or a bad list, changes nothing', [(await reader().pick(repo, ['go'])).picks, (await reader().pick(repo, 'css')).picks, (await reader().pick(repo, ['css', 'css'])).picks], [['css'], ['css'], ['css']])
  const sampled = await reader().pick(null, ['html'])
  check('with no folder the picks are the sample\'s, kept under its own key', [sampled.picks, (await reader().scan(null)).picks], [['html'], ['html']])
  const o = reader()
  check('characters per key: 99 is 12, 0 is 1, "x" is ignored', [(await o.options({ charsPerKey: 99 })).charsPerKey, (await o.options({ charsPerKey: 0 })).charsPerKey, (await o.options({ charsPerKey: 'x' })).charsPerKey, (await o.options({ charsPerKey: 2.5 })).charsPerKey], [12, 1, 1, 1])
  check('the panel switch takes a boolean only; unknown keys are ignored', [(await o.options({ panel: false })).panel, (await o.options({ panel: 'yes', other: 1 })).panel], [false, false])
  check('a disabled reader saves nothing', (await reader({ enabled: async () => false }).options({ charsPerKey: 7 })).charsPerKey, 1)
  writeFileSync(join(userData, 'plugins', 'work-mode.json'), '{ not json')
  const broken = reader()
  const sb = await broken.scan(repo)
  check('an unreadable store never stops it: defaults to read…', [sb.reason, sb.options.charsPerKey], [null, WM_CHARS_DEFAULT])
  check('…and a pick still holds for the run, without a throw', (await broken.pick(repo, ['tsx'])).picks, ['tsx'])
  check('never synced or exported: account sync and the setup file never name it', [read('src/main/hub/accountSync.ts').includes('work-mode'), read('src/shared/setupFile.ts').includes('work-mode')], [false, false])
}

/* ----------------------------------------------------------- redaction */

console.log('\nwhat is sent is cleaned (cleanForShow)')
{
  check('controls other than tab and newline go, both layers run', cleanForShow(`a\u0007b\tc\nd\u0085 key='${netOnly}' p='${both}'`), "ab\tc\nd key='[redacted]' p='[redacted]'")
  check('an invisible character inside a key does not split it from the patterns', cleanForShow(`k = '${both.slice(0, 12)}\u200b${both.slice(12)}'`), "k = '[redacted]'")
  check('nothing left is null', cleanForShow('\u0001\u0002 \n'), null)
}

/* --------------------------------------------------------- document model */

console.log('\nthe typing model')
const SAMPLE_DIR = join(root, 'src', 'renderer', 'src', 'assets', 'workModeSample')
const SAMPLE_PATHS = ['index.html', 'styles.css', 'app.js', 'js/cart.js', 'js/api.js']
const sampleFiles: WorkModeFile[] = SAMPLE_PATHS.map((p) => ({ path: p, ext: extOf(p), text: readFileSync(join(SAMPLE_DIR, p), 'utf8'), eol: 'LF' }))
const fixtures: WorkModeFile[] = [
  {
    path: 'fx/comments.js',
    ext: 'js',
    eol: 'LF',
    text: [
      '/* a block comment',
      '   that runs on */',
      'const tpl = `line one',
      '  ${value} and two`',
      'function f(a, b) {',
      '  const c = a + b',
      '  const d = c * 2',
      '  if (d > 3) {',
      '    return d',
      '  }',
      '  return c',
      '}',
      'const x = 1',
      'const y = 2',
      'const z = 3',
      'export default f',
      ''
    ].join('\n')
  },
  {
    path: 'fx/triple.py',
    ext: 'py',
    eol: 'LF',
    text: ['def f(x):', '    """Docs', '    over lines"""', '    y = x + 1', '    z = y * 2', '    return z', '', 'class A:', '    a = 1', '    b = 2', '    c = 3', 'print(f(1))', ''].join('\n')
  },
  {
    path: 'fx/style.css',
    ext: 'css',
    eol: 'LF',
    text: ['.a {', '  color: red;', '  margin: 0;', '  padding: 0;', '}', '/* c', 'd */', '.b {', '  color: blue;', '  border: 0;', '}', ''].join('\n')
  },
  {
    path: 'fx/README.md',
    ext: 'md',
    eol: 'LF',
    text: [
      '# Harbor queue',
      '',
      'A small job queue with retries, backoff and a dashboard. See [the guide](docs/guide.md) for more.',
      '',
      '## Install',
      '',
      '```ts',
      "import { createQueue } from './src/queue'",
      'const queue = createQueue({ concurrency: 4 })',
      '```',
      '',
      '- Run `npm run dev` to start the dashboard.',
      '- Run `npm test` to run the tests.',
      '1. Open <http://localhost:5173>.',
      '',
      '> Jobs are retried three times before they fail.',
      '',
      '| Option | Default |',
      '| --- | --- |',
      '| concurrency | 4 |',
      '',
      '---',
      'Released under the MIT licence.',
      ''
    ].join('\n')
  }
]
const corpus = [...sampleFiles, ...fixtures]
{
  const invariants = (f: PreparedFile, d: DocState): string | null => {
    let lastRef = -1
    for (const row of docRows(f, d)) {
      if (row.ref <= lastRef) return `rows out of order at ${row.ref}`
      lastRef = row.ref
      if (!f.lines[row.ref].startsWith(row.text)) return `row ${row.ref} is not a prefix of its line`
      if (d.typed[row.ref] === f.lines[row.ref].length && row.text !== f.lines[row.ref]) return `complete row ${row.ref} differs`
    }
    if (!d.done && d.typed[d.caret] < 0) return 'the caret is on an absent line'
    return null
  }
  let broken: string[] = []
  for (const file of corpus) {
    const f = prepareFile(file, 1234)
    const rng = seededRandom(hashSeed(file.path))
    let d = newDoc(f)
    for (let step = 0; step < 2000 && !d.done; step++) {
      const r = rng()
      if (r < 0.7) d = typeChars(f, d, 1 + Math.floor(rng() * 12))
      else if (r < 0.85) {
        const rows = docRows(f, d).length
        const first = Math.floor(rng() * Math.max(1, rows))
        const t = aimTarget(f, d, Math.floor(rng() * (rows + 4)), { first, last: first + 40 })
        if (t !== null) d = aimAt(f, d, t)
      } else d = fillLine(f, d)
      const bad = invariants(f, d)
      if (bad) {
        broken.push(`${file.path} step ${step}: ${bad}`)
        break
      }
    }
  }
  check('2,000 seeded steps (type 1-12, aim, fill) over every sample file and three fixtures keep every invariant', broken, [])

  broken = []
  for (const file of corpus) {
    const f = prepareFile(file, 99)
    let d = newDoc(f)
    let checkedWrap = false
    for (let guard = 0; guard < 400_000 && !d.done; guard++) {
      const len = f.lines[d.caret].length
      if (d.typed[d.caret] === len) {
        const s = nextSlot(f, d, d.caret)
        if (s !== null && s < d.caret && !checkedWrap) {
          checkedWrap = true
          // Typing alone to the end: every line but the holes, whole, and exactly the holes missing.
          const missing = f.lines.map((_, i) => i).filter((i) => d.typed[i] < 0)
          const holes = f.skip.map((s2, i) => (s2 ? i : -1)).filter((i) => i >= 0)
          const partial = f.lines.map((_, i) => i).filter((i) => d.typed[i] >= 0 && d.typed[i] !== f.lines[i].length)
          if (JSON.stringify(missing) !== JSON.stringify(holes) || partial.length) broken.push(`${file.path}: missing ${missing.length} holes ${holes.length} partial ${partial.length}`)
        }
      }
      d = typeChars(f, d, 1)
    }
    const text = docRows(f, d).map((r) => r.text).join('\n')
    if (text !== f.lines.join('\n')) broken.push(`${file.path}: the end is not the reference`)
    if (!checkedWrap && f.skip.some(Boolean)) broken.push(`${file.path}: never wrapped back for its holes`)
  }
  check('typing alone reaches the end missing exactly the holes, then goes back and fills them to the exact reference', broken, [])

  const holesSeen = corpus.map((file) => prepareFile(file, 4242)).reduce((n, f) => n + f.skip.filter(Boolean).length, 0)
  check('the corpus has holes to test (or the checks above prove little)', holesSeen > 20, true)
  broken = []
  for (const file of corpus) {
    for (let seed = 1; seed <= 24; seed++) {
      const f = prepareFile(file, seed)
      let run = 0
      f.skip.forEach((s, i) => {
        run = s ? run + 1 : 0
        if (run > WM_SKIP_RUN_MAX) broken.push(`${file.path}#${seed}: a run of ${run} at ${i}`)
        if (!s) return
        if (i === 0 || i === f.lines.length - 1) broken.push(`${file.path}#${seed}: a hole on the first or last line`)
        if (!skippable(f, i)) broken.push(`${file.path}#${seed}: hole ${i} is not skippable`)
        const r = tokenizeLine(f.grammar, f.lines[i], f.states[i], f.lang)
        if (!isPlainState(f.grammar, f.states[i])) broken.push(`${file.path}#${seed}: hole ${i} starts inside something`)
        if (bracketBalance(r.tokens.filter((t) => t.kind === 'punct').map((t) => t.text)) !== 0) broken.push(`${file.path}#${seed}: hole ${i} changes bracket depth`)
        if ((f.grammar === 'html' || f.grammar === 'jsx') && tagBalance(f.lines[i]) !== 0) broken.push(`${file.path}#${seed}: hole ${i} opens a tag`)
      })
    }
  }
  check('every hole meets every rule: not first or last, plain start, balanced, no tag, at most WM_SKIP_RUN_MAX in a row', broken, [])
  // Every middle line skippable, many seeds: runs reach the cap (so the check can bite) and never pass it.
  const flat = { path: 'fx/flat.js', ext: 'js', eol: 'LF' as const, text: Array.from({ length: 80 }, (_, i) => `const v${i} = ${i}`).join('\n') + '\n' }
  let longest = 0
  for (let seed = 1; seed <= 60; seed++) {
    let run = 0
    for (const sk of prepareFile(flat, seed).skip) {
      run = sk ? run + 1 : 0
      longest = Math.max(longest, run)
    }
  }
  check(`runs of holes reach WM_SKIP_RUN_MAX (${WM_SKIP_RUN_MAX}) and never pass it`, longest, WM_SKIP_RUN_MAX)
  const blockLine = prepareFile(fixtures[0], 1)
  check('no hole inside a block comment or a template', [blockLine.skip[1], blockLine.skip[3]], [false, false])
  check('a line that opens a block, or follows a block\'s colon, is never a hole', [skippable(blockLine, 4), skippable(blockLine, 7), skippable(prepareFile(fixtures[1], 1), 8)], [false, false, false])
  // Line 3 passes every other rule (plain, not first or last, no indent after, no continuation before): only its brackets refuse it.
  const closing = prepareFile({ path: 'fx/close.js', ext: 'js', eol: 'LF', text: 'function a() {\n  run(() => {\n    step()\n  }).then(done)\n  return 1\n}\n' }, 1)
  check('a line that closes a bracket it did not open is never a hole', skippable(closing, 3), false)
  check('a plain, balanced line in the middle can be', [skippable(blockLine, 13), skippable(prepareFile(fixtures[1], 1), 3)], [true, true])

  const g = prepareFile({ path: 'x.js', ext: 'js', text: 'function a() {\n    return x\n}\n', eol: 'LF' }, 1)
  let e = typeChars(g, newDoc(g), 'function a() {'.length)
  e = typeChars(g, e, 1)
  check('the newline costs one and brings the indentation', docRows(g, e).map((r) => r.text), ['function a() {', '    '])
  e = typeChars(g, e, 4)
  check('then four characters show "    retu"', docRows(g, e)[1].text, '    retu')
  const blanks = prepareFile({ path: 'b.js', ext: 'js', text: 'a\n\n\nb\n', eol: 'LF' }, 1)
  let bd = typeChars(blanks, newDoc(blanks), 1)
  bd = typeChars(blanks, bd, 1)
  const afterOne = docRows(blanks, bd).length
  bd = typeChars(blanks, bd, 1)
  check('each blank line costs one', [afterOne, docRows(blanks, bd).length], [2, 3])

  // aimTarget, on a document with holes at 9 and 14 (forced, so the case is fixed).
  const af = prepareFile(fixtures[0], 1)
  const forced: PreparedFile = { ...af, skip: af.lines.map((_, i) => i === 9 || i === 14) }
  let ad = newDoc(forced)
  for (let i = 0; i < 2000 && !(ad.caret === 15 && ad.typed[15] === forced.lines[15].length); i++) ad = typeChars(forced, ad, 1)
  check('fixture: typed to the last line, the holes at 9 and 14 left', [ad.typed[9], ad.typed[14], ad.caret], [-1, -1, 15])
  check('the nearest slot in view: a hole, anchored where it would be inserted', [aimTarget(forced, ad, 9, { first: 0, last: 30 }), aimTarget(forced, ad, 13, { first: 0, last: 30 })], [9, 14])
  const on9 = aimAt(forced, ad, 9)
  check('aiming starts the hole with its indentation', [on9.caret, on9.typed[9]], [9, 2])
  check('the current slot is kept within a row of the best, and left beyond it', [aimTarget(forced, on9, 12, { first: 0, last: 30 }), aimTarget(forced, on9, 13, { first: 0, last: 30 })], [9, 14])
  check('nothing in view: the frontier\'s slot (here, back to the first hole)', aimTarget(forced, ad, 500, { first: 400, last: 450 }), 9)
  check('a fill adds exactly one whole line at the aimed spot', (() => {
    const filled = fillLine(forced, on9)
    return [filled.typed[9] === forced.lines[9].length, filled.typed[14]]
  })(), [true, -1])
}

/* ------------------------------------------------- soft wrap: visual rows */

console.log('\nsoft wrap: no sideways scroll, every row fits, the caret and the aim in visual rows (polish item 1)')
{
  // A long line wraps where VS Code's word wrap would: after a space or `})]?|/&.,;`, before `([{+`, mid-word only when it must.
  const rowsOf = (t: string, cols: number, ind = 0): string[] => {
    const st = wrapStarts(t, cols, ind)
    return st.map((a, i) => t.slice(a, st[i + 1] ?? t.length))
  }
  check('a line wraps at a word boundary: after the space, before the call', rowsOf('const value = compute(alpha, beta)', 20), ['const value = ', 'compute(alpha, beta)'])
  check('…after a slash in a path, and continuation rows are measured without the kept indentation', rowsOf('  return fetchJson(`${base}/jobs/${id}`, { method: "POST", body })', 30, 2), ['  return fetchJson(`${base}/', 'jobs/${id}`, { method: ', '"POST", body })'])
  check('a word wider than a row breaks inside it, and only then', rowsOf('a'.repeat(25), 10), ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)])
  check('a space may hang one column past the row, as in VS Code', rowsOf('aaaa bbbb cccc', 9), ['aaaa bbbb ', 'cccc'])
  check('wide characters take two columns, and a surrogate pair is never split', [rowsOf('日本語のテキストです', 8), rowsOf('ab😀cd😀ef', 3).every((r) => !/^[\udc00-\udfff]|[\ud800-\udbff]$/.test(r))], [['日本語の', 'テキスト', 'です'], true])
  check('columns per row: the code area in characters, less the gutter and WRAP_RESERVE (575 px at 7.83 px, a 5-column gutter: 66)', [wrapColumns(575, 7.83, 5), wrapColumns(40, 7.83, 5), WRAP_RESERVE, WRAP_MIN_COLS], [66, WRAP_MIN_COLS, 2, 8])
  check('continuation rows keep the line\'s indentation while WRAP_MIN_TEXT columns remain, else start at 0', [wrapIndent(8, 66), wrapIndent(46, 66), wrapIndent(47, 66), wrapIndent(8, 30), wrapIndent(16, 30), WRAP_MIN_TEXT], [8, 46, 0, 8, 0, 20])

  // Every file of the corpus plus long-line fixtures, at many widths, every step of a typing session: no row is wider than its width.
  const longLines: WorkModeFile = {
    path: 'fx/long.tsx',
    ext: 'tsx',
    eol: 'LF',
    text: [
      "import React, { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState } from 'react'",
      '',
      'export function JobTable({ jobs, onRetry, onCancel, selected, filter, sort }: JobTableProps): React.JSX.Element {',
      '    const visible = useMemo(() => jobs.filter((job) => matchesFilter(job, filter)).sort(compareBy(sort)), [jobs, filter, sort])',
      '    return <table className="job-table" aria-label="Jobs">{visible.map((job) => <JobRow key={job.id} job={job} selected={selected === job.id} />)}</table>',
      '}',
      'const url = "https://api.harbor.example.invalid/v1/queues/' + 'x'.repeat(150) + '"',
      ''
    ].join('\n')
  }
  const wrapCorpus = [...corpus, longLines]
  const problems: string[] = []
  for (const file of wrapCorpus) {
    const f = prepareFile(file, 7)
    // One cache across every width, as the editor keeps it through a window resize: a key that forgot the width would show here.
    const cache = new Map<number, LineWrap>()
    for (const cols of [12, 20, 33, 40, 57, 66, 80]) {
      let d = newDoc(f)
      for (let step = 0; step < 600 && !d.done && problems.length < 5; step++) {
        d = typeChars(f, d, 1 + (step % 9))
        const lay = wrapLayout(f, d, cols, cache)
        const fresh = wrapLayout(f, d, cols)
        if (JSON.stringify([...fresh.tops]) !== JSON.stringify([...lay.tops])) problems.push(`${file.path}@${cols}: the cache changed the layout`)
        lay.refs.forEach((ref, k) => {
          const text = f.lines[ref].slice(0, d.typed[ref])
          const st = lay.wraps[k].starts
          const rows = st.map((a, i) => text.slice(a, st[i + 1] ?? text.length))
          if (rows.join('') !== text) problems.push(`${file.path}@${cols} line ${ref}: rows do not join to the line`)
          rows.forEach((r, i) => {
            const room = (i === 0 ? cols : cols - lay.wraps[k].indent) + (r.endsWith(' ') ? 1 : 0)
            if (textColumns(r) > room) problems.push(`${file.path}@${cols} line ${ref} row ${i}: ${textColumns(r)} columns in ${room}`)
            if (i > 0 && r.length === 0) problems.push(`${file.path}@${cols} line ${ref}: an empty row`)
          })
          if (lay.tops[k + 1] - lay.tops[k] !== st.length) problems.push(`${file.path}@${cols}: tops do not count the rows`)
        })
        const cv = caretVisual(f, d, lay)
        if (!d.done && (!cv || cv.col > cols + 1)) problems.push(`${file.path}@${cols}: the caret is past the row (${cv?.col})`)
      }
    }
  }
  check('every row of every line fits its width (cols, a continuation row cols less its indent, a hanging space one more), at 7 widths, every step, and joins back to the line', problems, [])

  // The caret is drawn at the end of its line's LAST visual row; the band covers all of them; the pointer aims by visual row.
  const text = ['const a = 1', '  const longer = [' + Array.from({ length: 12 }, (_, i) => `item${i}`).join(', ') + ']', '  const b = 2', '  const c = 3', 'export { a }', ''].join('\n')
  const base0 = prepareFile({ path: 'fx/aim.ts', ext: 'ts', text, eol: 'LF' }, 1)
  const forced: PreparedFile = { ...base0, skip: base0.lines.map((_, i) => i === 2) }
  let d = newDoc(forced)
  for (let i = 0; i < 400 && !(d.caret === 3 && d.typed[3] === forced.lines[3].length); i++) d = typeChars(forced, d, 1)
  const lay = wrapLayout(forced, d, 24)
  check('fixture: line 2 a hole, the long line 1 wraps to five visual rows (tops 0, 1, 6, 7)', [d.typed[2], [...lay.tops], lay.wraps[1].starts.length], [-1, [0, 1, 6, 7], 5])
  check('the caret is on the visual row of its line\'s end, at its column', caretVisual(forced, d, lay), { row: 6, col: 13 })
  check('a visual row belongs to its line; rows past the end count a line each', [0, 1, 3, 5, 6, 7, 9].map((r) => lineOfVisual(lay.tops, r)), [0, 1, 1, 1, 2, 3, 5])
  // Old behaviour (a row is a line) read the pointer on the long line's fourth visual row as line 3 and aimed past the end of the file.
  check('a pointer on the long line\'s fourth visual row aims at the hole right under that line, not past the end of the file', [aimTarget(forced, d, 3, { first: 0, last: 20 }, lay.tops), aimTarget(forced, d, 7, { first: 0, last: 20 }, lay.tops)], [2, 4])
  check('…and the reducer passes the visual rows through (an aim then a fill fills the hole)', (() => {
    const s0 = newSession([{ path: 'fx/aim.ts', ext: 'ts', text, eol: 'LF' }], ['ts'], 1, 1)
    let s1: Session = { ...s0, prepared: [forced], groups: [{ ...s0.groups[0], tabs: [{ file: 0, doc: d }], active: 0 }, s0.groups[1]] }
    s1 = reduceWorkMode(s1, { kind: 'aim', group: 0, row: 3, view: { first: 0, last: 20 }, tops: lay.tops })
    s1 = reduceWorkMode(s1, { kind: 'fill', group: 0 })
    const doc = s1.groups[0].tabs[0].doc
    return [doc.caret, doc.typed[2] === forced.lines[2].length]
  })(), [2, true])
  check('tokens split across visual rows lose nothing and keep their kinds', (() => {
    const line = forced.lines[1]
    const toks = tokenizeLine(forced.grammar, line, forced.states[1], forced.lang).tokens
    const rows = splitTokens(toks, lay.wraps[1].starts)
    return [rows.length, rows.map((r) => r.map((t) => t.text).join('')).join('') === line, rows.flat().every((t) => t.text.length > 0), rows.flat().filter((t) => t.kind === 'number').length >= 0]
  })(), [5, true, true, true])

  // The wire into the editor, by source text: nothing scrolls sideways, and the residual offset (prove Finding 1a) is gone.
  const editor = read('src/renderer/src/components/WorkModeEditor.tsx')
  const css = read('src/renderer/src/styles/workMode.css')
  const codeRule = css.match(/\.wm-code \{[^}]*\}/)?.[0] ?? ''
  check('the code area never scrolls sideways (overflow-x: hidden, a stable scrollbar gutter) and the gutter is not sticky', [/overflow-x: hidden/.test(codeRule), /scrollbar-gutter: stable/.test(codeRule), /\.wm-gutter \{[^}]*position: sticky/.test(css)], [true, true, false])
  check('the editor sets scrollLeft only to 0, never follows the caret sideways, and the gutter - 24 offset is gone', [[...editor.matchAll(/scrollLeft = ([^\n;]+)/g)].map((m) => m[1].trim()), /gutter - 24|scrollTo\(\{[^}]*left/.test(editor)], [['0', '0'], false])
  check('it lays out with wrapLayout, numbers only a line\'s first visual row, and passes the rows\' tops with the pointer', [/wrapLayout\(file, doc, cols, wrapCache\.current\.map\)/.test(editor), /\{k === 0 \? number : ''\}/.test(editor), /onPointer\(group, rowAt\(el, e\.clientY\), viewOf\(el\), layoutRef\.current\?\.tops/.test(editor), /onPress\(group, rowAt\(el, e\.clientY\), viewOf\(el\), layoutRef\.current\?\.tops/.test(editor)], [true, true, true, true])
  const wmRoot = read('src/renderer/src/components/WorkMode.tsx')
  check('…and the root hands those tops to the reducer\'s aim', (wmRoot.match(/dispatch\(\{ kind: 'aim', group, row, view, tops: tops \?\? undefined \}\)/g) ?? []).length, 2)
}

function hashSeed(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0
  return h
}

/* --------------------------------------------------------- session reducer */

console.log('\nthe session: two editors, their files, their tabs')
{
  const tiny = (path: string, ext: string): WorkModeFile => ({ path, ext, text: `const ${path.replace(/\W/g, '_')} = 1\n`, eol: 'LF' })
  const files = [tiny('a.ts', 'ts'), tiny('b.tsx', 'tsx'), tiny('c.css', 'css'), tiny('d.ts', 'ts'), tiny('e.tsx', 'tsx'), tiny('f.ts', 'ts')]
  let s: Session = newSession(files, ['ts', 'tsx', 'css'], 4, 11)
  const leftAllowed = new Set(s.groups[0].queue)
  const rightAllowed = new Set(s.groups[1].queue)
  check('the left queue is the first pick\'s files, the right the rest', [s.groups[0].queue.map((i) => files[i].ext), s.groups[1].queue.map((i) => files[i].ext)], [['ts', 'ts', 'ts'], ['tsx', 'css', 'tsx']])
  let strayed = false
  const opened: number[][] = [[], []]
  for (let i = 0; i < 600; i++) {
    if (i % 50 === 0) s = reduceWorkMode(s, { kind: 'focus', group: ((i / 50) % 2) as 0 | 1 })
    const before = s.groups.map((g) => g.tabs.length)
    s = reduceWorkMode(s, { kind: 'type' })
    s.groups.forEach((g, gi) => {
      for (const t of g.tabs) if (!(gi === 0 ? leftAllowed : rightAllowed).has(t.file)) strayed = true
      if (g.tabs.length > before[gi]) opened[gi].push(g.tabs[g.tabs.length - 1].file)
    })
  }
  check('600 keys, both groups: the left only ever types its files, the right only its own', strayed, false)
  check('at a file\'s end the next file opens in a new tab of the same group', [opened[0].slice(0, 2), opened[1].slice(0, 2)], [[3, 5], [2, 4]])
  check('an exhausted queue cycles back to its first file', s.groups[0].tabs.some((t) => t.file === 0 && !t.doc.done) || s.groups[0].cursor > s.groups[0].queue.length, true)
  const eight = Array.from({ length: 8 }, (_, i) => tiny(`f${i}.go`, 'go'))
  let t8 = newSession(eight, ['go'], 12, 1)
  for (let i = 0; i < 200; i++) t8 = reduceWorkMode(t8, { kind: 'type' })
  let t9 = newSession([...eight, tiny('r.rs', 'rs')], ['go', 'rs'], 12, 1)
  let most = 0
  for (let i = 0; i < 400; i++) {
    t9 = reduceWorkMode(t9, { kind: 'type' })
    most = Math.max(most, t9.groups[0].tabs.length)
  }
  check(`eight files through one group: never more than WM_TABS_MAX (${WM_TABS_MAX}) tabs`, [t8.groups[0].tabs.length <= WM_TABS_MAX, most], [true, WM_TABS_MAX])
  check('the seventh tab drops the first', (() => {
    let q = newSession([...eight, tiny('r.rs', 'rs')], ['go', 'rs'], 12, 1)
    for (let i = 0; i < 400 && q.groups[0].cursor < 8; i++) q = reduceWorkMode(q, { kind: 'type' })
    return [q.groups[0].tabs.length, q.groups[0].tabs[0].file !== 0]
  })(), [WM_TABS_MAX, true])
  let c = reduceWorkMode(newSession(files, ['ts'], 4, 1), { kind: 'chars', n: 99 })
  check('characters per key are clamped', [c.charsPerKey, reduceWorkMode(c, { kind: 'chars', n: -3 }).charsPerKey], [WM_CHARS_MAX, WM_CHARS_MIN])
  c = reduceWorkMode(c, { kind: 'type' })
  const dirty = c.groups[c.active].tabs[c.groups[c.active].active].doc.dirty
  c = reduceWorkMode(c, { kind: 'save' })
  check('typing marks the tab dirty, a save clears it', [dirty, c.groups[c.active].tabs[c.groups[c.active].active].doc.dirty], [true, false])
  const opened2 = reduceWorkMode(newSession(files, ['ts', 'css'], 4, 1), { kind: 'open', group: 1, file: 0 })
  check('opening a file from the explorer puts it in that group and makes it active', [opened2.active, opened2.groups[1].tabs[opened2.groups[1].active].file], [1, 0])
  const closed = reduceWorkMode(opened2, { kind: 'close', group: 1, index: opened2.groups[1].active })
  check('closing a tab keeps the group showing a file', closed.groups[1].tabs.length >= 1, true)
}

/* ------------------------------------------------------------- highlighter */

console.log('\nthe highlighter')
{
  const GRAMMARS: Array<[Grammar, string | undefined]> = [['js', undefined], ['jsx', undefined], ['clike', 'rust'], ['clike', 'c'], ['clike', 'go'], ['clike', 'php'], ['python', undefined], ['script', 'sh'], ['script', 'ruby'], ['script', 'lua'], ['script', 'sql'], ['css', 'scss'], ['css', 'css'], ['html', undefined], ['markdown', undefined]]
  const lossy: string[] = []
  for (const file of corpus) {
    const info = WORK_MODE_LANGUAGES[file.ext]
    // A type with no grammar is a failure here, never a crash that would hide the rest of the tally (gotcha 113).
    if (!info) {
      lossy.push(`${file.path}: no grammar for .${file.ext}`)
      continue
    }
    const lines = file.text.split('\n')
    const states = lineStates(info.grammar, lines, info.lang)
    lines.forEach((line, i) => {
      const r = tokenizeLine(info.grammar, line, states[i], info.lang)
      if (r.tokens.map((t) => t.text).join('') !== line || r.tokens.some((t) => t.text.length === 0)) lossy.push(`${file.path}:${i + 1}`)
    })
  }
  const rng = seededRandom(77)
  const alphabet = ' \t\'"`/*<>{}()[];:.,=+-!&|?#$@\\abcXYZ019_\n'
  for (let i = 0; i < 2000; i++) {
    const len = Math.floor(rng() * 80)
    let line = ''
    for (let j = 0; j < len; j++) line += alphabet[Math.floor(rng() * alphabet.length)]
    line = line.replace(/\n/g, '')
    const [g, lang] = GRAMMARS[i % GRAMMARS.length]
    let state = plainState(g)
    for (const part of [line, line.slice(3), line]) {
      const r = tokenizeLine(g, part, state, lang)
      if (r.tokens.map((t) => t.text).join('') !== part || r.tokens.some((t) => t.text.length === 0)) lossy.push(`random#${i} (${g})`)
      state = r.end
    }
  }
  check('lossless, with no empty token, for every line of the corpus and 2,000 random lines in every grammar', lossy.slice(0, 5), [])
  const adversarial = ["'\"`/*<a(\\/[".repeat(400), "'\\".repeat(2000), '/*'.repeat(2000), '<a '.repeat(1333), 'a('.repeat(2000), '\\'.repeat(4000), '"'.repeat(4000), '[[--'.repeat(1000), '<!--<'.repeat(800), '`a``'.repeat(1000), '![x]('.repeat(800), '[a](b'.repeat(800), '`'.repeat(4000)]
  let worst = 0
  let worstAt = ''
  for (const [g, lang] of GRAMMARS) for (const line of adversarial) tokenizeLine(g, line, plainState(g), lang)
  for (const [g, lang] of GRAMMARS) {
    for (const line of adversarial) {
      const t0 = performance.now()
      tokenizeLine(g, line, plainState(g), lang)
      const ms = performance.now() - t0
      if (ms > worst) {
        worst = ms
        worstAt = `${g}/${lang ?? ''}`
      }
    }
  }
  console.log(`        slowest adversarial 4,000-character line: ${worst.toFixed(2)} ms (${worstAt})`)
  check('linear: every adversarial 4,000-character line in every grammar tokenises in under 20 ms', worst < 20, true)
  const kinds = (g: Grammar, line: string, lang?: string, state = plainState(g)): string =>
    tokenizeLine(g, line, state, lang).tokens.filter((t) => t.kind !== 'text').map((t) => `${t.kind}:${t.text}`).join(' ')
  check('js: keyword, function, string, number, regex, comment', kinds('js', "const r = /a+/g.test('x') + 42 // c"), 'keyword:const operator:= regex:/a+/g punct:. function:test punct:( string:\'x\' punct:) operator:+ number:42 comment:// c')
  check('jsx: tags, attributes, an attribute expression, a component', kinds('jsx', 'return <Card title="a" onClick={go}>hi</Card>'), 'keyword:return punct:< type:Card attr:title punct:= string:"a" attr:onClick punct:= punct:{ punct:} punct:> punct:</ type:Card punct:>')
  check('a generic is not a tag', kinds('jsx', 'const v = useState<string>(x)').includes('tag:'), false)
  const states = lineStates('js', ['/* open', 'inside the comment', 'close */ const a = 1'])
  check('lineStates carry: a line inside a block comment is comment only', [states[1].mode, tokenizeLine('js', 'inside the comment', states[1]).tokens.map((t) => t.kind)], ['block', ['comment']])
  const py = lineStates('python', ['x = """start', 'middle', 'end""" + y'])
  check('python: a triple quote across lines', [py[1].mode, kinds('python', 'end""" + y', undefined, py[2])], ['triple', 'string:end""" operator:+'])
  check('python: a decorator, def and class names', kinds('python', 'def run(self):') + ' | ' + kinds('python', '@cached'), 'keyword:def function:run punct:( variable:self punct:) operator:: | function:@cached')
  const css = lineStates('css', ['.a {', '  color: red;', '}'], 'css')
  check('css: depth, a selector, a property, a value', [css.map((s) => s.depth), kinds('css', '  color: var(--x) !important;', 'css', css[1])], [[0, 1, 1], 'property:color punct:: function:var punct:( variable:--x punct:) keyword:!important punct:;'])
  const html = lineStates('html', ['<script>', 'const a = 1', '</script>', '<style>', '.b { margin: 0 }', '</style>', '<p class="x">t</p>'])
  check('html: script and style switch to js and css until their closing tag', [html[1].embed?.grammar, html[4].embed?.grammar, html[6].mode, kinds('html', 'const a = 1', undefined, html[1])], ['js', 'css', 'text', 'keyword:const operator:= number:1'])
  check('rust: a lifetime is a type, a char literal a string, a macro a function', kinds('clike', "let c: &'a str = 'x'; println!()", 'rust'), "keyword:let operator:: operator:& type:'a type:str operator:= string:'x' punct:; function:println operator:! punct:( punct:)")
  check('sh: a variable', kinds('script', 'echo "$HOME" ${PATH}', 'sh'), 'string:"$HOME" variable:${PATH}')
  check('sql keywords are case-insensitive', kinds('script', 'select id FROM t', 'sql'), 'keyword:select keyword:FROM')
  // Markdown (polish item 5): headings and list markers, code spans, links, quotes, table pipes, and fenced code in its own grammar.
  check('markdown: a heading, a list marker, a code span, a link', [kinds('markdown', '## Install it'), kinds('markdown', '- Run `npm test` and see [the guide](docs/guide.md).')], ['function:## Install it', 'function:- string:`npm test` type:[the guide] string:(docs/guide.md)'])
  check('markdown: a quote, a table row, a rule; a lone backtick stays text', [kinds('markdown', '> Jobs retry.'), kinds('markdown', '| a | b |'), kinds('markdown', '---'), kinds('markdown', 'a ` b')], ['comment:> Jobs retry.', 'punct:| punct:| punct:|', 'punct:---', ''])
  const md = lineStates('markdown', ['```ts', 'const a = 1', '```', 'const b = 2'])
  check('markdown: a fence carries its language (ts) until it closes, and is never the plain state (no holes in a code block)', [md[1].mode, md[1].embed?.grammar, kinds('markdown', 'const a = 1', undefined, md[1]), isPlainState('markdown', md[1]), md[3].mode, kinds('markdown', 'const b = 2', undefined, md[3])], ['fence', 'js', 'keyword:const operator:= number:1', false, 'code', ''])
  check('markdown: an unknown fence is plain text inside, and closes on the same fence', [kinds('markdown', 'x = 1', undefined, lineStates('markdown', ['~~~text', 'x = 1'])[1]), lineStates('markdown', ['~~~', '```', '~~~', 'y'])[3].mode], ['', 'code'])
}

/* -------------------------------------------- keys, exit, tail, pointer */

console.log('\nkeys, the leave chord, the tail, the pointer')
{
  const k = (key: string, mods: Partial<WorkModeKeyEvent> = {}): WorkModeKeyEvent => ({ key, code: /^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : undefined, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods })
  const mac = (e: WorkModeKeyEvent): string => workModeKey(e, true)
  const pc = (e: WorkModeKeyEvent): string => workModeKey(e, false)
  check('mac: Cmd+Q, Cmd+H, Cmd+Alt+H, Cmd+M, Cmd+` and Ctrl+Cmd+F pass to the OS', [mac(k('q', { metaKey: true })), mac(k('h', { metaKey: true })), mac({ ...k('˙', { metaKey: true, altKey: true }), code: 'KeyH' }), mac(k('m', { metaKey: true })), mac({ ...k('`', { metaKey: true }), code: 'Backquote' }), mac(k('f', { metaKey: true, ctrlKey: true }))], ['pass', 'pass', 'pass', 'pass', 'pass', 'pass'])
  check('mac: Cmd+K, T, W, 1, comma, F and R type (no Stoke shortcut runs)', ['k', 't', 'w', '1', ',', 'f', 'r'].map((x) => mac(k(x, { metaKey: true }))), ['type', 'type', 'type', 'type', 'type', 'type', 'type'])
  check('off mac: Alt+F4 and F11 pass; Ctrl+Q, Ctrl+W and Ctrl+Tab type', [pc(k('F4', { altKey: true })), pc(k('F11')), pc(k('q', { ctrlKey: true })), pc(k('w', { ctrlKey: true })), pc(k('Tab', { ctrlKey: true }))], ['pass', 'pass', 'type', 'type', 'type'])
  check('Cmd+S on a Mac and Ctrl+S elsewhere save', [mac(k('s', { metaKey: true })), pc(k('s', { ctrlKey: true })), mac(k('s', { ctrlKey: true }))], ['save', 'save', 'type'])
  check('composition, dead keys, Process and a lone modifier do nothing', [mac({ ...k('a'), isComposing: true }), mac(k('Dead')), pc(k('Process')), mac(k('Shift')), pc(k('Control')), mac(k('Meta')), pc(k('CapsLock'))], ['ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore', 'ignore'])
  check('Escape is the exit key, a letter or Enter types', [mac(k('Escape')), pc(k('a')), pc(k('Enter'))], ['exit', 'type', 'type'])
  /*
   * The in-mode menu: main takes no tab or window chord while Work mode is up, so a chord the page
   * leaves alone there reaches the default application menu (Close Window ends every session).
   */
  const menuMac = (e: WorkModeKeyEvent): string => workModeMenuKey(e, true)
  const menuPc = (e: WorkModeKeyEvent): string => workModeMenuKey(e, false)
  check('the menu: Tab, Shift+Tab, Space, Enter and the arrows are its controls\' own', [menuMac(k('Tab')), menuMac(k('Tab', { shiftKey: true })), menuMac(k(' ')), menuPc(k('Enter')), menuPc(k('ArrowDown')), menuMac(k('ArrowUp'))], ['native', 'native', 'native', 'native', 'native', 'native'])
  check('the menu, mac: Cmd+W, Cmd+R, Cmd+Shift+R, Cmd+Alt+I, the zoom chords, Cmd+Enter and a letter are blocked', [menuMac(k('w', { metaKey: true })), menuMac(k('r', { metaKey: true })), menuMac(k('R', { metaKey: true, shiftKey: true })), menuMac({ ...k('ˆ', { metaKey: true, altKey: true }), code: 'KeyI' }), menuMac(k('0', { metaKey: true })), menuMac(k('=', { metaKey: true })), menuMac(k('-', { metaKey: true })), menuMac(k('Enter', { metaKey: true })), menuMac(k('a'))], ['block', 'block', 'block', 'block', 'block', 'block', 'block', 'block', 'block'])
  check('the menu, off mac: Ctrl+W, Ctrl+R, Ctrl+Shift+I and Ctrl+Tab are blocked', [menuPc(k('w', { ctrlKey: true })), menuPc(k('r', { ctrlKey: true })), menuPc(k('I', { ctrlKey: true, shiftKey: true })), menuPc(k('Tab', { ctrlKey: true }))], ['block', 'block', 'block', 'block'])
  check('the menu: the OS chords still pass (Cmd+Q, Cmd+M, Cmd+H; Alt+F4, F11)', [menuMac(k('q', { metaKey: true })), menuMac(k('m', { metaKey: true })), menuMac(k('h', { metaKey: true })), menuPc(k('F4', { altKey: true })), menuPc(k('F11'))], ['pass', 'pass', 'pass', 'pass', 'pass'])

  const step = (s: ExitState, key: string, at: number, repeat = false) => exitStep(s, { key, at, repeat, kind: key === 'Escape' ? 'exit' : 'type' })
  const a = step(EXIT_START, 'Escape', 1000)
  check('a first Escape arms (the "again" hint)', [a.armed, a.leave, a.state.firstAt], [true, false, 1000])
  check('a second within 800 ms leaves', step(a.state, 'Escape', 1000 + WM_EXIT_WINDOW_MS).leave, true)
  const late = step(a.state, 'Escape', 1000 + WM_EXIT_WINDOW_MS + 1)
  check('one after 800 ms is a new first press', [late.leave, late.armed, late.state.firstAt], [false, true, 1801])
  check('a held Escape\'s repeat changes nothing (holding never leaves)', step(a.state, 'Escape', 1100, true), { state: a.state, leave: false, armed: false })
  check('a lone modifier between the two changes nothing', step(step(a.state, 'Shift', 1100).state, 'Escape', 1200).leave, true)
  check('any other key between them starts over', step(step(a.state, 'x', 1100).state, 'Escape', 1200).leave, false)
  const rng = seededRandom(5)
  let st: ExitState = EXIT_START
  let left = false
  let t = 0
  for (let i = 0; i < 200; i++) {
    t += 20 + rng() * 80
    const esc = i % 23 === 7
    const r = exitStep(st, { key: esc ? 'Escape' : String.fromCharCode(97 + Math.floor(rng() * 26)), repeat: false, at: t, kind: esc ? 'exit' : 'type' })
    st = r.state
    if (r.leave) left = true
  }
  check('200 random keys with single Escapes scattered through them never leave', left, false)
  check('the tail: 399 ms of quiet is not enough, 400 is (PRESS_QUIET_MS, one burst)', [tailDone(1000, 1399), tailDone(1000, 1400), WM_TAIL_QUIET_MS === PRESS_QUIET_MS], [false, true, true])

  let p = pointerBudget(POINTER_START, { x: 0, y: 0, at: 0 }).state
  const one = pointerBudget(p, { x: 0, y: 120, at: 300 })
  check('120 px of travel is one line', one.fill, true)
  p = pointerBudget(POINTER_START, { x: 0, y: 0, at: 0 }).state
  let fills = 0
  for (let i = 1; i <= 20; i++) {
    const r = pointerBudget(p, { x: 0, y: i * 50, at: i * 2.5 })
    p = r.state
    if (r.fill) fills++
  }
  check('1,000 px in 50 ms is one line (the gap holds the rest)', fills, 1)
  const hop = pointerBudget(pointerBudget(POINTER_START, { x: 0, y: 0, at: 0 }).state, { x: 600, y: 0, at: 10 })
  check('a 600 px hop (a re-entry) is nothing, and drops the carry', [hop.fill, hop.state.carry], [false, 0])
  const before = pointerBudget(pointerBudget(POINTER_START, { x: 0, y: 0, at: 0 }).state, { x: 0, y: 100, at: 10 }).state
  const idle = pointerBudget(before, { x: 0, y: 130, at: 10 + WM_IDLE_MS + 1 })
  check('after an idle the carry starts again', [before.carry, idle.fill, idle.state.carry], [100, false, 30])
}

/* ------------------------------------------------------------ panel lines */

console.log('\nthe build panel: the wall clock in order, counts that add up, real-looking tests, and tests only in a test terminal (polish item 3)')
{
  const tools: Toolchain[] = ['vite', 'next', 'node', 'cargo', 'go', 'python', 'ruby', 'gradle', 'make']
  const filesFor = (tool: Toolchain): string[] =>
    tool === 'cargo' ? ['src/lib.rs', 'src/queue.rs'] : tool === 'go' ? ['internal/queue/queue.go', 'cmd/harbor/main.go'] : tool === 'python' ? ['harbor/queue.py', 'harbor/retry.py'] : tool === 'ruby' ? ['app/models/cart.rb', 'lib/harbor/queue.rb'] : tool === 'make' ? ['src/main.c', 'src/util.c', 'src/site.css'] : ['src/retry.ts', 'src/scheduler.ts', 'src/components/JobRow.tsx', 'src/styles/table.css', 'index.html']
  const ownTests = ['src/scheduler.test.ts', 'tests/test_retry.py']
  const srcOf = (tool: Toolchain): PanelSource => ({ tool, name: 'Harbor Queue', files: filesFor(tool), tests: ownTests })
  /** A run of bursts the way WorkMode.tsx makes them: start, then ticks and saves, each stamped panelTime(last, now). */
  const session = (tool: Toolchain, seed: number, nows: number[]): Array<{ at: number; out: PanelOut }> => {
    const rng = seededRandom(seed)
    let last = -Infinity
    return nows.map((now, i) => {
      last = panelTime(last, now)
      const kind = i === 0 ? 'start' : i % 3 === 0 ? 'save' : 'tick'
      const files = filesFor(tool)
      return { at: last, out: panelBurst(srcOf(tool), rng, kind, last, kind === 'save' ? files[i % files.length] : null) }
    })
  }
  const t0 = new Date(2026, 9, 28, 21, 29, 50).getTime()
  // The clock is set back once, at the fifth burst: the panel's times must not go back with it.
  const nows = [t0, t0 + 7_000, t0 + 15_000, t0 + 16_200, t0 - 3_600_000, t0 + 31_000, t0 + 44_000, t0 + 52_500]
  const STAMP = /(?:^|\[)(\d{1,2}:\d\d:\d\d(?: [AP]M)?)(?:\]| \[vite\]| - INFO)|Start at\s+(\d\d:\d\d:\d\d)/
  const problems: string[] = []
  for (const tool of tools) {
    for (let seed = 1; seed <= 12; seed++) {
      const runs = session(tool, seed, nows)
      const again = session(tool, seed, nows)
      if (JSON.stringify(runs) !== JSON.stringify(again)) problems.push(`${tool}: not deterministic`)
      let lastAt = -Infinity
      for (const { at, out } of runs) {
        if (at < lastAt) problems.push(`${tool}: a burst stamped before the one before it`)
        lastAt = at
        const lines = [...out.dev, ...(out.test ?? [])]
        if (out.dev.length > WM_PANEL_DEV_MAX || (out.test?.length ?? 0) > WM_PANEL_TEST_MAX) problems.push(`${tool}: too many lines`)
        for (const l of lines) {
          if (l.length > 160) problems.push(`${tool}: a line of ${l.length}`)
          if (/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(l)) problems.push(`${tool}: a control character`)
          // Every time printed is this burst's wall clock, in the format the tool prints it.
          const m = STAMP.exec(l)
          if (m && m[1] !== clock12(at) && m[1] !== clock24(at) && m[2] !== clock24(at)) problems.push(`${tool}: "${l}" is not the wall clock ${clock24(at)}`)
          // A source path must be a given file, a test named after one, or the project's own test; build output is the tool's fiction.
          for (const p of l.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|js|css|py|rs|go|c|rb|html)\b|\b[a-z][\w.-]*\.(?:ts|tsx|js|css|py|rs|go|c|rb|html)\b/g)) {
            const path = p[0].replace(/^\//, '')
            const known = [...filesFor(tool), ...ownTests, ...filesFor(tool).map((f) => testFileFor(f, ownTests)).filter((x): x is string => !!x)]
            if (!/^(?:dist|build|target)\//.test(path) && !known.includes(path)) problems.push(`${tool}: a path not given: ${path}`)
          }
        }
      }
    }
  }
  check('every toolchain over a session: each time the wall clock, never going back (even with the clock set back), lines at most 160 characters, no controls, deterministic, only the given paths', problems.slice(0, 6), [])

  // Counts that add up, every run passing, and each test file's count its own on every run.
  const countProblems: string[] = []
  for (const tool of tools) {
    for (let seed = 1; seed <= 12; seed++) {
      for (const { out } of session(tool, seed, nows)) {
        for (const lines of [out.dev, out.test ?? []]) {
          const text = lines.join('\n')
          const files = [...text.matchAll(/^ ✓ (\S+) \((\d+) tests?\)/gm)].map((m) => ({ path: m[1], count: Number(m[2]) }))
          const tf = /Test Files {2}(\d+) passed \((\d+)\)/.exec(text)
          const tt = /Tests {2}(\d+) passed \((\d+)\)/.exec(text)
          if (tf && !(Number(tf[1]) === Number(tf[2]) && Number(tf[1]) === files.length)) countProblems.push(`${tool}: ${tf[0]} for ${files.length} files`)
          if (tt && !(Number(tt[1]) === Number(tt[2]) && Number(tt[1]) === files.reduce((n, f) => n + f.count, 0))) countProblems.push(`${tool}: ${tt[0]}`)
          if (files.length && (!tf || !tt)) countProblems.push(`${tool}: test files with no totals`)
          for (const f of files) if (f.count !== testCount(f.path)) countProblems.push(`${tool}: ${f.path} has ${f.count} tests here and ${testCount(f.path)} elsewhere`)
          const cargo = /running (\d+) tests[\s\S]*test result: ok\. (\d+) passed; 0 failed/.exec(text)
          if (/running \d+ tests/.test(text) && !(cargo && cargo[1] === cargo[2])) countProblems.push(`${tool}: cargo's counts`)
          const py = /collected (\d+) items[\s\S]*= (\d+) passed in/.exec(text)
          if (py && !(py[1] === py[2] && [...text.matchAll(/\.py (\.+)/g)].reduce((n, m) => n + m[1].length, 0) === Number(py[1]))) countProblems.push(`${tool}: pytest's counts`)
          const pct = [...text.matchAll(/\[\s*(\d+)%\]/g)].map((m) => Number(m[1]))
          if (pct.length && (pct.some((v, i) => i > 0 && v < pct[i - 1]) || pct[pct.length - 1] !== 100)) countProblems.push(`${tool}: pytest's progress ${pct}`)
          const gradle = /(\d+) actionable tasks: (\d+) executed, (\d+) up-to-date/.exec(text)
          if (gradle && Number(gradle[2]) + Number(gradle[3]) !== Number(gradle[1])) countProblems.push(`${tool}: ${gradle[0]}`)
          const rspec = /\n(\.+)\n[\s\S]*?(\d+) examples, 0 failures/.exec(text)
          if (rspec && rspec[1].length !== Number(rspec[2])) countProblems.push(`${tool}: rspec's counts`)
          if (/[1-9]\d* failed|[1-9]\d* failures|FAIL\b/.test(text)) countProblems.push(`${tool}: a failure with no failure detail`)
        }
      }
    }
  }
  check('test counts add up in every runner (files, totals, passed equals total, each file\'s count stable across runs) and every run passes', countProblems.slice(0, 6), [])

  // Test files are named like the project's tests (prove Finding 4 printed a source file, src/retry.ts, as a test file).
  check('a test is named after its source, or is the project\'s own: beside it, nearest first, by its runner\'s convention', [
    testFileFor('src/retry.ts', []), testFileFor('src/retry.ts', ['tests/retry.test.ts', 'other/retry.test.ts', 'src/x/retry.spec.ts']), testFileFor('src/components/JobRow.tsx', []),
    testFileFor('lib/util.mjs', []), testFileFor('harbor/queue.py', []), testFileFor('harbor/queue.py', ['tests/test_queue.py']), testFileFor('internal/q/queue.go', []),
    testFileFor('app/models/cart.rb', []), testFileFor('src/retry.test.ts', []), testFileFor('src/site.css', []), testFileFor('index.html', []), testFileFor('src/types.d.ts', []), testFileFor('README.md', [])
  ], ['src/retry.test.ts', 'src/x/retry.spec.ts', 'src/components/JobRow.test.tsx', 'lib/util.test.js', 'tests/test_queue.py', 'tests/test_queue.py', 'internal/q/queue_test.go', 'spec/models/cart_spec.rb', 'src/retry.test.ts', null, null, null, null])
  check('isTestPath and testStem read every runner\'s naming', [['src/a.test.ts', 'src/__tests__/b.tsx', 'tests/test_c.py', 'd_test.go', 'spec/e_spec.rb', 'src/f.ts', 'src/g.d.ts', 'docs/test.md'].map(isTestPath), ['src/a.test.ts', 'tests/test_c.py', 'd_test.go', 'spec/e_spec.rb', 'src/Retry.spec.tsx'].map(testStem)], [[true, true, true, true, true, false, false, false], ['a', 'c', 'd', 'e', 'retry']])
  const vite = panelBurst(srcOf('vite'), seededRandom(4), 'start', t0)
  const named = [...(vite.test ?? []).join('\n').matchAll(/ ✓ (\S+) \(/g)].map((m) => m[1])
  check('vite\'s first run: a test for each loaded source a runner tests, the project\'s own scheduler test, nothing for CSS or HTML', named, ['src/retry.test.ts', 'src/scheduler.test.ts', 'src/components/JobRow.test.tsx'])

  // Test output only in the test terminal (prove Finding 4: vitest lines appeared inside `npm run dev`).
  const VITEST_LINE = /✓ \S+ \(\d+ tests?\)|Test Files|Tests\s+\d+ passed|RERUN|press h to show help, press q/
  const leaks: string[] = []
  for (const tool of ['vite', 'next', 'node'] as const) {
    for (let seed = 1; seed <= 30; seed++) {
      for (const { out } of session(tool, seed, nows)) {
        for (const l of out.dev) if (VITEST_LINE.test(l)) leaks.push(`${tool}: ${l}`)
      }
    }
  }
  check('a JS project\'s dev terminal never prints a test line', leaks.slice(0, 3), [])
  const saved = panelBurst(srcOf('vite'), seededRandom(9), 'save', t0, 'src/retry.ts')
  const css = panelBurst(srcOf('vite'), seededRandom(9), 'save', t0, 'src/styles/table.css')
  check('a save reloads in the dev terminal and reruns that file\'s test in the test terminal; a style sheet reruns nothing', [saved.dev, saved.test?.[0], saved.test?.filter((l) => /✓/.test(l)).map((l) => l.replace(/ \d+ms$/, '')), css.dev.length, css.test], [[`${clock12(t0)} [vite] (client) hmr update /src/retry.ts`], ' RERUN  src/retry.ts', [` ✓ src/retry.test.ts (${testCount('src/retry.test.ts')} tests)`], 1, null])
  check('the test terminal is a JS project\'s own (vite, next, node), its prompt `npm test`', [tools.filter(hasTestTerminal), panelTestPrompt('harbor-queue', 'main')], [['vite', 'next', 'node'], 'harbor-queue git:(main) $ npm test'])
  check('panelTime: the wall clock, never before the last burst', [panelTime(-Infinity, 5), panelTime(10, 5), panelTime(10, 12), panelTime(10, Number.NaN)], [5, 10, 12, 10])
  check('the clock as the tools print it: tsc and Vite 12-hour, vitest and Guard 24-hour', [clock12(new Date(2026, 9, 28, 21, 4, 9).getTime()), clock12(new Date(2026, 9, 28, 0, 5, 0).getTime()), clock24(new Date(2026, 9, 28, 9, 4, 9).getTime())], ['9:04:09 PM', '12:05:00 AM', '09:04:09'])
  check('panel lines are coloured as a terminal would: passes green, a run\'s header, quiet details', [' ✓ src/a.test.ts (3 tests) 4ms', ' Test Files  1 passed (1)', ' RERUN  src/a.ts', '   Start at  21:04:09', '9:41:08 PM [vite] (client) hmr update /src/a.ts'].map(panelLineKind), ['ok', 'ok', 'info', 'dim', 'out'])

  const secretHome = ['', 'Users', 'someone', 'clients', 'acme-secret'].join('/')
  const prompt = panelPrompt(secretHome, 'main', 'vite')
  check('the prompt names the folder\'s last segment only, never its path', [prompt, prompt.includes('/Users'), prompt.includes('someone')], ['acme-secret git:(main) $ npm run dev', false, false])
  const leaked = ['tick', 'start', 'save'].flatMap((kind) => {
    const out = panelBurst({ tool: 'make', name: 'x', files: [['', 'Users', 'someone', 'x', 'main.c'].join('/')], tests: [] }, seededRandom(3), kind as 'tick')
    return [...out.dev, ...(out.test ?? [])]
  }).join('\n')
  check('an absolute path among the files is cut to its name: no folder, no user name', [leaked.includes('Users'), leaked.includes('someone'), leaked.includes('main.c')], [false, false, true])
  const panelSrc = read('src/renderer/src/components/WorkMode.tsx')
  check('WorkMode stamps every burst with panelTime(last, Date.now()) and names the saved file, the active editor\'s', [/panelAt\.current = panelTime\(panelAt\.current, Date\.now\(\)\)/.test(panelSrc), /printPanel\(src, 'save', saved\)/.test(panelSrc), /activeTab\(s, s\.active\)\?\.file\.path/.test(panelSrc)], [true, true, true])
}

/* -------------------------------------------------------------- the sample */

console.log('\nthe bundled sample website')
{
  const scratchJs = join(base, 'sample-check')
  const errors: string[] = []
  for (const p of ['app.js', 'js/cart.js', 'js/api.js']) {
    const dest = join(scratchJs, p.replace(/\.js$/, '.mjs'))
    put(dest, readFileSync(join(SAMPLE_DIR, p), 'utf8'))
    try {
      execFileSync(process.execPath, ['--check', dest], { stdio: 'pipe' })
    } catch (e) {
      errors.push(`${p}: ${String((e as { stderr?: Buffer }).stderr ?? e).split('\n')[0]}`)
    }
  }
  check('each JS file passes node --check', errors, [])
  const cssText = readFileSync(join(SAMPLE_DIR, 'styles.css'), 'utf8')
  let depth = 0
  let negative = false
  for (const ch of cssText.replace(/\/\*[\s\S]*?\*\//g, '').replace(/'[^']*'|"[^"]*"/g, '')) {
    if (ch === '{') depth++
    if (ch === '}') depth--
    if (depth < 0) negative = true
  }
  check('CSS braces balance and never go negative', [depth, negative], [0, false])
  const htmlText = readFileSync(join(SAMPLE_DIR, 'index.html'), 'utf8')
  const stack: string[] = []
  const mismatched: string[] = []
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr', 'path', 'circle'])
  for (const m of htmlText.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const name = m[2].toLowerCase()
    if (m[1]) {
      if (stack.pop() !== name) mismatched.push(name)
    } else if (!m[4] && !VOID.has(name)) stack.push(name)
  }
  check('HTML tags balance (void elements aside)', [stack, mismatched], [[], []])
  // The very pattern verify:color reads definitions with, so a name it would take from here is one it lists.
  const defs = new Set([...cssText.replace(/\/\*[\s\S]*?\*\//g, ' ').matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]))
  const used = [...cssText.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1])
  check('every var(--x) without a fallback is defined in styles.css', [...new Set(used.filter((v) => !defs.has(v)))], [])
  check('every custom property is --fern-*, so none masks a typo in Stoke\'s own tokens (verify:color reads every .css)', [...defs, ...used].filter((v) => !v.startsWith('--fern-')), [])
  const sizes = sampleFiles.map((f) => {
    const lines = f.text.replace(/\n$/, '').split('\n')
    return [f.path, lines.length >= 120 && lines.length <= 450, lines.every((l) => l.length <= 100), !f.text.includes('\t'), !f.text.includes('\r')]
  })
  check('each file: 120-450 lines, none over 100 characters, no tabs, LF', sizes.filter((s) => s.slice(1).some((x) => !x)), [])
  check('the sample\'s default picks are js, css, html (js has three files; css wins the tie by name)', defaultPicks(countTypes(SAMPLE_PATHS)), ['js', 'css', 'html'])
  check('the left editor types app.js, js/cart.js, js/api.js; the right styles.css, then index.html', (() => {
    const ordered = ['app.js', 'styles.css', 'js/cart.js', 'index.html', 'js/api.js'].map((p) => sampleFiles.find((f) => f.path === p)!)
    const q = windowQueues(ordered, ['js', 'css', 'html'])
    return [q.left.map((i) => ordered[i].path), q.right.map((i) => ordered[i].path)]
  })(), [['app.js', 'js/cart.js', 'js/api.js'], ['styles.css', 'index.html']])
  check('the sample is redaction-clean: what main would send is byte for byte the file', sampleFiles.filter((f) => cleanForShow(f.text) !== f.text).map((f) => f.path), [])
  check('detectIndent reads the sample as two spaces', sampleFiles.map((f) => detectIndent(f.text)).every((d) => !d.tabs && d.size === 2), true)
}

/* ---------------------------------------------------------------- pins */

console.log('\nsource pins: the wire no unit check can run (gotchas 31, 175)')
{
  const app = read('src/renderer/src/App.tsx')
  const overlay = app.match(/const overlayOpen = ([^\n]+)/)?.[1] ?? ''
  check('App: overlayOpen\'s one line names workModeOpen', /\bworkModeOpen\b/.test(overlay), true)
  check('App: workModeOpen is the Work mode state', /const workModeOpen = workMode !== null/.test(app), true)
  check('App: Work mode is a lazy chunk, never a static import', [/lazy\(\(\) => import\('\.\/components\/WorkMode'\)/.test(app), /^import .*components\/WorkMode['/]/m.test(app), /^import .*workModeSample/m.test(app)], [true, false, false])
  check('App: the onTabShortcut callback first returns in Work mode', /onTabShortcut\(action => \{\s*(?:\/\/[^\n]*\n\s*)*if \(workModeRef\.current\) return/.test(app), true)
  check('App: and so does the matchShortcut listener', /const onKey = \(e: KeyboardEvent\): void => \{\s*(?:\/\/[^\n]*\n\s*)*if \(workModeRef\.current\) return/.test(app), true)
  check('App: the folder is chosen at the press, for every tab kind (workModeFolder)', (app.match(/openWorkMode\(workModeFolder\(activeTab, launchTarget\?\.path \?\? null\)\)/g) ?? []).length >= 2, true)
  check('App: an off plugin ends Work mode through its tail', /stop=\{workModeEnabled === false\}/.test(app), true)
  const wm = read('src/renderer/src/components/WorkMode.tsx')
  check('WorkMode: one keydown listener on window in the CAPTURE phase', /window\.addEventListener\('keydown', onKeyDown, true\)/.test(wm), true)
  const handler = wm.slice(wm.indexOf('const onKeyDown'), wm.indexOf('const swallow'))
  check('…which stops propagation first, and prevents the default for all but an OS chord', [/^const onKeyDown = \(e: KeyboardEvent\): void => \{\s*(?:\/\/[^\n]*\n\s*)*e\.stopPropagation\(\)/.test(handler), /if \(kind === 'pass'\) return\s*\n\s*e\.preventDefault\(\)/.test(handler)], [true, true])
  check('…keeps swallowing while leaving (the tail)', /if \(phaseRef\.current === 'leaving'\) \{\s*e\.preventDefault\(\)/.test(handler), true)
  const menuBranch = handler.slice(handler.indexOf('menuEl.contains(e.target)'), handler.indexOf('const kind = workModeKey('))
  check('…and on its own menu blocks every chord its controls do not use (found in review: Cmd+W there closed the window)', [menuBranch.length > 0, /if \(workModeMenuKey\(e, isMac\) === 'block'\) e\.preventDefault\(\)/.test(menuBranch)], [true, true])
  check('…and swallows keyup and keypress too', [/addEventListener\('keyup', swallow, true\)/.test(wm), /addEventListener\('keypress', swallow, true\)/.test(wm)], [true, true])
  check('WorkMode: it tells main it is up, and down again', /workMode\.active\(true\)[\s\S]{0,80}workMode\.active\(false\)/.test(wm), true)
  const wmFiles = readdirSync(join(root, 'src/renderer/src/components')).filter((f) => /^WorkMode.*\.tsx$/.test(f))
  check('the Work mode components are all there', wmFiles.sort(), ['WorkMode.tsx', 'WorkModeChrome.tsx', 'WorkModeEditor.tsx', 'WorkModeExplorer.tsx', 'WorkModeMenu.tsx', 'WorkModePanel.tsx'])
  check('no dangerouslySetInnerHTML in any of them (file text is untrusted)', wmFiles.filter((f) => read(`src/renderer/src/components/${f}`).includes('dangerouslySetInnerHTML')), [])
  check('no hex colour in any of them or in workMode.css', [...wmFiles.map((f) => `src/renderer/src/components/${f}`), 'src/renderer/src/styles/workMode.css'].filter((f) => /#[0-9a-fA-F]{3,8}\b/.test(read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''))), [])
  check('workMode.css answers reduced motion: no glide, no blink', /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*\.wm-caret[^{]*\{\s*animation: none;\s*transition: none;/.test(read('src/renderer/src/styles/workMode.css')), true)
  const main = read('src/main/index.ts')
  const sw = main.slice(main.indexOf('function switchWindow('), main.indexOf('function bindWindowSwitching('))
  check('index.ts: switchWindow checks the Work mode flag before tabShortcut', sw.indexOf('workModeWindows.has(owner.webContents.id)') >= 0 && sw.indexOf('workModeWindows.has(owner.webContents.id)') < sw.indexOf('tabShortcut('), true)
  const bind = main.slice(main.indexOf('function bindWindowSwitching('), main.indexOf('function appFrame('))
  check('index.ts: a reload, a crash or a close drops the flag', [/did-start-navigation[\s\S]*workModeWindows\.delete\(id\)/.test(bind), /render-process-gone[\s\S]*workModeWindows\.delete\(id\)/.test(bind), /'closed'[\s\S]*workModeWindows\.delete\(id\)/.test(bind)], [true, true, true])
  check('index.ts: the flag is set only for an app frame', /ipcMain\.on\(CH\.workModeActive, \(event, on\) => \{\s*const owner = appFrame\(event\)\s*if \(!owner\) return/.test(main), true)
  check('index.ts: the reader is a lazy import, and every handler is the app\'s own frames', [/import\('\.\/plugins\/workMode\.ts'\)/.test(main), /^import .*plugins\/workMode/m.test(main), (main.match(/ipcMain\.handle\(CH\.workMode\w+, async \(event[^)]*\) => \{ pluginFrame\(event\);/g) ?? []).length], [true, false, 4])
  check('index.ts: revoking the plugin stops the reader', /if \(id === 'work-mode'\) workModeReader\?\.stop\(\)/.test(main), true)
  const reader = read('src/main/plugins/workMode.ts')
  check('the reader: no sync fs, no electron, relative .ts imports', [/Sync\(/.test(reader), /from 'electron'/.test(reader), /from '\.\.?\/[^']*(?<!\.ts)'/.test(reader)], [false, false, false])
  check('the reader opens with O_NOFOLLOW and O_NONBLOCK, after a realpath containment', [/O_NOFOLLOW/.test(reader), /O_NONBLOCK/.test(reader), /isInside\(real, resolved, this\.rules\)/.test(reader)], [true, true, true])
  check('no phone or hub route reaches Work mode', ['src/main/remote/server.ts', 'src/main/hub/remote.ts'].filter((f) => existsSync(join(root, f)) && /workMode|work-mode/.test(read(f))), [])
  check('verify:layers covers WorkMode.tsx as an overlayOpen overlay', /'components\/WorkMode\.tsx': 'workModeOpen'/.test(read('scripts/verify-layers.mts')), true)
  const pkgJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
  check('package.json: the suite, and its place in check right after verify:grok-bot', [pkgJson.scripts['verify:work-mode'], /npm run verify:grok-bot && npm run verify:work-mode &&/.test(pkgJson.scripts.check)], ['node scripts/verify-work-mode.mts', true])
  check('CLAUDE.md lists work-mode after grok-bot, in the same order', /\bgrok-bot,\s*work-mode,/.test(read('CLAUDE.md')), true)
  check('the shipped constants (gotcha 175)', [WM_CHARS_DEFAULT, WM_CHARS_MIN, WM_CHARS_MAX, WM_EXIT_WINDOW_MS, WM_TAIL_QUIET_MS, WM_HINT_MS, WM_HINT_AGAIN_MS, WM_PX_PER_LINE, WM_FILL_GAP_MS, WM_JUMP_PX, WM_IDLE_MS, WM_SKIP_EVERY, WM_SKIP_RUN_MAX, WM_TABS_MAX, WM_PANEL_LINES_MAX, WM_FILES_PER_TYPE, WM_FILES_MAX, WM_FILE_MIN_BYTES, WM_FILE_MAX_BYTES, WM_TOTAL_MAX_BYTES, WM_LINE_MAX_CHARS, WM_LIST_MAX, WM_WALK_MAX_ENTRIES, WM_WALK_MAX_DEPTH, WM_TREE_MAX, WM_PICKS_MAX, WM_PROJECTS_MAX, WM_TYPES_SHOWN], [4, 1, 12, 800, 400, 2600, 800, 120, 220, 400, 1500, 6, 2, 6, 200, 8, 24, 300, 65536, 1048576, 400, 50000, 5000, 6, 500, 8, 64, 12])
  check('the FIFO fixture was made, so O_NONBLOCK was exercised (POSIX)', process.platform === 'win32' || fifo, true)
  check('the bundled sample queues its picks most-used first too (orderPicks), so its left editor is its most-used type', /const kept = orderPicks\(picks, types\)/.test(read('src/renderer/src/lib/workModeSample.ts')), true)
  check('the shipped constants added by the polish (gotcha 175)', [WM_PROSE_LINE_MAX_CHARS, WM_TREE_TESTS_MAX, WM_PANEL_DEV_MAX, WM_PANEL_TEST_MAX, WRAP_RESERVE, WRAP_MIN_TEXT, WRAP_MIN_COLS], [2000, 8, 14, 24, 2, 20, 8])

  // Item 4 (polish, prove Finding 5): a real bell from the app's icon set, and no keyboard focus ring after a click.
  const chrome = read('src/renderer/src/components/WorkModeChrome.tsx')
  const icons = read('src/renderer/src/components/Icons.tsx')
  check('the status bar ends with a bell from the app\'s icon set (IconBell, on the shared Base), not a music note', [/<IconBell \/>/.test(chrome), chrome.includes('♪'), /export const IconBell = \(p: SVGProps<SVGSVGElement>\): React\.JSX\.Element => \(\s*<Base \{\.\.\.p\}>/.test(icons)], [true, false, true])
  const editorSrc = read('src/renderer/src/components/WorkModeEditor.tsx')
  const explorerSrc = read('src/renderer/src/components/WorkModeExplorer.tsx')
  check('a press on a tab or an explorer row keeps focus where it was (a key typed after a click would draw the keyboard ring there)', [
    /const keepFocus = \(e: React\.MouseEvent\): void => e\.preventDefault\(\)/.test(editorSrc),
    /className="wm-tab"[\s\S]{0,200}onMouseDown=\{keepFocus\}/.test(editorSrc),
    /const keepFocus = \(e: React\.MouseEvent\): void => e\.preventDefault\(\)/.test(explorerSrc),
    (explorerSrc.match(/className="wm-node"[^>]*?onMouseDown=\{keepFocus\}|className="wm-node"[\s\S]{0,120}?onMouseDown=\{keepFocus\}/g) ?? []).length
  ], [true, true, true, 2])

  // Item 6 (polish, review OPEN 1): the copy promises only what is true. The shared redaction misses a short password no pattern knows.
  const copies: Array<[string, string]> = [
    ['the Settings panel', read('src/renderer/src/components/WorkModePanel.tsx').replace(/&rsquo;/g, '’').replace(/\s+/g, ' ')],
    ['the plugin row', (read('src/renderer/src/components/PluginsSettings.tsx').match(/'work-mode'\s*\?\s*'([^']+)'/)?.[1] ?? '')],
    ['docs/plugins.md', read('docs/plugins.md').slice(read('docs/plugins.md').indexOf('## Work mode'))]
  ]
  check('no copy promises that anything looking like a key or a password is left out', copies.filter(([, t]) => /anything that looks like a key|or a password is left out|password in what is read is replaced|passwords? (?:are|is) (?:left out|hidden|removed)/i.test(t)).map(([w]) => w), [])
  check('each says which files are never opened, that text shaped like a key is masked, and that it shows real code', copies.map(([w, t]) => [w, /never opens/i.test(t) && /ignore/i.test(t) && /(?:secret|\.env)/i.test(t), /shaped like a key/i.test(t), /real code/i.test(t) && /fine showing that code/i.test(t)]), copies.map(([w]) => [w, true, true, true]))
  check('the docs say a short password can still show', /a short password written into the code[^.]*is shown as it is written/.test(copies[2][1]), true)

  // Item 7 (polish): the two gotchas found in review are recorded where the code that would hit them loads them.
  const rulesKeys = read('.claude/rules/keys.md')
  const rulesMain = read('.claude/rules/main.md')
  const claudeMd = read('CLAUDE.md')
  check('gotcha 178 (a takeover\'s key paths, its menus too, preventDefault every chord) is in keys.md, whose paths reach WorkMode.tsx', [/^## 178\. /m.test(rulesKeys), /workModeMenuKey/.test(rulesKeys.slice(rulesKeys.indexOf('## 178.'))), /paths:[\s\S]*?"src\/renderer\/src\/components\/WorkMode\.tsx"[\s\S]*?---/.test(rulesKeys.slice(0, rulesKeys.indexOf('\n#')))], [true, true, true])
  check('gotcha 179 (list a repo with git only, judge a read\'s realpath, cap after the rules) is in main.md, whose src/main/** reaches the reader', [/^## 179\. /m.test(rulesMain), /ls-files (?:-z )?--cached --others --exclude-standard/.test(rulesMain.slice(rulesMain.indexOf('## 179.'))), /"src\/main\/\*\*\/\*\.ts"/.test(rulesMain.slice(0, rulesMain.indexOf('\n#')))], [true, true, true])
  const keysGroup = claudeMd.slice(claudeMd.indexOf('**Keyboard chords**'), claudeMd.indexOf('**File drop**'))
  const mainGroup = claudeMd.slice(claudeMd.indexOf('**Anywhere in the main process**'), claudeMd.indexOf('**Terminal**'))
  check('CLAUDE.md indexes each in its group, and the code cites them', [/^- \*\*178\.\*\* /m.test(keysGroup), /^- \*\*179\.\*\* /m.test(mainGroup), /gotcha 178/.test(read('src/renderer/src/components/WorkMode.tsx')), /[Gg]otcha 179/.test(read('src/main/plugins/workMode.ts'))], [true, true, true, true])
}

console.log(failures ? `\n${failures} FAILED` : '\nall pass')
process.exitCode = failures ? 1 : 0
