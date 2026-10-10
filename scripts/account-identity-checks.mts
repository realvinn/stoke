import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountIdentities, planAccountIdentity, probeAccountIdentity, type AccountIdentitySpawn } from '../src/main/accountIdentity.ts'
import { accountIdentityTarget, identityFor, nativeAccountIdentity, type AccountIdentityTarget } from '../src/shared/accountIdentity.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'

export async function runAccountIdentityChecks(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'stoke-account-identity-'))
  const fixture = join(root, 'native-status.cjs')
  const record = join(root, 'requests.jsonl')
  const pass = (name: string) => console.log(`  PASS ${name}`)
  try {
    const settings = hydrateSettings({ accounts: {
      'claude-work': { id: 'claude-work', cli: 'claude', label: 'Work', kind: 'login', home: join(root, 'claude-work'), apiKey: '' },
      'codex-work': { id: 'codex-work', cli: 'codex', label: 'Codex work', kind: 'login', home: join(root, 'codex-work'), apiKey: '' },
      'grok-key': { id: 'grok-key', cli: 'grok', label: 'Grok key', kind: 'key', home: '', apiKey: 'fixture credential' }
    } })
    const target: AccountIdentityTarget = { cli: 'claude', accountId: 'claude-work', ptyId: 'owned-fixture-session' }
    assert.equal(accountIdentityTarget({ cli: 'codex', accountId: 'default', home: '/untrusted' })?.accountId, 'default')
    assert.equal(accountIdentityTarget({ cli: 'codex', accountId: '../credential-store' }), null)
    assert.equal(accountIdentityTarget({ cli: 'codex', accountId: 'default', ptyId: 7 }), null)
    pass('identity requests contain validated agent/account/PTY ids, never renderer-supplied paths')
    const captured = planAccountIdentity(target, settings, { CLAUDE_CONFIG_DIR: join(root, 'default-claude') }, root)
    assert.equal(captured.env.CLAUDE_CONFIG_DIR, join(root, 'claude-work'))
    assert.equal(captured.native, 'claude')
    const codex = planAccountIdentity({ cli: 'codex', accountId: 'codex-work' }, settings, { CODEX_HOME: join(root, 'default-codex') }, root)
    assert.equal(codex.env.CODEX_HOME, join(root, 'codex-work'))
    assert.equal(planAccountIdentity({ cli: 'codex', accountId: 'claude-work' }, settings, {}, root).native, null)
    assert.equal(planAccountIdentity({ cli: 'grok', accountId: 'grok-key' }, settings, {}, root).fallback.method, 'API key')
    assert.equal(planAccountIdentity({ cli: 'cursor', accountId: 'default' }, settings, {}, root).fallback.state, 'unavailable')
    assert.equal(planAccountIdentity({ cli: 'claude', accountId: 'default' }, settings, { ANTHROPIC_AUTH_TOKEN: 'external fixture' }, root).native, null)
    pass('account homes and authentication overrides are isolated; unsupported identities are explicit')
    const identity = nativeAccountIdentity('claude', { loggedIn: true, email: 'work@example.test', orgName: 'Work org', accessToken: 'never expose this fixture' })
    assert.equal(identity.email, 'work@example.test')
    assert(!JSON.stringify(identity).includes('never expose'))
    assert.equal(nativeAccountIdentity('claude', { loggedIn: false, email: 'old@example.test' }).email, null)
    assert.equal(nativeAccountIdentity('codex', { account: { type: 'chatgpt', email: 'codex@example.test', planType: 'pro', token: 'not public' } }).email, 'codex@example.test')
    assert.equal(nativeAccountIdentity('codex', { account: null, requiresOpenaiAuth: false }).state, 'unavailable')
    assert.equal(nativeAccountIdentity('codex', { account: null, requiresOpenaiAuth: true }).state, 'signed-out')
    assert.equal(nativeAccountIdentity('claude', { loggedIn: true, email: 'fake@example.test\nforged' }).email, null)
    pass('only public identity fields survive; stale emails and control characters are refused')
    const service = new AccountIdentities()
    service.capture(captured)
    let release: (v: unknown) => void = () => {}
    let calls = 0
    const reply = new Promise(resolve => { release = resolve })
    const configured = planAccountIdentity(target, hydrateSettings({}), {}, root)
    const one = service.read(target, configured, async plan => { calls++; assert.equal(plan.env.CLAUDE_CONFIG_DIR, captured.env.CLAUDE_CONFIG_DIR); return reply }, 1_000)
    const two = service.read(target, configured, async () => { throw new Error('duplicate native read') }, 1_000)
    // Give the owned slot's continuation a chance to enter the native reader.
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(calls, 1)
    release({ loggedIn: true, email: 'work@example.test' })
    const values = await Promise.all([one, two])
    assert.equal(values[0].email, 'work@example.test')
    assert.deepEqual(values[0], values[1])
    assert.equal(identityFor({ ...target, accountId: 'default' }, values[0]), null)
    assert.equal(identityFor({ ...target, ptyId: 'replacement-pty' }, values[0]), null)
    assert.equal((await service.read({ ...target, accountId: 'default' }, configured, async () => { throw new Error('wrong account read') })).state, 'unavailable')
    service.drop(target.ptyId!)
    assert.equal((await service.read(target, configured, async () => { throw new Error('ended PTY read') })).state, 'unavailable')
    pass('a live session keeps its launch account through settings changes; duplicate and late replies cannot select another account')
    service.capture(captured)
    let finishLate: (v: unknown) => void = () => {}
    const late = service.read(target, configured, () => new Promise(resolve => { finishLate = resolve }), 50_000)
    await new Promise(resolve => setImmediate(resolve))
    service.drop(target.ptyId!)
    finishLate({ loggedIn: true, email: 'late@example.test' })
    assert.equal((await late).email, null)
    pass('ending a PTY while its identity is being read discards the late native identity')
    const refreshService = new AccountIdentities()
    const defaultTarget: AccountIdentityTarget = { cli: 'claude', accountId: 'default' }
    const defaultPlan = planAccountIdentity(defaultTarget, settings, {}, root)
    let refreshCalls = 0
    const fresh = async () => ({ loggedIn: true, email: `account-${++refreshCalls}@example.test` })
    const first = await refreshService.read(defaultTarget, defaultPlan, fresh, 1_000)
    assert.equal((await refreshService.read(defaultTarget, defaultPlan, fresh, 5_000)).email, first.email)
    assert.equal((await refreshService.read(defaultTarget, defaultPlan, fresh, 5_000, true)).email, 'account-2@example.test')
    assert.equal((await refreshService.read(defaultTarget, defaultPlan, fresh, 5_500, true)).email, 'account-2@example.test')
    assert.equal(refreshCalls, 2)
    refreshService.invalidate()
    assert.equal((await refreshService.read(defaultTarget, defaultPlan, fresh, 6_000)).email, 'account-3@example.test')
    pass('manual Refresh bypasses a settled cache while rapid clicks coalesce, and completed sign-ins invalidate saved readings')
    const bounded = new AccountIdentities()
    const releases: Array<(value: unknown) => void> = []
    const signals: AbortSignal[] = []
    let queueCalls = 0
    const queued = Array.from({ length: 3 }, (_, i) => {
      const target = { ...defaultTarget, ptyId: `queued-${i}` }
      const plan = planAccountIdentity(target, settings, {}, root)
      bounded.capture(plan)
      return bounded.read(target, plan, (_plan, signal) => { queueCalls++; signals.push(signal); return new Promise(resolve => releases.push(resolve)) })
    })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(queueCalls, 2)
    bounded.clear()
    assert(signals.every(signal => signal.aborted))
    releases.forEach(release => release({ loggedIn: true, email: 'cancelled@example.test' }))
    assert((await Promise.all(queued)).every(identity => identity.email === null))
    assert.equal(queueCalls, 2)
    assert.equal((await bounded.read(defaultTarget, defaultPlan, fresh)).email, 'account-4@example.test')
    pass('native reads hold two owned slots; clearing sessions refuses queued work and late identities, then releases the slots')
    await writeFile(fixture, `
const fs = require('node:fs'); const readline = require('node:readline');
const mode = process.env.STOKE_IDENTITY_FIXTURE_MODE;
const record = (v) => fs.appendFileSync(process.env.STOKE_IDENTITY_FIXTURE_RECORD, JSON.stringify(v)+'\\n');
record({argv:process.argv.slice(2),home:process.env.CODEX_HOME||process.env.CLAUDE_CONFIG_DIR,pid:process.pid});
if (mode==='hang') { process.on('SIGTERM',()=>record({kind:'ignored-term'})); record({kind:'ready-hang',pid:process.pid}); process.stdout.write(JSON.stringify({loggedIn:true,email:'expired@example.test'})); setInterval(()=>{},1000); }
else if (mode==='oversized') { process.stdout.write('x'.repeat(150000)); setInterval(()=>{},1000); }
else if (mode==='claude') { const b=Buffer.from(JSON.stringify({loggedIn:true,email:'équipe@example.test',subscriptionType:'team'})); const cut=b.indexOf(0xc3)+1; process.stdout.write(b.subarray(0,cut)); setTimeout(()=>process.stdout.write(b.subarray(cut)),10); }
else { if(mode==='late') { process.on('SIGTERM',()=>{});setInterval(()=>{},1000); } const rl=readline.createInterface({input:process.stdin}); rl.on('line',line=>{const r=JSON.parse(line);record(r);if(r.method==='initialize')process.stdout.write(JSON.stringify({id:r.id,result:{userAgent:'fixture'}})+'\\n');else if(r.method==='account/read') { const reply=()=>{record({kind:'late-reply',pid:process.pid});process.stdout.write(JSON.stringify({id:r.id,result:{account:{type:'chatgpt',email:'codex@example.test',planType:'pro'}}})+'\\n');};if(mode==='late'){record({kind:'late-read',pid:process.pid});setTimeout(reply,150);}else reply(); }}); }
`, { mode: 0o600 })
    const spawned: number[] = []
    const run: AccountIdentitySpawn = (_file, args, options) => {
      const child = spawn(process.execPath, [fixture, ...args], options)
      if (child.pid) spawned.push(child.pid)
      return child
    }
    const env = { ...Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)), STOKE_IDENTITY_FIXTURE_RECORD: record, CODEX_HOME: join(root, 'codex-work') }
    const raw = await probeAccountIdentity(codex, 'fixture-only', { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'codex' }, 2_000, run)
    assert.equal(nativeAccountIdentity('codex', raw).email, 'codex@example.test')
    const records = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.deepEqual(records.filter(v => v.method).map(v => v.method), ['initialize', 'initialized', 'account/read'])
    assert.equal(records.find(v => v.method === 'account/read').params.refreshToken, false)
    assert.deepEqual(records[0].argv, ['app-server', '--listen', 'stdio://'])
    assert.equal(records[0].home, join(root, 'codex-work'))
    const cancel = new AbortController()
    const cancelled = probeAccountIdentity(codex, 'fixture-only', { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'late' }, 2_000, run, cancel.signal)
    const lateDeadline = Date.now() + 1_500
    while (!(await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).some(v => v.kind === 'late-read' && v.pid === spawned.at(-1))) {
      assert(Date.now() < lateDeadline, 'the delayed Codex read starts')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    cancel.abort()
    assert.equal(await cancelled, null)
    assert((await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).some(v => v.kind === 'late-reply' && v.pid === spawned.at(-1)), 'a reply really arrives after cancellation')
    pass('a native Codex reply received after cancellation cannot restore a discarded identity')
    assert.equal(nativeAccountIdentity('claude', await probeAccountIdentity(captured, 'fixture-only', { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'claude' }, 2_000, run)).email, 'équipe@example.test')
    pass('real owned children prove the Codex handshake and read-only request, exact account home, and split UTF-8 Claude identity')
    assert.equal(await probeAccountIdentity(captured, 'fixture-only', { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'hang' }, 1_000, run), null)
    if (process.platform !== 'win32') assert((await readFile(record, 'utf8')).includes('ignored-term'), 'the timeout actually reaches a child that ignores SIGTERM')
    assert.equal(await probeAccountIdentity(codex, 'fixture-only', { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'oversized' }, 2_000, run), null)
    const stopping = new AccountIdentities()
    const reading = stopping.read(defaultTarget, defaultPlan, (plan, signal) => probeAccountIdentity(plan, 'fixture-only', { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'hang' }, 5_000, run, signal))
    const startupDeadline = Date.now() + 2_000
    while (true) {
      const lines = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      if (spawned.at(-1) && lines.some(line => line.kind === 'ready-hang' && line.pid === spawned.at(-1))) break
      assert(Date.now() < startupDeadline, 'the owned child starts before shutdown')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    assert.equal(await stopping.shutdown(), 0, 'shutdown retains ownership until native close')
    assert.equal((await reading).email, null)
    for (const pid of spawned) {
      let alive = true
      try { process.kill(pid, 0) } catch { alive = false }
      assert.equal(alive, false, `owned fixture process ${pid} has exited`)
    }
    pass('timeouts, output limits and shutdown reject partial identities and reap every owned child, including a child that ignores SIGTERM')
  } finally { await rm(root, { recursive: true, force: true }) }
}
