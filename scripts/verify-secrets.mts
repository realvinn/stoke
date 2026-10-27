/*
 * Secrets at rest and the portable setup file.
 *
 * Everything here runs against a SYNTHETIC userData under the OS temp dir and
 * an INJECTED key store, never the real Keychain and never a real profile
 * (gotcha 74: fake every input — the directory as well as the backend — and
 * prove a bystander survives). The setup file is sealed with the real
 * node:crypto scrypt and AES-256-GCM at the shipped parameters, so a round
 * trip here is the same work an export does.
 *
 *   node scripts/verify-secrets.mts
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { DEFAULT_SETTINGS, hydrateSettings } from '../src/main/settingsSchema.ts'
import { safeStorageBackend, SecretStore, vaultItemPaths, type SecretBackend } from '../src/main/secrets.ts'
import {
  keepUnseenSecrets,
  KEYCHAIN_NOTICE_AFTER_MS,
  KEYS_NOTICE_AFTER_MS,
  remoteKeyVerdict,
  SecretsGate,
  secretsNotice
} from '../src/shared/secretsOpen.ts'
import { openSetup, sealSetup } from '../src/main/setupFile.ts'
import {
  applySecrets,
  collectSecrets,
  judgeProtection,
  parseSecretsFile,
  scrubSecrets,
  secretLabel,
  secretPathsIn,
  SECRET_PATHS
} from '../src/shared/secrets.ts'
import {
  buildSetupPayload,
  judgePassphrase,
  LOCAL_KEYS,
  mergeSetup,
  parseSetupEnvelope,
  PARTIAL_KEYS,
  PORTABLE_KEYS,
  planImport,
  previewSetup,
  SETUP_KDF_DEFAULTS,
  type SetupPayload
} from '../src/shared/setupFile.ts'
import type { Settings } from '../src/shared/types.ts'

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failures++
  console.log(
    `  ${ok ? 'PASS' : 'FAIL'}  ${name}` + (ok ? '' : `\n        got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
  )
}
function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail}`}`)
}

/* Canaries: unique strings that must never appear in plaintext on disk. */
const CANARY = {
  anthropic: 'sk-ant-CANARY-a1b2c3d4e5',
  openrouter: 'sk-or-CANARY-f6g7h8i9j0',
  custom: 'gw-CANARY-k1l2m3n4o5',
  codex: 'codex-CANARY-p6q7r8s9t0',
  phone: 'phone-CANARY-u1v2w3x4y5',
  account: 'xai-CANARY-z6y5x4w3v2',
  voice: 'stt-CANARY-z9y8x7w6v5'
}
const ALL_CANARIES = Object.values(CANARY)
const hasCanary = (text: string): string[] => ALL_CANARIES.filter((c) => text.includes(c))

function plaintextSettings(): Record<string, unknown> {
  return {
    themeId: 'lagoon',
    fontSize: 15,
    projectRoots: ['/Users/someone/code'],
    claudePath: '/opt/claude',
    providers: {
      claudeAuth: 'openrouter',
      anthropicApiKey: CANARY.anthropic,
      openrouterApiKey: CANARY.openrouter,
      customBaseUrl: 'http://127.0.0.1:8080',
      customAuthToken: CANARY.custom,
      openrouterModelDiscovery: false
    },
    agents: {
      chosen: ['claude', 'codex'],
      endpoints: { codex: { mode: 'custom', model: 'gpt-x', baseUrl: 'https://gw.example/v1', apiKey: CANARY.codex } },
      defaultCli: 'claude'
    },
    remote: { enabled: true, port: 7878, token: CANARY.phone },
    voice: { sttUrl: 'http://127.0.0.1:17890', provider: 'openai', model: '', baseUrl: '', keys: { openai: CANARY.voice } },
    hosts: [{ id: 'h1', label: 'Box', alias: 'box', command: '', keyEnrolled: true }],
    // A key account (shared/accounts.ts): its key is sealed like the rest,
    // and never travels — accounts are machine-local.
    accounts: { 'grok-team': { cli: 'grok', label: 'Team', kind: 'key', home: '', apiKey: CANARY.account } }
  }
}

/* A Stoke-held MCP server of each kind (shared/mcpServers.ts), holding canaries of its own. */
const MCP_CANARY = {
  env: 'mcp-env-CANARY-z1y2x3',
  header: 'mcp-header-CANARY-w4v5u6',
  bearer: 'mcp-bearer-CANARY-t7s8r9'
}
function withMcpServers(s: Record<string, unknown>): Record<string, unknown> {
  const agents = (s.agents ?? {}) as Record<string, unknown>
  return {
    ...s,
    agents: {
      ...agents,
      mcp: {
        perAgent: { codex: ['stoke', 'github', 'docs'] },
        extra: {
          github: {
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-github'],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: MCP_CANARY.env }
          },
          docs: { transport: 'http', url: 'https://mcp.example.com/mcp', headers: { 'X-Api-Key': MCP_CANARY.header }, bearer: MCP_CANARY.bearer }
        }
      }
    }
  }
}

/**
 * A fake key store. Reversible, prefix-tagged so a wrong "key" is visible, and
 * counting calls so the suite can prove when the store was NOT asked.
 */
function fakeBackend(opts: { key?: number; available?: boolean; linux?: string | null; failEncrypt?: boolean } = {}) {
  const key = opts.key ?? 0x5a
  const calls = { available: 0, encrypt: 0, decrypt: 0 }
  const backend: SecretBackend = {
    isEncryptionAvailable: () => {
      calls.available++
      return opts.available ?? true
    },
    selectedBackend: () => opts.linux ?? null,
    encrypt: (plain) => {
      calls.encrypt++
      if (opts.failEncrypt) throw new Error('Encryption is not available.')
      return Buffer.concat([Buffer.from('fk1'), Buffer.from(Buffer.from(plain, 'utf8').map((b) => b ^ key))])
    },
    decrypt: (sealed) => {
      calls.decrypt++
      if (sealed.subarray(0, 3).toString('latin1') !== 'fk1') throw new Error('bad prefix')
      return Buffer.from(sealed.subarray(3).map((b) => b ^ key)).toString('utf8')
    }
  }
  return { backend, calls }
}

const scratch: string[] = []
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'stoke-verify-secrets-'))
  scratch.push(d)
  return d
}
const read = (f: string): string => readFileSync(f, 'utf8')

/* ============================================================== registry */
console.log('\nthe secret-path registry')
{
  const s = plaintextSettings()
  const paths = secretPathsIn(s).sort()
  check('every registered secret is found in a populated settings object', paths, [
    'accounts.grok-team.apiKey',
    'agents.endpoints.codex.apiKey',
    'providers.anthropicApiKey',
    'providers.customAuthToken',
    'providers.openrouterApiKey',
    'remote.token',
    'voice.keys.openai'
  ])
  // A pattern that names a path Settings does not have encrypts nothing, silently.
  // The fixture plus one Stoke-held MCP server of each kind, so the MCP
  // patterns are held to a real path too (the block below covers them).
  const hydrated = hydrateSettings(withMcpServers(s))
  for (const spec of SECRET_PATHS) {
    ok(
      `pattern ${spec.pattern} names a real Settings path`,
      secretPathsIn(hydrated, [spec]).length > 0,
      'no path in a hydrated populated Settings matches it'
    )
  }
  check('collectSecrets returns exactly the six values', Object.values(collectSecrets(s)).sort(), [...ALL_CANARIES].sort())
  const scrubbed = scrubSecrets(s)
  check('scrubSecrets empties every secret', hasCanary(JSON.stringify(scrubbed)), [])
  check('and leaves the rest alone', (scrubbed as Record<string, unknown>).themeId, 'lagoon')
  ok('and does not touch its input', JSON.stringify(s).includes(CANARY.phone))
  check('applySecrets puts them back', collectSecrets(applySecrets(scrubbed, collectSecrets(s))), collectSecrets(s))
  check(
    'applySecrets writes no path the registry does not name',
    applySecrets({}, { 'claudePath': '/evil', 'providers.anthropicApiKey': 'k' }),
    { providers: { anthropicApiKey: 'k' } }
  )
  const polluted = applySecrets({}, { 'agents.endpoints.__proto__.apiKey': 'pwned', 'agents.endpoints.constructor.apiKey': 'x' })
  ok('a __proto__ segment is refused (no prototype pollution)', ({} as Record<string, unknown>).apiKey === undefined)
  check('and writes nothing', polluted, {})
  check('secretLabel names the agent for a wildcard path', secretLabel('agents.endpoints.codex.apiKey'), 'Codex endpoint key')
  check('and a speech provider by its own spelling, not a capitalised id', secretLabel('voice.keys.openai'), 'OpenAI speech-to-text key')
  check('a provider the table does not name falls back to capitalising', secretLabel('voice.keys.newco'), 'Newco speech-to-text key')

  // Stoke-held MCP servers: every value that can carry a credential is sealed.
  const m = hydrateSettings(withMcpServers(plaintextSettings()))
  check(
    'an MCP server’s env values, headers and bearer are secrets; its command, args and URL are not',
    secretPathsIn(m).filter((p) => p.startsWith('agents.mcp.')).sort(),
    ['agents.mcp.extra.docs.bearer', 'agents.mcp.extra.docs.headers.X-Api-Key', 'agents.mcp.extra.github.env.GITHUB_PERSONAL_ACCESS_TOKEN']
  )
  const mScrubbed = scrubSecrets(m)
  const mText = JSON.stringify(mScrubbed)
  check('scrubSecrets empties every MCP secret', Object.values(MCP_CANARY).filter((c) => mText.includes(c)), [])
  ok('and keeps the server whole, so the vault can fill it again', mText.includes('@modelcontextprotocol/server-github') && mText.includes('https://mcp.example.com/mcp'))
  const back = hydrateSettings(applySecrets(mScrubbed, collectSecrets(m))) as unknown as Record<string, { mcp: { extra: Record<string, { env: Record<string, string>; bearer?: string }> } }>
  check('applySecrets and a hydrate put them back', [back.agents.mcp.extra.github.env.GITHUB_PERSONAL_ACCESS_TOKEN, back.agents.mcp.extra.docs.bearer], [MCP_CANARY.env, MCP_CANARY.bearer])
  check('an emptied secret survives hydrate, so the shape is there to fill', (hydrateSettings(mScrubbed) as unknown as typeof back).agents.mcp.extra.github.env, { GITHUB_PERSONAL_ACCESS_TOKEN: '' })
  check('secretLabel names the server', secretLabel('agents.mcp.extra.github.env.GITHUB_PERSONAL_ACCESS_TOKEN'), 'Github MCP server variable')
  check('a whitespace-only value is not a secret', collectSecrets({ providers: { anthropicApiKey: '   ' } }), {})
}

