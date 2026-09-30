/*
 * The Stoke Hub DESKTOP CLIENT: its sync rules (src/shared/hub/client.ts), its
 * files and SSH-key handling (src/main/hub/files.ts, sshKeys.ts), and the
 * whole client (src/main/hub/service.ts) driven as two — then three — devices
 * against a real hub running in this process on 127.0.0.1.
 *
 *   node scripts/verify-hub-client.mts
 *
 * Every input is synthetic (gotcha 74): temp userData dirs, temp "~/.ssh"
 * dirs with made-up keys, a fake key store, settings held in memory, and an
 * `ssh -G` stand-in that reads only the temp config it is pointed at. Nothing
 * in ~ is read or written, no agent CLI runs, nothing leaves 127.0.0.1.
 *
 * The contract is verify:hub's and the server is verify:hub-server's; this is
 * whether the client does what the spec says a client does.
 */
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startHub, type HubHandle } from '../hub/app.ts'
import { HubLog } from '../hub/log.ts'
import type { Settings } from '../src/shared/types.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { HubFiles } from '../src/main/hub/files.ts'
import { HubService } from '../src/main/hub/service.ts'
import { installReceivedKey, listKeyPairs, planInstall, privateKeyHasPassphrase, readKeyForShare, sshFingerprint } from '../src/main/hub/sshKeys.ts'
import { itemKeys, openItem, sha256B64u } from '../src/main/hub/crypto.ts'
import type { SecretBackend } from '../src/main/secrets.ts'
import type { ExecRun } from '../src/main/sshEnroll.ts'
import {
  emptyHubState,
  hydrateHubState,
  incomingFrom,
  inScope,
  localValues,
  nextSyncDelay,
  planSync,
  SYNC_BACKOFF_MS,
  SYNC_INTERVAL_MS,
  sshKeyInstallPlan,
  valueDigest,
  type RemoteItem,
  type SyncedRecord
} from '../src/shared/hub/client.ts'
import { T1_KEYS } from '../src/shared/hub/items.ts'
import { LOCAL_KEYS, PARTIAL_KEYS, PORTABLE_KEYS } from '../src/shared/setupFile.ts'

let failures = 0
function check(name: string, got: unknown, want: unknown): void {
  const pass = JSON.stringify(got) === JSON.stringify(want)
  if (!pass) failures++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${name}` + (pass ? '' : `\n        got ${JSON.stringify(got)?.slice(0, 500)}, want ${JSON.stringify(want)?.slice(0, 500)}`))
}
function ok(name: string, condition: boolean, detail = ''): void {
  if (!condition) failures++
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}${condition || !detail ? '' : `\n        ${detail.slice(0, 700)}`}`)
}

const WIN = process.platform === 'win32'
const TMP = mkdtempSync(join(tmpdir(), 'stoke-hub-client-'))
const digest = (t: string): string => createHash('sha256').update(t).digest('base64url')
const ME = 'd0000000000000000'
const OTHER = 'dzzzzzzzzzzzzzzzz'
const HOST_A = 'h0000000000000001'
const HOST_B = 'h0000000000000002'
const KEY_1 = 'k0000000000000001'

function base(extra: Partial<Settings> = {}): Settings {
  return hydrateSettings(hydrateSettings({ ...extra }))
}

function remote(path: string, value: unknown, over: Partial<RemoteItem> = {}): RemoteItem {
  const deleted = over.deleted ?? false
  return {
    path,
    id: `i${'A'.repeat(32)}`,
    epoch: 1,
    version: 1,
    editedAt: 1000,
    author: OTHER,
    deleted,
    value: deleted ? null : value,
    hash: valueDigest(digest, { deleted, value: deleted ? null : value }),
    ...over
  }
}

function record(value: unknown, over: Partial<SyncedRecord> = {}): SyncedRecord {
  const h = valueDigest(digest, { deleted: over.deleted ?? false, value })
  return { id: `i${'A'.repeat(32)}`, epoch: 1, version: 1, hash: h, localHash: h, editedAt: 1000, author: OTHER, deleted: false, ...over }
}

const ALL = { settings: true, hosts: true, keys: true }

