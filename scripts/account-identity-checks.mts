import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AccountIdentities, planAccountIdentity, probeAccountIdentity, type AccountIdentitySpawn } from '../src/main/accountIdentity.ts'
import { accountIdentityTarget, accountLoginOutcome, identityFor, nativeAccountIdentity, type AccountIdentityTarget } from '../src/shared/accountIdentity.ts'
import { hydrateSettings } from '../src/main/settingsSchema.ts'
import { ACCOUNT_IDENTITY_CLEANUP_TIMEOUT_MS, stopWindowsAccountIdentity, WINDOWS_IDENTITY_CLEANUP_SCRIPT, WINDOWS_IDENTITY_DEPTH_SORT, type WindowsIdentityCleanupOptions } from '../src/main/accountIdentityWindows.ts'
import { windowsProcessTableSpec } from '../src/main/windowsProcessTable.ts'

export async function runAccountIdentityChecks(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'stoke-account-identity-'))
  const fixture = join(root, 'native-status.cjs')
  const record = join(root, 'requests.jsonl')
  const pass = (name: string) => console.log(`  PASS ${name}`)
  const fixtureChildren: ReturnType<typeof spawn>[] = []
  try {
    assert(!/[^\x00-\x7f]/.test(WINDOWS_IDENTITY_CLEANUP_SCRIPT), 'Windows PowerShell 5.1 receives a fixed ASCII cleanup script')
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
    const loginTarget = { cli: 'codex' as const, accountId: 'codex-work' }
    const loginIdentity = { target: loginTarget, label: 'Work', ...nativeAccountIdentity('codex', { account: { type: 'chatgpt', email: 'work@example.test' } }), checkedAt: 1 }
    assert.equal(accountLoginOutcome(loginTarget, 0, undefined, loginIdentity), 'success')
    assert.equal(accountLoginOutcome(loginTarget, 1, undefined, loginIdentity), 'failed')
    assert.equal(accountLoginOutcome(loginTarget, 0, 15, loginIdentity), 'failed')
    assert.equal(accountLoginOutcome(loginTarget, 0, undefined, { ...loginIdentity, target: { ...loginTarget, accountId: 'default' } }), 'unverified')
    assert.equal(accountLoginOutcome(loginTarget, 0, undefined, { ...loginIdentity, target: { ...loginTarget, ptyId: 'another-pty' } }), 'unverified')
    assert.equal(accountLoginOutcome(loginTarget, 0, undefined, null), 'unverified')
    assert.equal(accountLoginOutcome(loginTarget, 0, undefined, { ...loginIdentity, state: 'signed-out' }), 'failed')
    pass('login completion verifies the intended account and never promotes a cancelled, failed or unknown attempt using an old saved identity')
    const captured = planAccountIdentity(target, settings, { CLAUDE_CONFIG_DIR: join(root, 'default-claude') }, root)
    assert.equal(captured.env.CLAUDE_CONFIG_DIR, join(root, 'claude-work'))
    assert.equal(captured.native, 'claude')
    const inheritedApi = { ANTHROPIC_API_KEY: 'fixture-key', ANTHROPIC_AUTH_TOKEN: 'fixture-gateway', ANTHROPIC_BASE_URL: 'https://gateway.example.test', CLAUDE_CODE_OAUTH_TOKEN: 'fixture-other-login', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_SECURESTORAGE_CONFIG_DIR: join(root, 'other-login') }
    const isolated = planAccountIdentity(target, settings, inheritedApi, root)
    assert.equal(isolated.native, 'claude', 'a selected login account must identify its own saved sign-in despite inherited API authentication')
    assert.equal(isolated.env.CLAUDE_CONFIG_DIR, join(root, 'claude-work'))
    for (const name of Object.keys(inheritedApi)) assert.equal(isolated.env[name], undefined, `${name} must not select another account`)
    assert.deepEqual(inheritedApi.ANTHROPIC_API_KEY, 'fixture-key')
    pass('a named Claude login reads its own identity without inherited API, gateway, OAuth or Keychain overrides')
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
record({argv:process.argv.slice(2),home:process.env.CODEX_HOME||process.env.CLAUDE_CONFIG_DIR,pid:process.pid,parent:process.ppid});
if (mode==='tree-leaf') { record({kind:'ready-leaf',pid:process.pid,parent:process.ppid}); setInterval(()=>{},1000); }
else if (mode==='tree-exiting-leaf') { record({kind:'ready-exiting-leaf',pid:process.pid,parent:process.ppid}); const poll=setInterval(()=>{if(fs.existsSync(process.env.STOKE_IDENTITY_CAPTURE_MARKER)){clearInterval(poll);record({kind:'exiting-leaf',pid:process.pid,parent:process.ppid});process.exit(0);}},10); }
else if (mode==='tree-exiting-sibling') { const child=require('node:child_process').spawn(process.execPath,[__filename],{env:{...process.env,STOKE_IDENTITY_FIXTURE_MODE:'tree-exiting-leaf'},stdio:['ignore','inherit','inherit']}); child.once('close',()=>{record({kind:'closed-exiting-leaf',pid:process.pid,childPid:child.pid});require('node:child_process').spawn(process.execPath,[__filename],{env:{...process.env,STOKE_IDENTITY_FIXTURE_MODE:'tree-leaf'},stdio:['ignore','inherit','inherit']});});record({kind:'ready-tree',pid:process.pid,parent:process.ppid});setInterval(()=>{},1000); }
else if (mode==='tree'||mode==='tree-delayed'||mode==='tree-vendor-console') { const start=()=>require('node:child_process').spawn(mode==='tree-vendor-console'?process.env.STOKE_IDENTITY_VENDOR_RUNTIME:process.execPath,[__filename],{env:{...process.env,STOKE_IDENTITY_FIXTURE_MODE:'tree-leaf'},stdio:['ignore','inherit','inherit']}); if(mode==='tree-delayed')setTimeout(start,700);else start(); record({kind:'ready-tree',pid:process.pid,parent:process.ppid}); setInterval(()=>{},1000); }
else if (mode==='hang') { process.on('SIGTERM',()=>record({kind:'ignored-term'})); record({kind:'ready-hang',pid:process.pid}); process.stdout.write(JSON.stringify({loggedIn:true,email:'expired@example.test'})); setInterval(()=>{},1000); }
else if (mode==='oversized') { process.stdout.write('x'.repeat(150000)); setInterval(()=>{},1000); }
else if (mode==='claude') { const b=Buffer.from(JSON.stringify({loggedIn:true,email:'équipe@example.test',subscriptionType:'team'})); const cut=b.indexOf(0xc3)+1; process.stdout.write(b.subarray(0,cut)); setTimeout(()=>process.stdout.write(b.subarray(cut)),10); }
else { if(mode==='late') { process.on('SIGTERM',()=>{});setInterval(()=>{},1000); } const rl=readline.createInterface({input:process.stdin}); rl.on('line',line=>{const r=JSON.parse(line);record(r);if(r.method==='initialize')process.stdout.write(JSON.stringify({id:r.id,result:{userAgent:'fixture'}})+'\\n');else if(r.method==='account/read') { const reply=()=>{record({kind:'late-reply',pid:process.pid});process.stdout.write(JSON.stringify({id:r.id,result:{account:{type:'chatgpt',email:'codex@example.test',planType:'pro'}}})+'\\n');};if(mode==='late'){record({kind:'late-read',pid:process.pid});setTimeout(reply,150);}else reply(); }}); }
`, { mode: 0o600 })
    const spawned: number[] = []
    const run: AccountIdentitySpawn = (_file, args, options) => {
      const child = spawn(process.execPath, [fixture, ...args], options)
      fixtureChildren.push(child)
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
    if (process.platform !== 'win32') assert((await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).some(v => v.kind === 'late-reply' && v.pid === spawned.at(-1)), 'a reply really arrives after cancellation')
    pass('a native Codex reply received after cancellation cannot restore a discarded identity')
    assert.equal(nativeAccountIdentity('claude', await probeAccountIdentity(captured, 'fixture-only', { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'claude' }, 2_000, run)).email, 'équipe@example.test')
    pass('real owned children prove the Codex handshake and read-only request, exact account home, and split UTF-8 Claude identity')
    assert.equal(await probeAccountIdentity(captured, 'fixture-only', { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'hang' }, 1_000, run), null)
    if (process.platform !== 'win32') assert((await readFile(record, 'utf8')).includes('ignored-term'), 'the timeout actually reaches a child that ignores SIGTERM')
    assert.equal(await probeAccountIdentity(codex, 'fixture-only', { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'oversized' }, 2_000, run), null)
    const stopping = new AccountIdentities()
    const reading = stopping.read(defaultTarget, defaultPlan, (plan, signal) => probeAccountIdentity(plan, 'fixture-only', { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'hang' }, 5_000, run, signal))
    const startupDeadline = Date.now() + 5_000
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
    if (process.platform === 'win32') {
      const [powershell] = windowsProcessTableSpec()
      const sorted = await new Promise<string>((resolve, reject) => execFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', `$items = @(@{Id=2;Depth=2}, @{Id=0;Depth=0}, @{Id=1;Depth=1}); $ordered = @($items | ${WINDOWS_IDENTITY_DEPTH_SORT}); [Console]::Write(($ordered | ForEach-Object { $_['Id'] }) -join ',')`], { timeout: ACCOUNT_IDENTITY_CLEANUP_TIMEOUT_MS, maxBuffer: 4096, windowsHide: true }, (error, stdout) => error ? reject(error) : resolve(String(stdout))))
      assert.equal(sorted, '0,1,2', 'the actual Windows PowerShell helper sorts Hashtable keys with an explicit parent-first calculation')
      pass('native Windows PowerShell orders held Hashtable processes parent before child, including PowerShell 5.1')
      const launcher = join(root, 'native-status.cmd')
      const vendorRuntime = join(root, 'conhost.exe')
      await copyFile(process.execPath, vendorRuntime)
      await writeFile(launcher, `@echo off\r\n"${process.execPath}" "${fixture}" %*\r\n`)
      const bystander = spawn(process.execPath, [fixture], { env: { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'tree-leaf' }, stdio: 'ignore', windowsHide: true })
      fixtureChildren.push(bystander)
      const nativeSpawn: AccountIdentitySpawn = (file, args, options) => {
        const child = spawn(file, args, options)
        fixtureChildren.push(child)
        return child
      }
      try {
        const readyDeadline = Date.now() + 5_000
        while (!(await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).some(event => event.kind === 'ready-leaf' && event.pid === bystander.pid)) {
          assert(Date.now() < readyDeadline, 'the sibling bystander starts before its PID is excluded from the owned fixture')
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        assert.deepEqual(await stopWindowsAccountIdentity(bystander.pid!, 1, 2), { cleaned: false, failed: true }, 'a PID outside the exact owned spawn interval is refused')
        process.kill(bystander.pid!, 0)
        let refusals = 0
        assert.deepEqual(await stopWindowsAccountIdentity(bystander.pid!, 1, 2, { ownsRoot: () => { refusals++; return false } }), { cleaned: false, failed: true }, 'a pinned PID without the private owned-process acknowledgement is refused')
        assert.equal(refusals, 1, 'the helper really pins the PID and requests main’s ownership acknowledgement')
        process.kill(bystander.pid!, 0)
        const bound = spawn(process.execPath, [fixture], { env: { ...env, STOKE_IDENTITY_FIXTURE_MODE: 'tree-leaf' }, stdio: 'ignore', windowsHide: true })
        fixtureChildren.push(bound)
        const boundClosed = new Promise<void>(resolve => bound.once('close', () => resolve()))
        const boundPid = bound.pid!
        assert.deepEqual(await stopWindowsAccountIdentity(boundPid, 1, 2, { ownsRoot: () => bound.pid === boundPid && bound.exitCode === null && bound.signalCode === null }), { cleaned: true, failed: false }, 'main’s exact live process handle binds the owned root despite deliberately mismatched JavaScript timestamps')
        await boundClosed
        pass('native root binding uses a private pinned-handle acknowledgement; refused acknowledgements preserve the bystander and clock offsets cannot select another PID')
        for (const variant of ['normal', 'delayed-descendant', 'exited-child-late-sibling', 'vendor-console-basename', 'helper-spawn-failure', 'helper-timeout', 'helper-timeout-after-ownership']) {
          const previous = new Set((await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line).pid))
          const stopping = new AccountIdentities()
          const cancel = new AbortController()
          const captureMarker = join(root, 'capture-paused')
          const captureReports: Array<{ phase: 'capture' | 'capture-paused'; captured: number; jobs: number }> = []
          const options: WindowsIdentityCleanupOptions = variant === 'helper-spawn-failure' ? { powershell: join(root, 'missing-powershell.exe') } : variant === 'helper-timeout' ? { timeoutMs: 1 } : variant === 'helper-timeout-after-ownership' ? { pauseAfterOwnershipMs: 3000, timeoutAfterOwnershipMs: 25 } : variant === 'delayed-descendant' ? { captureDelayMs: 1500 } : variant === 'exited-child-late-sibling' ? { captureDelayMs: 2000, onCapture: report => { captureReports.push(report); if (report.phase === 'capture-paused') writeFileSync(captureMarker, '') } } : {}
          const reading = probeAccountIdentity(codex, launcher, { ...env, STOKE_IDENTITY_CAPTURE_MARKER: captureMarker, STOKE_IDENTITY_VENDOR_RUNTIME: vendorRuntime, STOKE_IDENTITY_FIXTURE_MODE: variant === 'delayed-descendant' ? 'tree-delayed' : variant === 'exited-child-late-sibling' ? 'tree-exiting-sibling' : variant === 'vendor-console-basename' ? 'tree-vendor-console' : 'tree' }, 10_000, nativeSpawn, cancel.signal, options)
          const deadline = Date.now() + 5_000
          while (true) {
            const events = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(event => !previous.has(event.pid))
            if (events.some(event => event.kind === 'ready-tree') && (variant === 'delayed-descendant' || events.some(event => event.kind === (variant === 'exited-child-late-sibling' ? 'ready-exiting-leaf' : 'ready-leaf')))) break
            assert(Date.now() < deadline, 'the actual .cmd launcher starts its native child before shutdown')
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          const shellPid = fixtureChildren.at(-1)!.pid!
          const warnings: unknown[][] = []
          const originalWarn = console.warn
          console.warn = (...values: unknown[]) => { warnings.push(values); originalWarn(...values) }
          try {
            cancel.abort()
            if (variant.startsWith('helper-')) {
              assert.equal(await reading, null, 'a failed or timed-out cleanup helper settles the public identity result')
              if (variant === 'helper-timeout-after-ownership') {
                assert(warnings.some(values => (values[1] as { killed?: boolean; jobOwned?: boolean })?.killed && (values[1] as { jobOwned?: boolean })?.jobOwned), 'the real helper is killed after the full tree is assigned to its kill-on-close job')
              } else {
                assert(stopping.pendingCount > 0, 'the native child remains owned after an unconfirmed public result settles')
                process.kill(shellPid, 0)
              }
            }
            assert.equal(await stopping.shutdown(), 0, 'Windows quit retries earlier failures and drains owned children through native cleanup and close')
            assert.equal(await reading, null)
          } finally { console.warn = originalWarn }
          if (variant.startsWith('helper-')) assert(warnings.some(values => values[0] === '[stoke] account identity tree cleanup failed'), 'the helper failure is actually exercised and diagnosed')
          if (variant === 'exited-child-late-sibling') {
            const pauses = captureReports.filter(report => report.phase === 'capture-paused')
            assert.equal(pauses.length, 1, 'the fixture changes the tree only after the native helper finishes its first assignments')
            assert(pauses[0].jobs >= 3, 'the launcher, parent and exiting leaf are assigned before the fixture marker is written')
            assert(captureReports.filter(report => report.phase === 'capture').length >= 2, 'a late sibling forces another capture pass over the already pinned exited leaf')
            const events = (await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(event => !previous.has(event.pid))
            const exited = events.find(event => event.kind === 'exiting-leaf')
            assert(exited, 'the first held leaf exits in response to the post-assignment marker')
            assert(events.some(event => event.kind === 'closed-exiting-leaf' && event.childPid === exited.pid), 'the parent observes the original leaf close before spawning its late sibling')
            assert(events.some(event => event.kind === 'ready-leaf' && event.pid !== exited.pid), 'the replacement sibling actually starts during the capture pause')
            assert(!warnings.some(values => values[0] === '[stoke] account identity tree cleanup failed' || (values[1] as { remaining?: number })?.remaining === -1), 'an absent exited child does not fail native ancestry or retain an owned cleanup slot')
            assert.equal(stopping.pendingCount, 0, 'the exited child and late sibling leave no retained native identity reads')
          }
          assert(!JSON.stringify(warnings).includes(root), 'cleanup diagnostics disclose no fixture paths or executable arguments')
          const ownedPids = [...new Set((await readFile(record, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(event => !previous.has(event.pid)).map(event => event.pid))]
          assert(!ownedPids.includes(shellPid), 'the owned launcher is cmd.exe, not a spawn override replacing it with node')
          assert(ownedPids.length >= 2, 'the native child and grandchild really start, including a grandchild born during capture')
          for (const pid of [shellPid, ...ownedPids]) {
            let alive = true
            try { process.kill(pid, 0) } catch { alive = false }
            assert.equal(alive, false, `actual .cmd tree fixture process ${pid} has exited`)
          }
          assert.equal(bystander.exitCode, null, 'a sibling synthetic process survives owned tree cleanup')
          process.kill(bystander.pid!, 0)
          pass(`actual Windows .cmd tree is reaped before quit (${variant}); a sibling bystander survives`)
        }
      } finally {
        const closed = new Promise<void>(resolve => { if (bystander.exitCode !== null || bystander.signalCode !== null) resolve(); else bystander.once('close', () => resolve()) })
        bystander.kill('SIGKILL'); await closed
      }
    }
  } finally {
    // Only exact ChildProcess objects created by this suite, never name-wide
    // termination or discovery of the owner's real agents.
    for (const child of fixtureChildren) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await rm(root, { recursive: true, force: true })
  }
}