/* ============================================================ protection */
console.log('\nwhich key stores count as protection')
check('macOS with a key store is protected', judgeProtection('darwin', true, null).protected, true)
check('Windows DPAPI is protected', judgeProtection('win32', true, null).backend, 'dpapi')
check('Linux libsecret is protected', judgeProtection('linux', true, 'gnome_libsecret').protected, true)
check('Linux kwallet6 is protected', judgeProtection('linux', true, 'kwallet6').protected, true)
check('Linux basic_text is NOT protected', judgeProtection('linux', true, 'basic_text').protected, false)
ok('and says why, naming basic_text’s fixed password', /fixed password/.test(judgeProtection('linux', true, 'basic_text').why))
check('an unknown Linux backend is not protected', judgeProtection('linux', true, 'unknown').protected, false)
check('no key store at all is not protected', judgeProtection('darwin', false, null).protected, false)

/* ============================================================== migration */
console.log('\nmigration on a synthetic userData')
{
  const dir = freshDir()
  const settingsFile = join(dir, 'settings.json')
  const secretsFile = join(dir, 'secrets.json')
  writeFileSync(settingsFile, JSON.stringify(plaintextSettings(), null, 2))
  writeFileSync(`${settingsFile}.tmp`, JSON.stringify(plaintextSettings()))
  const bystander = join(dir, 'tabs.json')
  writeFileSync(bystander, '{"bystander":true}')

  const { backend, calls } = fakeBackend()
  const store = new SecretStore(dir, backend, 'darwin')
  const loaded = hydrateSettings(store.load())
  check('the app still sees every key after migration', collectSecrets(loaded), collectSecrets(hydrateSettings(plaintextSettings())))
  const onDisk = read(settingsFile)
  check('no canary is left in settings.json', hasCanary(onDisk), [])
  check('its secret fields are empty strings, not missing', JSON.parse(onDisk).providers.anthropicApiKey, '')
  check('and every other setting is kept', [JSON.parse(onDisk).themeId, JSON.parse(onDisk).claudePath], ['lagoon', '/opt/claude'])
  ok('settings.json.tmp (a crash leftover holding keys) is gone', !existsSync(`${settingsFile}.tmp`))
  const vaultText = read(secretsFile)
  check('no canary appears in secrets.json either', hasCanary(vaultText), [])
  check('secrets.json holds one item per secret', Object.keys(parseSecretsFile(vaultText)?.items ?? {}).length, ALL_CANARIES.length)
  if (process.platform !== 'win32') {
    check('secrets.json is mode 0600', (statSync(secretsFile).mode & 0o777).toString(8), '600')
    check('settings.json is mode 0600 too', (statSync(settingsFile).mode & 0o777).toString(8), '600')
  }
  check('the bystander in userData survives untouched', read(bystander), '{"bystander":true}')
  ok('the key store was asked, since there was something to seal', calls.available > 0 && calls.encrypt === ALL_CANARIES.length)
  // The account itself stays, key emptied: settings.json read before the vault
  // opens must not drop it, or the next write would lose it (accounts.ts).
  check(
    'a key account stays in settings.json, its key an empty string',
    [JSON.parse(onDisk).accounts?.['grok-team']?.kind, JSON.parse(onDisk).accounts?.['grok-team']?.apiKey],
    ['key', '']
  )
  check(
    'and hydrating that file keeps the account',
    Object.keys(hydrateSettings(JSON.parse(onDisk)).accounts),
    ['grok-team']
  )

  // Idempotent: a second boot writes nothing and reads the same keys.
  const past = new Date(Date.now() - 60_000)
  utimesSync(settingsFile, past, past)
  utimesSync(secretsFile, past, past)
  const before = { s: read(settingsFile), v: read(secretsFile) }
  const again = new SecretStore(dir, fakeBackend().backend, 'darwin')
  const reloaded = hydrateSettings(again.load())
  check('a second boot reads the same keys', collectSecrets(reloaded), collectSecrets(loaded))
  ok(
    'and rewrites neither file',
    read(settingsFile) === before.s &&
      read(secretsFile) === before.v &&
      statSync(settingsFile).mtimeMs === past.getTime() &&
      statSync(secretsFile).mtimeMs === past.getTime()
  )

  // A write through the store: a changed key moves into the vault, never the file.
  const changedKey = 'sk-or-CANARY-rotated-zz'
  again.save({ ...reloaded, providers: { ...reloaded.providers, openrouterApiKey: changedKey } })
  ok('a changed key is not written to settings.json', !read(settingsFile).includes(changedKey))
  ok('and is not in secrets.json as plaintext', !read(secretsFile).includes(changedKey))
  const third = hydrateSettings(new SecretStore(dir, fakeBackend().backend, 'darwin').load())
  check('but comes back on the next boot', third.providers.openrouterApiKey, changedKey)
  again.save({ ...third, remote: { ...third.remote, token: '' } })
  ok('a cleared key leaves the vault', !Object.keys(parseSecretsFile(read(secretsFile))?.items ?? {}).includes('remote.token'))
  check('the bystander still survives', read(bystander), '{"bystander":true}')

  // An unchanged save does not re-seal anything.
  const counting = fakeBackend()
  const quiet = new SecretStore(dir, counting.backend, 'darwin')
  const q = hydrateSettings(quiet.load())
  const sealsBefore = counting.calls.encrypt
  quiet.save({ ...q, fontSize: 16 })
  check('saving a non-secret change seals nothing', counting.calls.encrypt - sealsBefore, 0)
}

console.log('\nplaintext wins over the vault (a key typed into an older build)')
{
  const dir = freshDir()
  const settingsFile = join(dir, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify(plaintextSettings(), null, 2))
  new SecretStore(dir, fakeBackend().backend, 'darwin').load()
  // An older build rewrites settings.json with a new plaintext key.
  const downgraded = JSON.parse(read(settingsFile))
  downgraded.providers.anthropicApiKey = 'sk-ant-CANARY-typed-in-old-build'
  writeFileSync(settingsFile, JSON.stringify(downgraded, null, 2))
  const up = hydrateSettings(new SecretStore(dir, fakeBackend().backend, 'darwin').load())
  check('the newer plaintext key is the one used', up.providers.anthropicApiKey, 'sk-ant-CANARY-typed-in-old-build')
  check('the vault-only keys are still there', up.providers.openrouterApiKey, CANARY.openrouter)
  ok('and it is scrubbed from settings.json again', !read(settingsFile).includes('typed-in-old-build'))
}

console.log('\na crash leftover is scrubbed even when settings.json is already clean')
{
  const dir = freshDir()
  const settingsFile = join(dir, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify(plaintextSettings(), null, 2))
  new SecretStore(dir, fakeBackend().backend, 'darwin').load()
  // An older build crashed between writing its temp and renaming it.
  writeFileSync(`${settingsFile}.tmp`, JSON.stringify(plaintextSettings()))
  const cleanBefore = read(settingsFile)
  new SecretStore(dir, fakeBackend().backend, 'darwin').load()
  ok('settings.json.tmp holding keys is removed at boot', !existsSync(`${settingsFile}.tmp`))
  check('without rewriting the clean settings.json', read(settingsFile), cleanBefore)
}

console.log('\nbasic_text and no key store: today’s plaintext behaviour, never a lock-out')
for (const [name, opts, platform] of [
  ['Linux basic_text', { linux: 'basic_text' }, 'linux'],
  ['macOS with no key store', { available: false }, 'darwin']
] as const) {
  const dir = freshDir()
  const settingsFile = join(dir, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify(plaintextSettings(), null, 2))
  const { backend, calls } = fakeBackend(opts)
  const store = new SecretStore(dir, backend, platform)
  const loaded = hydrateSettings(store.load())
  check(`${name}: every key still reaches the app`, collectSecrets(loaded), collectSecrets(hydrateSettings(plaintextSettings())))
  ok(`${name}: settings.json keeps the keys`, hasCanary(read(settingsFile)).length === 5 || read(settingsFile).includes(CANARY.phone))
  ok(`${name}: no secrets.json is written`, !existsSync(join(dir, 'secrets.json')))
  check(`${name}: nothing was sealed`, calls.encrypt, 0)
  store.save({ ...loaded, providers: { ...loaded.providers, anthropicApiKey: 'sk-ant-new-plain' } })
  ok(`${name}: a new key is saved, in settings.json`, read(settingsFile).includes('sk-ant-new-plain'))
  const st = store.status()
  check(`${name}: status says not protected, and where the keys are`, [st.protected, st.location], [false, 'settings.json'])
}