/* =================================================== what syncs, and what never does */
console.log('\nwhat a device offers the hub, tier by tier')
{
  const s = base({
    themeId: 'moss',
    providers: { ...base().providers, anthropicApiKey: 'sk-ant-api03-SYNTHETIC-portable' },
    hosts: [
      { id: 'host-1', label: 'NUC', alias: 'nuc', command: '', keyEnrolled: true, syncId: HOST_A },
      { id: 'host-2', label: 'Box', alias: 'box', command: '' }
    ],
    remote: { ...base().remote, token: 'PHONE-KEY-NEVER' },
    accounts: {},
    projectRoots: ['/Users/someone/dev']
  } as Partial<Settings>)
  const local = localValues({ settings: s, scope: ALL, prefs: { syncKeys: { on: true }, deviceNames: null }, keyRefs: { [HOST_A]: [KEY_1] } })
  const t1 = [...local.keys()].filter((p) => p.startsWith('t1/')).map((p) => p.slice('t1/settings/'.length))
  check('T1 is exactly the portable settings, hosts apart, plus the two partial blocks', t1.sort(), [...T1_KEYS].sort())
  ok('no machine-local setting is ever a T1 item (hub, remote, accounts, folders, window…)', LOCAL_KEYS.every((k) => !t1.includes(k)), t1.filter((k) => (LOCAL_KEYS as readonly string[]).includes(k)).join(','))
  ok('`hub` itself is machine-local (setupFile LOCAL_KEYS)', (LOCAL_KEYS as readonly string[]).includes('hub'))
  ok('every portable key but hosts is T1', PORTABLE_KEYS.filter((k) => k !== 'hosts').every((k) => t1.includes(k)) && Object.keys(PARTIAL_KEYS).every((k) => t1.includes(k)))
  const providers = local.get('t1/settings/providers')?.value as Record<string, unknown>
  check('a T1 block carries no key: providers travels with its key emptied', providers?.anthropicApiKey, '')
  check('T2 holds the portable key itself', local.get('t2/secret/providers.anthropicApiKey')?.value, 'sk-ant-api03-SYNTHETIC-portable')
  ok('the phone key, the hub session and account keys are never T2', ![...local.keys()].some((p) => /remote\.token|hub\.token|accounts\./.test(p)))
  ok('nothing anywhere carries the phone key', ![...local.values()].some((v) => JSON.stringify(v).includes('PHONE-KEY-NEVER')))
  const host = local.get(`t3/host/${HOST_A}`)?.value as Record<string, any>
  check('a host with a sync id is T3, without its local id, keyEnrolled or sync id', [host?.host?.alias, 'id' in (host?.host ?? {}), 'keyEnrolled' in (host?.host ?? {}), 'syncId' in (host?.host ?? {})], ['nuc', false, false, false])
  check('and names the SSH keys it uses', host?.keyRefs, [KEY_1])
  ok('a host with no sync id yet is not an item (it gets one after the hub’s hosts are folded in)', ![...local.keys()].some((p) => p.includes('host-2')) && [...local.keys()].filter((p) => p.startsWith('t3/')).length === 1)
  ok('T4 is never offered by a pass: a key moves only when the owner picks it', ![...local.keys()].some((p) => p.startsWith('t4/')) && !inScope(`t4/ssh-key/${KEY_1}`, ALL))
  check('the account’s key switch is an item', local.get('acct/pref/sync-keys')?.value, { on: true })
  const noKeys = localValues({ settings: s, scope: { settings: true, hosts: true, keys: false }, prefs: { syncKeys: null, deviceNames: null }, keyRefs: {} })
  ok('with key sync off, no T2 item exists at all', ![...noKeys.keys()].some((p) => p.startsWith('t2/')))
  const hydrated = localValues({ settings: base(), scope: ALL, prefs: { syncKeys: null, deviceNames: null }, keyRefs: {} })
  const again = localValues({ settings: base(base() as unknown as Partial<Settings>), scope: ALL, prefs: { syncKeys: null, deviceNames: null }, keyRefs: {} })
  ok(
    'a fresh profile hydrated once more reads the same (gotcha 116: no phantom write)',
    [...hydrated].every(([p, v]) => valueDigest(digest, v) === valueDigest(digest, again.get(p) ?? { deleted: true, value: null }))
  )
}

