/*
 * Secrets at rest.
 *
 * Everything here runs against a SYNTHETIC userData under the OS temp dir and
 * an INJECTED key store, never the real Keychain and never a real profile
 * (gotcha 74: fake every input — the directory as well as the backend — and
 * prove a bystander survives).
 *
 *   node scripts/verify-secrets.mts
 */
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { SecretStore, type SecretBackend } from '../src/main/secrets.ts'
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
  phone: 'phone-CANARY-u1v2w3x4y5'
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
    hosts: [{ id: 'h1', label: 'Box', alias: 'box', command: '', keyEnrolled: true }]
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
    'agents.endpoints.codex.apiKey',
    'providers.anthropicApiKey',
    'providers.customAuthToken',
    'providers.openrouterApiKey',
    'remote.token'
  ])
  // A pattern that names a path Settings does not have encrypts nothing, silently.
  const hydrated = hydrateSettings(s)
  for (const spec of SECRET_PATHS) {
    ok(
      `pattern ${spec.pattern} names a real Settings path`,
      secretPathsIn(hydrated, [spec]).length > 0,
      'no path in a hydrated populated Settings matches it'
    )
  }
  check('collectSecrets returns exactly the five values', Object.values(collectSecrets(s)).sort(), [...ALL_CANARIES].sort())
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
  check('secrets.json holds one item per secret', Object.keys(parseSecretsFile(vaultText)?.items ?? {}).length, 5)
  if (process.platform !== 'win32') {
    check('secrets.json is mode 0600', (statSync(secretsFile).mode & 0o777).toString(8), '600')
    check('settings.json is mode 0600 too', (statSync(settingsFile).mode & 0o777).toString(8), '600')
  }
  check('the bystander in userData survives untouched', read(bystander), '{"bystander":true}')
  ok('the key store was asked, since there was something to seal', calls.available > 0 && calls.encrypt === 5)

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
  check('and status lists all five as stranded', storeB.status().stranded.length, 5)
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

for (const d of scratch) rmSync(d, { recursive: true, force: true })

console.log(`\n${failures ? `${failures} failure(s)` : 'all pass'}`)
process.exitCode = failures ? 1 : 0
