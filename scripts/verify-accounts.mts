/**
 * verify:accounts — agent accounts (src/shared/accounts.ts, src/main/accounts.ts).
 *
 * What is proven here, and against what:
 *  - the table: which variable moves each agent's home, which agents may hold
 *    a login account at all, and the environment one launch on an account adds;
 *  - the launch decision: which account a launch runs on, and every refusal;
 *  - the plan-limit rule until usage is keyed per account: a second account's
 *    rate limits never merge into the Default account's (gotcha 45), both
 *    arrival orders;
 *  - Claude Code's Keychain service name, against the formula read out of the
 *    2.1.285 bundle, computed independently here with node:crypto;
 *  - the account folder and its links, against SYNTHETIC default trees and a
 *    synthetic accounts root, with bystanders that must survive (gotcha 74) —
 *    nothing here reads or writes the real ~/.claude, ~/.codex or ~/.stoke;
 *  - the index the `stoke` command reads, and the REAL shim (build/bin/stoke)
 *    run against it under every POSIX shell present, its output evaluated back;
 *  - that index as what it is, a file every Stoke on the machine shares: a dev
 *    build booting with no accounts leaves the app's index byte-for-byte, each
 *    writer's rows survive the others' writes, and two writing at once both land.
 *
 * Imports are relative with `.ts` (gotcha 78). The tally and exitCode are the
 * last statements (gotchas 50, 62).
 */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACCOUNT_EXTRA_ENV,
  ACCOUNT_HOME_ENV,
  ACCOUNT_KEY_ENV,
  ACCOUNT_LOGIN_ARGS,
  ACCOUNT_SWATCHES,
  accountEnv,
  accountEnvNames,
  accountIdFor,
  accountIndexNeedsWrite,
  accountIndexRow,
  accountIndexText,
  accountKindsFor,
  accountProblem,
  accountsFromRenderer,
  accountSlug,
  cliOfAccountId,
  DEFAULT_ACCOUNT_ID,
  isAccountHome,
  isAccountId,
  LOGIN_ACCOUNTS,
  loginArgsFor,
  mergeAccountIndex,
  nextSwatch,
  parseAccountIndex,
  resolveLaunchAccount,
  usageShareOf,
  type AccountIndex,
  type AgentAccount
} from '../src/shared/accounts.ts'
import { AGENT_SEEDS } from '../src/shared/agentColors.ts'
import { CODING_CLIS, type CodingCliId } from '../src/shared/codingClis.ts'
import { keepUsage } from '../src/shared/statusLine.ts'
import type { StatusLineSnapshot } from '../src/shared/types.ts'
import {
  claudeKeychainService,
  CLAUDE_SHARED_DIRS,
  makeAccountHome,
  NEVER_SHARED,
  planAccountHome,
  prepareAccountHome,
  readClaudeAccountEmail,
  updateAccountIndex
} from '../src/main/accounts.ts'
import { usageCredentialsPath, usageKeychainService } from '../src/main/usage.ts'

let failures = 0