/* =================================================== the plan */
console.log('\nplanning a pass: who changed, who wins')
{
  const path = 't1/settings/themeId'
  const plan = (local: Map<string, { deleted: boolean; value: unknown }>, rem: Map<string, RemoteItem>, records: Record<string, SyncedRecord>, extra: Partial<Parameters<typeof planSync>[0]> = {}) =>
    planSync({ local, remote: rem, records, scope: ALL, me: ME, now: 5000, lastEditedAt: 0, digest, ...extra })
  const L = (v: unknown) => new Map([[path, { deleted: false, value: v }]])
  const R = (v: unknown, o: Partial<RemoteItem> = {}) => new Map([[path, remote(path, v, o)]])

  let p = plan(L('ember'), R('ember'), { [path]: record('ember') })
  check('nobody changed: nothing to do', [p.apply.length, p.upload.length, p.adopt.length], [0, 0, 0])
  p = plan(L('moss'), R('ember'), { [path]: record('ember') })
  check('only this device changed: upload', [p.upload.map((u) => u.path), p.apply.length], [[path], 0])
  p = plan(L('ember'), R('moss', { version: 2 }), { [path]: record('ember') })
  check('only the hub changed: apply', [p.apply.map((a) => a.value), p.upload.length], [['moss'], 0])
  p = plan(L('moss'), R('moss', { version: 2 }), { [path]: record('ember') })
  check('both changed to the same value: adopt, no write', [p.adopt.length, p.apply.length, p.upload.length, p.notes.length], [1, 0, 0, 0])
  p = plan(L('moss'), R('lagoon', { version: 2, editedAt: 4000 }), { [path]: record('ember') }, { stamps: { [path]: { editedAt: 4500, hash: valueDigest(digest, { deleted: false, value: 'moss' }) } } })
  check('a conflict goes to the later edit — here this device’s, stamped when it was made', [p.upload.length, p.apply.length, p.notes[0]?.kept, p.upload[0]?.editedAt], [1, 0, 'mine', 4500])
  p = plan(L('moss'), R('lagoon', { version: 2, editedAt: 4800 }), { [path]: record('ember') }, { stamps: { [path]: { editedAt: 4500, hash: valueDigest(digest, { deleted: false, value: 'moss' }) } } })
  check('and to theirs when theirs is later, noted either way', [p.upload.length, p.apply.map((a) => a.value), p.notes[0]?.kept, p.notes[0]?.otherDevice], [0, ['lagoon'], 'theirs', OTHER])
  const tie = (me: string) => plan(L('moss'), R('lagoon', { version: 2, editedAt: 4500, author: 'dmmmmmmmmmmmmmmmm' }), { [path]: record('ember') }, { me, stamps: { [path]: { editedAt: 4500, hash: valueDigest(digest, { deleted: false, value: 'moss' }) } } }).notes[0]?.kept
  check('a tie goes to the larger device id, the same answer on every device', [tie('d0000000000000000'), tie('dzzzzzzzzzzzzzzzz')], ['theirs', 'mine'])
  p = plan(L('ember'), R('moss'), {})
  check('first meeting: the hub’s copy wins, so a joining device takes the account’s settings', [p.apply.map((a) => a.value), p.upload.length, p.notes.length], [['moss'], 0, 0])
  const key = 't2/secret/providers.anthropicApiKey'
  p = planSync({ local: new Map([[key, { deleted: false, value: 'mine' }]]), remote: new Map([[key, remote(key, null, { deleted: true })]]), records: {}, scope: ALL, me: ME, now: 5000, lastEditedAt: 0, digest })
  check('but a tombstone never deletes a key this device holds and never agreed to lose: it is uploaded again', [p.upload.map((u) => [u.path, u.local.deleted]), p.apply.length], [[[key, false]], 0])
  p = planSync({ local: new Map(), remote: new Map([[key, remote(key, 'k1')]]), records: { [key]: record('k1') }, scope: ALL, me: ME, now: 5000, lastEditedAt: 0, digest })
  check('a key cleared here after agreeing is a tombstone upload', p.upload.map((u) => [u.path, u.local.deleted]), [[key, true]])
  const hostPath = `t3/host/${HOST_B}`
  p = planSync({ local: new Map(), remote: new Map([[hostPath, remote(hostPath, { host: { alias: 'x' }, keyRefs: [] })]]), records: { [hostPath]: record({ host: { alias: 'x' }, keyRefs: [] }) }, scope: ALL, me: ME, now: 5000, lastEditedAt: 0, digest })
  check('a host removed here is a tombstone too', p.upload.map((u) => u.local.deleted), [true])
  p = planSync({ local: new Map(), remote: new Map([[key, remote(key, 'k1')]]), records: { [key]: record('k1') }, scope: { ...ALL, keys: false }, me: ME, now: 5000, lastEditedAt: 0, digest })
  check('with key sync off, a key is neither sent nor deleted nor applied', [p.upload.length, p.apply.length], [0, 0])
  p = plan(L('ember'), R('ember', { epoch: 2, version: 1, id: `i${'B'.repeat(32)}` }), { [path]: record('ember') })
  check('a copy re-sealed under a new epoch is adopted, so the next put lands on the new slot', [p.adopt.map((a) => a.epoch), p.apply.length, p.upload.length], [[2], 0, 0])
  const moved = { ...record('ember'), localHash: valueDigest(digest, { deleted: false, value: 'ember-hydrated' }) }
  p = plan(L('ember-hydrated'), R('ember'), { [path]: moved })
  check('a value hydrate moved after applying is not a local change (no phantom upload)', [p.upload.length, p.apply.length], [0, 0])
  const acct = planSync({ local: new Map(), remote: new Map([['acct/pref/sync-keys', remote('acct/pref/sync-keys', { on: true })]]), records: { 'acct/pref/sync-keys': record({ on: false }) }, scope: ALL, me: ME, now: 5000, lastEditedAt: 0, digest })
  check('an account preference this device has no value for is applied, never deleted', [acct.apply.length, acct.upload.length], [1, 0])
  const inc = incomingFrom([
    remote('t1/settings/themeId', 'moss'),
    remote(key, 'sk-x'),
    remote(`t3/host/${HOST_A}`, { host: { label: 'NUC', alias: 'nuc', command: '' }, keyRefs: [KEY_1, 'junk'] }),
    remote(`t3/host/${HOST_B}`, null, { deleted: true }),
    remote('acct/pref/device-names', { names: { [ME]: '  Laptop  ', junk: 'x' } })
  ])
  check('what arrives becomes applySyncedSettings input, key refs and preferences', [inc.incoming.settings?.themeId, inc.incoming.secrets?.['providers.anthropicApiKey'], Object.keys(inc.incoming.hosts ?? {}), inc.incoming.hosts?.[HOST_B], inc.keyRefs[HOST_A], inc.prefs.deviceNames?.names], ['moss', 'sk-x', [HOST_A, HOST_B], null, [KEY_1], { [ME]: 'Laptop' }])
  check('background sync backs off 30 s, 1 m, 2 m, 5 m, 15 m, and rests at 5 m when well', [nextSyncDelay(0), ...[1, 2, 3, 4, 5, 9].map(nextSyncDelay)], [SYNC_INTERVAL_MS, ...SYNC_BACKOFF_MS, SYNC_BACKOFF_MS[4]])
}

/* =================================================== the state file */
console.log('\nhub-state.json: repaired, never trusted')
{
  const s = emptyHubState('a0000000000000000')
  s.records['t1/settings/themeId'] = record('ember')
  s.notes.push({ path: 't1/settings/themeId', label: 'Theme', kept: 'mine', otherDevice: OTHER, otherEditedAt: 1, mineEditedAt: 2, at: 3 })
  s.vaultKeys['1'] = 'c2VhbGVk'
  const back = hydrateHubState(JSON.parse(JSON.stringify(s)), 'a0000000000000000')
  check('a state round-trips', JSON.stringify(back), JSON.stringify(s))
  check('a state for another account is not this one’s', Object.keys(hydrateHubState(s, 'azzzzzzzzzzzzzzzz').records).length, 0)
  const junk = hydrateHubState({ ...s, records: { 'not/a/path': record('x'), 't1/settings/themeId': { id: 'nope' } }, vaultKeys: { '0': 'x', abc: 'y' }, received: { nope: {} } }, 'a0000000000000000')
  check('junk records, epochs and keys are dropped', [Object.keys(junk.records).length, Object.keys(junk.vaultKeys).length, Object.keys(junk.received).length], [0, 0, 0])
}