console.log('\nitems that will not open are kept, never deleted')
{
  const dir = freshDir()
  const settingsFile = join(dir, 'settings.json')
  const secretsFile = join(dir, 'secrets.json')
  writeFileSync(settingsFile, JSON.stringify(plaintextSettings(), null, 2))
  new SecretStore(dir, fakeBackend({ key: 0x5a }).backend, 'darwin').load()
  const sealedByA = read(secretsFile)
  // Same prefix, different key: decrypts to garbage, which the path binding refuses.
  const storeB = new SecretStore(dir, fakeBackend({ key: 0x33 }).backend, 'darwin')
  const underB = hydrateSettings(storeB.load())
  check('under another key the app sees no keys', collectSecrets(underB), {})
  check('and status lists every one as stranded', storeB.status().stranded.length, ALL_CANARIES.length)
  storeB.save({ ...underB, fontSize: 17 })
  check('a save with no keys leaves every stranded item in secrets.json', parseSecretsFile(read(secretsFile))?.items, parseSecretsFile(sealedByA)?.items)
  storeB.save({ ...underB, providers: { ...underB.providers, anthropicApiKey: 'sk-ant-reentered' } })
  const items = parseSecretsFile(read(secretsFile))?.items ?? {}
  ok(
    're-entering a key replaces its stranded item and keeps the others',
    items['providers.anthropicApiKey'] !== parseSecretsFile(sealedByA)?.items['providers.anthropicApiKey'] &&
      items['remote.token'] === parseSecretsFile(sealedByA)?.items['remote.token']
  )
  check('a foreign (newer build) item is carried too', (() => {
    const f = JSON.parse(read(secretsFile))
    f.items['stt.apiKey'] = Buffer.from('opaque').toString('base64')
    writeFileSync(secretsFile, JSON.stringify(f))
    const s2 = new SecretStore(dir, fakeBackend({ key: 0x33 }).backend, 'darwin')
    s2.save(hydrateSettings(s2.load()))
    return parseSecretsFile(read(secretsFile))?.items['stt.apiKey']
  })(), Buffer.from('opaque').toString('base64'))
}

console.log('\na key store that refuses mid-run loses nothing')
{
  const dir = freshDir()
  const settingsFile = join(dir, 'settings.json')
  writeFileSync(settingsFile, JSON.stringify({ themeId: 'ember' }, null, 2))
  const store = new SecretStore(dir, fakeBackend({ failEncrypt: true }).backend, 'darwin')
  const s = hydrateSettings(store.load())
  store.save({ ...s, providers: { ...s.providers, anthropicApiKey: 'sk-ant-must-survive' } })
  ok('the key the user just typed is saved (in settings.json, as before)', read(settingsFile).includes('sk-ant-must-survive'))
  check('and status says so', store.status().protected, false)
}

console.log('\na secrets.json write that fails is retried, and the key is never lost')
{
  // The reported case: the vault's rename fails once (ENOSPC, or on Windows an
  // EPERM/EBUSY while antivirus holds the file). A non-empty directory where
  // secrets.json should be makes that rename throw on every platform, while
  // the old vault waits aside — exactly what a failed rename leaves on disk.
  const dir = freshDir()
  const settingsFile = join(dir, 'settings.json')
  const secretsFile = join(dir, 'secrets.json')
  const aside = `${secretsFile}.aside`
  writeFileSync(settingsFile, JSON.stringify(plaintextSettings(), null, 2))
  const store = new SecretStore(dir, fakeBackend().backend, 'darwin')
  const s = hydrateSettings(store.load())
  const vaultBefore = read(secretsFile)
  const rotated = 'sk-or-CANARY-typed-while-busy'
  const next = { ...s, providers: { ...s.providers, openrouterApiKey: rotated } }

  renameSync(secretsFile, aside)
  mkdirSync(secretsFile)
  writeFileSync(join(secretsFile, 'occupant'), 'x')
  let threw: unknown = null
  try {
    store.save(next)
  } catch (err) {
    threw = err
  }
  rmSync(secretsFile, { recursive: true, force: true })
  renameSync(aside, secretsFile)

  ok('the failed vault write does not throw out of save', threw === null, String(threw))
  check('the vault on disk is still the old one', read(secretsFile), vaultBefore)
  ok('the key just typed is kept in settings.json meanwhile', read(settingsFile).includes(rotated))
  check('and only that one: the keys the vault holds stay scrubbed', hasCanary(read(settingsFile)), [])
  ok('status names the failed write', typeof store.status().vaultWriteError === 'string')

  // A boot before any retry (a crash, a quit) must still see the new key.
  const crashed = freshDir()
  cpSync(dir, crashed, { recursive: true })
  check(
    'a boot in between reads the new key',
    hydrateSettings(new SecretStore(crashed, fakeBackend().backend, 'darwin').load()).providers.openrouterApiKey,
    rotated
  )

  // The next save of anything retries the vault: before the fix it compared
  // against a copy already claiming the new key, and skipped it for good.
  store.save({ ...next, fontSize: 18 })
  ok('the next save, of an unrelated setting, rewrites secrets.json', read(secretsFile) !== vaultBefore)
  ok('and takes the key back out of settings.json', !read(settingsFile).includes(rotated))
  check('and clears the status', store.status().vaultWriteError, null)
  check(
    'a fresh boot returns the new key',
    hydrateSettings(new SecretStore(dir, fakeBackend().backend, 'darwin').load()).providers.openrouterApiKey,
    rotated
  )
  check('with every other key intact', collectSecrets(hydrateSettings(new SecretStore(dir, fakeBackend().backend, 'darwin').load())), {
    ...collectSecrets(s),
    'providers.openrouterApiKey': rotated
  })
}

console.log('\na profile with no keys never asks the key store')
{
  const dir = freshDir()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ themeId: 'moss' }, null, 2))
  const { backend, calls } = fakeBackend()
  const store = new SecretStore(dir, backend, 'darwin')
  const s = hydrateSettings(store.load())
  store.save({ ...s, fontSize: 14 })
  check('no call to isEncryptionAvailable, encrypt or decrypt', calls, { available: 0, encrypt: 0, decrypt: 0 })
  ok('and settings.json is written normally', JSON.parse(read(join(dir, 'settings.json'))).fontSize === 14)
}

/* ===================================== opening without holding up the window */
/*
 * The boot open (store.ts `initSecretStore` → `SecretStore.prepare`). On macOS
 * the blocking key-store calls wait on the MAIN thread for a Keychain password
 * dialog — measured 18 s and 8 s before any window existed, 2026-10-27 — so the
 * boot asks only through the async calls, and nothing reads a key until the
 * open has settled.
 */

/** `fakeBackend` plus the async pair, counted apart, optionally held until `release()`. */
function fakeAsyncBackend(
  opts: { key?: number; linux?: string | null; asyncAvailable?: boolean; failAsyncDecrypt?: boolean; held?: boolean } = {}
) {
  const key = opts.key ?? 0x5a
  const { backend, calls } = fakeBackend({ key, linux: opts.linux })
  const asyncCalls = { available: 0, decrypt: 0 }
  let release: () => void = () => {}
  const opened = opts.held ? new Promise<void>((r) => (release = r)) : Promise.resolve()
  backend.isEncryptionAvailableAsync = async () => {
    asyncCalls.available++
    await opened
    return opts.asyncAvailable ?? true
  }
  backend.decryptAsync = async (sealed) => {
    asyncCalls.decrypt++
    await opened
    if (opts.failAsyncDecrypt) throw new Error('the async key provider refused')
    if (sealed.subarray(0, 3).toString('latin1') !== 'fk1') throw new Error('bad prefix')
    return Buffer.from(sealed.subarray(3).map((b) => b ^ key)).toString('utf8')
  }
  return { backend, calls, asyncCalls, release: () => release() }
}

/** A userData whose keys are already in the vault, as after any boot since the migration. */
function sealedProfile(): string {
  const dir = freshDir()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify(plaintextSettings(), null, 2))
  new SecretStore(dir, fakeBackend().backend, 'darwin').load()
  return dir
}
const onDisk = (dir: string): Settings => hydrateSettings(JSON.parse(read(join(dir, 'settings.json'))))
const ticks = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r))
}

console.log('\nthe boot open never makes a blocking key-store call')
{
  const dir = sealedProfile()
  const { backend, calls, asyncCalls } = fakeAsyncBackend()
  const store = new SecretStore(dir, backend, 'darwin')
  const finish = await store.prepare()
  const opened = hydrateSettings(finish(onDisk(dir)))
  check('every key opens', collectSecrets(opened), collectSecrets(hydrateSettings(plaintextSettings())))
  check(
    'with no call to the blocking isEncryptionAvailable, decrypt or encrypt (each is a main-thread Keychain dialog on macOS)',
    calls,
    { available: 0, encrypt: 0, decrypt: 0 }
  )
  check('and one async decrypt per sealed item', asyncCalls, { available: 1, decrypt: ALL_CANARIES.length })
  const blocking = hydrateSettings(new SecretStore(dir, fakeBackend().backend, 'darwin').load())
  check('the same settings the blocking load makes', collectSecrets(opened), collectSecrets(blocking))
  check('and the store reports them as held', store.status().held.length, ALL_CANARIES.length)
  check('with nothing written meanwhile, the finish works from the file it read', collectSecrets(hydrateSettings(finish())), collectSecrets(opened))
}

console.log('\na profile with no keys settles without asking the key store at all')
{
  const dir = freshDir()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ themeId: 'moss' }, null, 2))
  const { backend, calls, asyncCalls } = fakeAsyncBackend()
  const finish = await new SecretStore(dir, backend, 'darwin').prepare()
  check('the settings come back as they stand', (finish({ themeId: 'moss', fontSize: 17 }) as { fontSize: number }).fontSize, 17)
  check('no key-store call of either kind', [calls, asyncCalls], [{ available: 0, encrypt: 0, decrypt: 0 }, { available: 0, decrypt: 0 }])
}