function check(name: string, got: unknown, want: unknown): void {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(
    `  ${pass ? 'PASS' : 'FAIL'}  ${name}` +
      (pass ? '' : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`)
  )
}

function ok(name: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass || !detail ? '' : `\n        ${detail}`))
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHIM = join(root, 'build', 'bin', 'stoke')
const CMD = join(root, 'build', 'bin', 'stoke.cmd')

const login = (id: string, home: string, over: Partial<AgentAccount> = {}): AgentAccount => ({
  id,
  cli: cliOfAccountId(id) as CodingCliId,
  label: id,
  kind: 'login',
  home,
  apiKey: '',
  ...over
})
const keyed = (id: string, apiKey: string, over: Partial<AgentAccount> = {}): AgentAccount => ({
  id,
  cli: cliOfAccountId(id) as CodingCliId,
  label: id,
  kind: 'key',
  home: '',
  apiKey,
  ...over
})

/* ------------------------------------------------------------------ table */
console.log('\nthe table: what moves each agent\u2019s sign-in (research, 2026-09-30)')
{
  check('the home variables, exactly the verified ones', ACCOUNT_HOME_ENV, {
    claude: 'CLAUDE_CONFIG_DIR',
    codex: 'CODEX_HOME',
    grok: 'GROK_HOME',
    gemini: 'GEMINI_CLI_HOME',
    qwen: 'QWEN_HOME',
    kimi: 'KIMI_CODE_HOME',
    copilot: 'COPILOT_HOME',
    pi: 'PI_CODING_AGENT_DIR',
    cline: 'CLINE_DIR',
    vibe: 'VIBE_HOME',
    droid: 'FACTORY_HOME_OVERRIDE'
  })
  ok('Cursor has no home variable: its credentials are fixed Keychain names', !('cursor' in ACCOUNT_HOME_ENV))
  ok('so Cursor holds no login account', !LOGIN_ACCOUNTS.has('cursor'))
  ok('nor Vibe, whose key sits in one keyring item whatever VIBE_HOME says', !LOGIN_ACCOUNTS.has('vibe'))
  ok('every other agent with a home variable can hold a login account', Object.keys(ACCOUNT_HOME_ENV).filter((id) => id !== 'vibe').every((id) => LOGIN_ACCOUNTS.has(id as CodingCliId)))
  ok('Claude Code takes no key account: its key is Settings \u203a Providers (gotcha 57)', !('claude' in ACCOUNT_KEY_ENV))
  check('Cursor\u2019s key always travels with the in-memory store', ACCOUNT_KEY_ENV.cursor, { key: 'CURSOR_API_KEY', with: { AGENT_CLI_CREDENTIAL_STORE: 'memory' } })
  check('Gemini\u2019s login accounts stay on the per-home file store', ACCOUNT_EXTRA_ENV.gemini, { GEMINI_FORCE_ENCRYPTED_FILE_STORAGE: 'false' })
  check('the agent\u2019s own sign-in command, where one was read', ACCOUNT_LOGIN_ARGS, { claude: ['auth', 'login'], codex: ['login'] })
  check('every other agent\u2019s sign-in tab runs the agent itself', loginArgsFor('grok'), [])
  ok('every agent in the tables is a known agent', [...Object.keys(ACCOUNT_HOME_ENV), ...Object.keys(ACCOUNT_KEY_ENV)].every((id) => CODING_CLIS.some((c) => c.id === id)))
  check('what each agent can hold: Claude', accountKindsFor('claude'), ['login'])
  check('Grok: both', accountKindsFor('grok'), ['login', 'key'])
  check('Cursor: a key only', accountKindsFor('cursor'), ['key'])
  check('Aider: neither', accountKindsFor('aider'), [])
  check(
    'every variable an account can set, for `stoke account env default`',
    accountEnvNames(),
    [...Object.values(ACCOUNT_HOME_ENV), 'GEMINI_FORCE_ENCRYPTED_FILE_STORAGE']
  )
}

console.log('\nthe environment one launch on an account adds')
{
  for (const [cli, name] of Object.entries(ACCOUNT_HOME_ENV) as [CodingCliId, string][]) {
    if (!LOGIN_ACCOUNTS.has(cli)) continue
    const home = `/u/.stoke/accounts/${cli}-work`
    check(`${cli}: ${name}`, accountEnv(login(`${cli}-work`, home)), { [name]: home, ...(ACCOUNT_EXTRA_ENV[cli] ?? {}) })
  }
  for (const [cli, spec] of Object.entries(ACCOUNT_KEY_ENV) as [CodingCliId, { key: string; with?: Record<string, string> }][]) {
    check(`${cli} key account: ${spec.key}`, accountEnv(keyed(`${cli}-ci`, 'k-1')), { ...(spec.with ?? {}), [spec.key]: 'k-1' })
  }
  check('a key account with no key adds nothing', accountEnv(keyed('grok-ci', '')), {})
}

/* ------------------------------------------------------------- names, ids */
console.log('\nnames and ids')
{
  check('a name becomes a slug', accountSlug('  Side Gig — 2026! '), 'side-gig-2026')
  check('accents fold', accountSlug('Équipe Café'), 'equipe-cafe')
  check('nothing usable is empty, never a bare dash', [accountSlug('---'), accountSlug('!!'), accountSlug('')], ['', '', ''])
  ok('a slug is cut to 32 with no trailing dash', accountSlug('a'.repeat(31) + ' b c').length <= 32 && !accountSlug('a'.repeat(31) + ' b c').endsWith('-'))
  check('an id is <cli>-<slug>', accountIdFor('claude', 'work'), 'claude-work')
  check('ids and their agents', ['claude-work', 'codex-2', 'default', 'banana-1', 'Claude-Work', 'claude-', 'claude-../x', 'grok-a-b'].map((v) => [isAccountId(v), cliOfAccountId(v)]), [
    [true, 'claude'],
    [true, 'codex'],
    [false, null],
    [false, null],
    [false, null],
    [false, null],
    [false, null],
    [true, 'grok']
  ])
  check('homes: absolute, on either platform, no control characters', ['/a/b', 'C:\\a\\b', '\\\\srv\\share\\x', 'rel/x', '/a\nb', '/a\tb', '', 7].map(isAccountHome), [true, true, true, false, false, false, false, false])
}

console.log('\ncolour: every account swatch is an agent seed, so it clears every floor a seed does')
{
  const seeds = new Set(Object.values(AGENT_SEEDS))
  ok('each swatch is one of AGENT_SEEDS (held to the meter/danger/warning floors by verify:agents)', ACCOUNT_SWATCHES.every((s) => seeds.has(s.seed)))
  check('swatch ids are unique', new Set(ACCOUNT_SWATCHES.map((s) => s.id)).size, ACCOUNT_SWATCHES.length)
  ok('a new Claude account never wears Claude\u2019s own pink', ACCOUNT_SWATCHES.find((s) => s.id === nextSwatch('claude', [], AGENT_SEEDS.claude))?.seed !== AGENT_SEEDS.claude)
  const first = nextSwatch('claude', [], AGENT_SEEDS.claude)
  ok('and a second one wears a third colour', nextSwatch('claude', [first], AGENT_SEEDS.claude) !== first)
}

/* ---------------------------------------------------------------- launch */
console.log('\nwhich account a launch runs on')
{
  const work = login('claude-work', '/u/.stoke/accounts/claude-work')
  const cx = login('codex-2', '/u/.stoke/accounts/codex-2')
  const accounts = { 'claude-work': work, 'codex-2': cx }
  check('no default chosen: the agent\u2019s own sign-in', resolveLaunchAccount({ cli: 'claude', accounts, defaults: {} }), { ok: true, accountId: DEFAULT_ACCOUNT_ID, account: null })
  check('a default chosen: that account', resolveLaunchAccount({ cli: 'claude', accounts, defaults: { claude: 'claude-work' } }), { ok: true, accountId: 'claude-work', account: work })
  check(
    'a default since removed falls back rather than stopping Start',
    resolveLaunchAccount({ cli: 'claude', accounts: {}, defaults: { claude: 'claude-work' } }),
    { ok: true, accountId: DEFAULT_ACCOUNT_ID, account: null }
  )
  check(
    'a tab on Default asks for Default by name, whatever the default is now',
    resolveLaunchAccount({ cli: 'claude', requested: 'default', accounts, defaults: { claude: 'claude-work' } }),
    { ok: true, accountId: DEFAULT_ACCOUNT_ID, account: null }
  )
  const gone = resolveLaunchAccount({ cli: 'claude', requested: 'claude-old', accounts, defaults: {} })
  ok('a tab asking for an account since removed is refused, not moved to another plan', !gone.ok && /no longer/.test(gone.message), JSON.stringify(gone))
  const cross = resolveLaunchAccount({ cli: 'claude', requested: 'codex-2', accounts, defaults: {} })
  ok('an account of another agent is refused (account.cli !== cliId)', !cross.ok && /cannot start Claude Code/.test(cross.message), JSON.stringify(cross))
  const junk = resolveLaunchAccount({ cli: 'claude', requested: '../../etc', accounts, defaults: {} })
  ok('an id that is not one is refused', !junk.ok)
  check('a login account with a home launches', accountProblem(work), null)
  ok('one whose home was cleared is refused', accountProblem({ ...work, home: '' }) !== null)
  ok('a key account with no key is refused', /no key yet/.test(accountProblem(keyed('grok-ci', '')) ?? ''))
  ok('a key account beside a custom endpoint is refused', /custom endpoint/.test(accountProblem(keyed('grok-ci', 'k'), 'custom') ?? ''))
  check('and beside its own sign-in it launches', accountProblem(keyed('grok-ci', 'k'), 'default'), null)
}

console.log('\na settings patch from the renderer')
{
  const work = login('claude-work', '/u/.stoke/accounts/claude-work', { label: 'Work', swatch: 'teal' })
  const team = keyed('grok-team', 'old')
  const cur = { 'claude-work': work, 'grok-team': team }
  const next = accountsFromRenderer(cur, {
    'claude-work': { label: ' Day job ', home: '/etc', kind: 'key', cli: 'codex', swatch: 'sky' },
    'grok-team': { apiKey: ' new ' },
    'codex-evil': { kind: 'login', home: '/tmp/evil', cli: 'codex' }
  })
  check('a label and a swatch change; the home, kind and agent do not', next['claude-work'], { ...work, label: 'Day job', swatch: 'sky' })
  check('a key account\u2019s key changes', next['grok-team']?.apiKey, 'new')
  check('nothing is added', Object.keys(next), ['claude-work', 'grok-team'])
  check('an account the patch leaves out stays', Object.keys(accountsFromRenderer(cur, { 'grok-team': { label: 'T' } })), ['claude-work', 'grok-team'])
  check('junk changes nothing', accountsFromRenderer(cur, 'x'), cur)
}

/* ----------------------------------------------------------------- usage */
console.log('\nthe plan-limit chip reads the Default account only (gotcha 45)')
{
  const snap = (receivedAt: number, five: number | null): StatusLineSnapshot => ({
    sessionId: `s${receivedAt}`,
    promptId: null,
    contextWindowSize: 200_000,
    usedPercentage: 10,
    modelId: 'claude-opus-5',
    modelName: 'Opus 5',
    exceeds200k: false,
    cliVersion: '2.1.285',
    fiveHour: five === null ? null : { percent: five, resetsAt: 1_900_000_000_000 },
    sevenDay: five === null ? null : { percent: five / 2, resetsAt: 1_900_500_000_000 },
    receivedAt
  })
  const mine = snap(1000, 20)
  const theirs = snap(2000, 90)
  check('the Default account\u2019s reading passes as it is', usageShareOf(mine, 'default'), mine)
  check('so does one from a session whose account is unknown', usageShareOf(mine, undefined), mine)
  check('another account keeps its per-session fields and hands over no rate limits', usageShareOf(theirs, 'claude-work'), { ...theirs, fiveHour: null, sevenDay: null })
  // Both arrival orders, as main (`lastStatusLine`) and the chip merge them.
  const afterTheirs = keepUsage(keepUsage(null, mine), usageShareOf(theirs, 'claude-work'))
  check('Default first, then a NEWER reading from account 2: the figures stay Default\u2019s', afterTheirs.fiveHour?.percent, 20)
  const theirsFirst = keepUsage(keepUsage(null, usageShareOf(theirs, 'claude-work')), mine)
  check('account 2 first, then Default: Default\u2019s figures', theirsFirst.fiveHour?.percent, 20)
  check('and nothing from account 2 alone', keepUsage(null, usageShareOf(theirs, 'claude-work')).fiveHour, null)
}

/* -------------------------------------------------------------- Keychain */
console.log('\nClaude Code\u2019s Keychain service name (wN() in 2.1.285)')
{
  const hash8 = (s: string): string => createHash('sha256').update(s.normalize('NFC')).digest('hex').substring(0, 8)
  const dir = '/Users/v/.stoke/accounts/claude-work'
  check('no CLAUDE_CONFIG_DIR: the plain name the Default account has always used', claudeKeychainService({}), 'Claude Code-credentials')
  check('an empty one counts as none', claudeKeychainService({ CLAUDE_CONFIG_DIR: '' }), 'Claude Code-credentials')
  check('a config dir: sha256 of the dir, first 8 hex', claudeKeychainService({ CLAUDE_CONFIG_DIR: dir }), `Claude Code-credentials-${hash8(dir)}`)
  check('pinned against one computed by hand', claudeKeychainService({ CLAUDE_CONFIG_DIR: '/tmp/x' }), `Claude Code-credentials-${createHash('sha256').update('/tmp/x').digest('hex').slice(0, 8)}`)
  const composed = '/Users/Zo\u00e9/.stoke/accounts/claude-work'
  const decomposed = '/Users/Zoe\u0301/.stoke/accounts/claude-work'
  check('NFC first: a decomposed path names the same item as its composed spelling', claudeKeychainService({ CLAUDE_CONFIG_DIR: decomposed }), claudeKeychainService({ CLAUDE_CONFIG_DIR: composed }))
  ok('and a different dir names a different item', claudeKeychainService({ CLAUDE_CONFIG_DIR: `${dir}2` }) !== claudeKeychainService({ CLAUDE_CONFIG_DIR: dir }))
  check('CLAUDE_SECURESTORAGE_CONFIG_DIR wins over the config dir', claudeKeychainService({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: '/s' }), `Claude Code-credentials-${hash8('/s')}`)
  check('and set empty it means the plain name', claudeKeychainService({ CLAUDE_CONFIG_DIR: dir, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }), 'Claude Code-credentials')
  check('a staging OAuth URL adds its suffix first', claudeKeychainService({ CLAUDE_CODE_CUSTOM_OAUTH_URL: 'https://staging.example' }), 'Claude Code-staging-oauth-credentials')
  check('usage.ts reads the item for the dir it was started with', usageKeychainService({ CLAUDE_CONFIG_DIR: dir }), claudeKeychainService({ CLAUDE_CONFIG_DIR: dir }))
  check('and the credentials file beside it', usageCredentialsPath({ CLAUDE_CONFIG_DIR: dir }, '/Users/v'), `${dir}/.credentials.json`)
  check('with no dir, ~/.claude as ever', usageCredentialsPath({}, '/Users/v'), '/Users/v/.claude/.credentials.json')
}

/* ---------------------------------------------------- the shared index */
console.log('\nthe index is shared by every Stoke on the machine: merged per writer, never replaced')
{
  // Two userData folders, as the installed app and `npm run dev` have (gotcha 12).
  const APP = '/Users/v/Library/Application Support/Stoke'
  const DEV = '/Users/v/Library/Application Support/Stoke (dev)'
  const work = login('claude-work', '/Users/v/.stoke/accounts/claude-work', { label: 'Work' })
  const cxw = login('codex-work', '/Users/v/.stoke/accounts/codex-work', { label: 'Codex work' })
  const dev2 = login('gemini-dev', '/Users/v/.stoke/accounts/gemini-dev', { label: 'Dev' })
  const ids = (x: AccountIndex): string[] => x.rows.map((r) => r.id)
  const byApp = mergeAccountIndex({ existing: null, me: APP, mine: [work, cxw] })
  check('the app’s first write: its rows, and its record', [ids(byApp), byApp.writers], [['claude-work', 'codex-work'], [{ userData: APP, ids: ['claude-work', 'codex-work'] }]])
  // The reviewer's case: the dev build boots with no accounts and finds the app's index.
  ok('a Stoke that never held an account has nothing to write, even with an index there', !accountIndexNeedsWrite(byApp, DEV, []))
  ok('and neither does one with no index at all', !accountIndexNeedsWrite(null, DEV, []))
  ok('a Stoke with accounts always writes', accountIndexNeedsWrite(null, DEV, [dev2]))
  const withDev = mergeAccountIndex({ existing: byApp, me: DEV, mine: [dev2] })
  check('the dev build adding one keeps the app’s rows', ids(withDev), ['claude-work', 'codex-work', 'gemini-dev'])
  check('and records each writer apart', withDev.writers.map((w) => [w.userData, w.ids]), [[APP, ['claude-work', 'codex-work']], [DEV, ['gemini-dev']]])
  ok('a Stoke that HAD accounts must write, to take them back', accountIndexNeedsWrite(withDev, DEV, []))
  const devGone = mergeAccountIndex({ existing: withDev, me: DEV, mine: [] })
  check('the dev build removing its last: only its own row goes', ids(devGone), ['claude-work', 'codex-work'])
  check('and its record goes with it', devGone.writers.map((w) => w.userData), [APP])
  const appDrops = mergeAccountIndex({ existing: withDev, me: APP, mine: [work] })
  check('the app removing one keeps the dev build’s', ids(appDrops), ['claude-work', 'gemini-dev'])
  const both = mergeAccountIndex({ existing: byApp, me: DEV, mine: [work] })
  const oneLeaves = mergeAccountIndex({ existing: both, me: APP, mine: [cxw] })
  ok('an id two Stokes hold stays while either still does', ids(oneLeaves).includes('claude-work') && ids(oneLeaves).includes('codex-work'), JSON.stringify(ids(oneLeaves)))
  const relabel = mergeAccountIndex({ existing: withDev, me: APP, mine: [{ ...work, label: 'Work (me@example.com)' }, cxw] })
  check('a writer’s row replaces its old one in place', relabel.rows.map((r) => [r.id, r.label]), [
    ['claude-work', 'Work (me@example.com)'],
    ['codex-work', 'Codex work'],
    ['gemini-dev', 'Dev']
  ])
  const SANDBOX = '/tmp/stoke-sbx-x/ud'
  const withSandbox = mergeAccountIndex({ existing: withDev, me: SANDBOX, mine: [login('claude-sbx', '/Users/v/.stoke/accounts/claude-sbx')] })
  const pruned = mergeAccountIndex({ existing: withSandbox, me: APP, mine: [work, cxw], gone: (u) => u === SANDBOX })
  check('a writer whose userData is gone is dropped, with the rows only it held', [ids(pruned), pruned.writers.map((w) => w.userData)], [['claude-work', 'codex-work', 'gemini-dev'], [APP, DEV]])
  const legacy: AccountIndex = { rows: byApp.rows, writers: [] }
  check('rows no writer claims (an index from before writers) are dropped; the owner writes its own back', ids(mergeAccountIndex({ existing: legacy, me: DEV, mine: [dev2] })), ['gemini-dev'])

  console.log('\nthe index read back')
  check('text round-trips through the parser', parseAccountIndex(accountIndexText(withDev)), withDev)
  check('not JSON is null, never a guess', parseAccountIndex('{"accounts": ['), null)
  check('an index with no writers reads as none', parseAccountIndex('{"accounts":[],"version":1}'), { rows: [], writers: [] })
  const good = accountIndexRow(work)
  const junk = [
    { ...good, home: '/Users/v/a\u0007b' },
    { ...good, id: 'claude-work', name: 'other' },
    { ...good, env: 'CLAUDE CONFIG' },
    { ...good, env: '' },
    { ...good, extra: 'X=$(rm -rf ~)' },
    { ...good, home: 'relative/path' },
    { ...good, label: 7 },
    'not a row'
  ]
  check(
    'every row the shim could not trust is dropped, one by one',
    parseAccountIndex(JSON.stringify({ accounts: [good, ...junk], writers: [{ userData: APP, ids: ['claude-work', 'nope nope', 3] }, { userData: '' }] })),
    { rows: [good], writers: [{ userData: APP, ids: ['claude-work'] }] }
  )
  const future = { ...good, id: 'zed-work', name: 'work', cli: 'zed', env: 'ZED_HOME' }
  check('an agent this version does not know still passes, so an older Stoke keeps a newer one’s account', parseAccountIndex(JSON.stringify({ accounts: [future], writers: [] }))?.rows, [future])
  const text = accountIndexText(withDev)
  ok('no writer line looks like an account line to the shim', text.split('\n').filter((l) => l.includes('{"id":"')).length === withDev.rows.length)
}

/* ---------------------------------------------------- folders and links */
console.log('\nthe account folder and its links, against synthetic trees (gotcha 74)')
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'stoke-verify-accounts-')))
try {
  const userHome = join(scratch, 'home')
  const claudeTree = join(userHome, '.claude')
  const codexTree = join(userHome, '.codex')
  const accountsDir = join(userHome, '.stoke', 'accounts')
  for (const d of ['projects/-u-proj', 'skills/pdf', 'commands']) mkdirSync(join(claudeTree, d), { recursive: true })
  writeFileSync(join(claudeTree, 'projects', '-u-proj', 'old.jsonl'), '{"type":"user"}\n')
  writeFileSync(join(claudeTree, 'settings.json'), '{"model":"opus"}\n')
  writeFileSync(join(claudeTree, 'CLAUDE.md'), '# mine\n')
  // The default account's sign-in. Never linked, copied or touched.
  const dotClaudeJson = join(userHome, '.claude.json')
  writeFileSync(dotClaudeJson, '{"oauthAccount":{"emailAddress":"me@default.example"}}')
  writeFileSync(join(claudeTree, '.credentials.json'), '{"claudeAiOauth":{"accessToken":"sk-ant-oat-DEFAULT"}}')
  for (const d of ['skills/x', 'sessions/2026']) mkdirSync(join(codexTree, d), { recursive: true })
  writeFileSync(join(codexTree, 'config.toml'), 'model = "gpt-6"\n')
  writeFileSync(join(codexTree, 'auth.json'), '{"tokens":{"access_token":"DEFAULT"}}')
  // Bystanders: another account's folder and a stray file in the accounts root.
  mkdirSync(join(accountsDir, 'claude-other'), { recursive: true })
  writeFileSync(join(accountsDir, 'claude-other', 'keep.txt'), 'bystander')
  writeFileSync(join(accountsDir, 'notes.txt'), 'bystander')
  const trees = { claude: claudeTree, codex: codexTree }

  const made = await makeAccountHome({ root: accountsDir, id: 'claude-work', cli: 'claude', trees })
  const home = made.home
  check('the home is <root>/<id>, realpath\u2019d', home, join(realpathSync(accountsDir), 'claude-work'))
  check('linked: the dirs the default tree has, plus the two it must', made.report.linked, ['projects', 'sessions', 'skills', 'commands'])
  check('skipped: the ones it does not have', made.report.skipped, ['agents', 'plugins', 'output-styles'])
  check('copied once: settings.json and CLAUDE.md', made.report.copied, ['settings.json', 'CLAUDE.md'])
  ok('sessions was made in the default tree, so the registry stays one tree', existsSync(join(claudeTree, 'sessions')) && lstatSync(join(claudeTree, 'sessions')).isDirectory())
  for (const name of ['projects', 'sessions', 'skills', 'commands']) {
    const link = join(home, name)
    // realpath rather than readlink text: a Windows junction reads back in its own spelling.
    ok(
      `${name} is a link into the default tree`,
      lstatSync(link).isSymbolicLink() && realpathSync(link) === realpathSync(join(claudeTree, name)),
      readlinkSync(link)
    )
  }
  writeFileSync(join(home, 'projects', '-u-proj', 'new.jsonl'), '{"type":"user"}\n')
  ok('a transcript written under the account lands in the default tree', existsSync(join(claudeTree, 'projects', '-u-proj', 'new.jsonl')))
  ok('and the default tree\u2019s own are visible from the account', existsSync(join(home, 'projects', '-u-proj', 'old.jsonl')))
  ok('no .claude.json in the account: its own sign-in, never the default\u2019s', !existsSync(join(home, '.claude.json')))
  ok('no .credentials.json either', !existsSync(join(home, '.credentials.json')))
  check('the default .claude.json is byte-for-byte untouched', readFileSync(dotClaudeJson, 'utf8'), '{"oauthAccount":{"emailAddress":"me@default.example"}}')
  ok('settings.json is a copy, not a link', !lstatSync(join(home, 'settings.json')).isSymbolicLink())

  writeFileSync(join(home, 'settings.json'), '{"model":"sonnet"}\n')
  mkdirSync(join(home, 'agents'))
  const again = await prepareAccountHome(planAccountHome('claude', home, trees))
  check('a second run keeps every link it made', again.kept.slice(0, 4), ['projects', 'sessions', 'skills', 'commands'])
  check('and never writes over the account\u2019s own copy', readFileSync(join(home, 'settings.json'), 'utf8'), '{"model":"sonnet"}\n')
  ok('a real folder the agent made where a link would go is left alone', again.foreign.includes('agents') && lstatSync(join(home, 'agents')).isDirectory() && !lstatSync(join(home, 'agents')).isSymbolicLink())
  check('it linked nothing new', again.linked, [])

  const cx = await makeAccountHome({ root: accountsDir, id: 'codex-work', cli: 'codex', trees })
  check('Codex: only skills linked', cx.report.linked, ['skills'])
  check('config.toml copied once', cx.report.copied, ['config.toml'])
  ok('its auth.json is its own: never copied', !existsSync(join(cx.home, 'auth.json')))
  ok('its sessions are its own: they carry that account\u2019s rate limits', !existsSync(join(cx.home, 'sessions')))

  const gk = await makeAccountHome({ root: accountsDir, id: 'grok-work', cli: 'grok', trees })
  ok('Grok: a real, empty folder with no symlink in its path (grok refuses one)', lstatSync(gk.home).isDirectory() && !lstatSync(gk.home).isSymbolicLink() && realpathSync(gk.home) === gk.home)
  check('and nothing linked or copied', [gk.report.linked, gk.report.copied], [[], []])

  // A symlinked accounts root: the home is stored through it, as the CLI resolves its cwd (gotcha 91).
  const realRoot = join(scratch, 'elsewhere', 'accounts')
  mkdirSync(realRoot, { recursive: true })
  const linkedRoot = join(scratch, 'linked-accounts')
  symlinkSync(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir')
  const via = await makeAccountHome({ root: linkedRoot, id: 'claude-x', cli: 'claude', trees })
  check('a home made through a symlinked root is stored as its realpath', via.home, join(realpathSync(realRoot), 'claude-x'))

  let refused = false
  try {
    await prepareAccountHome({ home, links: [], copies: [{ from: dotClaudeJson, to: join(home, '.claude.json') }] })
  } catch {
    refused = true
  }
  ok('a plan that would copy .claude.json is refused before anything is written', refused && !existsSync(join(home, '.claude.json')))
  ok('NEVER_SHARED names every sign-in file', ['.claude.json', '.credentials.json', 'auth.json'].every((f) => NEVER_SHARED.includes(f)))
  ok('and no shared dir is one of them', CLAUDE_SHARED_DIRS.every((d) => !NEVER_SHARED.includes(d)))
  check('the bystander account survives', readFileSync(join(accountsDir, 'claude-other', 'keep.txt'), 'utf8'), 'bystander')
  check('and the stray file in the accounts root', readFileSync(join(accountsDir, 'notes.txt'), 'utf8'), 'bystander')
  check('the default credentials file is untouched', readFileSync(join(claudeTree, '.credentials.json'), 'utf8'), '{"claudeAiOauth":{"accessToken":"sk-ant-oat-DEFAULT"}}')

  console.log('\nthe email a Claude account signed in as, read-only')
  check('none before a sign-in', await readClaudeAccountEmail(home), null)
  const signedIn = '{"oauthAccount":{"emailAddress":"two@example.com","accountUuid":"u"},"projects":{}}'
  writeFileSync(join(home, '.claude.json'), signedIn)
  check('its own .claude.json, oauthAccount.emailAddress', await readClaudeAccountEmail(home), 'two@example.com')
  check('and the file is not rewritten by the read', readFileSync(join(home, '.claude.json'), 'utf8'), signedIn)
  writeFileSync(join(home, '.config.json'), '{"oauthAccount":{"emailAddress":"override@example.com"}}')
  check('the .config.json the CLI prefers wins, as it does for the CLI', await readClaudeAccountEmail(home), 'override@example.com')
  writeFileSync(join(home, '.config.json'), '{not json')
  check('an unparseable one is no email, never a guess', await readClaudeAccountEmail(home), null)

  /* ------------------------------------------------------ index + shim */
  console.log('\nthe index, and the real stoke shim reading it')
  const accounts: AgentAccount[] = [
    login('claude-work', home, { label: 'Work "main" 100%' }),
    login('codex-work', `${cx.home}'s`, { label: 'Work' }),
    login('gemini-2', join(accountsDir, 'gemini-2'), { label: 'Gemini 2' }),
    keyed('grok-team', 'xai-NEVER-IN-INDEX', { label: 'Team' }),
    login('claude-odd', join(accountsDir, 'odd"dir'), { label: 'Odd' })
  ]
  // Synthetic userData folders: the installed app's and the dev build's (gotcha 74 — none are real).
  const udApp = join(scratch, 'ud-app')
  const udDev = join(scratch, 'ud-dev')
  mkdirSync(udApp)
  mkdirSync(udDev)
  const firstWrite = await updateAccountIndex({ root: accountsDir, me: udApp, accounts })
  const indexFile = firstWrite.file
  ok('the app with accounts writes the index', firstWrite.wrote)
  const text = readFileSync(indexFile, 'utf8')
  ok('the index is JSON', (() => {
    try {
      return Array.isArray(JSON.parse(text).accounts)
    } catch {
      return false
    }
  })())
  ok('no key is ever written to it', !text.includes('xai-NEVER-IN-INDEX'))
  check('one account per line', text.split('\n').filter((l) => l.trimStart().startsWith('{"id":')).length, accounts.length)
  check('the index text is the pure builder\u2019s', text, accountIndexText(mergeAccountIndex({ existing: null, me: udApp, mine: accounts })))
  check('the bystander file beside it survives', readFileSync(join(accountsDir, 'notes.txt'), 'utf8'), 'bystander')

  const SHELLS = ['/bin/sh', '/bin/bash', '/bin/dash', '/bin/zsh'].filter((s) => existsSync(s))
  if (process.platform === 'win32' || SHELLS.length === 0) {
    console.log('  SKIP  no POSIX shell here to run build/bin/stoke with.')
  } else {
    const run = (shell: string, args: string[], env: Record<string, string> = {}) =>
      spawnSync(shell, [SHIM, ...args], { env: { PATH: '/usr/bin:/bin', HOME: userHome, ...env }, encoding: 'utf8' })
    for (const shell of SHELLS) {
      const env = run(shell, ['account', 'env', 'work'])
      check(`${shell}: env work exports both agents\u2019 work homes, single-quoted`, env.stdout, [
        `export CLAUDE_CONFIG_DIR='${home}'`,
        `export CODEX_HOME='${cx.home}'\\''s'`,
        ''
      ].join('\n'))
      check(`${shell}: exit 0`, env.status, 0)
      ok(`${shell}: the line it will not quote is skipped out loud`, /skipping claude-odd/.test(env.stderr), env.stderr)
      // Evaluated back by the same shell: the value the agent would get.
      const evald = spawnSync(shell, ['-c', `eval "$(${shell} '${SHIM}' account env work 2>/dev/null)"; printf '%s\\n%s\\n' "$CLAUDE_CONFIG_DIR" "$CODEX_HOME"`], {
        env: { PATH: '/usr/bin:/bin', HOME: userHome },
        encoding: 'utf8'
      })
      check(`${shell}: eval "$(stoke account env work)" sets exactly the stored homes`, evald.stdout, `${home}\n${cx.home}'s\n`)
      check(
        `${shell}: env claude-work is that one account`,
        run(shell, ['account', 'env', 'claude-work']).stdout,
        `export CLAUDE_CONFIG_DIR='${home}'\n`
      )
      check(
        `${shell}: a Gemini account also keeps Gemini on its file store`,
        run(shell, ['account', 'env', 'gemini-2']).stdout,
        `export GEMINI_CLI_HOME='${join(accountsDir, 'gemini-2')}'\nexport GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=false\n`
      )
      ok(`${shell}: a key account exports nothing, and says so`, /^# grok-team is an API-key account/.test(run(shell, ['account', 'env', 'team']).stdout))
      check(`${shell}: env default unsets every account variable`, run(shell, ['account', 'env', 'default']).stdout, `unset ${accountEnvNames().join(' ')}\n`)
      const nobody = run(shell, ['account', 'env', 'nope'])
      ok(`${shell}: an unknown name fails with a sentence`, nobody.status === 1 && /no account called nope/.test(nobody.stderr), nobody.stderr)
      const bad = run(shell, ['account', 'env', 'a;rm'])
      ok(`${shell}: a name that is not a name is refused before anything is read`, bad.status === 1 && bad.stdout === '', bad.stderr)
      const list = run(shell, ['account', 'list'])
      ok(`${shell}: list names every account it can print, labels unescaped`, list.status === 0 && /claude-work +claude +Work "main" 100%/.test(list.stdout) && /grok-team/.test(list.stdout) && /an API key/.test(list.stdout), list.stdout)
      const empty = run(shell, ['account', 'list'], { HOME: join(scratch, 'nobody') })
      ok(`${shell}: with no index, list says how to add one`, empty.status === 0 && /No accounts yet/.test(empty.stdout), empty.stdout + empty.stderr)
      check(
        `${shell}: with no index, env default still unsets every variable (the shim\u2019s own list matches the table)`,
        run(shell, ['account', 'env', 'default'], { HOME: join(scratch, 'nobody') }).stdout,
        `unset ${accountEnvNames().join(' ')}\n`
      )
    }
  }

  console.log('\nevery Stoke on the machine writes that one index: the app, the dev build, a sandbox')
  const appIds = accounts.map((a) => a.id)
  const readIndex = (): AccountIndex | null => parseAccountIndex(readFileSync(indexFile, 'utf8'))
  const before = readFileSync(indexFile, 'utf8')
  const devBoot = await updateAccountIndex({ root: accountsDir, me: udDev, accounts: [] })
  ok('the dev build booting with no accounts writes nothing', !devBoot.wrote)
  check('and the app’s index is byte-for-byte what it was', readFileSync(indexFile, 'utf8'), before)
  if (SHELLS.length) {
    const after = spawnSync(SHELLS[0], [SHIM, 'account', 'env', 'claude-work'], { env: { PATH: '/usr/bin:/bin', HOME: userHome }, encoding: 'utf8' })
    check('so `stoke account env` still answers for the app’s account', after.stdout, `export CLAUDE_CONFIG_DIR='${home}'\n`)
  }
  const devAccount = login('gemini-dev', join(accountsDir, 'gemini-dev'), { label: 'Dev' })
  await updateAccountIndex({ root: accountsDir, me: udDev, accounts: [devAccount] })
  check('the dev build adding one keeps every account of the app’s', readIndex()?.rows.map((r) => r.id), [...appIds, 'gemini-dev'])
  const devClear = await updateAccountIndex({ root: accountsDir, me: udDev, accounts: [] })
  ok('removing its last, it writes once more to take it back', devClear.wrote)
  check('leaving exactly the app’s accounts', readIndex()?.rows.map((r) => r.id), appIds)
  check('and no record of the dev build', readIndex()?.writers.map((w) => w.userData), [udApp])
  ok('after which it has nothing to write again', !(await updateAccountIndex({ root: accountsDir, me: udDev, accounts: [] })).wrote)

  const udSandbox = join(scratch, 'ud-sandbox')
  mkdirSync(udSandbox)
  await updateAccountIndex({ root: accountsDir, me: udSandbox, accounts: [login('claude-sbx', join(accountsDir, 'claude-sbx'))] })
  ok('a sandbox’s account is listed while its userData exists', !!readIndex()?.rows.some((r) => r.id === 'claude-sbx'))
  rmSync(udSandbox, { recursive: true })
  await updateAccountIndex({ root: accountsDir, me: udApp, accounts })
  check('once that folder is deleted, the next write drops it and its account', [readIndex()?.rows.map((r) => r.id), readIndex()?.writers.map((w) => w.userData)], [appIds, [udApp]])

  const udA = join(scratch, 'ud-a')
  const udB = join(scratch, 'ud-b')
  mkdirSync(udA)
  mkdirSync(udB)
  await Promise.all([
    updateAccountIndex({ root: accountsDir, me: udA, accounts: [login('qwen-a', join(accountsDir, 'qwen-a'))] }),
    updateAccountIndex({ root: accountsDir, me: udB, accounts: [login('kimi-b', join(accountsDir, 'kimi-b'))] })
  ])
  const raced = readIndex()?.rows.map((r) => r.id) ?? []
  ok('two Stokes writing at once both land (the lock)', raced.includes('qwen-a') && raced.includes('kimi-b') && appIds.every((id) => raced.includes(id)), JSON.stringify(raced))
  const lock = `${indexFile}.lock`
  ok('and no lock is left behind', !existsSync(lock))
  mkdirSync(lock)
  const longAgo = new Date(Date.now() - 60_000)
  utimesSync(lock, longAgo, longAgo)
  const t0 = Date.now()
  await updateAccountIndex({ root: accountsDir, me: udA, accounts: [] })
  ok('a crashed writer’s stale lock is broken, not waited out', Date.now() - t0 < 1_000 && !existsSync(lock), `${Date.now() - t0} ms`)
  ok('and the write behind it landed', !readIndex()?.rows.some((r) => r.id === 'qwen-a') && !!readIndex()?.rows.some((r) => r.id === 'kimi-b'))
  check('the bystander file beside the index still survives', readFileSync(join(accountsDir, 'notes.txt'), 'utf8'), 'bystander')

  const cmdText = readFileSync(CMD, 'utf8')
  const psDefaults = /\$names = @\(([^)]*)\)/.exec(cmdText)?.[1]?.replace(/'/g, '').split(',') ?? []
  check('stoke.cmd\u2019s fallback list for env default is the table\u2019s too', psDefaults, accountEnvNames())
  ok('stoke.cmd hands the name to PowerShell as data, never inside the script (gotcha 101)', cmdText.includes('set "STOKE_ACCOUNT_NAME=%~3"') && cmdText.includes('$env:STOKE_ACCOUNT_NAME'))
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