/* =================================================== the key store */
console.log('\nthe device files: sealed, and no vault key where the key store protects nothing')
{
  const dir = join(TMP, 'files-basic')
  mkdirSync(dir, { recursive: true })
  const basic: SecretBackend = { isEncryptionAvailable: () => true, selectedBackend: () => 'basic_text', encrypt: (p) => Buffer.from(p), decrypt: (b) => b.toString() }
  const f = new HubFiles(dir, basic, 'linux')
  check('Linux basic_text is not protection', f.keyStore().protected, false)
  let refused = false
  try {
    f.sealVault('a0000000000000000', 1, new Uint8Array(32))
  } catch {
    refused = true
  }
  check('so a vault key is refused rather than written readable (spec §4.2)', refused, true)
  const sealedDir = join(TMP, 'files-sealed')
  mkdirSync(sealedDir, { recursive: true })
  const good = new HubFiles(sealedDir, {
    isEncryptionAvailable: () => true,
    selectedBackend: () => null,
    encrypt: (p) => Buffer.from(`k|${Buffer.from(p).toString('base64')}`),
    decrypt: (b) => Buffer.from(b.toString().slice(2), 'base64').toString()
  }, 'darwin')
  const vk = new Uint8Array(32).fill(7)
  const sealed = good.sealVault('a0000000000000000', 3, vk)
  check('a sealed vault key opens for its own account and epoch only', [!!good.openVault('a0000000000000000', 3, sealed), good.openVault('a0000000000000000', 4, sealed), good.openVault('azzzzzzzzzzzzzzzz', 3, sealed)], [true, null, null])
}