console.log('\nwhile the open waits, nothing reads a key and the phone key is never minted')
{
  let now = 1_000
  const gate = new SecretsGate(() => now)
  check('before the open nothing is readable', [gate.current, gate.readable()], ['closed', false])
  check('a token is never minted before the open, even with none and no push pair', remoteKeyVerdict(gate.readable(), '', false, []), 'wait')
  ok('the first caller claims the open', gate.claim())
  ok('a second caller does not start another', !gate.claim())
  check('while it opens, nothing is readable', [gate.current, gate.readable()], ['opening', false])
  check('a token is never minted while the store is opening', remoteKeyVerdict(gate.readable(), '', true, []), 'wait')
  check('nor a push pair', remoteKeyVerdict(gate.readable(), CANARY.phone, false, []), 'wait')

  const dir = sealedProfile()
  const held = fakeAsyncBackend({ held: true })
  const store = new SecretStore(dir, held.backend, 'darwin')
  const order: string[] = []
  void gate.settled().then(() => order.push('reader'))
  let finish: ((current: unknown) => unknown) | null = null
  void store.prepare().then((f) => {
    finish = f
    order.push('prepared')
  })
  now = 1_000 + 18_000
  await ticks()
  check('a reader waiting on the open has not run while the key store has not answered', order, [])
  check('the open says how long it has waited', gate.state('darwin'), { phase: 'opening', platform: 'darwin', waitedMs: 18_000 })
  held.release()
  await ticks()
  check('the key store answered, and the reader still waits for the open to finish', order, ['prepared'])
  ok('the finish step is handed back', finish !== null)
  const opened = hydrateSettings((finish as unknown as (c: unknown) => unknown)(onDisk(dir)))
  ok('a settle from the wrong phase changes nothing', !new SecretsGate().settle('open'))
  ok('the open settles once', gate.settle('open') && !gate.settle('off'))
  await ticks()
  check('and only then does the reader run', order, ['prepared', 'reader'])
  check('readable once open', [gate.current, gate.readable(), gate.waitedMs()], ['open', true, 0])
  check('the key the phones hold is kept, not replaced', remoteKeyVerdict(gate.readable(), opened.remote.token, true, store.stranded()), 'keep')
  check('and is the vault’s', opened.remote.token, CANARY.phone)
  check('a key genuinely missing after the open is minted', remoteKeyVerdict(gate.readable(), '', true, store.stranded()), 'mint')
  let late = false
  await gate.settled().then(() => (late = true))
  ok('a reader arriving after the open runs at once', late)
  const failed = new SecretsGate()
  failed.claim()
  failed.settle('off')
  ok('a failed open is settled too: readers run, keys stay in settings.json', failed.readable())
}

console.log('\nsettings written while the store was opening are kept, and an empty key there is not a deletion')
{
  const dir = sealedProfile()
  const { backend } = fakeAsyncBackend()
  const store = new SecretStore(dir, backend, 'darwin')
  const finish = await store.prepare()
  // What the cache holds by the finish: settings.json (every sealed key '')
  // plus writes made meanwhile — a setting, and a key typed while it waited.
  const typed = 'sk-or-CANARY-typed-while-opening'
  const now = onDisk(dir)
  const current = { ...now, fontSize: 21, providers: { ...now.providers, openrouterApiKey: typed } }
  const opened = hydrateSettings(finish(current))
  check('a setting written meanwhile is kept', opened.fontSize, 21)
  check('a key typed meanwhile wins over the vault (the newer write)', opened.providers.openrouterApiKey, typed)
  check('a key left empty meanwhile is the vault’s, not deleted', [opened.remote.token, opened.providers.anthropicApiKey], [CANARY.phone, CANARY.anthropic])
  const file = read(join(dir, 'settings.json'))
  check('settings.json holds no key afterwards', [hasCanary(file), file.includes(typed)], [[], false])
  const next = hydrateSettings(new SecretStore(dir, fakeBackend().backend, 'darwin').load())
  check('the typed key was sealed into the vault and opens on the next boot', next.providers.openrouterApiKey, typed)
}

console.log('\noff macOS a refused async open falls back to the blocking one; on macOS it never does')
{
  const dir = sealedProfile()
  const mac = fakeAsyncBackend({ failAsyncDecrypt: true })
  const macStore = new SecretStore(dir, mac.backend, 'darwin')
  const macOpened = hydrateSettings((await macStore.prepare())(onDisk(dir)))
  check('macOS: no blocking decrypt after the async one refused', mac.calls.decrypt, 0)
  check('so the items are kept, stranded, and none is lost', [macOpened.remote.token, macStore.status().stranded.length], ['', ALL_CANARIES.length])
  const macOff = fakeAsyncBackend({ asyncAvailable: false })
  const macOffStore = new SecretStore(dir, macOff.backend, 'darwin')
  await macOffStore.prepare()
  check('macOS: no blocking availability check after the async one said no', macOff.calls.available, 0)
  check('and the run is unprotected rather than prompting again', macOffStore.status().protected, false)

  const linux = fakeAsyncBackend({ failAsyncDecrypt: true, linux: 'gnome_libsecret' })
  const linuxOpened = hydrateSettings((await new SecretStore(dir, linux.backend, 'linux').prepare())(onDisk(dir)))
  check('Linux: the blocking decrypt opens what the async provider refused', collectSecrets(linuxOpened), collectSecrets(hydrateSettings(plaintextSettings())))
  const win = fakeAsyncBackend({ asyncAvailable: false })
  const winOpened = hydrateSettings((await new SecretStore(dir, win.backend, 'win32').prepare())(onDisk(dir)))
  check('Windows: an async "unavailable" is asked again the blocking way, and the keys open', winOpened.remote.token, CANARY.phone)
  check('through the blocking calls only', [win.calls.available, win.calls.decrypt, win.asyncCalls.decrypt], [1, ALL_CANARIES.length, 0])
}

console.log('\nmacOS: after an async open, the blocking key store is asked once, so later blocking calls do not prompt')
{
  /*
   * Electron 43 keeps two key fetches with separate caches: the async open's,
   * and OSCrypt's blocking one, which `save`, the migration, the hub, account
   * sync and the plugins still use. The old blocking boot warmed the second.
   * `warmBlockingKeyStore` does it on purpose, before the open settles, so an
   * "Allow" (not "Always Allow") asks again at once and never at a later click.
   */
  const dir = sealedProfile()
  const mac = fakeAsyncBackend()
  const store = new SecretStore(dir, mac.backend, 'darwin')
  await store.prepare()
  const ms = store.warmBlockingKeyStore()
  ok('macOS, keys opened: it is asked, and says how long it took', typeof ms === 'number' && ms >= 0)
  check('exactly one blocking availability check, and nothing sealed or opened the blocking way', mac.calls, { available: 1, encrypt: 0, decrypt: 0 })
  store.save(hydrateSettings({ ...plaintextSettings(), providers: { ...(plaintextSettings().providers as object), openrouterApiKey: 'sk-or-CANARY-saved-later' } }))
  check('a key saved later then seals the blocking way, through the warmed store', [mac.calls.available, mac.calls.encrypt], [1, 1])

  const denied = fakeAsyncBackend({ failAsyncDecrypt: true })
  const deniedStore = new SecretStore(dir, denied.backend, 'darwin')
  await deniedStore.prepare()
  check('never after a refusal: nothing opened, so it would only be the dialog again', [deniedStore.warmBlockingKeyStore(), denied.calls.available], [null, 0])
  const off = fakeAsyncBackend({ asyncAvailable: false })
  const offStore = new SecretStore(dir, off.backend, 'darwin')
  await offStore.prepare()
  check('never in an unprotected run', [offStore.warmBlockingKeyStore(), off.calls.available], [null, 0])
  const bare = freshDir()
  writeFileSync(join(bare, 'settings.json'), JSON.stringify({ themeId: 'moss' }, null, 2))
  const none = fakeAsyncBackend()
  const noneStore = new SecretStore(bare, none.backend, 'darwin')
  await noneStore.prepare()
  check('never for a profile with no keys, which never touches the Keychain', [noneStore.warmBlockingKeyStore(), none.calls.available], [null, 0])
  for (const platform of ['linux', 'win32']) {
    const other = fakeAsyncBackend({ linux: 'gnome_libsecret' })
    const otherStore = new SecretStore(dir, other.backend, platform)
    await otherStore.prepare()
    check(`never off macOS (${platform}), where nothing prompts`, [otherStore.warmBlockingKeyStore(), other.calls.available], [null, 0])
  }
  const legacy = fakeBackend()
  const legacyStore = new SecretStore(dir, legacy.backend, 'darwin')
  await legacyStore.prepare()
  const legacyAsked = legacy.calls.available
  check('never when the open was blocking already (a key store with no async calls)', [legacyStore.warmBlockingKeyStore(), legacy.calls.available], [null, legacyAsked])
}

