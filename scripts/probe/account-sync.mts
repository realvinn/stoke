/** Real localhost vault with an owned second computer. No vendor login or paid CLI. */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startHub } from '../../hub/app.ts'
import { HubLog } from '../../hub/log.ts'
import { HubService } from '../../src/main/hub/service.ts'
import { AccountSync } from '../../src/main/hub/accountSync.ts'
import { accountsRoot, defaultTrees, makeAccountHome } from '../../src/main/accounts.ts'
import { hydrateSettings } from '../../src/main/settingsSchema.ts'
import { GrokBotPlugin } from '../../src/main/plugins/grokBot.ts'
import { GrokBotSessionReader } from '../../src/main/plugins/grokBotSession.ts'
import type { Settings } from '../../src/shared/types.ts'
import type { SecretBackend } from '../../src/main/secrets.ts'

export async function accountSyncFixture(root: string) {
  const home = join(root, 'source-home'), userData = join(home, 'stoke'), trees = defaultTrees({}, home)
  await mkdir(userData, { recursive: true }); await mkdir(trees.codex, { recursive: true })
  const key = randomBytes(32)
  const backend: SecretBackend = {
    isEncryptionAvailable: () => true, selectedBackend: () => null,
    encrypt: value => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]) },
    decrypt: value => { const cipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12)); cipher.setAuthTag(value.subarray(-16)); return Buffer.concat([cipher.update(value.subarray(12, -16)), cipher.final()]).toString() }
  }
  let settings = hydrateSettings({}), svc: HubService
  const listeners = new Set<(s: Settings) => void>()
  const commit = (patch: Partial<Settings>) => { settings = hydrateSettings({ ...settings, ...patch }); for (const fn of listeners) fn(settings); return settings }
  const auth = (email: string) => JSON.stringify({ auth_mode: 'chatgpt', tokens: { id_token: `e30.${Buffer.from(JSON.stringify({ email, sub: email })).toString('base64url')}.fixture`, access_token: 'owned-native-access-' + email, refresh_token: 'owned-native-refresh-' + email, account_id: 'fixture-' + email }, last_refresh: '2026-10-13T01:00:00Z' })
  await writeFile(join(trees.codex, 'auth.json'), auth('synced-personal@example.test'))
  const work = await makeAccountHome({ root: accountsRoot(home), id: 'codex-synced-work', cli: 'codex', trees })
  await writeFile(join(work.home, 'auth.json'), auth('synced-work@example.test'))
  settings = hydrateSettings({ accounts: { 'codex-synced-work': { id: 'codex-synced-work', cli: 'codex', kind: 'login', label: 'Synced Work', home: work.home, apiKey: '' } } })
  const bots = new GrokBotPlugin({ root: join(userData, 'plugins'), executable: process.execPath, runner: '', platform: 'darwin', environment: {}, backend, reader: new GrokBotSessionReader({ home, platform: 'darwin', environment: {} }), enabled: async () => false, changed: () => svc?.accountsChanged() })
  for (let n = 1; n <= 5; n++) await bots.importFromSync('gbot-' + randomUUID(), { label: `Synced Grok ${n}`, credential: { gatewayUrl: 'https://gateway.cursor.sh', token: 'owned-sync-token-' + n, headers: { 'x-owned-slot': String(n) } } }, () => true)
  const accounts = new AccountSync({ userData, root: accountsRoot(home), trees, platform: 'darwin', label: 'Fixture Desktop', backend, getSettings: () => settings, commit, active: () => false, grok: async () => bots, changed: () => svc?.accountsChanged() })
  const announced: string[] = []
  const hub = await startHub({ dataDir: join(root, 'hub'), mount: '/hub', edge: null, lan: { host: '127.0.0.1', port: 0 }, edgeSecret: null, rate: { capacity: 100_000, refillPerSec: 1000 }, pingMs: 60 * 60_000 }, { log: new HubLog(() => undefined, { level: 'error' }), announce: s => announced.push(s) })
  const url = `http://127.0.0.1:${hub.lanPort}/hub`, email = 'native-sync@example.test', password = 'owned native fixture password'
  svc = new HubService({ userData, backend, platform: 'darwin', hostname: 'Fixture Desktop', appVersion: '0.0.0-fixture', getSettings: () => settings, commit, hydrate: hydrateSettings, onSettingsChanged: fn => { listeners.add(fn); return () => listeners.delete(fn) }, emit: () => {}, presence: null, accounts, pairPollMs: 50, ssh: { home, dir: join(home, '.ssh'), config: join(home, '.ssh', 'config') }, exec: async () => ({ ok: true, stdout: '', stderr: '', error: null }) })
  try {
    await svc.start(); await svc.setScope({ settings: false, hosts: false, keys: false }); await svc.setUrl(url)
    const signed = await svc.signIn({ email, password, label: 'Fixture Desktop', invite: /(INV(?:-[0-9A-Z]{4}){6})/.exec(announced.join(''))?.[1] ?? '' })
    if (!signed.ok) throw new Error(signed.message)
    const kit = await svc.createVault()
    if (!kit.ok) throw new Error(kit.message)
    const confirmed = await svc.confirmKit(kit.kit.split('-')[kit.group])
    if (!confirmed.ok) throw new Error(confirmed.message)
    return { svc, url, email, password, stop: async () => { await svc.signOut().catch(() => {}); svc.stop(); bots.stop(); await hub.close() } }
  } catch (error) { svc.stop(); bots.stop(); await hub.close(); throw error }
}