/* =================================================== SSH keys on disk */
console.log('\nSSH keys: listed by their .pub, read only when picked, received without replacing anything')
function syntheticKey(name: string, cipher: 'none' | 'aes256-ctr'): { priv: string; pub: string } {
  const magic = Buffer.from('openssh-key-v1\0', 'latin1')
  const c = Buffer.from(cipher, 'latin1')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(c.length)
  const body = Buffer.concat([magic, len, c, Buffer.from(`synthetic-${name}-${Math.random()}`)]).toString('base64')
  const blob = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519'), Buffer.from(`pub-${name}-${Math.random()}`)]).toString('base64')
  return { priv: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.match(/.{1,70}/g)?.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`, pub: `ssh-ed25519 ${blob} ${name}@synthetic` }
}

/** `ssh -G` as far as IdentityFile goes: the lines of the config it is given with -F, nothing else read. */
function fakeSshG(): ExecRun {
  return async (_file, args) => {
    const f = args.indexOf('-F')
    const cfg = f >= 0 ? args[f + 1] : ''
    const alias = args[args.length - 1]
    let out = ''
    if (cfg && existsSync(cfg)) {
      let on = false
      for (const line of readFileSync(cfg, 'utf8').split('\n')) {
        const host = /^\s*Host\s+(.+)$/.exec(line)
        if (host) on = host[1].split(/\s+/).includes(alias)
        const idf = /^\s*IdentityFile\s+"?([^"]+)"?\s*$/.exec(line)
        if (idf && on) out += `identityfile ${idf[1]}\n`
      }
    }
    return { ok: true, stdout: `hostname ${alias}\n${out}`, stderr: '', error: null }
  }
}

{
  const dir = join(TMP, 'ssh-a')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const k = syntheticKey('work', 'none')
  const kp = syntheticKey('locked', 'aes256-ctr')
  writeFileSync(join(dir, 'id_work'), k.priv, { mode: 0o600 })
  writeFileSync(join(dir, 'id_work.pub'), `${k.pub}\n`)
  writeFileSync(join(dir, 'id_locked'), kp.priv, { mode: 0o600 })
  writeFileSync(join(dir, 'id_locked.pub'), `${kp.pub}\n`)
  writeFileSync(join(dir, 'lonely.pub'), `${k.pub}\n`)
  writeFileSync(join(dir, 'known_hosts'), 'bystander\n')
  writeFileSync(join(dir, 'config'), 'Host *\n  ServerAliveInterval 30\n')
  const pairs = await listKeyPairs(dir)
  check('the picker lists key PAIRS only (no lone .pub, no known_hosts, no config)', pairs.map((p) => p.name), ['id_locked', 'id_work'])
  check('with OpenSSH’s own fingerprint', pairs.find((p) => p.name === 'id_work')?.fingerprint, sshFingerprint(k.pub.split(' ')[1]))
  const read = await readKeyForShare(dir, 'id_work')
  ok('a picked key is read as it is, with its .pub', 'privateKey' in read && read.privateKey === k.priv && read.publicKey.startsWith('ssh-ed25519 '))
  check('a passphrase on a key is seen, and travels (the key is not decrypted)', [privateKeyHasPassphrase(k.priv), privateKeyHasPassphrase(kp.priv), privateKeyHasPassphrase('-----BEGIN RSA PRIVATE KEY-----\nProc-Type: 4,ENCRYPTED\n')], [false, true, true])
  check('nothing outside a key pair is read for sharing', [('error' in (await readKeyForShare(dir, 'config'))), ('error' in (await readKeyForShare(dir, '../x')))], [true, true])

  const recv = join(TMP, 'ssh-b')
  const payload = read as Exclude<typeof read, { error: string }>
  check('a received key goes under its own name when free', await planInstall(recv, payload), { name: 'id_work', pubName: 'id_work.pub', action: 'write' })
  mkdirSync(recv, { recursive: true, mode: 0o700 })
  const someoneElse = syntheticKey('someone-else', 'none').priv
  writeFileSync(join(recv, 'id_work'), someoneElse, { mode: 0o600 })
  writeFileSync(join(recv, 'known_hosts'), 'bystander-b\n')
  writeFileSync(join(recv, 'config'), '# mine\nHost old\n  User me\n')
  chmodSync(join(recv, 'config'), 0o600)
  const configBefore = readFileSync(join(recv, 'config'))
  check('a different key already under that name is never replaced: -stoke-2', (await planInstall(recv, payload)) as unknown, { name: 'id_work-stoke-2', pubName: 'id_work-stoke-2.pub', action: 'write' })
  writeFileSync(join(recv, 'id_work-stoke-2.pub'), 'someone’s lone pub\n')
  check('nor a lone .pub under the next one: -stoke-3', ((await planInstall(recv, payload)) as { name: string }).name, 'id_work-stoke-3')
  check('an unsafe name is refused outright', [sshKeyInstallPlan({ ...payload, name: 'config' }, () => 'free'), sshKeyInstallPlan({ ...payload, name: '.hidden' }, () => 'free')].map((r) => 'error' in r), [true, true])
  check('so is a payload that is not a key', 'error' in sshKeyInstallPlan({ ...payload, privateKey: 'hello' }, () => 'free'), true)
  const hosts = [{ id: 'host-1', label: 'NUC', alias: 'nuc', command: '', syncId: HOST_A }, { id: 'host-2', label: 'Other', alias: 'other', command: '', syncId: HOST_B }]
  const paths = { dir: recv, config: join(recv, 'config'), home: TMP }
  const res = await installReceivedKey(paths, KEY_1, payload, hosts as never, { [HOST_A]: [KEY_1] }, 'the Mac', fakeSshG())
  check('installed under the free name, for the host that uses it only', [res.ok, res.name, res.hosts], [true, 'id_work-stoke-3', ['nuc']])
  const written = join(recv, 'id_work-stoke-3')
  check('the private key is exactly what was shared', readFileSync(written, 'utf8'), payload.privateKey)
  if (!WIN) check('owner-only: 0600, the .pub 0644', [statSync(written).mode & 0o777, statSync(`${written}.pub`).mode & 0o777], [0o600, 0o644])
  check('the other key under the wanted name is untouched', readFileSync(join(recv, 'id_work'), 'utf8'), someoneElse)
  check('and so are known_hosts and the lone .pub', [readFileSync(join(recv, 'known_hosts'), 'utf8'), readFileSync(join(recv, 'id_work-stoke-2.pub'), 'utf8')], ['bystander-b\n', 'someone’s lone pub\n'])
  const configAfter = readFileSync(join(recv, 'config'))
  ok('the config is appended to, never rewritten: every old byte is still first', configAfter.subarray(0, configBefore.length).equals(configBefore))
  ok('with an IdentityFile block for that host naming the new file', /Host nuc\n\s+IdentityFile "[^"]*id_work-stoke-3"/.test(configAfter.toString('utf8')), configAfter.toString('utf8'))
  ok('and a backup of the config as it was', existsSync(join(recv, 'config.stoke.bak')) && readFileSync(join(recv, 'config.stoke.bak')).equals(configBefore))
  const twice = await installReceivedKey(paths, KEY_1, payload, hosts as never, { [HOST_A]: [KEY_1] }, 'the Mac', fakeSshG())
  check('installing it again writes nothing: the identical key is found, the host already offers it', [twice.name, twice.wrote, readFileSync(join(recv, 'config')).equals(configAfter)], ['id_work-stoke-3', false, true])
}

/* =================================================== two devices, one hub */
console.log('\nthe client end to end: two devices, a hub on 127.0.0.1')

function fakeBackend(tag: string): SecretBackend {
  return {
    isEncryptionAvailable: () => true,
    selectedBackend: () => null,
    encrypt: (plain) => Buffer.from(`${tag}|${Buffer.from(plain, 'utf8').toString('base64')}`, 'utf8'),
    decrypt: (sealed) => {
      const t = sealed.toString('utf8')
      if (!t.startsWith(`${tag}|`)) throw new Error('sealed by another key')
      return Buffer.from(t.slice(tag.length + 1), 'base64').toString('utf8')
    }
  }
}

interface Box {
  name: string
  svc: HubService
  settings(): Settings
  set(patch: Partial<Settings>): void
  userData: string
  ssh: { dir: string; config: string; home: string }
}

function device(name: string, initial: Partial<Settings>): Box {
  const userData = join(TMP, `ud-${name}`)
  mkdirSync(userData, { recursive: true })
  const ssh = { dir: join(TMP, `home-${name}`, '.ssh'), config: join(TMP, `home-${name}`, '.ssh', 'config'), home: join(TMP, `home-${name}`) }
  mkdirSync(ssh.dir, { recursive: true, mode: 0o700 })
  let s = hydrateSettings(initial)
  const listeners = new Set<(x: Settings) => void>()
  const commit = (patch: Partial<Settings>): Settings => {
    s = hydrateSettings({ ...s, ...patch })
    for (const l of listeners) l(s)
    return s
  }
  const svc = new HubService({
    userData,
    backend: fakeBackend(name),
    platform: 'darwin',
    hostname: `${name} test machine`,
    appVersion: '0.0.0-test',
    getSettings: () => s,
    commit,
    hydrate: hydrateSettings,
    onSettingsChanged: (fn) => {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    emit: () => undefined,
    ssh,
    exec: fakeSshG(),
    presence: null,
    pairPollMs: 40
  })
  return { name, svc, settings: () => s, set: (p) => commit(p), userData, ssh }
}

async function until(what: string, cond: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (cond()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  ok(`in time: ${what}`, false)
  return false
}

const hubDir = join(TMP, 'hub')
const announced: string[] = []
const hub: HubHandle = await startHub(
  { dataDir: hubDir, mount: '/hub', edge: null, lan: { host: '127.0.0.1', port: 0 }, edgeSecret: null, rate: { capacity: 100_000, refillPerSec: 1000 }, pingMs: 60 * 60_000 },
  { log: new HubLog(() => undefined, { level: 'error' }), announce: (t) => announced.push(t) }
)
const URL = `http://127.0.0.1:${hub.lanPort}/hub`
const invite = /(INV(?:-[0-9A-Z]{4}){6})/.exec(announced.join(''))?.[1] ?? ''
const EMAIL = 'owner@example.com'
const PASSWORD = 'correct horse battery staple'
const CANARY_KEY = `sk-ant-api03-hubclient-canary-${Math.random().toString(36).slice(2)}`
const CANARY_KEY_2 = `sk-or-v1-hubclient-canary2-${Math.random().toString(36).slice(2)}`
const secretsSeen: string[] = [CANARY_KEY, CANARY_KEY_2, PASSWORD]

const A = device('mac', {
  themeId: 'moss',
  fontSize: 15,
  providers: { ...hydrateSettings({}).providers, anthropicApiKey: CANARY_KEY },
  hosts: [{ id: 'host-1', label: 'NUC', alias: 'nuc', command: '', persist: 'off' }],
  remote: { ...hydrateSettings({}).remote, token: 'PHONE-KEY-A' }
} as Partial<Settings>)
const B = device('win', {
  themeId: 'ember',
  hosts: [
    { id: 'host-1', label: 'VPS', alias: 'vps', command: '', persist: 'off' },
    { id: 'host-2', label: 'NUC here', alias: 'nuc', command: '', persist: 'off' }
  ]
} as Partial<Settings>)

try {
  await A.svc.start()
  await B.svc.start()
  check('before an address, the panel is off', A.svc.view().phase, 'off')
  const checked = await A.svc.checkUrl(URL)
  check('the address answers as a hub that still needs its first account', [checked.ok, checked.ok && checked.needsBootstrap, checked.ok && !!checked.warning], [true, true, true])
  const notHub = await A.svc.checkUrl('http://127.0.0.1:1/hub')
  check('an address with nothing there says so in a sentence', [notHub.ok, !notHub.ok && /Could not reach the hub/.test(notHub.message)], [false, true])
  check('plain http to a public host is refused before anything is sent', (await A.svc.setUrl('http://example.com/hub')).ok, false)
  check('the local hub is accepted, with the warning', (await A.svc.setUrl(URL)).ok, true)

  const weak = await A.svc.signIn({ invite, email: EMAIL, password: 'short' })
  check('a short password is refused before the hub is asked', [weak.ok, !weak.ok && /12 characters/.test(weak.message)], [false, true])
  const up = await A.svc.signIn({ invite, email: EMAIL, password: PASSWORD, label: 'Mac' })
  check('the first account is made with the invite and signed in', [up.ok, A.svc.view().phase, A.svc.view().role], [true, 'new-account', 'owner'])
  ok('the session is sealed in hub-device.json, never in Settings', A.settings().hub.token === '' && !readFileSync(join(A.userData, 'hub-device.json'), 'utf8').includes('sht_'))
  if (!WIN) check('hub-device.json is owner-only', statSync(join(A.userData, 'hub-device.json')).mode & 0o777, 0o600)
  const twice = await Promise.all([A.svc.createVault(), A.svc.createVault()])
  check('a double press makes one Kit, not two (gotcha 20)', twice.map((r) => r.ok).sort(), [false, true])
  const made = twice.find((r) => r.ok) as { ok: true; kit: string; group: number }
  ok('the Kit looks like a Kit', /^RK1(-[0-9A-Z*~$=U]{3,4}){7}$/.test(made.kit), made.kit)
  secretsSeen.push(made.kit)
  check('the vault is not made until the Kit is confirmed', [A.svc.view().phase, A.svc.view().kitPending], ['new-account', true])
  check('a wrong group is refused', (await A.svc.confirmKit('XXXX')).ok, false)
  const group = made.kit.split('-')[made.group]
  check('the right group (typed any old way) makes the vault', (await A.svc.confirmKit(group.toLowerCase())).ok, true)
  await until('A syncs after genesis', () => A.svc.view().lastSyncAt !== null)
  check('A is in the vault, alone', [A.svc.view().phase, A.svc.view().devices.length, A.svc.view().devices[0]?.me], ['active', 1, true])
  ok('A’s host got a sync id when it first synced (gotcha 139)', /^h[0-9a-z]{16}$/.test((A.settings().hosts[0] as { syncId?: string }).syncId ?? ''))
  check('A synced its settings and host; keys wait for the account switch', [A.svc.view().counts.settings > 10, A.svc.view().counts.hosts, A.svc.view().counts.keys], [true, 1, 0])
  check('turning on key sync for the account', (await A.svc.setAccountKeys(true)).ok, true)
  check('uploads the portable key (and never the phone key)', A.svc.view().counts.keys, 1)

  /* ------------------------------------------ B joins by approval */
  check('B signs in to the same account', (await B.svc.setUrl(URL)).ok && (await B.svc.signIn({ email: EMAIL, password: PASSWORD, label: 'Windows PC' })).ok, true)
  check('and is locked: signed in, not in the vault', B.svc.view().phase, 'locked')
  check('B asks to join', (await B.svc.joinStart()).ok, true)
  await A.svc.syncNow()
  const req = A.svc.view().pairs[0]
  check('A lists the request, naming the device', [req?.device.label, req?.state], ['Windows PC', 'waiting'])
  check('A answers it', (await A.svc.approveStart(req.pair)).ok, true)
  await until('both screens show a code', () => !!B.svc.view().join?.code && !!A.svc.view().pairs[0]?.code)
  const codeA = A.svc.view().pairs[0]?.code
  const codeB = B.svc.view().join?.code
  ok(`both screens show the same six digits (${codeA})`, !!codeA && codeA === codeB && /^\d{3} \d{3}$/.test(codeA))
  check('A confirms the match and adds B', (await A.svc.approveConfirm(req.pair)).ok, true)
  await until('B takes the vault key and syncs', () => B.svc.view().phase === 'active' && B.svc.view().lastSyncAt !== null)
  check('B is in the vault with A', B.svc.view().devices.map((d) => d.label).sort(), ['Mac', 'Windows PC'])
  check('B took the account’s settings on joining (the hub’s copy wins the first meeting)', [B.settings().themeId, B.settings().fontSize], ['moss', 15])
  check('B received the API key, usable in its settings', B.settings().providers.anthropicApiKey, CANARY_KEY)
  ok('and never A’s phone key', B.settings().remote.token !== 'PHONE-KEY-A')
  const bHosts = B.settings().hosts as { alias: string; syncId?: string; label: string }[]
  const aNuc = (A.settings().hosts[0] as { syncId?: string }).syncId
  check('B’s own NUC adopted A’s sync id (same alias and command), its VPS kept and given its own', [bHosts.find((h) => h.alias === 'nuc')?.syncId === aNuc, bHosts.length, /^h/.test(bHosts.find((h) => h.alias === 'vps')?.syncId ?? '')], [true, 2, true])
  await A.svc.syncNow()
  check('A gets B’s VPS', (A.settings().hosts as { alias: string }[]).map((h) => h.alias).sort(), ['nuc', 'vps'])

  /* ------------------------------------------ an SSH key, opt-in */
  const key = syntheticKey('nuc-key', 'none')
  writeFileSync(join(A.ssh.dir, 'nuc_ed25519'), key.priv, { mode: 0o600 })
  writeFileSync(join(A.ssh.dir, 'nuc_ed25519.pub'), `${key.pub}\n`)
  writeFileSync(A.ssh.config, `Host nuc\n  IdentityFile ${join(A.ssh.dir, 'nuc_ed25519')}\n`)
  secretsSeen.push(key.priv.split('\n')[1])
  const offered = await A.svc.localKeys()
  check('A’s picker lists its key pair, unshared', offered.map((k) => [k.name, k.shared]), [['nuc_ed25519', null]])
  const shared = await A.svc.shareKey('nuc_ed25519')
  check('A shares it', shared.ok, true)
  check('and the host whose ssh -G offers it is marked as using it', A.svc.view().sshKeys.map((k) => [k.name, k.hosts]), [['nuc_ed25519', ['NUC']]])
  await B.svc.syncNow()
  const onB = B.svc.view().sshKeys
  check('B sees the key offered, not installed: nothing is written until Install', [onB.map((k) => [k.name, k.mine, k.installedAs]), existsSync(join(B.ssh.dir, 'nuc_ed25519'))], [[['nuc_ed25519', false, null]], false])
  const inst = await B.svc.installKey(onB[0].keyId)
  check('Install writes it and says so', [inst.ok, inst.ok && inst.name], [true, 'nuc_ed25519'])
  ok(`the result line names the file and the host (${inst.ok ? inst.message : ''})`, inst.ok && /nuc_ed25519/.test(inst.message) && /nuc will offer it/.test(inst.message))
  check('B now holds the same key', readFileSync(join(B.ssh.dir, 'nuc_ed25519'), 'utf8'), key.priv)
  if (!WIN) check('0600 in B’s ssh folder', statSync(join(B.ssh.dir, 'nuc_ed25519')).mode & 0o777, 0o600)
  ok('with an IdentityFile for nuc in B’s config', /Host nuc\n\s+IdentityFile "[^"]*nuc_ed25519"/.test(readFileSync(B.ssh.config, 'utf8')))

  /* ------------------------------------------ a conflict */
  A.set({ themeId: 'lagoon' })
  await new Promise((r) => setTimeout(r, 1200))
  B.set({ themeId: 'rose' })
  await new Promise((r) => setTimeout(r, 1200))
  await A.svc.syncNow()
  await B.svc.syncNow()
  const note = B.svc.view().notes.find((n) => n.path === 't1/settings/themeId')
  check('two devices changed the theme: the later edit (B’s) wins, and B notes it in words', [B.settings().themeId, note?.kept, note?.otherDevice, note?.label], ['rose', 'mine', 'Mac', 'Theme'])
  await A.svc.syncNow()
  check('A converges on it', A.settings().themeId, 'rose')

  /* ------------------------------------------ a third device, by the Recovery Kit */
  const C = device('linux', { themeId: 'ember' } as Partial<Settings>)
  await C.svc.start()
  await C.svc.setUrl(URL)
  await C.svc.signIn({ email: EMAIL, password: PASSWORD, label: 'Laptop' })
  check('a Kit with a typo is caught before any crypto', (await C.svc.recover(made.kit.slice(0, -1) + (made.kit.endsWith('0') ? '1' : '0'))).ok, false)
  check('the right Kit joins C with no other device involved', (await C.svc.recover(made.kit)).ok, true)
  await until('C syncs', () => C.svc.view().lastSyncAt !== null)
  check('C has the account’s settings and key', [C.settings().themeId, C.settings().providers.anthropicApiKey], ['rose', CANARY_KEY])
  await A.svc.syncNow()
  check('the device list is three', A.svc.view().devices.length, 3)

  /* ------------------------------------------ rename, revoke */
  check('A renames C', (await A.svc.renameDevice(C.svc.view().device!.id, 'Old laptop')).ok, true)
  await B.svc.syncNow()
  check('and B shows the new name', B.svc.view().devices.find((d) => d.id === C.svc.view().device!.id)?.label, 'Old laptop')
  const bId = B.svc.view().device!.id
  const epochBefore = A.svc.view().epoch
  check('removing a device needs the Kit (a wrong one is refused)', (await A.svc.revokeDevice(bId, { kit: 'RK1-0000-0000-0000-0000-0000-0000-000' })).ok, false)
  const revoked = await A.svc.revokeDevice(bId, { kit: made.kit })
  check('A removes B with the Kit: a new epoch', [revoked.ok, A.svc.view().epoch], [true, epochBefore + 1])
  check('and lists what B could have read, to rotate by hand', [A.svc.view().revokeReport?.keys, A.svc.view().revokeReport?.sshKeys], [['Anthropic API key'], ['nuc_ed25519']])
  A.set({ providers: { ...A.settings().providers, openrouterApiKey: CANARY_KEY_2 } })
  await A.svc.syncNow()
  const bSync = await B.svc.syncNow()
  check('B can no longer sync: its session died with the revoke', [bSync.ok, B.svc.view().phase], [false, 'signed-out'])
  const bBack = await B.svc.signIn({ email: EMAIL, password: PASSWORD })
  check('nor sign back in as the same device', [bBack.ok, B.svc.view().phase], [false, 'revoked'])
  ok('B never got the key A added after', B.settings().providers.openrouterApiKey !== CANARY_KEY_2)
  await C.svc.syncNow()
  check('C, still in, follows the new epoch and gets it', [C.svc.view().epoch, C.settings().providers.openrouterApiKey], [epochBefore + 1, CANARY_KEY_2])
  // What B holds can not open what A wrote after: B's own sealed vault keys, opened with B's key store.
  const bState = JSON.parse(readFileSync(join(B.userData, 'hub-state.json'), 'utf8'))
  const bFiles = new HubFiles(B.userData, fakeBackend('win'), 'darwin')
  const bEpochs = Object.keys(bState.vaultKeys).map(Number)
  check('B holds no vault key for the new epoch', bEpochs.includes(epochBefore + 1), false)
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(hubDir, 'hub.db'), { readOnly: true })
  const rows = db.prepare('SELECT envelope_json FROM items').all() as { envelope_json: string }[]
  const newest = rows.map((r) => JSON.parse(r.envelope_json)).filter((e) => e.epoch === epochBefore + 1)
  const opensWithOld = newest.some((env) => bEpochs.some((e) => {
    const vk = bFiles.openVault(bState.account, e, bState.vaultKeys[String(e)])
    return vk ? openItem(itemKeys(vk, bState.account, e), env).ok : false
  }))
  check(`every item is now sealed under the new epoch (${newest.length} of ${rows.length}), and none opens with B’s keys`, [newest.length === rows.length, opensWithOld], [true, false])
  const wraps = db.prepare('SELECT device_id FROM wraps WHERE epoch = ?').all(epochBefore + 1) as { device_id: string }[]
  check('the hub holds no wrap of the new key for B', wraps.some((w) => w.device_id === bId), false)
  db.close()

  /* ------------------------------------------ a lost Kit: remove with a NEW one */
  const cId = C.svc.view().device!.id
  const epochNow = A.svc.view().epoch
  const fresh = await A.svc.revokeDevice(cId, { newKit: true })
  check('removing a device with no Kit to hand makes a new Kit first, posting nothing yet', [fresh.ok, A.svc.view().kitPending, A.svc.view().epoch], [true, true, epochNow])
  const freshKit = (fresh as { ok: true; kit: string; group: number }).kit
  secretsSeen.push(freshKit)
  check('the new Kit is not the old one', freshKit !== made.kit, true)
  check('confirming it removes C and replaces the Kit in one append (revoke, then rotate)', (await A.svc.confirmKit(freshKit.split('-')[(fresh as { group: number }).group])).ok, true)
  check('two epochs on, one device left', [A.svc.view().epoch, A.svc.view().devices.map((d) => d.label)], [epochNow + 2, ['Mac']])
  const D = device('spare', {} as Partial<Settings>)
  await D.svc.start()
  await D.svc.setUrl(URL)
  await D.svc.signIn({ email: EMAIL, password: PASSWORD, label: 'Spare' })
  const oldKit = await D.svc.recover(made.kit)
  check('the old Kit no longer opens the vault', [oldKit.ok, !oldKit.ok && /not this account’s current one/.test(oldKit.message)], [false, true])
  check('the new one does', (await D.svc.recover(freshKit)).ok, true)
  await until('D syncs', () => D.svc.view().lastSyncAt !== null)
  check('and D reads everything, re-sealed under the newest key', [D.svc.view().epoch, D.settings().providers.openrouterApiKey], [epochNow + 2, CANARY_KEY_2])
  D.svc.stop()

  /* ------------------------------------------ what the hub can see */
  const files = readdirSync(hubDir).filter((f) => f.startsWith('hub.db'))
  const bytes = Buffer.concat(files.map((f) => readFileSync(join(hubDir, f))))
  const leaked = secretsSeen.filter((s) => bytes.includes(Buffer.from(s)))
  check(`the hub’s database (${files.join(', ')}) holds none of the API keys, the SSH key, the Kit or the password`, leaked, [])
  ok('nor any item path (the hub sees opaque ids)', !bytes.includes(Buffer.from('providers.anthropicApiKey')) && !bytes.includes(Buffer.from('t4/ssh-key')))

  /* ------------------------------------------ sign out */
  check('C signs out', (await C.svc.signOut()).ok, true)
  check('and its hub files are gone; what it synced stays', [existsSync(join(C.userData, 'hub-device.json')), existsSync(join(C.userData, 'hub-state.json')), C.settings().providers.anthropicApiKey, C.svc.view().phase], [false, false, CANARY_KEY, 'signed-out'])
  for (const d of [A, B, C]) d.svc.stop()
} finally {
  await hub.close()
  rmSync(TMP, { recursive: true, force: true })
}

console.log(failures ? `\n${failures} failed` : '\nall pass')
process.exitCode = failures ? 1 : 0