console.log('\na phone key that is stored but could not be opened is never minted over (gotcha 53)')
{
  const dir = sealedProfile()
  const mac = fakeAsyncBackend({ failAsyncDecrypt: true })
  const denied = new SecretStore(dir, mac.backend, 'darwin')
  const opened = hydrateSettings((await denied.prepare())(onDisk(dir)))
  const asked = { ...mac.calls }
  const unread = denied.stranded()
  ok('stranded() names the shut phone key', unread.includes('remote.token'))
  check('and asks the key store nothing (status() would, to decide)', mac.calls, asked)
  check('after a Deny the phone key reads empty and is NOT minted over', remoteKeyVerdict(true, opened.remote.token, false, unread), 'stranded')
  check('nor is a shut push pair, beside a readable key', remoteKeyVerdict(true, CANARY.phone, false, ['remote.push.vapidPrivate']), 'stranded')
  check('a push pair that is merely missing beside a readable key is minted', remoteKeyVerdict(true, CANARY.phone, false, ['remote.token']), 'mint')
  check('nothing shut and nothing held: a first start mints', remoteKeyVerdict(true, '', false, []), 'mint')
  check('a key that reads is kept whatever else is shut', remoteKeyVerdict(true, CANARY.phone, true, ['remote.token', 'remote.push.vapidPrivate']), 'keep')
  check('while opening it is still wait, never stranded', remoteKeyVerdict(false, '', false, ['remote.token']), 'wait')

  const macOff = fakeAsyncBackend({ asyncAvailable: false })
  const unprotected = new SecretStore(dir, macOff.backend, 'darwin')
  const plain = hydrateSettings((await unprotected.prepare())(onDisk(dir)))
  check('an unprotected run carries the vault unread, and the key is not minted over', remoteKeyVerdict(true, plain.remote.token, false, unprotected.stranded()), 'stranded')

  // New key (index.ts `remoteNewToken`) is the one way to replace it: a key typed replaces its stranded copy.
  denied.save({ ...opened, remote: { ...opened.remote, token: 'phone-CANARY-new-key' } })
  ok('a New key saved replaces the shut copy, so a start goes ahead', !denied.stranded().includes('remote.token'))

  check('a failed open reads the vault’s paths without the key store (vaultItemPaths)', vaultItemPaths(dir).sort(), Object.keys(collectSecrets(hydrateSettings(plaintextSettings()))).sort())
  const missing = freshDir()
  check('no secrets.json: nothing stored', vaultItemPaths(missing), [])
  writeFileSync(join(missing, 'secrets.json'), '{ not json')
  check('an unreadable secrets.json: nothing it can name', vaultItemPaths(missing), [])
}

console.log('\nsafeStorageBackend adapts Electron’s async calls, and only those it has')
{
  // A class, so a call that loses `this` (as `ss.decryptStringAsync` unbound does) fails here.
  class FakeSafeStorage {
    private readonly k: number
    constructor() {
      this.k = 0x21
    }
    isEncryptionAvailable(): boolean {
      return true
    }
    encryptString(plain: string): Buffer {
      return Buffer.from(Buffer.from(plain).map((b) => b ^ this.k))
    }
    decryptString(sealed: Buffer): string {
      return Buffer.from(sealed.map((b) => b ^ this.k)).toString()
    }
    async isAsyncEncryptionAvailable(): Promise<boolean> {
      return this.k === 0x21
    }
    async decryptStringAsync(sealed: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }> {
      return { result: Buffer.from(sealed.map((b) => b ^ this.k)).toString(), shouldReEncrypt: false }
    }
  }
  const ss = new FakeSafeStorage()
  const b = safeStorageBackend(ss, 'darwin')
  const settle = async <T,>(p: Promise<T> | undefined): Promise<T | string | undefined> => {
    try {
      return await p
    } catch (err) {
      return `threw: ${err instanceof Error ? err.message : String(err)}`
    }
  }
  check('the async availability check is passed through, on the key store itself', await settle(b.isEncryptionAvailableAsync?.()), true)
  check('the async decrypt returns its result', await settle(b.decryptAsync?.(ss.encryptString('hello'))), 'hello')
  const legacy = safeStorageBackend(
    { isEncryptionAvailable: () => true, encryptString: (p) => Buffer.from(p), decryptString: (s) => s.toString() },
    'darwin'
  )
  ok('a key store without them is opened the blocking way, as before', !legacy.isEncryptionAvailableAsync && !legacy.decryptAsync)
}

console.log('\na renderer patch built before the open does not delete the keys it never saw')
{
  const held = hydrateSettings(plaintextSettings())
  const unseen = hydrateSettings(scrubSecrets(plaintextSettings()))
  const patch = { voice: { ...unseen.voice, provider: 'groq' as const }, providers: { ...unseen.providers, customAuthToken: 'gw-typed' } }
  const kept = keepUnseenSecrets(patch, held)
  check('an empty key in the patch is put back', kept.voice.keys.openai, CANARY.voice)
  check('the change it carried stands', kept.voice.provider, 'groq')
  check('a key typed into it is kept', kept.providers.customAuthToken, 'gw-typed')
  check('the other empty keys beside it are put back too', kept.providers.openrouterApiKey, CANARY.openrouter)
  const plain = { fontSize: 12 }
  ok('a patch with no keys in it is passed through untouched', keepUnseenSecrets(plain, held) === plain)
  const accounts = keepUnseenSecrets({ accounts: {} }, held)
  check('an account the patch dropped is not brought back by its key', accounts.accounts, {})
  const remoteOnly = keepUnseenSecrets({ remote: { ...unseen.remote, enabled: false } }, held) as Partial<Settings>
  check('a Phone access toggle from before the open keeps the phone key', remoteOnly.remote?.token, CANARY.phone)
  check('and adds nothing it did not carry', Object.keys(remoteOnly), ['remote'])
  // An object below the top that the patch left out is replaced whole too
  // (`setSettings` merges only the top level), so its keys are put back there.
  const noKeys = keepUnseenSecrets({ voice: { provider: 'groq' } }, held) as Partial<Settings>
  check('a patch carrying voice without its keys object gets the key put back under it', noKeys.voice?.keys?.openai, CANARY.voice)
  const noFields = keepUnseenSecrets({ providers: { claudeAuth: 'anthropic' } }, held) as Partial<Settings>
  check(
    'a patch carrying providers without the key fields gets every one put back',
    [noFields.providers?.anthropicApiKey, noFields.providers?.openrouterApiKey, noFields.providers?.customAuthToken, noFields.providers?.claudeAuth],
    [CANARY.anthropic, CANARY.openrouter, CANARY.custom, 'anthropic']
  )
}

console.log('\nwhat the window says while it waits')
{
  const mac = secretsNotice({ phase: 'opening', platform: 'darwin', waitedMs: 0 })
  check('macOS: it names the Keychain', mac?.title, 'Waiting for macOS Keychain')
  ok('and says the dialog can be behind other windows, and what to press', !!mac?.description?.includes('behind other windows') && !!mac?.description?.includes('Always Allow'))
  check('not at once: a Keychain that answers in tens of ms never flashes it', mac?.afterMs, KEYCHAIN_NOTICE_AFTER_MS)
  check('net of what main already waited', secretsNotice({ phase: 'opening', platform: 'darwin', waitedMs: 5_000 })?.afterMs, 0)
  const win = secretsNotice({ phase: 'opening', platform: 'win32', waitedMs: 300 })
  check('elsewhere: a generic line, and only after a second', [win?.title, win?.afterMs, win?.description], ['Opening your saved keys…', KEYS_NOTICE_AFTER_MS - 300, undefined])
  check(
    'nothing once open, failed, or before the open',
    (['open', 'off', 'closed'] as const).map((phase) => secretsNotice({ phase, platform: 'darwin', waitedMs: 9_000 })),
    [null, null, null]
  )
}

console.log('\nstore.ts itself, under a stand-in electron: the open loses no key and announces only a finished open')
{
  /*
   * Gotcha 31: the order inside `initSecretStore` — flush, finish, install,
   * then settle — is out of reach of the pure checks above, and two of its
   * lines could be deleted with all of them green: the flush just before the
   * finish (without it a write coalesced during the open lands AFTER the
   * install, through the vault, with every key empty, and empties secrets.json)
   * and the settle after the install (before it, the 'open' push carries no
   * key). So store.ts is bundled with `electron` swapped for a stand-in whose
   * key store seals like `fakeBackend`, over a synthetic userData (gotcha 74),
   * and each case imports a copy of its own: fresh module state.
   */
  const STAND_IN = [
    'const st = () => globalThis.__stokeStoreStandIn',
    'const KEY = 0x5a',
    "const seal = (p) => Buffer.concat([Buffer.from('fk1'), Buffer.from(Buffer.from(p, 'utf8').map((b) => b ^ KEY))])",
    "const open = (b) => { if (b.subarray(0, 3).toString('latin1') !== 'fk1') throw new Error('bad prefix'); return Buffer.from(b.subarray(3).map((x) => x ^ KEY)).toString('utf8') }",
    "export const app = { getPath(name) { const s = st(); if (s.failGetPath > 0) { s.failGetPath--; throw new Error('userData is unavailable') } return s.userData } }",
    'export const safeStorage = {',
    "  isEncryptionAvailable() { const s = st(); s.calls.available++; s.onBlocking('available'); return s.available },",
    "  encryptString(p) { const s = st(); s.calls.encrypt++; s.onBlocking('encrypt'); return seal(p) },",
    "  decryptString(b) { const s = st(); s.calls.decrypt++; s.onBlocking('decrypt'); return open(b) },",
    "  getSelectedStorageBackend() { return 'gnome_libsecret' },",
    '  async isAsyncEncryptionAvailable() { const s = st(); s.calls.asyncAvailable++; await s.held; return s.available },',
    '  async decryptStringAsync(b) { const s = st(); s.calls.asyncDecrypt++; await s.held; return { result: open(b), shouldReEncrypt: false } }',
    '}',
    'export default { app, safeStorage }'
  ].join('\n')
  const work = freshDir()
  const bundle = join(work, 'store.mjs')
  await build({
    entryPoints: [join(import.meta.dirname, '../src/main/store.ts')],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins: [
      {
        name: 'electron-stand-in',
        setup(b) {
          b.onResolve({ filter: /^electron$/ }, () => ({ path: 'electron', namespace: 'stand-in' }))
          b.onLoad({ filter: /.*/, namespace: 'stand-in' }, () => ({ loader: 'js', contents: STAND_IN }))
        }
      }
    ]
  })
  interface StandIn {
    userData: string
    available: boolean
    failGetPath: number
    held: Promise<void>
    calls: Record<string, number>
    onBlocking: (kind: string) => void
  }
  let copies = 0
  const loadStore = async (userData: string, opts: { available?: boolean; failGetPath?: number } = {}) => {
    let release: () => void = () => {}
    const standIn: StandIn = {
      userData,
      available: opts.available ?? true,
      failGetPath: opts.failGetPath ?? 0,
      held: new Promise<void>((r) => (release = r)),
      calls: { available: 0, encrypt: 0, decrypt: 0, asyncAvailable: 0, asyncDecrypt: 0 },
      onBlocking: () => {}
    }
    ;(globalThis as Record<string, unknown>).__stokeStoreStandIn = standIn
    const mod = (await import(`${pathToFileURL(bundle).href}?copy=${++copies}`)) as typeof import('../src/main/store.ts')
    return { mod, standIn, release: () => release() }
  }
  const vaultPaths = (dir: string): string[] => Object.keys(parseSecretsFile(read(join(dir, 'secrets.json')))?.items ?? {}).sort()
  const wantKeys = collectSecrets(hydrateSettings(plaintextSettings()))
  const allPaths = Object.keys(wantKeys).sort()

  {
    const dir = sealedProfile()
    const { mod, release } = await loadStore(dir)
    const opening = mod.initSecretStore()
    check('while the key store has not answered nothing is readable', [mod.secretsOpenState().phase, mod.secretsReadable()], ['opening', false])
    mod.setSettings({ fontSize: 16 }) // written at once, the old way: no vault yet
    mod.setSettings({ fontSize: 17 }) // coalesced, still pending when the key store answers
    release()
    await opening
    await new Promise((r) => setTimeout(r, 400)) // past COALESCE_MS: anything still queued has landed
    check('a write coalesced during the open never reaches the vault with empty keys: every item is still in it', vaultPaths(dir), allPaths)
    check('and every key is in memory', collectSecrets(mod.getSettings()), wantKeys)
    const file = read(join(dir, 'settings.json'))
    check('settings.json holds the write and no key', [hydrateSettings(JSON.parse(file)).fontSize, hasCanary(file)], [17, []])
    check('the next boot opens every key', collectSecrets(hydrateSettings(new SecretStore(dir, fakeBackend().backend, 'darwin').load())), wantKeys)
  }

  {
    const dir = sealedProfile()
    const { mod, standIn, release } = await loadStore(dir)
    const blocking: string[] = []
    standIn.onBlocking = (kind) => blocking.push(`${kind} while ${mod.secretsOpenState().phase}`)
    let pushed: unknown = null
    let toListeners: unknown = null
    mod.onSettingsChanged((next) => (toListeners = collectSecrets(next)))
    mod.onSecretsOpenState((state) => {
      if (state.phase === 'open') pushed = collectSecrets(mod.getSettings())
    })
    const opening = mod.initSecretStore()
    release()
    await opening
    check('the open is announced only once every key is installed (index.ts pushes getSettings() on it)', pushed, wantKeys)
    check('main’s own listeners are handed the keys', toListeners, wantKeys)
    check('every item opened through the async calls', [standIn.calls.asyncAvailable, standIn.calls.asyncDecrypt], [1, ALL_CANARIES.length])
    const mac = process.platform === 'darwin'
    check(
      mac
        ? 'macOS: one blocking availability check, made while the window still says it is waiting for the Keychain'
        : `off macOS (${process.platform}): no blocking key-store call at all`,
      blocking,
      mac ? ['available while opening'] : []
    )
  }

  {
    const dir = sealedProfile()
    const { mod, release } = await loadStore(dir, { available: false })
    const opening = mod.initSecretStore()
    check('nothing is reported unread while the store is opening', mod.secretsStoredUnread(), [])
    release()
    await opening
    const s = mod.getSettings()
    check('a key store that says no: the open settles unprotected, the phone key unread', [mod.secretsOpenState().phase, s.remote.token], ['open', ''])
    ok('secretsStoredUnread names it', mod.secretsStoredUnread().includes('remote.token'))
    check('so a start refuses rather than mint over it', remoteKeyVerdict(mod.secretsReadable(), s.remote.token, false, mod.secretsStoredUnread()), 'stranded')
  }

  {
    const dir = sealedProfile()
    const { mod, release } = await loadStore(dir, { failGetPath: 1 })
    const logged: unknown[] = []
    const error = console.error
    console.error = (...args: unknown[]) => void logged.push(args[0])
    try {
      const opening = mod.initSecretStore()
      release()
      await opening
    } finally {
      console.error = error
    }
    const s = mod.getSettings()
    check('an open that throws settles off, says so, and the phone key reads empty', [mod.secretsOpenState().phase, logged.length, s.remote.token], ['off', 1, ''])
    check('secretsStoredUnread names everything the vault holds', mod.secretsStoredUnread().sort(), allPaths)
    check('so a start refuses rather than mint over it', remoteKeyVerdict(mod.secretsReadable(), s.remote.token, false, mod.secretsStoredUnread()), 'stranded')
  }
}

console.log('\nthe wiring: the window opens first, and every reader of a key waits (index.ts, store.ts)')
{
  // Gotcha 31: a suite cannot see the wire from boot to the pure rules above,
  // so the seam is pinned by its text. Each pin names the line it protects.
  const main = read(join(import.meta.dirname, '../src/main/index.ts'))
  const storeSrc = read(join(import.meta.dirname, '../src/main/store.ts'))
  const ready = main.slice(main.indexOf('app.whenReady().then(() => {'))
  const boot = ready.slice(0, ready.indexOf('createWindow()') + 1)
  ok('the open is started, not waited for, before the window is made', /\n\s*void initSecretStore\(\)/.test(boot) && !/await initSecretStore/.test(main))
  ok('store.ts opens through prepare(), never the blocking load()', /store\.prepare\(\)/.test(storeSrc) && !/store\.load\(\)/.test(storeSrc))
  ok(
    'store.ts finishes on the cache once anything wrote meanwhile, and counts every write',
    /finish\(settingsWrites === writesAtStart \? undefined : getSettings\(\)\)/.test(storeSrc) &&
      /export function setSettings\([^)]*\)[^{]*\{\s*settingsWrites\+\+/.test(storeSrc)
  )
  ok('settings:get waits for the open', /handle\(CH\.settingsGet, async \(\) => \{\s*await secretsSettled\(\)/.test(main))
  ok(
    'settings:set waits too, and keeps the keys a patch from before the open never saw',
    /handle\(CH\.settingsSet, async \([^)]*\) => \{\s*const unseen = !secretsReadable\(\)\s*await secretsSettled\(\)\s*return commitSettings\(unseen \? keepUnseenSecrets\(/.test(main)
  )
  const mint = main.slice(main.indexOf('function ensureRemoteToken'), main.indexOf('function ensureRemoteToken') + 1600)
  ok('ensureRemoteToken asks remoteKeyVerdict before it mints', /remoteKeyVerdict\(secretsReadable\(\)/.test(mint) && mint.indexOf('remoteKeyVerdict') < mint.indexOf('generateToken'))
  const bringUp = main.slice(main.indexOf('Bring remote access back up'), main.indexOf('Bring remote access back up') + 900)
  ok('the window brings Phone access back up only after the open', bringUp.indexOf('secretsSettled().then(') >= 0 && bringUp.indexOf('secretsSettled().then(') < bringUp.indexOf('ensureRemoteToken()'))
  for (const ch of ['remoteOpenOnPhone', 'remoteStart']) {
    const at = main.indexOf(`handle(CH.${ch}, async () => {`)
    const body = main.slice(at, at + 400)
    ok(`${ch} waits for the open before it can mint`, at >= 0 && body.indexOf('await secretsSettled()') >= 0 && body.indexOf('await secretsSettled()') < body.indexOf('ensureRemoteToken()'))
  }
  const launch = main.slice(main.indexOf('async function launchSession('), main.indexOf('async function startSession('))
  ok('a launch waits for the open before it reads a key', launch.indexOf('await secretsSettled()') >= 0 && launch.indexOf('await secretsSettled()') < launch.indexOf('getSettings()'))
  const hub = main.slice(main.indexOf('hubStarting ??= (async () => {'), main.indexOf('hubStarting ??= (async () => {') + 400)
  ok('the hub starts only after the open', hub.indexOf('await secretsSettled()') >= 0 && hub.indexOf('await secretsSettled()') < hub.indexOf("import('./hub/service.ts')"))

  // The order inside initSecretStore; the store.ts cases above prove it, and these name it on every platform.
  const open = storeSrc.slice(storeSrc.indexOf('export function initSecretStore'))
  const prepared = open.indexOf('await store.prepare()')
  const warmed = open.indexOf('store.warmBlockingKeyStore()')
  const flushed = open.indexOf('flushSettings()', prepared)
  const finished = open.indexOf('finish(', prepared)
  const installed = open.indexOf('cache = opened')
  const settledOpen = open.indexOf("gate.settle('open')")
  ok('a coalesced write is flushed the old way between the key store answering and the finish', prepared > 0 && flushed > prepared && flushed < finished)
  ok('the blocking key store is warmed after the async open and before the open is announced', warmed > prepared && warmed < finished && warmed < settledOpen)
  ok('the open is announced only after the keys are installed', finished > 0 && installed > finished && settledOpen > installed)
  ok(
    'a failed open records what the vault holds before it settles off',
    /unreadWhenOff = vaultItemPaths\(app\.getPath\('userData'\)\)/.test(open) && open.indexOf('unreadWhenOff = vaultItemPaths(') < open.indexOf("gate.settle('off')")
  )

  // A stored key this run could not open is never minted over (gotcha 53).
  ok(
    'ensureRemoteToken hands remoteKeyVerdict what is stored but unread, and refuses a stranded key',
    /remoteKeyVerdict\(secretsReadable\(\), s\.remote\.token, pushWhole, secretsStoredUnread\(\)\)/.test(mint) &&
      /verdict === 'stranded'\) \{\s*throw new Error\(/.test(mint)
  )
  const bringUpWhole = main.slice(main.indexOf('Bring remote access back up'), main.indexOf('Bring remote access back up') + 1400)
  ok('the window’s bring-up catches that refusal instead of rejecting unhandled', /try \{\s*cfg = ensureRemoteToken\(\)\s*\} catch/.test(bringUpWhole))
  const newKeyAt = main.indexOf('handle(CH.remoteNewToken, async () => {')
  const newKey = main.slice(newKeyAt, newKeyAt + 1200)
  ok(
    'New key waits for the open and replaces a push pair that is not whole with it',
    newKeyAt >= 0 &&
      newKey.indexOf('await secretsSettled()') >= 0 &&
      newKey.indexOf('await secretsSettled()') < newKey.indexOf('getSettings()') &&
      /isVapidPair\([^)]*\) \? null : generateVapidKeys\(\)/.test(newKey) &&
      /token: generateToken\(\)/.test(newKey)
  )

  // Every other reader of a sealed key a person or the boot can reach waits for the open.
  const waitsBefore = (src: string, start: string, use: string, span = 1500): boolean => {
    const at = src.indexOf(start)
    if (at < 0) return false
    const body = src.slice(at, at + span)
    const waited = body.indexOf('await secretsSettled()')
    return waited >= 0 && body.indexOf(use, waited) > waited && !body.slice(0, waited).includes(use)
  }
  const readers: Array<[string, string, string]> = [
    ['dictation (CH.transcribe)', 'handle(CH.transcribe, async', 'getSettings()'],
    ['the stoke-command chain (acceptLaunch)', 'function acceptLaunch(', "req.kind === 'account-add'"],
    ['the usage chip (usageBoard)', 'const usageBoard = async', 'getSettings()'],
    ['dictation readiness (sttStatusNow)', 'const sttStatusNow = async', 'getSettings()'],
    ['an account’s identity (CH.accountsIdentity)', 'handle(CH.accountsIdentity, async', 'planAccountIdentity('],
    ['the launcher’s setup check (CH.launchPreflight)', 'handle(CH.launchPreflight, async', '.check(input)'],
    ['a setup export (CH.setupExport)', 'handle(CH.setupExport, async', 'buildSetupPayload(getSettings()']
  ]
  for (const [name, start, use] of readers) ok(`${name} waits for the open before it reads a key`, waitsBefore(main, start, use))
  const exportAt = main.indexOf('handle(CH.setupExport, async')
  const exportBody = main.slice(exportAt, exportAt + 1500)
  ok('the export claims setupBusy before that wait (gotcha 20)', exportBody.indexOf('setupBusy = true') >= 0 && exportBody.indexOf('setupBusy = true') < exportBody.indexOf('await '))
  ok(
    'the boot’s symlinked-folder migration (a settingsChanged push) waits for the open',
    /secretsSettled\(\)\s*\.then\(\(\) => migrateSymlinkedProjectKeys\(getSettings\(\)\)\)/.test(main)
  )
  const app = read(join(import.meta.dirname, '../src/renderer/src/App.tsx'))
  ok(
    'the Keychain notice is mounted beside the Toaster, outside anything that waits for settings',
    /import \{ SecretsWaitNotice \} from '\.\/components\/SecretsWaitNotice'/.test(app) && /\n\s*<Toaster paused=\{shellInert\} \/>\n\s*<SecretsWaitNotice \/>\n/.test(app)
  )
}

/* ========================================================= the setup file */
console.log('\nwhat travels in a setup file')
{
  const all = Object.keys(DEFAULT_SETTINGS).sort()
  const sorted = [...PORTABLE_KEYS, ...Object.keys(PARTIAL_KEYS), ...LOCAL_KEYS].sort()
  check('portable, partial and local keys partition every setting exactly', sorted, all)
  const current = hydrateSettings(plaintextSettings())
  const bare = buildSetupPayload(current, { includeSecrets: false, version: '0.0.0', platform: 'darwin', now: new Date(0) })
  check('without the tick, no key is in the payload', hasCanary(JSON.stringify(bare)), [])
  ok('no machine-local path travels', !JSON.stringify(bare).includes('/Users/someone/code') && !JSON.stringify(bare).includes('/opt/claude'))
  ok('nor the remote block', !('remote' in bare.settings))
  check('a host travels without this device’s keyEnrolled', (bare.settings.hosts as Record<string, unknown>[])[0].keyEnrolled, undefined)
  const withKeys = buildSetupPayload(current, { includeSecrets: true, version: '0.0.0', platform: 'darwin', now: new Date(0) })
  check('with the tick, the five portable keys travel', Object.keys(withKeys.secrets).sort(), [
    'agents.endpoints.codex.apiKey',
    'providers.anthropicApiKey',
    'providers.customAuthToken',
    'providers.openrouterApiKey',
    'voice.keys.openai'
  ])
  ok('but never the phone access key', !JSON.stringify(withKeys).includes(CANARY.phone))
  ok('nor an account\u2019s key: accounts stay on this machine', !JSON.stringify(withKeys).includes(CANARY.account))
  // Spec 2026-10-03: only the computer being searched turns its chat sharing on, with the
  // hub password typed there. A setup file carrying the tick or its grants would do it for it.
  const sharing = hydrateSettings({ ...plaintextSettings(), hub: { shareChats: true, chatGrants: { d0000000000000000: 'always' }, shareSessions: true } })
  const sharingFile = JSON.stringify(buildSetupPayload(sharing, { includeSecrets: true, version: '0.0.0', platform: 'darwin', now: new Date(0) }))
  check('the chat-sharing tick and its grants never travel in a setup file (hub is local)', [(LOCAL_KEYS as readonly string[]).includes('hub'), sharingFile.includes('shareChats'), sharingFile.includes('chatGrants'), sharingFile.includes('d0000000000000000')], [true, false, false, false])
}

console.log('\nsealing and opening (scrypt N=2^17, AES-256-GCM)')
{
  const current = hydrateSettings(plaintextSettings())
  const payload = buildSetupPayload(current, { includeSecrets: true, version: '0.9.97', platform: 'darwin', now: new Date(0) })
  const pass = 'ember kindling orbit lantern'
  const text = await sealSetup(payload, pass)
  const env = JSON.parse(text)
  check('the header names the format and the shipped KDF', [env.format, env.v, env.kdf.alg, env.kdf.N, env.kdf.r, env.kdf.p, env.aead], [
    'stoke-setup',
    1,
    'scrypt',
    SETUP_KDF_DEFAULTS.N,
    8,
    1,
    'AES-256-GCM'
  ])
  check('no canary appears in the exported file', hasCanary(text), [])
  const opened = await openSetup(text, pass)
  check('round trip: the payload comes back exactly', opened.ok ? opened.payload : opened, payload)
  const nfd = await openSetup(await sealSetup(payload, 'caf\u00e9 lantern orbit'), 'cafe\u0301 lantern orbit')
  ok('the passphrase is NFC-normalised (a Mac’s NFD opens a file made with NFC)', nfd.ok)

  const wrong = await openSetup(text, 'ember kindling orbit lanterns')
  check('a wrong passphrase is refused', wrong.ok ? 'opened' : wrong.reason, 'wrong-passphrase')

  const body = Buffer.from(env.ciphertext, 'base64')
  body[Math.floor(body.length / 2)] ^= 0x01
  const flipped = await openSetup(JSON.stringify({ ...env, ciphertext: body.toString('base64') }), pass)
  check('one flipped ciphertext byte is refused (GCM tag)', flipped.ok ? 'opened' : flipped.reason, 'wrong-passphrase')

  const tag = Buffer.from(env.ciphertext, 'base64')
  tag[tag.length - 1] ^= 0x80
  const badTag = await openSetup(JSON.stringify({ ...env, ciphertext: tag.toString('base64') }), pass)
  check('a flipped tag byte is refused', badTag.ok ? 'opened' : badTag.reason, 'wrong-passphrase')

  // The header is the AAD: an edit that still derives a valid-looking key must fail too.
  const nonce = Buffer.from(env.nonce, 'base64')
  nonce[0] ^= 0x01
  const headerEdit = await openSetup(JSON.stringify({ ...env, nonce: nonce.toString('base64') }), pass)
  check('an edited header is refused', headerEdit.ok ? 'opened' : headerEdit.reason, 'wrong-passphrase')

  const refuse = async (label: string, mutate: (e: Record<string, unknown>) => unknown, want: string): Promise<void> => {
    const r = await openSetup(JSON.stringify(mutate(structuredClone(env))), pass)
    check(label, r.ok ? 'opened' : r.reason, want)
  }
  await refuse('an unknown KDF is refused before deriving', (e) => ({ ...e, kdf: { ...(e.kdf as object), alg: 'argon2id' } }), 'unknown-kdf')
  await refuse('an N past the memory ceiling is refused', (e) => ({ ...e, kdf: { ...(e.kdf as object), N: 1 << 22 } }), 'unknown-kdf')
  await refuse('an N that is not a power of two is refused', (e) => ({ ...e, kdf: { ...(e.kdf as object), N: 100000 } }), 'unknown-kdf')
  await refuse('a different cipher is refused', (e) => ({ ...e, aead: 'ChaCha20-Poly1305' }), 'unknown-cipher')
  await refuse('another format is refused', (e) => ({ ...e, format: 'something-else' }), 'not-a-setup-file')
  await refuse('a newer version is refused, and says so', (e) => ({ ...e, v: 2 }), 'newer-version')
  check('garbage is not a setup file', (parseSetupEnvelope('not json') as { reason?: string }).reason, 'not-a-setup-file')
}

console.log('\nimporting: merge through hydrate, unknown keys dropped, values clamped')
{
  const current = hydrateSettings({
    ...plaintextSettings(),
    hosts: [
      { id: 'h1', label: 'Box', alias: 'box', command: '', keyEnrolled: true },
      { id: 'mine', label: 'Only here', alias: 'mine', command: '' }
    ],
    browser: { bookmarks: ['https://a.example'] },
    defaults: { permissionMode: 'default', model: '', effort: 'default', ultracode: false }
  })
  const incoming: SetupPayload = {
    kind: 'stoke-setup-payload',
    createdAt: '2026-09-30T00:00:00.000Z',
    from: { version: '0.9.97', platform: 'win32' },
    settings: {
      evil: 'dropped',
      claudePath: 'C:\\evil\\claude.exe',
      remote: { token: 'stolen', enabled: true, bindLan: true },
      projectRoots: ['C:\\code'],
      fontSize: 999,
      themeId: 42,
      hosts: [
        { id: 'h1', label: 'Box renamed', alias: 'box', command: 'byobu', keyEnrolled: false },
        { id: 'h2', label: 'New VPS', alias: 'vps', command: '', keyEnrolled: true }
      ],
      browser: { bookmarks: ['https://b.example'], lastUrl: 'https://leak.example', width: 9999 },
      defaults: { permissionMode: 'bypassPermissions', model: 'opus', effort: 'high', ultracode: true },
      providers: { claudeAuth: 'anthropic', anthropicApiKey: '', openrouterApiKey: '', customBaseUrl: '', customAuthToken: '' },
      agents: { chosen: ['claude', 'opencode'], endpoints: { opencode: { mode: 'openrouter', model: 'm', baseUrl: '', apiKey: '' } } }
    },
    secrets: {
      'providers.anthropicApiKey': 'sk-ant-FROM-FILE',
      'remote.token': 'stolen-token',
      'agents.endpoints.__proto__.apiKey': 'pwned',
      claudePath: '/evil'
    }
  }
  const keep = mergeSetup(current, incoming, { includeSecrets: false })
  const kept = hydrateSettings(keep.raw)
  ok('an unknown key is dropped', !('evil' in kept))
  check('local-only fields keep this machine’s values', [kept.claudePath, kept.projectRoots, kept.remote.token, kept.remote.bindLan], [
    '/opt/claude',
    ['/Users/someone/code'],
    CANARY.phone,
    false
  ])
  check('fontSize is clamped by hydrate', kept.fontSize, hydrateSettings({ fontSize: 999 }).fontSize)
  check('a non-string theme id falls back to the default', kept.themeId, DEFAULT_SETTINGS.themeId)
  check('hosts are merged by id, the local-only one kept', kept.hosts.map((h) => h.id), ['h1', 'mine', 'h2'])
  check('an existing host takes the file’s fields but keeps this device’s keyEnrolled', [kept.hosts[0].label, kept.hosts[0].keyEnrolled], [
    'Box renamed',
    true
  ])
  check('a new host is never marked enrolled here', kept.hosts[2].keyEnrolled, false)
  check('bookmarks are a union', kept.browser.bookmarks, ['https://a.example', 'https://b.example'])
  check('browser window state does not travel', [kept.browser.lastUrl, kept.browser.width], [current.browser.lastUrl, current.browser.width])
  check('bypass permissions is not imported unconfirmed', kept.defaults.permissionMode, 'default')
  check('but the rest of the defaults are', [kept.defaults.model, kept.defaults.effort], ['opus', 'high'])
  check('and the skip is reported', keep.skipped.map((s) => s.key), ['defaults.permissionMode'])
  check('without the tick, every current key is kept', collectSecrets(kept), collectSecrets(current))
  check('agents: chosen is a union, a new endpoint arrives', [kept.agents.chosen, Object.keys(kept.agents.endpoints).sort()], [
    ['claude', 'codex', 'opencode'],
    ['codex', 'opencode']
  ])
  check('and the existing codex endpoint key survives an import without keys', kept.agents.endpoints.codex?.apiKey, CANARY.codex)

  const take = hydrateSettings(mergeSetup(current, incoming, { includeSecrets: true }).raw)
  check('with the tick, the file’s portable key replaces the current one', take.providers.anthropicApiKey, 'sk-ant-FROM-FILE')
  check('but a phone key in a crafted file is ignored', take.remote.token, CANARY.phone)
  ok('and a __proto__ secret pollutes nothing', ({} as Record<string, unknown>).apiKey === undefined)
  check('and a non-secret path in the secrets map is not written', take.claudePath, '/opt/claude')

  const preview = previewSetup(current, take, incoming, keep.skipped)
  ok('the preview carries no key, from either side', !/CANARY|FROM-FILE|stolen/.test(JSON.stringify(preview)))
  check('it lists the file’s keys by name and action', preview.secrets.map((s) => `${s.label}:${s.action}`), ['Anthropic API key:replace'])
  ok('and names what would change', preview.changes.some((c) => c.key === 'hosts' && /New VPS/.test(c.detail)))
}

console.log('\nan import of an identical setup changes nothing')
{
  // A fresh profile that has never written a setting, importing a file made
  // from another fresh profile: hydrate is not idempotent on worklogBoards
  // (default targets survive the first pass, not the second), which made the
  // preview report a change that was not one. Found driving the app.
  const fresh = hydrateSettings(null)
  const file = buildSetupPayload(fresh, { includeSecrets: false, version: 'x', platform: 'darwin', now: new Date(0) })
  check('fresh into fresh: no changes', planImport(hydrateSettings(null), file, { includeSecrets: false }, hydrateSettings).preview.changes, [])
  const busy = hydrateSettings(plaintextSettings())
  const own = buildSetupPayload(busy, { includeSecrets: true, version: 'x', platform: 'darwin', now: new Date(0) })
  const plan = planImport(busy, own, { includeSecrets: true }, hydrateSettings)
  check('a setup into itself: no changes', plan.preview.changes, [])
  check('and every key reads as the same', plan.preview.secrets.map((s) => s.action), ['same', 'same', 'same', 'same', 'same'])
}

console.log('\nan import from before the Default model brings no hidden leftover in (agents.ts AGENTS_FORMAT)')
{
  /*
   * The merged block carries THIS machine's `agents.format`, so hydrate alone
   * would never upgrade what the file brought. A file exported before format 2
   * can hold a default-mode model the old page hid — an OpenRouter id kept by
   * a mode switch — which would arrive here as that agent's Default model.
   */
  const here = hydrateSettings({
    agents: { chosen: ['codex', 'gemini', 'grok'], endpoints: { grok: { mode: 'default', model: 'grok-build' } }, format: 2 }
  })
  check('this machine’s Default model is stored', here.agents.endpoints.grok?.model, 'grok-build')
  const payload = (agents: Record<string, unknown>): SetupPayload => ({
    kind: 'stoke-setup-payload',
    createdAt: '2026-09-30T00:00:00.000Z',
    from: { version: '0.9.97', platform: 'darwin' },
    settings: { agents },
    secrets: {}
  })
  const endpoints = {
    codex: { mode: 'default', model: 'anthropic/claude-sonnet-5', baseUrl: '', apiKey: '' },
    gemini: { mode: 'openrouter', model: 'google/gemini-3-pro', baseUrl: '', apiKey: '' }
  }
  const old = planImport(here, payload({ chosen: ['codex'], endpoints }), { includeSecrets: false }, hydrateSettings)
  check(
    'an old file: its default-mode leftover is dropped, its OpenRouter endpoint arrives, this machine’s Default model stands',
    old.next.agents.endpoints,
    {
      grok: { mode: 'default', model: 'grok-build', baseUrl: '', apiKey: '' },
      gemini: { mode: 'openrouter', model: 'google/gemini-3-pro', baseUrl: '', apiKey: '' }
    }
  )
  check('and the merged block is this build’s format (3)', old.next.agents.format, 3)
  const current = planImport(here, payload({ chosen: ['codex'], endpoints, format: 2 }), { includeSecrets: false }, hydrateSettings)
  check(
    'a format-2 file’s default-mode model was chosen on purpose, and is imported',
    current.next.agents.endpoints.codex,
    { mode: 'default', model: 'anthropic/claude-sonnet-5', baseUrl: '', apiKey: '' }
  )
}

console.log('\npassphrase strength')
check('empty is not acceptable', judgePassphrase('').acceptable, false)
check('a short one is not acceptable', judgePassphrase('Tr0ub4dor').acceptable, false)
check('a common prefix is not acceptable', judgePassphrase('password123456').acceptable, false)
check('one repeated character is not acceptable', judgePassphrase('aaaaaaaaaaaaaaaa').acceptable, false)
check('four unrelated words are acceptable', judgePassphrase('correct horse battery staple').acceptable, true)
check('a long mixed passphrase is strong', judgePassphrase('Lantern-Orbit-73-kindling!').score >= 3, true)

for (const d of scratch) rmSync(d, { recursive: true, force: true })

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
